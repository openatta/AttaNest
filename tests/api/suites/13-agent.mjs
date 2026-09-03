// Agent behaviour: tool calls, permission asks, the shapes a client renders.
//
// **Replayed, not called.** Every turn here comes from a recorded fixture, so
// the same tool is called every run, at the same point, with the same
// arguments — and none of it costs a model call or a network round trip. The
// alternative was a suite whose results depended on what a provider felt like
// doing that afternoon, which is how the permission path went untested for
// most of this project's life.
//
// A fixture answers the prompt it was recorded against, so the prompts below
// are the recorded ones. Changing one does not change what comes back — see
// `fixtures/recordings/README.md`.

import { connect, finish, inconclusive } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** A session bound to one fixture, and the prompt it was recorded with. */
async function replaying(client, fixture, message) {
  const created = await client.call("session.create", {
    scene: "coding",
    project_root: process.cwd(),
    options: { recorder: { name: fixture } },
  });
  await client.call("nest.attach", { session_id: created.session_id });
  await client.call("nest.send", { session_id: created.session_id, message });
  return created.session_id;
}

const settled = (client, sessionId) => client.waitFor(
  (f) => f.method === "nest.turn_settled" && f.params.session_id === sessionId,
  { timeout: 60_000, describe: "the replayed turn to settle" },
);

export default {
  needsModel: true,

  tests: {
    "a replayed turn produces the same text every run": async ({ client, replay }) => {
      if (!replay) inconclusive("live model: this asserts determinism, which a live model has none of");
      const session = await replaying(client, "says-ready", "Say exactly: fixture ready");
      const done = await settled(client, session);
      assert(!done.params.error, `the turn failed: ${JSON.stringify(done.params.error)}`);
      const text = client.text(session);
      assert(/fixture ready/i.test(text), `replayed text was "${text.slice(0, 120)}"`);
      await finish(client, session);
    },

    "a tool call arrives as a tool_use with its input": async ({ client }) => {
      const session = await replaying(
        client, "calls-a-tool",
        "Use the Bash tool right now to run exactly: echo nest-fixture. "
        + "Call the tool. Do not answer in prose.");
      await settled(client, session);

      const calls = client.eventsOfKind("tool_use", session);
      assert(calls.length >= 1, "no tool was called");
      const call = calls[0];
      assert(call.id, "a tool_use with no id — nothing could pair a result to it");
      assert(call.name, "a tool_use with no name");
      assert(call.input !== undefined, "a tool_use with no input");
      await finish(client, session);
    },

    "every tool_result pairs to a tool_use by id": async ({ client }) => {
      const session = await replaying(
        client, "calls-a-tool",
        "Use the Bash tool right now to run exactly: echo nest-fixture. "
        + "Call the tool. Do not answer in prose.");
      await settled(client, session);

      const uses = new Set(client.eventsOfKind("tool_use", session).map((e) => e.id));
      const results = client.eventsOfKind("tool_result", session);
      assert(results.length >= 1, "a tool was called and never returned");
      for (const result of results) {
        // By id, never by position: concurrency-safe tools run in parallel and
        // finish out of order, so the stream's order is not the call order.
        // A client pairing by index is right in history and wrong live.
        assert(uses.has(result.id), `a tool_result with id ${result.id} pairs to nothing`);
      }
      await finish(client, session);
    },

    "the turn reports what it spent": async ({ client }) => {
      const session = await replaying(
        client, "calls-a-tool",
        "Use the Bash tool right now to run exactly: echo nest-fixture. "
        + "Call the tool. Do not answer in prose.");
      await settled(client, session);
      const complete = client.eventsOfKind("turn_complete", session);
      assert(complete.length >= 1, "no turn_complete");
      const usage = complete[0].usage;
      assert(usage, "turn_complete carries no usage");
      // The total for the turn, not the last call of it. A turn that made
      // several calls and reported only the last would under-count, and a
      // host budgeting on it would be wrong by however many steps it took.
      assert(typeof usage.input_tokens === "number", "no input token count");
      assert(complete[0].api_calls >= 1, "no api_calls count");
      await finish(client, session);
    },

    "a permission ask reaches every watcher and the first answer wins":
      async ({ backend, client }) => {
        const second = await connect(backend, { topology: client.topology });
        const session = await replaying(
          client, "asks-permission",
          "Use the Bash tool right now to run exactly: rm -f /tmp/nest-fixture-probe. "
          + "Call the tool. Do not answer in prose.");
        await second.call("nest.attach", { session_id: session });

        const ask = await client.waitFor(
          (f) => f.method === "nest.event" && f.params.session_id === session
            && f.params.event.kind === "prompt",
          { timeout: 60_000, describe: "the recorded permission ask" });

        const prompt = ask.params.event;
        assert(prompt.prompt_id, "the ask carries no prompt_id");
        assert(prompt.prompt_type === "permission", `prompt_type is ${prompt.prompt_type}`);
        assert(prompt.tool_name, "the ask does not say which tool");

        // Broadcast: the second client was asked too, without asking for it.
        await second.waitFor(
          (f) => f.method === "nest.event" && f.params.event.kind === "prompt"
            && f.params.event.prompt_id === prompt.prompt_id,
          { timeout: 15_000, describe: "the second client to be asked as well" });

        // Either may answer, and the second answer is a silent success —
        // two people both pressing allow is normal, not an error.
        await second.call("session.respondToPrompt", {
          session_id: session, prompt_id: prompt.prompt_id, decision: { type: "permit" },
        });
        const late = await client.refused("session.respondToPrompt", {
          session_id: session, prompt_id: prompt.prompt_id, decision: { type: "permit" },
        });
        assert(!late, `answering twice failed: ${late?.message}`);

        await settled(client, session);
        second.close();
        await finish(client, session);
      },

    "a client arriving mid-ask is told what is waiting": async ({ backend, client }) => {
      const session = await replaying(
        client, "asks-permission",
        "Use the Bash tool right now to run exactly: rm -f /tmp/nest-fixture-probe. "
        + "Call the tool. Do not answer in prose.");
      const ask = await client.waitFor(
        (f) => f.method === "nest.event" && f.params.event.kind === "prompt",
        { timeout: 60_000, describe: "the recorded permission ask" });

      // Without this a session looks stuck while it walks towards a silent
      // refusal — the engine denies an unanswered ask after its timeout.
      const late = await connect(backend, { topology: client.topology });
      const attached = await late.call("nest.attach", { session_id: session });
      assert(attached.pending_prompts.length >= 1, "a late client was not told what is waiting");
      assert(
        attached.pending_prompts.some((p) => p.prompt_id === ask.params.event.prompt_id),
        "the pending ask has a different prompt_id",
      );

      await late.call("session.respondToPrompt", {
        session_id: session, prompt_id: ask.params.event.prompt_id,
        decision: { type: "deny", reason: "not in a test" },
      });
      await settled(client, session);
      late.close();
      await finish(client, session);
    },

    "denying is answered and the turn still ends": async ({ client }) => {
      const session = await replaying(
        client, "asks-permission",
        "Use the Bash tool right now to run exactly: rm -f /tmp/nest-fixture-probe. "
        + "Call the tool. Do not answer in prose.");
      const ask = await client.waitFor(
        (f) => f.method === "nest.event" && f.params.event.kind === "prompt",
        { timeout: 60_000, describe: "the recorded permission ask" });
      await client.call("session.respondToPrompt", {
        session_id: session,
        prompt_id: ask.params.event.prompt_id,
        decision: { type: "deny", reason: "the test says no" },
      });
      // A refusal is an answer, not a failure: the turn carries an error tool
      // result and goes on.
      const done = await settled(client, session);
      assert(done, "a denied turn never settled");
      await finish(client, session);
    },

    /// A replayed session writes no recording, so it has no envelope — and
    /// says so rather than failing.
    ///
    /// Worth a test of its own because the two states are easy to conflate:
    /// "this session never called the model" and "this session is playing one
    /// back" both mean there is nothing to read, and neither is an error. The
    /// envelope's real content is covered against a live model in
    /// `11-recordings`.
    "a replayed session has no envelope, and that is not an error":
      async ({ client, replay }) => {
        if (!replay) inconclusive("live model: covered by 11-recordings instead");
        const session = await replaying(
          client, "calls-a-tool",
          "Use the Bash tool right now to run exactly: echo nest-fixture. "
          + "Call the tool. Do not answer in prose.");
        await settled(client, session);
        const result = await client.call("nest.requestHeaders", { session_id: session });
        const headers = result.headers ?? [];
        assert(headers.length === 0, `a replaying session produced ${headers.length} envelopes`);
        await finish(client, session);
      },
  },
};
