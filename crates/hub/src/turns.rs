//! Sending, the turn loop, the queue, and interruption.
//!
//! Part of [`crate::Hub`]; split out of `lib.rs` by concern rather than by
//! type, so the file you open is the subject you came for.

use daemon::rpc::codes;
use serde_json::{json, Value};

use std::sync::Arc;

use crate::{new_id, notification, push_replay, require_session_id, BrowserId, Hub, QueueItem};

impl Hub {
    pub(crate) async fn send(self: &Arc<Self>, browser: BrowserId, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        // Sending implies watching. A browser that skipped `nest.attach` would
        // otherwise get neither the turn's events nor its settlement — the
        // frames go to watchers, and it is not one.
        {
            let mut guard = self.inner.lock().await;
            guard
                .sessions
                .entry(session_id.clone())
                .or_default()
                .watchers
                .insert(browser);
        }
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if message.trim().is_empty() {
            return Err(json!({"code": codes::INVALID_PARAMS, "message": "empty message"}));
        }
        let attachments = params.get("attachments").cloned().unwrap_or(json!([]));
        let queue_if_busy = params.get("on_busy").and_then(Value::as_str) != Some("reject");

        let item = QueueItem {
            item_id: new_id("q"),
            message,
            attachments,
        };

        let busy = {
            let guard = self.inner.lock().await;
            guard
                .sessions
                .get(&session_id)
                .map(|s| s.running_turn.is_some())
                .unwrap_or(false)
        };
        if busy {
            if !queue_if_busy {
                return Err(json!({
                    "code": codes::SESSION_BUSY,
                    "message": "session is busy",
                }));
            }
            let queued = {
                let mut guard = self.inner.lock().await;
                let state = guard.sessions.entry(session_id.clone()).or_default();
                let view = item.view();
                state.queue.push_back(item);
                let snapshot = state.queue.iter().map(QueueItem::view).collect::<Vec<_>>();
                (view, snapshot, state.watchers.iter().copied().collect::<Vec<_>>())
            };
            let (view, snapshot, watchers) = queued;
            self.fan_out(
                &watchers,
                &notification(
                    "nest.queue",
                    json!({"session_id": session_id, "items": snapshot}),
                ),
            )
            .await;
            return Ok(json!({"queued": true, "item": view}));
        }

        let turn_id = self.start_turn(&session_id, item).await?;
        Ok(json!({"turn_id": turn_id}))
    }

    /// Begin a turn and hand it to a task, so the browser's `nest.send`
    /// returns immediately and the turn survives that browser going away.
    ///
    /// The task is a loop rather than a recursive call chain: a settled turn
    /// that finds a queued send starts it in the same task.
    pub(crate) async fn start_turn(self: &Arc<Self>, session_id: &str, item: QueueItem) -> Result<String, Value> {
        let turn_id = self.open_turn(session_id, &item).await;
        let hub = self.clone();
        let session_id = session_id.to_string();
        let first = (turn_id.clone(), item);
        tokio::spawn(async move {
            let mut current = first;
            loop {
                let (turn_id, item) = current;
                let outcome = hub
                    .call(
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
    /// the engine emits no event for it, and every other tab needs to see it.
    pub(crate) async fn open_turn(self: &Arc<Self>, session_id: &str, item: &QueueItem) -> String {
        let total = self.history_total(session_id).await;
        let turn_id = new_id("t");

        let watchers = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.to_string()).or_default();
            state.running_turn = Some(turn_id.clone());
            state.history_total_before_turn = total;
            state.replay.clear();
            state.replay_bytes = 0;
            state.truncated = false;
            state.seq += 1;
            let seq = state.seq;
            let event = json!({"kind": "user_message", "text": item.message});
            push_replay(state, seq, &turn_id, &event);
            (seq, event, state.watchers.iter().copied().collect::<Vec<_>>())
        };
        let (seq, event, watchers) = watchers;
        self.fan_out(
            &watchers,
            &notification(
                "nest.event",
                json!({"session_id": session_id, "seq": seq, "turn_id": turn_id, "event": event}),
            ),
        )
        .await;
        turn_id
    }

    /// A turn ended (completed, failed, or was interrupted): tell every
    /// watcher — including tabs that were not open when it started — drop the
    /// buffer if the transcript has caught up, and report what to run next.
    pub(crate) async fn settle_turn(
        self: &Arc<Self>,
        session_id: &str,
        turn_id: &str,
        outcome: Result<Value, Value>,
    ) -> Option<QueueItem> {
        let total_after = self.history_total(session_id).await;
        let (watchers, next) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.to_string()).or_default();
            state.running_turn = None;
            state.pending_prompts.clear();
            if total_after > state.history_total_before_turn {
                state.replay.clear();
                state.replay_bytes = 0;
            }
            let watchers = state.watchers.iter().copied().collect::<Vec<_>>();
            (watchers, state.queue.pop_front())
        };

        let params = match &outcome {
            Ok(result) => json!({
                "session_id": session_id, "turn_id": turn_id, "result": result,
            }),
            Err(error) => json!({
                "session_id": session_id, "turn_id": turn_id, "error": error,
            }),
        };
        self.fan_out(&watchers, &notification("nest.turn_settled", params))
            .await;

        if next.is_some() {
            let snapshot = {
                let guard = self.inner.lock().await;
                guard
                    .sessions
                    .get(session_id)
                    .map(|s| s.queue.iter().map(QueueItem::view).collect::<Vec<_>>())
                    .unwrap_or_default()
            };
            self.fan_out(
                &watchers,
                &notification(
                    "nest.queue",
                    json!({"session_id": session_id, "items": snapshot}),
                ),
            )
            .await;
        }
        next
    }

    pub(crate) async fn interrupt(&self, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let result = self
            .call("session.interrupt", json!({"session_id": session_id}))
            .await?;
        let (watchers, snapshot) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.queue.clear();
            (
                state.watchers.iter().copied().collect::<Vec<_>>(),
                Vec::<Value>::new(),
            )
        };
        self.fan_out(
            &watchers,
            &notification(
                "nest.queue",
                json!({"session_id": session_id, "items": snapshot}),
            ),
        )
        .await;
        Ok(result)
    }

    pub(crate) async fn close_or_delete(&self, method: &str, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let result = self.call(method, params).await?;
        self.inner.lock().await.sessions.remove(&session_id);
        // The recorder keeps no retention policy — a recording is a directory
        // for whoever owns the session to remove, and deleting the session is
        // that moment. Closing is not: the conversation is still there to
        // reopen, and so is what the model was sent.
        if method == "session.delete" {
            self.forget_recording(&session_id);
        }
        Ok(result)
    }

    pub(crate) async fn queue_remove(&self, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let item_id = params
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (watchers, snapshot) = {
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.queue.retain(|i| i.item_id != item_id);
            (
                state.watchers.iter().copied().collect::<Vec<_>>(),
                state.queue.iter().map(QueueItem::view).collect::<Vec<_>>(),
            )
        };
        self.fan_out(
            &watchers,
            &notification(
                "nest.queue",
                json!({"session_id": session_id, "items": snapshot.clone()}),
            ),
        )
        .await;
        Ok(json!({"items": snapshot}))
    }

}
