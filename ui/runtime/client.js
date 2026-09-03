/** The client library: five channel semantics, mapped onto one topology.
 *
 * A contribution never touches a connection. It calls `call()`, subscribes to
 * events, and the same code runs whether this deployment carries everything on
 * one bidirectional connection or splits it across several — which is the whole
 * reason the semantics are fixed and the topology is not.
 *
 * Nothing happens before the handshake. Protocol version, contribution API
 * version and topology are agreed once, up front, and a mismatch is refused
 * with a sentence saying which side is out of date. There is no silent
 * downgrade: a half-compatible interface produces bug reports nobody can act
 * on. */

import { t } from "./i18n/index.js";
import { connectSplit } from "./topology.js";

export const PROTOCOL_VERSION = 3;
export const CONTRIB_API_VERSION = 1;

const token = document.querySelector('meta[name="nest-token"]')?.content || "";

/** The topologies this bundle can speak, best first.
 *
 * Preference, not capability ranking: one bidirectional connection is fewer
 * reconnects and simpler ordering, so it is tried first, and split streams is
 * what a deployment behind a reverse proxy offers instead. The server decides
 * which it serves; the client picks from that list.
 *
 * Choosing between topologies is **not** the silent downgrade the design
 * forbids — that rule is about the protocol version and the contribution API,
 * where a mismatch means the two sides disagree about what the words mean. A
 * topology is how the words travel, and every one of them carries the same
 * ones. */
const SPEAKS = ["single_duplex", "split_streams"];

let socket = null;
let nextId = 1;
let attempt = 0;
let negotiated = null;
let refused = false;
const pending = new Map();
const listeners = { notify: [], status: [] };

export function onNotify(fn) {
  listeners.notify.push(fn);
}

export function onStatus(fn) {
  listeners.status.push(fn);
}

/** What the handshake settled: topology, versions, which subject we are. */
export function session() {
  return negotiated;
}

function status(state, detail) {
  for (const fn of listeners.status) fn(state, detail);
}

/** Which topology this connection ended up on, once the handshake settled. */
let carrier = null;

export function connect() {
  if (refused) return;
  connectDuplex();
}

/** Topology two, when the bidirectional one is not served here.
 *
 * Reached only from a refusal that names the topology — the server says which
 * ones it offers, and this tries the next one this bundle speaks. Anything
 * else the handshake refuses (a protocol version, a contribution API version)
 * is a genuine mismatch and stops here with its reason. */
async function connectSplitStreams(offered) {
  try {
    carrier = await connectSplit({
      token,
      protocolVersion: PROTOCOL_VERSION,
      contribApiVersion: CONTRIB_API_VERSION,
      onFrame: (frame) => {
        if (frame.method) {
          for (const fn of listeners.notify) fn(frame.method, frame.params || {});
        }
      },
      onStatus: (state) => status(state),
    });
    negotiated = carrier.negotiated;
    status("open");
  } catch (e) {
    refused = true;
    negotiated = null;
    status("incompatible", (e && e.message) || String(offered));
  }
}

function connectDuplex() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.onopen = async () => {
    attempt = 0;
    try {
      negotiated = await call("nest.handshake", {
        protocol_version: PROTOCOL_VERSION,
        contrib_api_version: CONTRIB_API_VERSION,
        topology: SPEAKS[0],
      });
      carrier = null;
      status("open");
    } catch (e) {
      // "This deployment does not serve that topology" is not a mismatch, it
      // is an answer: try the next one this bundle speaks.
      const message = (e && e.message) || "";
      if (message.includes("topology") && SPEAKS.includes("split_streams")) {
        socket.close();
        connectSplitStreams(message);
        return;
      }
      // Refused on purpose, with a reason. Reconnecting would only refuse
      // again — the versions cannot change while the page is open — so the
      // loop stops here and the reason stands.
      negotiated = null;
      refused = true;
      status("incompatible", e && e.message);
      socket.close();
    }
  };

  socket.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.id != null && pending.has(frame.id)) {
      const slot = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) slot.reject(frame.error);
      else slot.resolve(frame.result);
      return;
    }
    if (frame.method) {
      for (const fn of listeners.notify) fn(frame.method, frame.params || {});
    }
  };

  socket.onclose = () => {
    for (const [, slot] of pending) slot.reject({ message: t("error.connectionClosed") });
    pending.clear();
    // The connection never opened, so there was no handshake to be told
    // anything by. A deployment that does not carry this topology answers the
    // upgrade with a refusal rather than a 404 — but the browser's WebSocket
    // API does not hand the status code out, so the way to find out what is
    // offered is to ask the other endpoint.
    if (!negotiated && !refused && SPEAKS.includes("split_streams") && attempt === 0) {
      attempt = 1;
      connectSplitStreams("the bidirectional topology is not served here");
      return;
    }
    // A refused handshake is not a dropped connection. Falling through here
    // would overwrite the reason with "disconnected" and then reconnect into
    // the same refusal, which is how a clear message becomes a flicker.
    if (refused) return;
    status("closed");
    attempt = Math.min(attempt + 1, 6);
    setTimeout(connect, 300 * attempt);
  };

  socket.onerror = () => status("error");
}

/** One unary call, over whichever topology the handshake settled on. */
export function call(method, params) {
  if (carrier) return carrier.call(method, params);
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      reject({ message: t("error.notConnected") });
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id }));
  });
}

/** Fire-and-forget; used on unload, where a response cannot arrive anyway. */
export function notify(method, params) {
  if (carrier) return carrier.notify(method, params);
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }));
  }
}

/** An out-of-band answer — to a permission ask, or any other question the
 *  server asked.
 *
 * Its own semantic because a download-only event stream has no return path.
 * On the bidirectional topology it happens to travel back up the same
 * connection; on split streams it goes to its own endpoint. Callers do not
 * need to know which, and that is the point. */
export function answer(method, params) {
  return call(method, params);
}

export const errorText = (e) => (e && (e.message || e.msg)) || String(e || t("error.unknown"));
