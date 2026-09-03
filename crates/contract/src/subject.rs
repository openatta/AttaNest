//! Who is calling.
//!
//! Two subjects, and only two. Installed code is **not** one of them: an
//! extension runs inside AttaCore, under AttaCore's capability gate, and
//! never reaches this process's method surface. A `Plugin` variant here would
//! be a second place deciding what an extension may do (§4.1).

use serde::{Deserialize, Serialize};

/// The caller behind one request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Subject {
    /// This binary, calling itself. Assembly and the hub's own turn loop.
    Kernel,
    /// A paired client. One process serves one user, so a device is that
    /// user on one machine — not a tenant.
    Device { id: String },
}

impl Subject {
    pub fn label(&self) -> String {
        match self {
            Subject::Kernel => "kernel".into(),
            Subject::Device { id } => format!("device:{id}"),
        }
    }
}

