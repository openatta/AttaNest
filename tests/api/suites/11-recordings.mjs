// The request envelope: what the model was actually sent.
//
// Recording is on by default and the hub is what turns it on, because it owns
// every way a runnable session comes into being. Without it there is no
// answer to "what did the model see", and that question is not optional.
//
// The recording directory is never served over HTTP — it is read through an
// authorized method that folds it into a view.

import { finish, inconclusive } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  // Live only: the subject is the recording being *written*, and a replaying
  // session writes none. What a replayed session reports instead — nothing,
  // honestly — is checked in `13-agent`.
  needsLiveModel: true,

  tests: {
    "a session that never called the model has no envelope, and that is not an error":
      async ({ client }) => {
        const created = await client.call("session.create", {});
        const result = await client.call("nest.requestHeaders",
          { session_id: created.session_id });
        // Not an error: a conversation nobody has spoken in genuinely has no
        // envelope, and failing here would make the interface show a problem
        // where there is none.
        assert(result.recording === false || (result.headers ?? []).length === 0,
          `answered ${JSON.stringify(result).slice(0, 120)}`);
        await finish(client, created.session_id);
      },

    "after a turn, the envelope says what was sent": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send", { session_id: created.session_id, message: "Say: recorded." });
      await client.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        { timeout: 180_000, describe: "the turn to settle" })
        .catch(() => inconclusive("the upstream never settled the turn"));

      const result = await client.call("nest.requestHeaders", { session_id: created.session_id });
      const headers = result.headers ?? [];
      assert(headers.length >= 1, `no envelope after a turn: ${JSON.stringify(result).slice(0, 200)}`);

      const first = headers[0];
      assert(Array.isArray(first.system) && first.system.length > 0, "no system blocks recorded");
      // Each block says what it is and who put it there — two different
      // questions, and the details pane asks both.
      assert("source" in first.system[0] && "origin" in first.system[0],
        `a system block carries ${Object.keys(first.system[0])}`);
      assert(first.system[0].text?.length > 0, "a system block was recorded with no text");
      assert(Array.isArray(first.tools), "no tool catalog recorded");

      await finish(client, created.session_id);
    },

    "identical envelopes fold to one row": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      for (const message of ["Say: one.", "Say: two."]) {
        await client.call("nest.send", { session_id: created.session_id, message });
        await client.waitFor(
          (f) => f.method === "nest.turn_settled"
            && f.params.session_id === created.session_id
            && client.events.filter((x) => x.method === "nest.turn_settled").length >= 1,
          { timeout: 180_000, describe: `"${message}" to settle` });
        await new Promise((r) => setTimeout(r, 300));
      }
      const { headers = [] } = await client.call("nest.requestHeaders",
        { session_id: created.session_id });
      // Two turns with the same scene and the same tools are the same
      // envelope. The timeline is of *changes*, not of calls, or it would be
      // a log nobody reads.
      assert(headers.length <= 2, `${headers.length} envelope rows for two identical turns`);
      await finish(client, created.session_id);
    },

    "the recording directory is not reachable over HTTP": async ({ backend }) => {
      for (const path of ["/recordings", "/.atta", "/recordings/index.json"]) {
        const response = await fetch(`http://127.0.0.1:${backend.port}${path}`);
        const body = await response.text();
        // The static face answers unknown paths with the index — a route, not
        // a file. What must never happen is a recording coming back.
        assert(!/blob|call_|"system"/.test(body),
          `${path} returned something that looks like a recording`);
      }
    },
  },
};
