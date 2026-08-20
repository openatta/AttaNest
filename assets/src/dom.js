/** Tiny DOM helpers. No framework: every view owns its nodes and swaps them. */

import { t, currentLocale } from "./i18n/index.js";

/**
 * Build an element.
 * @param {string} tag
 * @param {string|object} [cls] class string, or a props object
 * @param {string|Node|Array} [children] text, node, or list of them
 */
export function el(tag, cls, children) {
  const node = document.createElement(tag);
  if (typeof cls === "string") node.className = cls;
  else if (cls && typeof cls === "object") Object.assign(node, cls);
  append(node, children);
  return node;
}

export function append(node, children) {
  if (children == null) return node;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

export const $ = (id) => document.getElementById(id);

export function clear(node) {
  node.innerHTML = "";
  return node;
}

/** An icon element from a raw `<svg>` string (see icons.js). */
export function icon(svg, cls) {
  const span = el("span", cls || "");
  span.innerHTML = svg;
  return span;
}

export function on(node, type, handler) {
  node.addEventListener(type, handler);
  return node;
}

export function button(cls, children, handler, attrs) {
  const b = el("button", cls, children);
  b.type = "button";
  if (attrs) Object.assign(b, attrs);
  if (handler) b.onclick = handler;
  return b;
}

export const escapeHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Middle-truncate to `n` characters, reporting what was cut. */
export function clip(text, n) {
  const s = String(text == null ? "" : text);
  return s.length > n ? `${s.slice(0, n)} … (+${s.length - n})` : s;
}

/** Human-readable relative time for session rows. */
export function ago(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return t("time.justNow");
  if (secs < 3600) return t("time.minutes", { count: Math.floor(secs / 60) });
  if (secs < 86400) return t("time.hours", { count: Math.floor(secs / 3600) });
  if (secs < 86400 * 30) return t("time.days", { count: Math.floor(secs / 86400) });
  return new Date(then).toLocaleDateString(currentLocale());
}
