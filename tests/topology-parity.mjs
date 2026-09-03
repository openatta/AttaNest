// The same conversation, over both topologies, compared.
//
// This is the experiment the transport layer was built for. The claim is
// "语义写死，拓扑可选" — the semantics are fixed and the topology is chosen —
// and it is worth exactly nothing until a second topology exists and gets the
// same answers as the first.
//
// Two things are checked, and they are different:
//
//   1. **Parity.** Method names, params, error codes and event shapes are
//      identical. Switching topology is not switching protocol.
//   2. **The seam that only the second topology exposes.** In split streams
//      `nest.attach` arrives on a POST while the frames it registers a watcher
//      for leave on a separate stream. If client identity came from the
//      connection, the attach would register the wrong one and the events
//      would go nowhere — silently, because nothing errors. That is why
//      identity comes from the credential.
//
//   node tests/topology-parity.mjs <port> <token>

import { PROTOCOL_VERSION, CONTRIB_API_VERSION } from "../ui/runtime/protocol.js";

const [port, token] = process.argv.slice(2);
if (!port || !token) {
  console.error("usage: node tests/topology-parity.mjs <port> <token>");
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const fail = (m) => { console.log("FAIL:", m); failures += 1; };
const ok = (m) => console.log("ok —", m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── topology one: one bidirectional connection ───────────────────────── */

async function singleDuplex() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  let id = 1;
  const pending = new Map();
  const events = [];
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
  const call = (method, params) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: i }));
  });
  await call("nest.handshake", { protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION, topology: "single_duplex" });
  return { name: "single_duplex", call, events, close: () => ws.close() };
}

/* ── topology two: HTTP plus two download-only streams ────────────────── */

async function splitStreams() {
  const handshake = await fetch(`${base}/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token, protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION, topology: "split_streams",
    }),
  }).then((r) => r.json());
  if (handshake.error) throw handshake.error;

  const credential = handshake.credential;
  const events = [];
  // Two subscription faces, opened separately. A read-only client would open
  // only one of them and never have the other queued for it at all.
  const readers = [];
  for (const [face, sink] of [["session", events], ["host", events]]) {
    const response = await fetch(`${base}/events/${face}?token=${encodeURIComponent(credential)}`);
    const reader = response.body.getReader();
    readers.push(reader);
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try { sink.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive */ }
            }
          }
        }
      } catch { /* closed */ }
    })();
  }
  // Give both streams a moment to be attached before anything is sent.
  await sleep(120);

  let id = 1;
  const call = async (method, params) => {
    const endpoint = method === "session.respondToPrompt" ? "respond" : "rpc";
    const frame = await fetch(`${base}/${endpoint}?token=${encodeURIComponent(credential)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: id++ }),
    }).then((r) => r.json());
    if (frame.error) throw frame.error;
    return frame.result;
  };
  return {
    name: "split_streams",
    call,
    events,
    close: () => readers.forEach((r) => r.cancel().catch(() => {})),
  };
}

/* ── the same script, both times ──────────────────────────────────────── */

async function drive(client) {
  const out = {};
  const hello = await client.call("nest.hello");
  out.protocol = hello.protocol_version;
  out.contribApi = hello.contrib_api_version;
  out.scenes = (hello.scenes || []).map((s) => s.scene).sort();

  out.reachable = (await client.call("nest.reachable")).methods.length;

  // A refusal has to be the same refusal, with the same code and words.
  try {
    await client.call("config.setProvider", {});
    out.refusal = "ALLOWED";
  } catch (e) {
    out.refusal = `${e.code}:${e.message}`;
  }
  // And so does an unknown method.
  try {
    await client.call("nest.noSuchMethod", {});
    out.unknown = "ALLOWED";
  } catch (e) {
    out.unknown = `${e.code}:${e.message}`;
  }

  // A session, an attach, and a send — the attach is the interesting one:
  // in split streams it registers a watcher for a stream that is not this
  // request's connection.
  const created = await client.call("session.create", { project_root: null, scene: "chat" })
    .catch(() => client.call("session.create", {}));
  out.created = typeof created.session_id === "string";
  const attached = await client.call("nest.attach", { session_id: created.session_id });
  out.attachShape = Object.keys(attached).sort().join(",");

  await client.call("nest.send", { session_id: created.session_id, message: "hello" })
    .catch(() => {});
  // Long enough for the user_message frame the hub synthesises to arrive.
  await sleep(600);
  out.sawOwnMessage = client.events.some((f) =>
    f.method === "nest.event" && f.params?.event?.kind === "user_message");

  await client.call("session.delete", { session_id: created.session_id }).catch(() => {});
  return out;
}

const one = await singleDuplex();
const first = await drive(one);
one.close();

const two = await splitStreams();
const second = await drive(two);
two.close();

for (const key of Object.keys(first)) {
  const a = JSON.stringify(first[key]);
  const b = JSON.stringify(second[key]);
  if (a !== b) fail(`${key}: single_duplex ${a} vs split_streams ${b}`);
  else ok(`${key}: ${a}`);
}

// The one that only the second topology can fail. Stated separately because
// it is not parity — it is the seam that made the experiment worth running.
if (!second.sawOwnMessage) {
  fail("split streams: nest.attach over POST did not register the event stream as a watcher");
} else {
  ok("split streams: a watcher registered over POST receives frames on its own stream");
}

console.log(failures ? "\nTOPOLOGY PARITY FAILED" : "\nTOPOLOGY PARITY PASSED");
process.exitCode = failures ? 1 : 0;
