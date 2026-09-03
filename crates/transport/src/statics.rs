//! The static face, when this node serves one.
//!
//! The interface is a **separate artifact** — ES modules, CSS and an asset
//! manifest — and the backend is one binary that does not contain it (§5.1).
//! Three deployments share one transport contract: served from here, served
//! by any static server or CDN, or not served at all (`--headless`).
//!
//! The cost of that separation is two release artifacts and one explicit
//! version negotiation; the reason is customization, which is the first goal.
//! A whole different interface makes a different product without recompiling
//! the backend.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::AppState;

/// No external sources and no inline anything.
///
/// There is no inline script or style anywhere in the page, so neither
/// `'unsafe-inline'` nor a list of hashes is needed; the token travels in a
/// `<meta>` tag. Nothing is fetched from the network at run time, which is
/// what lets the interface open with no network at all.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
     connect-src 'self'; img-src 'self' data:; font-src 'self' data:; \
     base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub struct StaticFace {
    root: Option<PathBuf>,
    /// Each installed package's directory, by name.
    ///
    /// Served from a **same-origin** path, which is the whole reason the
    /// browser can `import()` one at run time: the CSP is `script-src 'self'`
    /// and is not loosened for a package. A bundle has to be self-contained —
    /// no CDN, nothing fetched from the network — and that is also what lets
    /// the interface open with no network at all.
    ///
    /// Resolved through this map rather than by joining a path, so a request
    /// can only reach a directory the engine actually installed.
    packages: RwLock<BTreeMap<String, PathBuf>>,
}

impl StaticFace {
    pub fn new(root: Option<PathBuf>) -> Self {
        Self { root, packages: RwLock::new(BTreeMap::new()) }
    }

    /// Replace what is being served. Called once at assembly and again after
    /// an install, because a package that needs a restart to appear is a
    /// package nobody will believe installed.
    pub fn set_packages(&self, packages: BTreeMap<String, PathBuf>) {
        *self.packages.write().unwrap() = packages;
    }

    pub fn serves_anything(&self) -> bool {
        self.root.is_some()
    }

    /// Resolve a request path under the interface directory.
    ///
    /// Anything containing `..` falls back to the index rather than being
    /// resolved: a deep link that reloads must not land on an error page, and
    /// a traversal must not land anywhere at all.
    fn read(&self, path: &str) -> Option<(Vec<u8>, &'static str)> {
        let root = self.root.as_ref()?;
        let clean = path.trim_start_matches('/');
        if clean.is_empty() || clean.contains("..") {
            return read_file(&root.join("index.html")).map(|b| (b, "text/html; charset=utf-8"));
        }
        // `/plugins/<name>/ui/<file>`.
        if let Some(rest) = clean.strip_prefix("plugins/") {
            let (name, file) = rest.split_once("/ui/")?;
            if file.contains("..") || name.contains('/') {
                return None;
            }
            let dir = self.packages.read().unwrap().get(name).cloned()?;
            return read_file(&dir.join("ui").join(file)).map(|b| (b, content_type(file)));
        }
        match read_file(&root.join(clean)) {
            Some(bytes) => Some((bytes, content_type(clean))),
            // Client-side routing: an unknown path is a route, not a 404.
            None => read_file(&root.join("index.html")).map(|b| (b, "text/html; charset=utf-8")),
        }
    }
}

fn read_file(path: &Path) -> Option<Vec<u8>> {
    path.is_file().then(|| std::fs::read(path).ok()).flatten()
}

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

pub async fn serve(State(state): State<AppState>, uri: Uri) -> Response {
    let Some((bytes, mime)) = state.statics.read(uri.path()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    // The index is the only response the connection token is injected into.
    // The page itself does not need one — a cross-origin page cannot read the
    // body — and the token governs connecting, not reading.
    if mime.starts_with("text/html") {
        let page = String::from_utf8_lossy(&bytes).replace("__NEST_TOKEN__", &state.config.token);
        return (
            [
                (header::CONTENT_TYPE, mime),
                (header::CONTENT_SECURITY_POLICY, CSP),
                (header::CACHE_CONTROL, "no-store"),
            ],
            page,
        )
            .into_response();
    }
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_SECURITY_POLICY, CSP),
        ],
        bytes,
    )
        .into_response()
}
