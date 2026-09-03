//! Transport: a set of channel semantics, not a connection topology.
//!
//! **The semantics are fixed; the topology is a choice** (§3.3). Different
//! deployments want different things from a connection: at the edge on a weak
//! link, one fewer connection is one fewer reconnect and heartbeat; behind a
//! reverse proxy, letting requests go over ordinary HTTP buys the middleware,
//! caching and rate limiting that already exist; a read-only client that only
//! wants progress should not be made to open a channel it could send on.
//! None of that should force the hub to speak differently.
//!
//! So this layer maps five semantics — unary, session events, host events,
//! out-of-band answers, bulk — onto whichever topology was negotiated, and
//! everything below it is written in terms of the semantics. That is what
//! makes §3.3.3's fifth invariant checkable: adding a topology changes this
//! crate and nothing under it.
//!
//! It does not know what a session is. It moves frames, checks an origin,
//! serves a static face if there is one, and takes uploads.

mod admission;
mod bulk;
mod handshake;
mod session;
mod split;
mod statics;
mod ws;

pub use bulk::BulkStore;
pub use statics::{Face, StaticFace, CSP};

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use nest_contract::{Gate, Topology};

#[derive(Clone)]
pub struct Config {
    /// Topologies this deployment serves. A client picks one at handshake;
    /// anything else is refused with a reason, never silently downgraded.
    pub topologies: Vec<Topology>,
    /// One per-process token, injected into the page and checked on connect.
    ///
    /// Binding to loopback does not keep other pages out: a web page cannot
    /// read a cross-origin response, but it *can* open a WebSocket to
    /// `ws://127.0.0.1:<port>`. The origin check refuses browsers that are
    /// not us — a page cannot forge that header — and this refuses everything
    /// else.
    pub token: String,
    /// Where the interface comes from: the one compiled in, a directory that
    /// replaces it, or none at all.
    pub face: statics::Face,
    /// TLS material. Required for any non-loopback bind — see [`serve`].
    pub tls: Option<Tls>,
    /// How a connection proves it may be here.
    ///
    /// On loopback the per-process token is the whole story: the listener is
    /// unreachable from the network, and the token is what keeps another page
    /// on this machine out. Off loopback the token is **not** enough — it is
    /// one secret shared by every device, so it cannot be revoked for one of
    /// them — and a paired device signing a server-chosen challenge is
    /// required as well (§6.3).
    pub admission: Admission,
    pub max_upload_bytes: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Admission {
    /// Loopback: the per-process token.
    Token,
    /// Reachable: the token *and* a paired device's signature.
    PairedDevice,
}

/// A certificate and its key, as files on disk.
///
/// Operator-provided, and there is no generator here on purpose. A
/// self-signed certificate this process minted would need a trust story to go
/// with it — a fingerprint to check, somewhere to check it — and inventing
/// half of one is how a system ends up with a security feature that is really
/// a habit. Whoever exposes this to a network already has a way to get a
/// certificate.
#[derive(Clone, Debug)]
pub struct Tls {
    pub cert: std::path::PathBuf,
    pub key: std::path::PathBuf,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub gate: Arc<dyn Gate>,
    pub hub: Arc<nest_hub::Hub>,
    pub bulk: Arc<dyn BulkStore>,
    pub config: Arc<Config>,
    pub statics: Arc<StaticFace>,
    /// Established handshakes, by credential. Shared by every topology,
    /// because a credential belongs to the subject rather than to whichever
    /// connection happens to carry it.
    pub sessions: Arc<session::Sessions>,
    pub devices: Arc<nest_authz::Devices>,
    pub challenges: Arc<admission::Challenges>,
}

pub fn router(
    gate: Arc<dyn Gate>,
    hub: Arc<nest_hub::Hub>,
    bulk: Arc<dyn BulkStore>,
    devices: Arc<nest_authz::Devices>,
    config: Config,
) -> (Router, Arc<StaticFace>) {
    let statics = Arc::new(StaticFace::new(config.face.clone()));
    let topologies = config.topologies.clone();
    let state = AppState {
        gate,
        hub,
        bulk,
        config: Arc::new(config),
        statics,
        sessions: Arc::new(session::Sessions::default()),
        devices,
        challenges: Arc::new(admission::Challenges::default()),
    };
    // Bulk is registered once and is identical in every topology: it is not a
    // property of any of them, it is what stops one image from filling the
    // frame ceiling.
    // `/ws` is routed even where the bidirectional topology is not served, so
    // a client that speaks it gets a refusal naming what *is* offered instead
    // of a 404. "There is no such endpoint" and "this deployment does not
    // carry that topology" are different answers, and only the second one
    // tells the client what to try next.
    let mut router = Router::new()
        .route("/upload", post(bulk::upload))
        .route("/ws", get(ws::upgrade))
        // The two things available before admission. Minting a challenge
        // gives away nothing; redeeming a pairing code is how the first
        // device on a reachable node comes to exist at all.
        .route("/challenge", get(admission::mint))
        .route("/pair", post(admission::pair));
    if topologies.contains(&Topology::SplitStreams) {
        router = router
            .route("/handshake", post(split::establish))
            .route("/rpc", post(split::rpc))
            .route("/respond", post(split::respond))
            .route("/events/session", get(split::session_events))
            .route("/events/host", get(split::host_events));
    }
    if state.statics.serves_anything() {
        router = router.fallback(get(statics::serve));
    }
    let face = state.statics.clone();
    (router.with_state(state), face)
}

/// Origins a browser may connect from: loopback, any port.
///
/// Which port the interface is served on is a deployment detail — pinning it
/// would mean changing the backend to change the interface's port. A missing
/// `Origin` is not a browser and is left to the token.
pub(crate) fn origin_allowed(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    else {
        return true;
    };
    let host = origin.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("");
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Serve on every given address, sharing one router.
///
/// Loopback is **two** addresses. Most systems resolve `localhost` to `::1`
/// first, so a service bound only to v4 answers `curl` and fails to open a
/// page. The v6 bind failing is a warning, not a startup failure.
///
/// # There is no plaintext remote
///
/// A non-loopback bind without TLS is refused here, at the point of binding.
/// Not a default that can be turned off, not a warning — the path does not
/// exist (§6.3). Anything reachable from a network carries a fully-tooled
/// agent and a live model credential, and "it was only for a minute" is how
/// every one of those gets exposed.
pub async fn serve(addrs: &[SocketAddr], router: Router, tls: Option<Tls>) -> anyhow::Result<()> {
    use std::future::IntoFuture;

    if let Some(addr) = addrs.iter().find(|a| !a.ip().is_loopback()) {
        if tls.is_none() {
            anyhow::bail!(
                "{addr} is reachable from the network and no TLS material was given. \
                 There is no plaintext remote: pass --tls-cert and --tls-key, or bind loopback."
            );
        }
    }

    let config = match &tls {
        Some(tls) => {
            // Installed once, and only when TLS is actually used, so a
            // loopback-only run links the provider without initialising it.
            let _ = rustls::crypto::ring::default_provider().install_default();
            Some(
                axum_server::tls_rustls::RustlsConfig::from_pem_file(&tls.cert, &tls.key)
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "TLS material at {} / {}: {e}",
                            tls.cert.display(),
                            tls.key.display()
                        )
                    })?,
            )
        }
        None => None,
    };

    let mut servers = Vec::new();
    for addr in addrs {
        match (&config, tokio::net::TcpListener::bind(addr).await) {
            (Some(config), Ok(listener)) => {
                tracing::info!(%addr, "listening (TLS)");
                let listener = listener.into_std()?;
                let router = router.clone();
                let config = config.clone();
                servers.push(tokio::spawn(async move {
                    axum_server::from_tcp_rustls(listener, config)
                        .serve(router.into_make_service())
                        .await
                        .map_err(|e| anyhow::anyhow!("{e}"))
                }));
            }
            (None, Ok(listener)) => {
                tracing::info!(%addr, "listening");
                let router = router.clone();
                servers.push(tokio::spawn(async move {
                    axum::serve(listener, router)
                        .into_future()
                        .await
                        .map_err(|e| anyhow::anyhow!("{e}"))
                }));
            }
            (_, Err(e)) if addr.is_ipv6() => {
                tracing::warn!(%addr, error = %e, "no IPv6 listener; IPv4 only")
            }
            (_, Err(e)) => anyhow::bail!("could not bind {addr}: {e}"),
        }
    }
    if servers.is_empty() {
        anyhow::bail!("no listener could be bound");
    }
    for server in servers {
        let _ = server.await;
    }
    Ok(())
}
