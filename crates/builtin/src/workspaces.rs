//! Workspaces, session titles, view preferences, and search.
//!
//! Registered through the interface's own registry, like everything else
//! this product draws (§5.5).

use std::collections::HashMap;

use nest_contract::{codes, RpcError};
use serde_json::{json, Value};

use crate::store::{new_workspace_id, Workspace};
use crate::{default_title, require_session_id, require_str, Builtin};

impl Builtin {
    /// Workspaces are Nest's own idea. The engine knows a session's
    /// `project_root` and nothing else, so grouping, ordering, collapse and
    /// archival live in `store` and are joined onto the session list here.
    /// The groups, the view preferences, and **the per-session overlay**.
    ///
    /// The overlay is here rather than folded into `nest.sessions` because
    /// the hub does not know what a workspace is and must not learn: it holds
    /// sessions, and a title someone typed is not a property of a session,
    /// it is a note this product keeps about one.
    ///
    /// It was briefly nowhere at all. `nest.sessions` used to fold it in;
    /// splitting the layers moved the store out of the hub and the fold went
    /// with it, so renaming a session wrote to disk and nothing ever read it
    /// back — along with archiving, grouping and every view preference. The
    /// interface tests did not notice because their fake backend still
    /// returned the old shape, which is the one way a fake earns its risk and
    /// then loses it.
    pub(crate) async fn workspaces_list(&self) -> Result<Value, RpcError> {
        let store = self.store.lock().await;
        let state = store.state();
        // Which workspace a session belongs to is **not** here, and cannot
        // be: it is a session's project root matched against a workspace's
        // path, and the store knows the paths while the hub knows the roots.
        // Reaching across for it would mean one of the two layers learning
        // about the other. The client holds both halves already, so the join
        // is its to make.
        let sessions: serde_json::Map<String, Value> = state
            .sessions
            .iter()
            .map(|(id, meta)| {
                (
                    id.clone(),
                    json!({
                        // A user-typed title outranks the engine's generated
                        // name; `null` means they never typed one.
                        "title": meta.title,
                        "archived": meta.archived,
                    }),
                )
            })
            .collect();
        Ok(json!({
            "workspaces": state.workspaces,
            "prefs": state.prefs,
            "sessions": sessions,
        }))
    }

    pub(crate) async fn workspaces_create(&self, params: Value) -> Result<Value, RpcError> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(path) = &path {
            if !std::path::Path::new(path).is_dir() {
                return Err(RpcError::new(codes::INVALID_PARAMS, format!("not a directory: {path}")));
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

    pub(crate) async fn workspaces_update(&self, params: Value) -> Result<Value, RpcError> {
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
            None => Err(RpcError::new(codes::INVALID_PARAMS, "unknown workspace")),
        }
    }

    /// Move a workspace before another (or to the end). The whole order comes
    /// back, so a client never has to reconstruct it from a delta.
    pub(crate) async fn workspaces_reorder(&self, params: Value) -> Result<Value, RpcError> {
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
            None => Err(RpcError::new(codes::INVALID_PARAMS, "unknown workspace")),
        }
    }

    /// Forget the grouping only. Sessions and transcripts are untouched — a
    /// removed workspace's sessions reappear ungrouped.
    pub(crate) async fn workspaces_remove(&self, params: Value) -> Result<Value, RpcError> {
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
    pub(crate) async fn session_rename(&self, params: Value) -> Result<Value, RpcError> {
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

    pub(crate) async fn session_archive(&self, params: Value) -> Result<Value, RpcError> {
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

    pub(crate) async fn prefs_set(&self, params: Value) -> Result<Value, RpcError> {
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
    pub(crate) async fn search(&self, params: Value) -> Result<Value, RpcError> {
        let query = require_str(&params, "query")?;
        let Some(store) = self.hub.engine().history.as_ref() else {
            return Err(RpcError::new(codes::INTERNAL_ERROR, "this engine has no transcript store"));
        };

        let listed = self.hub.engine_call("session.list", json!({})).await?;
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

        let mut limits = crate::search::Limits::default();
        if let Some(limit) = params.get("limit").and_then(Value::as_u64) {
            limits.max_hits = (limit as usize).clamp(1, limits.max_hits);
        }
        let outcome = crate::search::search(store.as_ref(), &sessions, &query, &limits).await;

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
