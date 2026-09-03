//! The one place a call is admitted.
//!
//! Adding a method defaults to refusing it: [`MethodTable`] is an allow-list,
//! and a name that is not in it is refused by falling off the end rather than
//! by anyone remembering to write a rule.
//!
//! Two kinds of subject, judged differently (concept_and_architecture.md
//! §3.4). A device is a person, and in a single-user process the answer to
//! "may this person do it" is nearly always yes. A plugin is code acting on
//! that person's behalf, and that is the question this layer is really for.
//!
//! Authorization happens at the method, not at the connection. A multi-channel
//! topology gives one subject several connections; hanging the decision on a
//! connection would give several answers to one question.
//!
//! This layer does not know what a frame looks like or which channel carried
//! it — it depends on `nest-contract` and nothing else.

mod audit;
mod devices;
mod table;

pub use audit::{Audit, AuditEntry, AuditSink, Decision};
pub use devices::challenge as devices_challenge;
pub use devices::{Device, Devices, PairError, PAIRING_TTL};
pub use table::{MethodTable, Reach, ENGINE_REFUSALS};

use std::sync::Arc;

use nest_contract::{Gate, RpcError, Subject};
use serde_json::Value;

/// Wraps the thing that actually answers, and lets nothing past that the
/// table did not name.
pub struct Authorizer {
    table: MethodTable,
    inner: Arc<dyn Gate>,
    audit: Arc<Audit>,
}

impl Authorizer {
    pub fn new(table: MethodTable, inner: Arc<dyn Gate>, audit: Arc<Audit>) -> Self {
        Self { table, inner, audit }
    }

    pub fn audit(&self) -> &Arc<Audit> {
        &self.audit
    }

    pub fn table(&self) -> &MethodTable {
        &self.table
    }

    /// Methods this subject may call, for a client that wants to grey out
    /// what it cannot use rather than discover it by being refused.
    pub fn reachable(&self, subject: &Subject) -> Vec<&'static str> {
        self.table.reachable(subject)
    }
}

/// The method this layer answers itself.
///
/// "What may I call" is an authorization question, so it is answered where
/// the answer lives rather than by handing the table to something else. A
/// client uses it to grey out what it cannot reach instead of discovering it
/// by being refused, and a contribution's filtered RPC client is built from
/// it — so the message is the same whichever side catches the call.
pub const REACHABLE: &str = "nest.reachable";

#[async_trait::async_trait]
impl Gate for Authorizer {
    async fn call(&self, subject: &Subject, method: &str, params: Value) -> Result<Value, RpcError> {
        // Read out of the call, not known by this layer. A durable sink needs
        // somewhere to file an entry; deciding whether to allow the call does
        // not.
        let session = params
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if method == REACHABLE {
            self.audit.record(subject, method, Decision::Allow, None, session);
            return Ok(serde_json::json!({
                "subject": subject,
                "methods": self.reachable(subject),
            }));
        }
        match self.table.decide(subject, method) {
            Decision::Allow => {
                self.audit.record(subject, method, Decision::Allow, None, session);
                self.inner.call(subject, method, params).await
            }
            // Refused on purpose, with the reason in the error. Silence here
            // would read as a Nest bug to whoever hit it.
            Decision::Refuse(reason) => {
                self.audit.record(subject, method, Decision::Refuse(reason), Some(reason), session);
                Err(RpcError::refused(reason))
            }
            Decision::Unknown => {
                self.audit.record(subject, method, Decision::Unknown, None, session);
                Err(RpcError::not_found(format!(
                    "method `{method}` is not reachable by {}",
                    subject.label()
                )))
            }
        }
    }
}
