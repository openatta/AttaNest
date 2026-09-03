// Record one fixture against a real model.
//
//   node tests/api/record-fixture.mjs calls-a-tool "Use the Bash tool to run: echo hi"
//
// Needs `.env`. Answers any permission prompt with permit, so a recording of a
// tool call actually contains the call rather than stopping at the ask.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv, hasModel, sleep } from "./harness.mjs";
import { PROTOCOL_VERSION, CONTRIB_API_VERSION } from "../../ui/runtime/protocol.js";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const [name, prompt] = process.argv.slice(2);
if (!name || !prompt) {
  console.error('usage: node tests/api/record-fixture.mjs <name> "<prompt>"');
  process.exit(2);
}

const env = loadEnv();
if (!hasModel(env)) {
  console.error("no model in .env — a fixture is a recording of a real call");
  process.exit(2);
}

const port = 4269;
const scratch = mkdtempSync(join(tmpdir(), "nest-record-"));
const child = spawn(
  join(ROOT, "target", "release", "nest"),
  ["--port", String(port), "--headless",
   "--atta-dir", join(scratch, "atta"), "--data-dir", join(scratch, "projects")],
  { cwd: ROOT, env: { ...process.env, ...env, RUST_LOG: "warn" }, stdio: "inherit" },
);

for (let i = 0; i < 120 && !existsSync(join(scratch, "projects", ".nest", "token")); i += 1) {
  await sleep(250);
}
const token = readFileSync(join(scratch, "projects", ".nest", "token"), "utf8").trim();

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let id = 1;
const pending = new Map();
const events = [];
const call = (method, params) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: i }));
});
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  if (frame.id != null && pending.has(frame.id)) {
    const slot = pending.get(frame.id);
    pending.delete(frame.id);
    frame.error ? slot.rej(frame.error) : slot.res(frame.result);
    return;
  }
  if (frame.method) events.push(frame);
};
await new Promise((r) => { ws.onopen = r; });
await call("nest.handshake", { protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION, topology: "single_duplex" });

const session = await call("session.create", { scene: "coding", project_root: ROOT });
await call("nest.attach", { session_id: session.session_id });
await call("nest.send", { session_id: session.session_id, message: prompt });

// Answer every ask, or a recording of a tool call stops at the question.
const answered = new Set();
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  for (const frame of events) {
    if (frame.method === "nest.event" && frame.params.event.kind === "prompt") {
      const promptId = frame.params.event.prompt_id;
      if (!answered.has(promptId)) {
        answered.add(promptId);
        await call("session.respondToPrompt", {
          session_id: session.session_id, prompt_id: promptId, decision: { type: "permit" },
        });
      }
    }
  }
  if (events.some((f) => f.method === "nest.turn_settled")) break;
  await sleep(200);
}

const kinds = (kind) => events.filter(
  (f) => f.method === "nest.event" && f.params.event.kind === kind).length;
console.log(`  tool_use=${kinds("tool_use")}  prompts=${kinds("prompt")}  settled=${
  events.some((f) => f.method === "nest.turn_settled")}`);

ws.close();
child.kill();
await sleep(500);

const from = join(scratch, "atta", "recordings", session.session_id);
const to = join(ROOT, "tests", "api", "fixtures", "recordings", name);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
rmSync(scratch, { recursive: true, force: true });
console.log(`  → tests/api/fixtures/recordings/${name}`);
process.exit(0);
