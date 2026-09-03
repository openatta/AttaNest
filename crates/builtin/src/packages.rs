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
//! # The one coupling here, named
//!
//! `plugin.list` answers with names and versions and no paths, so the
//! unpacked directory has to be derived from the engine's cache layout:
//! `<plugins-dir>/cache/{name}/{version}/`. That is a dependency on a layout
//! rather than on an interface, and it is written down here rather than
//! spread across call sites — a `root` on `plugin.list` would remove it
//! (see the request filed against AttaCore).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What a package contributes to this side.
#[derive(Debug, Clone, Serialize)]
pub struct Contributions {
    pub plugin: String,
    pub version: String,
    pub root: PathBuf,
    pub enabled: bool,
    pub ui: Vec<UiEntry>,
    /// Declared sections that will not take, and why. Kept rather than
    /// dropped: a contribution that quietly does nothing is the failure mode
    /// worth designing against.
    pub inert: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiEntry {
    pub point: String,
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

/// Where the engine unpacks a package.
pub fn package_root(plugins_dir: &Path, name: &str, version: &str) -> PathBuf {
    plugins_dir.join("cache").join(name).join(version)
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
    let ui: Vec<UiEntry> = sections
        .ui
        .into_iter()
        .filter(|entry| {
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
    })
}

/// Everything installed that contributes to this side.
///
/// Driven by what the engine says is installed, so a package that the engine
/// refused, disabled or never had is not here either. Asking the engine
/// rather than scanning the directory is the difference between "installed"
/// and "some files are lying around".
pub async fn discover(hub: &nest_hub::Hub, plugins_dir: &Path) -> Vec<Contributions> {
    let listed = match hub.engine_call("plugin.list", serde_json::json!({})).await {
        Ok(value) => value,
        Err(e) => {
            // In a build carrying the script carrier this is
            // `PLUGINS_DISABLED` and nothing is installed, which is a fact
            // rather than a failure — see §4.5.
            tracing::debug!(reason = %e.message, "no installed packages to read");
            return Vec::new();
        }
    };
    let mut found = Vec::new();
    for entry in listed.get("plugins").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let get = |key: &str| entry.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let (name, version) = (get("name"), get("version"));
        if name.is_empty() || version.is_empty() {
            continue;
        }
        let enabled = entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        let root = package_root(plugins_dir, &name, &version);
        if let Some(contributions) = read(&root, &name, &version, enabled) {
            for reason in &contributions.inert {
                tracing::warn!(plugin = %name, %reason, "a declared contribution will not take");
            }
            found.push(contributions);
        }
    }
    found
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
