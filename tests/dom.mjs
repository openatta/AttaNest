// The smallest DOM that runs the web app, shared by the tests that drive it
// headless. Renders nothing and lays nothing out; everything below it
// (WebSocket, hub, engine, model) is real.
//
// The app is a set of ES modules, so loading it is an `import()` with the
// globals it expects installed first — the same modules the browser loads, no
// bundling step and no second copy of the code.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get set() {
    return new Set(String(this.el.className || "").split(/\s+/).filter(Boolean));
  }
  write(s) {
    this.el.className = [...s].join(" ");
  }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.write(s); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.write(s); }
  toggle(c, on) {
    const s = this.set;
    const want = on === undefined ? !s.has(c) : on;
    want ? s.add(c) : s.delete(c);
    this.write(s);
  }
  contains(c) { return this.set.has(c); }
}

export class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.className = "";
    this._text = "";
    this._html = "";
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.classList = new ClassList(this);
    this.listeners = {};
    // Form controls carry a value, and assigning one moves the caret to the
    // end — both are what a browser does, and code that does caret arithmetic
    // (the composer's `/` and `@` triggers) reads exactly these.
    if (["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName)) {
      let value = "";
      Object.defineProperty(this, "value", {
        get: () => value,
        set: (next) => {
          value = next == null ? "" : String(next);
          this.selectionStart = value.length;
        },
        configurable: true,
        enumerable: true,
      });
      this.selectionStart = 0;
      this.setSelectionRange = (start) => { this.selectionStart = start; };
    }
  }
  get textContent() {
    return this._text || this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = v == null ? "" : String(v);
    this.children = [];
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    // Clearing detaches: a stale reference must not still look attached, or a
    // lookup by id will happily return a node that is no longer on the page.
    if (v === "") {
      for (const child of this.children) child.parent = null;
      this.children = [];
    }
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i >= 0 ? this.parent.children[i + 1] || null : null;
  }
  appendChild(c) {
    if (c.parent) c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs) { cs.forEach((c) => c && this.appendChild(c)); }
  insertBefore(node, ref) {
    if (node.parent) node.remove();
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  replaceWith(other) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) {
      this.parent.children[i] = other;
      other.parent = this.parent;
      this.parent = null;
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) {
    (this.listeners[type] || []).forEach((fn) =>
      fn({ preventDefault() {}, stopPropagation() {}, target: this, ...ev }));
  }
  focus() {} blur() {} scrollIntoView() {}
  click() { if (this.onclick) this.onclick({ preventDefault() {}, stopPropagation() {} }); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    let pool = this.descendants();
    parts.forEach((part, index) => {
      pool = pool.filter((e) => matches(e, part));
      if (index < parts.length - 1) pool = pool.flatMap((e) => e.descendants());
    });
    return pool;
  }
}

function matches(e, sel) {
  const m = /^([a-zA-Z]*)((?:\.[-\w]+)*)(?:\[([-\w]+)="?([^\]"]*)"?\])?$/.exec(sel);
  if (!m) return false;
  const [, tag, classes, attr, val] = m;
  if (tag && e.tagName !== tag.toUpperCase()) return false;
  for (const c of classes.split(".").filter(Boolean)) if (!e.classList.contains(c)) return false;
  if (attr) {
    const key = attr.startsWith("data-")
      ? attr.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())
      : attr;
    const have = attr.startsWith("data-") ? e.dataset[key] : e.attributes[attr] ?? e[key];
    if (String(have) !== val) return false;
  }
  return true;
}

const VOID = new Set(["br", "hr", "img", "input", "link", "meta", "source", "path", "circle", "rect"]);

/** Parse the app's static markup into a tree, keeping ids addressable. */
function buildDocument(html) {
  const byId = new Map();
  const body = new El("body");
  const head = new El("head");
  const bodyHtml = /<body>([\s\S]*)<\/body>/.exec(html)[1];
  const stack = [body];
  const token = /<(\/?)([a-zA-Z][-\w]*)((?:"[^"]*"|[^>])*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(bodyHtml))) {
    const [, closing, tag, attrs, selfClose, chunk] = m;
    const top = stack[stack.length - 1];
    if (chunk) {
      const text = chunk.trim();
      if (text) top._text = (top._text || "") + text;
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new El(tag);
    for (const [, key, value] of attrs.matchAll(/([-\w]+)="([^"]*)"/g)) {
      if (key === "class") node.className = value;
      else if (key === "id") { node.id = value; byId.set(value, node); }
      else if (key.startsWith("data-")) {
        node.dataset[key.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      } else node.attributes[key] = value;
    }
    top.appendChild(node);
    if (!selfClose && !VOID.has(tag.toLowerCase())) stack.push(node);
  }
  return { byId, body, head };
}

/**
 * Install a document and run the app's real modules in it.
 * @param {object} options
 * @param {string} options.token the token the page would have been served with
 * @param {number|string} options.port where the server listens
 * @param {Function} [options.WebSocket] a socket class for offline tests
 * @returns {Promise<{byId: Map, body: El, $: Function, errors: string[]}>}
 */
export async function loadApp({ token = "T", port = "0", WebSocket: socket, locale = "zh-CN" } = {}) {
  const html = readFileSync(join(root, "ui", "index.html"), "utf8");
  const { byId, body, head } = buildDocument(html);

  const meta = new El("meta");
  meta.attributes.name = "nest-token";
  meta.content = token;
  head.appendChild(meta);

  // Views create ids at runtime (the header's connection pill, the composer's
  // controls), so a lookup falls back to a tree scan the way a browser does
  // rather than only answering for ids present in the static markup.
  const attached = (node) => {
    for (let cursor = node; cursor; cursor = cursor.parent) if (cursor === body) return true;
    return false;
  };
  const findById = (id) => {
    const known = byId.get(id);
    if (known && attached(known)) return known;
    const found = body.descendants().find((node) => node.id === id);
    if (found) byId.set(id, found);
    return found || null;
  };

  const doc = {
    body,
    head,
    documentElement: new El("html"),
    getElementById: findById,
    createElement: (tag) => new El(tag),
    createTextNode: (text) => {
      const node = new El("#text");
      node._text = String(text);
      return node;
    },
    addEventListener: (type, fn) => body.addEventListener(type, fn),
    querySelector: (sel) => (sel === 'meta[name="nest-token"]' ? meta : body.querySelector(sel)),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };

  const errors = [];
  globalThis.document = doc;
  globalThis.location = { protocol: "http:", host: `127.0.0.1:${port}`, search: "", href: "/" };
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  // Seeded before the app loads: `navigator` does not exist here, so without a
  // stored choice the app would resolve English and every assertion would be
  // testing the fallback rather than the requested locale.
  globalThis.localStorage = {
    store: new Map(locale ? [["nest.locale", locale]] : []),
    getItem(k) { return this.store.get(k) ?? null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); },
  };
  globalThis.getComputedStyle = () => ({ backgroundColor: "rgb(255,255,255)" });
  globalThis.confirm = () => true;
  if (socket) globalThis.WebSocket = socket;
  // Recorded *and* printed: a swallowed failure exits 0 with no output, which
  // is indistinguishable from a test that never ran.
  const record = (label) => (e) => {
    const detail = e && e.stack ? e.stack : String(e);
    errors.push(`${label}: ${e && e.message ? e.message : e}`);
    console.error(`${label}:`, detail);
    process.exitCode = 1;
  };
  process.on("unhandledRejection", record("unhandled rejection"));
  process.on("uncaughtException", record("uncaught exception"));

  // Cache-busted so repeated loads in one process get fresh module state.
  const entry = pathToFileURL(join(root, "ui", "main.js"));
  try {
    await import(`${entry.href}?t=${Date.now()}`);
  } catch (e) {
    // Loud: a swallowed load failure exits 0 with no output, which reads as
    // "the test did not run" and is exactly what a broken import looks like.
    console.error("the app failed to load:", e && e.stack ? e.stack : e);
    process.exit(1);
  }

  return { byId, body, errors, $: findById, doc };
}
