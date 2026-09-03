//! Sending, the turn loop, the queue, and interruption.
//!
//! `run_turn` is started **here**, not by a client connection. Directly:
//! closing or refreshing a tab does not end the turn and does not lose its
//! final response, because the response comes back to the hub and the hub
//! broadcasts it. A client that talks to the engine directly loses that
//! response with its connection and has to guess from `turn_complete`.
//!
//! The engine allows one turn per session at a time and refuses a second
//! rather than queueing. That constraint is the engine's business and should
//! not reach the user unchanged, so the queue is here (§3.2, point 4).

use std::sync::Arc;

use daemon::rpc::codes as engine_codes;
use nest_contract::{Frame, RpcError, Subject};
use serde_json::{json, Value};

use crate::session::QueueItem;
use crate::{new_id, notification, require_session_id, Hub};

impl Hub {
    pub(crate) async fn send(self: &Arc<Self>, subject: &Subject, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        // The session has to exist before a turn is opened on it.
        //
        // `session.run_turn` does not require one — handed an id it does not
        // know, the engine makes a session and runs the turn there. That is
        // reasonable for the engine and wrong for a client: a mistyped id
        // came back as a settled turn, with the transcript in a session under
        // an id the caller had never seen and could not ask for again, and a
        // model call spent on it. The hub owns turns (§3.2), so refusing here
        // is the hub's to do — and it costs the one call the send already
        // makes to read the transcript depth.
        self.engine_call("session.get", json!({"session_id": &session_id}))
            .await?;
        // Sending implies watching. A client that skipped `nest.attach` would
        // otherwise get neither the turn's events nor its settlement — frames
        // go to watchers, and it would not be one.
        if let Some(client) = params.get("__client").and_then(Value::as_u64).map(crate::ClientId) {
            let mut guard = self.inner.lock().await;
            guard.sessions.entry(session_id.clone()).or_default().watchers.insert(client);
        }
        let _ = subject;

        let message = params.get("message").and_then(Value::as_str).unwrap_or("").to_string();
        if message.trim().is_empty() {
            return Err(RpcError::invalid_params("empty message"));
        }
        let item = QueueItem {
            item_id: new_id("q"),
            message,
            attachments: params.get("attachments").cloned().unwrap_or(json!([])),
        };
        let queue_if_busy = params.get("on_busy").and_then(Value::as_str) != Some("reject");

        let busy = {
            let guard = self.inner.lock().await;
            guard.sessions.get(&session_id).is_some_and(|s| s.running_turn.is_some())
        };
        if busy {
            if !queue_if_busy {
                return Err(RpcError::new(engine_codes::SESSION_BUSY, "session is busy"));
            }
            let (view, snapshot, watchers) = {
                let mut guard = self.inner.lock().await;
                let state = guard.sessions.entry(session_id.clone()).or_default();
                let view = item.view();
                state.queue.push_back(item);
                (view, state.queue_view(), state.watchers())
            };
            self.push_queue(&session_id, &watchers, snapshot).await;
            return Ok(json!({"queued": true, "item": view}));
        }

        let turn_id = self.start_turn(&session_id, item).await?;
        Ok(json!({"turn_id": turn_id}))
    }

    /// Begin a turn and hand it to a task, so `nest.send` returns at once and
    /// the turn outlives the client that asked for it.
    ///
    /// The task is a **loop**, not a chain of recursive calls: a settled turn
    /// that finds a queued send starts it in the same task. Written
    /// recursively, `start_turn → settle → start_turn` does not even prove
    /// `Send` in Rust.
    pub(crate) async fn start_turn(
        self: &Arc<Self>,
        session_id: &str,
        item: QueueItem,
    ) -> Result<String, RpcError> {
        let turn_id = self.open_turn(session_id, &item).await;
        let hub = self.clone();
        let session_id = session_id.to_string();
        let first = (turn_id.clone(), item);
        tokio::spawn(async move {
            let mut current = first;
            loop {
                let (turn_id, item) = current;
                let outcome = hub
                    .engine_call(
                        "session.run_turn",
                        json!({
                            "session_id": session_id,
                            "turn_id": turn_id,
                            "message": item.message,
                            "attachments": item.attachments,
                        }),
                    )
                    .await;
                match hub.settle_turn(&session_id, &turn_id, outcome).await {
                    Some(next) => {
                        let next_id = hub.open_turn(&session_id, &next).await;
                        current = (next_id, next);
                    }
                    None => break,
                }
            }
        });
        Ok(turn_id)
    }

    /// Record the transcript depth this turn starts from, drop the previous
    /// turn's buffer, and put the user's own message into the event stream —
    /// the engine emits no event for it, and every other client needs to see
    /// it.
    async fn open_turn(self: &Arc<Self>, session_id: &str, item: &QueueItem) -> String {
        let total = self.history_total(session_id).await;
        let turn_id = new_id("t");

        let (seq, event, watchers) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.to_string()).or_default();
            state.running_turn = Some(turn_id.clone());
            state.history_total_before_turn = total;
            state.replay.clear();
            state.seq += 1;
            let seq = state.seq;
            let event = json!({"kind": "user_message", "text": item.message});
            state.replay.push(seq, &turn_id, &event);
            (seq, event, state.watchers())
        };
        self.fan_out(
            &watchers,
            Frame::session(
                session_id,
                notification(
                    "nest.event",
                    json!({"session_id": session_id, "seq": seq, "turn_id": turn_id, "event": event}),
                ),
            ),
        )
        .await;
        turn_id
    }

    /// A turn ended — completed, failed or interrupted. Tell every watcher,
    /// including clients that were not open when it started; drop the buffer
    /// only once the transcript has caught up; report what to run next.
    async fn settle_turn(
        self: &Arc<Self>,
        session_id: &str,
        turn_id: &str,
        outcome: Result<Value, RpcError>,
    ) -> Option<QueueItem> {
        let total_after = self.history_total(session_id).await;
        let (watchers, next) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.to_string()).or_default();
            state.running_turn = None;
            state.pending_prompts.clear();
            // Only once the transcript has grown. A turn that finished but is
            // not yet on disk would otherwise be in neither place.
            if total_after > state.history_total_before_turn {
                state.replay.clear();
            }
            (state.watchers(), state.queue.pop_front())
        };

        let params = match &outcome {
            Ok(result) => json!({"session_id": session_id, "turn_id": turn_id, "result": result}),
            Err(error) => json!({
                "session_id": session_id, "turn_id": turn_id,
                "error": {"code": error.code, "message": error.message},
            }),
        };
        self.fan_out(
            &watchers,
            Frame::session(session_id, notification("nest.turn_settled", params)),
        )
        .await;

        if next.is_some() {
            let snapshot = {
                let guard = self.inner.lock().await;
                guard.sessions.get(session_id).map(|s| s.queue_view()).unwrap_or_default()
            };
            self.push_queue(session_id, &watchers, snapshot).await;
        }
        next
    }

    /// Interrupting is a decision about the whole session, not just the
    /// running turn: the queue behind it is abandoned too. Otherwise a user
    /// presses stop and the next queued message starts immediately.
    pub(crate) async fn interrupt(self: &Arc<Self>, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        let result = self
            .engine_call("session.interrupt", json!({"session_id": session_id}))
            .await?;
        let watchers = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.queue.clear();
            state.watchers()
        };
        self.push_queue(&session_id, &watchers, Vec::new()).await;
        Ok(result)
    }

    pub(crate) async fn close_or_delete(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        let result = self.engine_call(method, params).await?;
        self.inner.lock().await.sessions.remove(&session_id);
        // The recorder keeps no retention policy and says so — a recording is
        // a self-contained directory for whoever owns the session to remove,
        // and deleting the session is that moment. Closing is not: the
        // conversation can be reopened, and what the model saw should still
        // be there (§6.4).
        if method == "session.delete" {
            let dir = self.engine().recordings_root.join(&session_id);
            if dir.is_dir() {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    tracing::warn!(dir = %dir.display(), error = %e, "recording not removed");
                }
            }
        }
        Ok(result)
    }

    pub(crate) async fn queue_remove(self: &Arc<Self>, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        let item_id = params.get("item_id").and_then(Value::as_str).unwrap_or("").to_string();
        let (watchers, snapshot) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.queue.retain(|i| i.item_id != item_id);
            (state.watchers(), state.queue_view())
        };
        self.push_queue(&session_id, &watchers, snapshot.clone()).await;
        Ok(json!({"items": snapshot}))
    }

    /// The queue is pushed **whole**, never as a delta. A merge bug only shows
    /// up in one order of arrival, and that order is not one tests reliably
    /// produce (§3.2).
    async fn push_queue(&self, session_id: &str, watchers: &[crate::ClientId], items: Vec<Value>) {
        self.fan_out(
            watchers,
            Frame::session(
                session_id,
                notification("nest.queue", json!({"session_id": session_id, "items": items})),
            ),
        )
        .await;
    }
}
