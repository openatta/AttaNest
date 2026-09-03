//! What was decided, and what came of it.
//!
//! An authorization decision, a plugin call and its outcome, a permission
//! answer, a device paired or revoked: all of it is recorded and can be
//! asked about. "My plugin does nothing" is otherwise a guess
//! (concept_and_architecture.md §2.4, §6.5).
//!
//! The ring is in memory and bounded. The durable home for these is the
//! session timeline as engine extension entries, where an unknown namespace
//! is skippable — so uninstalling a plugin does not make its history
//! unreadable. `AuditSink` is where that lands; this crate keeps no files.

use std::sync::Mutex;

use nest_contract::Subject;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    #[serde(rename = "refuse")]
    Refuse(&'static str),
    /// Not in the table at all.
    Unknown,
}

impl Decision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Refuse(_) => "refuse",
            Decision::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub subject: String,
    pub method: String,
    pub decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// The session this call named, if it named one.
    ///
    /// Read out of the call's own parameters rather than known by this layer:
    /// authorization decides about a subject and a method and must not learn
    /// what a session is. It is here because a durable sink needs somewhere
    /// to file the entry, and `None` simply means there is nowhere — a device
    /// being paired belongs to no conversation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// Somewhere entries outlive the process. Wired by the app to the engine's
/// extension-entry log; absent, the ring is all there is.
pub trait AuditSink: Send + Sync {
    fn append(&self, entry: &AuditEntry);
}

pub struct Audit {
    ring: Mutex<std::collections::VecDeque<AuditEntry>>,
    capacity: usize,
    sink: Mutex<Option<Box<dyn AuditSink>>>,
}

impl Default for Audit {
    fn default() -> Self {
        Self::with_capacity(2048)
    }
}

impl Audit {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            ring: Mutex::new(std::collections::VecDeque::with_capacity(capacity.min(256))),
            capacity,
            sink: Mutex::new(None),
        }
    }

    pub fn set_sink(&self, sink: Box<dyn AuditSink>) {
        *self.sink.lock().unwrap() = Some(sink);
    }

    pub fn record(
        &self,
        subject: &Subject,
        method: &str,
        decision: Decision,
        reason: Option<&'static str>,
        session: Option<String>,
    ) {
        let entry = AuditEntry {
            subject: subject.label(),
            method: method.to_string(),
            decision: decision.as_str(),
            reason,
            session,
        };
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.append(&entry);
        }
        let mut ring = self.ring.lock().unwrap();
        if ring.len() == self.capacity {
            ring.pop_front();
        }
        ring.push_back(entry);
    }

    pub fn recent(&self, limit: usize) -> Vec<AuditEntry> {
        let ring = self.ring.lock().unwrap();
        ring.iter().rev().take(limit).cloned().collect()
    }
}
