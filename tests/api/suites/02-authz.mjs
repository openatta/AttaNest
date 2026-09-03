// The one admission point.
//
// Everything not written down is refused, and everything refused says why.
// "Unknown method" and "you may not" are different answers: a client that
// cannot tell them apart reports the wrong bug.

import { METHOD_NOT_FOUND, REFUSED } from "../../../ui/runtime/protocol.js";
const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "a subject can ask what it may call": async ({ client }) => {
      const { methods, subject } = await client.call("nest.reachable");
      assert(Array.isArray(methods) && methods.length > 20, `${methods?.length} methods`);
      assert(subject.kind === "device", `subject is ${subject.kind}`);
      assert(methods.includes("nest.send"), "nest.send is not reachable");
    },

    "an unlisted method is not found": async ({ client }) => {
      const e = await client.refused("nest.noSuchThing");
      assert(e, "an unlisted method answered");
      assert(e.code === METHOD_NOT_FOUND, `code ${e.code}`);
    },

    "credential and endpoint methods are refused with a reason": async ({ client }) => {
      for (const method of ["config.setProvider", "config.set", "daemon.shutdown", "import.run"]) {
        const e = await client.refused(method, {});
        assert(e, `${method} was allowed`);
        // Refused, not merely absent — the distinction is the whole point.
        assert(e.code === REFUSED, `${method}: code ${e.code}`);
        assert(e.message.length > 20, `${method}: no reason given`);
      }
    },

    "the hub's own semantics are not reachable around it": async ({ client }) => {
      for (const [method, expect] of [
        ["session.run_turn", /nest\.send/],
        ["session.subscribe", /nest\.attach/],
        ["session.unsubscribe", /nest\.detach/],
        ["daemon.subscribeEvents", /host events/i],
      ]) {
        const e = await client.refused(method, {});
        assert(e, `${method} was allowed`);
        assert(expect.test(e.message), `${method}: says "${e.message}"`);
      }
    },

    "adding an MCP server stays refused while installing a plugin does not": async ({ client }) => {
      // Installing a package is this person's decision: it arrives with a
      // manifest, a capability declaration and a disclosure. Adding an MCP
      // server configures a subprocess-spawning tool with none of the three,
      // so it is refused here and named in the reason.
      const mcp = await client.refused("mcp.addServer", {});
      assert(mcp && mcp.code === REFUSED, "mcp.addServer is not refused");

      const { methods } = await client.call("nest.reachable");
      for (const method of ["nest.plugins.install", "nest.plugins.list"]) {
        assert(methods.includes(method), `${method} is not reachable`);
      }
    },

    "what did not take is queryable": async ({ client }) => {
      const { methods, refused } = await client.call("nest.contributions");
      assert(methods.length > 15, `${methods.length} registered`);
      assert(Array.isArray(refused), "no refusal list");
    },
  },
};
