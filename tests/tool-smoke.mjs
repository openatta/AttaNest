// The coding path: a real tool call, the permission card that gates it, and
// the tool row that reports it — driven through the real app.
//
// The permission card is the riskiest surface in the UI (one that renders
// wrong leaves the model waiting until it is denied by timeout), and the only
// way to exercise it live is a session whose scene actually has tools. Whether
// a given call asks depends on the rule set, so this test accepts both
// outcomes and checks whichever one happened.
//
//   node tests/tool-smoke.mjs <port> <token> [project_root]

import { loadApp } from "./dom.mjs";
import zh from "../ui/runtime/i18n/zh-CN.js";

/** Expected copy comes from the same dictionary the app renders from. */
const T = (key, vars) => (vars
  ? zh[key].replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
  : zh[key]);

const PORT = process.argv[2] || "4080";
const TOKEN = process.argv[3];
const PROJECT = process.argv[4] || process.cwd();
if (!TOKEN) {
  console.error("usage: node tests/tool-smoke.mjs <port> <token> [project_root]");
  process.exit(2);
}

const { $, body, errors } = await loadApp({ token: TOKEN, port: PORT });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (sel) => body.querySelectorAll(sel);
const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok —", m);
const running = () => $("send").classList.contains("stop");
const toolRows = () =>
  all(".row-item").filter(
    (r) => ![T("flow.injectedContext"), T("flow.compacted")].includes(text(r.querySelectorAll(".name")[0])),
  );

await sleep(2500);
if ($("conn").className !== "on") {
  fail("not connected");
  process.exit(1);
}

// A coding session on a real project root, permission mode `default`.
$("new").click();
await sleep(800);
const selects = $("modal").querySelectorAll("select");
selects[0].value = "coding";
if (selects[0].onchange) selects[0].onchange();
selects[1].value = "default";
if (selects[1].onchange) selects[1].onchange();
const useCwd = $("modal").querySelectorAll("button").find((b) => text(b).includes(PROJECT));
if (!useCwd) fail(`recents list has no row for ${PROJECT}`);
else useCwd.click();
$("modal").querySelectorAll("button").find((b) => text(b) === T("common.create")).click();
await sleep(2000);
ok(`coding session created on ${PROJECT}`);

$("input").value = "Run `ls` in the project root with the Bash tool and say how many entries it printed.";
$("send").click();

// The permission card, if the rule set asks for one.
let asked = null;
let waited = 0;
while (waited < 45000 && !asked && !toolRows().length) {
  await sleep(400);
  waited += 400;
  asked = all(".ask")[0] || null;
}
if (!asked) {
  ok("no permission card appeared (the rule set allowed the call outright)");
} else {
  const labels = asked.querySelectorAll("button").map((b) => text(b)).filter(Boolean);
  ok(`permission card: "${text(asked.querySelectorAll(".head")[0])}" · [${labels.join(" / ")}]`);
  const countdown = asked.querySelectorAll(".countdown")[0];
  if (!/\d+s/.test(text(countdown))) fail("permission card shows no countdown");
  else ok(`countdown running: ${text(countdown)}`);
  const allow = asked.querySelectorAll("button").find((b) => text(b) === T("perm.allowOnce"));
  if (!allow) fail("permission card has no allow button");
  else {
    allow.click();
    await sleep(600);
    if (!all(".ask").some((a) => a.classList.contains("done"))) {
      fail("answered permission card did not move to its answered state");
    } else ok("card marked answered after allow");
  }
}

// The tool row, from running to settled.
let row = null;
waited = 0;
while (waited < 90000) {
  await sleep(500);
  waited += 500;
  const rows = toolRows();
  row = rows[rows.length - 1] || null;
  if (row && row.dataset.state !== "running") break;
  if (!running() && waited > 20000) break;
}
if (!row) fail("no tool row rendered");
else {
  ok(`tool row: ${text(row.querySelectorAll(".name")[0])} · ` +
     `"${text(row.querySelectorAll(".summary")[0]).slice(0, 40)}" · ${row.dataset.state}`);
  if (row.dataset.state === "running") fail("tool row never left the running state");

  row.querySelectorAll(".row-head")[0].click();
  await sleep(200);
  const opened = toolRows().find((r) => r.classList.contains("open"));
  const sections = opened ? opened.querySelectorAll(".label").map((l) => text(l)) : [];
  ok(`expanded row sections: ${sections.join(", ") || "(none)"}`);
  if (!sections.includes(T("flow.input"))) fail("expanded tool row shows no input");

  const detail = opened && opened.querySelectorAll("button").find((b) => text(b) === T("flow.openInDetails"));
  if (detail) {
    detail.click();
    await sleep(200);
    if ($("frame").dataset.details !== "open") fail("details pane did not open");
    else {
      ok(`details pane: "${text($("details").querySelectorAll(".head")[0])}" · ` +
         `${$("details").querySelectorAll(".label").map((l) => text(l)).join(", ")}`);
    }
  }
}

const answer = all(".blk.a").map((a) => a.innerHTML).join("");
ok(`assistant text rendered: ${answer.length} chars`);
errors.forEach(fail);
if (!errors.length) ok("no unhandled errors");
console.log(process.exitCode ? "\nTOOL UI SMOKE FAILED" : "\nTOOL UI SMOKE PASSED");
process.exit(process.exitCode || 0);
