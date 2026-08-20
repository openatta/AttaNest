import { t } from "./i18n/index.js";

/** The wire: one WebSocket carrying JSON-RPC 2.0 both ways.
 *
 * Requests are correlated by id and resolve a promise; anything without an id
 * is a server notification and goes to the subscribed handlers. A dropped
 * connection rejects everything in flight and reconnects with backoff — the
 * hub keeps the session alive across it, so reconnecting is a re-attach, not a
 * restart (see docs/architecture.md §5). */

const token = document.querySelector('meta[name="nest-token"]')?.content || "";

let socket = null;
let nextId = 1;
let attempt = 0;
const pending = new Map();
const listeners = { notify: [], status: [] };

export function onNotify(fn) {
  listeners.notify.push(fn);
}

export function onStatus(fn) {
  listeners.status.push(fn);
}

function status(state, detail) {
  for (const fn of listeners.status) fn(state, detail);
}

export function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.onopen = () => {
    attempt = 0;
    status("open");
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
    for (const [, slot] of pending) slot.reject({ message: "connection closed" });
    pending.clear();
    status("closed");
    attempt = Math.min(attempt + 1, 6);
    setTimeout(connect, 300 * attempt);
  };

  socket.onerror = () => status("error");
}

export function call(method, params) {
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

/** Fire-and-forget; used on unload where a response cannot arrive anyway. */
export function notify(method, params) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }));
  }
}

export const errorText = (e) => (e && (e.message || e.msg)) || String(e || t("error.unknown"));
