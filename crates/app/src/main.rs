//! `nest` — AttaCore in a browser tab.
//!
//! Builds the engine in this process (no daemon subprocess, no socket), wraps
//! it in the session hub, and serves the single-file app over loopback. See
//! docs/architecture.md.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;

use clap::Parser;
use nest_engine::EngineConfig;
use nest_hub::Hub;

mod paths;
use paths::{RootArgs, Roots};

#[derive(Parser, Debug)]
#[command(version, about = "AttaCore web front end")]
struct Cli {
    /// Port to serve on.
    #[arg(long, default_value = "4080")]
    port: u16,

    /// Bind address. Loopback only: there is no authentication layer here yet,
    /// and a reachable listener would hand an unauthenticated caller a
    /// fully-tooled agent.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// Default scene for new sessions, and the state root under
    /// `~/.atta/scenes/<scene>/`.
    #[arg(long, default_value = "coding")]
    scene: String,

    /// Extra scenes to activate, comma-separated (e.g. `chat,research`).
    #[arg(long, value_delimiter = ',')]
    scenes: Vec<String>,

    /// Model for new sessions. Settings tiers still win over this the same way
    /// they do for `attacored`.
    #[arg(long, default_value = "claude-sonnet-4-6")]
    model: String,

    #[arg(long, default_value = "2000")]
    max_tokens: u32,

    #[arg(long, default_value = "32")]
    session_cap: usize,

    #[arg(long, default_value = "3600")]
    session_idle_timeout: u64,

    /// Seconds a permission prompt may go unanswered before the engine denies
    /// it. The UI shows this as a countdown.
    #[arg(long, default_value = "300")]
    permission_prompt_timeout: u64,

    /// The engine's directory — what Nest points AttaCore at: settings tiers,
    /// transcripts, memory, skills. Defaults to `$ATTA_CONFIG_HOME`, else
    /// `~/.atta`, so an existing install keeps its sessions.
    #[arg(long)]
    atta_dir: Option<PathBuf>,

    /// The projects directory: where the picker starts and where a new project
    /// is created. Defaults to `$NEST_DATA_DIR`, else `~/Documents`. A
    /// starting point, not a fence — projects elsewhere under `$HOME` still
    /// open.
    #[arg(long)]
    data_dir: Option<PathBuf>,

    /// Serve the web app from this directory instead of the copy compiled into
    /// the binary — for working on the front end: edit, reload, no rebuild.
    #[arg(long)]
    assets_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,nest=debug")),
        )
        .init();

    let cli = Cli::parse();
    if !cli.host.is_loopback() {
        anyhow::bail!(
            "--host must be a loopback address; `{}` is reachable from the network",
            cli.host
        );
    }

    let roots = Roots::resolve(&RootArgs {
        atta_dir: cli.atta_dir.clone(),
        data_dir: cli.data_dir.clone(),
    });
    tracing::info!(
        engine = %roots.engine.display(),
        projects = %roots.projects.display(),
        state = %roots.state.display(),
        "directories"
    );

    let engine = nest_engine::build(EngineConfig {
        scene: cli.scene.clone(),
        scenes: cli.scenes.clone(),
        model: cli.model.clone(),
        max_tokens: cli.max_tokens,
        session_cap: cli.session_cap,
        session_idle_timeout_secs: cli.session_idle_timeout,
        permission_prompt_timeout_secs: cli.permission_prompt_timeout,
        data_root: roots.engine.clone(),
    })
    .await?;
    tracing::info!(
        scenes = ?engine.active_scenes,
        model = %engine.model,
        "engine ready (in-process)"
    );

    let state_root = roots.state.clone();
    let hub = Hub::new(engine, state_root.clone(), roots.projects.clone()).await?;

    // The page carries the token; the URL does not need it, and keeping it out
    // of the URL keeps it out of shell history and terminal scrollback. Tests
    // and other local tooling read it from the run directory.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let token_file = state_root.join("token");
    if let Err(e) = std::fs::write(&token_file, &token) {
        tracing::warn!(error = %e, "could not write the token file");
    }
    // Both loopback families, or exactly what was asked for. `localhost`
    // resolves to `::1` first in every current browser, so a v4-only listener
    // is a page that will not open.
    let mut addrs = vec![SocketAddr::new(cli.host, cli.port)];
    if cli.host.is_loopback() && cli.host.is_ipv4() {
        addrs.push(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), cli.port));
    }
    let addr = addrs[0];

    if let Some(dir) = &cli.assets_dir {
        tracing::info!(dir = %dir.display(), "serving the web app from disk");
    }
    let router = nest_web::router(hub.clone(), token, cli.assets_dir.clone());
    let server = tokio::spawn(async move { nest_web::serve(&addrs, router).await });

    println!("\n  nest → http://{addr}/\n  token → {}\n", token_file.display());

    tokio::select! {
        result = server => { result??; }
        _ = tokio::signal::ctrl_c() => {
            println!("shutting down…");
        }
    }

    hub.shutdown().await;
    // Uploads are this process's scratch; the rest of the state root outlives us.
    let _ = std::fs::remove_dir_all(state_root.join("uploads").join(std::process::id().to_string()));
    Ok(())
}
