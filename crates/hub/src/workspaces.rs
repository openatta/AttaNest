//! Workspaces, session titles, view preferences, and search.
//!
//! Part of [`crate::Hub`]; split out of `lib.rs` by concern rather than by
//! type, so the file you open is the subject you came for.

use std::collections::HashMap;

use daemon::rpc::codes;
use serde_json::{json, Value};

use crate::store::{new_workspace_id, Workspace};
use crate::{default_title, require_session_id, require_str, Hub};

impl Hub {
    /// Workspaces are Nest's own idea. The engine knows a session's
    /// `project_root` and nothing else, so grouping, ordering, collapse and
    /// archival live in `store` and are joined onto the session list here.
    pub(crate) async fn workspaces_list(&self) -> Result<Value, Value> {
        let store = self.store.lock().await;
        Ok(json!({
            "workspaces": store.state().workspaces,
            "prefs": store.state().prefs,
        }))
    }

    pub(crate) async fn workspaces_create(&self, params: Value) -> Result<Value, Value> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(path) = &path {
            if !std::path::Path::new(path).is_dir() {
                return Err(json!({
                    "code": codes::INVALID_PARAMS,
                    "message": format!("not a directory: {path}"),
                }));
            }
        }
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| default_title(path.as_deref()));

        let mut store = self.store.lock().await;
        if let Some(existing) = store.workspace_for(path.as_deref()) {
            return Ok(json!({"workspace": existing, "existed": true}));
        }
        let workspace = Workspace {
            id: new_workspace_id(),
            path,
            title,
            collapsed: false,
            session_order: Vec::new(),
        };
        let created = store.update(|state| {
            state.workspaces.push(workspace);
            state.workspaces.last().cloned()
        });
        Ok(json!({"workspace": created, "existed": false}))
    }

    pub(crate) async fn workspaces_update(&self, params: Value) -> Result<Value, Value> {
        let id = require_str(&params, "id")?;
        let mut store = self.store.lock().await;
        let updated = store.update(|state| {
            let workspace = state.workspaces.iter_mut().find(|w| w.id == id)?;
            if let Some(title) = params.get("title").and_then(Value::as_str) {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    workspace.title = trimmed.to_string();
                }
            }
            if let Some(collapsed) = params.get("collapsed").and_then(Value::as_bool) {
                workspace.collapsed = collapsed;
            }
            if let Some(order) = params.get("session_order").and_then(Value::as_array) {
                workspace.session_order = order
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
            }
            Some(workspace.clone())
        });
        match updated {
            Some(workspace) => Ok(json!({"workspace": workspace})),
            None => Err(json!({"code": codes::INVALID_PARAMS, "message": "unknown workspace"})),
        }
    }

    /// Move a workspace before another (or to the end). The whole order comes
    /// back, so a client never has to reconstruct it from a delta.
    pub(crate) async fn workspaces_reorder(&self, params: Value) -> Result<Value, Value> {
        let id = require_str(&params, "id")?;
        let before = params
            .get("before_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut store = self.store.lock().await;
        let workspaces = store.update(|state| {
            let from = state.workspaces.iter().position(|w| w.id == id)?;
            let moved = state.workspaces.remove(from);
            let at = before
                .as_deref()
                .and_then(|anchor| state.workspaces.iter().position(|w| w.id == anchor))
                .unwrap_or(state.workspaces.len());
            state.workspaces.insert(at, moved);
            Some(state.workspaces.clone())
        });
        match workspaces {
            Some(workspaces) => Ok(json!({"workspaces": workspaces})),
            None => Err(json!({"code": codes::INVALID_PARAMS, "message": "unknown workspace"})),
        }
    }

    /// Forget the grouping only. Sessions and transcripts are untouched — a
    /// removed workspace's sessions reappear ungrouped.
    pub(crate) async fn workspaces_remove(&self, params: Value) -> Result<Value, Value> {
        let id = require_str(&params, "id")?;
        let mut store = self.store.lock().await;
        let workspaces = store.update(|state| {
            state.workspaces.retain(|w| w.id != id);
            state.workspaces.clone()
        });
        Ok(json!({"workspaces": workspaces}))
    }

    /// A title the user typed. The engine has no `session.rename`, so this is
    /// an overlay: `nest.sessions` prefers it over the engine's generated name
    /// and nothing else in the system sees it.
    pub(crate) async fn session_rename(&self, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let mut store = self.store.lock().await;
        store.update(|state| {
            let meta = state.sessions.entry(session_id.clone()).or_default();
            meta.title = if title.is_empty() { None } else { Some(title.clone()) };
        });
        Ok(json!({"session_id": session_id, "title": if title.is_empty() { Value::Null } else { json!(title) }}))
    }

    pub(crate) async fn session_archive(&self, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        let archived = params
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut store = self.store.lock().await;
        store.update(|state| {
            let meta = state.sessions.entry(session_id.clone()).or_default();
            meta.archived = archived;
        });
        Ok(json!({"session_id": session_id, "archived": archived}))
    }

    pub(crate) async fn prefs_set(&self, params: Value) -> Result<Value, Value> {
        let key = require_str(&params, "key")?;
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        let mut store = self.store.lock().await;
        let prefs = store.update(|state| {
            if value.is_null() {
                state.prefs.remove(&key);
            } else {
                state.prefs.insert(key.clone(), value.clone());
            }
            state.prefs.clone()
        });
        Ok(json!({"prefs": prefs}))
    }

    /// Content search across sessions.
    ///
    /// Ordering comes from `session.list` (most recent first); the scan itself
    /// reads the transcript store directly — see `nest_engine::search` for why
    /// this does not page `session.history`.
    pub(crate) async fn search(&self, params: Value) -> Result<Value, Value> {
        let query = require_str(&params, "query")?;
        let Some(store) = self.engine.history.as_ref() else {
            return Err(json!({
                "code": codes::INTERNAL_ERROR,
                "message": "this engine has no transcript store",
            }));
        };

        let listed = self.call("session.list", json!({})).await?;
        let sessions: Vec<String> = listed
            .get("sessions")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("session_id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let mut limits = nest_engine::search::Limits::default();
        if let Some(limit) = params.get("limit").and_then(Value::as_u64) {
            limits.max_hits = (limit as usize).clamp(1, limits.max_hits);
        }
        let outcome = nest_engine::search::search(store.as_ref(), &sessions, &query, &limits).await;

        // Titles live here, not in the transcript.
        let titles = {
            let store = self.store.lock().await;
            outcome
                .hits
                .iter()
                .map(|hit| (hit.session_id.clone(), store.title_of(&hit.session_id)))
                .collect::<HashMap<_, _>>()
        };
        let hits: Vec<Value> = outcome
            .hits
            .iter()
            .map(|hit| {
                json!({
                    "session_id": hit.session_id,
                    "name": titles.get(&hit.session_id).cloned().flatten(),
                    "role": hit.role,
                    "snippet": hit.snippet,
                    "ts": hit.ts,
                })
            })
            .collect();

        Ok(json!({
            "hits": hits,
            "scanned": outcome.scanned,
            "truncated": outcome.truncated,
        }))
    }

}
