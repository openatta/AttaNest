//! The session hub.
//!
//! Every browser talks to this and only this. The hub holds the single daemon
//! connection, owns every session subscription, records the running turn's
//! event frames so a reloading tab can catch up, owns `run_turn` (so closing a
//! tab cannot lose a turn's final response), and queues sends that would have
//! hit `SESSION_BUSY`.
//!
//! The invariant the whole design rests on: **the hub subscribes before any
//! browser asks**. A session is subscribed the first time anyone attaches, and
//! from then on nothing that happens in it is unobserved — so a browser's
//! catch-up is entirely inside the hub's buffer and never depends on the
//! daemon replaying anything (it doesn't) or on the transcript being current
//! (mid-turn, it isn't). See docs/architecture.md §3 and §5.
//!
//! Browser-facing methods that are not `nest.*` are AttaCore v2 verbatim, from
//! an allow-list. The allow-list is the only authorization point in the
//! process: the daemon trusts whoever can reach its dispatch, which in this
//! build is us.

mod files;
mod recordings;
mod settings;
pub mod store;
mod turns;
mod workspaces;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use daemon::rpc::{codes, Client, FrameSink, RpcRequest, RpcResponse, Sink};
use daemon::DaemonServer;
use nest_engine::Engine;
use serde_json::{json, Value};
use store::Store;
use tokio::sync::{mpsc, Mutex};
use tracing::debug;

/// Frames of one turn kept for catch-up, and the byte ceiling over their
/// payloads. A long turn streams thousands of `text_delta` frames; they are
/// coalesced on the way in, so these bounds are generous in practice.
const REPLAY_MAX_FRAMES: usize = 20_000;
const REPLAY_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Coalesce consecutive `text_delta` frames up to this size.
const DELTA_COALESCE_BYTES: usize = 4096;

/// Methods a browser may send through untouched.
const PASSTHROUGH: &[&str] = &[
    "session.create",
    "session.list",
    "session.get",
    "session.history",
    "session.fork",
    "session.resume",
    "session.respondToPrompt",
    "scene.list",
    "scene.describe",
    "scene.activate",
    "commands.list",
    "mcp.status",
    "plugin.list",
    "daemon.status",
    "daemon.ping",
    "daemon.doctor",
];

/// Methods that exist but are refused at this boundary, with the reason the
/// browser can show. Refused explicitly rather than by omission: "unknown
/// method" would read as a Nest bug.
fn refusal(method: &str) -> Option<&'static str> {
    Some(match method {
        "config.setProvider" | "config.set" | "config.update" => {
            "changing provider credentials or base_url is not reachable from the browser"
        }
        "mcp.addServer" => "adding an MCP server is not reachable from the browser",
        "plugin.install" | "plugin.uninstall" | "plugin.enable" | "plugin.disable" => {
            "plugin management is not reachable from the browser"
        }
        "import.run" | "import.list" => "config import is not reachable from the browser",
        "daemon.shutdown" => "shutdown is not reachable from the browser",
        "session.run_turn" => "use nest.send — the hub owns turns",
        "session.subscribe" | "session.unsubscribe" | "daemon.subscribeEvents" => {
            "use nest.attach — the hub owns subscriptions"
        }
        _ => return None,
    })
}

pub(crate) type BrowserId = u64;

struct ReplayFrame {
    seq: u64,
    turn_id: String,
    event: Value,
}

pub(crate) struct QueueItem {
    pub(crate) item_id: String,
    pub(crate) message: String,
    pub(crate) attachments: Value,
}

impl QueueItem {
    pub(crate) fn view(&self) -> Value {
        json!({"item_id": self.item_id, "message": self.message})
    }
}

#[derive(Default)]
struct SessionState {
    subscribed: bool,
    seq: u64,
    replay: VecDeque<ReplayFrame>,
    replay_bytes: usize,
    truncated: bool,
    running_turn: Option<String>,
    queue: VecDeque<QueueItem>,
    pending_prompts: Vec<Value>,
    watchers: HashSet<BrowserId>,
    /// Projected-message count before the running turn started, so settling
    /// can tell whether the transcript has caught up.
    history_total_before_turn: u64,
}

/// What `session.list` does not report.
///
/// `SessionInfo` carries no `scene` and no `project_root` — `session.get`
/// adds the scene, and nothing in the protocol reports a project root for a
/// session the caller did not create. So the hub remembers what it saw at
/// creation and attach time; a session it has never opened groups as
/// "unknown", which is honest and self-correcting.
#[derive(Default, Clone)]
struct SessionFacts {
    scene: Option<String>,
    project_root: Option<String>,
}

#[derive(Default)]
struct Inner {
    browsers: HashMap<BrowserId, mpsc::UnboundedSender<String>>,
    sessions: HashMap<String, SessionState>,
    facts: HashMap<String, SessionFacts>,
    /// One-shot upload grants: token → destination path.
    uploads: HashMap<String, PathBuf>,
}

pub struct Hub {
    pub(crate) server: Arc<DaemonServer>,
    pub(crate) client: Arc<Client>,
    pub(crate) engine: Engine,
    pub(crate) inner: Arc<Mutex<Inner>>,
    /// Everything AttaCore has no concept of: workspaces, titles, view
    /// preferences. Nest's directory, never the engine's — see `store`.
    pub(crate) store: Mutex<Store>,
    pub(crate) next_browser: AtomicU64,
    pub(crate) upload_dir: PathBuf,
    /// Where projects live: what the picker opens on, and what "new project"
    /// creates into. A default, not a boundary — the fence is `$HOME`.
    pub(crate) projects_root: PathBuf,
    pub(crate) max_upload_bytes: usize,
}

/// The hub's own end of the daemon connection: every `session.event` and
/// `daemon.event` frame the engine emits arrives here.
struct HubSink {
    pub(crate) inner: Arc<Mutex<Inner>>,
}

#[async_trait::async_trait]
impl FrameSink for HubSink {
    async fn send_json(&self, json: String) -> bool {
        let Ok(frame) = serde_json::from_str::<Value>(&json) else {
            return true;
        };
        // Responses to the hub's own calls come back from `dispatch_public`
        // directly; anything with an id here is not ours to route.
        if frame.get("id").is_some() {
            return true;
        }
        match frame.get("method").and_then(Value::as_str) {
            Some("session.event") => {
                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                route_session_event(&self.inner, params).await;
            }
            Some("daemon.event") => {
                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                let out = notification("nest.daemon_event", params);
                broadcast_all(&self.inner, &out).await;
            }
            other => debug!(method = ?other, "hub sink: unrouted frame"),
        }
        true
    }
}

pub(crate) fn notification(method: &str, params: Value) -> String {
    serde_json::to_string(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
        .unwrap_or_else(|_| String::from("{}"))
}

async fn broadcast_all(inner: &Arc<Mutex<Inner>>, frame: &str) {
    let guard = inner.lock().await;
    for tx in guard.browsers.values() {
        let _ = tx.send(frame.to_string());
    }
}

/// Assign a seq, record for catch-up, fan out to this session's watchers.
///
/// Sequence assignment, buffering and fan-out all happen under one lock, so a
/// browser that attaches between two frames either sees a frame in its replay
/// snapshot or receives it live — never both, never neither.
async fn route_session_event(inner: &Arc<Mutex<Inner>>, params: Value) {
    let Some(session_id) = params.get("session_id").and_then(Value::as_str) else {
        return;
    };
    let turn_id = params
        .get("turn_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = params.get("event").cloned().unwrap_or(Value::Null);
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");

    let mut guard = inner.lock().await;
    let session_id = session_id.to_string();
    let state = guard.sessions.entry(session_id.clone()).or_default();

    if kind == "prompt" {
        state.pending_prompts.push(event.clone());
    }
    if kind == "turn_complete" {
        // Nothing is waiting on these answers any more.
        state.pending_prompts.clear();
    }

    state.seq += 1;
    let seq = state.seq;
    push_replay(state, seq, &turn_id, &event);

    let watchers: Vec<BrowserId> = state.watchers.iter().copied().collect();
    let frame = notification(
        "nest.event",
        json!({"session_id": session_id, "seq": seq, "turn_id": turn_id, "event": event}),
    );
    for id in watchers {
        if let Some(tx) = guard.browsers.get(&id) {
            let _ = tx.send(frame.clone());
        }
    }
}

pub(crate) fn push_replay(state: &mut SessionState, seq: u64, turn_id: &str, event: &Value) {
    let is_delta = event.get("kind").and_then(Value::as_str) == Some("text_delta");
    if is_delta {
        if let Some(last) = state.replay.back_mut() {
            let mergeable = last.turn_id == turn_id
                && last.event.get("kind").and_then(Value::as_str) == Some("text_delta")
                && last
                    .event
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| t.len() < DELTA_COALESCE_BYTES)
                    .unwrap_or(false);
            if mergeable {
                let add = event.get("text").and_then(Value::as_str).unwrap_or("");
                if let Some(Value::String(text)) = last.event.get_mut("text") {
                    text.push_str(add);
                }
                last.seq = seq;
                state.replay_bytes += add.len();
                return;
            }
        }
    }
    let bytes = event.to_string().len();
    state.replay.push_back(ReplayFrame {
        seq,
        turn_id: turn_id.to_string(),
        event: event.clone(),
    });
    state.replay_bytes += bytes;
    while state.replay.len() > REPLAY_MAX_FRAMES || state.replay_bytes > REPLAY_MAX_BYTES {
        let Some(dropped) = state.replay.pop_front() else {
            break;
        };
        state.replay_bytes = state
            .replay_bytes
            .saturating_sub(dropped.event.to_string().len());
        state.truncated = true;
    }
}

impl Hub {
    pub async fn new(
        engine: Engine,
        state_root: PathBuf,
        projects_root: PathBuf,
    ) -> anyhow::Result<Arc<Self>> {
        let store = Store::open(state_root)?;
        let upload_dir = store.root().join("uploads").join(std::process::id().to_string());
        std::fs::create_dir_all(&upload_dir)?;
        let inner = Arc::new(Mutex::new(Inner::default()));
        let sink: Sink = Arc::new(HubSink {
            inner: inner.clone(),
        });
        let client = engine.server.accept_connection(sink);
        let hub = Arc::new(Self {
            server: engine.server.clone(),
            client,
            engine,
            inner,
            store: Mutex::new(store),
            next_browser: AtomicU64::new(1),
            upload_dir,
            projects_root,
            max_upload_bytes: 32 * 1024 * 1024,
        });
        // Instance-level notifications (session evicted, MCP connect failed,
        // scene degraded) go to every browser.
        hub.call("daemon.subscribeEvents", json!({})).await.ok();
        Ok(hub)
    }

    /// One JSON-RPC call into the engine, in-process.
    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        let req: RpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 0,
        }))
        .map_err(|e| json!({"code": codes::INVALID_PARAMS, "message": e.to_string()}))?;
        debug!(method, "engine call →");
        let resp = self.server.dispatch_public(req, self.client.clone()).await;
        debug!(method, ok = resp.error.is_none(), "engine call ←");
        response_split(resp)
    }

    pub fn upload_dir(&self) -> &Path {
        &self.upload_dir
    }

    pub fn max_upload_bytes(&self) -> usize {
        self.max_upload_bytes
    }

    pub async fn add_browser(&self) -> (BrowserId, mpsc::UnboundedReceiver<String>) {
        let id = self.next_browser.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner.lock().await.browsers.insert(id, tx);
        (id, rx)
    }

    /// Push one already-built frame to one browser.
    pub async fn send_to(&self, id: BrowserId, frame: String) {
        if let Some(tx) = self.inner.lock().await.browsers.get(&id) {
            let _ = tx.send(frame);
        }
    }

    pub async fn remove_browser(&self, id: BrowserId) {
        let mut guard = self.inner.lock().await;
        guard.browsers.remove(&id);
        for state in guard.sessions.values_mut() {
            state.watchers.remove(&id);
        }
    }

    /// Claim an upload grant. `None` means the token was never issued or has
    /// already been used.
    pub async fn claim_upload(&self, token: &str) -> Option<PathBuf> {
        self.inner.lock().await.uploads.remove(token)
    }

    /// Handle one browser frame. Returns the response frame, if the request
    /// had an id.
    pub async fn handle(self: &Arc<Self>, browser: BrowserId, text: &str) -> Option<String> {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return Some(err_frame(
                    Value::Null,
                    codes::PARSE_ERROR,
                    format!("invalid JSON: {e}"),
                ))
            }
        };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Some(err_frame(id, codes::INVALID_REQUEST, "missing method"));
        };
        let params = value.get("params").cloned().unwrap_or(json!({}));
        let notification_only = value.get("id").is_none();

        let outcome = self.route(browser, method, params).await;
        if notification_only {
            return None;
        }
        Some(match outcome {
            Ok(result) => serde_json::to_string(&json!({
                "jsonrpc": "2.0", "id": id, "result": result
            }))
            .unwrap_or_default(),
            Err(error) => serde_json::to_string(&json!({
                "jsonrpc": "2.0", "id": id, "error": error
            }))
            .unwrap_or_default(),
        })
    }

    async fn route(
        self: &Arc<Self>,
        browser: BrowserId,
        method: &str,
        params: Value,
    ) -> Result<Value, Value> {
        if let Some(reason) = refusal(method) {
            return Err(json!({"code": codes::METHOD_NOT_FOUND, "message": reason}));
        }
        match method {
            "nest.hello" => self.hello().await,
            "nest.sessions" => self.sessions().await,
            "nest.workspaces.list" => self.workspaces_list().await,
            "nest.workspaces.create" => self.workspaces_create(params).await,
            "nest.workspaces.update" => self.workspaces_update(params).await,
            "nest.workspaces.reorder" => self.workspaces_reorder(params).await,
            "nest.workspaces.remove" => self.workspaces_remove(params).await,
            "nest.sessions.rename" => self.session_rename(params).await,
            "nest.sessions.archive" => self.session_archive(params).await,
            "nest.prefs.set" => self.prefs_set(params).await,
            "nest.search" => self.search(params).await,
            "nest.requestHeaders" => self.request_headers(params).await,
            "nest.settings.describe" => self.settings_describe(params).await,
            "nest.settings.set" => self.settings_set(params).await,
            "nest.settings.setProvider" => self.settings_set_provider(params).await,
            "nest.attach" => self.attach(browser, params).await,
            "nest.detach" => self.detach(browser, params).await,
            "nest.send" => self.send(browser, params).await,
            "nest.queue.remove" => self.queue_remove(params).await,
            "nest.listDirectory" => self.list_directory(params).await,
            "nest.recentProjects" => self.recent_projects().await,
            "nest.files" => self.files(params).await,
            "nest.projects.create" => self.projects_create(params).await,
            "nest.upload.begin" => self.upload_begin(params).await,
            // Interrupting is a user decision about the whole session, not
            // just the running turn: the queue behind it is abandoned too.
            "session.interrupt" => self.interrupt(params).await,
            "session.close" | "session.delete" => self.close_or_delete(method, params).await,
            // Intercepted to record what the response is the last place to see
            // — nothing later reports a session's project root — and to turn
            // recording on, which is where the request envelope comes from.
            "session.create" => {
                let requested_root = params
                    .get("project_root")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let result = self
                    .call("session.create", recordings::with_recording(params))
                    .await?;
                if let Some(sid) = result.get("session_id").and_then(Value::as_str) {
                    self.remember(
                        sid,
                        result.get("scene").and_then(Value::as_str).map(str::to_string),
                        result
                            .get("project_root")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or(requested_root),
                    )
                    .await;
                }
                Ok(result)
            }
            m if PASSTHROUGH.contains(&m) => self.call(m, params).await,
            m => Err(json!({
                "code": codes::METHOD_NOT_FOUND,
                "message": format!("method `{m}` is not exposed to the browser"),
            })),
        }
    }

    async fn hello(&self) -> Result<Value, Value> {
        let status = self.call("daemon.status", json!({})).await.unwrap_or(json!({}));
        let scenes = self.call("scene.list", json!({})).await.unwrap_or(json!({}));
        let commands = self
            .call("commands.list", json!({}))
            .await
            .unwrap_or(json!({}));
        Ok(json!({
            "protocol_version": 2,
            "engine": {
                "model": self.engine.model,
                "active_scenes": self.engine.active_scenes,
                "data_root": self.engine.data_root.display().to_string(),
                "has_credentials": self.engine.has_credentials,
                "status": status,
            },
            "scenes": scenes.get("scenes").cloned().unwrap_or(json!([])),
            "commands": commands.get("commands").cloned().unwrap_or(json!([])),
            "limits": {
                "max_frame_bytes": 16 * 1024 * 1024,
                "max_upload_bytes": self.max_upload_bytes,
                "replay_max_frames": REPLAY_MAX_FRAMES,
            },
            "cwd": std::env::current_dir().ok().map(|p| p.display().to_string()),
            "state_dir": self.store.lock().await.root().display().to_string(),
            "projects_root": self.projects_root.display().to_string(),
        }))
    }

    /// Open a session for one browser: subscribe (once, hub-wide, resuming the
    /// session first if it is only on disk), read its shape and transcript
    /// depth, then hand back the replay snapshot under the same lock that
    /// registers the watcher.
    async fn attach(&self, browser: BrowserId, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;

        // `session.get` reads the transcript, so it answers for a cold session
        // too — and it is where the scene comes from, which a resume needs.
        let info = self
            .call("session.get", json!({"session_id": session_id}))
            .await?;
        let scene = info
            .get("scene")
            .and_then(Value::as_str)
            .map(str::to_string);

        // Subscribe before anything else is read. Everything after this point
        // is observed, so the seam between what history holds and what the
        // buffer holds cannot lose a frame.
        let subscribed = {
            let guard = self.inner.lock().await;
            guard
                .sessions
                .get(&session_id)
                .map(|s| s.subscribed)
                .unwrap_or(false)
        };
        if !subscribed {
            let mut resp = self
                .call("session.subscribe", json!({"session_id": session_id}))
                .await;
            // Only live sessions have subscribers. A session that exists on
            // disk but not in memory has to be brought back first — opening
            // a past conversation is otherwise impossible, and this is the
            // same cost DSH pays ("history resumes an unattached session").
            if is_code(&resp, codes::SESSION_NOT_FOUND) {
                let project_root = self.known_project_root(&session_id).await;
                let mut resume = json!({"session_id": session_id});
                if let Some(scene) = &scene {
                    resume["scene"] = json!(scene);
                }
                if let Some(root) = project_root {
                    resume["project_root"] = json!(root);
                }
                // A resumed session records too, or its next turn would be the
                // one turn with no envelope. Nothing is written until it makes
                // a call, so merely reopening a conversation to read it leaves
                // the recording of its last run intact.
                self.call("session.resume", recordings::with_recording(resume))
                    .await?;
                resp = self
                    .call("session.subscribe", json!({"session_id": session_id}))
                    .await;
            }
            let resp = resp?;
            let mut guard = self.inner.lock().await;
            let state = guard.sessions.entry(session_id.clone()).or_default();
            state.subscribed = true;
            if let Some(prompts) = resp.get("pending_prompts").and_then(Value::as_array) {
                for p in prompts {
                    state.pending_prompts.push(p.clone());
                }
            }
        }

        self.remember(&session_id, scene, None).await;
        let total = self.history_total(&session_id).await;

        let mut guard = self.inner.lock().await;
        let state = guard.sessions.entry(session_id.clone()).or_default();
        state.watchers.insert(browser);
        // A settled turn already in the transcript would otherwise be
        // rendered twice — history holds it, and so does the buffer.
        let serve_replay = state.running_turn.is_some() || total <= state.history_total_before_turn;
        let replay: Vec<Value> = if serve_replay {
            state
                .replay
                .iter()
                .map(|f| json!({"seq": f.seq, "turn_id": f.turn_id, "event": f.event}))
                .collect()
        } else {
            Vec::new()
        };
        Ok(json!({
            "session": info,
            "history_total": total,
            "replay": replay,
            "truncated": state.truncated,
            "pending_prompts": state.pending_prompts,
            "running_turn": state.running_turn,
            "queue": state.queue.iter().map(QueueItem::view).collect::<Vec<_>>(),
            "seq": state.seq,
        }))
    }

    /// The session list, with the facts `session.list` does not carry folded
    /// back in. Sessions the hub has never opened come back with a null scene
    /// and project root rather than a guess.
    async fn sessions(&self) -> Result<Value, Value> {
        let listed = self.call("session.list", json!({"limit": 200})).await?;
        // One lock at a time, always: the store is snapshotted and released
        // before `inner` is taken, so no code path can hold them in two
        // different orders.
        let (workspaces, prefs, overlay) = {
            let store = self.store.lock().await;
            let overlay: HashMap<String, (Option<String>, bool)> = store
                .state()
                .sessions
                .iter()
                .map(|(id, meta)| (id.clone(), (meta.title.clone(), meta.archived)))
                .collect();
            let workspaces: Vec<(Option<String>, String)> = store
                .state()
                .workspaces
                .iter()
                .map(|w| (w.path.clone(), w.id.clone()))
                .collect();
            (
                serde_json::to_value(&store.state().workspaces).unwrap_or(json!([])),
                Value::Object(store.state().prefs.clone()),
                (overlay, workspaces),
            )
        };
        let (titles, workspace_ids) = overlay;
        let guard = self.inner.lock().await;
        let mut rows: Vec<Value> = Vec::new();
        for s in listed
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let mut row = s.clone();
            let sid = s.get("session_id").and_then(Value::as_str).unwrap_or("");
            let facts = guard.facts.get(sid).cloned().unwrap_or_default();
            let workspace = workspace_ids
                .iter()
                .find(|(path, _)| path.as_deref() == facts.project_root.as_deref())
                .map(|(_, id)| id.clone());
            let meta = titles.get(sid);
            if let Some(obj) = row.as_object_mut() {
                obj.insert("scene".into(), json!(facts.scene));
                obj.insert("project_root".into(), json!(facts.project_root));
                obj.insert("workspace_id".into(), json!(workspace));
                obj.insert("archived".into(), json!(meta.map(|m| m.1).unwrap_or(false)));
                // A user-typed title outranks the engine's generated name.
                if let Some(title) = meta.and_then(|m| m.0.clone()) {
                    obj.insert("name".into(), json!(title));
                    obj.insert("renamed".into(), json!(true));
                }
                obj.insert(
                    "running".into(),
                    json!(guard
                        .sessions
                        .get(sid)
                        .map(|st| st.running_turn.is_some())
                        .unwrap_or(false)),
                );
            }
            rows.push(row);
        }
        Ok(json!({
            "sessions": rows,
            "workspaces": workspaces,
            "prefs": prefs,
        }))
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

    pub(crate) async fn known_project_root(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .await
            .facts
            .get(session_id)
            .and_then(|f| f.project_root.clone())
    }

    async fn detach(&self, browser: BrowserId, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let mut guard = self.inner.lock().await;
        if let Some(state) = guard.sessions.get_mut(&session_id) {
            state.watchers.remove(&browser);
        }
        Ok(json!({"detached": true}))
    }

    pub(crate) async fn history_total(&self, session_id: &str) -> u64 {
        self.call(
            "session.history",
            json!({"session_id": session_id, "limit": 0}),
        )
        .await
        .ok()
        .and_then(|v| v.get("total").and_then(Value::as_u64))
        .unwrap_or(0)
    }

    pub(crate) async fn fan_out(&self, watchers: &[BrowserId], frame: &str) {
        let guard = self.inner.lock().await;
        for id in watchers {
            if let Some(tx) = guard.browsers.get(id) {
                let _ = tx.send(frame.to_string());
            }
        }
    }

    pub async fn shutdown(&self) {
        self.server.drop_connection(self.client.id()).await;
        self.engine.shutdown().await;
    }
}

pub(crate) fn response_split(resp: RpcResponse) -> Result<Value, Value> {
    if let Some(error) = resp.error {
        return Err(serde_json::to_value(error).unwrap_or(json!({"message": "error"})));
    }
    Ok(resp.result.unwrap_or(Value::Null))
}

pub(crate) fn is_code(result: &Result<Value, Value>, code: i32) -> bool {
    matches!(result, Err(e) if e.get("code").and_then(Value::as_i64) == Some(code as i64))
}

/// A workspace's default label: the last path segment, or the no-project name.
pub(crate) fn default_title(path: Option<&str>) -> String {
    match path {
        Some(path) => path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(path)
            .to_string(),
        None => "无项目".to_string(),
    }
}



pub(crate) fn require_str(params: &Value, key: &str) -> Result<String, Value> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| json!({"code": codes::INVALID_PARAMS, "message": format!("missing {key}")}))
}

pub(crate) fn require_session_id(params: &Value) -> Result<String, Value> {
    params
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| json!({"code": codes::INVALID_PARAMS, "message": "missing session_id"}))
}

fn err_frame(id: Value, code: i32, message: impl Into<String>) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message.into()},
    }))
    .unwrap_or_default()
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
