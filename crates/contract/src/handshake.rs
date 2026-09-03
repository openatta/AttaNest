//! One handshake, one negotiation.
//!
//! Protocol version, contribution API version, topology and capability bits
//! are agreed once. In a multi-channel topology the later channels carry the
//! credential the handshake produced rather than negotiating again — a
//! negotiation held twice is a negotiation that one day produces two answers
//! (concept_and_architecture.md §3.3.3).
//!
//! A mismatch is refused with a reason. There is no silent downgrade: a
//! half-compatible client produces bug reports nobody can act on.

use serde::{Deserialize, Serialize};

/// The client-facing protocol. Bumped when a method, an event shape or an
/// error code changes in a way a client can observe.
pub const PROTOCOL_VERSION: u32 = 3;

/// The contribution point API. Bumped when a contribution point's contract
/// changes — separately from the protocol, because a UI bundle can be current
/// on one and stale on the other.
pub const CONTRIB_API_VERSION: u32 = 1;

/// How the five channel semantics are carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Topology {
    /// One bidirectional connection carries all five (bulk still goes around
    /// it). Fewest connections, simplest ordering, a return path for free.
    /// The default at the edge, where a connection costs more than middleware.
    SingleDuplex,
    /// Unary and out-of-band over plain HTTP; session events and host events
    /// each on their own download-only stream. Behind a reverse proxy, where
    /// ordinary HTTP buys ordinary middleware.
    SplitStreams,
    /// Unary and bulk only; events by polling. Script clients, constrained
    /// networks, automation that does not need to be live.
    RequestOnly,
}

impl Topology {
    pub fn as_str(&self) -> &'static str {
        match self {
            Topology::SingleDuplex => "single_duplex",
            Topology::SplitStreams => "split_streams",
            Topology::RequestOnly => "request_only",
        }
    }
}

/// What the client asks for, and what the server answers with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handshake {
    pub protocol_version: u32,
    pub contrib_api_version: u32,
    pub topology: Topology,
}

/// Ceilings a client has to respect, told to it once rather than discovered
/// by hitting them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub max_upload_bytes: usize,
    pub replay_max_frames: usize,
}

/// Why a handshake was refused, in words the client can show.
pub fn refuse(client: &Handshake, supported: &[Topology]) -> Option<String> {
    if client.protocol_version != PROTOCOL_VERSION {
        return Some(format!(
            "protocol version {} is not {}; the {} is out of date",
            client.protocol_version,
            PROTOCOL_VERSION,
            if client.protocol_version < PROTOCOL_VERSION { "client" } else { "server" }
        ));
    }
    if client.contrib_api_version != CONTRIB_API_VERSION {
        return Some(format!(
            "contribution API version {} is not {}; the {} is out of date",
            client.contrib_api_version,
            CONTRIB_API_VERSION,
            if client.contrib_api_version < CONTRIB_API_VERSION { "client" } else { "server" }
        ));
    }
    if !supported.contains(&client.topology) {
        return Some(format!(
            "topology `{}` is not served here; this build offers {}",
            client.topology.as_str(),
            supported.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    None
}
