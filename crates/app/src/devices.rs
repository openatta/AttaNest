//! `nest.devices.*` — pairing, listing, revoking.
//!
//! Registered by the app rather than by `nest-builtin`, because these are the
//! authorization layer's data and this is the layer that owns both it and the
//! transport whose channels a revocation has to end. Putting them in the
//! built-ins would give that crate a reason to depend on authorization, for
//! one feature, and dependency edges are cheaper not to add.

use std::sync::Arc;
use std::time::SystemTime;

use nest_authz::{Devices, PairError};
use nest_contract::{RpcError, Subject};
use nest_contrib::registry::Owner;
use nest_contrib::{HostMethod, Registry};
use serde_json::{json, Value};

pub const METHODS: &[&str] = &[
    "nest.devices.list",
    "nest.devices.pair.begin",
    "nest.devices.pair.complete",
    "nest.devices.revoke",
];

/// Characters a pairing code is drawn from.
///
/// No `0`/`O`, no `1`/`I`/`l`: the code is read off one screen and typed into
/// another, and the two most common ways that goes wrong are worth designing
/// out rather than apologising for.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN: usize = 8;

pub struct DeviceMethods {
    devices: Arc<Devices>,
    /// Ending a revoked device's channels. The authorization layer knows a
    /// credential belongs to a subject; only transport knows there are
    /// connections carrying it.
    disconnect: Arc<dyn Fn(&str) + Send + Sync>,
    name: &'static str,
}

pub fn register(
    registry: &mut Registry,
    devices: Arc<Devices>,
    disconnect: Arc<dyn Fn(&str) + Send + Sync>,
) {
    for name in METHODS {
        let entry = Arc::new(DeviceMethods {
            devices: devices.clone(),
            disconnect: disconnect.clone(),
            name,
        });
        if let Err(reason) = registry.method(*name, Owner::Builtin, entry) {
            tracing::error!(method = name, %reason, "device method not registered");
        }
    }
}

#[async_trait::async_trait]
impl HostMethod for DeviceMethods {
    async fn call(&self, _subject: &Subject, params: Value) -> Result<Value, RpcError> {
        let now = SystemTime::now();
        self.devices.sweep(now);
        match self.name {
            "nest.devices.list" => Ok(json!({"devices": self.devices.list()})),

            "nest.devices.pair.begin" => {
                let label = params
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("device")
                    .to_string();
                let code = pairing_code();
                let handle = self.devices.begin_pairing(&code, label, now);
                // The code is returned once, to be shown once. Only its hash
                // is kept, so this is the only moment it exists in the clear.
                Ok(json!({
                    "handle": handle,
                    "code": code,
                    "expires_in_secs": nest_authz::PAIRING_TTL.as_secs(),
                }))
            }

            "nest.devices.pair.complete" => {
                let code = require(&params, "code")?;
                let public_key = require(&params, "public_key")?;
                let stamp = stamp(now);
                match self.devices.complete_pairing(&code, &public_key, now, &stamp) {
                    Ok(device) => Ok(json!({"device": device})),
                    // One error for "no such code", "expired" and "already
                    // used": telling them apart tells a guesser which guesses
                    // were closer.
                    Err(e @ (PairError::Refused | PairError::TooManyAttempts)) => {
                        Err(RpcError::refused(e.to_string()))
                    }
                }
            }

            "nest.devices.revoke" => {
                let id = require(&params, "device_id")?;
                let removed = self.devices.revoke(&id);
                // Immediately, and all of its channels — a credential belongs
                // to the subject, not to a connection, so there is no such
                // thing as revoking one of them (§3.3.3, item 2).
                if removed {
                    (self.disconnect)(&id);
                }
                Ok(json!({"revoked": removed}))
            }

            other => Err(RpcError::not_found(format!("`{other}` is not a device method"))),
        }
    }
}

fn require(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("missing {key}")))
}

/// Mint a code and say it on the console.
///
/// The bootstrap problem, answered: pairing is a method, methods need
/// admission, and a reachable listener admits nobody until a device is
/// paired. Something has to break the circle, and the honest place is the
/// console of the process that was just started — whoever started it is
/// there, and nobody else is.
///
/// Only when there are no devices yet. A node with a paired device already
/// has a way to pair the next one, and printing a code every restart would
/// leave a standing door in the scrollback.
pub fn bootstrap(devices: &Devices, reachable: bool) {
    if !reachable || !devices.list().is_empty() {
        return;
    }
    let code = pairing_code();
    let now = SystemTime::now();
    devices.begin_pairing(&code, "first device", now);
    let minutes = nest_authz::PAIRING_TTL.as_secs() / 60;
    println!(
        "  no device is paired yet, and this listener is reachable.\n\
         \n\
         \x20   pairing code → {code}     (valid {minutes} minutes, one use)\n\
         \n\
         \x20 Enter it on the device you want to use this from.\n"
    );
}

fn pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4();
    bytes
        .as_bytes()
        .iter()
        .take(CODE_LEN)
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

fn stamp(now: SystemTime) -> String {
    now.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two ways reading a code off a screen goes wrong, designed out.
    #[test]
    fn a_pairing_code_has_no_ambiguous_characters() {
        for _ in 0..200 {
            let code = pairing_code();
            assert_eq!(code.len(), CODE_LEN);
            for c in code.chars() {
                assert!(!"01OIl".contains(c), "`{code}` contains an ambiguous character");
            }
        }
    }
}
