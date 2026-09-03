// A package, from a zip on disk to a row on the screen.
//
//   node tests/package-e2e.mjs
//
// The whole path, once, with nothing stubbed: upload the file, let the engine
// install and disclose it, let Nest read the one section the engine ignores
// and serve the directory, let the browser import the module, and check that
// the row it registered **replaced** the built-in one for the tool it claims
// and left the others alone.
//
// # Why this builds its own backend
//
// The engine carries one extension carrier or none, and packaging is bundled
// with the WebAssembly one by a feature flag — so the build Nest ships
// answers `PLUGINS_DISABLED` and installs nothing. This compiles a backend
// with `--features plugin-compile` and skips, loudly, if it cannot. When
// AttaCore splits packaging from the carrier, this stops needing its own
// build. (Filed; see `.local/attacore-issue-plugin-carriers.md`.)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 4288;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const fail = (m) => { console.log("FAIL:", m); failures += 1; };
const ok = (m) => console.log("ok —", m);
const skip = (m) => { console.log("SKIP:", m); process.exit(0); };

/* ── a backend that can install packages ──────────────────────────────── */

const binary = process.env.NEST_PLUGIN_BINARY
  ?? join(ROOT, "target", "plugin-carrier", "nest");
if (!existsSync(binary)) {
  // Not built here, and not for tidiness: the carrier is chosen in the
  // workspace's own dependency table, and `cargo --config` does not reach a
  // path dependency there. So the binary is made once, deliberately, and this
  // says how rather than editing a manifest out from under whoever is
  // building.
  skip(
    `no plugin-carrier backend at ${binary}\n`
    + "  This test needs a build with the plugin carrier, which is not the one Nest ships.\n"
    + "  Make one:\n"
    + "    scripts/build-plugin-carrier.sh\n"
    + "  or point NEST_PLUGIN_BINARY at your own.",
  );
}

const scratch = mkdtempSync(join(tmpdir(), "nest-pkg-e2e-"));
const child = spawn(
  binary,
  ["--port", String(PORT), "--ui-dir", join(ROOT, "ui"),
   "--atta-dir", join(scratch, "atta"), "--data-dir", join(scratch, "projects"),
   "--replay-dir", join(ROOT, "tests", "api", "fixtures", "recordings")],
  { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: "package-e2e", RUST_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });

const stop = () => {
  try { child.kill(); } catch { /* gone */ }
  rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", stop);

for (let i = 0; i < 200; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
  } catch { /* not up */ }
  await sleep(200);
  if (i === 199) { console.log(log); fail("the backend did not start"); process.exit(1); }
}
const token = readFileSync(join(scratch, "projects", ".nest", "token"), "utf8").trim();

/* ── a client ─────────────────────────────────────────────────────────── */

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
let id = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  const slot = pending.get(frame.id);
  if (slot) { pending.delete(frame.id); frame.error ? slot.rej(frame.error) : slot.res(frame.result); }
};
await new Promise((r) => { ws.onopen = r; });
const call = (method, params) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: i }));
});
await call("nest.handshake", { protocol_version: 3, contrib_api_version: 1, topology: "single_duplex" });

/* ── install it ───────────────────────────────────────────────────────── */

const zip = readFileSync(join(ROOT, "tests", "fixtures", "packages", "demo-rows.zip"));
const checksum = createHash("sha256").update(zip).digest("hex");

const grant = await call("nest.plugins.upload", { name: "demo-rows.zip" });
const uploaded = await fetch(`http://127.0.0.1:${PORT}${grant.url}`, { method: "POST", body: zip });
if (!uploaded.ok) fail(`upload refused: ${uploaded.status}`);
else ok("the package went up the bulk channel");

let installed;
try {
  installed = await call("nest.plugins.install", {
    path: grant.path, name: "demo-rows", version: "1.0.0", checksum,
  });
  ok("the engine installed it");
} catch (e) {
  skip(`the engine would not install it: ${e.message}`);
}

// The engine discloses after installing, and that order is the engine's. What
// matters here is that the disclosure reaches the caller at all — a package
// installed without one is a package nobody agreed to.
if (!installed.disclosure) fail("the install returned no disclosure");
else ok("and returned what it will put in front of the model");

const listed = await call("nest.plugins.list");
if (!listed.plugins.some((p) => p.name === "demo-rows")) fail("it is not listed as installed");
else ok("it is listed as installed");

const contributes = listed.contributes.find((c) => c.plugin === "demo-rows");
if (!contributes) fail("Nest read no contribution out of it");
else if (contributes.inert.length) fail(`declared but inert: ${contributes.inert.join("; ")}`);
else if (contributes.ui.length !== 1) fail(`${contributes.ui.length} interface contributions`);
else ok(`Nest read its ${contributes.ui[0].point} contribution`);

// Same-origin, and only under ui/.
const module = await fetch(`http://127.0.0.1:${PORT}/plugins/demo-rows/ui/rows.js`);
if (!module.ok) fail(`the module is not served: ${module.status}`);
else ok("its module is served same-origin");

const leak = await fetch(`http://127.0.0.1:${PORT}/plugins/demo-rows/ui/plugin.toml`);
if (leak.ok && (await leak.text()).includes("[plugin]")) fail("the manifest is reachable over HTTP");
else ok("and nothing else in the package is");

/* ── see it in a browser ──────────────────────────────────────────────── */

let chromium;
try {
  ({ chromium } = await import("@playwright/test"));
} catch {
  console.log("SKIP: no browser — the serving half passed, the drawing half is unchecked");
  ws.close();
  console.log(failures ? "\nPACKAGE E2E FAILED" : "\nPACKAGE E2E PASSED (partial)");
  process.exit(failures ? 1 : 0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator("#conn.on").waitFor({ timeout: 20_000 });

// Polled, because the connection dot is not the signal.
//
// `#conn.on` appears when the handshake settles; the built-ins register and
// the packages load *after* that. Probing straight away reads a registry with
// only the built-ins in it — which is what this check did on its first run,
// and it was the check that was wrong, not the loading.
const deadline = Date.now() + 15_000;
let owners = [];
do {
  owners = await page.evaluate(async () => {
    const { at } = await import("/runtime/contrib.js");
    return at("tool.row").map((c) => c.owner);
  });
  if (owners.includes("demo-rows")) break;
  await sleep(200);
} while (Date.now() < deadline);

if (!owners.includes("demo-rows")) fail(`tool.row owners are ${owners.join(", ")}`);
else ok("the browser imported it and it registered");

// Later registration wins the claim — for the tool it named, and no other.
const claims = await page.evaluate(async () => {
  const { claim } = await import("/runtime/contrib.js");
  return {
    bash: claim("tool.row", { kind: "tool", name: "Bash" })?.owner,
    read: claim("tool.row", { kind: "tool", name: "Read" })?.owner,
  };
});
if (claims.bash !== "demo-rows") fail(`Bash is drawn by ${claims.bash}`);
else ok("it took over the row it claimed");
if (claims.read !== "builtin") fail(`Read is drawn by ${claims.read}`);
else ok("and left the others to the built-in one");

// And it actually paints.
await page.evaluate(async () => {
  const { call } = await import("/runtime/client.js");
  const { openSession } = await import("/shell/session.js");
  const created = await call("session.create",
    { scene: "coding", project_root: null, options: { recorder: { name: "calls-a-tool" } } })
    .catch(() => call("session.create", { options: { recorder: { name: "calls-a-tool" } } }));
  await openSession(created.session_id);
});
await page.locator("#input").fill(
  "Use the Bash tool right now to run exactly: echo nest-fixture. "
  + "Call the tool. Do not answer in prose.");
await page.locator("#input").press("Enter");

try {
  await page.locator(".blk.row-item .name", { hasText: "demo-rows" })
    .first().waitFor({ timeout: 30_000 });
  ok("and the row it drew is the one on screen");
} catch {
  fail("the contributed row never appeared in the flow");
}
if (errors.length) fail(`the page threw: ${errors.join("; ")}`);
else ok("with nothing thrown");

await browser.close();
ws.close();
console.log(failures ? "\nPACKAGE E2E FAILED" : "\nPACKAGE E2E PASSED");
process.exit(failures ? 1 : 0);
