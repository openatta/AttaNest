// The chat path, driven through the real app: connect, create a session, send,
// watch the answer stream in, reopen it from history.
//
// What this catches is the class of failure Rust tests cannot see and a human
// notices last: a wrong element id, a typo on a hot path, an event kind the
// reducer does not handle, a node that is never swapped in. Everything below
// the DOM is real — WebSocket, hub, engine, model.
//
//   node tests/ui-smoke.mjs <port> <token>

import { loadApp } from "./dom.mjs";
import zh from "../assets/src/i18n/zh-CN.js";

/** Expected copy comes from the same dictionary the app renders from. */
const T = (key, vars) => (vars
  ? zh[key].replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
  : zh[key]);

const PORT = process.argv[2] || "4080";
const TOKEN = process.argv[3];
if (!TOKEN) {
  console.error("usage: node tests/ui-smoke.mjs <port> <token>");
  process.exit(2);
}

const { $, body, errors } = await loadApp({ token: TOKEN, port: PORT });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (sel) => body.querySelectorAll(sel);
const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
const fail = (msg) => { console.log("FAIL:", msg); process.exitCode = 1; };
const ok = (msg) => console.log("ok —", msg);
const rows = (name) => all(".row-item").filter((r) => text(r.querySelectorAll(".name")[0]) === name);
const running = () => $("send").classList.contains("stop");

await sleep(2500);
if ($("conn").className !== "on") fail(`connection state is "${$("conn").className}"`);
else ok(`connected · sidebar footer "${text($("side").querySelectorAll(".foot")[0])}"`);
ok(`sidebar rendered ${all(".srow").length} session rows`);

$("new").click();
await sleep(800);
const selects = $("modal").querySelectorAll("select");
const create = $("modal").querySelectorAll("button").find((b) => text(b) === T("common.create"));
if (!create || selects.length < 2) fail("new-session dialog is incomplete");
else {
  selects[0].value = "chat";
  if (selects[0].onchange) selects[0].onchange();
  const noProject = $("modal").querySelectorAll("button").find((b) => text(b) === T("dialog.noProjectSession"));
  if (noProject) noProject.click();
  ok("new-session dialog: scene + permission-mode selects, recents, browser");
  create.click();
}
await sleep(1500);
if ($("veil").classList.contains("on")) fail("dialog stayed open after create");

$("input").value = "Reply with exactly: ui smoke ok";
$("send").click();

let waited = 0;
let streamed = "";
while (waited < 90000) {
  await sleep(400);
  waited += 400;
  const assistant = all(".blk.a")[0];
  streamed = assistant ? assistant.innerHTML : "";
  if (streamed && !running()) break;
}

const bubbles = all(".u");
if (!bubbles.length) fail("no user bubble rendered");
else ok(`user bubble: "${text(bubbles[0]).slice(0, 40)}"`);
if (!streamed) fail("assistant block never got content");
else ok(`assistant answer: ${streamed.length} chars html — ${streamed.slice(0, 80).replace(/\s+/g, " ")}`);
if (streamed && !streamed.includes("<p>")) fail("assistant html is not markdown-rendered");
if (!text($("head")).includes("tokens")) fail(`header shows no usage: "${text($("head"))}"`);
else ok(`header after settle: "${text($("head"))}"`);

// The request envelope, read back out of the recording the engine wrote: one
// row for the whole turn however many API calls it took, carrying the system
// prompt the engine really assembled. Pulled after the turn ends rather than
// pushed, so it lands a beat after the answer does.
await sleep(400);
const envelopes = rows(T("request.title"));
if (envelopes.length !== 1) fail(`expected 1 request-envelope row, got ${envelopes.length}`);
else {
  ok(`envelope row: "${text(envelopes[0].querySelectorAll(".summary")[0])}" · ` +
     `${text(envelopes[0].querySelectorAll(".tail")[0])}`);
  envelopes[0].querySelectorAll(".row-head")[0].click();
  await sleep(60);
  const detail = rows(T("request.title"))[0]
    .querySelectorAll("button").find((b) => text(b) === T("flow.openInDetails"));
  if (!detail) fail("envelope row has no details action");
  else {
    detail.click();
    await sleep(60);
    const paneText = $("details").querySelectorAll("pre").map((p) => p.textContent).join("\n");
    const labels = $("details").querySelectorAll(".label").map((l) => text(l));
    if (paneText.length < 500) fail(`envelope details hold only ${paneText.length} chars`);
    else if (!labels.includes(T("request.schemas"))) fail(`envelope details: ${labels.join(", ")}`);
    else ok(`envelope details: ${paneText.length} chars across ${labels.length} sections`);
  }
}

// Reopening goes through history, not the live stream. The memory injection the
// engine logs as a user message must read as context, not as a second prompt.
await sleep(500);
const sessionRows = all(".srow");
(sessionRows.find((r) => r.classList.contains("on")) || sessionRows[0]).click();
await sleep(2500);
ok(`reopened from history: ${all(".u").length} user bubble(s), ${all(".blk.a").length} assistant block(s), ` +
   `${rows(T("flow.injectedContext")).length} injected-context row(s)`);
if (all(".u").length !== 1) fail(`history rendered ${all(".u").length} user bubbles for one prompt`);
if (!all(".blk.a").length) fail("history rendered no assistant block");

// The envelope is not in the transcript — `session.history` has no such
// message — so a reopened session gets it from the recording or not at all.
// This is the assertion the whole change exists for.
const reopened = rows(T("request.title"));
if (reopened.length !== 1) fail(`reopened session shows ${reopened.length} envelope rows, expected 1`);
else ok(`envelope survives a reopen: "${text(reopened[0].querySelectorAll(".tail")[0])}"`);

$("input").value = "/co";
$("input").dispatch("input");
const items = $("menu").querySelectorAll(".item");
if (!$("menu").classList.contains("on") || !items.length) fail("slash completion did not open for '/co'");
else ok(`slash completion: ${items.map((i) => text(i.querySelectorAll(".cmd")[0])).join(" ")}`);

errors.forEach(fail);
if (!errors.length) ok("no unhandled errors");
console.log(process.exitCode ? "\nCHAT UI SMOKE FAILED" : "\nCHAT UI SMOKE PASSED");
process.exit(process.exitCode || 0);
