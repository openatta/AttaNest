//! Directories, projects, and upload grants — the file-facing methods.
//!
//! Part of [`crate::Hub`]; split out of `lib.rs` by concern rather than by
//! type, so the file you open is the subject you came for.

use std::path::PathBuf;

use daemon::rpc::codes;
use serde_json::{json, Value};

use crate::store::{new_workspace_id, Workspace};
use crate::{home_dir, new_id, require_str, Hub};

impl Hub {
    /// Files under a project root, for the composer's `@` menu.
    ///
    /// Walks with `ignore`, so `.gitignore` and friends apply — a mention menu
    /// full of `node_modules` is a mention menu nobody uses. Bounded by a
    /// result cap and a file cap, and matched on the path as typed (substring,
    /// case-insensitive) rather than fuzzily: a wrong file quietly attached is
    /// worse than one more keystroke.
    pub(crate) async fn files(&self, params: Value) -> Result<Value, Value> {
        const MAX_RESULTS: usize = 30;
        const MAX_VISITED: usize = 20_000;

        let root = params
            .get("project_root")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.projects_root.clone());
        let query = params
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_RESULTS as u64)
            .min(MAX_RESULTS as u64) as usize;

        let root_display = root.display().to_string();
        let files = tokio::task::spawn_blocking(move || {
            let mut out: Vec<(String, u64)> = Vec::new();
            let mut visited = 0usize;
            for entry in ignore::WalkBuilder::new(&root).hidden(true).build().flatten() {
                visited += 1;
                if visited > MAX_VISITED || out.len() >= limit {
                    break;
                }
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let Ok(relative) = entry.path().strip_prefix(&root) else { continue };
                let path = relative.to_string_lossy().to_string();
                if !query.is_empty() && !path.to_lowercase().contains(&query) {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((path, size));
            }
            // Shallow paths first: the file someone means is rarely the deepest.
            out.sort_by_key(|(path, _)| (path.matches('/').count(), path.len()));
            out
        })
        .await
        .map_err(|e| json!({"code": codes::INTERNAL_ERROR, "message": e.to_string()}))?;

        Ok(json!({
            "project_root": root_display,
            "files": files
                .into_iter()
                .map(|(path, size)| json!({"path": path, "size": size}))
                .collect::<Vec<_>>(),
        }))
    }

    /// One directory level, for the project picker.
    ///
    /// Opens on the projects root. Browsing is allowed inside `$HOME` **or**
    /// inside the projects root — the operator named that root, so it is
    /// trusted even when it sits outside the home directory (a deployment
    /// keeping projects on another volume is the ordinary case). Anything
    /// else is refused: a browser asking for `/` is what the fence is for.
    pub(crate) async fn list_directory(&self, params: Value) -> Result<Value, Value> {
        let home = home_dir().ok_or_else(
            || json!({"code": codes::INTERNAL_ERROR, "message": "no home directory"}),
        )?;
        let target = match params.get("path").and_then(Value::as_str) {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => self.projects_root.clone(),
        };
        let target = target.canonicalize().unwrap_or(target);
        let projects = self
            .projects_root
            .canonicalize()
            .unwrap_or_else(|_| self.projects_root.clone());
        if !target.starts_with(&home) && !target.starts_with(&projects) {
            return Err(json!({
                "code": codes::INVALID_PARAMS,
                "message": "path is outside the home and projects directories",
            }));
        }
        let mut entries: Vec<Value> = Vec::new();
        let read = std::fs::read_dir(&target).map_err(|e| {
            json!({"code": codes::INVALID_PARAMS, "message": format!("unreadable: {e}")})
        })?;
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                continue; // a project root is a directory; files are noise here
            }
            entries.push(json!({"name": name, "hidden": name.starts_with('.')}));
        }
        entries.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        });
        let anchor = if target.starts_with(&projects) && !projects.starts_with(&home) {
            projects.as_path()
        } else {
            home.as_path()
        };
        let mut breadcrumbs: Vec<Value> = Vec::new();
        let mut walk = target.as_path();
        loop {
            breadcrumbs.push(json!({
                "name": walk.file_name().map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| walk.display().to_string()),
                "path": walk.display().to_string(),
            }));
            if walk == anchor {
                break;
            }
            match walk.parent() {
                Some(p) if p.starts_with(anchor) || p == anchor => walk = p,
                _ => break,
            }
        }
        breadcrumbs.reverse();
        Ok(json!({
            "path": target.display().to_string(),
            "home": home.display().to_string(),
            "projects_root": self.projects_root.display().to_string(),
            "entries": entries,
            "breadcrumbs": breadcrumbs,
        }))
    }

    /// Create a project directory under the projects root.
    ///
    /// One segment, no separators: this makes a project, it does not place a
    /// directory anywhere the caller names. The workspace is registered in the
    /// same call, because a project the sidebar cannot show is not one the
    /// user asked for.
    pub(crate) async fn projects_create(&self, params: Value) -> Result<Value, Value> {
        let name = require_str(&params, "name")?.trim().to_string();
        let invalid = name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name.starts_with('.')
            || name == ".."
            || name.len() > 128;
        if invalid {
            return Err(json!({
                "code": codes::INVALID_PARAMS,
                "message": "a project name is one path segment, not a path",
            }));
        }
        let path = self.projects_root.join(&name);
        if path.exists() {
            return Err(json!({
                "code": codes::INVALID_PARAMS,
                "message": format!("already exists: {}", path.display()),
            }));
        }
        std::fs::create_dir_all(&path).map_err(|e| {
            json!({"code": codes::INTERNAL_ERROR, "message": format!("could not create: {e}")})
        })?;

        let display = path.display().to_string();
        let mut store = self.store.lock().await;
        let workspace = store.update(|state| {
            state.workspaces.push(Workspace {
                id: new_workspace_id(),
                path: Some(display.clone()),
                title: name.clone(),
                collapsed: false,
                session_order: Vec::new(),
            });
            state.workspaces.last().cloned()
        });
        Ok(json!({"path": display, "workspace": workspace}))
    }

    /// Projects that already have sessions, most recently active first — the
    /// list a new-session dialog should offer before it offers a file browser.
    pub(crate) async fn recent_projects(&self) -> Result<Value, Value> {
        let listed = self
            .call("session.list", json!({"status": "all", "limit": 200}))
            .await?;
        let mut seen: Vec<(String, String)> = Vec::new();
        if let Some(sessions) = listed.get("sessions").and_then(Value::as_array) {
            for s in sessions {
                let Some(root) = s.get("project_root").and_then(Value::as_str) else {
                    continue;
                };
                let last = s
                    .get("last_active")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                match seen.iter_mut().find(|(r, _)| r == root) {
                    Some((_, at)) if *at < last => *at = last,
                    Some(_) => {}
                    None => seen.push((root.to_string(), last)),
                }
            }
        }
        seen.sort_by(|a, b| b.1.cmp(&a.1));
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string());
        Ok(json!({
            "cwd": cwd,
            "projects_root": self.projects_root.display().to_string(),
            "projects": seen.into_iter()
                .map(|(root, at)| json!({"project_root": root, "last_active": at}))
                .collect::<Vec<_>>(),
        }))
    }

    /// Hand out a one-shot upload URL. Attachments do not ride the WebSocket:
    /// the daemon's frame ceiling is 16 MiB and an image would sit right
    /// under it, so the file goes over HTTP and the turn references its path.
    pub(crate) async fn upload_begin(&self, params: Value) -> Result<Value, Value> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("upload.bin");
        let bytes = params.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
        if bytes > self.max_upload_bytes {
            return Err(json!({
                "code": codes::INVALID_PARAMS,
                "message": format!("file exceeds {} bytes", self.max_upload_bytes),
            }));
        }
        let token = new_id("u");
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = self.upload_dir.join(format!("{token}-{safe}"));
        self.inner
            .lock()
            .await
            .uploads
            .insert(token.clone(), path.clone());
        Ok(json!({
            "token": token,
            "url": format!("/upload?token={token}"),
            "path": path.display().to_string(),
        }))
    }

}
