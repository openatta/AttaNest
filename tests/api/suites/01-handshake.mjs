// The handshake, and what happens without one.
//
// Nothing may be called before it, and a mismatch is refused with a reason
// rather than downgraded — a half-compatible client produces bug reports
// nobody can act on.

import { connect } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "the handshake reports what was agreed": async ({ client }) => {
      const { protocol_version, contrib_api_version, topology, channels } = client.handshake;
      assert(protocol_version === 3, `protocol ${protocol_version}`);
      assert(contrib_api_version === 1, `contrib api ${contrib_api_version}`);
      assert(topology === client.topology, `got ${topology}, asked for ${client.topology}`);
      // Five semantics, named, whatever carries them.
      assert(channels.length === 5, `${channels.length} channels`);
    },

    "a wrong protocol version is refused, saying which side is stale": async ({ backend }) => {
      const raw = await rawHandshake(backend, { protocol_version: 99 });
      assert(raw.error, "a protocol version of 99 was accepted");
      assert(/out of date/.test(raw.error.message), `unhelpful message: ${raw.error.message}`);
      assert(/99|3/.test(raw.error.message), "the message names neither version");
    },

    "a topology this deployment does not serve is refused by name": async ({ backend }) => {
      const raw = await rawHandshake(backend, { topology: "request_only" });
      assert(raw.error, "an unserved topology was accepted");
      assert(/request_only/.test(raw.error.message), `does not name it: ${raw.error.message}`);
      assert(/single_duplex|split_streams/.test(raw.error.message), "does not say what is offered");
    },

    "nothing is callable before the handshake": async ({ backend, client }) => {
      if (client.topology !== "single_duplex") return; // split streams has no pre-handshake wire
      const ws = new WebSocket(
        `ws://127.0.0.1:${backend.port}/ws?token=${encodeURIComponent(backend.token)}`);
      await new Promise((r) => { ws.onopen = r; });
      const answer = await new Promise((resolve) => {
        ws.onmessage = (e) => resolve(JSON.parse(e.data));
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "nest.hello", params: {}, id: 1 }));
      });
      ws.close();
      assert(answer.error, "nest.hello answered before the handshake");
      assert(/handshake/.test(answer.error.message), `unhelpful: ${answer.error.message}`);
    },

    "a second handshake on one connection is refused": async ({ client }) => {
      if (client.topology !== "single_duplex") return;
      const again = await client.refused("nest.handshake", {
        protocol_version: 3, contrib_api_version: 1, topology: "single_duplex",
      });
      assert(again, "a second handshake was accepted");
      assert(/two answers|already/.test(again.message), `unhelpful: ${again.message}`);
    },

    "a bad token never reaches the handshake": async ({ backend }) => {
      const response = await fetch(`http://127.0.0.1:${backend.port}/handshake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong", protocol_version: 3, contrib_api_version: 1,
          topology: "split_streams" }),
      });
      assert(response.status === 401, `status ${response.status}`);
    },

    "two clients can be connected at once": async ({ backend, client }) => {
      const second = await connect(backend, { topology: client.topology });
      assert(second.handshake.protocol_version === 3, "the second client did not handshake");
      second.close();
    },
  },
};

async function rawHandshake(backend, overrides) {
  const body = {
    token: backend.token, protocol_version: 3, contrib_api_version: 1,
    topology: "single_duplex", ...overrides,
  };
  if (body.topology === "split_streams") {
    return fetch(`http://127.0.0.1:${backend.port}/handshake`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
  }
  const ws = new WebSocket(
    `ws://127.0.0.1:${backend.port}/ws?token=${encodeURIComponent(backend.token)}`);
  await new Promise((r) => { ws.onopen = r; });
  const answer = await new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "nest.handshake", params: body, id: 1 }));
  });
  ws.close();
  return answer;
}
