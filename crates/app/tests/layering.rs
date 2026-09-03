//! The dependency direction, asserted rather than described.
//!
//! concept_and_architecture.md §3 says each kernel part is ignorant of the
//! one above it. A paragraph saying so goes stale the first time someone
//! reaches for a type that is convenient and wrong; this fails the build
//! instead.
//!
//! It also asserts the thing §3.3.3's fifth invariant rests on — the hub and
//! the authorizer cannot name a topology, a connection or an HTTP type — and
//! the constraint that keeps Nest a thin layer: no interpreter is linked
//! here, because extension execution is AttaCore's.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/app is two levels below the root")
        .to_path_buf()
}

/// Direct dependencies of one Nest crate, by name.
fn dependencies(crate_dir: &str) -> BTreeSet<String> {
    let manifest = workspace_root().join("crates").join(crate_dir).join("Cargo.toml");
    let text = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|e| panic!("{}: {e}", manifest.display()));
    let mut names = BTreeSet::new();
    let mut in_deps = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_deps = line.starts_with("[dependencies]") || line.starts_with("[dev-dependencies]");
            continue;
        }
        if !in_deps || line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((name, _)) = line.split_once('=') {
            names.insert(name.trim().to_string());
        }
    }
    names
}

fn assert_ignorant_of(crate_dir: &str, forbidden: &[&str], because: &str) {
    let deps = dependencies(crate_dir);
    for name in forbidden {
        assert!(
            !deps.contains(*name),
            "`{crate_dir}` depends on `{name}`, and it must not: {because}"
        );
    }
}

/// Transport moves frames. It does not know what a session is.
#[test]
fn transport_does_not_know_what_a_session_is() {
    assert_ignorant_of(
        "transport",
        &["nest-assembly", "nest-contrib", "nest-plugin", "daemon", "base"],
        "it carries channel semantics and nothing about what they contain",
    );
}

/// Authorization decides subject × method. It does not know what a frame
/// looks like or which channel carried one — otherwise the decision starts
/// depending on the topology, and a subject with several connections gets
/// several answers to one question.
#[test]
fn authorization_does_not_know_what_a_frame_looks_like() {
    assert_ignorant_of(
        "authz",
        &["axum", "nest-transport", "nest-hub", "nest-assembly", "daemon"],
        "it sees an authenticated subject and a method name, and nothing else",
    );
}

/// The hub owns sessions. It does not know about HTTP, TLS, connections or
/// topology — which is what lets a second topology be added without touching
/// it (§3.3.3, fifth invariant).
#[test]
fn the_hub_does_not_know_about_connections() {
    assert_ignorant_of(
        "hub",
        &["axum", "nest-transport", "nest-authz", "bytes", "futures"],
        "it speaks to `dyn FrameSink`, which is all it may learn about a downstream",
    );
}

/// Assembly builds the engine. It does not know the client-facing protocol
/// exists.
#[test]
fn assembly_does_not_know_the_client_protocol_exists() {
    assert_ignorant_of(
        "assembly",
        &["nest-transport", "nest-authz", "nest-hub", "axum"],
        "it stands up an engine; who talks to it is not its business",
    );
}

/// The contract crate is the shared vocabulary. If it grew a dependency on a
/// layer, the layers would be able to reach each other through it and every
/// rule above would be enforceable only on paper.
#[test]
fn the_contract_depends_on_no_layer() {
    let deps = dependencies("contract");
    for name in &deps {
        assert!(
            !name.starts_with("nest-"),
            "`contract` depends on `{name}`; it is the waist of the hourglass and must stay empty"
        );
    }
}

/// Neither the hub nor the authorizer may name a topology.
///
/// This is §3.3.3's fifth invariant, in the only form that survives: "adding
/// a topology does not touch these two layers" is a statement about a diff,
/// and a diff needs a baseline nobody has six months from now. What does not
/// expire is that these layers cannot *say* any of these words — the hub
/// faces "a downstream that can take frames", the authorizer faces "an
/// authenticated subject and a method name", and if either ever needed to
/// know which connection carried something, it would have to name one of
/// these to do it.
///
/// The dependency assertions above stop them reaching a topology through a
/// type. This stops them reaching one through a string.
#[test]
fn neither_the_hub_nor_the_authorizer_names_a_topology() {
    let forbidden = [
        "single_duplex", "split_streams", "request_only", "SingleDuplex",
        "SplitStreams", "RequestOnly", "Topology", "WebSocket", "websocket",
        "/events/", "/rpc", "Sse", "http", "HTTP",
    ];
    let mut offenders = Vec::new();
    for layer in ["hub", "authz"] {
        let dir = workspace_root().join("crates").join(layer).join("src");
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            // Code only. The prose in these files *says* "knows nothing about
            // HTTP", and a check that cannot tell a comment from a call would
            // fail on the sentence describing the rule it is enforcing.
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let code: String = text
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for needle in forbidden {
                if code.contains(needle) {
                    offenders.push(format!("{} names `{needle}`", path.display()));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "the topology leaked into a layer that must not perceive one:\n{}",
        offenders.join("\n")
    );
}

/// Nest links no interpreter.
///
/// Extending the agent is AttaCore's: the carrier, the sandbox, the
/// capability gate. Nest may read a manifest — it reads one section of one,
/// deliberately (§4.6) — but it must never be able to *run* what a package
/// brought, because that is where a second answer to "what may an extension
/// do" would come from.
#[test]
fn nest_constructs_no_interpreter() {
    let root = workspace_root().join("crates");
    let mut offenders = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            // This file names them in order to forbid them.
            if path.ends_with("layering.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            for needle in ["QuickJsEngine", "rquickjs", "wasmtime"] {
                if text.contains(needle) {
                    offenders.push(format!("{} names `{needle}`", path.display()));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "Nest must link no interpreter:\n{}", offenders.join("\n"));
}

/// Nest reads exactly one section of a package manifest.
///
/// This is §2.2 in the only form that survives a rewrite. "Nest has no plugin
/// system" is a sentence; what makes it true is that nothing here parses the
/// engine's half of a manifest — no payloads, no capabilities, no scene, no
/// agent types — and nothing runs what a package brought.
///
/// It was two sections for a while, the second being a projection Nest would
/// execute. A projection has no capabilities, so it introduced no second
/// answer to "what may an extension do" — but it made the rule need a
/// carve-out, and a rule with a carve-out is a rule somebody widens. One
/// section needs no exception.
#[test]
fn nest_reads_only_its_own_manifest_section() {
    let path = workspace_root().join("crates/builtin/src/packages.rs");
    let text = std::fs::read_to_string(&path).expect("packages.rs");
    let start = text.find("struct Sections {").expect("the manifest reader's struct");
    let body = &text[start..start + text[start..].find('}').expect("a closing brace")];

    let fields: BTreeSet<&str> = body
        .lines()
        .filter_map(|line| line.trim().strip_suffix(','))
        .filter_map(|line| line.split(':').next())
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with('#'))
        .collect();

    assert_eq!(
        fields,
        BTreeSet::from(["ui"]),
        "the manifest reader grew a section; everything but `ui` is the engine's"
    );

    // And nothing else in the file names one of the engine's. Code only —
    // the prose here *says* "no capabilities", and a check that cannot tell a
    // comment from a field fails on the sentence describing the rule.
    let code: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for needle in ["WasmPayload", "McpPayload", "SceneSection", "AgentDef", "capabilities"] {
        assert!(
            !code.contains(needle),
            "packages.rs names `{needle}`, which is the engine's half of the manifest"
        );
    }
}

/// Every crate that depends on a Nest crate depends on one that exists, and
/// nothing depends on itself. Cheap, and it catches a rename that only half
/// happened.
#[test]
fn every_nest_dependency_resolves() {
    let crates = ["app", "assembly", "authz", "builtin", "contract", "contrib", "hub", "transport"];
    let known: BTreeSet<String> = crates
        .iter()
        .map(|c| if *c == "app" { "nest".to_string() } else { format!("nest-{c}") })
        .collect();
    for dir in crates {
        for dep in dependencies(dir) {
            if dep.starts_with("nest-") {
                assert!(known.contains(&dep), "`{dir}` depends on unknown crate `{dep}`");
                assert_ne!(dep, format!("nest-{dir}"), "`{dir}` depends on itself");
            }
        }
    }
}
