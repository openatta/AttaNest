// The two things the interface refactor is actually for, driven headlessly.
//
// 1. **The interface is assembled out of its seams.** Tool rows, flow blocks
//    and panels are registered parts, not a switch statement, and a later
//    registration takes one over — which is what "replace the interface"
//    means in practice. These are Nest's own seams: extending the *agent* is
//    AttaCore's, and nothing is loaded from outside this bundle.
//
// 2. **The handshake refuses rather than downgrades.** A version mismatch
//    stops the boot and says which side is stale. A half-compatible interface
//    produces bug reports nobody can act on, so there is no partial path.
//
//   node tests/contrib-smoke.mjs

import { readFileSync } from "node:fs";

import { loadApp } from "./dom.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (node) => (node ? node.textContent : "");

/** The catalogued points, from the generated table.
 *
 * `docs/contribution_points.md` is rendered by `nest_contrib::catalog` and a
 * Rust test fails when the two disagree, so reading it here means this file
 * and the backend cannot drift apart either. */
function catalogPoints() {
  const doc = readFileSync(new URL("../docs/contribution_points.md", import.meta.url), "utf8");
  const table = doc.slice(doc.indexOf("BEGIN GENERATED TABLE"), doc.indexOf("END GENERATED TABLE"));
  return [...table.matchAll(/^\| `([a-z.]+)`/gm)].map((m) => m[1]);
}

let failures = 0;
const fail = (m) => { console.log("FAIL:", m); failures += 1; };
const ok = (m) => console.log("ok —", m);

/** A socket that answers every request the same way. */
function socketThat(reply, seen) {
  return class {
    constructor() {
      this.readyState = 1;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (seen) seen.push(request.method);
      if (request.id == null) return;
      const body = reply(request.method, request.params || {});
      const frame = body && body.__error
        ? { jsonrpc: "2.0", id: request.id, error: body.__error }
        : { jsonrpc: "2.0", id: request.id, result: body || {} };
      if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  };
}

/* ── the points are real ─────────────────────────────────────────────── */
// First: the client refuses to reconnect after a refused handshake, and that
// is deliberate, so the refusal case has to come last in one process.
{
  await loadApp({
    WebSocket: socketThat((method, params) => {
      if (method === "nest.handshake") {
        return {
          protocol_version: 3,
          contrib_api_version: 1,
          topology: params.topology,
          topologies: ["single_duplex"],
          subject: { kind: "device", id: "test" },
        };
      }
      if (method === "nest.reachable") return { methods: [] };
      if (method === "nest.hello") {
        return { protocol_version: 3, contributions: {}, engine: {}, scenes: [], commands: [], limits: {} };
      }
      if (method === "nest.sessions") return { sessions: [] };
      return {};
    }),
  });
  await sleep(80);
  const contrib = await import("../ui/runtime/contrib.js");

  // Read from the generated catalog, not typed here.
  //
  // A hand-kept copy is how `projection.view` survived: the backend's catalog
  // listed it, nothing registered at it, nothing asked for it, and this list
  // had already been edited to leave it out. Every check passed and the point
  // existed only in a document.
  const points = catalogPoints();
  const empty = points.filter((p) => contrib.at(p).length === 0);
  if (empty.length) fail(`nothing registered at: ${empty.join(", ")}`);
  else ok(`every one of the ${points.length} catalogued points carries a registration`);

  const owners = new Set(points.flatMap((p) => contrib.at(p).map((c) => c.owner)));
  if (owners.size !== 1 || !owners.has("builtin")) fail(`unexpected owners: ${[...owners].join(", ")}`);
  else ok("everything registered is the product's own — nothing came from outside the bundle");

  // The catch-all is registered first so it is searched last: an unknown kind
  // draws as a note rather than as nothing.
  const unknown = contrib.claim("flow.block", { kind: "no-such-kind", text: "x" });
  if (!unknown || unknown.id !== "builtin.note") fail(`unknown kind claimed by ${unknown && unknown.id}`);
  else ok("an unknown block kind falls to the note, not to nothing");

  // And it does not swallow the kinds that have their own contribution.
  const user = contrib.claim("flow.block", { kind: "user", text: "hi" });
  if (!user || user.id !== "builtin.user") fail(`user block claimed by ${user && user.id}`);
  else ok("a known kind is claimed by its own contribution, not the catch-all");

  // Registered later wins. This is what "replace a tool row without forking"
  // means in practice.
  contrib.register("tool.row", { owner: "replacement", match: (b) => b.name === "Bash", render: () => "mine" });
  const bash = contrib.claim("tool.row", { kind: "tool", name: "Bash" });
  if (!bash || bash.owner !== "replacement") fail("a later registration did not take over the row");
  else ok("a later registration wins over the one it replaces");
  const other = contrib.claim("tool.row", { kind: "tool", name: "Read" });
  if (!other || other.owner !== "builtin") fail("taking one row over changed the others");
  else ok("and only the row it claimed");

  // A failing contribution loses its own contribution and nothing else.
  contrib.register("tool.row", { owner: "broken", match: () => { throw new Error("boom"); }, render: () => "x" });
  if (!contrib.claim("tool.row", { kind: "tool", name: "Read" })) {
    fail("one throwing registration broke the point for everyone");
  } else ok("a throwing registration loses only itself");
  if (!contrib.refusals().some((r) => r.owner === "broken")) fail("the failure was not recorded");
  else ok("and it is recorded, so a part that does not appear can say why");
}

/* ── the handshake refuses ───────────────────────────────────────────── */
// Second, because the client refuses to reconnect after a refusal and that
// flag lives for the life of the module — which is the behavior under test.
{
  const contrib = await import("../ui/runtime/contrib.js");
  const before = contrib.at("flow.block").length;

  const reason = "protocol version 3 is not 4; the client is out of date";
  const asked = [];
  const app = await loadApp({
    WebSocket: socketThat(
      (m) => (m === "nest.handshake" ? { __error: { code: -32001, message: reason } } : {}),
      asked,
    ),
  });
  await sleep(80);
  const { state } = await import("../ui/runtime/state.js");

  const banner = app.$("banner");
  if (!banner || !banner.classList.contains("on")) fail("a refused handshake showed nothing");
  else ok(`a refused handshake is shown: "${text(banner).slice(0, 52)}"`);
  if (state.connection !== "incompatible") fail(`connection reads "${state.connection}"`);
  else ok("the connection is marked incompatible rather than retried forever");
  // The store outlives one boot, so what proves the refusal stopped the boot
  // is what was asked for on the wire, not what is in the store.
  if (asked.some((m) => m !== "nest.handshake")) fail(`boot continued: asked ${asked.join(", ")}`);
  else ok("nothing was asked for past the refusal");

  if (contrib.at("flow.block").length !== before) fail("a refused handshake still registered contributions");
  else ok("and nothing was registered");
}



/* ── every point is consumed, not just registered ────────────────────── */
// The failure this catches actually happened: seven points had built-in
// contributions registered and five of them were never asked, while the shell
// went on drawing those things directly. Everything looked right — the
// contributions were there, the tests passed — and the extension surface was
// a claim for five of its seven points. Registration is not the property that
// matters; being *asked* is.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));

  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) sources.push(readFileSync(path, "utf8"));
    }
  };
  // The shell and the boot file: the places that are supposed to *ask*.
  // `ui/builtin` is excluded — a built-in naming its own point proves nothing.
  walk(join(root, "ui", "shell"));
  sources.push(readFileSync(join(root, "ui", "main.js"), "utf8"));
  const asking = sources.join("\n");

  // `tool.row` is asked for by the `flow.block` contribution that draws tool
  // blocks, which is the composition the two points are for, so it is read
  // from `ui/builtin` on purpose.
  const composed = readFileSync(join(root, "ui", "builtin", "flow-blocks.js"), "utf8");

  const unasked = catalogPoints()
    .filter((p) => !asking.includes(`"${p}"`) && !composed.includes(`"${p}"`));
  if (unasked.length) fail(`registered but never asked: ${unasked.join(", ")}`);
  else ok("every point is asked by something that draws");
}

console.log(failures ? "\nCONTRIB SMOKE FAILED" : "\nCONTRIB SMOKE PASSED");
process.exitCode = failures ? 1 : 0;
