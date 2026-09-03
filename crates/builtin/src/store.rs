//! Nest's own state, in Nest's own directory.
//!
//! Everything this file holds is something AttaCore does not have a concept of
//! — workspaces, session titles, archived rows, view preferences. It lives
//! under the state root the caller resolved (`crates/app/src/paths.rs`),
//! never mixed into the engine's root: that tree belongs to AttaCore and to
//! whoever hand-edits it, and a front end's bookkeeping has no business
//! there. Deleting our root loses grouping and titles and nothing else.
//!
//! One small JSON file, rewritten atomically on every change (temp + rename),
//! so a crash mid-write leaves the previous state rather than half of the new
//! one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::warn;

const STATE_VERSION: u32 = 1;

/// A project the user groups sessions under.
///
/// `path` is the project root a session's `project_root` matches; `None` is
/// the no-project group, which exists so no-project sessions can be ordered
/// and collapsed like any other.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    #[serde(default)]
    pub collapsed: bool,
    /// Manual session order inside this workspace; ids not listed fall to the
    /// end by recency.
    #[serde(default)]
    pub session_order: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionMeta {
    /// Title the user typed. AttaCore has no `session.rename`, so a rename
    /// lives here until it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NestState {
    pub version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub sessions: HashMap<String, SessionMeta>,
    /// View preferences the browser owns but wants to survive a reload
    /// (grouping, sort mode, sidebar width).
    #[serde(default)]
    pub prefs: Map<String, Value>,
}

impl Default for NestState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            workspaces: Vec::new(),
            sessions: HashMap::new(),
            prefs: Map::new(),
        }
    }
}

/// The state file plus its directory.
pub struct Store {
    root: PathBuf,
    file: PathBuf,
    state: NestState,
}

impl Store {
    /// Resolve the root and load what is there. A missing file is an empty
    /// state; an unreadable or unparsable one is backed up and replaced,
    /// because refusing to start over a corrupt preferences file would be a
    /// worse trade than losing the grouping.
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&root)?;
        let file = root.join("state.json");
        let state = match std::fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<NestState>(&bytes) {
                Ok(state) => state,
                Err(e) => {
                    let backup = file.with_extension("json.broken");
                    warn!(error = %e, backup = %backup.display(), "unreadable state file; starting fresh");
                    let _ = std::fs::rename(&file, &backup);
                    NestState::default()
                }
            },
            Err(_) => NestState::default(),
        };
        Ok(Self { root, file, state })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state(&self) -> &NestState {
        &self.state
    }

    /// Mutate and persist. The closure's return value is handed back, so a
    /// caller can build its response from the state it just wrote.
    pub fn update<T>(&mut self, f: impl FnOnce(&mut NestState) -> T) -> T {
        let out = f(&mut self.state);
        self.persist();
        out
    }

    fn persist(&self) {
        let Ok(json) = serde_json::to_vec_pretty(&self.state) else {
            return;
        };
        let temp = self.file.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&temp, &json).and_then(|()| std::fs::rename(&temp, &self.file))
        {
            warn!(error = %e, "could not write the Nest state file");
        }
    }

    pub fn title_of(&self, session_id: &str) -> Option<String> {
        self.state.sessions.get(session_id).and_then(|m| m.title.clone())
    }

    /// The workspace a project root belongs to, if one is registered.
    pub fn workspace_for(&self, project_root: Option<&str>) -> Option<&Workspace> {
        self.state
            .workspaces
            .iter()
            .find(|w| w.path.as_deref() == project_root)
    }
}

pub fn new_workspace_id() -> String {
    format!("w-{}", uuid::Uuid::new_v4().simple())
}
