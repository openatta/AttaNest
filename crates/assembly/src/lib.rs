//! Assembly: build the engine this profile describes, once, and then stop.
//!
//! A profile says which scenes, which providers, which interface and which
//! transport topology; assembly does what it says and nothing more. It does
//! not accept anything changing that while the process runs — a round of
//! assembly is fixed once it is done.
//!
//! This layer does not know the client-facing protocol exists. It depends on
//! the engine and on neither transport nor authorization —
//! `crates/app/tests/layering.rs` states that as a fact about the dependency
//! graph rather than as a paragraph here.
//!
//! # Extensions are not assembled here
//!
//! Nest has no extension subsystem. Scripts and plugins are AttaCore's:
//! their manifest, their disclosure, their capability gate, their carrier,
//! their lifecycle. Nest neither reads a package nor runs one — it hands
//! AttaCore a file and calls AttaCore's own install (see
//! `nest_builtin::plugins`). Anything here that read a manifest would be a
//! second truth about what an extension may do.

pub mod engine;
pub mod profile;

pub use engine::{build as build_engine, Engine, EngineConfig};
pub use profile::{EngineProfile, Profile, TransportProfile, UiProfile};
