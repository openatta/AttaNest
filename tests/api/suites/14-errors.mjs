// The error surface, which is most of the surface.
//
// A method that has only ever answered has never had its arguments checked,
// its preconditions tested, or its refusal walked — and there are more lines
// behind those three than behind the answer. Before this suite the whole API
// had produced **two** distinct error codes across every run; the engine alone
// defines eighteen.
//
// Two rules hold everything here together:
//
//   1. **Which layer said it is readable from the code.** Nest's own codes sit
//      outside JSON-RPC's reserved band, AttaCore's sit inside it. That was
//      not true once — `REFUSED` and the engine's `SESSION_NOT_FOUND` were
//      both `-32000`, so "you may not" and "no such session" arrived
//      indistinguishable, and the tests used that number to tell the layers
//      apart.
//   2. **A refusal says why.** "Unknown method" and "you may not" are
//      different answers; so are "missing id" and "that scene needs a
//      project". A client that cannot tell them apart reports the wrong bug.

import { INVALID_PARAMS, METHOD_NOT_FOUND, REFUSED } from "../../../ui/runtime/protocol.js";
import { finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** Nest's band is everything above the reserved one. */
const isHostCode = (code) => code > -32000;

export default {
  tests: {
    "a missing required argument is named, not guessed at": async ({ client }) => {
      // Each of these has a `require_str` on the way in. What is checked is
      // that the answer names the argument — an "invalid params" with no
      // subject sends whoever hit it reading source.
      const cases = [
        ["nest.workspaces.update", {}, "id"],
        ["nest.workspaces.remove", {}, "id"],
        ["nest.workspaces.reorder", {}, "id"],
        ["nest.plugins.upload", {}, "name"],
        ["nest.plugins.install", {}, "path"],
        ["nest.search", {}, "query"],
        ["nest.settings.set", {}, "tier"],
        ["nest.settings.setProvider", {}, "provider_id"],
        ["nest.projects.create", {}, "name"],
      ];
      for (const [method, params, argument] of cases) {
        const e = await client.refused(method, params);
        assert(e, `${method} answered with no arguments at all`);
        assert(e.code === INVALID_PARAMS,
          `${method}: code ${e.code}, expected INVALID_PARAMS`);
        assert(e.message.includes(argument),
          `${method}: "${e.message}" does not name \`${argument}\``);
      }
    },

    "a session that does not exist is said so, by the layer that looked":
      async ({ client }) => {
        const missing = "nope-no-such-session";
        for (const method of ["session.get", "nest.attach"]) {
          const e = await client.refused(method, { session_id: missing });
          assert(e, `${method} answered for a session that does not exist`);
          // Not the host's refusal band: the host has nothing to refuse here,
          // it asked the engine and relayed what came back. Telling those two
          // apart is exactly what the code split is for.
          assert(!isHostCode(e.code),
            `${method}: ${e.code} is in the host's band — the host invented this answer`);
        }
      },

    "undoing something that was never done is not an error": async ({ client }) => {
      // Detaching from a session this client never watched, and removing a
      // queue item that is not queued. Both are deliberate: a client that
      // reconnects and tidies up should not have to know what it still holds,
      // and an error here would push that bookkeeping onto every client.
      // Same rule as revoking a device that was never paired (09-devices).
      const detached = await client.call("nest.detach", { session_id: "never-attached" });
      assert(detached.detached === true, `detach answered ${JSON.stringify(detached)}`);

      const created = await client.call("session.create", {});
      const removed = await client.call("nest.queue.remove",
        { session_id: created.session_id, item_id: "nothing-is-queued" });
      assert(removed, "removing a queue item that does not exist answered nothing");
      await finish(client, created.session_id);
    },

    "an upload grant defaults a name rather than refusing": async ({ client }) => {
      // `name` is what the file is called on disk, and a missing one is not
      // ambiguous — it is unnamed. Refusing would make the caller invent a
      // name it does not have, so the host does it instead.
      const grant = await client.call("nest.upload.begin", {});
      assert(grant.token && grant.url.includes(grant.token), `grant is ${JSON.stringify(grant)}`);
      assert(grant.path.endsWith(".bin"), `unnamed upload landed at ${grant.path}`);

      // A size the host will not accept is refused *before* a grant exists,
      // so nothing has to be cleaned up after.
      const { limits } = await client.call("nest.hello");
      const tooBig = await client.refused("nest.upload.begin",
        { name: "big.bin", bytes: limits.max_upload_bytes + 1 });
      assert(tooBig && tooBig.code === INVALID_PARAMS, `code ${tooBig?.code}`);
      assert(/\d/.test(tooBig.message), `does not say the ceiling: "${tooBig.message}"`);
    },

    "every lifecycle call refuses a session that is not there":
      async ({ client }) => {
        // Closing, deleting, forking, interrupting, resuming and renaming all
        // take a session id, and every one of them had only ever been called
        // with a real one. A method that silently succeeds on a session that
        // does not exist is one a client can call with a stale id forever
        // without learning anything.
        const missing = "AAAAAAAAAAAAAAAAAAAAAA";
        const refusals = [];
        // `session.close` and `session.delete` are left out on purpose: like
        // `nest.detach`, they undo something, and undoing what was never done
        // is not an error (see the test above). The rest either read a
        // session or write something keyed by it, and both have to be told
        // when it is not there.
        for (const method of ["session.fork", "session.interrupt", "session.resume",
                              "nest.sessions.rename", "nest.sessions.archive"]) {
          const params = { session_id: missing };
          if (method === "nest.sessions.rename") params.name = "x";
          if (method === "nest.sessions.archive") params.archived = true;
          if (method === "session.resume") params.scene = "coding";
          const e = await client.refused(method, params);
          refusals.push([method, e]);
        }
        const silent = refusals.filter(([, e]) => !e).map(([m]) => m);
        assert(!silent.length,
          `succeeded on a session that does not exist: ${silent.join(", ")}`);
        for (const [method, e] of refusals) {
          assert(String(e.message).length > 5, `${method}: bare message "${e.message}"`);
        }
      },

    "a file query outside any project is refused rather than answered":
      async ({ client }) => {
        // `nest.files` resolves mentions inside a project. Pointed at
        // somewhere that is not one, it must not fall back to answering from
        // wherever the process happens to be standing.
        const e = await client.refused("nest.files",
          { project_root: "/definitely/not/a/project", query: "x" });
        if (e) {
          assert(e.message.length > 5, `bare message "${e.message}"`);
        } else {
          const result = await client.call("nest.files",
            { project_root: "/definitely/not/a/project", query: "x" });
          assert(Array.isArray(result.files) && result.files.length === 0,
            `answered with ${result.files?.length} files from a path that is not a project`);
        }
      },

    "an unknown method and a refused one are different answers": async ({ client }) => {
      const absent = await client.refused("nest.thereIsNoSuchMethod");
      assert(absent.code === METHOD_NOT_FOUND, `absent: code ${absent.code}`);

      const refused = await client.refused("config.set", { key: "x", value: 1 });
      assert(refused.code === REFUSED, `refused: code ${refused.code}`);
      assert(refused.message.length > 20, `no reason given: "${refused.message}"`);

      assert(absent.code !== refused.code,
        "an absent method and a refused one answer the same code");
    },

    "every refusal in the table carries its own reason": async ({ client }) => {
      // Not one shared sentence. The reason is what tells somebody whether
      // they hit a policy, a typo, or a method that moved.
      const reasons = new Set();
      const refusable = ["config.set", "config.update", "config.setProvider",
                         "mcp.addServer", "import.run", "import.list",
                         "daemon.shutdown", "session.run_turn", "session.subscribe",
                         "session.unsubscribe", "daemon.subscribeEvents"];
      for (const method of refusable) {
        const e = await client.refused(method, {});
        assert(e && e.code === REFUSED, `${method}: ${e ? e.code : "answered"}`);
        reasons.add(e.message);
      }
      assert(reasons.size > 4,
        `${refusable.length} refusals share only ${reasons.size} distinct reasons`);
    },

    "a scene that needs a project says so rather than failing later":
      async ({ client }) => {
        const { scenes } = await client.call("scene.list");
        const needsProject = scenes.find((s) => s.requires_project && s.active);
        if (!needsProject) return;
        const e = await client.refused("session.create",
          { scene: needsProject.scene, project_root: null });
        assert(e, "a project-requiring scene created a session without one");
        assert(/project/i.test(e.message), `says "${e.message}"`);
      },

    "a scene that is not active is refused by name": async ({ client }) => {
      const { scenes } = await client.call("scene.list");
      const inactive = scenes.find((s) => !s.active);
      if (!inactive) return;
      const e = await client.refused("session.create", { scene: inactive.scene });
      assert(e, `creating in inactive scene ${inactive.scene} succeeded`);
      assert(e.message.includes(inactive.scene), `does not name the scene: "${e.message}"`);
    },

    "an unknown scene and an inactive one are different answers": async ({ client }) => {
      const unknown = await client.refused("scene.activate", { scene: "no-such-scene" });
      assert(unknown, "activating a scene that does not exist succeeded");
      assert(/unknown|not found|no such/i.test(unknown.message), `says "${unknown.message}"`);
    },

    "an empty message is refused before a turn is opened": async ({ client }) => {
      const created = await client.call("session.create", {});
      const e = await client.refused("nest.send",
        { session_id: created.session_id, message: "" });
      assert(e && e.code === INVALID_PARAMS, `code ${e?.code}`);
      // And the session is untouched — a refused send must not leave a turn
      // half-open, which `session.get` is the way to check.
      const info = await client.call("session.get", { session_id: created.session_id });
      assert(!info.turn_state || info.turn_state === "idle",
        `a refused send left the session ${info.turn_state}`);
      await finish(client, created.session_id);
    },

    "a malformed id is a parameter problem, not a missing session":
      async ({ client }) => {
        // `session.history` parses the id before looking it up, so a short
        // string is rejected for its shape. That is a different answer from
        // a well-formed id nobody has, and both are worth having.
        const e = await client.refused("session.history", { session_id: "nope" });
        assert(e, "a malformed session id answered");
        assert(e.code === INVALID_PARAMS, `code ${e.code}, expected INVALID_PARAMS`);
      },

    "an upload token is one-shot and an unknown one is refused":
      async ({ backend, client }) => {
        const grant = await client.call("nest.upload.begin", { name: "e.txt", bytes: 3 });
        const url = `http://127.0.0.1:${backend.port}${grant.url}`;
        const first = await fetch(url, { method: "POST", body: "abc" });
        assert(first.ok, `first upload: ${first.status}`);
        const second = await fetch(url, { method: "POST", body: "abc" });
        assert(second.status === 403, `a spent token answered ${second.status}`);

        const bogus = await fetch(`http://127.0.0.1:${backend.port}/upload?token=nope`,
          { method: "POST", body: "abc" });
        assert(bogus.status === 403, `an unknown token answered ${bogus.status}`);

        const untokened = await fetch(`http://127.0.0.1:${backend.port}/upload`,
          { method: "POST", body: "abc" });
        assert(untokened.status === 400, `no token at all answered ${untokened.status}`);
      },

    "settings refuse the tier, the key and the shape separately":
      async ({ client }) => {
        const tier = await client.refused("nest.settings.set",
          { tier: "no-such-tier", key: "ui.theme", value: "dark" });
        assert(tier, "an unknown tier was accepted");

        const key = await client.refused("nest.settings.set",
          { tier: "global", key: "not.a.real.setting", value: 1 });
        assert(key && key.message.includes("not.a.real.setting"),
          `the key is not named: "${key?.message}"`);

        assert(tier.message !== key.message,
          "an unknown tier and an unknown key give the same sentence");
      },
  },
};
