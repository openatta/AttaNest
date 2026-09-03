//! What a handshake establishes, and what every channel of it shares.
//!
//! **A credential belongs to the subject, not to a connection** (§3.3.3, item
//! 2). One handshake produces one credential and one client identity; every
//! channel opened afterwards carries that credential rather than negotiating
//! again. In the single-duplex topology that is one connection holding all
//! five semantics; in split streams it is three connections holding one
//! identity between them.
//!
//! This is the piece the second topology forced into the open. Client
//! identity used to be "which connection is this", which works exactly as
//! long as there is one — and then `nest.attach` arrives on a POST while the
//! frames have to reach an event stream that is a different socket entirely.
//! Tying identity to the credential fixes that, and it is also what makes
//! revoking a device able to cut all of its channels at once.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use nest_contract::{Channel, Frame, FrameSink, Subject, Topology};
use tokio::sync::{mpsc, Mutex};

/// One established handshake.
pub struct Established {
    pub subject: Subject,
    /// What was negotiated. Held so a second handshake on the same subject
    /// can be refused rather than quietly renegotiating into a different
    /// answer (§3.3.3, item 2).
    #[allow(dead_code)]
    pub topology: Topology,
    /// The hub's handle for this client. Frames addressed to it arrive on the
    /// queues below whichever connection is currently draining them.
    pub client: nest_hub::ClientId,
    /// Server-initiated frames, split by subscription face.
    ///
    /// Two queues, because they are two subscription faces: a client watching
    /// only the sidebar must not receive every session's body just to learn
    /// which one is running.
    ///
    /// **Only where the topology actually splits them.** One bidirectional
    /// connection carries both, so it hands its own sender in and gets no
    /// queues at all — the alternative was two channels and two tasks per
    /// connection whose entire job was to copy one queue into another. That
    /// showed up as about 110 KB per idle connection against a 64 KB budget,
    /// which is how it was found.
    pub session_events: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    pub host_events: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
}

/// The downstream the hub sees. It knows nothing about connections.
pub struct Downstream {
    /// Where each face's frames go. The same sender twice when one connection
    /// carries both.
    session_tx: mpsc::UnboundedSender<String>,
    host_tx: mpsc::UnboundedSender<String>,
    /// Which faces this client actually subscribed to. In split streams a
    /// read-only client may open only the host stream, and then session
    /// bodies are not merely ignored — they are never queued.
    faces: parking_faces::Faces,
}

/// A tiny bitset, spelled out rather than pulled in.
mod parking_faces {
    use std::sync::atomic::{AtomicU8, Ordering};

    #[derive(Default)]
    pub struct Faces(AtomicU8);

    const SESSION: u8 = 1;
    const HOST: u8 = 2;

    impl Faces {
        pub fn all() -> Self {
            Self(AtomicU8::new(SESSION | HOST))
        }

        pub fn none() -> Self {
            Self(AtomicU8::new(0))
        }

        pub fn add_session(&self) {
            self.0.fetch_or(SESSION, Ordering::Relaxed);
        }

        pub fn add_host(&self) {
            self.0.fetch_or(HOST, Ordering::Relaxed);
        }

        pub fn wants_session(&self) -> bool {
            self.0.load(Ordering::Relaxed) & SESSION != 0
        }

        pub fn wants_host(&self) -> bool {
            self.0.load(Ordering::Relaxed) & HOST != 0
        }
    }
}

impl Downstream {
    pub fn subscribe_session(&self) {
        self.faces.add_session();
    }

    pub fn subscribe_host(&self) {
        self.faces.add_host();
    }
}

#[async_trait::async_trait]
impl FrameSink for Downstream {
    async fn deliver(&self, frame: Frame) -> bool {
        match frame.channel {
            Channel::SessionEvents => self.session_tx.send(frame.payload).is_ok(),
            Channel::HostEvents => self.host_tx.send(frame.payload).is_ok(),
            // Unary replies travel back on the request that asked; bulk goes
            // around every channel. Neither reaches a sink.
            _ => true,
        }
    }

    fn wants(&self, channel: Channel) -> bool {
        match channel {
            Channel::SessionEvents => self.faces.wants_session(),
            Channel::HostEvents => self.faces.wants_host(),
            _ => false,
        }
    }
}

/// Every established handshake, by credential.
#[derive(Default)]
pub struct Sessions {
    by_credential: Mutex<HashMap<String, Arc<Established>>>,
    sinks: Mutex<HashMap<String, Arc<Downstream>>>,
    next: AtomicU64,
}

impl Sessions {
    /// Establish one.
    ///
    /// `single_wire` is the connection's own sender, for a topology that
    /// carries both faces on one connection: frames go straight to it, and no
    /// queue or task is created to move them. `None` splits the faces into
    /// their own queues for the streams that will drain them.
    pub async fn establish(
        &self,
        hub: &nest_hub::Hub,
        subject: Subject,
        topology: Topology,
        single_wire: Option<mpsc::UnboundedSender<String>>,
    ) -> (String, Arc<Established>, Arc<Downstream>) {
        let (session_tx, host_tx, session_rx, host_rx, faces) = match single_wire {
            Some(wire) => (
                wire.clone(),
                wire,
                None,
                None,
                // Both faces, from the start: there is one wire and it carries
                // everything.
                parking_faces::Faces::all(),
            ),
            None => {
                let (session_tx, session_rx) = mpsc::unbounded_channel();
                let (host_tx, host_rx) = mpsc::unbounded_channel();
                (
                    session_tx,
                    host_tx,
                    Some(session_rx),
                    Some(host_rx),
                    // Neither: opening a stream is how a client says which
                    // face it wants.
                    parking_faces::Faces::none(),
                )
            }
        };
        let sink = Arc::new(Downstream { session_tx, host_tx, faces });
        let client = hub.add_client(sink.clone()).await;
        let established = Arc::new(Established {
            subject,
            topology,
            client,
            session_events: Mutex::new(session_rx),
            host_events: Mutex::new(host_rx),
        });
        // Opaque and unguessable; it is the only thing a later channel shows.
        let credential = format!(
            "{}-{}",
            uuid::Uuid::new_v4().simple(),
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        self.by_credential
            .lock()
            .await
            .insert(credential.clone(), established.clone());
        self.sinks.lock().await.insert(credential.clone(), sink.clone());
        (credential, established, sink)
    }

    pub async fn get(&self, credential: &str) -> Option<Arc<Established>> {
        self.by_credential.lock().await.get(credential).cloned()
    }

    /// Opening a stream is how a client subscribes to that face.
    ///
    /// It is not a formality: a client that opens only the host stream never
    /// has session bodies queued for it at all, which is the read-only case
    /// the two faces exist for.
    pub async fn subscribe(&self, credential: &str, session_face: bool) {
        if let Some(sink) = self.sinks.lock().await.get(credential) {
            if session_face {
                sink.subscribe_session();
            } else {
                sink.subscribe_host();
            }
        }
    }

    /// Drop one, and everything it was watching with it. Revoking a device is
    /// this, for each credential it holds.
    pub async fn end(&self, hub: &nest_hub::Hub, credential: &str) {
        self.sinks.lock().await.remove(credential);
        if let Some(established) = self.by_credential.lock().await.remove(credential) {
            hub.remove_client(established.client).await;
        }
    }
}
