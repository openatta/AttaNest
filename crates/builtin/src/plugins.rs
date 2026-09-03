//! Uploading a package, and asking AttaCore to install it.
//!
//! **Nest has no plugin system.** Writing a plugin for Nest is writing a
//! plugin for AttaCore: its manifest, its capability gate, its sandbox, its
//! disclosure, its lifecycle. Nest neither reads a package nor runs one, and
//! never sees what is inside — anything here that parsed a manifest would be
//! a second truth about what an extension may do, and the two would diverge.
//!
//! What is left for a host to do is the one thing AttaCore deliberately does
//! not: **receive a file.** `plugin.install` fetches from a URL it is given
//! and has no upload channel, so a person with a `.zip` on their laptop and a
//! backend on another machine has no way across. That gap is this file.
//!
//! ```text
//!   browser --- POST /upload ------> nest            the bulk semantic
//!   browser --- nest.plugins.install --> nest
//!                                    nest --- plugin.install{download_url:
//!                                             "file:///…"} ---> AttaCore
//! ```
//!
//! # Disclosure comes back, not first
//!
//! AttaCore installs and *then* returns what the package will put in front of
//! the model. That is the opposite order from disclose-then-decide, and it is
//! the engine's order, so it is the one the interface shows: installed, here
//! is what it will say to the model, keep it or remove it. Inventing a
//! pre-install inspection on this side would mean reading the package here,
//! which is the thing this file exists not to do.
//!
//! # A build can still be one nothing installs into
//!
//! The package layer — manifest, fetch, checksum, unpack, disclosure,
//! lifecycle — is exclusive with nothing upstream and is in the shipped
//! build, so packages install here. A build made without it answers
//! `PLUGINS_DISABLED`, and these methods pass that through unchanged rather
//! than dressing it up as an empty list: "there is no plugin subsystem here"
//! and "no plugins are installed" are different facts, and a client that
//! cannot tell them apart shows the wrong screen.

use nest_contract::RpcError;
use serde_json::{json, Value};

use crate::{new_id, packages, require_str, Builtin};

/// Ceiling on an uploaded package.
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

impl Builtin {
    /// A one-shot URL to PUT a `.zip` at. The grant is spent on use.
    pub(crate) async fn plugins_upload(&self, params: Value) -> Result<Value, RpcError> {
        let name = require_str(&params, "name")?;
        let token = new_id("pkg");
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = self.upload_dir().join(format!("{token}-{safe}"));
        self.uploads.lock().await.insert(token.clone(), (path.clone(), MAX_PACKAGE_BYTES));
        Ok(json!({
            "token": token,
            "url": format!("/upload?token={token}"),
            "path": path.display().to_string(),
            "max_bytes": MAX_PACKAGE_BYTES,
        }))
    }

    /// What is installed, and what of it reaches this side.
    ///
    /// The engine's list, plus the one section it ignores. One call, because
    /// "what is installed" and "what will appear in my interface" are the
    /// same question asked by the same screen.
    pub(crate) async fn plugins_list(&self, _params: Value) -> Result<Value, RpcError> {
        match self.hub.engine_call("plugin.list", json!({})).await {
            Ok(value) => Ok(json!({
                "plugins": value.get("plugins").cloned().unwrap_or(json!([])),
                "contributes": packages::read_all(&value),
                "available": true,
            })),
            // Not an empty list. "This build carries no plugin subsystem" and
            // "nothing is installed" are different facts, and a client that
            // cannot tell them apart sends someone looking for a package that
            // could never load (§4.5).
            Err(e) => Ok(json!({
                "plugins": [],
                "contributes": [],
                "available": false,
                "reason": e.message,
            })),
        }
    }

    /// Hand AttaCore a local path and let it do the rest.
    ///
    /// The `checksum` is passed through when given. AttaCore requires one for
    /// `http(s)` sources and allows it to be omitted for `file://`, and that
    /// rule is the engine's to enforce — repeating it here would be a second
    /// copy of a policy that can change.
    pub(crate) async fn plugins_install(&self, params: Value) -> Result<Value, RpcError> {
        let path = require_str(&params, "path")?;
        let mut request = json!({
            "name": params.get("name").cloned().unwrap_or(Value::Null),
            "version": params.get("version").cloned().unwrap_or(Value::Null),
            "download_url": format!("file://{path}"),
        });
        for key in ["checksum", "scope"] {
            if let Some(value) = params.get(key) {
                request[key] = value.clone();
            }
        }
        let result = self.hub.engine_call("plugin.install", request).await?;
        // The package is on disk now, so what it contributes is knowable now.
        // A package that needed a reload to appear is a package nobody will
        // believe installed.
        self.refresh().await;
        Ok(result)
    }

    /// Hand a lifecycle call to the engine, then re-read what is installed.
    ///
    /// The engine owns enable, disable, uninstall and reload; nothing is
    /// decided here and no parameter is invented. What the host adds is the
    /// step after: it serves each package's `ui/` directory and publishes the
    /// contribution set, so a call that changes what is installed has to be
    /// followed by re-reading it. Passing `plugin.*` straight through would
    /// leave a disabled package's module still being served, and a client
    /// with no way to notice.
    pub(crate) async fn plugins_manage(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let result = self.hub.engine_call(method, params).await?;
        self.refresh().await;
        Ok(result)
    }

    /// Re-read what is installed, and tell whoever is serving it.
    ///
    /// The static face and the hello payload are both downstream of this, and
    /// both are held by the app — which is the layer that owns them. So this
    /// calls back rather than reaching up.
    pub async fn refresh(&self) {
        if let Some(on_change) = self.on_packages_changed.lock().await.as_ref() {
            on_change(packages::discover(&self.hub).await);
        }
    }
}
