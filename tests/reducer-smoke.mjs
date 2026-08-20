// The app's reducer and rendering, against a scripted socket.
//
// No engine, no model, no network: the test *is* the server, so every event
// kind can be produced on demand — including the ones a live run reaches only
// by luck (a permission ask, a failed tool, a compaction, a sub-agent). Fast,
// deterministic, and free.
//
//   node tests/reducer-smoke.mjs

import { loadApp } from "./dom.mjs";
import zh from "../assets/src/i18n/zh-CN.js";

/** Expected copy comes from the same dictionary the app renders from. */
const T = (key, vars) => (vars
  ? zh[key].replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
  : zh[key]);

const sent = [];
let socket = null;

/** A WebSocket the test drives. Requests are answered from `answer`. */
class ScriptedSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    socket = this;
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  send(raw) {
    const request = JSON.parse(raw);
    sent.push(request);
    const result = answer(request.method, request.params || {});
    if (request.id != null && result !== undefined) {
      this.deliver({ jsonrpc: "2.0", id: request.id, result });
    }
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  deliver(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
  push(method, params) { this.deliver({ jsonrpc: "2.0", method, params }); }
}

const SID = "S-test";
let historyMessages = [];
/** What the hub would fold out of this session's recording. */
let recordedHeaders = [];

const workspaces = [{
  id: "w-1",
  path: "/tmp/project",
  title: "project",
  collapsed: false,
  session_order: [],
}];

/** The open session plus six others, so grouping and "show more" both show. */
function sessionRows() {
  const rows = [{
    session_id: SID,
    name: "测试会话",
    scene: "coding",
    project_root: "/tmp/project",
    workspace_id: "w-1",
    message_count: historyMessages.length,
    status: "active",
    running: false,
    archived: false,
    last_active: new Date().toISOString(),
  }];
  for (let i = 2; i <= 7; i += 1) {
    rows.push({
      session_id: `S-${i}`,
      name: `会话 ${i}`,
      scene: "coding",
      project_root: "/tmp/project",
      workspace_id: "w-1",
      message_count: 4,
      status: "inactive",
      running: false,
      archived: i === 7,
      last_active: new Date(Date.now() - i * 3600e3).toISOString(),
    });
  }
  return rows;
}

function answer(method, params) {
  switch (method) {
    case "nest.hello":
      return {
        protocol_version: 2,
        engine: { model: "test-model", active_scenes: ["coding"], status: {} },
        scenes: [{
          scene: "coding",
          name: "Coding",
          active: true,
          capabilities: { requires_project: true, supports_team: true },
        }],
        commands: [
          { name: "compact", description: "compact the context", source: "builtin" },
          { name: "cost", description: "show cost", source: "builtin" },
        ],
        limits: { max_frame_bytes: 16777216, max_upload_bytes: 33554432 },
        cwd: "/tmp/project",
      };
    case "nest.sessions":
      return { sessions: sessionRows(), workspaces, prefs: {} };
    case "nest.workspaces.update": {
      const workspace = workspaces.find((w) => w.id === params.id);
      if (params.collapsed !== undefined) workspace.collapsed = params.collapsed;
      if (params.title !== undefined) workspace.title = params.title;
      return { workspace };
    }
    case "nest.workspaces.reorder":
      return { workspaces };
    case "nest.workspaces.create":
      return { workspace: workspaces[0], existed: true };
    case "nest.workspaces.remove":
      return { workspaces: [] };
    case "nest.sessions.rename":
      return { session_id: params.session_id, title: params.title };
    case "nest.sessions.archive":
      return { session_id: params.session_id, archived: params.archived };
    case "nest.search":
      return {
        hits: [{ session_id: SID, name: "测试会话", role: "assistant", snippet: "…命中的那一段文字…", ts: null }],
        scanned: 7,
        truncated: false,
      };
    case "nest.attach":
      return {
        session: { session_id: SID, scene: "coding", name: "测试会话", turn_state: "idle" },
        history_total: historyMessages.length,
        replay: [],
        truncated: false,
        pending_prompts: [],
        running_turn: null,
        queue: [],
        seq: 0,
      };
    case "session.history":
      return {
        session_id: SID,
        messages: historyMessages.slice(
          params.offset || 0,
          (params.offset || 0) + (params.limit ?? 200),
        ),
        total: historyMessages.length,
      };
    case "nest.requestHeaders":
      return {
        recording: recordedHeaders.length > 0,
        headers: recordedHeaders,
        calls: recordedHeaders.length,
        auxiliary: 0,
        damaged: 0,
      };
    case "nest.send":
      return { turn_id: "t-1" };
    case "session.respondToPrompt":
      return { session_id: SID, prompt_id: params.prompt_id };
    case "nest.queue.remove":
      return { items: [] };
    case "session.interrupt":
      return { session_id: SID, interrupted: true };
    default:
      return {};
  }
}

const { $, body, errors } = await loadApp({ WebSocket: ScriptedSocket });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (sel) => body.querySelectorAll(sel);
const fail = (m) => { console.log("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok —", m);
const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
const rows = (name) => all(".row-item").filter((r) => text(r.querySelectorAll(".name")[0]) === name);

const ev = (event, turn = "t-1") =>
  socket.push("nest.event", { session_id: SID, seq: ++ev.seq, turn_id: turn, event });
ev.seq = 0;

await sleep(60);
if ($("conn").className !== "on") fail("page never reached connected state");
else ok(`connected · header "${text($("head"))}"`);
if (!all(".srow").length) fail("sidebar did not render the session");
else ok(`sidebar row: "${text(all(".srow")[0])}"`);

if (!$("hero")) fail("no empty state before a session is opened");
else ok(`empty state: "${text($("hero")).slice(0, 24)}…"`);

// Chrome that has no other test: the sidebar rail and the theme switch.
// Collapsing is three phases (fade, land, slide in), so it settles a frame
// later — the assertion waits the same way a user does.
$("side").querySelectorAll(".collapse")[0].click();
await sleep(220);
if ($("frame").dataset.sidebar !== "collapsed") fail("sidebar did not collapse to its rail");
else ok("sidebar collapses to the rail");
$("side").querySelectorAll(".collapse")[0].click();
await sleep(220);
if ($("frame").dataset.sidebar !== "expanded") fail("sidebar did not come back");

const themeButton = $("side").querySelectorAll("button").find((b) => b.title === T("app.theme"));
const before = globalThis.document.documentElement.dataset.theme;
themeButton.click();
const after = globalThis.document.documentElement.dataset.theme;
if (before === after) fail(`theme did not switch (stayed ${after})`);
else ok(`theme switches ${before} → ${after}`);

/* ── the workspace-grouped list ─────────────────────────────────────────── */
const group = all(".group")[0];
if (!group) fail("no workspace group rendered");
else {
  const title = text(group.querySelectorAll(".label")[0]);
  const count = text(group.querySelectorAll(".count")[0]);
  ok(`group "${title}" · ${count} sessions · ${group.querySelectorAll(".srow").length} rows shown`);
  if (group.querySelectorAll(".srow").length !== 5) {
    fail(`a group should page at 5 rows, showed ${group.querySelectorAll(".srow").length}`);
  }
  const more = all(".more-rows")[0];
  if (!more) fail("no show-more control for an overflowing group");
  else {
    more.click();
    await sleep(20);
    ok(`show-more expands to ${all(".group")[0].querySelectorAll(".srow").length} rows`);
    all(".more-rows")[0].click();
    await sleep(20);
  }

  all(".group")[0].querySelectorAll(".chev")[0].click();
  await sleep(30);
  const collapse = sent.filter((r) => r.method === "nest.workspaces.update").pop();
  if (!collapse || collapse.params.collapsed !== true) fail("collapsing a group sent no update");
  else ok("collapsing a group persists through nest.workspaces.update");
  if (all(".group")[0].querySelectorAll(".srow").length !== 0) fail("a collapsed group still shows rows");
  all(".group")[0].querySelectorAll(".chev")[0].click();
  await sleep(30);
}

const archived = all(".archive-toggle")[0];
if (!archived) fail("no archived toggle for an archived session");
else {
  ok(`archived toggle: "${text(archived)}"`);
  const before = Number(text(all(".group")[0].querySelectorAll(".count")[0]));
  archived.click();
  await sleep(20);
  const after = Number(text(all(".group")[0].querySelectorAll(".count")[0]));
  if (after !== before + 1) fail(`archived rows stayed hidden (${before} → ${after})`);
  else ok(`archived rows join the group when asked for (${before} → ${after})`);
  all(".archive-toggle")[0].click();
  await sleep(20);
}

const searchToggle = $("side").querySelectorAll(".section-head button").find((b) => b.title === T("sidebar.search"));
if (!searchToggle) fail("no search control in the session section header");
else {
  searchToggle.click();
  await sleep(80);
  if (!$("side").querySelectorAll(".section-head")[0].classList.contains("searching")) {
    fail("the search capsule did not open");
  } else ok("search opens from its icon in the section header");
}
$("search").value = "命中";
$("search").dispatch("keydown", { key: "Enter" });
await sleep(60);
if (!all(".srow.hit").length) fail("content search rendered no hits");
else ok(`content search: "${text(all(".srow.hit")[0].querySelectorAll(".snippet")[0])}"`);
all(".group")[0].querySelectorAll("button").find((b) => b.title === T("common.clear")).click();
await sleep(20);

all(".srow")[0].click();
await sleep(60);
ok("session opened");

/* ── streaming text ─────────────────────────────────────────────────────── */
ev({ kind: "user_message", text: "帮我改一下权限层" });
ev({ kind: "text_delta", text: "先看" });
ev({ kind: "text_delta", text: "一下现有实现。\n\n" });
ev({ kind: "text_delta", text: "## 计划\n\n- 读 `gate.rs`\n- 加一条规则\n" });
await sleep(30);

if (!all(".u").length) fail("no user bubble rendered");
else ok(`user bubble: "${text(all(".u")[0])}"`);

const assistant = all(".blk.a")[0];
if (!assistant) fail("no assistant block for text_delta");
else {
  if (!assistant.classList.contains("streaming")) fail("streaming block lacks its caret class");
  const html = assistant.innerHTML;
  if (!html.includes("<h2>计划</h2>") || !html.includes("<li>读 <code>gate.rs</code></li>")) {
    fail(`markdown not rendered as expected: ${html}`);
  } else ok(`streaming markdown intact (${html.length} chars html)`);
}

/* ── permission ask ─────────────────────────────────────────────────────── */
ev({
  kind: "prompt",
  prompt_type: "permission",
  prompt_id: "p-1",
  tool_name: "Write",
  message: "Allow Write to /tmp/project/src/gate.rs?",
  paths: ["/tmp/project/src/gate.rs"],
});
await sleep(30);
const ask = all(".ask")[0];
if (!ask) fail("no permission card rendered for a prompt event");
else {
  const labels = ask.querySelectorAll("button").map((b) => text(b)).filter(Boolean);
  const countdown = ask.querySelectorAll(".countdown")[0];
  ok(`permission card: [${labels.join(" / ")}] · ${text(countdown)}`);
  if (!/\d+s/.test(text(countdown))) fail("permission card has no countdown");
  if (!ask.querySelectorAll(".paths")[0]) fail("permission card does not show its paths");

  ask.querySelectorAll("button").find((b) => text(b) === T("perm.allowSession")).click();
  await sleep(30);
  const answered = sent.filter((r) => r.method === "session.respondToPrompt").pop();
  if (!answered) fail("answering the card sent no session.respondToPrompt");
  else if (
    answered.params.prompt_id !== "p-1" ||
    answered.params.decision.type !== "permit_always" ||
    answered.params.decision.scope !== "session"
  ) fail(`wrong decision on the wire: ${JSON.stringify(answered.params)}`);
  else ok(`answered on the wire: ${JSON.stringify(answered.params.decision)}`);
  if (!all(".ask")[0].classList.contains("done")) fail("card did not switch to answered state");
  else ok("card shows as answered");
}

/* ── tools: paired by id, not by position ───────────────────────────────── */
ev({ kind: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cargo test --workspace" } });
ev({ kind: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/tmp/project/src/gate.rs" } });
await sleep(30);
const running = all('.row-item[data-state="running"]');
if (running.length !== 2) fail(`expected 2 running rows, got ${running.length}`);
else ok(`two tool rows running: ${running.map((r) => text(r.querySelectorAll(".name")[0])).join(", ")}`);

// Out of order: the second tool finishes first.
ev({ kind: "tool_result", id: "toolu_2", name: "Read", content: "fn main() {}", is_error: false });
ev({ kind: "tool_result", id: "toolu_1", name: "Bash", content: "error: test failed", is_error: true });
await sleep(30);

const bash = rows("Bash")[0];
const read = rows("Read")[0];
if (!bash || !read) fail("tool rows missing after results");
else {
  const state = (r) => r.dataset.state;
  if (state(bash) !== "error" || state(read) !== "ok") {
    fail(`results paired wrongly: Bash=${state(bash)} Read=${state(read)}`);
  } else ok(`out-of-order results paired by tool_use_id: Bash=${state(bash)} Read=${state(read)}`);
  if (!text(bash.querySelectorAll(".summary")[0]).includes("cargo test")) {
    fail("tool row shows no argument summary");
  } else ok(`row summary: "${text(bash.querySelectorAll(".summary")[0])}"`);

  bash.querySelectorAll(".row-head")[0].click();
  await sleep(30);
  const opened = rows("Bash")[0];
  const sections = opened.querySelectorAll(".label").map((l) => text(l));
  if (!opened.classList.contains("open")) fail("clicking a tool row did not expand it");
  else if (!sections.includes(T("flow.input")) || !sections.includes(T("flow.error"))) {
    fail(`expanded row sections: ${sections.join(", ")}`);
  } else ok(`failed row expands to ${sections.join(" + ")}`);

  const detail = opened.querySelectorAll("button").find((b) => text(b) === T("flow.openInDetails"));
  if (!detail) fail("expanded row has no details action");
  else {
    detail.click();
    await sleep(30);
    if ($("frame").dataset.details !== "open") fail("details pane did not open");
    else ok(`details pane: "${text($("details").querySelectorAll(".head")[0])}" · ` +
      `${$("details").querySelectorAll(".label").map((l) => text(l)).join(", ")}`);
  }
}

/* ── the request envelope ───────────────────────────────────────────────── */
// Read out of the recording, not pushed: the hub folds every recorded call
// down to the points where the envelope changed, and a finished turn is the
// cue to go look. The three below are a session's worth — the first one, a
// tool joining the catalog, a fallback switching the model — and classifying
// the difference is still the client's job.

const LONG_PROMPT = `you are a coding agent. ${"detail ".repeat(900)}`;
const TOOLS = [
  { name: "Bash", description: "run a command", input_schema: { type: "object" }, source: "builtin" },
  { name: "Read", description: "read a file", input_schema: { type: "object" }, source: "builtin" },
];
const envelope = (over = {}) => ({
  reason: "initial",
  turn: 1,
  step: 0,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  max_tokens: 8192,
  thinking_mode: "off",
  system: [
    { role: "system", cache: "ephemeral", source: "scene", text: LONG_PROMPT },
    { role: "system", cache: null, source: "memory", text: "project: /tmp/project" },
  ],
  tools: TOOLS,
  ...over,
});

/** A turn ending is what sends the client back to the recording. */
const turnEnded = async () => {
  ev({ kind: "turn_complete", stop_reason: "end_turn", api_calls: 1, tool_calls: 0, usage: {} });
  await sleep(30);
};

recordedHeaders = [envelope()];
await turnEnded();

const requests = () => rows(T("request.title"));
const first = requests()[0];
if (!first) fail("the recorded envelope produced no row");
else {
  const summary = text(first.querySelectorAll(".summary")[0]);
  if (summary !== T("request.change.initial")) fail(`first envelope reads "${summary}"`);
  else ok(`envelope row: "${summary}" · ${text(first.querySelectorAll(".tail")[0])}`);
  if (!text(first.querySelectorAll(".tail")[0]).includes("2")) fail("envelope tail hides the tool count");

  first.querySelectorAll(".row-head")[0].click();
  await sleep(30);
  const opened = requests()[0];
  const labels = opened.querySelectorAll(".label").map((l) => text(l));
  if (!labels.includes(T("request.config"))) fail(`expanded envelope labels: ${labels.join(", ")}`);
  else if (!labels.some((l) => l.includes(T("request.cache", { marker: "ephemeral" })))) {
    fail(`no cache marker among: ${labels.join(", ")}`);
  } else ok(`envelope expands to ${labels.length} sections incl. "${labels[1]}"`);
  // The recorder annotates each block with the stage that assembled it, and
  // that is what the label should say — "系统块 2" alone identifies nothing.
  if (!labels.includes(T("request.systemBlockSource", { n: 2, source: "memory" }))) {
    fail(`no block named by its source among: ${labels.join(", ")}`);
  } else ok(`system blocks named by source: "${T("request.systemBlockSource", { n: 2, source: "memory" })}"`);
  const tally = text(opened.querySelectorAll("pre")[opened.querySelectorAll("pre").length - 1]);
  if (tally !== "2 builtin") fail(`tool sources tallied as "${tally}"`);
  else ok(`tool catalog tallied by source: ${tally}`);

  const rowText = opened.querySelectorAll("pre").map((p) => p.textContent).join("");
  if (rowText.includes(LONG_PROMPT)) fail("the flow row printed the whole system prompt uncut");
  else ok(`flow row clips the prompt (${rowText.length} of ${LONG_PROMPT.length} chars)`);

  opened.querySelectorAll("button").find((b) => text(b) === T("flow.openInDetails")).click();
  await sleep(30);
  const paneLabels = $("details").querySelectorAll(".label").map((l) => text(l));
  const paneText = $("details").querySelectorAll("pre").map((p) => p.textContent).join("");
  if (text($("details").querySelectorAll(".head")[0]) !== `${T("request.title")}${T("common.close")}`
    && !text($("details").querySelectorAll(".head")[0]).startsWith(T("request.title"))) {
    fail(`details head reads "${text($("details").querySelectorAll(".head")[0])}"`);
  }
  if (!paneText.includes(LONG_PROMPT)) fail("details pane clipped the system prompt");
  else ok("details pane carries the system prompt in full");
  if (!paneLabels.includes(T("request.schemas"))) fail(`details labels: ${paneLabels.join(", ")}`);
  else if (!paneText.includes("run a command")) fail("details pane lists no tool descriptions");
  else ok(`details pane: ${paneLabels.join(" · ")}`);
}

// The recording grows: an MCP server connects and adds a tool, then a
// fallback switches the model with everything else identical.
const WITH_GREP = [
  ...TOOLS,
  { name: "Grep", description: "search files", input_schema: { type: "object" }, source: "mcp:files" },
];
recordedHeaders = [
  envelope(),
  envelope({ reason: "changed", turn: 2, tools: WITH_GREP }),
  envelope({ reason: "changed", turn: 3, model: "claude-opus-4-6", tools: WITH_GREP }),
];
await turnEnded();

const summaries = requests().map((r) => text(r.querySelectorAll(".summary")[0]));
if (summaries.length !== 3) fail(`expected 3 envelope rows, got ${summaries.length}`);
else if (summaries[1] !== T("request.change.tools")) {
  fail(`a new tool classified as "${summaries[1]}"`);
} else if (summaries[2] !== T("request.change.config")) {
  fail(`a model switch classified as "${summaries[2]}"`);
} else ok(`envelope changes classified: ${summaries.join(" → ")}`);

// Re-reading the same recording must add nothing. The envelope is pulled
// after every turn, so a client that appended what it had already rendered
// would grow a row per turn for a session whose envelope never moved.
await turnEnded();
if (requests().length !== 3) fail(`re-reading the recording added ${requests().length - 3} rows`);
else ok("re-reading the same recording adds no rows");

// A resumed session's first call truncates its recording and starts a new
// one, so the list can be *replaced* rather than extended. Matching by
// position rather than by count is what notices.
recordedHeaders = [envelope({ turn: 1, model: "claude-haiku-4-5", tools: WITH_GREP })];
await turnEnded();
if (requests().length !== 4) fail(`a new run produced ${requests().length - 3} rows, expected 1`);
else {
  requests()[3].querySelectorAll(".row-head")[0].click();
  await sleep(30);
  const shown = requests()[3].querySelectorAll("pre").map((p) => p.textContent).join(" ");
  if (!shown.includes("claude-haiku-4-5")) fail("the new run's row does not show the model it recorded");
  else ok("a re-recorded session contributes its new envelope, not a duplicate");
}

/* ── sub-agent, compaction ──────────────────────────────────────────────── */
ev({ kind: "subagent_progress", agent_id: "ag-1", agent_label: "explore", agent_type: "Explore", event: { kind: "tool_use", id: "x", name: "Grep", input: {} } });
ev({ kind: "subagent_progress", agent_id: "ag-1", agent_label: "explore", agent_type: "Explore", event: { kind: "text_delta", text: "found 3 call sites" } });
ev({ kind: "agent_state", agent_id: "ag-1", label: "explore", state: "complete", prev: "running" });
ev({ kind: "compact", strategy: "auto", messages_before: 48, messages_after: 12, tokens_saved: 31000 });
await sleep(30);

const agent = all(".agent")[0];
if (!agent) fail("no sub-agent block rendered");
else ok(`sub-agent: "${text(agent.querySelectorAll(".lines")[0]).slice(0, 40)}" · ${text(agent.querySelectorAll(".pill")[0])}`);

const compaction = rows(T("flow.compacted"))[0];
if (!compaction) fail("compaction produced no row");
else ok(`compaction row: ${text(compaction.querySelectorAll(".summary")[0])} · ${text(compaction.querySelectorAll(".tail")[0])}`);

/* ── queue, settle, banner ──────────────────────────────────────────────── */
socket.push("nest.queue", { session_id: SID, items: [{ item_id: "q-1", message: "再顺手把测试补上" }] });
await sleep(30);
if (!all(".queue-item").length) fail("queued send not rendered");
else ok(`queue row: "${text(all(".queue-item")[0])}"`);

ev({ kind: "turn_complete", stop_reason: "end_turn", api_calls: 3, tool_calls: 2, usage: { input_tokens: 1200, output_tokens: 340 } });
socket.push("nest.turn_settled", {
  session_id: SID,
  turn_id: "t-1",
  result: { stop_reason: "end_turn", name: "改权限层", usage: { input_tokens: 1200, output_tokens: 340 } },
});
await sleep(40);
if (!text($("head")).includes("1540 tokens")) fail(`header usage reads "${text($("head"))}"`);
else ok("usage after settle: 1540 tokens");
if (all(".blk.a")[0].classList.contains("streaming")) fail("caret still showing after settle");
else ok("streaming caret cleared on settle");

socket.push("nest.daemon_event", { kind: "session_evicted", session_id: SID, reason: "idle_timeout" });
await sleep(30);
if (!$("banner").classList.contains("on")) fail("daemon event produced no banner");
else ok(`banner: "${text($("banner")).slice(0, 36)}"`);

/* ── slash completion ───────────────────────────────────────────────────── */
$("input").value = "/co";
$("input").dispatch("input");
await sleep(20);
const items = $("menu").querySelectorAll(".item");
if (!$("menu").classList.contains("on") || !items.length) fail("slash completion did not open for '/co'");
else {
  ok(`slash completion: ${items.map((i) => text(i.querySelectorAll(".cmd")[0])).join(" ")}`);
  items[0].click();
  await sleep(20);
  if ($("input").value !== "/compact ") fail(`choosing a command wrote "${$("input").value}"`);
  else ok("choosing a command fills the composer");
}

/* ── history rendering ──────────────────────────────────────────────────── */
historyMessages = [
  { role: "user", content: [{ type: "text", text: "帮我改一下权限层" }], ts: "2026-08-17T10:00:00Z" },
  { role: "user", content: [{ type: "text", text: "<system-reminder>\nRelevant memories: …\n</system-reminder>" }], ts: "2026-08-17T10:00:00Z" },
  { role: "assistant", content: [
    { type: "thinking", thinking: "内部推理", signature: "sig" },
    { type: "text", text: "改完了。" },
    { type: "tool_use", id: "toolu_9", name: "Edit", input: { file_path: "gate.rs" } },
  ], ts: "2026-08-17T10:00:05Z" },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "1 edit applied" }], is_error: false }], ts: "2026-08-17T10:00:06Z" },
];
all(".srow")[0].click();
await sleep(80);

if (all(".u").length !== 1) fail(`history rendered ${all(".u").length} user bubbles for one prompt`);
else ok("history: one user bubble");
if (rows(T("flow.injectedContext")).length !== 1) fail(`injected context rendered ${rows(T("flow.injectedContext")).length} rows`);
else ok("history: injected context as its own row");
if (!all(".think").length) fail("thinking block not rendered");
else ok("history: thinking block rendered");
const edit = rows("Edit")[0];
if (!edit || edit.dataset.state !== "ok") fail("history tool_result did not attach to its tool_use");
else ok("history: tool_result attached to its tool_use across messages");

errors.forEach(fail);
if (!errors.length) ok("no unhandled errors");
console.log(process.exitCode ? "\nREDUCER SMOKE FAILED" : "\nREDUCER SMOKE PASSED");
process.exit(process.exitCode || 0);
