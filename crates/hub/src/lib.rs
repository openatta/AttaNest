//! The hub: the holder of sessions.
//!
//! One invariant, and everything else follows from it:
//!
//! > **The hub subscribes before any client does.**
//!
//! From that come four things, none of which would justify a layer alone and
//! all of which together do (§3.2):
//!
//! 1. **Refreshing loses nothing.** Half a turn is in the buffer, and does
//!    not depend on the engine re-sending it.
//! 2. **A turn does not hang off a connection.** `run_turn` is started here,
//!    so closing a tab, switching device or losing the network does not end
//!    it; the final result is broadcast to every watcher.
//! 3. **Several devices agree.** One session can be watched from several
//!    clients; any of them may answer a permission ask, first answer wins.
//! 4. **Queueing is product behavior, not an error.** The engine allows one
//!    turn per session at a time. That constraint should not reach the user
//!    unchanged, so a send during a turn is queued here and sent when the
//!    turn settles.
//!
//! This layer knows nothing about HTTP, TLS, connections or topology. It
//! speaks to `dyn FrameSink`, which is "a downstream that can take frames",
//! and that is all it ever learns about the other side.

mod clients;
mod replay;
mod session;
mod turns;

pub use clients::ClientId;
pub use replay::{MAX_BYTES as REPLAY_MAX_BYTES, MAX_FRAMES as REPLAY_MAX_FRAMES};
pub use session::SessionFacts;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use daemon::rpc::{Client, FrameSink as EngineFrameSink, RpcRequest, RpcResponse, Sink};
use daemon::DaemonServer;
use nest_assembly::Engine;
use nest_contract::{Frame, FrameSink, Gate, RpcError, Subject};
use nest_contrib::Registry;
use serde_json::{json, Value};
use tokio::sync::{Mutex, RwLock};
use tracing::debug;

use clients::Clients;
use session::SessionState;

/// Engine methods a client may send through untouched.
///
/// An allow-list, not a deny-list: the engine trusts whoever reaches its
/// dispatch, and in this build that is the hub. What is not named here is not
/// reachable — see `nest_authz`, which is where the decision is actually made.
pub const PASSTHROUGH: &[&str] = &[
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

/// The hub's own methods. Named here so `nest_authz` can open them and the
/// generated method catalog can list them without tracing dispatch.
pub const HUB_METHODS: &[&str] = &[
    "nest.hello",
    "nest.sessions",
    "nest.attach",
    "nest.detach",
    "nest.send",
    "nest.queue.remove",
    "nest.contributions",
];

#[derive(Default)]
struct Inner {
    clients: Clients,
    sessions: HashMap<String, SessionState>,
    facts: HashMap<String, SessionFacts>,
}

pub struct Hub {
    /// Where recordings are played back from, when this process was started
    /// in replay. `None` is the ordinary case: record, never play.
    replay_from: Option<std::path::PathBuf>,
    server: Arc<DaemonServer>,
    client: Arc<Client>,
    engine: Engine,
    inner: Arc<Mutex<Inner>>,
    next_client: AtomicU64,
    /// The `nest.*` methods the product registered.
    registry: RwLock<Registry>,
    /// Interface modules from installed packages, told to a client at hello.
    /// Held here rather than resolved per call because it changes when a
    /// package is installed, not when someone asks.
    ui_contributions: RwLock<Value>,
}

impl Hub {
    pub async fn new(
        engine: Engine,
        registry: Registry,
        replay_from: Option<std::path::PathBuf>,
    ) -> anyhow::Result<Arc<Self>> {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let sink: Sink = Arc::new(HubSink { inner: inner.clone() });
        let client = engine.server.accept_connection(sink);
        let hub = Arc::new(Self {
            replay_from,
            server: engine.server.clone(),
            client,
            engine,
            inner,
            next_client: AtomicU64::new(1),
            registry: RwLock::new(registry),
            ui_contributions: RwLock::new(json!([])),
        });
        // Host-level notifications go to every client.
        hub.engine_call("daemon.subscribeEvents", json!({})).await.ok();
        Ok(hub)
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub(crate) fn replay_from(&self) -> Option<&std::path::Path> {
        self.replay_from.as_deref()
    }

    pub async fn registry(&self) -> tokio::sync::RwLockReadGuard<'_, Registry> {
        self.registry.read().await
    }

    /// Replace what a client will be told the packages contribute.
    ///
    /// Called at assembly and again after an install: a package that needed a
    /// reload to appear is a package nobody will believe installed.
    pub async fn set_ui_contributions(&self, contributions: Value) {
        *self.ui_contributions.write().await = contributions;
    }

    /// A writable handle, for registration at assembly.
    ///
    /// Registration happens once, before anything is served. A contribution
    /// cannot change what this process is while it runs (§3.1) — enabling a
    /// package takes effect from the next round of assembly.
    pub async fn registry_mut(&self) -> tokio::sync::RwLockWriteGuard<'_, Registry> {
        self.registry.write().await
    }

    /// One JSON-RPC call into the engine, in-process. No socket, no frame, no
    /// id mapping: dispatch returns the response.
    pub async fn engine_call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let req: RpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0", "method": method, "params": params, "id": 0,
        }))
        .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        debug!(method, "engine call →");
        let resp = self.server.dispatch_public(req, self.client.clone()).await;
        debug!(method, ok = resp.error.is_none(), "engine call ←");
        split(resp)
    }

    /// Register a client and get the id its frames are addressed by.
    pub async fn add_client(&self, sink: Arc<dyn FrameSink>) -> ClientId {
        let id = ClientId(self.next_client.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        self.inner.lock().await.clients.insert(id, sink);
        id
    }

    pub async fn remove_client(&self, id: ClientId) {
        let mut guard = self.inner.lock().await;
        guard.clients.remove(id);
        for state in guard.sessions.values_mut() {
            state.watchers.remove(&id);
        }
    }

    pub async fn shutdown(&self) {
        self.server.drop_connection(self.client.id()).await;
        self.engine.shutdown().await;
    }

    /// What a client is told once, after the handshake: what this engine is,
    /// what scenes and commands exist, and what the ceilings are.
    async fn hello(&self) -> Result<Value, RpcError> {
        let status = self.engine_call("daemon.status", json!({})).await.unwrap_or(json!({}));
        let scenes = self.engine_call("scene.list", json!({})).await.unwrap_or(json!({}));
        let commands = self.engine_call("commands.list", json!({})).await.unwrap_or(json!({}));
        Ok(json!({
            "protocol_version": nest_contract::PROTOCOL_VERSION,
            "contrib_api_version": nest_contract::CONTRIB_API_VERSION,
            "engine": {
                "model": self.engine.model,
                "active_scenes": self.engine.active_scenes,
                "data_root": self.engine.data_root.display().to_string(),
                "has_credentials": self.engine.has_credentials,
                "status": status,
            },
            "scenes": scenes.get("scenes").cloned().unwrap_or(json!([])),
            "commands": commands.get("commands").cloned().unwrap_or(json!([])),
            // Interface modules the installed packages contribute, flat and
            // in load order. An array, not a map by point: the client imports
            // each one and the module decides what it registers, so grouping
            // by point here would be a shape nothing reads.
            "contributions": self.ui_contributions.read().await.clone(),
            "limits": {
                "max_frame_bytes": 16 * 1024 * 1024,
                "replay_max_frames": replay::MAX_FRAMES,
            },
        }))
    }

    /// What every contribution did, and what did not take. Queryable rather
    /// than logged: "why is my contribution not working" needs an answer
    /// (§2.4).
    async fn contributions(&self) -> Result<Value, RpcError> {
        let registry = self.registry.read().await;
        let refusals: Vec<Value> = registry
            .refusals()
            .iter()
            .map(|(who, point, reason)| json!({"who": who, "point": point, "reason": reason}))
            .collect();
        Ok(json!({
            "methods": registry.method_names(),
            "refused": refusals,
        }))
    }

    /// Dispatch one already-authorized call.
    ///
    /// Order is: the hub's own semantics, then contributed methods, then the
    /// engine. A contribution cannot shadow a hub method — the registry
    /// refuses a name already taken, and these names are taken at assembly.
    async fn dispatch(self: &Arc<Self>, subject: &Subject, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "nest.hello" => return self.hello().await,
            "nest.contributions" => return self.contributions().await,
            "nest.sessions" => return self.sessions().await,
            "nest.attach" => return self.attach(subject, params).await,
            "nest.detach" => return self.detach(subject, params).await,
            "nest.send" => return self.send(subject, params).await,
            "nest.queue.remove" => return self.queue_remove(params).await,
            "session.interrupt" => return self.interrupt(params).await,
            "session.close" | "session.delete" => return self.close_or_delete(method, params).await,
            "session.create" => return self.create(params).await,
            _ => {}
        }
        if let Some(handler) = self.registry.read().await.lookup(method).cloned() {
            return handler.call(subject, params).await;
        }
        if PASSTHROUGH.contains(&method) {
            return self.engine_call(method, params).await;
        }
        Err(RpcError::not_found(format!("`{method}` is not a method of this process")))
    }
}

/// The hub is the thing behind the gate. Authorization decides; this answers.
///
/// A separate type rather than `impl Gate for Hub`, because every method here
/// needs the `Arc` — a turn outlives the call that started it, which is the
/// whole point of the hub owning turns.
pub struct HubGate(pub Arc<Hub>);

#[async_trait::async_trait]
impl Gate for HubGate {
    async fn call(&self, subject: &Subject, method: &str, params: Value) -> Result<Value, RpcError> {
        self.0.dispatch(subject, method, params).await
    }
}

/// The hub's own end of the engine connection: every `session.event` and
/// `daemon.event` the engine emits arrives here.
struct HubSink {
    inner: Arc<Mutex<Inner>>,
}

#[async_trait::async_trait]
impl EngineFrameSink for HubSink {
    async fn send_json(&self, json: String) -> bool {
        let Ok(frame) = serde_json::from_str::<Value>(&json) else {
            return true;
        };
        // Replies to the hub's own calls come back from `dispatch_public`
        // directly; anything carrying an id here is not ours to route.
        if frame.get("id").is_some() {
            return true;
        }
        match frame.get("method").and_then(Value::as_str) {
            Some("session.event") => {
                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                session::route_event(&self.inner, params).await;
            }
            Some("daemon.event") => {
                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                let out = Frame::host(notification("nest.host_event", params));
                let guard = self.inner.lock().await;
                guard.clients.broadcast(&out).await;
            }
            other => debug!(method = ?other, "unrouted engine frame"),
        }
        true
    }
}

pub(crate) fn notification(method: &str, params: Value) -> String {
    serde_json::to_string(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
        .unwrap_or_else(|_| String::from("{}"))
}

fn split(resp: RpcResponse) -> Result<Value, RpcError> {
    if let Some(error) = resp.error {
        return Err(RpcError {
            code: error.code,
            message: error.message,
            data: error.data,
        });
    }
    Ok(resp.result.unwrap_or(Value::Null))
}

pub(crate) fn require_session_id(params: &Value) -> Result<String, RpcError> {
    params
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params("missing session_id"))
}

/// Recording is on by default, and it is the hub that turns it on because it
/// owns every way a runnable session comes into being — `session.create` and
/// the `session.resume` behind an attach.
///
/// Without a recording there is no answer to "what did the model actually
/// see", and that question is not optional (§6.4). No `dir` is named: the
/// engine resolves the root from settings and assembly resolves the same way
/// for reading, so there is one answer rather than two.
///
/// # Which mode is not a client's decision
///
/// A client cannot ask for `replay`, or for a different root: the key is
/// overwritten, not defaulted. Replay is a **process-level** decision, made
/// by whoever started this one — the same kind of decision as which engine
/// root to serve, and for the same reason.
///
/// When the operator has made it, and only then, a client may name *which*
/// recording to play. That is not a loosening: outside replay the name means
/// nothing, and inside it, naming the fixture is the entire point.
pub(crate) fn with_recording(mut params: Value, replay_from: Option<&std::path::Path>) -> Value {
    let named = params
        .get("options")
        .and_then(|o| o.get("recorder"))
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let recorder = match replay_from {
        Some(dir) => json!({
            "mode": "replay",
            "name": named,
            "dir": dir.display().to_string(),
            // Divergences are reported, not fatal — and that is a concession
            // to a fact, not a preference.
            //
            // Strict replay compares the live request against the recorded
            // one. The assembled prompt carries **today's date** and absolute
            // paths, so a strict fixture stops matching the morning after it
            // was recorded, and again on any machine with a different
            // checkout path. What replay is for here is making an agent's
            // *behaviour* deterministic — the tool calls, the permission
            // asks, the sub-agents — and that works regardless.
            //
            // Making strict possible needs the engine's `environment` seam
            // (the one that owns "the date in the prompt") to be settable by
            // a host. That is filed; until then, strictness would only ever
            // be a test that fails at midnight.
            "strict": false,
        }),
        None => json!({"mode": "record"}),
    };
    let options = params
        .as_object_mut()
        .map(|obj| obj.entry("options").or_insert_with(|| json!({})));
    if let Some(Value::Object(options)) = options {
        options.insert("recorder".into(), recorder);
    }
    params
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

pub(crate) fn is_code(result: &Result<Value, RpcError>, code: i32) -> bool {
    matches!(result, Err(e) if e.code == code)
}

