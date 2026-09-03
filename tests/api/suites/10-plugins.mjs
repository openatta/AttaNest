// Extensions belong to AttaCore. What Nest adds is the one step the engine
// deliberately does not take: receiving a file.
//
// This build carries the script carrier, and the two carriers are mutually
// exclusive upstream, so every `plugin.*` call answers PLUGINS_DISABLED. That
// is the behaviour under test — "this build has no plugin subsystem" and
// "nothing is installed" are different facts, and the second one would send
// somebody looking for a package that could never load.

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "the engine says it carries no plugin subsystem, rather than showing an empty list":
      async ({ client }) => {
        const e = await client.refused("plugin.list");
        assert(e, "plugin.list returned a list in a build with no plugin carrier");
        assert(/unavailable|disabled/i.test(e.message), `says "${e.message}"`);
      },

    "an upload grant for a package is issued": async ({ client }) => {
      const grant = await client.call("nest.plugins.upload", { name: "example.zip" });
      assert(grant.url.includes("token="), `url is ${grant.url}`);
      assert(grant.path.endsWith("example.zip"), `path is ${grant.path}`);
      assert(grant.max_bytes > 0, "no ceiling on a package");
    },

    "installing passes straight through to the engine": async ({ client }) => {
      const grant = await client.call("nest.plugins.upload", { name: "x.zip" });
      const e = await client.refused("nest.plugins.install",
        { path: grant.path, name: "x", version: "1.0.0" });
      // The engine refuses because it has no plugin subsystem — which is the
      // right refusal, arriving from the right place.
      assert(e, "installing succeeded in a build with no plugin carrier");
      assert(/unavailable|disabled/i.test(e.message), `says "${e.message}"`);
    },

    "the list says whether there is a plugin subsystem at all": async ({ client }) => {
      // Not an error, and not an empty list either. A client has to be able
      // to tell "this build carries no plugin subsystem" from "nothing is
      // installed", or it sends somebody looking for a package that could
      // never load.
      const result = await client.call("nest.plugins.list");
      assert("available" in result, "the list does not say whether packages are possible");
      assert(Array.isArray(result.plugins), "no plugin list");
      assert(Array.isArray(result.contributes), "no contribution list");
      if (!result.available) {
        assert(result.reason, "unavailable, and no reason given");
        assert(result.plugins.length === 0, "unavailable but something is listed");
      }
    },

    "a package's interface module is not reachable before one is installed":
      async ({ backend }) => {
        const response = await fetch(
          `http://127.0.0.1:${backend.port}/plugins/nothing-installed/ui/x.js`);
        assert(response.status === 404, `status ${response.status}`);
      },

    "management calls reach the engine rather than being refused here": async ({ client }) => {
      for (const method of ["plugin.enable", "plugin.disable", "plugin.uninstall",
                            "plugin.reload", "plugin.install"]) {
        const e = await client.refused(method, { name: "nothing" });
        assert(e, `${method} answered`);
        // -32000 would mean this layer refused it. Anything else means it
        // reached the engine, which is what should happen.
        assert(e.code !== -32000, `${method} was refused by the host: ${e.message}`);
      }
    },
  },
};
