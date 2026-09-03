// Workspaces, titles, preferences, search — the things AttaCore has no
// concept of, kept in Nest's own directory.
//
// All of it registers through the contribution registry, so exercising it
// here also exercises that path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "workspaces can be created, renamed, reordered and removed": async ({ client }) => {
      const before = (await client.call("nest.workspaces.list")).workspaces.length;

      const created = await client.call("nest.workspaces.create", { path: process.cwd() });
      assert(created.workspace?.id, "no workspace returned");
      const id = created.workspace.id;

      const renamed = await client.call("nest.workspaces.update", { id, title: "renamed by a test" });
      assert(renamed.workspace.title === "renamed by a test", `title is ${renamed.workspace.title}`);

      const collapsed = await client.call("nest.workspaces.update", { id, collapsed: true });
      assert(collapsed.workspace.collapsed === true, "collapse did not persist");

      await client.call("nest.workspaces.remove", { id });
      const after = (await client.call("nest.workspaces.list")).workspaces.length;
      assert(after === before, `${after} workspaces left, started with ${before}`);
    },

    "reordering moves the one named, relative to the anchor it names":
      async ({ client }) => {
        // This was a call with an `id` and nothing else, against a list with
        // one workspace in it — which moves that workspace to the end of a
        // list of one. It passed, it exercised the method, and it could not
        // have failed. Reordering needs three workspaces and an anchor before
        // it means anything.
        // Three distinct directories: a workspace is identified by its path,
        // and creating a second one on a path that already has one hands back
        // the existing row. Three creates on `process.cwd()` make one
        // workspace, which is a list too short to reorder.
        const ids = [];
        const dirs = [];
        for (const name of ["reorder-a", "reorder-b", "reorder-c"]) {
          const dir = mkdtempSync(join(tmpdir(), `nest-${name}-`));
          dirs.push(dir);
          const made = await client.call("nest.workspaces.create", { path: dir, title: name });
          assert(made.existed === false, `${name} reused an existing workspace`);
          ids.push(made.workspace.id);
        }
        const order = () => client.call("nest.workspaces.list")
          .then(({ workspaces }) => workspaces.map((w) => w.id).filter((i) => ids.includes(i)));

        const [a, b, c] = ids;
        assert((await order()).join() === [a, b, c].join(), "the three did not start in order");

        // Move the last one in front of the first.
        await client.call("nest.workspaces.reorder", { id: c, before_id: a });
        assert((await order()).join() === [c, a, b].join(),
          `after moving c before a the order is ${(await order()).join()}`);

        // No anchor means the end — which is what the old call was doing
        // without anyone noticing, because the list was one long.
        await client.call("nest.workspaces.reorder", { id: c });
        assert((await order()).join() === [a, b, c].join(),
          `after moving c to the end the order is ${(await order()).join()}`);

        // An anchor that does not exist puts it at the end rather than
        // failing: the caller's view of the list can be one change stale, and
        // refusing would make every reorder a read-then-write.
        await client.call("nest.workspaces.reorder", { id: a, before_id: "no-such-workspace" });
        assert((await order()).join() === [b, c, a].join(),
          `with an unknown anchor the order is ${(await order()).join()}`);

        for (const id of ids) await client.call("nest.workspaces.remove", { id });
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      },

    "reordering something that is not there changes nothing": async ({ client }) => {
      const before = (await client.call("nest.workspaces.list")).workspaces.map((w) => w.id);
      const e = await client.refused("nest.workspaces.reorder", { id: "no-such-workspace" });
      const after = (await client.call("nest.workspaces.list")).workspaces.map((w) => w.id);
      assert(before.join() === after.join(),
        `the list changed: ${before.join()} → ${after.join()}`);
      if (e) assert(e.message, "refused without saying why");
    },

    "creating a workspace on a path that is not a directory is refused": async ({ client }) => {
      const e = await client.refused("nest.workspaces.create", { path: "/definitely/not/here" });
      assert(e, "a non-directory was accepted");
      assert(/director/i.test(e.message), `says "${e.message}"`);
    },

    "a rename comes back, not just succeeds": async ({ client }) => {
      // The version of this test that only checked the call succeeded passed
      // for weeks while the title went nowhere: the store was written and
      // nothing read it back. Asserting the write is asserting that a
      // function was called; asserting the read is asserting the feature.
      const created = await client.call("session.create", {});
      await client.call("nest.sessions.rename",
        { session_id: created.session_id, title: "a name a person chose" });

      const notes = await client.call("nest.workspaces.list");
      const note = notes.sessions?.[created.session_id];
      assert(note, "the renamed session has no overlay entry");
      assert(note.title === "a name a person chose", `the title came back as ${note.title}`);
      await finish(client, created.session_id);
    },

    "archiving comes back too": async ({ client }) => {
      const created = await client.call("session.create", {});
      await client.call("nest.sessions.archive",
        { session_id: created.session_id, archived: true });
      let notes = await client.call("nest.workspaces.list");
      assert(notes.sessions?.[created.session_id]?.archived === true,
        "an archived session does not read back as archived");

      await client.call("nest.sessions.archive",
        { session_id: created.session_id, archived: false });
      notes = await client.call("nest.workspaces.list");
      assert(notes.sessions?.[created.session_id]?.archived === false,
        "un-archiving did not read back");
      await finish(client, created.session_id);
    },

    "the two halves of a session row can actually be joined": async ({ client }) => {
      // The hub holds sessions and the store holds the notes about them, and
      // neither knows about the other — so what a client needs is that the
      // keys line up. This is the assertion that the split is usable, rather
      // than merely tidy.
      const created = await client.call("session.create", {});
      await client.call("nest.attach", { session_id: created.session_id });
      await client.call("nest.sessions.rename",
        { session_id: created.session_id, title: "joinable" });

      const { sessions } = await client.call("nest.sessions");
      const notes = await client.call("nest.workspaces.list");
      const row = sessions.find((s) => s.session_id === created.session_id);
      assert(row, "the session is not in the hub's list");
      assert(notes.sessions[row.session_id], "the two lists do not share a key");
      assert("project_root" in row, "the hub's row carries no project root to join a workspace on");
      assert(Array.isArray(notes.workspaces), "the store returns no workspaces to join against");
      await finish(client, created.session_id);
    },

    "view preferences survive": async ({ client }) => {
      await client.call("nest.prefs.set", { key: "grouping", value: "recent" });
      const { prefs } = await client.call("nest.workspaces.list");
      assert(prefs.grouping === "recent", `prefs are ${JSON.stringify(prefs)}`);
    },

    "search answers on an empty corpus without failing": async ({ client }) => {
      const result = await client.call("nest.search", { query: "nothing will match this" });
      assert(Array.isArray(result.hits), "no hits array");
      assert(result.hits.length === 0, `${result.hits.length} hits for a nonsense query`);
    },
  },
};
