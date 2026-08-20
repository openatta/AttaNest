// Static checks on the styles that a rendering test cannot make.
//
// The fake DOM runs the app but applies no CSS, so a rule that never matches
// is invisible to every other test — which is how an unsized `.glyph` shipped
// as a plus sign the height of its button. These are the cheap invariants
// that would have caught it.
//
//   node tests/style-lint.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(root, "assets", "styles");
const css = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(join(stylesDir, name), "utf8"))
  .join("\n");

const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".js")) sources.push([path, readFileSync(path, "utf8")]);
  }
};
walk(join(root, "assets", "src"));

const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok —", m);

/** Does any rule give this class a width? (`.glyph`, `.mark`, …) */
function sized(className) {
  const rule = new RegExp(`\\.${className}\\b[^{]*\\{[^}]*\\bwidth\\s*:`, "s");
  return rule.test(css);
}

/* ── every icon carries at least one class that gives it a size ─────────── */
// Per call site, not per class: `icon(X, "glyph folder")` is sized by `.glyph`
// while `.folder` only switches it on and off.
const iconSites = new Set();
for (const [path, source] of sources) {
  for (const [, cls] of source.matchAll(/icon\([^,)]+,\s*"([^"]*)"\)/g)) {
    const classes = cls.trim().split(/\s+/).filter(Boolean);
    if (!classes.length) fail(`${path}: icon() with an empty class — nothing can size it`);
    else if (!classes.some(sized)) fail(`${path}: icon("${cls}") has no class with a width rule`);
    else iconSites.add(cls);
  }
}
ok(`${iconSites.size} icon call shapes, every one sized: ${[...iconSites].sort().join(" | ")}`);

/* ── no shouty uppercase on text that will be CJK ───────────────────────── */
const uppercase = [...css.matchAll(/([^}]*)text-transform:\s*uppercase/g)].length;
if (uppercase) fail(`${uppercase} rule(s) still force uppercase — it does nothing for CJK but spread it`);
else ok("no uppercase transforms");

/* ── tokens only: no raw colors outside the token sheet ─────────────────── */
const featureCss = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css") && name !== "tokens.css")
  .map((name) => [name, readFileSync(join(stylesDir, name), "utf8")]);
const rawColors = [];
for (const [name, body] of featureCss) {
  for (const [, color] of body.matchAll(/:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)) {
    // rgba() inside a shadow or a gradient is a shape, not a palette entry;
    // the palette ones are what must come from tokens.
    if (/^rgba?\(/.test(color) && /(shadow|gradient|mask)/i.test(body.slice(0, body.indexOf(color)).split("\n").slice(-6).join("\n"))) continue;
    rawColors.push(`${name}: ${color}`);
  }
}
if (rawColors.length) fail(`raw colors outside tokens.css: ${rawColors.slice(0, 6).join(", ")}`);
else ok("feature styles use tokens only");

/* ── every id the app addresses exists in the markup or is built by a view ─ */
const html = readFileSync(join(root, "assets", "index.html"), "utf8");
const declared = new Set([...html.matchAll(/\bid="([-\w]+)"/g)].map((m) => m[1]));
const created = new Set();
for (const [, source] of sources) {
  for (const [, id] of source.matchAll(/\.id\s*=\s*"([-\w]+)"/g)) created.add(id);
  for (const [, id] of source.matchAll(/\bid:\s*"([-\w]+)"/g)) created.add(id);
}
const missing = new Set();
for (const [path, source] of sources) {
  for (const [, id] of source.matchAll(/\$\("([-\w]+)"\)/g)) {
    if (!declared.has(id) && !created.has(id)) missing.add(`${path}: #${id}`);
  }
}
if (missing.size) fail(`ids addressed but never created: ${[...missing].join(", ")}`);
else ok(`${declared.size} declared + ${created.size} view-built ids, all addressable`);

console.log(process.exitCode ? "\nSTYLE LINT FAILED" : "\nSTYLE LINT PASSED");
process.exit(process.exitCode || 0);
