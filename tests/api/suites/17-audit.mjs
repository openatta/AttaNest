// The audit trail — the one promise in §6.5 that nothing was checking.
//
// Decisions worth going back for are written into the session's own timeline
// as engine extension entries, under one namespace the engine never parses.
// That is the durable half, and it works.
//
// # Why this reads a file
//
// **There is no method that returns audit entries.** `session.history`
// reconstructs the model-visible conversation, so extension entries are not
// in it; the in-memory ring behind `Audit::recent` has no caller anywhere in
// the process. So the only way to observe the trail today is the transcript
// on disk, and that is what this does — deliberately, rather than quietly
// testing something easier. A suite that could only reach the trail by going
// around the API is itself the finding: something written for people to go
// back to should be reachable by the thing those people are using.
//
// If a `nest.audit` method is ever added, this suite should stop reading
// files and call it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REFUSED } from "../../../ui/runtime/protocol.js";
import { finish, sleep } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

const NS = "nest.audit";

/** Every entry in every transcript this backend has written. */
function entries(backend) {
  const root = join(backend.scratch, "atta", "projects");
  const out = [];
  let projects = [];
  try { projects = readdirSync(root); } catch { return out; }
  for (const project of projects) {
    let files = [];
    try { files = readdirSync(join(root, project)); } catch { continue; }
    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const text = readFileSync(join(root, project, file), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a partial write */ }
      }
    }
  }
  return out;
}

const audit = (backend) => entries(backend).filter((e) => e.kind === "extension" && e.ns === NS);

/** Writes are fire-and-forget, on purpose: an audit write must never be able
 *  to fail a call or slow one down. So it is waited for, not assumed. */
async function auditFor(backend, match, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = audit(backend).filter(match);
    if (found.length) return found;
    if (Date.now() > deadline) return [];
    await sleep(100);
  }
}

export default {
  tests: {
    "a refusal that named a session lands in that session's timeline":
      async ({ backend, client }) => {
        const created = await client.call("session.create", {});
        const e = await client.refused("session.run_turn",
          { session_id: created.session_id, message: "x" });
        assert(e && e.code === REFUSED, `code ${e?.code}`);

        const found = await auditFor(backend,
          (a) => a.session_id === created.session_id && a.payload?.method === "session.run_turn");
        assert(found.length, "the refusal is not in the timeline");

        const [entry] = found;
        assert(entry.event === "refuse", `event is ${entry.event}`);
        assert(entry.payload.subject.startsWith("device:"),
          `subject is ${entry.payload.subject}`);
        // The reason, not just the fact. An audit line that says "refused"
        // and not why sends whoever reads it back to the source.
        assert(entry.payload.reason && entry.payload.reason.length > 20,
          `no reason recorded: ${JSON.stringify(entry.payload)}`);
        assert(entry.payload.reason === e.message,
          "the audited reason and the one the client was given differ");
        await finish(client, created.session_id);
      },

    "the entry is filed under one namespace and carries no engine shape":
      async ({ backend, client }) => {
        const created = await client.call("session.create", {});
        await client.refused("daemon.subscribeEvents", { session_id: created.session_id });
        const found = await auditFor(backend,
          (a) => a.session_id === created.session_id
            && a.payload?.method === "daemon.subscribeEvents");
        assert(found.length, "nothing was written");

        // One key, opaque to the engine. This is what makes the entry
        // skippable by anything that does not know what it is — the engine
        // reads `kind` and `ns` and never looks inside `payload`.
        const [entry] = found;
        assert(entry.kind === "extension", `kind is ${entry.kind}`);
        assert(entry.ns === NS, `ns is ${entry.ns}`);
        assert(entry.session_id === created.session_id, "filed under another session");
        assert(entry.ts, "no timestamp");
        await finish(client, created.session_id);
      },

    "a routine allow is not written": async ({ backend, client }) => {
      // Read-only, happens constantly, and would bury everything worth
      // reading if it were kept. This is the rule that keeps the timeline
      // legible: a refusal is always worth a line, a routine allow never is.
      const created = await client.call("session.create", {});
      for (let i = 0; i < 5; i += 1) {
        await client.call("session.get", { session_id: created.session_id });
        await client.call("session.history", { session_id: created.session_id, limit: 1 });
      }
      await sleep(300);
      const noisy = audit(backend).filter(
        (a) => a.session_id === created.session_id
          && ["session.get", "session.history"].includes(a.payload?.method));
      assert(!noisy.length, `${noisy.length} routine reads were audited`);
      await finish(client, created.session_id);
    },

    "deleting a session takes its audit entry with it": async ({ backend, client }) => {
      // Not an assertion that this is *right*. `session.delete` is on the
      // consequential list, and it is the only entry there that names a
      // session — so the one allow the timeline could hold is the one whose
      // timeline the action destroys. The entry is written and then removed
      // with the transcript it was written into.
      //
      // Recorded here so the next person reading `is_consequential` knows
      // that line currently buys nothing, and that auditing deletions needs a
      // sink that is not the deleted session's own file.
      const created = await client.call("session.create", {});
      await client.call("session.delete", { session_id: created.session_id });
      await sleep(500);
      const survived = audit(backend).filter(
        (a) => a.session_id === created.session_id && a.payload?.method === "session.delete");
      assert(!survived.length,
        "the deletion entry survived — if this now passes, the trail outlives the session "
        + "and the test above it should assert the entry instead");
    },

    "a refusal with no session to file it under is dropped, not invented":
      async ({ backend, client }) => {
        // Pairing a device belongs to no conversation. Filing it under one
        // would be worse than not having it in a transcript at all — the
        // entry would claim a relationship that does not exist.
        const before = audit(backend).length;
        await client.refused("config.setProvider", {});
        await client.refused("mcp.addServer", {});
        await sleep(300);
        const added = audit(backend).slice(before);
        for (const entry of added) {
          assert(!["config.setProvider", "mcp.addServer"].includes(entry.payload?.method),
            `${entry.payload.method} was filed under session ${entry.session_id}`);
        }
      },

    "an unparseable session id is not filed anywhere": async ({ backend, client }) => {
      const before = audit(backend).length;
      await client.refused("session.run_turn", { session_id: "not-a-real-id", message: "x" });
      await sleep(300);
      const added = audit(backend).slice(before);
      assert(!added.length, `${added.length} entries were filed under a made-up session`);
    },
  },
};
