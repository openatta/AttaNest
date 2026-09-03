//! Per-session state, and what arrives from the engine.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use daemon::rpc::codes as engine_codes;
use nest_contract::{Frame, RpcError};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::clients::ClientId;
use crate::replay::Buffer;
use crate::{notification, require_session_id, with_recording, Hub, Inner};

pub(crate) struct QueueItem {
    pub item_id: String,
    pub message: String,
    pub attachments: Value,
}

impl QueueItem {
    /// What a client draws for a message that is waiting its turn.
    ///
    /// Attachments are in it because the row is the only place a queued
    /// message is visible: without them a "look at this file" waiting behind
    /// a running turn draws as a bare question, and there is no other call
    /// that would tell the client otherwise. They reach the turn either way —
    /// what was missing was the client being able to see that they would.
    pub fn view(&self) -> Value {
        json!({
            "item_id": self.item_id,
            "message": self.message,
            "attachments": self.attachments,
        })
    }
}

#[derive(Default)]
pub(crate) struct SessionState {
    pub subscribed: bool,
    pub seq: u64,
    pub replay: Buffer,
    pub running_turn: Option<String>,
    pub queue: VecDeque<QueueItem>,
    pub pending_prompts: Vec<Value>,
    pub watchers: HashSet<ClientId>,
    /// Projected-message count before the running turn began, so settling can
    /// tell whether the transcript has caught up.
    pub history_total_before_turn: u64,
}

impl SessionState {
    pub fn watchers(&self) -> Vec<ClientId> {
        self.watchers.iter().copied().collect()
    }

    pub fn queue_view(&self) -> Vec<Value> {
        self.queue.iter().map(QueueItem::view).collect()
    }
}

/// What `session.list` does not report.
///
/// `SessionInfo` carries no scene and no project root; `session.get` adds the
/// scene, and `session.create`'s reply is the last place a project root is
/// visible. So the hub writes down what it saw. A session it has never opened
/// reports null rather than a guess — honest, and self-correcting the moment
/// it is opened.
#[derive(Default, Clone)]
pub struct SessionFacts {
    pub scene: Option<String>,
    pub project_root: Option<String>,
}

/// Assign a seq, buffer for catch-up, fold the projections, fan out.
///
/// Sequence assignment, buffering and fan-out happen under one lock, so a
/// client attaching between two frames either finds a frame in its replay
/// snapshot or receives it live — never both, never neither.
pub(crate) async fn route_event(inner: &Arc<Mutex<Inner>>, params: Value) {
    let Some(session_id) = params.get("session_id").and_then(Value::as_str) else {
        return;
    };
    let session_id = session_id.to_string();
    let turn_id = params.get("turn_id").and_then(Value::as_str).unwrap_or("").to_string();
    let event = params.get("event").cloned().unwrap_or(Value::Null);
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");

    {
        let mut guard = inner.lock().await;
        let state = guard.sessions.entry(session_id.clone()).or_default();
        match kind {
            "prompt" => state.pending_prompts.push(event.clone()),
            // Nothing is waiting on those answers any more.
            "turn_complete" => state.pending_prompts.clear(),
            _ => {}
        }
        state.seq += 1;
        let seq = state.seq;
        state.replay.push(seq, &turn_id, &event);
        let watchers = state.watchers();
        let frame = Frame::session(
            session_id.clone(),
            notification(
                "nest.event",
                json!({"session_id": session_id, "seq": seq, "turn_id": turn_id, "event": event}),
            ),
        );
        guard.clients.send_many(&watchers, &frame).await;
    }
}

impl Hub {
    /// Open a session for one client: subscribe once, hub-wide, resuming the
    /// session first if it only exists on disk; read its shape and transcript
    /// depth; then hand back the replay snapshot under the same lock that
    /// registers the watcher.
    ///
    /// The order of those three is not interchangeable. Subscribing before
    /// reading is what closes the seam between what history holds and what the
    /// buffer holds.
    pub(crate) async fn attach(&self, subject: &nest_contract::Subject, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        let client = client_of(subject, &params)?;

        // `session.get` reads the transcript, so it answers for a cold session
        // too — and it is where the scene comes from, which a resume needs.
        let info = self.engine_call("session.get", json!({"session_id": session_id})).await?;
        let scene = info.get("scene").and_then(Value::as_str).map(str::to_string);

        let subscribed = {
            let guard = self.inner.lock().await;
            guard.sessions.get(&session_id).is_some_and(|s| s.subscribed)
        };
        if !subscribed {
            let mut resp = self
                .engine_call("session.subscribe", json!({"session_id": session_id}))
                .await;
            // Only live sessions have subscribers. One that exists on disk but
            // not in memory has to be brought back first — opening a past
            // conversation is otherwise impossible.
            if crate::is_code(&resp, engine_codes::SESSION_NOT_FOUND) {
                let mut resume = json!({"session_id": session_id});
                if let Some(scene) = &scene {
                    resume["scene"] = json!(scene);
                }
                if let Some(root) = self.known_project_root(&session_id).await {
                    resume["project_root"] = json!(root);
                }
                // A resumed session records too, or its next turn would be
                // the one turn with no envelope. Nothing is written until it
                // makes a call, so reopening a conversation just to read it
                // leaves the previous run's recording intact.
                self.engine_call("session.resume", with_recording(resume, self.replay_from())).await?;
                resp = self
                    .engine_call("session.subscribe", json!({"session_id": session_id}))
                    .await;
            }
            let resp = resp?;
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.subscribed = true;
            if let Some(prompts) = resp.get("pending_prompts").and_then(Value::as_array) {
                state.pending_prompts.extend(prompts.iter().cloned());
            }
        }

        self.remember(&session_id, scene, None).await;
        let total = self.history_total(&session_id).await;

        let mut guard = self.inner.lock().await;
        let state = guard.sessions.entry(session_id.clone()).or_default();
        state.watchers.insert(client);
        // A settled turn already in the transcript would otherwise render
        // twice — history holds it, and so does the buffer.
        let serve_replay = state.running_turn.is_some() || total <= state.history_total_before_turn;
        let replay = if serve_replay { state.replay.snapshot() } else { Vec::new() };
        Ok(json!({
            "session": info,
            "history_total": total,
            "replay": replay,
            "truncated": state.replay.truncated,
            "pending_prompts": state.pending_prompts,
            "running_turn": state.running_turn,
            "queue": state.queue_view(),
            "seq": state.seq,
        }))
    }

    pub(crate) async fn detach(&self, subject: &nest_contract::Subject, params: Value) -> Result<Value, RpcError> {
        let session_id = require_session_id(&params)?;
        let client = client_of(subject, &params)?;
        let mut guard = self.inner.lock().await;
        if let Some(state) = guard.sessions.get_mut(&session_id) {
            state.watchers.remove(&client);
        }
        Ok(json!({"detached": true}))
    }

    /// The session list with the facts `session.list` does not carry folded
    /// back in.
    pub(crate) async fn sessions(&self) -> Result<Value, RpcError> {
        let listed = self.engine_call("session.list", json!({"limit": 200})).await?;
        let guard = self.inner.lock().await;
        let rows: Vec<Value> = listed
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut row| {
                let sid = row.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
                let facts = guard.facts.get(&sid).cloned().unwrap_or_default();
                if let Some(obj) = row.as_object_mut() {
                    obj.insert("scene".into(), json!(facts.scene));
                    obj.insert("project_root".into(), json!(facts.project_root));
                    obj.insert(
                        "running".into(),
                        json!(guard.sessions.get(&sid).is_some_and(|s| s.running_turn.is_some())),
                    );
                }
                row
            })
            .collect();
        Ok(json!({"sessions": rows}))
    }

    /// Intercepted because the reply is the last place a session's project
    /// root is visible — nothing later reports it.
    pub(crate) async fn create(&self, params: Value) -> Result<Value, RpcError> {
        let requested = params.get("project_root").and_then(Value::as_str).map(str::to_string);
        let result = self
            .engine_call("session.create", with_recording(params, self.replay_from()))
            .await?;
        if let Some(sid) = result.get("session_id").and_then(Value::as_str) {
            self.remember(
                sid,
                result.get("scene").and_then(Value::as_str).map(str::to_string),
                result
                    .get("project_root")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(requested),
            )
            .await;
        }
        Ok(result)
    }

    pub(crate) async fn remember(&self, session_id: &str, scene: Option<String>, project_root: Option<String>) {
        let mut guard = self.inner.lock().await;
        let facts = guard.facts.entry(session_id.to_string()).or_default();
        if scene.is_some() {
            facts.scene = scene;
        }
        if project_root.is_some() {
            facts.project_root = project_root;
        }
    }

    pub async fn known_project_root(&self, session_id: &str) -> Option<String> {
        self.inner.lock().await.facts.get(session_id).and_then(|f| f.project_root.clone())
    }

    pub(crate) async fn history_total(&self, session_id: &str) -> u64 {
        self.engine_call("session.history", json!({"session_id": session_id, "limit": 0}))
            .await
            .ok()
            .and_then(|v| v.get("total").and_then(Value::as_u64))
            .unwrap_or(0)
    }

    pub(crate) async fn fan_out(&self, watchers: &[ClientId], frame: Frame) {
        let guard = self.inner.lock().await;
        guard.clients.send_many(watchers, &frame).await;
    }
}

/// Which client this call is on behalf of.
///
/// Watching is per-client, and a subject may have several. The transport
/// stamps the id onto the params; nothing else may set it, which is why a
/// missing one is an error rather than a default.
fn client_of(subject: &nest_contract::Subject, params: &Value) -> Result<ClientId, RpcError> {
    params
        .get("__client")
        .and_then(Value::as_u64)
        .map(ClientId)
        .ok_or_else(|| {
            RpcError::invalid_params(format!(
                "{} called a watching method outside a client connection",
                subject.label()
            ))
        })
}
