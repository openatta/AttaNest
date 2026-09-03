//! Who is allowed to open a channel at all.
//!
//! Two shapes, and which one applies is decided by where the listener is
//! bound rather than by a setting (§6.3):
//!
//! - **Loopback** — the per-process token. Binding to loopback keeps the
//!   network out; the token keeps another page on this machine out, because a
//!   page cannot read a cross-origin response but *can* open a socket to
//!   `127.0.0.1`.
//! - **Reachable** — the token *and* a paired device signing a challenge this
//!   server chose. The token alone cannot carry a reachable listener: it is
//!   one secret shared by every device, so revoking one device would mean
//!   rotating it for all of them, which nobody does.
//!
//! The challenge is single-use and short-lived, so a signature captured off
//! the wire is worth nothing the second time.

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use nest_authz::{devices_challenge as challenge, Devices};
use tokio::sync::Mutex;

/// How long an unanswered challenge is worth keeping. A round trip, not a
/// session.
const CHALLENGE_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Challenges {
    open: Mutex<HashMap<String, (Vec<u8>, SystemTime)>>,
}

impl Challenges {
    /// Mint one. Returned base64, to travel in JSON.
    pub async fn issue(&self, now: SystemTime) -> (String, String) {
        let bytes: Vec<u8> = (0..challenge::LEN)
            .map(|i| uuid::Uuid::new_v4().as_bytes()[i % 16])
            .collect();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut open = self.open.lock().await;
        open.retain(|_, (_, expires)| now <= *expires);
        open.insert(id.clone(), (bytes.clone(), now + CHALLENGE_TTL));
        (id, base64::engine::general_purpose::STANDARD.encode(&bytes))
    }

    /// Spend one. `None` means unknown, expired, or already used — one answer
    /// for all three, because telling them apart tells a prober which of its
    /// guesses were closer.
    pub async fn redeem(&self, id: &str, now: SystemTime) -> Option<Vec<u8>> {
        let mut open = self.open.lock().await;
        let (bytes, expires) = open.remove(id)?;
        (now <= expires).then_some(bytes)
    }
}

/// Hand out something to sign.
///
/// The only endpoint reachable before admission, and it gives away nothing: a
/// challenge is random bytes with a minute to live, useless without the
/// private key of a device that was paired.
pub async fn mint(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    let (id, bytes) = state.challenges.issue(SystemTime::now()).await;
    axum::Json(serde_json::json!({"challenge_id": id, "challenge": bytes})).into_response()
}

/// Redeem a pairing code for a device record.
///
/// The one call a reachable listener takes before any device exists, and the
/// only thing that breaks the circle — pairing is a method, methods need
/// admission, and admission needs a paired device. What stands in for
/// admission here is the code itself: short-lived, single-use, burned after a
/// few wrong guesses, and it reached the person through a channel this
/// process does not control (the console it printed on).
///
/// The per-process token is still required, so this is not a door onto the
/// network — it is the second half of one the operator opened deliberately.
pub async fn pair(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    let get = |key: &str| body.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if get("token") != state.config.token {
        return (axum::http::StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let now = SystemTime::now();
    state.devices.sweep(now);
    let stamp = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into());
    match state
        .devices
        .complete_pairing(&get("code"), &get("public_key"), now, &stamp)
    {
        Ok(device) => axum::Json(serde_json::json!({"device": device})).into_response(),
        Err(e) => (axum::http::StatusCode::UNAUTHORIZED, e.to_string()).into_response(),
    }
}

/// Answer to "may this connection exist".
pub enum Verdict {
    Admit { device: Option<String> },
    Refuse(&'static str),
}

/// Check a handshake body against what this listener requires.
pub async fn admit(
    admission: crate::Admission,
    expected_token: &str,
    devices: &Devices,
    challenges: &Challenges,
    body: &serde_json::Value,
) -> Verdict {
    if body.get("token").and_then(|v| v.as_str()) != Some(expected_token) {
        return Verdict::Refuse("bad token");
    }
    if admission == crate::Admission::Token {
        return Verdict::Admit { device: None };
    }

    let get = |key: &str| body.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let (Some(device_id), Some(challenge_id), Some(signature)) =
        (get("device_id"), get("challenge_id"), get("signature"))
    else {
        return Verdict::Refuse(
            "this listener is reachable from the network, so a paired device must sign a challenge",
        );
    };
    let Some(device) = devices.get(&device_id) else {
        return Verdict::Refuse("unknown or revoked device");
    };
    let Some(bytes) = challenges.redeem(&challenge_id, SystemTime::now()).await else {
        return Verdict::Refuse("challenge is unknown, expired, or already used");
    };
    if !challenge::verify(&device.public_key, &bytes, &signature) {
        return Verdict::Refuse("signature does not match the paired key");
    }
    Verdict::Admit { device: Some(device_id) }
}
