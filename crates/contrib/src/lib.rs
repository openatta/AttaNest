//! Contribution points: how the interface is assembled out of named parts.
//!
//! **These are Nest's own seams, not an extension surface for third parties.**
//! Extending the agent is AttaCore's business — its scripts, its plugins, its
//! manifest, its capability gate, its disclosure. Nest neither reads a package
//! nor runs one. What this crate does is keep the interface from being a pile
//! of switch statements: every tool row, flow block, panel, sidebar grouping,
//! command and settings section is a named registration, so the shell asks a
//! registry instead of knowing every case.
//!
//! Two rules survive from when this was going to be more, and both are still
//! worth their keep:
//!
//! 1. **The catalog is generated.** [`catalog::render_markdown`] renders the
//!    table in `docs/contribution_points.md`, and `crates/app/tests/catalog_doc.rs`
//!    fails when the file and the code disagree. A stale list of seams is
//!    worse than none: it gets quoted as fact.
//! 2. **Frequency is part of the contract.** Every point says the order of
//!    magnitude it fires at, and nothing here follows the stream: a point
//!    evaluated per streaming delta would cost a few thousand calls a turn
//!    where these cost a dozen.
//!
//! And one that matters more than either: **the shell must ask.** A point
//! nothing consults is a seam that exists only in the catalog, and the
//! product goes on drawing that thing directly — which is exactly what
//! happened once, to five of the seven points, with every test still green.
//! `tests/contrib-smoke.mjs` checks for it now.

pub mod catalog;
pub mod registry;

pub use catalog::{Frequency, Point, PointKind};
pub use registry::{HostMethod, Registry};

/// Bumped when a point's contract changes. Negotiated in the handshake
/// separately from the protocol version: an interface bundle can be current
/// on one and stale on the other.
pub use nest_contract::handshake::CONTRIB_API_VERSION;
