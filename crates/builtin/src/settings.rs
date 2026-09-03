//! The settings plane: read the three tiers, write one field into one tier.
//!
//! AttaCore exposes `config.get` (read, per tier, redacted) and
//! `config.reload`, but no generic write — the supported way to change a
//! setting is to edit the tier's `settings.json`, which is exactly what
//! `config.reload` exists for and what the engine's `WatchHub` already
//! watches. So Nest writes the file and asks the engine to re-read it.
//!
//! Two rules make that safe to expose to a browser:
//!
//! - **A whitelist, not a passthrough.** Only the fields in [`FIELDS`] can be
//!   written, each with a declared kind that the value is checked against. A
//!   settings file is a program's behaviour; "set any key to any JSON" is not
//!   a feature, it is a remote configuration channel.
//! - **Read, modify, write the whole file.** Hand edits and engine writes
//!   (`config.setProvider` writes the project tier) are preserved because the
//!   file is re-read immediately before each change, and replaced atomically.
//!
//! Credentials keep going through `config.setProvider`: it is the only code
//! that knows how to validate a provider and rebuild the router. Nest holds
//! it behind this surface rather than passing the method through, so the
//! allow-list stays the single authorization point.

use std::path::PathBuf;

use nest_contract::{codes, RpcError};
use serde_json::{json, Map, Value};

use crate::{require_str, Builtin};

/// What a field accepts. Anything else is refused before a file is touched.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Text,
    Count,
    Flag,
    Choice(&'static [&'static str]),
}

pub(crate) struct Field {
    /// Dotted path into settings.json.
    pub key: &'static str,
    pub kind: Kind,
}

/// The settings a person changes from a UI. Deliberately short: every entry
/// here is a promise that writing it does something predictable.
pub(crate) const FIELDS: &[Field] = &[
    Field { key: "model.model_name", kind: Kind::Text },
    Field { key: "model.max_tokens", kind: Kind::Count },
    Field {
        key: "permission_mode",
        kind: Kind::Choice(&["default", "acceptEdits", "plan", "bypassPermissions"]),
    },
    Field { key: "memory_enabled", kind: Kind::Flag },
    Field { key: "allow_client_permission_override", kind: Kind::Flag },
];

const TIERS: &[&str] = &["global", "scene", "project"];

impl Builtin {
    /// Every editable field, its effective value, and where each tier stands.
    pub(crate) async fn settings_describe(&self, params: Value) -> Result<Value, RpcError> {
        // `config.get` needs a scene and refuses without one. Falling back to
        // the engine's own default rather than sending a request that cannot
        // succeed: a settings page opened with no session is the ordinary
        // case, and it used to answer every field `null` — a write made and
        // then read back as nothing, with the error swallowed on the way.
        let scene = params
            .get("scene")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.hub.engine().active_scenes.first().cloned());
        let project_root = params
            .get("project_root")
            .and_then(Value::as_str)
            .map(str::to_string);

        let mut raw = Map::new();
        let mut problems: Vec<Value> = Vec::new();
        for tier in TIERS {
            let mut request = json!({"tier": tier});
            if let Some(scene) = &scene {
                request["scene"] = json!(scene);
            }
            if let Some(root) = &project_root {
                request["project_root"] = json!(root);
            }
            // A tier that genuinely has no file answers `null`; a call that
            // *failed* is a different thing and is reported rather than
            // flattened into the same answer. The two used to be
            // indistinguishable, which is how a page of nulls looked like an
            // empty configuration instead of a broken request.
            let settings = match self.hub.engine_call("config.get", request).await {
                Ok(value) => value.get("settings").cloned().unwrap_or(Value::Null),
                Err(e) => {
                    tracing::warn!(tier, error = %e.message, "settings tier could not be read");
                    problems.push(json!({"tier": tier, "error": e.message}));
                    Value::Null
                }
            };
            raw.insert((*tier).to_string(), settings);
        }

        let mut effective_request = json!({"tier": "effective"});
        if let Some(scene) = &scene {
            effective_request["scene"] = json!(scene);
        }
        if let Some(root) = &project_root {
            effective_request["project_root"] = json!(root);
        }
        let effective = self
            .hub.engine_call("config.get", effective_request)
            .await
            .ok()
            .and_then(|value| value.get("settings").cloned())
            .unwrap_or(Value::Null);

        let fields: Vec<Value> = FIELDS
            .iter()
            .map(|field| {
                let per_tier: Map<String, Value> = TIERS
                    .iter()
                    .map(|tier| {
                        let value = raw
                            .get(*tier)
                            .and_then(|settings| dig(settings, field.key))
                            .cloned()
                            .unwrap_or(Value::Null);
                        ((*tier).to_string(), value)
                    })
                    .collect();

                // What the files say, highest tier wins. Computed here rather
                // than taken from `config.get {tier:"effective"}` because that
                // answer is memoized per (project, scene) and
                // `apply_reloaded_settings` only swaps the pool's own pair —
                // so for every other pair it keeps serving the value from
                // before the reload, and a settings page that showed it would
                // report that a write it just made did nothing. The engine's
                // own answer rides along as `engine` for diagnostics.
                let (source, from_files) = TIERS
                    .iter()
                    .rev()
                    .find_map(|tier| {
                        per_tier
                            .get(*tier)
                            .filter(|value| !value.is_null())
                            .map(|value| (json!(tier), value.clone()))
                    })
                    .unwrap_or((Value::Null, Value::Null));

                json!({
                    "key": field.key,
                    "kind": kind_name(field.kind),
                    "options": match field.kind {
                        Kind::Choice(options) => json!(options),
                        _ => Value::Null,
                    },
                    "effective": from_files,
                    "source": source,
                    "engine": dig(&effective, field.key).cloned().unwrap_or(Value::Null),
                    "tiers": per_tier,
                })
            })
            .collect();

        let providers = self
            .hub.engine_call("config.getProvider", json!({}))
            .await
            .unwrap_or(json!({}));

        Ok(json!({
            "fields": fields,
            "scene": scene,
            // Empty in the ordinary case. Not empty means a tier could not be
            // read, and the page can say so instead of showing its nulls as
            // if they were the configuration.
            "problems": problems,
            "paths": {
                "global": self.tier_path("global", scene.as_deref(), project_root.as_deref())
                    .map(|p| p.display().to_string()),
                "scene": self.tier_path("scene", scene.as_deref(), project_root.as_deref())
                    .map(|p| p.display().to_string()),
                "project": self.tier_path("project", scene.as_deref(), project_root.as_deref())
                    .map(|p| p.display().to_string()),
            },
            "providers": providers,
        }))
    }

    /// Write one whitelisted field into one tier, then make the engine re-read.
    ///
    /// A `null` value removes the key, which is how a tier gives a setting
    /// back to the tier below it.
    pub(crate) async fn settings_set(&self, params: Value) -> Result<Value, RpcError> {
        let tier = require_str(&params, "tier")?;
        let key = require_str(&params, "key")?;
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        // The same default as `describe`, for the same reason: a write with
        // no scene would otherwise resolve no tier path and be refused for a
        // reason that has nothing to do with what was asked.
        let default_scene = self.hub.engine().active_scenes.first().cloned();
        let scene = params
            .get("scene")
            .and_then(Value::as_str)
            .or(default_scene.as_deref());
        let project_root = params.get("project_root").and_then(Value::as_str);

        let Some(field) = FIELDS.iter().find(|f| f.key == key) else {
            return Err(RpcError::new(codes::INVALID_PARAMS, format!("`{key}` is not an editable setting")));
        };
        if !value.is_null() && !accepts(field.kind, &value) {
            return Err(RpcError::new(codes::INVALID_PARAMS, format!("`{key}` does not accept that value")));
        }
        let Some(path) = self.tier_path(&tier, scene, project_root) else {
            return Err(RpcError::new(codes::INVALID_PARAMS, format!("no `{tier}` tier for this session")));
        };

        // Read-modify-write the whole file: a hand edit or an engine write
        // (`config.setProvider` owns the project tier) must survive this.
        let mut document: Value = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                RpcError::new(codes::INTERNAL_ERROR, format!("{} is not valid JSON: {e}", path.display()))
            })?,
            Err(_) => json!({}),
        };
        set_path(&mut document, &key, value);

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        let temp = path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&document).map_err(|e| {
            RpcError::new(codes::INTERNAL_ERROR, e.to_string())
        })?;
        std::fs::write(&temp, &body)
            .and_then(|()| std::fs::rename(&temp, &path))
            .map_err(io_error)?;

        let reloaded = self.hub.engine_call("config.reload", json!({})).await.is_ok();
        let mut describe = self.settings_describe(params.clone()).await?;
        if let Some(object) = describe.as_object_mut() {
            object.insert("written".into(), json!(path.display().to_string()));
            object.insert("reloaded".into(), json!(reloaded));
        }
        Ok(describe)
    }

    /// Add, edit or remove a provider — credentials included.
    ///
    /// Held here rather than passed through: `config.setProvider` trusts its
    /// caller completely (it can point every later model request at another
    /// host), so it stays behind Nest's allow-list with one deliberate entry.
    pub(crate) async fn settings_set_provider(&self, params: Value) -> Result<Value, RpcError> {
        let provider_id = require_str(&params, "provider_id")?;
        let mut request = json!({"provider_id": provider_id});
        for key in ["config", "default_provider", "task_models", "delete"] {
            if let Some(value) = params.get(key) {
                request[key] = value.clone();
            }
        }
        let result = self.hub.engine_call("config.setProvider", request).await?;
        let providers = self
            .hub.engine_call("config.getProvider", json!({}))
            .await
            .unwrap_or(json!({}));
        Ok(json!({"result": result, "providers": providers}))
    }

    /// The settings.json a tier writes to, if that tier exists here.
    fn tier_path(
        &self,
        tier: &str,
        scene: Option<&str>,
        project_root: Option<&str>,
    ) -> Option<PathBuf> {
        let root = &self.hub.engine().data_root;
        match tier {
            "global" => Some(root.join("settings.json")),
            "scene" => scene.map(|scene| root.join("scenes").join(scene).join("settings.json")),
            "project" => project_root.map(|p| PathBuf::from(p).join(".atta").join("settings.json")),
            _ => None,
        }
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Text => "text",
        Kind::Count => "count",
        Kind::Flag => "flag",
        Kind::Choice(_) => "choice",
    }
}

fn accepts(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Text => value.as_str().is_some_and(|s| !s.trim().is_empty()),
        Kind::Count => value.as_u64().is_some_and(|n| n > 0 && n <= 1_000_000),
        Kind::Flag => value.is_boolean(),
        Kind::Choice(options) => value.as_str().is_some_and(|s| options.contains(&s)),
    }
}

/// Read a dotted path out of a settings document.
fn dig<'a>(document: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cursor = document;
    for segment in key.split('.') {
        cursor = cursor.get(segment)?;
    }
    Some(cursor)
}

/// Write a dotted path into a settings document, creating objects on the way
/// and removing the key when the value is null.
fn set_path(document: &mut Value, key: &str, value: Value) {
    let segments: Vec<&str> = key.split('.').collect();
    if !document.is_object() {
        *document = json!({});
    }
    let mut cursor = document;
    for segment in &segments[..segments.len() - 1] {
        if !cursor.get(*segment).map(Value::is_object).unwrap_or(false) {
            cursor[*segment] = json!({});
        }
        cursor = cursor.get_mut(*segment).expect("just inserted");
    }
    let last = segments[segments.len() - 1];
    match value {
        Value::Null => {
            if let Some(object) = cursor.as_object_mut() {
                object.remove(last);
            }
        }
        value => cursor[last] = value,
    }
}

fn io_error(e: std::io::Error) -> RpcError {
    RpcError::new(codes::INTERNAL_ERROR, format!("could not write: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nested_write_creates_its_parents_and_keeps_siblings() {
        let mut document = json!({"model": {"max_tokens": 2000}, "memory_enabled": true});
        set_path(&mut document, "model.model_name", json!("deepseek-v4"));
        assert_eq!(document["model"]["model_name"], json!("deepseek-v4"));
        assert_eq!(document["model"]["max_tokens"], json!(2000));
        assert_eq!(document["memory_enabled"], json!(true));
    }

    #[test]
    fn null_gives_the_setting_back_to_the_tier_below() {
        let mut document = json!({"permission_mode": "plan"});
        set_path(&mut document, "permission_mode", Value::Null);
        assert!(document.get("permission_mode").is_none());
    }

    #[test]
    fn kinds_refuse_what_they_do_not_mean() {
        assert!(accepts(Kind::Count, &json!(4000)));
        assert!(!accepts(Kind::Count, &json!(0)));
        assert!(!accepts(Kind::Count, &json!("4000")));
        assert!(accepts(Kind::Choice(&["plan"]), &json!("plan")));
        assert!(!accepts(Kind::Choice(&["plan"]), &json!("yolo")));
        assert!(!accepts(Kind::Text, &json!("   ")));
    }
}
