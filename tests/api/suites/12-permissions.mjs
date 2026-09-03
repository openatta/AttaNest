// Permission asks: broadcast to everyone watching, any of them may answer,
// first answer wins.
//
// The interesting part is not the happy path — it is that a second answer is
// a silent success rather than an error, because two people looking at the
// same session both pressing "allow" is a normal thing to happen.

import { connect, inconclusive, finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  // Superseded by `13-agent`, which does this against a recorded fixture and
  // therefore actually runs. Kept live-only because a live model reaching for
  // a tool on its own is worth confirming occasionally — it is the thing the
  // fixtures were recorded from.
  needsLiveModel: true,

  tests: {
    "a tool that needs permission asks every watcher": async ({ backend, client }) => {
      const created = await client.call("session.create",
        { scene: "coding", project_root: process.cwd() }).catch(() => null);
      if (!created) inconclusive("no coding scene in this build, so no tool to ask about");

      const second = await connect(backend, { topology: client.topology });
      await client.call("nest.attach", { session_id: created.session_id });
      await second.call("nest.attach", { session_id: created.session_id });

      await client.call("nest.send", {
        session_id: created.session_id,
        // Direct, and asking for the tool by name. A model that answers in
        // prose instead is not a failure of the permission path, and the
        // test says so rather than going green over it.
        message: "Use the Bash tool to run: echo permission-check\n"
          + "Do this now. Do not describe it, do not ask, just call the tool.",
      });

      let ask = null;
      try {
        ask = await client.waitFor(
          (f) => f.method === "nest.event"
            && f.params.session_id === created.session_id
            && f.params.event.kind === "prompt",
          { timeout: 90_000, describe: "a permission ask" });
      } catch {
        second.close();
        await finish(client, created.session_id);
        // The model answered without reaching for a tool, so there was
        // nothing to ask about. Not a pass: nothing was shown either way.
        inconclusive("the model did not call a tool, so no permission was asked");
      }

      const prompt = ask.params.event;
      assert(prompt.prompt_id, "the ask carries no prompt_id");
      assert(prompt.prompt_type === "permission", `prompt_type is ${prompt.prompt_type}`);

      // Broadcast: the other client saw it too, without asking for it.
      await second.waitFor(
        (f) => f.method === "nest.event" && f.params.event.kind === "prompt"
          && f.params.event.prompt_id === prompt.prompt_id,
        { timeout: 10_000, describe: "the second client to be asked as well" });

      // Either client may answer. The second answer is a silent success —
      // two people both pressing allow is normal, not an error.
      await second.call("session.respondToPrompt", {
        session_id: created.session_id, prompt_id: prompt.prompt_id, decision: { type: "permit" },
      });
      const late = await client.refused("session.respondToPrompt", {
        session_id: created.session_id, prompt_id: prompt.prompt_id, decision: { type: "permit" },
      });
      assert(!late, `answering twice failed: ${late?.message}`);

      second.close();
      await finish(client, created.session_id);
    },

    "an unanswered ask is handed to a client that arrives late": async ({ backend, client }) => {
      const created = await client.call("session.create",
        { scene: "coding", project_root: process.cwd() }).catch(() => null);
      if (!created) inconclusive("no coding scene in this build, so no tool to ask about");

      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send", {
        session_id: created.session_id,
        message: "Use the Bash tool to run: echo late-watcher\n"
          + "Do this now. Do not describe it, do not ask, just call the tool.",
      });

      let ask = null;
      try {
        ask = await client.waitFor(
          (f) => f.method === "nest.event" && f.params.event.kind === "prompt",
          { timeout: 90_000, describe: "a permission ask" });
      } catch {
        await finish(client, created.session_id);
        inconclusive("the model did not call a tool, so no permission was asked");
      }

      // A client opening the session now has to be told what is waiting, or
      // the session looks stuck while it walks towards a silent refusal.
      const late = await connect(backend, { topology: client.topology });
      const attached = await late.call("nest.attach", { session_id: created.session_id });
      assert(attached.pending_prompts.length >= 1,
        "a late client was not told about the unanswered ask");
      assert(attached.pending_prompts.some((p) => p.prompt_id === ask.params.event.prompt_id),
        "the pending ask has a different prompt_id");

      await late.call("session.respondToPrompt", {
        session_id: created.session_id,
        prompt_id: ask.params.event.prompt_id,
        decision: { type: "deny", reason: "not in a test" },
      });
      late.close();
      await finish(client, created.session_id);
    },
  },
};
