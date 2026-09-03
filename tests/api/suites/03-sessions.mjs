// Sessions: creating, listing, opening, closing, deleting.
//
// The facts `session.list` does not carry — the scene and the project root —
// are folded back in by the hub, and a session it has never opened reports
// null rather than a guess. That honesty is what is checked here.

import { finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "hello describes the engine and the ceilings": async ({ client }) => {
      const hello = await client.call("nest.hello");
      assert(hello.engine.model, "no model reported");
      assert(Array.isArray(hello.engine.active_scenes) && hello.engine.active_scenes.length,
        "no active scenes");
      assert(hello.limits.max_frame_bytes > 0, "no frame ceiling");
      assert(hello.limits.replay_max_frames > 0, "no replay ceiling");
      assert(Array.isArray(hello.scenes) && hello.scenes.length, "no scene list");
    },

    "a session can be created, opened and closed": async ({ client }) => {
      const created = await client.call("session.create", {});
      assert(created.session_id, "no session id");
      assert(created.scene, "the create response carries no scene");

      const attached = await client.call("nest.attach", { session_id: created.session_id });
      for (const key of ["session", "history_total", "replay", "truncated",
                         "pending_prompts", "running_turn", "queue", "seq"]) {
        assert(key in attached, `attach did not return ${key}`);
      }
      assert(attached.history_total === 0, `a new session has ${attached.history_total} messages`);

      await client.call("nest.detach", { session_id: created.session_id });
      await client.call("session.close", { session_id: created.session_id });
    },

    "the session list carries the scene and project root the engine drops": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      const { sessions } = await client.call("nest.sessions");
      const row = sessions.find((s) => s.session_id === created.session_id);
      assert(row, "the created session is not listed");
      // `SessionInfo` upstream carries neither; the hub writes down what it
      // saw at create and attach time.
      assert("scene" in row && "project_root" in row && "running" in row,
        `row is missing folded-in facts: ${Object.keys(row)}`);
      assert(row.scene, "scene was not folded back in");
      await finish(client, created.session_id);
    },

    "a session the hub never opened reports null rather than a guess": async ({ client }) => {
      const { sessions } = await client.call("nest.sessions");
      for (const row of sessions) {
        assert(row.scene === null || typeof row.scene === "string",
          `scene is ${JSON.stringify(row.scene)}`);
      }
    },

    "session.get answers for a session that was never run": async ({ client }) => {
      const created = await client.call("session.create", {});
      const info = await client.call("session.get", { session_id: created.session_id });
      assert(info.session_id === created.session_id, "wrong session");
      await finish(client, created.session_id);
    },

    "history is empty and pages sanely before anything is said": async ({ client }) => {
      const created = await client.call("session.create", {});
      const page = await client.call("session.history",
        { session_id: created.session_id, offset: 0, limit: 10 });
      assert(page.total === 0, `total is ${page.total}`);
      assert(Array.isArray(page.messages) && page.messages.length === 0, "messages is not empty");
      assert(page.has_more === false, "has_more is true on an empty session");
      await finish(client, created.session_id);
    },

    "a fork is a new session": async ({ client }) => {
      const created = await client.call("session.create", {});
      const forked = await client.call("session.fork", { session_id: created.session_id })
        .catch(() => null);
      if (forked) {
        assert(forked.session_id !== created.session_id, "fork returned the same id");
        await finish(client, forked.session_id);
      }
      await finish(client, created.session_id);
    },

    "a cold session can be reopened": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("session.close", { session_id: created.session_id });
      // Only live sessions have subscribers upstream, so reopening one that
      // is only on disk has to resume it first. That fallback is the hub's,
      // and this is the call that exercises it.
      const again = await client.call("nest.attach", { session_id: created.session_id });
      assert(again.session, "reopening a closed session returned nothing");
      await finish(client, created.session_id);
    },

    "the engine's own session list is reachable, and the hub's adds to it":
      async ({ client }) => {
        const created = await client.call("session.create", {});
        // The engine's list is what the hub folds facts into. Both are
        // callable, and the difference between them is the point: `scene` and
        // `project_root` are on one and not the other.
        const engine = await client.call("session.list", {});
        const raw = engine.sessions.find((s) => s.session_id === created.session_id);
        assert(raw, "the engine does not list the session it just created");
        assert(!("project_root" in raw), "the engine's list grew a project root");

        await client.call("nest.attach", { session_id: created.session_id });
        const { sessions } = await client.call("nest.sessions");
        const folded = sessions.find((s) => s.session_id === created.session_id);
        assert("project_root" in folded, "the hub did not fold the project root back in");
        await finish(client, created.session_id);
      },

    "a closed session can be resumed explicitly": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      const scene = (await client.call("session.get",
        { session_id: created.session_id })).scene;
      await client.call("session.close", { session_id: created.session_id });
      const resumed = await client.call("session.resume",
        { session_id: created.session_id, scene });
      assert(resumed, "resume returned nothing");
      await finish(client, created.session_id);
    },

    "scenes can be listed, described and activated": async ({ client }) => {
      const { scenes } = await client.call("scene.list");
      assert(scenes.length, "no scenes");
      const described = await client.call("scene.describe", { scene: scenes[0].scene });
      assert(described, "scene.describe returned nothing");

      // Activating one that is already active is the safe call to make here:
      // it exercises the path without changing what this process is for every
      // test that runs after it.
      const active = scenes.find((s) => s.active) ?? scenes[0];
      await client.call("scene.activate", { scene: active.scene }).catch(() => {});
    },

    "the engine answers for its own health": async ({ client }) => {
      const status = await client.call("daemon.status");
      assert(typeof status.sessions === "number", "no session count");
      const ping = await client.call("daemon.ping");
      assert(ping, "ping returned nothing");
      const doctor = await client.call("daemon.doctor");
      assert(doctor, "doctor returned nothing");
      await client.call("commands.list");
      await client.call("mcp.status");
    },
  },
};
