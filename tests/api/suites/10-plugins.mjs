// Extensions belong to AttaCore. What Nest adds is the one step the engine
// deliberately does not take: receiving a file.
//
// The shipped build carries the package layer, so these calls reach a working
// installer rather than a refusal. What is under test is that they *reach* it
// — that the host carries the file across, passes the call through, and reads
// back the one section the engine ignores. Whether the engine then installs
// correctly is the engine's own test suite's business.
//
// `tests/package-e2e.mjs` runs the whole path with a real package.

import { METHOD_NOT_FOUND, REFUSED } from "../../../ui/runtime/protocol.js";
const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "the shipped build can install packages": async ({ client }) => {
      // The engine's own list, asked directly: it is read-only, so it stays
      // reachable where the lifecycle calls do not. A build without the
      // package layer refuses this one instead of answering.
      const listed = await client.call("plugin.list");
      assert(Array.isArray(listed.plugins), "plugin.list answered without a list");

      const result = await client.call("nest.plugins.list");
      assert(result.available, `packages unavailable: ${result.reason}`);
      assert(Array.isArray(result.plugins), "no plugin list");
    },

    "an upload grant for a package is issued": async ({ client }) => {
      const grant = await client.call("nest.plugins.upload", { name: "example.zip" });
      assert(grant.url.includes("token="), `url is ${grant.url}`);
      assert(grant.path.endsWith("example.zip"), `path is ${grant.path}`);
      assert(grant.max_bytes > 0, "no ceiling on a package");
    },

    "installing passes straight through to the engine": async ({ client }) => {
      const grant = await client.call("nest.plugins.upload", { name: "x.zip" });
      // Nothing was ever PUT at that grant, so the engine has no file to
      // install. The refusal is the engine's, arriving from the engine — the
      // host neither anticipates it nor dresses it up.
      const e = await client.refused("nest.plugins.install",
        { path: grant.path, name: "x", version: "1.0.0" });
      assert(e, "installing a file that does not exist succeeded");
      assert(e.code !== REFUSED, `refused by the host rather than the engine: ${e.message}`);
    },

    "the list says whether there is a plugin subsystem at all": async ({ client }) => {
      // Not an error, and not an empty list either. A build made without the
      // package layer has to be distinguishable from one with nothing
      // installed, or a client sends somebody looking for a package that
      // could never load.
      const result = await client.call("nest.plugins.list");
      assert("available" in result, "the list does not say whether packages are possible");
      assert(Array.isArray(result.plugins), "no plugin list");
      assert(Array.isArray(result.contributes), "no contribution list");
      if (!result.available) {
        assert(result.reason, "unavailable, and no reason given");
        assert(result.plugins.length === 0, "unavailable but something is listed");
      }
    },

    "what a package contributes is read from the root the engine reports":
      async ({ client }) => {
        // Nest composes no path of its own, so every contribution here is
        // anchored to a directory the engine named. Nothing is installed in
        // this fixture, which is exactly the state where a host that derived
        // its own paths would still happily report finds.
        const result = await client.call("nest.plugins.list");
        for (const c of result.contributes) {
          const listed = result.plugins.find((p) => p.name === c.plugin);
          assert(listed, `${c.plugin} contributes but is not installed`);
          assert(c.root === listed.root, `${c.plugin} read from ${c.root}, engine says ${listed.root}`);
        }
      },

    "a package's interface module is not reachable before one is installed":
      async ({ backend }) => {
        const response = await fetch(
          `http://127.0.0.1:${backend.port}/plugins/nothing-installed/ui/x.js`);
        assert(response.status === 404, `status ${response.status}`);
      },

    "management calls reach the engine rather than stopping here": async ({ client }) => {
      // Whether the engine minds being asked about a package that is not
      // installed is the engine's business. What is checked here is that the
      // call arrives — METHOD_NOT_FOUND would mean nothing routes it, which is how four
      // dead management calls once sat behind a screen nobody could reach.
      for (const method of ["nest.plugins.enable", "nest.plugins.disable",
                            "nest.plugins.uninstall"]) {
        const e = await client.refused(method, { name: "nothing-is-installed" });
        if (e) {
          assert(e.code !== METHOD_NOT_FOUND, `${method} routes nowhere`);
          assert(e.code !== REFUSED, `${method} was refused by the host: ${e.message}`);
        }
      }
      const reloaded = await client.call("nest.plugins.reload");
      assert(Array.isArray(reloaded.plugins), "reload answered without a list");
    },

    "the engine's own lifecycle names are not reachable around the host":
      async ({ client }) => {
        // Reaching `plugin.disable` directly would disable a package while
        // Nest went on serving its interface module — the host has to be the
        // one told, because the host is what is serving.
        for (const method of ["plugin.enable", "plugin.disable", "plugin.uninstall",
                              "plugin.install", "plugin.reload"]) {
          const e = await client.refused(method, { name: "nothing" });
          assert(e, `${method} answered`);
        }
      },
  },
};
