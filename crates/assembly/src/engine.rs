//! Standing the engine up, in this process.
//!
//! The engine is linked as a library and called in-process: no socket, no
//! handshake, no subprocess to supervise (§9). This does what `attacored`'s
//! `main.rs` does — resolve scenes, load the settings tiers, build the model
//! client and the `SessionPool` — and stops before the part that binds
//! listeners. What it hands back is a `DaemonServer` whose `dispatch_public`
//! the hub calls directly.
//!
//! It mirrors an assembly that lives upstream, and the only reason it is a
//! mirror is that upstream exposes no bootstrap entry point. When AttaCore
//! grows one, this file becomes a call to it.
//!
//! The engine root is **passed in**, never read from this process's
//! environment: otherwise one process could not serve two roots, and the
//! state would sit somewhere the caller cannot see (§3.1).

use std::path::PathBuf;
use std::sync::Arc;

use base::interface::permission::PermissionOutcome;
use daemon::config::{load_daemon_config, StaticDaemonPaths};
use daemon::{DaemonServer, SessionPool};
use model::client::{AnthropicClient, AuthMode, HttpAnthropicClient};
use tokio_util::sync::CancellationToken;
use tracing::info;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Default scene for `session.create` and the state root under
    /// `~/.atta/scenes/<scene>/`.
    pub scene: String,
    /// Scenes activated on top of `scene`.
    pub scenes: Vec<String>,
    pub model: String,
    pub max_tokens: u32,
    pub session_cap: usize,
    pub session_idle_timeout_secs: u64,
    pub permission_prompt_timeout_secs: u64,
    /// The engine's data root — settings tiers, transcripts, memory, skills.
    /// What `ATTA_CONFIG_HOME` names, resolved by the app and handed in.
    pub data_root: PathBuf,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            scene: "coding".to_string(),
            scenes: Vec::new(),
            model: "claude-sonnet-4-6".to_string(),
            max_tokens: 2000,
            session_cap: 32,
            session_idle_timeout_secs: 3600,
            permission_prompt_timeout_secs: 300,
            data_root: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".atta"),
        }
    }
}

pub struct Engine {
    pub server: Arc<DaemonServer>,
    /// The root this engine was built on, for reporting.
    pub data_root: PathBuf,
    /// The transcript store, for readers that would otherwise page the RPC
    /// surface to get at text (see `search`).
    pub history: Option<Arc<dyn history::store::HistoryStore>>,
    /// Where a session's recording lands — one directory per session id. The
    /// engine has no reader for it, so the hub goes to the files directly;
    /// this is the one place that says which files.
    pub recordings_root: PathBuf,
    pub pool: Arc<SessionPool>,
    pub cancel: CancellationToken,
    /// Scenes actually active after startup, sorted.
    pub active_scenes: Vec<String>,
    /// The model name sessions get with nothing overriding it.
    pub model: String,
    /// Whether a usable credential was found at startup. False means the UI
    /// should send the user to the settings page before a first turn.
    pub has_credentials: bool,
}

impl Engine {
    /// Finish in-flight turns, close every session, cancel the pool's tasks.
    pub async fn shutdown(&self) {
        self.pool.shutdown_all().await;
        self.cancel.cancel();
    }
}

/// Allow-everything permission — handed only to sessions whose effective
/// `permission_mode` is `bypassPermissions`. Everything else gets a real
/// `RuleSetPermission` built by the pool, which is what raises the
/// `session.event{kind:"prompt"}` frames the browser answers.
struct AllowAllPermission;

#[async_trait::async_trait]
impl base::interface::permission::Permission for AllowAllPermission {
    async fn check(
        &self,
        _tool: &str,
        _input: &serde_json::Value,
        _cwd: &std::path::Path,
        _session_id: &str,
    ) -> PermissionOutcome {
        PermissionOutcome::Permit
    }
}

fn resolve_scene(name: &str) -> anyhow::Result<Arc<dyn base::interface::scene::AgentScene>> {
    let mut registry = scene::scene::SceneRegistry::new();
    registry.register_builtin();
    registry.resolve(name).ok_or_else(|| {
        let mut known = registry.ids();
        known.sort();
        anyhow::anyhow!(
            "unsupported scene `{name}` — supported scenes: {}",
            known.join(", ")
        )
    })
}

fn active_scenes(scene: &str, scenes: &[String]) -> Vec<String> {
    let mut all: Vec<String> = std::iter::once(scene.to_string())
        .chain(scenes.iter().cloned())
        .collect();
    all.sort();
    all.dedup();
    all
}

pub async fn build(config: EngineConfig) -> anyhow::Result<Engine> {
    let scene = resolve_scene(&config.scene)?;
    let scope = scene.id().to_string();
    for extra in &config.scenes {
        resolve_scene(extra)?; // fail before any state is touched
    }

    // `{data_root}/scenes/<scope>/` over `{data_root}/` — the same layout
    // `DefaultDaemonPaths::from_env` derives, with the root handed in.
    let paths = StaticDaemonPaths::with_project(
        config.data_root.join("scenes").join(&scope),
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    )
    .with_global(config.data_root.clone());
    let mut daemon_config = load_daemon_config(
        &config.model,
        config.max_tokens,
        // No socket: nothing listens on one. `load_daemon_config` still
        // derives a path for it, which we never create.
        None,
        &scope,
        &paths,
    );
    daemon_config.session_cap = config.session_cap;
    daemon_config.session_idle_timeout_secs = config.session_idle_timeout_secs;
    daemon_config.settings.session_dir = Some(daemon_config.settings.paths.local_data_dir.clone());


    let task_router: Option<Arc<base::provider::TaskRouter>> =
        if daemon_config.settings.providers.is_empty() {
            None
        } else {
            let (resolved, warnings) = base::provider::resolve_task_models(
                &daemon_config.settings.providers,
                daemon_config.settings.default_provider.as_deref(),
                &daemon_config.settings.task_models,
            )
            .map_err(|e| anyhow::anyhow!("invalid multi-provider LLM config: {e}"))?;
            for w in &warnings {
                tracing::warn!("model routing: {w}");
            }
            let default_provider = daemon_config
                .settings
                .default_provider
                .as_deref()
                .expect("resolve_task_models validated default_provider is set");
            let router = daemon::model_router::build_task_router(
                &daemon_config.settings.providers,
                default_provider,
                resolved,
            )
            .map_err(|e| anyhow::anyhow!("failed to build model router: {e}"))?;
            Some(Arc::new(router))
        };

    // A configured provider is a complete answer on its own: the router serves
    // `main` and the client built here is never asked for anything. Requiring
    // an environment variable anyway would mean a fresh install could not be
    // set up from its own settings page.
    let api_key = std::env::var("ANTHROPIC_AUTH_TOKEN")
        .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
        .ok();
    if api_key.is_none() && task_router.is_none() {
        anyhow::bail!(
            "no model credentials: set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY), \
             or configure a provider in settings.json"
        );
    }
    let has_credentials = api_key.is_some();
    let auth = AuthMode::ApiKey(api_key.unwrap_or_default());
    let client: Arc<dyn AnthropicClient> = match std::env::var("ANTHROPIC_BASE_URL").ok() {
        Some(mut url) => {
            if !url.ends_with('/') {
                url.push('/');
            }
            let base = reqwest::Url::parse(&url)
                .map_err(|e| anyhow::anyhow!("invalid ANTHROPIC_BASE_URL: {e}"))?;
            Arc::new(HttpAnthropicClient::with_base(auth, base)?)
        }
        None => Arc::new(HttpAnthropicClient::new(auth)?),
    };

    let global_dir = daemon_config.settings.paths.global_data_dir.clone();
    let local_dir = daemon_config.settings.paths.local_data_dir.clone();
    let settings = Arc::new(daemon_config.settings.clone());
    // What a turn will actually use: with a provider router in play, `main`
    // routes to that provider's model, and reporting the CLI default instead
    // would name a model no request ever reaches.
    let model_name = settings
        .default_provider
        .as_ref()
        .and_then(|id| settings.providers.get(id))
        .and_then(|provider| provider.default_model.clone())
        .unwrap_or_else(|| settings.model.model_name.clone());

    // Mirrors `daemon::session_pool::recordings_root` with no `dir` override,
    // which is how the hub asks for recording (see `nest_hub::recordings`).
    // The two must agree: the daemon decides where a recording is written and
    // this decides where it is read from.
    let recordings_root = settings
        .recorder
        .as_ref()
        .map(|recorder| recorder.root.clone())
        .unwrap_or_else(|| {
            base::paths::ConfigPaths::from_settings(&settings.paths).global_recordings_dir()
        });

    let memory_store = Arc::new(base::interface::memory::MemoryStore::new(
        global_dir.join("memory"),
        local_dir.join("memory"),
    ));

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let permission: Arc<dyn base::interface::permission::Permission> = Arc::new(AllowAllPermission);

    let history_roots = history::path::HistoryRoots::under(&global_dir);
    let migration = history::migrate::migrate_layout(&global_dir);
    if !migration.did_nothing() {
        info!(
            transcripts = migration.transcripts_moved,
            sidecars = migration.sidecars_moved,
            "migrated session state to the projects/ + sessions/ layout"
        );
    }
    let history_store: Option<Arc<dyn history::store::HistoryStore>> =
        match history::store::JsonlHistoryStore::with_roots(&cwd, history_roots).await {
            Ok(store) => Some(Arc::new(store)),
            Err(e) => {
                tracing::warn!(error = %e, "history store unavailable; sessions are in-memory only");
                None
            }
        };
    let history_store_handle = history_store.clone();

    let mcp_servers = daemon_config.settings.mcp_servers.clone();

    let pool = Arc::new(
        SessionPool::new(
            daemon_config.session_cap,
            daemon_config.session_idle_timeout_secs,
            client,
            settings,
            scene,
            permission,
            memory_store,
            cwd,
            history_store,
            daemon_config.paths.clone(),
            task_router,
        )
        .with_permission_prompt_timeout(std::time::Duration::from_secs(
            config.permission_prompt_timeout_secs,
        )),
    );

    for extra in &config.scenes {
        if extra == &config.scene {
            continue;
        }
        pool.activate_scene(extra)
            .await
            .map_err(|(_, message)| anyhow::anyhow!("scene `{extra}`: {message}"))?;
    }

    // Plugin components load before any session can be created: a session
    // built while this is still running is missing every plugin tool with
    // nothing to indicate why. With the plugin feature compiled out this is a
    // no-op.
    pool.load_plugin_components().await;
    let mut mcp_servers = mcp_servers;
    mcp_servers.extend(pool.plugin_mcp_servers().await);
    pool.connect_mcp_servers_in_background(mcp_servers);
    pool.start_janitor();

    let cancel = CancellationToken::new();
    let server = Arc::new(DaemonServer::new(pool.clone(), cancel.clone()));

    Ok(Engine {
        server,
        data_root: config.data_root.clone(),
        history: history_store_handle,
        recordings_root,
        pool,
        cancel,
        active_scenes: active_scenes(&config.scene, &config.scenes),
        model: model_name,
        has_credentials,
    })
}
