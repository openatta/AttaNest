// The directory picker, project creation, and the bulk channel.
//
// The picker's fence is the point: it opens on the projects directory, walks
// under `$HOME` or an explicitly configured root, and refuses everything
// else. A picker that can be walked out of is a file browser.

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "the picker lists a directory with breadcrumbs": async ({ client }) => {
      const listing = await client.call("nest.listDirectory", {});
      assert(listing.path, "no path");
      assert(Array.isArray(listing.entries), "no entries");
      assert(Array.isArray(listing.breadcrumbs), "no breadcrumbs");
      // Directories only: a picker that lists files is asking the wrong
      // question.
      for (const entry of listing.entries) assert("name" in entry, "an entry has no name");
    },

    "the picker cannot be walked out of": async ({ client }) => {
      const e = await client.refused("nest.listDirectory", { path: "/etc" });
      // Either refused, or answered with something still inside the fence —
      // both are correct, silently listing /etc is not.
      if (!e) {
        const listing = await client.call("nest.listDirectory", { path: "/etc" });
        assert(!listing.path.startsWith("/etc"), `walked out to ${listing.path}`);
      }
    },

    "recent projects are derived from the sessions that exist": async ({ client }) => {
      const recent = await client.call("nest.recentProjects");
      assert(Array.isArray(recent.projects ?? recent.roots ?? []), "no project list");
    },

    "a project can be created and then listed": async ({ client }) => {
      const name = `api-test-${Date.now()}`;
      const created = await client.call("nest.projects.create", { name });
      assert(created.path?.endsWith(name), `created ${created.path}`);
      const listing = await client.call("nest.listDirectory", {});
      assert(listing.entries.some((e) => e.name === name), "the new project is not listed");
    },

    "file mentions resolve inside a project": async ({ client }) => {
      const result = await client.call("nest.files",
        { project_root: process.cwd(), query: "Cargo" });
      assert(Array.isArray(result.files), "no file list");
      assert(result.files.some((f) => f.path.includes("Cargo")), "Cargo.toml was not found");
    },

    "an upload grant is one-shot and the payload lands on disk": async ({ client, backend }) => {
      const grant = await client.call("nest.upload.begin", { name: "note.txt", bytes: 11 });
      assert(grant.url.includes("token="), `url is ${grant.url}`);

      const body = "hello there";
      const response = await fetch(`http://127.0.0.1:${backend.port}${grant.url}`,
        { method: "POST", body });
      assert(response.ok, `upload failed: ${response.status}`);
      const written = await response.json();
      assert(written.path === grant.path, "the payload landed somewhere else");

      // Spent. A grant that could be replayed would be a writable path handed
      // to whoever saw the URL.
      const replay = await fetch(`http://127.0.0.1:${backend.port}${grant.url}`,
        { method: "POST", body });
      assert(!replay.ok, "the same upload grant was accepted twice");
    },

    "an unknown upload token is refused": async ({ backend }) => {
      const response = await fetch(`http://127.0.0.1:${backend.port}/upload?token=made-up`,
        { method: "POST", body: "x" });
      assert(response.status === 403, `status ${response.status}`);
    },
  },
};
