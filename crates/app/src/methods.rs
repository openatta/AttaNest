//! The authorization table, in one place.
//!
//! Reading this file answers "what can a client call" without tracing
//! dispatch. Everything not named here is refused — the table is an
//! allow-list, so a new method is unreachable until someone writes it down
//! (§3.4).

use nest_authz::{MethodTable, Reach, ENGINE_REFUSALS};

pub fn table() -> MethodTable {
    let mut table = MethodTable::new()
        // The hub's own semantics. A device drives its sessions; a plugin
        // that wants any of these has to have declared it.
        .allow_all(nest_hub::HUB_METHODS, Reach::Device)
        // Engine methods that pass through untouched.
        .allow_all(nest_hub::PASSTHROUGH, Reach::Device)
        // Extension management is AttaCore's, and reaching it is this
        // person's to do. In a build carrying the script carrier these
        // answer `PLUGINS_DISABLED`, which is passed through as-is: "there
        // is no plugin subsystem here" is a different fact from "nothing is
        // installed".
        .allow_all(
            &["plugin.install", "plugin.uninstall", "plugin.enable", "plugin.disable", "plugin.reload"],
            Reach::Device,
        )
        // Interrupting, closing and deleting are intercepted by the hub but
        // are still the device's to ask for.
        .allow_all(&["session.interrupt", "session.close", "session.delete"], Reach::Device)
        // Nest's own methods, registered through the same registry the
        // interface's parts use.
        .allow_all(nest_builtin::METHODS, Reach::Device)
        // Pairing another device, and revoking one. This person's own
        // machines are this person's to manage.
        .allow_all(crate::devices::METHODS, Reach::Device);

    // Answered by the authorizer itself, and reachable by anyone that got
    // this far: a subject may always ask what it may do.
    table = table.allow(nest_authz::REACHABLE, Reach::Device);

    // Methods that exist and are refused, with the reason in the error.
    // Refused explicitly rather than by omission: "unknown method" would read
    // as a bug in Nest to whoever hit it, and these are deliberate.
    for (method, reason) in ENGINE_REFUSALS {
        table = table.allow(method, Reach::Refused(reason));
    }
    table
}

#[cfg(test)]
mod tests {
    use nest_contract::Subject;

    use super::*;

    fn device() -> Subject {
        Subject::Device { id: "test".into() }
    }

    /// The whole point of an allow-list: a name nobody wrote down is refused,
    /// and adding a method is a decision rather than an accident.
    #[test]
    fn an_unlisted_method_is_refused() {
        let table = table();
        assert!(!table.reachable(&device()).contains(&"session.somethingNew"));
    }

    /// The engine trusts whoever reaches its dispatch. These would hand that
    /// trust to a client (§3.4), so they are refused with a reason rather
    /// than left unimplemented.
    #[test]
    fn credential_and_endpoint_methods_are_refused() {
        let table = table();
        for (method, _) in ENGINE_REFUSALS {
            assert!(
                !table.reachable(&device()).contains(method),
                "{method} reachable by a device"
            );
        }
    }

    /// Installing an extension is this person's decision to make; what the
    /// extension may then do is the engine's to enforce (§4.4).
    #[test]
    fn extension_management_is_reachable_but_mcp_is_not() {
        let reachable = table().reachable(&device());
        for method in ["plugin.install", "plugin.uninstall", "plugin.enable", "plugin.disable"] {
            assert!(reachable.contains(&method), "{method} unreachable");
        }
        // Configures a subprocess-spawning tool with no manifest, no
        // capability declaration and no disclosure at all — a different
        // thing wearing a similar shape.
        assert!(!reachable.contains(&"mcp.addServer"));
    }
}
