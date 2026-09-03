//! Where an audit entry ends up.
//!
//! `nest_authz::Audit` keeps a bounded ring so the diagnostics page can show
//! recent decisions, and a ring dies with the process. §6.5 asks for
//! something else: decisions written into the **session timeline**, in order
//! with every other entry, surviving load, fork and resume.
//!
//! AttaCore already has exactly that seam, and reusing it rather than
//! building a second log buys one specific thing: **an unknown namespace is
//! inert, never an error.** The kernel never parses an extension entry's
//! payload, so a session whose log contains entries from something that is no
//! longer installed still loads, forks and resumes unchanged. A separate
//! audit file would have had to re-earn that, and would have been a second
//! place where "what happened in this session" is written down.
//!
//! # Not every decision
//!
//! An allow on a read-only method, several times a second, would bury the
//! entries that matter under entries nobody will ever read — and a log nobody
//! reads is the same as no log. What lands here is what someone would go
//! looking for afterwards: a refusal, a device paired or revoked, an
//! extension installed. Routine allows stay in the ring.

use std::sync::Arc;

use history::entry::LogEntry;
use history::store::HistoryStore;
use nest_authz::{AuditEntry, AuditSink};

/// The namespace these entries are filed under. One key, opaque to the
/// engine, and the thing that makes them skippable by anything that does not
/// know what they are.
const NS: &str = "nest.audit";

pub struct TimelineAudit {
    store: Arc<dyn HistoryStore>,
    /// Which session an entry belongs to.
    ///
    /// Authorization decides about a *subject and a method*; it has no idea
    /// which conversation was open, and giving it one would be exactly the
    /// leak the layering test forbids. So entries are filed under the session
    /// named in the call's own parameters when there is one, and dropped into
    /// the ring alone when there is not — a device being paired belongs to no
    /// conversation, and inventing one for it would be worse than not having
    /// it in a transcript.
    handle: tokio::runtime::Handle,
}

impl TimelineAudit {
    pub fn new(store: Arc<dyn HistoryStore>) -> Self {
        Self { store, handle: tokio::runtime::Handle::current() }
    }
}

impl AuditSink for TimelineAudit {
    fn append(&self, entry: &AuditEntry) {
        // Only what someone would come looking for.
        if entry.decision == "allow" && !is_consequential(&entry.method) {
            return;
        }
        // A session id that does not parse is one that was never real — a
        // typo in a call that was refused, most likely. There is nowhere to
        // file that, and inventing somewhere would be worse than the ring.
        let Some(session) = entry.session.as_deref().and_then(|s| base::session::SessionId::parse(s).ok())
        else {
            return;
        };
        let record = LogEntry::Extension {
            ns: NS.to_string(),
            event: entry.decision.to_string(),
            payload: serde_json::json!({
                "subject": entry.subject,
                "method": entry.method,
                "reason": entry.reason,
            }),
        };
        let store = self.store.clone();
        // Fire and forget: an audit write must never be able to fail a call,
        // and it must never be able to slow one down either.
        self.handle.spawn(async move {
            if let Err(e) = store.append(session, record).await {
                tracing::warn!(error = %e, "audit entry not written to the timeline");
            }
        });
    }
}

/// Allows worth a timeline entry: the ones that change what this process is
/// or what it may reach.
fn is_consequential(method: &str) -> bool {
    matches!(
        method,
        "plugin.install"
            | "plugin.uninstall"
            | "plugin.enable"
            | "plugin.disable"
            | "nest.plugins.install"
            | "nest.devices.pair.complete"
            | "nest.devices.revoke"
            | "nest.settings.set"
            | "nest.settings.setProvider"
            | "session.delete"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule that keeps the timeline readable: a refusal is always worth a
    /// line, a routine allow never is.
    #[test]
    fn only_consequential_allows_are_written() {
        assert!(is_consequential("nest.devices.revoke"));
        assert!(is_consequential("plugin.install"));
        assert!(!is_consequential("nest.sessions"));
        assert!(!is_consequential("session.history"));
    }
}
