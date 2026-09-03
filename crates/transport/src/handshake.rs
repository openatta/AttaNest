//! One handshake, before anything else on a connection.
//!
//! Protocol version, contribution API version and topology are settled once.
//! A mismatch is refused with a sentence saying which side is out of date —
//! never downgraded, because a half-compatible client produces bug reports
//! nobody can act on (§5.1).
//!
//! In a multi-channel topology the later channels carry the credential this
//! produced rather than negotiating again. A negotiation held twice is one
//! that will eventually produce two answers.

use nest_contract::{codes, Handshake, RpcError, Subject, Topology};
use serde_json::{json, Value};

/// What a connection is after a successful handshake.
pub struct Session {
    pub subject: Subject,
    pub topology: Topology,
}

/// Read a client's `nest.handshake` and decide.
pub fn negotiate(params: &Value, supported: &[Topology], subject: Subject) -> Result<Session, RpcError> {
    let client: Handshake = serde_json::from_value(params.clone())
        .map_err(|e| RpcError::invalid_params(format!("handshake: {e}")))?;
    if let Some(reason) = nest_contract::handshake::refuse(&client, supported) {
        return Err(RpcError::new(codes::HANDSHAKE_REFUSED, reason));
    }
    Ok(Session { subject, topology: client.topology })
}

/// The server's half of the handshake.
pub fn accepted(session: &Session, supported: &[Topology]) -> Value {
    json!({
        "protocol_version": nest_contract::PROTOCOL_VERSION,
        "contrib_api_version": nest_contract::CONTRIB_API_VERSION,
        "topology": session.topology,
        "topologies": supported,
        "subject": session.subject,
        "channels": ["unary", "session_events", "host_events", "out_of_band", "bulk"],
    })
}
