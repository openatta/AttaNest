//! Bulk: attachments in, exports out, never on an event channel.
//!
//! A one-shot grant is exchanged for a URL, the payload lands on disk, and
//! what travels afterwards is a path. This holds in every topology, because
//! what it prevents — one image filling the frame ceiling — is not a property
//! of any of them (§3.3.3, fourth invariant).

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tracing::warn;

use crate::AppState;

/// Who issued the grant and where it lands.
///
/// A trait so transport does not have to know that uploads belong to a
/// contribution rather than to the kernel.
#[async_trait::async_trait]
pub trait BulkStore: Send + Sync {
    /// Claim a grant: where the bytes go, and the ceiling that grant was
    /// issued under. `None` means never issued, or already spent.
    ///
    /// The ceiling travels with the grant rather than being one number for
    /// the route, because the two things that use this channel do not have
    /// the same limit — a file attachment and an extension package are
    /// different sizes of thing, and each is advertised at its own number by
    /// the method that issues it.
    async fn claim(&self, token: &str) -> Option<(std::path::PathBuf, usize)>;
}

/// What the route will buffer. Above every ceiling any grant is issued
/// under, so the refusal comes from the check that knows which grant this is
/// and what it was promised — not from the framework, which knows neither.
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Deserialize)]
pub struct Grant {
    token: Option<String>,
}

pub async fn upload(State(state): State<AppState>, Query(grant): Query<Grant>, body: Bytes) -> Response {
    let Some(token) = grant.token else {
        return (StatusCode::BAD_REQUEST, "missing token").into_response();
    };
    let Some((path, ceiling)) = state.bulk.claim(&token).await else {
        return (StatusCode::FORBIDDEN, "unknown or spent upload token").into_response();
    };
    // Said in Nest's own words, with the number the grant was issued under.
    // Without the route limit raised above this, the body never arrives and
    // the caller gets the framework's "failed to buffer the request body"
    // instead — which names neither the ceiling nor the channel.
    if body.len() > ceiling {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("{} bytes; this grant was issued for at most {ceiling}", body.len()),
        )
            .into_response();
    }
    match tokio::fs::write(&path, &body).await {
        Ok(()) => axum::Json(serde_json::json!({"path": path.display().to_string()})).into_response(),
        Err(e) => {
            warn!(error = %e, "upload write failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "write failed").into_response()
        }
    }
}
