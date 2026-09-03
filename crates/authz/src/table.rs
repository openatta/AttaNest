//! Which subjects reach which methods.
//!
//! The table is data, in one place, so "what can a client call" is answered
//! by reading it rather than by tracing dispatch. Everything absent is
//! refused — a new method is unreachable until someone writes it down.

use std::collections::BTreeMap;

use nest_contract::Subject;

use crate::audit::Decision;

/// How far a method is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// This binary only. Never reachable from outside the process.
    Kernel,
    /// Any paired device, and the kernel.
    Device,
    /// It exists and is refused, with the reason a client can show.
    Refused(&'static str),
}

pub struct MethodTable {
    entries: BTreeMap<&'static str, Reach>,
}

impl MethodTable {
    pub fn new() -> Self {
        Self { entries: BTreeMap::new() }
    }

    pub fn allow(mut self, method: &'static str, reach: Reach) -> Self {
        self.entries.insert(method, reach);
        self
    }

    pub fn allow_all(mut self, methods: &[&'static str], reach: Reach) -> Self {
        for m in methods {
            self.entries.insert(m, reach);
        }
        self
    }

    pub fn decide(&self, subject: &Subject, method: &str) -> Decision {
        let Some(reach) = self.entries.get(method) else {
            return Decision::Unknown;
        };
        match (reach, subject) {
            (Reach::Refused(reason), _) => Decision::Refuse(reason),
            (_, Subject::Kernel) => Decision::Allow,
            (Reach::Kernel, _) => Decision::Refuse(
                "this method is the kernel's own and is not reachable from outside the process",
            ),
            (Reach::Device, Subject::Device { .. }) => Decision::Allow,
        }
    }

    pub fn reachable(&self, subject: &Subject) -> Vec<&'static str> {
        self.entries
            .iter()
            .filter(|(m, _)| matches!(self.decide(subject, m), Decision::Allow))
            .map(|(m, _)| *m)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Every name in the table with how far it reaches — the source the
    /// generated method catalog is rendered from.
    pub fn rows(&self) -> impl Iterator<Item = (&'static str, Reach)> + '_ {
        self.entries.iter().map(|(m, r)| (*m, *r))
    }
}

impl Default for MethodTable {
    fn default() -> Self {
        Self::new()
    }
}

/// The engine methods that change credentials, repoint model endpoints, or
/// hand the caller the process itself. Refused always, with the reason
/// written out — the engine trusts whoever reaches its dispatch, and in this
/// process that is the hub (§3.4).
///
/// `plugin.*` is deliberately **not** in this list. Installing a plugin runs
/// code, but one process serves one user and a device is that person: the
/// question this layer really answers is "may installed code do this on their
/// behalf", not "may this person install something". The enforcement that
/// matters is the engine's — its capability gate, its sandbox, and the
/// disclosure it returns from the install itself.
///
/// `mcp.addServer` stays refused, and the difference is the point: it
/// configures a subprocess-spawning tool with no manifest, no capability
/// declaration and no disclosure at all.
pub const ENGINE_REFUSALS: &[(&str, &str)] = &[
    ("config.setProvider", "changing provider credentials or base_url would point model traffic elsewhere"),
    ("config.set", "changing provider credentials or base_url would point model traffic elsewhere"),
    ("config.update", "changing provider credentials or base_url would point model traffic elsewhere"),
    ("mcp.addServer", "adding an MCP server is equivalent to installing a tool that runs subprocesses"),
    ("import.run", "config import runs outside the disclosure this layer is for"),
    ("import.list", "config import runs outside the disclosure this layer is for"),
    ("daemon.shutdown", "the process is stopped by whoever started it, not over its own protocol"),
    ("session.run_turn", "use nest.send — the hub owns turns, so closing a tab cannot lose one"),
    ("session.subscribe", "use nest.attach — the hub subscribes before any client does"),
    ("session.unsubscribe", "use nest.detach — the hub owns subscriptions"),
    ("daemon.subscribeEvents", "host events are the hub's to fan out"),
];
