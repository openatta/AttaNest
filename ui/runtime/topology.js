/** Split streams: unary over HTTP, each subscription face on its own
 *  download-only stream.
 *
 * The client library picks this when the server serves it and not the
 * bidirectional one — behind a reverse proxy, typically, where ordinary HTTP
 * requests get the proxy's middleware and a WebSocket gets none of it.
 *
 * Everything above this file is unchanged by the choice. Method names,
 * params, error codes and event shapes are the same, and a contribution never
 * sees a connection at all. That is the whole point of fixing the semantics
 * and leaving the topology to the deployment. */

/** Establish, then open both faces.
 *
 * The handshake produces a credential and **every later channel carries it**
 * rather than negotiating again — a negotiation held twice is one that will
 * eventually produce two answers. It is also why a watcher registered by a
 * POST receives frames on a stream that is a different socket: identity comes
 * from the credential, not from whichever connection asked. */
export async function connectSplit({ token, protocolVersion, contribApiVersion, onFrame, onStatus }) {
  const handshake = await fetch("/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      protocol_version: protocolVersion,
      contrib_api_version: contribApiVersion,
      topology: "split_streams",
    }),
  }).then((r) => r.json());
  if (handshake.error) throw handshake.error;

  const credential = handshake.credential;
  const readers = [];

  // Two faces, opened separately, because they are two subscriptions even
  // when one connection carries both: watching the sidebar should not mean
  // receiving every session's body.
  for (const face of ["session", "host"]) {
    const source = new EventSource(`/events/${face}?token=${encodeURIComponent(credential)}`);
    source.onmessage = (event) => {
      try {
        onFrame(JSON.parse(event.data));
      } catch {
        // A keep-alive comment, or a frame this build does not understand.
      }
    };
    // One face dropping is not the connection dropping: the other keeps
    // running, and this one reconnects on its own. `EventSource` does that
    // reconnection itself, which is most of why this face is an SSE.
    source.onerror = () => onStatus("degraded", face);
    readers.push(source);
  }

  let nextId = 1;

  return {
    topology: "split_streams",
    negotiated: handshake,

    /** One request, one reply, over ordinary HTTP. */
    async call(method, params) {
      // An out-of-band answer goes to its own endpoint, because a
      // download-only stream has no return path. Naming it as a separate
      // semantic is what lets every topology implement it honestly.
      const endpoint = method === "session.respondToPrompt" ? "respond" : "rpc";
      const frame = await fetch(`/${endpoint}?token=${encodeURIComponent(credential)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id: nextId++ }),
      }).then((r) => r.json());
      if (frame.error) throw frame.error;
      return frame.result;
    },

    notify(method, params) {
      // No reply wanted, and `keepalive` so it still goes out from a page
      // that is unloading — which is the only place notify is used.
      fetch(`/rpc?token=${encodeURIComponent(credential)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }),
        keepalive: true,
      }).catch(() => {});
    },

    close() {
      for (const source of readers) source.close();
    },
  };
}
