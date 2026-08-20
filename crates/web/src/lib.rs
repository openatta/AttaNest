//! The carrier: the app's static files, one WebSocket, one upload route.
//!
//! This layer knows nothing about sessions. It serves the SPA (compiled in, or
//! read from disk with `--assets-dir` while working on it), turns WebSocket
//! text messages into `Hub::handle` calls and hub frames back into messages,
//! and writes upload bodies to the paths the hub granted.
//!
//! Every unknown path answers `index.html` rather than 404: the app owns its
//! own routes, and a deep link that reloads must not land on an error page.
//!
//! ## Why a token on a loopback listener
//!
//! Binding `127.0.0.1` keeps other machines out; it does not keep *pages* out.
//! WebSocket is not subject to the same-origin policy, so any site the user
//! visits can open `ws://127.0.0.1:<port>`. The Origin check refuses browsers
//! that are not us (a page cannot forge that header) and the per-process token
//! — minted at startup, injected into the page — refuses everything else.

use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures::{SinkExt, StreamExt};
use nest_hub::Hub;
use tracing::{info, warn};

/// The app, compiled in: one binary is the whole deployment.
static ASSETS: include_dir::Dir<'_> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../../assets");

/// How many requests one browser may have in flight. The engine refuses past
/// 64 per connection and the hub shares one; a page never needs more than a
/// handful, and a bound here means a runaway tab cannot spend the budget.
const MAX_IN_FLIGHT_PER_BROWSER: usize = 16;

#[derive(Clone)]
pub struct AppState {
    hub: Arc<Hub>,
    token: Arc<String>,
    /// Set while developing: assets are read per request from here instead of
    /// from the binary, so editing a stylesheet is a reload rather than a
    /// rebuild.
    assets_dir: Option<Arc<PathBuf>>,
}

pub fn router(hub: Arc<Hub>, token: String, assets_dir: Option<PathBuf>) -> Router {
    let limit = hub.max_upload_bytes();
    let state = AppState {
        hub,
        token: Arc::new(token),
        assets_dir: assets_dir.map(Arc::new),
    };
    Router::new()
        .route("/ws", get(ws_upgrade))
        .route(
            "/upload",
            post(upload).layer(DefaultBodyLimit::max(limit + 4096)),
        )
        .fallback(get(asset))
        .with_state(state)
}

/// Serve on every given address, all sharing one router.
///
/// Loopback is two addresses, not one: browsers resolve `localhost` to `::1`
/// before `127.0.0.1`, so a v4-only listener answers `curl` and refuses the
/// browser. The first address must bind — that is the one the user was told
/// about — while a later failure (a machine with IPv6 disabled) is a warning.
pub async fn serve(addrs: &[SocketAddr], router: Router) -> anyhow::Result<()> {
    let mut servers = Vec::new();
    for (index, addr) in addrs.iter().enumerate() {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                info!(%addr, "listening");
                servers.push(tokio::spawn(axum::serve(listener, router.clone()).into_future()));
            }
            Err(e) if index == 0 => {
                return Err(anyhow::anyhow!(
                    "could not bind {addr}: {e} (another nest already running?)"
                ));
            }
            Err(e) => warn!(%addr, error = %e, "could not bind this address; continuing"),
        }
    }
    for server in servers {
        server.await??;
    }
    Ok(())
}

/// No inline script or style anywhere in the app, so `'self'` is the whole
/// policy — no hashes to keep in sync, and no `'unsafe-inline'`.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
     connect-src 'self'; img-src 'self' data:; font-src 'self' data:; \
     base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Serve one asset. Anything that is not a file falls back to `index.html`
/// (SPA routing); the index is the only response the token is injected into.
async fn asset(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    // `..` never reaches the disk read below, and a compiled-in lookup cannot
    // escape the archive at all.
    let clean = requested.replace('\\', "/");
    let traversal = clean.split('/').any(|part| part == "..");
    let path = if clean.is_empty() || traversal { "index.html" } else { clean.as_str() };

    let (bytes, path) = match read_asset(&state, path) {
        Some(bytes) => (bytes, path),
        None => match read_asset(&state, "index.html") {
            Some(bytes) => (bytes, "index.html"),
            None => return (StatusCode::NOT_FOUND, "missing index.html").into_response(),
        },
    };

    if path == "index.html" {
        let page = String::from_utf8_lossy(&bytes).replace("__NEST_TOKEN__", &state.token);
        return (
            [
                (header::CONTENT_TYPE, content_type(path)),
                (header::CONTENT_SECURITY_POLICY, CSP),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_FRAME_OPTIONS, "DENY"),
            ],
            page,
        )
            .into_response();
    }

    (
        [
            (header::CONTENT_TYPE, content_type(path)),
            (header::CONTENT_SECURITY_POLICY, CSP),
            // The dev directory must not be cached at all; the compiled-in
            // copy changes only when the binary does, and the binary is what
            // the browser reconnects to.
            (
                header::CACHE_CONTROL,
                if state.assets_dir.is_some() { "no-store" } else { "no-cache" },
            ),
        ],
        bytes,
    )
        .into_response()
}

fn read_asset(state: &AppState, path: &str) -> Option<Vec<u8>> {
    if let Some(dir) = &state.assets_dir {
        return std::fs::read(dir.join(path)).ok();
    }
    ASSETS.get_file(path).map(|file| file.contents().to_vec())
}

/// Origins a browser may connect from: loopback only, any port (which port the
/// page is served from is a deployment detail, and pinning it here would mean
/// changing the daemon to change the UI's port). A missing `Origin` is not a
/// browser and is left to the token.
fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = origin
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

#[derive(serde::Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        warn!("refused a WebSocket upgrade from a non-loopback Origin");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    if query.token.as_deref() != Some(state.token.as_str()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let hub = state.hub.clone();
    upgrade.on_upgrade(move |socket| browser_session(socket, hub))
}

/// One browser connection: read frames, answer them, push hub frames out.
async fn browser_session(socket: WebSocket, hub: Arc<Hub>) {
    let (browser, mut outbound) = hub.add_browser().await;
    let (mut sink, mut stream) = socket.split();

    let pump = tokio::spawn(async move {
        while let Some(frame) = outbound.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // A request is served on its own task so a long one cannot hold up the
    // read loop, bounded so a tab cannot open unlimited work.
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT_PER_BROWSER));
    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            warn!("browser exceeded its in-flight budget; frame dropped");
            continue;
        };
        let hub = hub.clone();
        tokio::spawn(async move {
            let reply = hub.handle(browser, &text).await;
            if let Some(reply) = reply {
                hub.send_to(browser, reply).await;
            }
            drop(permit);
        });
    }

    hub.remove_browser(browser).await;
    pump.abort();
}

async fn upload(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    body: Bytes,
) -> Response {
    let Some(token) = query.token else {
        return (StatusCode::BAD_REQUEST, "missing token").into_response();
    };
    let Some(path) = state.hub.claim_upload(&token).await else {
        return (StatusCode::FORBIDDEN, "unknown or spent upload token").into_response();
    };
    if body.len() > state.hub.max_upload_bytes() {
        return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response();
    }
    match tokio::fs::write(&path, &body).await {
        Ok(()) => axum::Json(serde_json::json!({"path": path.display().to_string()})).into_response(),
        Err(e) => {
            warn!(error = %e, "upload write failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "write failed").into_response()
        }
    }
}
