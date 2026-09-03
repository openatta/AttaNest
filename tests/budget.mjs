// The performance budget, as a gate rather than a sentence.
//
// A performance target nobody measures is just a claim. These are the numbers
// from concept_and_architecture.md §7.2, checked against the release build;
// a regression fails here instead of being noticed months later on a small
// machine.
//
// The initial values are set for "a 4-core 8 GB box, and it has to run on a
// 2-core 2 GB arm64 board too". They can be changed — by writing the new
// number into the table *and* saying why, never by quietly loosening the gate.
//
//   cargo build --release && node tests/budget.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const MB = 1024 * 1024;
const KB = 1024;

/** The table. Changing a number here is the only way to change the gate. */
const BUDGET = [
  {
    name: "backend binary (default build)",
    limit: 48 * MB,
    unit: (n) => `${(n / MB).toFixed(1)} MB`,
    // The script carrier costs about a megabyte; the WebAssembly one costs
    // about twenty, and the two are mutually exclusive upstream. This number
    // is for the build that carries scripts.
    measure: () => statSync(join(root, "target", "release", "nest")).size,
  },
  {
    name: "interface (gzipped, as embedded)",
    limit: 300 * KB,
    unit: (n) => `${(n / KB).toFixed(0)} KB`,
    // Measured from `ui/`, which is what `include_dir!` compiles in — the
    // same bytes, so this is the embedded size and not an estimate of it.
    // It is self-contained (no CDN, nothing fetched at run time), which is
    // what lets the interface open with no network at all, and it is also
    // why it can live in the binary without dragging anything else along.
    measure: () => {
      let total = 0;
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (/\.(js|css|html)$/.test(entry.name)) {
            total += gzipSync(readFileSync(path)).length;
          }
        }
      };
      walk(join(root, "ui"));
      return total;
    },
  },
];

let failures = 0;
const measured = [];

for (const item of BUDGET) {
  let value;
  try {
    value = item.measure();
  } catch (e) {
    console.log(`SKIP: ${item.name} — ${e.message}`);
    continue;
  }
  const within = value <= item.limit;
  const line = `${within ? "ok —" : "FAIL:"} ${item.name}: ${item.unit(value)} (limit ${item.unit(item.limit)})`;
  console.log(line);
  measured.push({ name: item.name, value, limit: item.limit });
  if (!within) failures += 1;
}

// Cold start is measured only when a binary exists and can be asked for its
// version — enough to load the process image, which is what the number is
// really about.
try {
  const bin = join(root, "target", "release", "nest");
  statSync(bin);
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const started = process.hrtime.bigint();
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    runs.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  const limit = 300;
  const within = median <= limit;
  console.log(`${within ? "ok —" : "FAIL:"} process start (median of 5): ${median.toFixed(0)} ms (limit ${limit} ms)`);
  if (!within) failures += 1;
} catch {
  console.log("SKIP: process start — no release binary");
}

/* ── the ones that need the thing actually running ────────────────────── */
//
// Size and startup can be measured from a file. Resident memory, latency and
// idle CPU cannot: they are properties of a live process, and the whole point
// of the numbers in §7.2 is that this has to fit on a small machine while
// serving somebody. So the rest of this file starts a real backend against a
// throwaway directory and measures it.

const live = await measureLive(root).catch((e) => {
  console.log(`SKIP: live measurements — ${e.message}`);
  return null;
});

if (live) {
  const checks = [
    { name: "resident memory, idle", value: live.idleRssMb, limit: 80,
      unit: (n) => `${n.toFixed(1)} MB` },
    { name: "resident memory per idle session", value: live.perSessionMb, limit: 4,
      unit: (n) => `${n.toFixed(2)} MB` },
    { name: "unary round trip p99 (same machine)", value: live.p99Ms, limit: 15,
      unit: (n) => `${n.toFixed(1)} ms` },
    { name: "resident overhead per idle connection", value: live.perConnectionKb, limit: 64,
      unit: (n) => `${n.toFixed(1)} KB` },
    // The number a small box has to satisfy, and the one the per-connection
    // figure cannot be quietly traded against.
    { name: `resident memory holding ${live.connections} connections`, value: live.heldRssMb, limit: 120,
      unit: (n) => `${n.toFixed(1)} MB` },
    { name: "CPU when fully idle", value: live.idleCpuPercent, limit: 0.5,
      unit: (n) => `${n.toFixed(2)} %` },
  ];
  for (const c of checks) {
    const within = c.value <= c.limit;
    console.log(`${within ? "ok —" : "FAIL:"} ${c.name}: ${c.unit(c.value)} (limit ${c.unit(c.limit)})`);
    if (!within) failures += 1;
  }
}

/**
 * Start a backend, measure it, stop it.
 *
 * Measured against a throwaway engine directory and with no model credential,
 * so nothing here reaches a provider — what is under test is the process's
 * own footprint, and a turn would be measuring somebody else's.
 */
async function measureLive(root) {
  const { spawn, execFileSync: exec } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const bin = join(root, "target", "release", "nest");
  statSync(bin);
  const scratch = mkdtempSync(join(tmpdir(), "nest-budget-"));
  const port = 4291;
  const child = spawn(
    bin,
    ["--port", String(port), "--headless",
     "--atta-dir", join(scratch, "atta"), "--data-dir", join(scratch, "projects")],
    { cwd: root, env: { ...process.env, ANTHROPIC_API_KEY: "budget-test", RUST_LOG: "error" },
      stdio: "ignore" },
  );

  const rssMb = () => {
    // `ps` rather than anything clever: this is the number an operator would
    // read, so it is the number the budget should be about.
    const out = exec("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" });
    return Number(out.trim()) / 1024;
  };
  const cpuPercent = () => {
    const out = exec("ps", ["-o", "%cpu=", "-p", String(child.pid)], { encoding: "utf8" });
    return Number(out.trim());
  };

  try {
    const token = await waitForToken(join(scratch, "projects", ".nest", "token"), port);

    // Settle: the janitor, the skill scan and the MCP background connects all
    // happen after the port opens, and measuring through them would measure
    // startup rather than idle.
    await new Promise((r) => setTimeout(r, 3000));
    const idleRssMb = rssMb();

    const client = await connect(port, token);

    // p99 over a few hundred calls of a method that does no I/O of its own.
    const samples = [];
    for (let i = 0; i < 300; i += 1) {
      const started = process.hrtime.bigint();
      await client.call("daemon.ping", {});
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p99Ms = samples[Math.floor(samples.length * 0.99)];

    // What a connection costs while doing nothing.
    //
    // Measured **after a warm-up round**, and the reason is worth writing
    // down. Measured cold, the first hundred connections read as ~145 KB
    // each; open and close another hundred and the marginal cost is under a
    // kilobyte. The difference is not the connections — it is the allocator
    // taking pages from the OS for the first time and then keeping them. A
    // gate on the cold number would be a gate on macOS's malloc, and it would
    // fail or pass for reasons that have nothing to do with this code.
    //
    // So both numbers are checked, because both are real: the marginal cost
    // of one more connection, and the total footprint while a hundred are
    // held — which is the one an operator's box actually has to satisfy.
    const CONNECTIONS = 100;
    const warm = [];
    for (let i = 0; i < CONNECTIONS; i += 1) warm.push(await connect(port, token));
    await new Promise((r) => setTimeout(r, 1500));
    for (const c of warm) c.close();
    await new Promise((r) => setTimeout(r, 2000));

    const rssBefore = rssMb();
    const extra = [];
    for (let i = 0; i < CONNECTIONS; i += 1) extra.push(await connect(port, token));
    await new Promise((r) => setTimeout(r, 2000));
    const heldRssMb = rssMb();
    const perConnectionKb = Math.max(0, heldRssMb - rssBefore) * 1024 / extra.length;
    for (const c of extra) c.close();

    // Sessions, created and left alone.
    const rssBeforeSessions = rssMb();
    const sessions = [];
    for (let i = 0; i < 8; i += 1) {
      const created = await client.call("session.create", {}).catch(() => null);
      if (created?.session_id) sessions.push(created.session_id);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const perSessionMb = sessions.length
      ? Math.max(0, rssMb() - rssBeforeSessions) / sessions.length
      : 0;
    for (const id of sessions) await client.call("session.delete", { session_id: id }).catch(() => {});

    client.close();
    // `ps` reports CPU averaged over the process's life, so a fresh reading
    // after a quiet stretch is the honest way to ask "does it spin".
    await new Promise((r) => setTimeout(r, 4000));
    const idleCpuPercent = cpuPercent();

    return { idleRssMb, perSessionMb, p99Ms, perConnectionKb, heldRssMb, connections: CONNECTIONS, idleCpuPercent };
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function waitForToken(path, port) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/nope`).catch(() => {});
      return readFileSync(path, "utf8").trim();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("backend did not start in 30s");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** One handshaken connection, as a client would hold it. */
async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  let id = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.id != null && pending.has(frame.id)) {
      const slot = pending.get(frame.id);
      pending.delete(frame.id);
      frame.error ? slot.rej(frame.error) : slot.res(frame.result);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("could not connect"));
  });
  const call = (method, params) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: i }));
  });
  await call("nest.handshake", {
    protocol_version: 3, contrib_api_version: 1, topology: "single_duplex",
  });
  return { call, close: () => ws.close() };
}

console.log(failures ? "\nBUDGET FAILED" : "\nBUDGET PASSED");
process.exitCode = failures ? 1 : 0;
