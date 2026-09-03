//! Channel semantics, and the downstream a frame goes to.
//!
//! Five semantics, three reference topologies, one set of guarantees
//! (concept_and_architecture.md §3.3). What a channel carries is fixed; how
//! many connections carry it is not. Everything below this line is stated in
//! terms of the semantics, so adding a topology touches transport and nothing
//! else.

use serde::{Deserialize, Serialize};

/// What a frame is for. A topology maps these onto connections; the hub and
/// the authorizer only ever name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    /// One request, one reply. Client-initiated.
    Unary,
    /// One session's events: streamed body, tool rows, permission asks.
    /// Server-initiated.
    SessionEvents,
    /// Everything not tied to a session: the session list, the queue, engine
    /// health, plugin state. Server-initiated.
    HostEvents,
    /// The answer to a question the server asked. Client-initiated, and
    /// separate because a download-only event stream has no return path.
    OutOfBand,
    /// Attachments in, exports out. Never on an event channel: one image must
    /// not fill the frame ceiling.
    Bulk,
}

impl Channel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Channel::Unary => "unary",
            Channel::SessionEvents => "session_events",
            Channel::HostEvents => "host_events",
            Channel::OutOfBand => "out_of_band",
            Channel::Bulk => "bulk",
        }
    }
}

/// One server-initiated frame, tagged with the semantics it belongs to.
///
/// `seq` is assigned by the hub, never by a connection: an event's place in a
/// session's stream does not depend on which channel carried it or how many
/// times that channel dropped.
#[derive(Debug, Clone)]
pub struct Frame {
    pub channel: Channel,
    /// The session this belongs to, for [`Channel::SessionEvents`].
    pub session_id: Option<String>,
    /// JSON-RPC notification, already serialized.
    pub payload: String,
}

impl Frame {
    pub fn host(payload: String) -> Self {
        Self { channel: Channel::HostEvents, session_id: None, payload }
    }

    pub fn session(session_id: impl Into<String>, payload: String) -> Self {
        Self {
            channel: Channel::SessionEvents,
            session_id: Some(session_id.into()),
            payload,
        }
    }
}

/// A downstream that can take frames.
///
/// The hub holds these and knows nothing else about them — not the topology,
/// not the connection, not whether there is one connection or three.
/// `false` means the downstream is gone and may be dropped.
#[async_trait::async_trait]
pub trait FrameSink: Send + Sync {
    async fn deliver(&self, frame: Frame) -> bool;

    /// Whether this downstream subscribes to a channel at all. A client
    /// watching only the sidebar should not receive every session's body.
    fn wants(&self, _channel: Channel) -> bool {
        true
    }
}
