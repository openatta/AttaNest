//! The two places the protocol version is written down, compared.
//!
//! One is Rust and one is the JavaScript the browser loads, and they have to
//! agree or every handshake is refused with a sentence about someone being out
//! of date. Nothing in either build makes them agree, so this does.

use std::path::PathBuf;

fn read(name: &str) -> i64 {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../ui/runtime/protocol.js")
        .canonicalize()
        .expect("ui/runtime/protocol.js");
    let text = std::fs::read_to_string(&path).expect("read protocol.js");
    let needle = format!("export const {name} = ");
    let line = text
        .lines()
        .find(|l| l.starts_with(&needle))
        .unwrap_or_else(|| panic!("{name} is not declared in {}", path.display()));
    line[needle.len()..]
        .trim_end_matches(';')
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("{name} is not a number: {line}"))
}

#[test]
fn the_interface_and_the_backend_agree_on_the_protocol_version() {
    assert_eq!(
        read("PROTOCOL_VERSION"),
        i64::from(nest_contract::PROTOCOL_VERSION),
        "ui/runtime/protocol.js and nest_contract disagree; every handshake would be refused"
    );
}

#[test]
fn the_interface_and_the_backend_agree_on_the_contribution_api() {
    assert_eq!(read("CONTRIB_API_VERSION"), i64::from(nest_contract::CONTRIB_API_VERSION));
}

/// The codes a client branches on, stated on both sides.
#[test]
fn the_interface_and_the_backend_agree_on_the_codes() {
    assert_eq!(read("REFUSED"), i64::from(nest_contract::codes::REFUSED));
    assert_eq!(
        read("HANDSHAKE_REFUSED"),
        i64::from(nest_contract::codes::HANDSHAKE_REFUSED)
    );
}

/// Nest's own codes stay out of the band JSON-RPC reserves for the
/// implementation, which is where AttaCore's live. `REFUSED` was `-32000`
/// once — the same number as the engine's `SESSION_NOT_FOUND`.
#[test]
fn nests_codes_cannot_collide_with_the_engines() {
    for (name, code) in [
        ("REFUSED", nest_contract::codes::REFUSED),
        ("HANDSHAKE_REFUSED", nest_contract::codes::HANDSHAKE_REFUSED),
    ] {
        assert!(
            code > -32000,
            "{name} is {code}, inside JSON-RPC's reserved band where the engine's codes live"
        );
    }
}
