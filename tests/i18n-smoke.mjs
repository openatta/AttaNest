// The language packs: parity between them, and the app actually rendering the
// one it was asked for.
//
// Catches the two ways i18n rots: a key added to one dictionary and not the
// other (renders as the fallback, or as the key itself), and a view that went
// back to writing a literal (the string never changes when the locale does).
//
//   node tests/i18n-smoke.mjs

import { loadApp } from "./dom.mjs";
import zh from "../ui/runtime/i18n/zh-CN.js";
import en from "../ui/runtime/i18n/en.js";

const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok —", m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── pack parity ────────────────────────────────────────────────────────── */
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));
const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
if (missingInEn.length) fail(`keys missing from en: ${missingInEn.join(", ")}`);
if (missingInZh.length) fail(`keys missing from zh-CN: ${missingInZh.join(", ")}`);
if (!missingInEn.length && !missingInZh.length) ok(`${zhKeys.size} keys, both packs complete`);

// Placeholders must match, or one locale silently drops a value.
for (const key of zhKeys) {
  if (!enKeys.has(key)) continue;
  const holders = (text) => (String(text).match(/\{(\w+)\}/g) || []).sort().join(",");
  if (holders(zh[key]) !== holders(en[key])) {
    fail(`placeholders differ for ${key}: zh "${holders(zh[key])}" vs en "${holders(en[key])}"`);
  }
}
ok("placeholders line up across packs");

// An empty string renders as nothing and reads as a bug.
for (const [pack, dictionary] of [["zh-CN", zh], ["en", en]]) {
  const blank = Object.entries(dictionary).filter(([, value]) => !String(value).trim());
  if (blank.length) fail(`${pack} has blank values: ${blank.map(([k]) => k).join(", ")}`);
}

/* ── the app renders the requested locale ──────────────────────────────── */
class QuietSocket {
  constructor() {
    this.readyState = 1;
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  send(raw) {
    const request = JSON.parse(raw);
    if (request.id == null) return;
    const result = request.method === "nest.hello"
      ? { protocol_version: 2, engine: { model: "m", active_scenes: [] }, scenes: [], commands: [], limits: {} }
      : { sessions: [], workspaces: [], prefs: {} };
    this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
  }
  close() {}
}

const app = await loadApp({ WebSocket: QuietSocket, locale: "en" });
await sleep(80);

const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
const newButton = app.$("new");
if (!newButton) fail("no new-session button rendered");
else if (!text(newButton).includes(en["sidebar.newSession"])) {
  fail(`new-session button reads "${text(newButton)}", expected the en label`);
} else ok(`en renders "${text(newButton)}"`);

const placeholder = app.$("input").placeholder;
if (placeholder !== en["composer.placeholder"]) {
  fail(`composer placeholder reads "${placeholder}"`);
} else ok(`en composer placeholder: "${placeholder}"`);

const hero = app.$("hero");
if (!hero || !text(hero).includes(en["hero.title"])) fail("empty state is not in en");
else ok("en empty state");

if (text(newButton).includes(zh["sidebar.newSession"])) fail("zh copy leaked into an en render");

// Switching locales repaints; it must not re-register anything. A leaked
// subscription shows up as a second identical node after two switches.
const { setLocale } = await import("../ui/runtime/i18n/index.js");
setLocale("zh-CN");
await sleep(30);
setLocale("en");
await sleep(30);
const inputs = app.body.querySelectorAll("textarea");
const fileListeners = (app.$("file").listeners.change || []).length;
if (inputs.length !== 1) fail(`${inputs.length} composers after two locale switches`);
else ok("one composer after two locale switches");
if (fileListeners !== 1) fail(`${fileListeners} file listeners after two locale switches`);
else ok("one file listener after two locale switches");
if (app.$("input").placeholder !== en["composer.placeholder"]) {
  fail("composer copy did not follow the locale back to en");
} else ok("composer copy follows the locale");

app.errors.forEach(fail);
if (!app.errors.length) ok("no unhandled errors");
console.log(process.exitCode ? "\nI18N SMOKE FAILED" : "\nI18N SMOKE PASSED");
process.exit(process.exitCode || 0);
