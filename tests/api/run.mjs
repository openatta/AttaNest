// The runner.
//
//   node tests/api/run.mjs                     everything
//   node tests/api/run.mjs sessions turns       named suites
//   node tests/api/run.mjs --topology split_streams
//   node tests/api/run.mjs --no-model           skip anything that calls one
//
// One backend for the whole run, and a fresh session per test that needs one.
// Sharing the process is what makes this fast enough to run often; not
// sharing sessions is what keeps a failure attributable.

import { readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Inconclusive, connect, errorCodesSeen, erroredMethods, exercisedMethods, hasModel, loadEnv, startBackend } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const named = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--topology");

const topology = option("topology", "single_duplex");
const env = loadEnv();
// Replay is the default for anything model-shaped.
//
// A recorded fixture makes an agent's behaviour deterministic and free: the
// same tool calls every run, no provider, no network, no waiting. `--live`
// asks for a real model instead — which is what recording a fixture needs,
// and what nothing else does.
const live = flag("live");
const replay = !live && !flag("no-model");
const model = live && hasModel(env);

const suiteFiles = readdirSync(join(here, "suites"))
  .filter((f) => f.endsWith(".mjs"))
  .sort();

const suites = [];
for (const file of suiteFiles) {
  const mod = await import(join(here, "suites", file));
  const name = file.replace(/\.mjs$/, "");
  if (named.length && !named.includes(name)) continue;
  suites.push({ name, ...mod.default });
}

/* ── running ──────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
let skipped = 0;
let inconclusive = 0;
const failures = [];

// Both topologies are served, always. The suites are written once and the
// runner picks which one they speak; serving only one would mean the other's
// endpoints are absent rather than answering, and "absent" is not the
// behaviour anything is trying to check.
const profile = join(tmpdir(), `nest-api-profile-${process.pid}.toml`);
writeFileSync(profile, [
  "[transport]",
  'topologies = ["single_duplex", "split_streams"]',
  'host = "127.0.0.1"',
  `port = ${Number(option("port", 4270))}`,
  "",
].join("\n"));

const fixtures = join(here, "fixtures", "recordings");
const backend = await startBackend({
  port: Number(option("port", 4270)),
  env: model ? env : { ANTHROPIC_API_KEY: "api-tests-no-model" },
  args: replay
    ? ["--profile", profile, "--replay-dir", fixtures]
    : ["--profile", profile],
});

console.log(
  `backend on :${backend.port} · topology ${topology} · `
  + `model ${live ? (model ? "live" : "asked for but not configured") : replay ? "replayed" : "none"}\n`);

/** A replaying backend of its own, for a suite whose point is determinism.
 *
 * `--replay-dir` is a whole-process decision, so in `--live` the shared
 * backend records rather than replays — and a suite written against fixtures
 * quietly became a live-model suite whose assertions depend on what the model
 * felt like doing. `13-agent` failed that way roughly one run in five, always
 * in a full run and never alone, which is the shape of a flake nobody finds.
 */
async function replayingBackend(port) {
  const path = join(tmpdir(), `nest-api-replay-${process.pid}.toml`);
  writeFileSync(path, [
    "[transport]",
    'topologies = ["single_duplex", "split_streams"]',
    'host = "127.0.0.1"',
    `port = ${port}`,
    "",
  ].join("\n"));
  return startBackend({
    port,
    env: { ANTHROPIC_API_KEY: "api-tests-replayed" },
    args: ["--profile", path, "--replay-dir", fixtures],
  });
}

try {
  for (const suite of suites) {
    // A suite needing a model runs against a fixture unless it asked for a
    // live one. `needsLiveModel` is for the few things a recording cannot
    // stand in for — there are none today, and the flag exists so that when
    // there is one, it says so.
    if (suite.needsModel && !model && !replay) {
      console.log(`— ${suite.name} (skipped: no model and no fixtures)`);
      skipped += suite.tests.length;
      continue;
    }
    if (suite.needsLiveModel && !model) {
      console.log(`— ${suite.name} (skipped: needs --live)`);
      skipped += suite.tests.length;
      continue;
    }
    console.log(`— ${suite.name}`);
    // A suite that declares itself replayed gets a replaying backend whatever
    // mode the run is in. Its whole value is that the same tool is called at
    // the same point every time; against a live model it is a different test
    // wearing the same name.
    const own = suite.replayed && !replay ? await replayingBackend(Number(option("port", 4270)) + 20) : null;
    const target = own ?? backend;
    const shared = suite.setup ? await suite.setup({ backend: target, env }) : {};
    for (const [title, run] of Object.entries(suite.tests)) {
      // A client per test, not per suite.
      //
      // The event log is per client, and sharing one meant a test could match
      // a frame an earlier test produced — which is how two of these went
      // green and red on alternate runs for a while. A handshake costs
      // milliseconds; a test whose result depends on what ran before it costs
      // considerably more than that.
      const client = await connect(target, { topology });
      const started = Date.now();
      try {
        await run({ client, backend: target, env, model, replay: replay || Boolean(own), ...shared });
        passed += 1;
        console.log(`  ok   ${title}  (${Date.now() - started}ms)`);
      } catch (e) {
        if (e instanceof Inconclusive) {
          inconclusive += 1;
          console.log(`  --   ${title}  (inconclusive: ${e.message})`);
        } else {
          failed += 1;
          failures.push({ suite: suite.name, title, error: e });
          console.log(`  FAIL ${title}`);
          console.log(`       ${e && e.message ? e.message : JSON.stringify(e)}`);
        }
      } finally {
        client.close();
      }
    }
    if (own) own.stop();
    if (suite.teardown) await suite.teardown({ backend, env, ...shared }).catch(() => {});
  }

  /* ── coverage ───────────────────────────────────────────────────────── */
  //
  // Against what the backend says a client may call, not against a list kept
  // by hand — a hand-kept list drifts the moment a method is added, and it
  // drifts in the direction that makes coverage look better.
  const probe = await connect(backend, { topology });
  const reachable = (await probe.call("nest.reachable")).methods;
  probe.close();

  const called = new Set(exercisedMethods());
  const untested = reachable.filter((m) => !called.has(m)).sort();
  const percent = ((reachable.length - untested.length) / reachable.length) * 100;

  // The second axis. A method that has only ever answered has never had its
  // arguments checked or its refusal walked, and that is where most of its
  // lines are. Measured, not declared — see `erroredMethods`.
  const errored = new Set(erroredMethods());
  const neverFailed = reachable.filter((m) => called.has(m) && !errored.has(m)).sort();
  const failedCount = reachable.filter((m) => errored.has(m)).length;

  console.log(`\n── coverage ──`);
  console.log(`  ${reachable.length - untested.length}/${reachable.length} reachable methods called (${percent.toFixed(0)}%)`);
  if (untested.length) {
    console.log(`  never called:`);
    for (const m of untested) console.log(`    ${m}`);
  }
  console.log(`  ${failedCount}/${reachable.length} also driven into an error `
    + `(${((failedCount / reachable.length) * 100).toFixed(0)}%)`);
  if (neverFailed.length) {
    console.log(`  happy path only:`);
    for (const m of neverFailed) console.log(`    ${m}`);
  }
  const codes = errorCodesSeen();
  console.log(`  ${codes.length} distinct error codes seen: `
    + codes.map(([code, via]) => `${code} (${via})`).join(", "));

  console.log(`\n${passed} passed, ${failed} failed`
    + `${inconclusive ? `, ${inconclusive} inconclusive` : ""}`
    + `${skipped ? `, ${skipped} skipped` : ""}`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  ${f.suite} › ${f.title}`);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  backend.stop();
  rmSync(profile, { force: true });
}
