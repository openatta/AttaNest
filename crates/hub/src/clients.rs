//! Who is watching, and how a frame reaches them.
//!
//! A client here is a `dyn FrameSink` and nothing more. Whether that is one
//! bidirectional connection, two download-only streams or a poll queue is the
//! transport's business — and the fact that this file cannot tell is what
//! makes §3.3.3's fifth invariant ("adding a topology does not touch the hub")
//! checkable rather than aspirational.

use std::collections::HashMap;
use std::sync::Arc;

use nest_contract::{Channel, Frame, FrameSink};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ClientId(pub u64);

#[derive(Default)]
pub struct Clients {
    sinks: HashMap<ClientId, Arc<dyn FrameSink>>,
}

impl Clients {
    pub fn insert(&mut self, id: ClientId, sink: Arc<dyn FrameSink>) {
        self.sinks.insert(id, sink);
    }

    pub fn remove(&mut self, id: ClientId) {
        self.sinks.remove(&id);
    }

    /// Send to one client, if it still wants this channel.
    pub async fn send(&self, id: ClientId, frame: &Frame) {
        if let Some(sink) = self.sinks.get(&id) {
            if sink.wants(frame.channel) {
                sink.deliver(frame.clone()).await;
            }
        }
    }

    /// Send to a named set — a session's watchers.
    pub async fn send_many(&self, ids: &[ClientId], frame: &Frame) {
        for id in ids {
            self.send(*id, frame).await;
        }
    }

    /// Send to everyone. Only for host events: a client watching the sidebar
    /// must not receive every session's body just to learn which one is
    /// running (§3.3.1).
    pub async fn broadcast(&self, frame: &Frame) {
        debug_assert_eq!(frame.channel, Channel::HostEvents);
        for sink in self.sinks.values() {
            if sink.wants(frame.channel) {
                sink.deliver(frame.clone()).await;
            }
        }
    }
}
