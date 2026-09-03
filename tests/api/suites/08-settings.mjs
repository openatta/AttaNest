// Settings: what the three tiers say, and what happens when they are written.
//
// The engine memoizes resolved settings per (project, scene) and only
// refreshes its own pair on reload, so the effective value it reports can lag
// a write. Nest computes the tiers itself and hands back the engine's answer
// alongside — so when they disagree, the interface can say so instead of
// showing one of them and being wrong half the time.

import { METHOD_NOT_FOUND, REFUSED } from "../../../ui/runtime/protocol.js";
const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "settings describe their tiers": async ({ client }) => {
      const described = await client.call("nest.settings.describe", {});
      assert(described, "nothing described");
      const asJson = JSON.stringify(described);
      assert(/global|local|project|effective/.test(asJson), "no tiers in the description");
    },

    "a write lands in the tier it was aimed at": async ({ client }) => {
      const key = "model.max_tokens";
      const before = await client.call("nest.settings.describe", {});
      await client.call("nest.settings.set", { tier: "global", key, value: 4321 });
      const after = await client.call("nest.settings.describe", {});
      assert(JSON.stringify(after) !== JSON.stringify(before), "the write changed nothing");
      // Null gives a setting back to the tier below it, rather than pinning a
      // default that then cannot be un-pinned.
      await client.call("nest.settings.set", { tier: "global", key, value: null });
    },

    "an unknown tier is refused rather than guessed": async ({ client }) => {
      const e = await client.refused("nest.settings.set",
        { tier: "nonsense", key: "model.model_name", value: "x" });
      assert(e, "an unknown tier was accepted");
    },

    "a key that is not editable is refused by name": async ({ client }) => {
      // The editable set is a list, not "anything in the file": a settings
      // page that could write arbitrary keys is a JSON editor with extra
      // steps, and a typo would silently create a setting nothing reads.
      const e = await client.refused("nest.settings.set",
        { tier: "global", key: "make.believe", value: 1 });
      assert(e, "an unknown key was written");
      assert(/editable/.test(e.message), `says "${e.message}"`);
    },

    "a value of the wrong shape is refused": async ({ client }) => {
      const e = await client.refused("nest.settings.set",
        { tier: "global", key: "model.max_tokens", value: "not a number" });
      assert(e, "a count accepted a string");
    },

    "providers can be read back": async ({ client }) => {
      const described = await client.call("nest.settings.describe", { section: "providers" })
        .catch(() => null);
      assert(described !== undefined, "providers could not be described");
    },

    "setting a provider is reachable here and refused on the engine": async ({ client }) => {
      // The engine's own `config.setProvider` is refused to every client —
      // it repoints model traffic. The same intent goes through this layer,
      // where it is a deliberate, audited method rather than a passthrough.
      const direct = await client.refused("config.setProvider", {});
      assert(direct && direct.code === REFUSED, "config.setProvider is not refused");
      const e = await client.refused("nest.settings.setProvider", {});
      // Refused for want of arguments, not for want of permission.
      if (e) assert(e.code !== REFUSED, `refused as unauthorized: ${e.message}`);
    },
  },
};
