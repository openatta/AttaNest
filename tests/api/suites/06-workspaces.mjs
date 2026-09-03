// Workspaces, titles, preferences, search — the things AttaCore has no
// concept of, kept in Nest's own directory.
//
// All of it registers through the contribution registry, so exercising it
// here also exercises that path.

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

      // Moving one, relative to an anchor — not handing over a whole order.
      // The list is the store's; a caller that sent an order would be
      // deciding what exists as well as where it sits.
      await client.call("nest.workspaces.reorder", { id });

      await client.call("nest.workspaces.remove", { id });
      const after = (await client.call("nest.workspaces.list")).workspaces.length;
      assert(after === before, `${after} workspaces left, started with ${before}`);
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
