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
      if (!attached.replay.length) {
        // Nothing to catch up on is two different facts. Opening a second
        // client takes long enough — a handshake and, on split streams, two
        // more streams — that a three-sentence answer can finish inside that
        // window, and then there is no mid-turn left to arrive in. That is
        // the turn being short, not the buffer being empty, so it is asked
        // rather than assumed.
        const over = client.events.some(
          (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        );
        if (over) {
          late.close();
          await finish(client, created.session_id);
          inconclusive("the turn settled before the second client finished connecting");
        }
        assert(false, "the late client caught up on nothing while the turn was still running");
      }

      await late.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
        { timeout: 180_000, describe: "the late client to see the turn settle" })
        .catch(() => inconclusive("the upstream never settled the turn"));
      late.close();
      await finish(client, created.session_id);
    },

    "an attachment travels with the message it was sent on": async ({ client }) => {
      // `attachments` has never been passed. The bulk channel exists so a
      // file can reach a turn, and nothing checked that the second half of
      // that journey — grant, upload, then name it on the send — arrives.
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });

      const grant = await client.call("nest.upload.begin",
        { name: "note.txt", bytes: 11 });
      const put = await fetch(`http://127.0.0.1:${client.backend.port}${grant.url}`,
        { method: "POST", body: "nest-attach" });
      assert(put.ok, `the upload was refused: ${put.status}`);

      const attachments = [{ kind: "file", path: grant.path, name: "note.txt" }];
      await client.call("nest.send",
        { session_id: created.session_id, message: "What is in the attached file?", attachments });

      // The hub puts the user's own message into the stream — the engine
      // emits none — so what a second client sees is what the hub recorded.
      // If attachments were dropped on the way in, they are absent here.
      const own = await client.waitFor(
        (f) => f.method === "nest.event"
          && f.params.session_id === created.session_id
          && f.params.event.kind === "user_message",
        { timeout: 30_000, describe: "the hub to echo the message" });
      assert(own.params.event.text.includes("attached file"), "the wrong message came back");

      const queued = await client.call("nest.send", {
        session_id: created.session_id,
        message: "and again",
        attachments,
        on_busy: "queue",
      });
      if (queued.queued) {
        // The queue view is what a client draws while waiting, and it has to
        // carry the attachments or the row loses them on the way to the top.
        assert(Array.isArray(queued.item.attachments),
          `a queued item carries ${JSON.stringify(queued.item.attachments)}`);
        assert(queued.item.attachments.length === 1, "the queued attachment was dropped");
      }
      await client.call("session.interrupt", { session_id: created.session_id })
        .catch(() => {});
      await finish(client, created.session_id);
    },

    "a client that dies mid-turn does not take the turn with it":
      async ({ backend, client }) => {
        // `nest.detach` is the polite exit and is covered. This is the other
        // one: a tab closed, a laptop shut, a socket that simply stops. The
        // hub owns the turn, so it has to keep running and stay watchable by
        // whoever is still there.
        const created = await client.call("session.create", {});
        await client.call("nest.attach", { session_id: created.session_id });

        const doomed = await connect(backend, { topology: client.topology });
        await doomed.call("nest.attach", { session_id: created.session_id });

        await client.call("nest.send",
          { session_id: created.session_id, message: "Write two sentences about tide pools." });
        await client.waitFor((f) => f.method === "nest.event"
          && f.params.event.kind === "text_delta",
          { timeout: 120_000, describe: "the model to start" });

        doomed.close();

        const settled = await client.waitFor(
          (f) => f.method === "nest.turn_settled" && f.params.session_id === created.session_id,
          { timeout: 180_000, describe: "the turn to settle after a watcher vanished" })
          .catch(() => null);
        if (!settled) inconclusive("the upstream never settled the turn");
        assert(!settled.params.error,
          `the turn failed after a watcher left: ${JSON.stringify(settled.params.error)}`);

        // And the session is still usable by the client that stayed.
        const info = await client.call("session.get", { session_id: created.session_id });
        assert(info.session_id === created.session_id, "the session did not survive");
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
          try {
            await client.waitFor(() => settled() >= want,
              { timeout: 180_000, describe: `turn ${want} of 2 to settle` });
          } catch {
            // A settlement that never arrives is two different facts, and
            // guessing which would make this suite red for the provider's
            // behaviour (§7.4). So ask: a session still running is an
            // upstream that hung, and a session sitting idle with a
            // settlement missing is a queue that did not drain — which is
            // the thing this test is actually about.
            const info = await client
              .call("session.get", { session_id: created.session_id })
              .catch(() => null);
            const running = info?.turn_state && info.turn_state !== "idle";
            if (running) {
              inconclusive(
                `the upstream never settled turn ${want} of 2 in 180s `
                + `(the session is still ${info.turn_state})`,
              );
            }
            assert(false, `turn ${want} of 2 never settled and the session is idle`);
          }
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
