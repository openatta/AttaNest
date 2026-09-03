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
    /// Claim a grant. `None` means never issued, or already spent.
    async fn claim(&self, token: &str) -> Option<std::path::PathBuf>;
}

#[derive(serde::Deserialize)]
pub struct Grant {
    token: Option<String>,
}

pub async fn upload(State(state): State<AppState>, Query(grant): Query<Grant>, body: Bytes) -> Response {
    let Some(token) = grant.token else {
        return (StatusCode::BAD_REQUEST, "missing token").into_response();
    };
    let Some(path) = state.bulk.claim(&token).await else {
        return (StatusCode::FORBIDDEN, "unknown or spent upload token").into_response();
    };
    if body.len() > state.config.max_upload_bytes {
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
