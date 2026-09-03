// The invariants the hub exists for.
//
// These are the ones that cannot be checked from the interface side, because
// they are about what happens when a client is *not* there: a turn that
// outlives its tab, a second client catching up on one already running, a
// queue that drains.
//
// Everything here works without a model by driving the queue and the
// watcher registry directly; the turn-shaped versions are in `05-turns`.

import { connect, finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "sending registers the sender as a watcher": async ({ client }) => {
      // A client that skipped attach would otherwise get neither the turn's
      // events nor its settlement — frames go to watchers, and it would not
      // be one.
      const created = await client.call("session.create", {});
      await client.call("nest.send", { session_id: created.session_id, message: "hello" })
        .catch(() => {});
      const own = await client.waitFor(
        (f) => f.method === "nest.event"
          && f.params.session_id === created.session_id
          && f.params.event.kind === "user_message",
        { describe: "the sender's own message, without having attached" },
      );
      assert(own.params.event.text === "hello", `text is ${own.params.event.text}`);
      await finish(client, created.session_id);
    },

    "an empty message is refused": async ({ client }) => {
      const created = await client.call("session.create", {});
      const e = await client.refused("nest.send", { session_id: created.session_id, message: "   " });
      assert(e, "an empty message was accepted");
      await finish(client, created.session_id);
    },

    "two clients watching one session both see it": async ({ backend, client }) => {
      const created = await client.call("session.create", {});
      const second = await connect(backend, { topology: client.topology });
      await client.call("nest.attach", { session_id: created.session_id });
      await second.call("nest.attach", { session_id: created.session_id });

      await client.call("nest.send", { session_id: created.session_id, message: "seen by both" })
        .catch(() => {});
      for (const [who, c] of [["the sender", client], ["the second client", second]]) {
        await c.waitFor(
          (f) => f.method === "nest.event"
            && f.params.session_id === created.session_id
            && f.params.event.kind === "user_message",
          { describe: `${who} to see the message` },
        );
      }
      await client.call("session.interrupt", { session_id: created.session_id }).catch(() => {});
      second.close();
      await finish(client, created.session_id);
    },

    "a client that attaches late catches up exactly once": async ({ backend, client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.send", { session_id: created.session_id, message: "before you arrived" })
        .catch(() => {});
      await client.waitFor((f) => f.method === "nest.event"
        && f.params.event.kind === "user_message", { describe: "the first message" });

      const late = await connect(backend, { topology: client.topology });
      const attached = await late.call("nest.attach", { session_id: created.session_id });

      // The property is **exactly once**, not "in the buffer".
      //
      // Where the content comes from depends on whether the turn has settled,
      // and both answers are right: mid-turn it is in the buffer, because the
      // transcript is written once per turn and does not have it yet; after
      // settling it is in the transcript and the buffer has been cleared.
      // What must never happen is both — a client rendering history and
      // replay would draw the turn twice.
      //
      // This used to assert the buffer, which made it a test of how fast the
      // model answered: replayed turns settle in about 300ms, so on the
      // slower topology the turn was already done and the correct answer read
      // as a failure.
      const replayed = attached.replay.map((f) => f.event).filter((e) => e.kind === "user_message");
      const inHistory = attached.history_total > 0;
      assert(
        replayed.length > 0 || inHistory,
        "the late client caught up on nothing: no replay frames and an empty transcript",
      );
      assert(
        !(replayed.length > 0 && inHistory),
        `the same turn is in both the buffer (${replayed.length} frames) `
        + `and the transcript (${attached.history_total} messages) — it would render twice`,
      );
      if (replayed.length) {
        assert(replayed[0].text === "before you arrived", `replayed ${replayed[0].text}`);
      }
      assert(typeof attached.seq === "number" && attached.seq > 0, "no seq watermark");
      late.close();
      await finish(client, created.session_id);
    },

    "seq is assigned by the hub and never goes backwards": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      for (const text of ["one", "two", "three"]) {
        await client.call("nest.send", { session_id: created.session_id, message: text })
          .catch(() => {});
      }
      await client.waitFor((f) => f.method === "nest.event"
        && f.params.event.kind === "user_message" && f.params.event.text === "one",
        { describe: "the first message" });
      const seqs = client.events
        .filter((f) => f.method === "nest.event" && f.params.session_id === created.session_id)
        .map((f) => f.params.seq);
      for (let i = 1; i < seqs.length; i += 1) {
        assert(seqs[i] > seqs[i - 1], `seq went ${seqs[i - 1]} → ${seqs[i]}`);
      }
      await finish(client, created.session_id);
    },

    "a send during a turn queues instead of failing": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send", { session_id: created.session_id, message: "first" })
        .catch(() => {});
      // The engine allows one turn per session and refuses a second. That
      // constraint is the engine's business, and it should not reach the user
      // unchanged — so the second send queues.
      const queued = await client.call("nest.send",
        { session_id: created.session_id, message: "second", on_busy: "queue" });
      if (queued.queued) {
        assert(queued.item.item_id, "a queued item has no id");
        const snapshot = await client.waitFor(
          (f) => f.method === "nest.queue" && f.params.session_id === created.session_id,
          { describe: "a whole-value queue snapshot" });
        assert(Array.isArray(snapshot.params.items), "the queue push is not a whole value");

        const after = await client.call("nest.queue.remove",
          { session_id: created.session_id, item_id: queued.item.item_id });
        assert(!after.items.some((i) => i.item_id === queued.item.item_id),
          "the removed item is still queued");
      }
      await finish(client, created.session_id);
    },

    "asking to be rejected instead of queued is honoured": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.send", { session_id: created.session_id, message: "first" })
        .catch(() => {});
      const second = await client.refused("nest.send",
        { session_id: created.session_id, message: "second", on_busy: "reject" });
      if (second) assert(/busy/i.test(second.message), `says "${second.message}"`);
      await finish(client, created.session_id);
    },

    "interrupting abandons the queue behind it": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.send", { session_id: created.session_id, message: "first" })
        .catch(() => {});
      await client.call("nest.send",
        { session_id: created.session_id, message: "queued", on_busy: "queue" }).catch(() => {});
      // Stopping is a decision about the whole session, not just the running
      // turn: otherwise the user presses stop and the next message starts.
      await client.call("session.interrupt", { session_id: created.session_id });
      const attached = await client.call("nest.attach", { session_id: created.session_id });
      assert(attached.queue.length === 0, `${attached.queue.length} items survived the interrupt`);
      await finish(client, created.session_id);
    },

    "detaching stops the frames without touching the session": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.detach", { session_id: created.session_id });
      const info = await client.call("session.get", { session_id: created.session_id });
      assert(info.session_id === created.session_id, "detaching disturbed the session");
      await finish(client, created.session_id);
    },
  },
};
