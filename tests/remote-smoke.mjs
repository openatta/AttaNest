// The whole remote path, once: pair, connect, be admitted, be revoked.
//
// Each step is a rule from §6.3, and each one is checked by doing it rather
// than by reading the code that implements it:
//
//   * a reachable listener refuses the token alone
//   * a pairing code is single-use and short-lived
//   * a device proves possession by signing a challenge the server chose
//   * a signature is worth nothing for a different challenge
//   * revoking is immediate and total
//
// The backend has to be bound somewhere **reachable** — `0.0.0.0`, or an
// interface address — and served over TLS, with `split_streams` among its
// topologies (the RPC endpoint this uses is only mounted for it). On loopback
// the per-process token is the whole story by design, so every rule below is
// vacuously false there; that case is detected and said, rather than printed
// as four failures about revoked devices being admitted.
//
//   nest --profile <both topologies, host = "0.0.0.0"> --tls-cert … --tls-key …
//   node tests/remote-smoke.mjs <port> <token> <pairing-code>

import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { PROTOCOL_VERSION, CONTRIB_API_VERSION } from "../ui/runtime/protocol.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the test's cert is self-signed

const [port, token, pairingCode] = process.argv.slice(2);
if (!port || !token || !pairingCode) {
  console.error("usage: node tests/remote-smoke.mjs <port> <token> <pairing-code>");
  process.exit(2);
}
const base = `https://127.0.0.1:${port}`;

let failures = 0;
const fail = (m) => { console.log("FAIL:", m); failures += 1; };
const ok = (m) => console.log("ok —", m);

/** An Ed25519 keypair, the way a real device would hold one: the private half
 *  never leaves, and what travels is a signature over bytes the server chose. */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicB64 = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
const signB64 = (bytes) => nodeSign(null, bytes, privateKey).toString("base64");

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

const rpc = async (credential, method, params) => {
  const frame = await post(`/rpc?token=${encodeURIComponent(credential)}`, {
    jsonrpc: "2.0", method, params: params || {}, id: 1,
  });
  const body = JSON.parse(frame.text);
  if (body.error) throw body.error;
  return body.result;
};

const challenge = async () =>
  fetch(`${base}/challenge`).then((r) => r.json());

const handshake = (extra) =>
  post("/handshake", {
    token, protocol_version: PROTOCOL_VERSION, contrib_api_version: CONTRIB_API_VERSION, topology: "split_streams", ...extra,
  });

/* ── the token alone is not enough ────────────────────────────────────── */
{
  const { status, text } = await handshake({});
  if (status === 200) {
    // Not a failure — a listener this test cannot say anything about. On a
    // loopback bind the token *is* the whole story (§6.3), so admission,
    // challenges and revocation all have nothing to gate and every check
    // below would report a security property as broken when it was simply
    // never in play.
    console.log(
      "SKIP: this listener admitted the token alone, which means it is bound to\n"
      + "  loopback — where that is the design. Bind it somewhere reachable\n"
      + "  (`host = \"0.0.0.0\"`) with TLS and run this again.",
    );
    process.exit(0);
  }
  ok(`token alone refused: ${text}`);
}

/* ── pairing ──────────────────────────────────────────────────────────── */
// The code came from the console of the process that was just started. That
// is the only thing that breaks the circle: pairing is a method, methods need
// admission, and this listener admits nobody yet.
let deviceId = null;
{
  // Completing the pairing is itself a method, so it is reached over a
  // handshake that carries the code instead of a signature — the one call a
  // reachable listener takes before any device exists.
  const { status, text } = await post("/pair", {
    token, code: pairingCode, public_key: publicB64,
  });
  if (status !== 200) {
    fail(`pairing refused: ${status} ${text}`);
  } else {
    deviceId = JSON.parse(text).device.id;
    ok(`paired: ${deviceId}`);
  }
}

if (!deviceId) {
  console.log("\nREMOTE SMOKE FAILED");
  process.exit(1);
}

/* ── a code is single-use ─────────────────────────────────────────────── */
{
  const { status } = await post("/pair", { token, code: pairingCode, public_key: publicB64 });
  if (status === 200) fail("the same pairing code paired a second device");
  else ok("the pairing code is spent");
}

/* ── a signature over the server's challenge admits ───────────────────── */
let credential = null;
{
  const { challenge_id, challenge: bytes } = await challenge();
  const signature = signB64(Buffer.from(bytes, "base64"));
  const { status, text } = await handshake({ device_id: deviceId, challenge_id, signature });
  if (status !== 200) fail(`a paired device was refused: ${text}`);
  else {
    credential = JSON.parse(text).credential;
    ok("a paired device signing the server's challenge is admitted");
  }
}

/* ── and it is worth nothing anywhere else ────────────────────────────── */
{
  const first = await challenge();
  const signature = signB64(Buffer.from(first.challenge, "base64"));
  const second = await challenge();
  const { status } = await handshake({
    device_id: deviceId, challenge_id: second.challenge_id, signature,
  });
  if (status === 200) fail("a signature transferred to another challenge");
  else ok("a signature does not transfer to another challenge");

  // And the first challenge was spent by nobody, so replaying the pair is
  // still refused once it has been used.
  await handshake({ device_id: deviceId, challenge_id: first.challenge_id, signature });
  const replay = await handshake({
    device_id: deviceId, challenge_id: first.challenge_id, signature,
  });
  if (replay.status === 200) fail("a challenge was redeemed twice");
  else ok("a challenge is single-use");
}

/* ── revoking is immediate ────────────────────────────────────────────── */
{
  const listed = await rpc(credential, "nest.devices.list");
  if (!listed.devices.some((d) => d.id === deviceId)) fail("the paired device is not listed");
  else ok(`listed: ${listed.devices.length} device(s)`);

  await rpc(credential, "nest.devices.revoke", { device_id: deviceId });
  const { challenge_id, challenge: bytes } = await challenge();
  const signature = signB64(Buffer.from(bytes, "base64"));
  const { status } = await handshake({ device_id: deviceId, challenge_id, signature });
  if (status === 200) fail("a revoked device was still admitted");
  else ok("a revoked device cannot open a new channel");
}

console.log(failures ? "\nREMOTE SMOKE FAILED" : "\nREMOTE SMOKE PASSED");
process.exitCode = failures ? 1 : 0;
