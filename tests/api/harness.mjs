// The harness: a real backend, a client that speaks the front-end protocol,
// and a record of what was actually exercised.
//
// # Why this exists next to the other tests
//
// `tests/reducer-smoke.mjs` drives the interface against a scripted socket:
// the test *is* the server, so every event kind can be produced on demand.
// That covers the front end and, deliberately, none of the back end.
//
// This is the other half. A real engine, a real transport, the real
// authorization table, and a client that talks to it the way the interface
// does — same methods, same params, same frames. What is under test is the
// backend, through the only surface a client ever has.
//
// # Coverage is measured, not claimed
//
// The backend answers `nest.reachable` with every method a client may call.
// The harness asks for that list, records every method the suites call, and
// reports the difference. "We tested the API" is a claim; "51 of 56 methods
// were called, and here are the five that were not" is a number.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, CONTRIB_API_VERSION } from "../../ui/runtime/protocol.js";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/* ── model configuration ──────────────────────────────────────────────── */

/**
 * Read `.env` the way a shell would.
 *
 * Suites that need a model are skipped without it rather than failed: a
 * missing credential is a fact about the machine, and turning it into a red
 * test trains people to ignore red tests.
 */
export function loadEnv() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

export function hasModel(env) {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

/* ── the backend ──────────────────────────────────────────────────────── */

/**
 * Start one, on a throwaway engine directory.
 *
 * A fresh `--atta-dir` every run, because a suite that inherits yesterday's
 * sessions is a suite whose failures depend on what somebody did yesterday.
 */
export async function startBackend({ port, env = {}, args = [], seed } = {}) {
  const binary = join(ROOT, "target", "release", "nest");
  if (!existsSync(binary)) {
    execFileSync("cargo", ["build", "--release", "-p", "nest"], { cwd: ROOT, stdio: "inherit" });
  }
  const scratch = mkdtempSync(join(tmpdir(), "nest-api-"));
  // A hook for state that has to exist *before* the engine reads it. Some
  // behaviour is only reachable at startup — an MCP server that fails to
  // connect emits the only host events this build produces, and no method
  // can provoke one — so a suite that needs it seeds the directory and gets
  // its own backend.
  if (seed) seed(scratch);
  const child = spawn(
    binary,
    ["--port", String(port), "--ui-dir", join(ROOT, "ui"),
     "--atta-dir", join(scratch, "atta"), "--data-dir", join(scratch, "projects"), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, ...env, RUST_LOG: process.env.NEST_TEST_LOG || "warn" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`backend did not start:\n${log}`);
    }
    await sleep(200);
  }
  const token = readFileSync(join(scratch, "projects", ".nest", "token"), "utf8").trim();

  return {
    port,
    token,
    scratch,
    log: () => log,
    stop() {
      try { child.kill(); } catch { /* already gone */ }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/* ── the client ───────────────────────────────────────────────────────── */

/** Every method any client of this harness has called. */
const exercised = new Set();
/** Every method that has been driven into an error at least once. */
const refuted = new Set();
/** Every distinct error code seen, and one method that produced it. */
const codesSeen = new Map();

export function exercisedMethods() {
  return [...exercised].sort();
}

/**
 * Methods that have been made to fail, and the codes that came back.
 *
 * The second axis of coverage, and the one that is hard to fake. "Was this
 * method called" is satisfied by any happy path; a method that has never
 * returned an error has never had its arguments checked, its preconditions
 * tested, or its refusal path walked — and there are more lines behind those
 * than behind the answer. Counted here rather than declared in a list,
 * because a list of what is covered drifts in the direction that flatters.
 */
export function erroredMethods() {
  return [...refuted].sort();
}

export function errorCodesSeen() {
  return [...codesSeen.entries()].sort((a, b) => b[0] - a[0]);
}

/** Called from the one place in each topology where an error frame surfaces. */
function noteError(method, error) {
  refuted.add(method);
  if (error && typeof error.code === "number" && !codesSeen.has(error.code)) {
    codesSeen.set(error.code, method);
  }
}

/**
 * A client, over whichever topology is asked for.
 *
 * The two implementations differ only in how bytes move. Everything a suite
 * writes is the same either way, which is the property the transport layer
 * exists to provide — and running a suite over both is how that stays true.
 */
export async function connect(backend, { topology = "single_duplex" } = {}) {
  return topology === "split_streams"
    ? connectSplit(backend)
    : connectDuplex(backend);
}

async function connectDuplex(backend) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${backend.port}/ws?token=${encodeURIComponent(backend.token)}`);
  const pending = new Map();
  const events = [];
  const waiters = [];
  let id = 1;

  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.id != null && pending.has(frame.id)) {
      const slot = pending.get(frame.id);
      if (slot && frame.error) noteError(slot.method, frame.error);
      pending.delete(frame.id);
      frame.error ? slot.rej(frame.error) : slot.res(frame.result);
      return;
    }
    if (frame.method) deliver(events, waiters, frame);
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("could not open the socket"));
  });

  const call = (method, params) => {
    exercised.add(method);
    return new Promise((res, rej) => {
      const i = id++;
      pending.set(i, { res, rej, method });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: i }));
    });
  };
  const handshake = await call("nest.handshake", {
    protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION, topology: "single_duplex",
  });
  return client({ topology: "single_duplex", handshake, call, events, waiters,
    close: () => ws.close(), backend });
}

async function connectSplit(backend) {
  const base = `http://127.0.0.1:${backend.port}`;
  exercised.add("nest.handshake");
  const handshake = await fetch(`${base}/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: backend.token, protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION,
      topology: "split_streams",
    }),
  }).then((r) => r.json());
  if (handshake.error) throw handshake.error;

  const events = [];
  const waiters = [];
  const readers = [];
  for (const face of ["session", "host"]) {
    const response = await fetch(
      `${base}/events/${face}?token=${encodeURIComponent(handshake.credential)}`);
    const reader = response.body.getReader();
    readers.push(reader);
    void pump(reader, (frame) => deliver(events, waiters, frame));
  }
  await sleep(150); // both faces attached before anything is sent

  let id = 1;
  const call = async (method, params) => {
    exercised.add(method);
    const endpoint = method === "session.respondToPrompt" ? "respond" : "rpc";
    const frame = await fetch(
      `${base}/${endpoint}?token=${encodeURIComponent(handshake.credential)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: id++ }),
      },
    ).then((r) => r.json());
    if (frame.error) {
      noteError(method, frame.error);
      throw frame.error;
    }
    return frame.result;
  };
  return client({ topology: "split_streams", handshake, call, events, waiters,
    close: () => readers.forEach((r) => r.cancel().catch(() => {})), backend });
}

async function pump(reader, onFrame) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { onFrame(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive */ }
        }
      }
    }
  } catch { /* closed */ }
}

function deliver(events, waiters, frame) {
  events.push(frame);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].match(frame)) waiters.splice(i, 1)[0].resolve(frame);
  }
}

/** What a suite is handed. */
function client({ topology, handshake, call, events, waiters, close, backend }) {
  return {
    topology,
    handshake,
    events,
    call,
    close,
    backend,

    /** Calls that are expected to be refused. Returns the error. */
    async refused(method, params) {
      try {
        await call(method, params);
        return null;
      } catch (e) {
        return e;
      }
    },

    /** Wait for a frame, or give up saying what was waited for.
     *
     * Waiting on a predicate rather than sleeping is the difference between a
     * suite that is slow and one that is flaky. */
    async waitFor(match, { timeout = 20_000, describe = "a frame" } = {}) {
      const already = events.find(match);
      if (already) return already;
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
            reject(new Error(`timed out waiting for ${describe}`));
          }
        }, timeout);
      });
    },

    /** Session events of one kind, in arrival order. */
    eventsOfKind(kind, sessionId) {
      return events
        .filter((f) => f.method === "nest.event")
        .filter((f) => !sessionId || f.params.session_id === sessionId)
        .filter((f) => f.params.event?.kind === kind)
        .map((f) => f.params.event);
    },

    /** Everything the model streamed, joined. */
    text(sessionId) {
      return this.eventsOfKind("text_delta", sessionId).map((e) => e.text).join("");
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop whatever this session is doing, then remove it.
 *
 * Deleting a session with a turn still running leaves the engine finishing
 * work for something that no longer exists, and the next test pays for it —
 * which is how three tests here passed alone and failed in a full run. So:
 * interrupt, **wait for the settlement**, then delete.
 *
 * Never throws. Cleanup that can fail a test hides the failure that mattered.
 */
export async function finish(client, sessionId) {
  try {
    // Asked, not inferred. Guessing from "did this client ever see an event"
    // says yes for a turn that already settled, and then cleanup sits waiting
    // for a second settlement that is never coming.
    const info = await client.call("session.get", { session_id: sessionId }).catch(() => null);
    const running = info?.turn_state && info.turn_state !== "idle";
    if (running) {
      await client.call("session.interrupt", { session_id: sessionId }).catch(() => {});
      await client.waitFor(
        (f) => f.method === "nest.turn_settled" && f.params.session_id === sessionId,
        { timeout: 20_000, describe: "the interrupted turn to settle during cleanup" },
      ).catch(() => {});
    }
    await client.call("session.delete", { session_id: sessionId }).catch(() => {});
  } catch { /* cleanup never fails a test */ }
}

/**
 * A test that could not reach what it was trying to reach.
 *
 * Distinct from a pass, and that distinction matters more than it looks. A
 * permission test whose model never reached for a tool has not shown that
 * permissions work; reporting it green would be the test lying, and reporting
 * it red would train people to ignore red. So it says what happened.
 */
export class Inconclusive extends Error {}
export const inconclusive = (reason) => { throw new Inconclusive(reason); };
