// A real turn, against a real model.
//
// This is where the hub's reason for existing gets tested rather than argued
// about: a turn is started by the hub, so it does not hang off the connection
// that asked for it, and its result reaches every client watching — including
// one that arrived halfway through.

import { connect, finish, inconclusive, sleep } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** Say something short and wait for it to settle.
 *
 * Generous, because the model is at the other end of a network and none of
 * these tests are about how fast it is.
 *
 * Two different things can go wrong, and they are reported differently. A
 * turn that settles **with an error** is a real result — the hub did its job
 * and the failure is in the answer — so that is left to the caller. A turn
 * that never settles at all means the upstream stopped answering, which is a
 * fact about the provider and not about this code. §7.4 names that case
 * exactly: an upstream that hangs rather than erroring. Reporting it red
 * would make the suite fail for something it does not test, and reporting it
 * green would be worse.
 */
async function turn(client, sessionId, message, timeout = 180_000) {
  await client.call("nest.send", { session_id: sessionId, message });
  try {
    return await client.waitFor(
      (f) => f.method === "nest.turn_settled" && f.params.session_id === sessionId,
      { timeout, describe: `the turn "${message}" to settle` },
    );
  } catch {
    const streamed = client.text(sessionId);
    inconclusive(
      `the upstream never settled the turn in ${timeout / 1000}s`
      + `${streamed ? ` (it had streamed ${streamed.length} chars)` : " (nothing streamed)"}`,
    );
  }
}

export default {
  // Live only, and deliberately.
  //
  // What this suite is about is a turn that takes real time: a client closing
  // its tab while one runs, another arriving in the middle of one, a queue
  // draining behind one. A replayed turn settles in about 300ms, which makes
  // "arrive in the middle" a race rather than a test — the middle is gone
  // before the second client finishes connecting.
  //
  // The deterministic half of agent behaviour — tool calls, permission asks,
  // the shapes a client renders — is `13-agent`, which replays. This is the
  // half that needs a clock.
  needsLiveModel: true,

  tests: {
    "a turn streams and settles": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });

      const settled = await turn(client, created.session_id,
        "Reply with exactly the word: ready. Nothing else.");
      assert(!settled.params.error, `the turn failed: ${JSON.stringify(settled.params.error)}`);

      const streamed = client.text(created.session_id);
      assert(streamed.length > 0, "nothing was streamed");
      assert(/ready/i.test(streamed), `the model said "${streamed.slice(0, 120)}"`);

      // `turn_complete` is the model's side finishing; the settlement is the
      // hub's. Both, in that order.
      const complete = client.eventsOfKind("turn_complete", created.session_id);
      assert(complete.length >= 1, "no turn_complete event");
      assert(complete[0].usage, "turn_complete carries no usage");

      await finish(client, created.session_id);
    },

    "the transcript holds what was said": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await turn(client, created.session_id, "Say the word: persisted.");

      // Polled, and that is not a workaround for a flake — it is the
      // contract. Settling means the turn is over; the transcript is written
      // once per turn and catches up shortly after, which is exactly why the
      // hub keeps a replay buffer until it has seen `total` grow. Asserting
      // on history the instant a turn settles asserts a guarantee nothing
      // makes. (Caught by this test reading `user, user` once in a full run.)
      let history = null;
      const deadline = Date.now() + 15_000;
      do {
        history = await client.call("session.history",
          { session_id: created.session_id, offset: 0, limit: 50 });
        if (history.messages.some((m) => m.role === "assistant")) break;
        await sleep(250);
      } while (Date.now() < deadline);

      assert(history.total >= 2, `${history.total} messages after one exchange`);
      const roles = history.messages.map((m) => m.role);
      assert(roles.includes("user"), `roles are ${roles.join(", ")}`);
      assert(roles.includes("assistant"),
        `the assistant reply never reached the transcript; roles are ${roles.join(", ")}`);

      await finish(client, created.session_id);
    },

    "a turn outlives the client that started it": async ({ backend, client }) => {
      const created = await client.call("session.create", {});
      // Started by a client that then goes away entirely. `run_turn` belongs
      // to the hub, so this is a tab being closed, not a turn being cancelled.
      const starter = await connect(backend, { topology: client.topology });
      await starter.call("nest.attach", { session_id: created.session_id });
      await starter.call("nest.send",
        { session_id: created.session_id, message: "Count slowly to three, one word per line." });
      await starter.waitFor((f) => f.method === "nest.event"
        && f.params.event.kind === "user_message", { describe: "the turn to start" });
      starter.close();

      // A different client, arriving after the tab closed, sees it finish.
      const watcher = await connect(backend, { topology: client.topology });
      const attached = await watcher.call("nest.attach", { session_id: created.session_id });
      assert(attached.running_turn || attached.replay.length > 0,
        "the turn did not survive its client");
      await watcher.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        { timeout: 180_000, describe: "the orphaned turn to settle for a new watcher" },
      ).catch(() => inconclusive("the upstream never settled the orphaned turn"));
      watcher.close();
      await finish(client, created.session_id);
    },

    "a second client catches up mid-turn and sees the same ending": async ({ backend, client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send",
        { session_id: created.session_id, message: "Write three short sentences about rain." });
      await client.waitFor((f) => f.method === "nest.event"
        && f.params.event.kind === "text_delta", { timeout: 120_000, describe: "the model to start" });

      const late = await connect(backend, { topology: client.topology });
      const attached = await late.call("nest.attach", { session_id: created.session_id });
      // Catching up happens entirely inside the hub's buffer. The engine
      // re-sends nothing, and mid-turn the transcript does not have it yet.
      assert(attached.replay.length > 0, "the late client caught up on nothing");

      await late.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        { timeout: 180_000, describe: "the late client to see the turn settle" })
        .catch(() => inconclusive("the upstream never settled the turn"));
      late.close();
      await finish(client, created.session_id);
    },

    "a queued send runs after the one in front of it": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send",
        { session_id: created.session_id, message: "Say: first." });
      const queued = await client.call("nest.send",
        { session_id: created.session_id, message: "Say: second.", on_busy: "queue" });

      if (queued.queued) {
        // Two settlements, in order: the queue drains inside the same task
        // rather than needing anyone to poll it. Counted **for this session**
        // — counting every settlement the client ever saw is how this test
        // used to pass on a count another test had already run up.
        const settled = () => client.events.filter(
          (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        ).length;
        for (let want = 1; want <= 2; want += 1) {
          await client.waitFor(() => settled() >= want,
            { timeout: 180_000, describe: `turn ${want} of 2 to settle` });
        }
        const said = client.text(created.session_id);
        assert(/second/i.test(said), `the queued turn never ran: "${said.slice(0, 200)}"`);
      }
      await finish(client, created.session_id);
    },

    "interrupting stops a running turn": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send",
        { session_id: created.session_id, message: "Write a long essay about the sea." });
      await client.waitFor((f) => f.method === "nest.event"
        && f.params.event.kind === "text_delta", { timeout: 120_000, describe: "the model to start" });

      await client.call("session.interrupt", { session_id: created.session_id });
      await client.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        { timeout: 120_000, describe: "the interrupted turn to settle" });

      // A cancelled turn writes no terminal marker — being interrupted is not
      // arriving at an end — so the session stays resumable.
      const info = await client.call("session.get", { session_id: created.session_id });
      assert(info.session_id === created.session_id, "the session did not survive an interrupt");
      await finish(client, created.session_id);
    },

    "reopening a settled session reads it back from the transcript": async ({ backend, client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await turn(client, created.session_id, "Say the word: remembered.");
      await client.call("session.close", { session_id: created.session_id });

      const fresh = await connect(backend, { topology: client.topology });
      const attached = await fresh.call("nest.attach", { session_id: created.session_id });
      assert(attached.history_total >= 2, `history_total is ${attached.history_total}`);
      // History holds it, so the buffer must not also — a settled turn that
      // is in both is a turn rendered twice.
      assert(attached.replay.length === 0,
        `${attached.replay.length} replay frames for a settled, on-disk turn`);
      const history = await fresh.call("session.history",
        { session_id: created.session_id, offset: 0, limit: 50 });
      const text = JSON.stringify(history.messages);
      assert(/remembered/i.test(text), "what was said is not in the transcript");
      fresh.close();
      await finish(client, created.session_id);
    },
  },
};
