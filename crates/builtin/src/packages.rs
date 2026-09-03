//! Reading the one section of an installed package that the engine ignores.
//!
//! **Nest does not install anything, and does not run anything.** The package
//! format, the fetch, the checksum, the unpack, the cache layout, the
//! disclosure and the lifecycle are AttaCore's — one package, one manifest,
//! one install, one disclosure (§2.2). What is here is a reader: given what
//! the engine says is installed, find its unpacked directory and pick out the
//! one section the engine has no opinion about.
//!
//! ```toml
//! [[ui]]                    # a same-origin ES module the browser imports
//! point  = "tool.row"
//! module = "rows.js"        # under the package's ui/
//! ```
//!
//! The engine's manifest parser ignores sections it does not know, so this
//! needs nothing from it.
//!
//! # One section, not two
//!
//! There was briefly a `[[host]]` section here — a projection, a pure fold
//! over the event stream, run by Nest. It was removed on purpose. A fold has
//! no capabilities, so it did not introduce a second answer to "what may an
//! extension do" — but keeping it meant the rule had to be stated as
//! "Nest executes package code, but only the kind that cannot do anything",
//! and a rule with a carve-out is a rule somebody eventually widens.
//!
//! **Nest executes nothing a package brought.** That version needs no
//! exception, and `crates/app/tests/layering.rs` holds it.
//!
//! # Where the package is, is the engine's to say
//!
//! `plugin.list` carries each package's unpacked `root`. Nest reads it and
//! never composes a path of its own, so the engine's cache layout stays the
//! engine's: it can move packages, version the directory name, or split the
//! tiers differently, and nothing here has to be told.

use std::path::{Path, PathBuf};

use nest_contrib::CONTRIB_API_VERSION;
use serde::{Deserialize, Serialize};

/// What a package contributes to this side.
#[derive(Debug, Clone, Serialize)]
pub struct Contributions {
    pub plugin: String,
    pub version: String,
    pub root: PathBuf,
    pub enabled: bool,
    pub ui: Vec<UiEntry>,
    /// Declared sections that will **not** take, and why. Kept rather than
    /// dropped: a contribution that quietly does nothing is the failure mode
    /// worth designing against.
    pub inert: Vec<String>,
    /// Things that will take, and are still worth saying.
    ///
    /// Separate from `inert` because they answer different questions. "This
    /// will not appear" and "this works but is built on an assumption that
    /// may not hold next release" belong on different lines, and folding the
    /// second into the first would make every advisory look like a failure.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiEntry {
    pub point: String,
    /// Which contribution API this module was written against.
    ///
    /// Not the same number as `[plugin] api_version`, which is the engine's.
    /// A package can be current on one and stale on the other, so they are
    /// two versions and are checked by the two sides that own them.
    ///
    /// Absent means "written before this was declared". Accepted, because
    /// refusing every package that predates the field would be a version
    /// check that mostly rejects working things — but reported, so an author
    /// is told rather than left to find out when a panel does not appear.
    #[serde(default)]
    pub api_version: Option<u32>,
    /// Relative to the package's `ui/` directory, and only ever resolved
    /// against it. That is not a convention — it is what makes it impossible
    /// to name a file outside `ui/`, so nothing else in the package can be
    /// reached over HTTP by writing a clever `module`.
    pub module: String,
}

/// Only this one section. Everything else in the manifest is the engine's.
#[derive(Debug, Default, Deserialize)]
struct Sections {
    #[serde(default)]
    ui: Vec<UiEntry>,
}

/// Read one package's `[[ui]]` section.
///
/// A package without one is not an error and not a warning — most packages
/// are engine-only, and that is the ordinary case.
pub fn read(root: &Path, name: &str, version: &str, enabled: bool) -> Option<Contributions> {
    let text = std::fs::read_to_string(root.join("plugin.toml")).ok()?;
    let sections: Sections = toml::from_str(&text).unwrap_or_default();
    if sections.ui.is_empty() {
        return None;
    }

    let mut inert = Vec::new();
    let mut notes = Vec::new();
    let ui: Vec<UiEntry> = sections
        .ui
        .into_iter()
        .filter(|entry| {
            // A module written against a different contribution API is
            // refused **here**, at install, rather than imported and left to
            // fail inside `activate()`. The second way produces a panel that
            // silently does not appear, which is the failure mode with no
            // symptom (§2.4).
            match entry.api_version {
                Some(declared) if declared != CONTRIB_API_VERSION => {
                    inert.push(format!(
                        "{} 是照贡献点 API v{declared} 写的，这个构建是 v{CONTRIB_API_VERSION}；\
                         {} 的那一边旧了",
                        entry.point,
                        if declared < CONTRIB_API_VERSION { "包" } else { "Nest" },
                    ));
                    return false;
                }
                // Loads. Said anyway, because the alternative is an author
                // finding out when a panel stops appearing.
                None => notes.push(format!(
                    "{} 没有声明 api_version；贡献点契约改动之后它会安静地失效",
                    entry.point,
                )),
                _ => {}
            }
            // A module has to be inside the package. Anything with `..` in it
            // is refused here rather than resolved — the unpacker already
            // rejects such entries, and this is the second place that would
            // have to be wrong for one to escape.
            let ok = !entry.module.contains("..") && root.join("ui").join(&entry.module).is_file();
            if !ok {
                inert.push(format!("{} → ui/{} 不在这个包里", entry.point, entry.module));
            }
            ok
        })
        .collect();


    Some(Contributions {
        plugin: name.to_string(),
        version: version.to_string(),
        root: root.to_path_buf(),
        enabled,
        ui,
        inert,
        notes,
    })
}

/// Everything that contributes to this side, in a `plugin.list` answer.
///
/// Separate from [`discover`] so a caller that already asked the engine —
/// `nest.plugins.list` does, to show the engine's own list beside this one —
/// reads the answer it has rather than asking a second time.
pub fn read_all(listed: &serde_json::Value) -> Vec<Contributions> {
    let mut found = Vec::new();
    for entry in listed.get("plugins").and_then(|v| v.as_array()).map_or(&[][..], |v| v) {
        let get = |key: &str| entry.get(key).and_then(|v| v.as_str()).unwrap_or_default();
        let (name, version, root) = (get("name"), get("version"), get("root"));
        if name.is_empty() || version.is_empty() || root.is_empty() {
            continue;
        }
        let enabled = entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        if let Some(contributions) = read(Path::new(root), name, version, enabled) {
            for reason in &contributions.inert {
                tracing::warn!(plugin = %name, %reason, "a declared contribution will not take");
            }
            for note in &contributions.notes {
                tracing::info!(plugin = %name, %note, "about a contribution");
            }
            found.push(contributions);
        }
    }
    found
}

/// Ask the engine what is installed, and read what of it lands here.
///
/// Driven by what the engine says is installed, so a package that the engine
/// refused, disabled or never had is not here either. Asking the engine
/// rather than scanning the directory is the difference between "installed"
/// and "some files are lying around".
pub async fn discover(hub: &nest_hub::Hub) -> Vec<Contributions> {
    match hub.engine_call("plugin.list", serde_json::json!({})).await {
        Ok(listed) => read_all(&listed),
        Err(e) => {
            // A build without the package layer answers `PLUGINS_DISABLED`
            // and nothing is installed, which is a fact rather than a
            // failure — see §4.5.
            tracing::debug!(reason = %e.message, "no installed packages to read");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(body: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("plugin.toml"), body).unwrap();
        std::fs::create_dir_all(dir.path().join("ui")).unwrap();
        std::fs::create_dir_all(dir.path().join("host")).unwrap();
        std::fs::write(dir.path().join("ui/rows.js"), "export function activate(){}").unwrap();
        std::fs::write(dir.path().join("host/fold.js"), "function project(){}").unwrap();
        dir
    }

    /// The engine's own sections are none of this reader's business, and a
    /// manifest full of them parses here without complaint.
    #[test]
    fn an_engine_only_package_contributes_nothing_here() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[wasm]]
            component = "p.wasm"

            [[mcp]]
            name = "gh"
            "#,
        );
        assert!(read(dir.path(), "p", "1.0.0", true).is_none());
    }

    #[test]
    fn the_two_sections_are_read_and_the_rest_ignored() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[wasm]]
            component = "p.wasm"

            [[mcp]]
            name = "gh"

            [[ui]]
            point = "tool.row"
            module = "rows.js"
            "#,
        );
        let read = read(dir.path(), "p", "1.0.0", true).expect("contributes");
        assert_eq!(read.ui.len(), 1);
        assert!(read.inert.is_empty());
    }

    /// A package can carry code for the engine to run, and Nest reads none
    /// of it. What is checked here is that a `[[host]]` section — the one
    /// that briefly existed and was removed — contributes nothing now, rather
    /// than being quietly half-supported.
    #[test]
    fn a_host_section_contributes_nothing() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[host]]
            point = "hub.projection"
            entry = "host/fold.js:project"
            "#,
        );
        assert!(
            read(dir.path(), "p", "1.0.0", true).is_none(),
            "a host section was read"
        );
    }

    /// `module` is resolved under `ui/` and nowhere else, so a package
    /// cannot name a file elsewhere in itself and have it served over HTTP.
    /// A module written against a different contribution API is refused at
    /// install, with which side is stale named.
    #[test]
    fn a_mismatched_contribution_api_is_refused_by_version() {
        let dir = package(&format!(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "rows.js"
            api_version = {}
            "#,
            CONTRIB_API_VERSION + 1,
        ));
        let read = read(dir.path(), "p", "1.0.0", true).expect("declares something");
        assert!(read.ui.is_empty(), "a mismatched module was going to be loaded");
        assert!(read.inert[0].contains("Nest"), "does not say which side is stale");
    }

    #[test]
    fn a_matching_contribution_api_loads_without_comment() {
        let dir = package(&format!(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "rows.js"
            api_version = {CONTRIB_API_VERSION}
            "#
        ));
        let read = read(dir.path(), "p", "1.0.0", true).expect("contributes");
        assert_eq!(read.ui.len(), 1);
        assert!(read.inert.is_empty(), "a matching version was refused: {:?}", read.inert);
        assert!(read.notes.is_empty(), "a matching version was commented on: {:?}", read.notes);
    }

    /// A package that predates the field still loads. Refusing every one of
    /// them would be a version check that mostly rejects working things —
    /// but the author is told, rather than finding out when a panel does not
    /// appear.
    #[test]
    fn an_undeclared_contribution_api_loads_and_is_mentioned() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "rows.js"
            "#,
        );
        let read = read(dir.path(), "p", "1.0.0", true).expect("contributes");
        assert_eq!(read.ui.len(), 1, "an undeclared version was refused");
        assert!(read.inert.is_empty(), "an advisory was filed as a refusal");
        assert!(read.notes[0].contains("api_version"), "the author was not told");
    }

    /// The unpacked directory comes from the engine's answer. Nest composes
    /// no path of its own, so a package the engine put somewhere unexpected
    /// is still found, and one the engine did not locate is skipped rather
    /// than guessed at.
    #[test]
    fn the_root_is_taken_from_the_engine_and_never_composed() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "rows.js"
            api_version = 1
            "#,
        );
        let listed = serde_json::json!({"plugins": [
            {"name": "p", "version": "1.0.0", "enabled": true,
             "root": dir.path().display().to_string()},
            {"name": "no-root", "version": "1.0.0", "enabled": true},
        ]});
        let found = read_all(&listed);
        assert_eq!(found.len(), 1, "a package without a root was guessed at");
        assert_eq!(found[0].root, dir.path());
        assert_eq!(found[0].ui.len(), 1);
    }

    #[test]
    fn a_module_cannot_reach_outside_the_ui_directory() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "host/fold.js"
            "#,
        );
        let read = read(dir.path(), "p", "1.0.0", true).expect("declares something");
        assert!(read.ui.is_empty(), "a file outside ui/ was going to be served");
    }

    #[test]
    fn a_module_outside_the_package_is_refused() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "../../../etc/passwd"
            "#,
        );
        let read = read(dir.path(), "p", "1.0.0", true).expect("declares something");
        assert!(read.ui.is_empty(), "a module outside the package was served");
        assert_eq!(read.inert.len(), 1);
    }

    /// Declared, not runnable, and said so — rather than a blank panel.
    #[test]
    fn a_missing_file_is_reported() {
        let dir = package(
            r#"
            [plugin]
            name = "p"
            version = "1.0.0"
            api_version = "1"

            [[ui]]
            point = "tool.row"
            module = "gone.js"
            "#,
        );
        let read = read(dir.path(), "p", "1.0.0", true).expect("declares something");
        assert!(read.ui.is_empty());
        assert!(read.inert[0].contains("不在这个包里"));
    }
}
