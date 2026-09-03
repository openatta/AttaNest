// The host-event channel: the one of the five semantics nothing was checking.
//
// Session events belong to a conversation and go to its watchers. Host events
// belong to the process — an MCP server that would not connect, a scene that
// degraded — and go to **every** client, subscribed or not, because there is
// nothing to subscribe to. The interface draws three banners off them.
//
// # Why this suite runs its own backend
//
// Every host event this build produces comes from connecting MCP servers, and
// that happens once, at startup: `mcp.addServer` is refused here on purpose
// (§3.4), so **no client can provoke one**. The only way to see the channel
// carry anything is to start a process that will emit one — a server pointed
// at a command that does not exist — and watch.
//
// That is worth saying plainly: a channel with no client-reachable trigger is
// a channel that can only be tested this way, or not at all.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, startBackend } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

const PORT = 4276;
const SERVER = "a-server-that-cannot-start";

/** Settings the engine reads at startup, naming an MCP server whose command
 *  does not exist. Connecting it fails, and failing emits the event. */
function seedFailingMcp(scratch) {
  const atta = join(scratch, "atta");
  mkdirSync(atta, { recursive: true });
  writeFileSync(join(atta, "settings.json"), JSON.stringify({
    mcp_servers: {
      // Valid configuration, unreachable binary. A *malformed* entry is
      // skipped with a log line and no event at all, which is a different
      // (and worse) case — see the suite this one sits beside.
      [SERVER]: {
        type: "stdio",
        command: "/nonexistent/definitely-not-a-real-binary",
        args: [],
      },
    },
  }, null, 2));
}

/** Host events already delivered, plus any that arrive within `timeout`. */
async function hostEvents(client, match, timeout = 20_000) {
  const seen = () => client.events.filter(
    (f) => f.method === "nest.host_event" && (!match || match(f)));
  if (seen().length) return seen();
  await client.waitFor((f) => f.method === "nest.host_event" && (!match || match(f)),
    { timeout, describe: "a host event" }).catch(() => {});
  return seen();
}

export default {
  tests: {
    "a process-level failure reaches a client that subscribed to nothing":
      async ({ topology }) => {
        const backend = await startBackend({
          port: PORT,
          env: { ANTHROPIC_API_KEY: "host-events" },
          seed: seedFailingMcp,
        });
        try {
          const client = await connect(backend, { topology });
          const found = await hostEvents(client,
            (f) => f.params?.kind === "mcp_connect_failed");
          assert(found.length,
            `no host event arrived; saw ${client.events.map((e) => e.method).join(", ") || "nothing"}`);

          const event = found[0].params;
          assert(event.server === SERVER, `the event names ${event.server}`);
          // The reason travels with it. A banner that says "an MCP server
          // failed" and not which one, or why, is a banner nobody can act on.
          assert(event.error || event.reason,
            `no reason on the event: ${JSON.stringify(event)}`);
          client.close();
        } finally {
          backend.stop();
        }
      },

    "a host event is a broadcast, not a subscription": async ({ topology }) => {
      const backend = await startBackend({
        port: PORT + 1,
        env: { ANTHROPIC_API_KEY: "host-events" },
        seed: seedFailingMcp,
      });
      try {
        // Two clients, neither of which attached to anything. The defining
        // property of this semantic is that there is nothing to ask for:
        // process-level facts go to everyone who is connected.
        const first = await connect(backend, { topology });
        const second = await connect(backend, { topology });
        for (const [name, client] of [["first", first], ["second", second]]) {
          const found = await hostEvents(client, (f) => f.params?.kind === "mcp_connect_failed");
          assert(found.length, `the ${name} client, which subscribed to nothing, was not told`);
        }
        first.close();
        second.close();
      } finally {
        backend.stop();
      }
    },

    "the host face carries host events and the session face does not":
      async ({ topology }) => {
        // Only split streams can be wrong about this: there, the two kinds
        // travel on two separate downloads, and a host event delivered on the
        // session face would mean a read-only client watching one
        // conversation is being handed process-level facts it did not ask for
        // — and, worse, that the faces are interchangeable, which is the
        // thing the split exists to disprove.
        if (topology !== "split_streams") return;
        const backend = await startBackend({
          port: PORT + 2,
          env: { ANTHROPIC_API_KEY: "host-events" },
          seed: seedFailingMcp,
        });
        try {
          const client = await connect(backend, { topology });
          const found = await hostEvents(client, (f) => f.params?.kind === "mcp_connect_failed");
          assert(found.length, "no host event arrived on split streams");
          // `nest.event` is the session face's method. A host event wearing
          // that method would have come down the wrong stream.
          const misrouted = client.events.filter(
            (f) => f.method === "nest.event" && f.params?.kind === "mcp_connect_failed");
          assert(!misrouted.length, "a host event arrived as a session event");
          client.close();
        } finally {
          backend.stop();
        }
      },

    "a client that arrives after the failure cannot learn about it":
      async ({ topology }) => {
        // Not an assertion that this is right — it is the gap, written down.
        //
        // The failure is announced once, on a channel, and nothing holds the
        // state: `mcp.status` lists servers that connected, so a server that
        // never did is absent rather than broken. A tab opened a minute later
        // sees a healthy process. Catching up on a session's events is what
        // the hub's buffer is for (§3.2); there is no equivalent for
        // process-level facts, and the engine's own status call is where one
        // would naturally live.
        //
        // Filed against AttaCore. When `mcp.status` reports servers that
        // failed, this test should assert the row rather than its absence.
        const backend = await startBackend({
          port: PORT + 3,
          env: { ANTHROPIC_API_KEY: "host-events" },
          seed: seedFailingMcp,
        });
        try {
          const witness = await connect(backend, { topology });
          const seen = await hostEvents(witness,
            (f) => f.params?.kind === "mcp_connect_failed");
          assert(seen.length, "the failure was never announced at all");

          // A second client, connecting after the announcement it missed.
          const late = await connect(backend, { topology });
          const { servers } = await late.call("mcp.status");
          assert(!servers.some((s) => s.name === SERVER),
            "mcp.status now reports the failed server — good; assert the row instead of this");
          const missed = late.events.filter((f) => f.method === "nest.host_event");
          assert(!missed.length, "host events are replayed to late clients — assert that instead");
          witness.close();
          late.close();
        } finally {
          backend.stop();
        }
      },
  },
};
