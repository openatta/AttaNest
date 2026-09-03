//! What the product registered, and under what name.
//!
//! Registration happens once, at assembly, before anything is served. This is
//! how the interface's parts are named and found, not a door for third-party
//! code: extending the agent is AttaCore's, and nothing here loads anything
//! from outside the binary.

use std::collections::BTreeMap;
use std::sync::Arc;

use nest_contract::{RpcError, Subject};
use serde_json::Value;

/// One `nest.*` method someone contributed.
#[async_trait::async_trait]
pub trait HostMethod: Send + Sync {
    async fn call(&self, subject: &Subject, params: Value) -> Result<Value, RpcError>;
}

#[async_trait::async_trait]
impl<F, Fut> HostMethod for F
where
    F: Fn(Subject, Value) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<Value, RpcError>> + Send,
{
    async fn call(&self, subject: &Subject, params: Value) -> Result<Value, RpcError> {
        self(subject.clone(), params).await
    }
}

pub struct MethodEntry {
    pub owner: Owner,
    handler: Arc<dyn HostMethod>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// Nest itself. The only owner there is — kept as a named type rather
    /// than dropped, because "who registered this" is what the diagnostics
    /// section reports and a bare string would drift.
    Builtin,
}

impl Owner {
    pub fn label(&self) -> String {
        match self {
            Owner::Builtin => "builtin".into(),
        }
    }
}

#[derive(Default)]
pub struct Registry {
    methods: BTreeMap<String, MethodEntry>,
    /// Registrations that did not take, kept so the diagnostics section can
    /// say which one and why rather than the thing silently not being there.
    refused: Vec<(String, String, String)>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a `nest.*` method. Refuses a name already taken: two owners
    /// of one method is a question with no right answer, and the second one
    /// silently winning is the worst of them.
    pub fn method(
        &mut self,
        name: impl Into<String>,
        owner: Owner,
        handler: Arc<dyn HostMethod>,
    ) -> Result<(), String> {
        let name = name.into();
        if let Some(existing) = self.methods.get(&name) {
            let reason = format!(
                "`{name}` is already contributed by {}",
                existing.owner.label()
            );
            self.refused.push((owner.label(), "hub.method".into(), reason.clone()));
            return Err(reason);
        }
        self.methods.insert(name, MethodEntry { owner, handler });
        Ok(())
    }

    pub fn lookup(&self, name: &str) -> Option<&Arc<dyn HostMethod>> {
        self.methods.get(name).map(|e| &e.handler)
    }

    pub fn method_names(&self) -> Vec<&str> {
        self.methods.keys().map(String::as_str).collect()
    }

    /// Everything that did not take, with the reason. Queryable rather than
    /// logged: "my plugin does nothing" needs an answer, not a guess (§2.4).
    pub fn refusals(&self) -> &[(String, String, String)] {
        &self.refused
    }

}
