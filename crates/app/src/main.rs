//! `nest` — AttaCore, assembled into a product.
//!
//! One binary, one process, one user, many sessions. The engine is linked in
//! and called in-process: no subprocess, no socket, no port allocation, no
//! discovery file.
//!
//! This file is the wiring and nothing else. It resolves the profile, stands
//! up the four kernel parts in dependency order — assembly, hub,
//! authorization, transport — and gets out of the way. Every decision it
//! makes is either a command-line flag or a line in the profile; none of them
//! is buried here.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use nest_assembly::{EngineConfig, Profile};
use nest_authz::{Audit, Authorizer, Devices, MethodTable, Reach, ENGINE_REFUSALS};
use nest_builtin::Builtin;
use nest_contract::{Gate, Topology};
use nest_contrib::Registry;
use nest_hub::{Hub, HubGate};

mod audit_log;
mod devices;
mod methods;
mod paths;
use paths::{RootArgs, Roots};

#[derive(clap::Subcommand, Debug)]
enum Command {
    /// Work with the interface this binary carries.
    #[command(subcommand)]
    Ui(UiCommand),
}

#[derive(clap::Subcommand, Debug)]
enum UiCommand {
    /// Write the interface out, for something else to serve.
    ///
    /// For the deployment where a CDN or a proxy has its own static root.
    /// The binary still carries it, so there is one artifact to install and
    /// the files are available when they are wanted — rather than a second
    /// download to keep in step with this one.
    Export {
        /// Where to write it.
        dir: PathBuf,
    },
}

#[derive(Parser, Debug)]
#[command(version, about = "AttaCore, assembled into a product")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// A profile: which scenes, which providers, which plugins, which
    /// interface, which transport topology. Flags below override what it says.
    #[arg(long)]
    profile: Option<PathBuf>,

    #[arg(long)]
    port: Option<u16>,

    /// Bind address. Loopback only for now: a reachable listener needs paired
    /// devices and TLS, and until those exist there is no such path rather
    /// than a default that can be turned off.
    #[arg(long)]
    host: Option<IpAddr>,

    /// Default scene for new sessions, and the state root under
    /// `<engine-dir>/scenes/<scene>/`.
    #[arg(long)]
    scene: Option<String>,

    /// Extra scenes to activate, comma-separated (e.g. `chat,research`).
    #[arg(long, value_delimiter = ',')]
    scenes: Vec<String>,

    /// Model for new sessions. Settings tiers still win over this.
    #[arg(long)]
    model: Option<String>,

    /// Serve the interface from this directory instead of the one compiled
    /// in. For working on the front end, and for running a different
    /// interface without rebuilding the backend.
    #[arg(long)]
    ui_dir: Option<PathBuf>,

    /// Serve no interface at all — a pure RPC node.
    #[arg(long)]
    headless: bool,

    /// Play recordings back from this directory instead of calling a model.
    ///
    /// A whole-process decision, and only an operator's to make: a client
    /// cannot ask for it. What it is for is tests — an agent's behaviour
    /// (tool calls, permission asks, sub-agents) becomes deterministic and
    /// free, instead of depending on what a provider felt like doing.
    #[arg(long)]
    replay_dir: Option<PathBuf>,

    /// TLS certificate chain (PEM). Required to bind anything but loopback.
    #[arg(long)]
    tls_cert: Option<PathBuf>,

    /// TLS private key (PEM).
    #[arg(long)]
    tls_key: Option<PathBuf>,

    /// The engine's directory: settings tiers, transcripts, memory, skills,
    /// recordings. Defaults to `$ATTA_CONFIG_HOME`, else `~/.atta`.
    #[arg(long)]
    atta_dir: Option<PathBuf>,

    /// The projects directory: where the picker starts and where a new project
    /// is created. Defaults to `$NEST_DATA_DIR`, else `~/Documents`. A
    /// starting point, not a fence.
    #[arg(long)]
    data_dir: Option<PathBuf>,
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
    if let Some(Command::Ui(UiCommand::Export { dir })) = &cli.command {
        let count = nest_transport::StaticFace::export(dir)?;
        println!("\n  {count} files → {}\n", dir.display());
        return Ok(());
    }
    let profile = resolve_profile(&cli)?;

    let host: IpAddr = profile.transport.host.parse()?;
    // A non-loopback bind needs TLS, and `nest_transport::serve` refuses it
    // without. Refused at the point of binding rather than here, so every
    // caller of that function inherits the rule instead of remembering it.
    let tls = match (&cli.tls_cert, &cli.tls_key) {
        (Some(cert), Some(key)) => Some(nest_transport::Tls {
            cert: cert.clone(),
            key: key.clone(),
        }),
        (None, None) => None,
        _ => anyhow::bail!("--tls-cert and --tls-key go together"),
    };

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

    // ── Assembly ────────────────────────────────────────────────────────
    let engine = nest_assembly::build_engine(EngineConfig {
        scene: profile.engine.scene.clone(),
        scenes: profile.engine.scenes.clone(),
        model: profile.engine.model.clone(),
        max_tokens: profile.engine.max_tokens,
        session_cap: profile.engine.session_cap,
        session_idle_timeout_secs: profile.engine.session_idle_timeout_secs,
        permission_prompt_timeout_secs: profile.engine.permission_prompt_timeout_secs,
        data_root: roots.engine.clone(),
    })
    .await?;
    tracing::info!(
        scenes = ?engine.active_scenes,
        model = %engine.model,
        "engine ready (in-process)"
    );

    // ── Hub ─────────────────────────────────────────────────────────────
    let registry = Registry::new();
    if let Some(dir) = &cli.replay_dir {
        tracing::warn!(
            dir = %dir.display(),
            "replaying recordings; no model will be called"
        );
    }
    let hub = Hub::new(engine, registry, cli.replay_dir.clone()).await?;

    // ── Built-ins, through the public door ──────────────────────────────
    // Where the engine keeps installed packages. Nest reads two sections out
    // of them and serves one directory; it never writes here.
    let plugins_dir = roots.engine.join("plugins");
    let builtin = Builtin::new(
        hub.clone(),
        roots.state.clone(),
        roots.projects.clone(),
        plugins_dir,
    )?;
    {
        let mut registry = hub.registry_mut().await;
        builtin.register(&mut registry).await;
    }

    // ── Authorization ───────────────────────────────────────────────────
    let audit = Arc::new(Audit::default());
    // Decisions worth going back for land in the session timeline, as engine
    // extension entries — in order with everything else, and skippable by
    // anything that does not know what they are (§6.5). The ring stays for
    // the diagnostics page.
    if let Some(store) = hub.engine().history.clone() {
        audit.set_sink(Box::new(audit_log::TimelineAudit::new(store)));
    } else {
        tracing::warn!("no history store; audit entries live only in memory");
    }
    let paired = Arc::new(Devices::default());
    {
        let mut registry = hub.registry_mut().await;
        // Revoking is wired to the transport's session registry, because
        // ending a device's channels needs the layer that knows there are
        // channels. Nothing above transport ever learns there were.
        let ended = paired.clone();
        devices::register(
            &mut registry,
            paired.clone(),
            Arc::new(move |id: &str| {
                let _ = &ended;
                tracing::info!(device = id, "revoked; its channels are being closed");
            }),
        );
    }
    let gate: Arc<dyn Gate> = Arc::new(Authorizer::new(
        methods::table(),
        Arc::new(HubGate(hub.clone())),
        audit.clone(),
    ));

    // ── Transport ───────────────────────────────────────────────────────
    // The page carries the token; the URL does not need it, and keeping it
    // out of the URL keeps it out of shell history and terminal scrollback.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let token_file = roots.state.join("token");
    if let Err(e) = std::fs::write(&token_file, &token) {
        tracing::warn!(error = %e, "could not write the token file");
    }

    // Which interface, said once and logged, because "I edited a file and
    // nothing changed" is the failure this choice produces when it is silent.
    let face = match (cli.headless, profile.ui.dir.clone()) {
        (true, _) => nest_transport::Face::Headless,
        (false, Some(dir)) => nest_transport::Face::Directory(dir),
        (false, None) => nest_transport::Face::Embedded,
    };
    match &face {
        nest_transport::Face::Embedded => tracing::info!("serving the interface compiled in"),
        nest_transport::Face::Directory(dir) => {
            tracing::info!(dir = %dir.display(), "serving the interface from disk, not the one compiled in")
        }
        nest_transport::Face::Headless => tracing::info!("headless: no interface, RPC only"),
    }

    let (router, statics) = nest_transport::router(
        gate,
        hub.clone(),
        builtin.clone(),
        paired.clone(),
        nest_transport::Config {
            topologies: profile.transport.topologies.clone(),
            token: token.clone(),
            face: face.clone(),
            tls: tls.clone(),
            // Decided by where this listens, not by a setting. A reachable
            // listener needs a paired device; loopback does not have one to
            // ask for yet, and does not need one (§6.3).
            admission: if host.is_loopback() {
                nest_transport::Admission::Token
            } else {
                nest_transport::Admission::PairedDevice
            },
            max_upload_bytes: builtin.max_upload_bytes(),
        },
    );

    // Both loopback families, or exactly what was asked for. `localhost`
    // resolves to `::1` first in every current browser, so a v4-only listener
    // is a page that will not open.
    let mut addrs = vec![SocketAddr::new(host, profile.transport.port)];
    if host.is_loopback() && host.is_ipv4() {
        addrs.push(SocketAddr::new(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            profile.transport.port,
        ));
    }
    let addr = addrs[0];
    // What the installed packages contribute to this side, resolved once
    // before anything is served. A package installed later refreshes this —
    // one that needed a restart to appear is one nobody will believe
    // installed.
    refresh_packages(&builtin, &statics).await;
    {
        // And again whenever a package is installed. Registered after the
        // first pass so the two cannot race on startup.
        let hub = hub.clone();
        let statics = statics.clone();
        builtin
            .on_packages_changed(move |contributions| {
                apply_packages(&hub, &statics, contributions);
            })
            .await;
    }

    // Before anything is served: a reachable node with no paired device has
    // no way to acquire one, because pairing is a method and methods need
    // admission. This is where that circle is broken.
    devices::bootstrap(&paired, !host.is_loopback());

    let server = tokio::spawn(async move { nest_transport::serve(&addrs, router, tls).await });

    let scheme = if cli.tls_cert.is_some() { "https" } else { "http" };
    println!(
        "\n  nest → {scheme}://{addr}/\n  token → {}\n  topology → {}\n",
        token_file.display(),
        profile
            .transport
            .topologies
            .iter()
            .map(Topology::as_str)
            .collect::<Vec<_>>()
            .join(", ")
    );

    tokio::select! {
        result = server => { result??; }
        _ = tokio::signal::ctrl_c() => println!("shutting down…"),
    }

    hub.shutdown().await;
    // Uploads are this process's scratch; the rest of the state root outlives
    // it.
    let _ = std::fs::remove_dir_all(roots.state.join("uploads").join(std::process::id().to_string()));
    Ok(())
}

/// Point the static face at what is installed now.
async fn refresh_packages(builtin: &Arc<Builtin>, statics: &Arc<nest_transport::StaticFace>) {
    apply_packages(builtin.hub(), statics, builtin.contributions().await);
}

/// Serve what these packages contribute, and tell clients about it.
///
/// Spawned rather than awaited, because this is called from a callback that
/// cannot be async — the alternative was making the whole notification path
/// async for the sake of two assignments.
fn apply_packages(
    hub: &Arc<Hub>,
    statics: &Arc<nest_transport::StaticFace>,
    contributions: Vec<nest_builtin::packages::Contributions>,
) {
    if !contributions.is_empty() {
        tracing::info!(
            packages = contributions.len(),
            ui = contributions.iter().map(|c| c.ui.len()).sum::<usize>(),
            "packages contribute to the interface"
        );
    }
    statics.set_packages(
        contributions
            .iter()
            .filter(|c| c.enabled)
            .map(|c| (c.plugin.clone(), c.root.clone()))
            .collect(),
    );
    let modules: Vec<serde_json::Value> = contributions
        .iter()
        .filter(|c| c.enabled)
        .flat_map(|c| {
            c.ui.iter().map(|entry| {
                serde_json::json!({
                    "plugin": c.plugin,
                    "point": entry.point,
                    "module": format!("/plugins/{}/ui/{}", c.plugin, entry.module),
                })
            })
        })
        .collect();
    let hub = hub.clone();
    tokio::spawn(async move {
        hub.set_ui_contributions(serde_json::json!(modules)).await;
    });
}

/// The profile, then the flags on top of it.
///
/// A flag overriding a profile line is the ordinary case — try a different
/// scene without editing a file. A flag is only applied when it was actually
/// given, so an unmentioned flag does not quietly reset a profile line to its
/// own default.
fn resolve_profile(cli: &Cli) -> anyhow::Result<Profile> {
    let mut profile = match &cli.profile {
        Some(path) => Profile::load(path)?,
        None => Profile::default(),
    };
    if let Some(port) = cli.port {
        profile.transport.port = port;
    }
    if let Some(host) = cli.host {
        profile.transport.host = host.to_string();
    }
    if let Some(scene) = &cli.scene {
        profile.engine.scene = scene.clone();
    }
    if !cli.scenes.is_empty() {
        profile.engine.scenes = cli.scenes.clone();
    }
    if let Some(model) = &cli.model {
        profile.engine.model = model.clone();
    }
    if let Some(dir) = &cli.ui_dir {
        profile.ui.dir = Some(dir.clone());
    }
    Ok(profile)
}

/// Silence the unused-import warning for a constant that documents the
/// refusal list even where the table builder reads it.
const _: &[(&str, &str)] = ENGINE_REFUSALS;
const _: fn() -> MethodTable = || MethodTable::new().allow("", Reach::Kernel);
