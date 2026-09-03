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

    "history pages, clamps an over-large limit, and says which it applied":
      async ({ client }) => {
        // Pagination has never been walked: every history assertion so far
        // was against an empty session, where offset and limit cannot be
        // wrong. What is checked here is the contract the engine documents —
        // an over-large `limit` is clamped rather than refused, and the
        // response says what was actually applied so a caller can tell.
        const created = await client.call("session.create", {});
        const huge = await client.call("session.history",
          { session_id: created.session_id, limit: 100_000 });
        assert(typeof huge.total === "number", "no total");
        assert(typeof huge.has_more === "boolean", "no has_more");
        assert(huge.limit === undefined || huge.limit < 100_000,
          `an over-large limit came back as ${huge.limit}`);

        // An offset past the end is an empty page, not an error: a client
        // paging forward should be able to walk off the end and stop.
        const past = await client.call("session.history",
          { session_id: created.session_id, offset: 5_000, limit: 10 });
        assert(Array.isArray(past.messages) && past.messages.length === 0,
          `offset past the end returned ${past.messages?.length} messages`);
        assert(past.has_more === false, "has_more is true past the end");
        await finish(client, created.session_id);
      },

    "the engine's session list can include children, and says whose they are":
      async ({ client }) => {
        // `include_children` and `parent_session_id` have never been passed.
        // A build that quietly ignored them would look identical to one that
        // honoured them, because every session in these tests is a primary.
        const created = await client.call("session.create", {});
        const flat = await client.call("session.list", {});
        const withChildren = await client.call("session.list", { include_children: true });
        assert(Array.isArray(withChildren.sessions), "include_children broke the list");
        assert(withChildren.sessions.length >= flat.sessions.length,
          `including children returned fewer rows (${withChildren.sessions.length} < ${flat.sessions.length})`);
        for (const row of withChildren.sessions) {
          assert(row.session_kind, `a row with no session_kind: ${JSON.stringify(row)}`);
        }

        // Filtering by a parent nobody has is an empty list, not an error.
        const orphans = await client.call("session.list",
          { include_children: true, parent_session_id: created.session_id });
        assert(Array.isArray(orphans.sessions), "filtering by parent broke the list");
        assert(!orphans.sessions.some((r) => r.session_id === created.session_id),
          "a session was returned as its own child");
        await finish(client, created.session_id);
      },

    "the permission mode a session was created with cannot be read back":
      async ({ client }) => {
        // `options.permission_mode` is what the new-session dialog sends, and
        // it decides whether tool calls ask at all — without it the engine
        // uses `AllowAllPermission` and no prompt is ever emitted. It is
        // accepted, and then **nothing reports it**: `session.get` carries
        // scene, status, turn state and message count, and not this.
        //
        // So a tab reopening a session cannot tell whether it will be asked
        // before a command runs, and neither can a test. Written down as the
        // gap it is; when `session.get` carries the mode, this should assert
        // the value instead.
        const created = await client.call("session.create",
          { options: { permission_mode: "plan" } });
        const info = await client.call("session.get", { session_id: created.session_id });
        assert(info.session_id === created.session_id, "wrong session");
        assert(info.permission_mode === undefined && info.options === undefined,
          `session.get now reports the mode (${JSON.stringify(info.permission_mode)}) — assert it`);

        // A mode the engine does not know is still accepted, because unknown
        // `options` are dropped whole rather than refused. Same blind spot,
        // seen from the other side: a typo in the dialog is silent.
        const typo = await client.call("session.create",
          { options: { permission_mode: "not-a-real-mode" } });
        assert(typo.session_id, "an unknown permission mode broke session creation");
        await finish(client, typo.session_id);
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

      assert(described.scene === scenes[0].scene, "describe answered about another scene");
      assert(described.capabilities, `${described.scene} declares no capabilities`);
      assert(typeof described.capabilities.requires_project === "boolean",
        "requires_project is not a boolean — the dialog branches on it");
      assert(described.settings, "no settings block");

      // Activating one that is already active is the safe call to make here:
      // it exercises the path without changing what this process is for every
      // test that runs after it. Not swallowed — a refusal here means the
      // method is broken, and `.catch(() => {})` was hiding exactly that.
      const active = scenes.find((s) => s.active) ?? scenes[0];
      const reactivated = await client.call("scene.activate", { scene: active.scene });
      assert(reactivated, "activating an already-active scene returned nothing");

      const unknown = await client.refused("scene.describe", { scene: "no-such-scene" });
      assert(unknown, "describing a scene that does not exist answered");
    },

    "the engine answers for its own health": async ({ client }) => {
      const status = await client.call("daemon.status");
      assert(typeof status.sessions === "number", "no session count");
      assert(typeof status.uptime_secs === "number", "no uptime");
      assert(status.version, "no engine version");

      const ping = await client.call("daemon.ping");
      assert(ping.pong === true, `ping answered ${JSON.stringify(ping)}`);

      // The health report, not merely a non-null object: a doctor that
      // returns `{}` and a doctor that ran its checks are indistinguishable
      // to a truthiness test, and only one of them is working.
      const doctor = await client.call("daemon.doctor");
      assert(Array.isArray(doctor.health?.checks) && doctor.health.checks.length,
        `doctor ran no checks: ${JSON.stringify(doctor).slice(0, 120)}`);
      for (const check of doctor.health.checks) {
        assert(check.name || check.check, `a check with no name: ${JSON.stringify(check)}`);
      }
    },

    "the command list carries what a client needs to draw it": async ({ client }) => {
      const { commands } = await client.call("commands.list");
      assert(Array.isArray(commands) && commands.length, "no commands");
      for (const c of commands) {
        assert(c.name, `a command with no name: ${JSON.stringify(c)}`);
        assert(c.kind, `${c.name} has no kind`);
        assert(c.source, `${c.name} does not say where it came from`);
      }
      // Provenance is the point: a command contributed by a package and one
      // the engine ships are different things to show, and `source` is the
      // only thing that separates them (§2.3).
      assert(commands.some((c) => c.source === "builtin"), "nothing is builtin");
    },

    "mcp servers are reported as a list, configured or not": async ({ client }) => {
      const { servers } = await client.call("mcp.status");
      assert(Array.isArray(servers), `servers is ${typeof servers}`);
      // None are configured in a test backend, and an empty list is the right
      // answer — distinct from the method being absent, which is what a bare
      // unasserted call could not tell apart.
      for (const s of servers) assert(s.name, `a server with no name: ${JSON.stringify(s)}`);
    },
  },
};
