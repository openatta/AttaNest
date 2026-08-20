/** The flow: one node per block, re-rendered only when its `rev` moves. */

import { $, el, button, icon, clip, append } from "../dom.js";
import { ICON, toolIcon } from "../icons.js";
import { markdown } from "../markdown.js";
import {
  configLine, sizeSummary, systemBlocks, systemLabel, toolNames, toolSources, tools,
} from "../request.js";
import { state, subscribe, emit } from "../state.js";
import { answerPrompt } from "../session.js";
import { t } from "../i18n/index.js";

const rendered = new Map(); // block.key → { rev, node }

export function mountConversation() {
  subscribe("flow", render);
  subscribe("session", renderHeader);
  subscribe("connection", renderHeader);
  subscribe("turn", renderHeader);
  render();
  renderHeader();
}

function render() {
  const flow = $("flow");
  const main = $("main");
  main.classList.toggle("empty", !state.sessionId || state.blocks.length === 0);

  if (!state.sessionId) {
    if (!flow.querySelector("#hero")) {
      flow.innerHTML = "";
      rendered.clear();
      flow.appendChild(heroBlock());
    }
    return;
  }

  const heroNode = flow.querySelector("#hero");
  if (heroNode) {
    flow.innerHTML = "";
    rendered.clear();
  }

  const keys = new Set();
  let previous = null;
  for (const block of state.blocks) {
    keys.add(block.key);
    const known = rendered.get(block.key);
    if (known && known.rev === block.rev) {
      previous = known.node;
      continue;
    }
    const node = renderBlock(block);
    if (known) {
      known.node.replaceWith(node);
    } else if (previous && previous.nextSibling) {
      flow.insertBefore(node, previous.nextSibling);
    } else if (previous) {
      flow.appendChild(node);
    } else {
      flow.insertBefore(node, flow.firstChild);
    }
    rendered.set(block.key, { rev: block.rev, node });
    previous = node;
  }

  for (const [key, entry] of rendered) {
    if (!keys.has(key)) {
      entry.node.remove();
      rendered.delete(key);
    }
  }

  autoScroll();
}

let pinnedToBottom = true;

export function watchScroll() {
  const scroll = $("scroll");
  scroll.addEventListener("scroll", () => {
    pinnedToBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
  });
}

function autoScroll() {
  if (!pinnedToBottom) return;
  const scroll = $("scroll");
  scroll.scrollTop = scroll.scrollHeight;
}

export function scrollToBottom() {
  pinnedToBottom = true;
  autoScroll();
}

/* ── blocks ───────────────────────────────────────────────────────────── */

function renderBlock(block) {
  switch (block.kind) {
    case "user":
      return el("div", "blk u-row", el("div", "u", block.text));
    case "assistant": {
      const node = el("div", `blk a md${block.streaming ? " streaming" : ""}`);
      node.innerHTML = markdown(block.text);
      return node;
    }
    case "think": {
      const node = el("div", "blk think md");
      node.innerHTML = markdown(block.text);
      return node;
    }
    case "tool":
      return toolBlock(block);
    case "context":
      return rowBlock(block, {
        icon: ICON.context,
        name: t("flow.injectedContext"),
        summary: clip(block.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 120),
        body: [labelled(t("flow.injectedBody"), block.text)],
      });
    case "compact":
      return rowBlock(block, {
        icon: ICON.compact,
        name: t("flow.compacted"),
        summary: t("flow.compactedSummary", { before: block.info.messages_before, after: block.info.messages_after }),
        tail: block.info.tokens_saved ? t("flow.compactedSaved", { tokens: block.info.tokens_saved }) : "",
        body: [labelled(t("flow.compactedStrategy"), String(block.info.strategy || "auto"))],
      });
    case "request":
      return requestBlock(block);
    case "ask":
      return askBlock(block);
    case "agent":
      return agentBlock(block);
    case "image": {
      const img = el("img");
      img.src = block.src;
      return el("div", "blk", img);
    }
    case "note":
    default:
      return el("div", `blk note${block.error ? " err" : ""}`, block.text || "");
  }
}

function labelled(label, text) {
  return [el("div", "label", label), el("pre", "", String(text == null ? "" : text))];
}

/** The 24px disclosure row shared by tools, injected context and compaction. */
function rowBlock(block, spec) {
  const node = el("div", `blk row-item${block.open ? " open" : ""}`);
  if (spec.state) node.dataset.state = spec.state;

  const head = button("row-head", [
    icon(spec.icon, "lead"),
    el("span", "name", spec.name),
    spec.summary ? el("span", "summary truncate", spec.summary) : null,
    spec.tail ? el("span", "tail", spec.tail) : null,
  ], () => {
    block.open = !block.open;
    block.rev += 1;
    emit("flow");
  });
  node.appendChild(head);

  const body = el("div", "row-body");
  for (const part of spec.body || []) append(body, part);
  if (spec.actions) append(body, el("div", "actions", spec.actions));
  node.appendChild(body);
  return node;
}

function toolBlock(block) {
  const status =
    block.status === "running" ? "running" : block.status === "error" ? "error" : "ok";
  const body = [];
  if (block.input !== undefined) {
    body.push(labelled(t("flow.input"), typeof block.input === "string"
      ? block.input
      : JSON.stringify(block.input, null, 2)));
  }
  if (block.result != null) {
    body.push(labelled(block.error ? t("flow.error") : t("flow.result"), clip(block.result, 4000)));
  }
  return rowBlock(block, {
    icon: toolIcon(block.name),
    name: block.name || t("flow.tool"),
    summary: argumentSummary(block.input),
    tail: status === "running" ? t("flow.toolRunning") : status === "error" ? t("flow.toolFailed") : "",
    state: status,
    body,
    actions: button("btn sm outline", t("flow.openInDetails"), () => {
      state.detail = block;
      emit("detail");
    }),
  });
}

/** The envelope as a ledger row: what changed, how big, what is in it. */
function requestBlock(block) {
  const header = block.header || {};
  const body = [
    labelled(t("request.config"), configLine(header)),
    ...systemBlocks(header).map((part, index) =>
      labelled(systemLabel(part, index), clip(part.text || "", 4000))),
    labelled(t("request.tools", { count: tools(header).length }), toolNames(header)),
  ];
  const sources = toolSources(header);
  if (sources) body.push(labelled(t("request.toolSources"), sources));
  return rowBlock(block, {
    icon: ICON.envelope,
    name: t("request.title"),
    summary: t(`request.change.${block.change}`),
    tail: sizeSummary(header),
    body,
    actions: button("btn sm outline", t("flow.openInDetails"), () => {
      state.detail = block;
      emit("detail");
    }),
  });
}

function argumentSummary(input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input, 160);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    if (input[key]) return clip(String(input[key]).replace(/\s+/g, " "), 160);
  }
  return clip(JSON.stringify(input), 160);
}

function askBlock(block) {
  const prompt = block.prompt || {};
  const node = el("div", `blk ask${block.answered ? " done" : ""}`);

  node.appendChild(el("div", "head", [
    icon(block.answered ? ICON.check : ICON.shield, "lead"),
    el("span", "", block.answered
      ? t("perm.answered", { decision: block.answered, tool: prompt.tool_name || "" })
      : t("perm.request", { tool: prompt.tool_name || "" })),
  ]));
  if (prompt.message) node.appendChild(el("div", "msg", prompt.message));
  if (prompt.paths && prompt.paths.length) {
    node.appendChild(el("div", "paths", prompt.paths.join("\n")));
  }

  const answer = (decision, label) => answerPrompt(block, decision, label);
  const actions = el("div", "actions", [
    button("btn sm primary", t("perm.allowOnce"), () => answer({ type: "permit" }, t("perm.decisionAllow"))),
    button("btn sm outline", t("perm.allowSession"), () =>
      answer({ type: "permit_always", scope: "session" }, t("perm.decisionAllow"))),
    button("btn sm outline", t("perm.allowLocal"), () =>
      answer({ type: "permit_always", scope: "local" }, t("perm.decisionAllow")), {
      title: t("perm.allowLocalHint"),
    }),
    button("btn sm danger", t("perm.deny"), () => answer({ type: "deny", reason: "user denied" }, t("perm.decisionDeny"))),
    el("span", "countdown", block.left > 0 ? t("perm.countdown", { seconds: block.left }) : ""),
  ]);
  node.appendChild(actions);

  if (!block.answered && !block.timer) {
    block.timer = setInterval(() => {
      block.left -= 1;
      if (block.answered || block.left <= 0) {
        clearInterval(block.timer);
        block.timer = null;
        if (!block.answered) {
          block.answered = t("perm.decisionTimeout");
          block.rev += 1;
          emit("flow");
        }
        return;
      }
      const node = document.querySelector(`[data-ask="${block.key}"] .countdown`);
      if (node) node.textContent = t("perm.countdown", { seconds: block.left });
    }, 1000);
  }
  if (block.answered && block.timer) {
    clearInterval(block.timer);
    block.timer = null;
  }
  node.dataset.ask = block.key;
  return node;
}

function agentBlock(block) {
  return el("div", "blk agent", [
    el("div", "head", [
      icon(ICON.agent, "lead"),
      el("span", "tag", t("flow.subagent")),
      el("span", "truncate", block.label || ""),
      el("span", "pill", block.state || ""),
    ]),
    el("div", "lines", block.lines.slice(-40).map((line) => el("div", "truncate", clip(line.text, 200)))),
  ]);
}

function heroBlock() {
  const node = el("div", "");
  node.id = "hero";
  node.appendChild(icon(ICON.brand, "mark"));
  node.appendChild(el("h1", "", t("hero.title")));
  node.appendChild(el("p", "", t("hero.body")));
  return node;
}

/* ── header ───────────────────────────────────────────────────────────── */

function renderHeader() {
  const head = $("head");
  head.innerHTML = "";
  if (!state.sessionId) {
    head.appendChild(el("div", "title truncate", t("app.title")));
  } else {
    const session = state.session || {};
    head.appendChild(el("div", "title truncate", session.name || t("sidebar.untitled")));
    const meta = el("div", "meta", [
      session.scene ? el("span", "pill", session.scene) : null,
      state.usage
        ? el("span", "pill", `${(state.usage.input_tokens || 0) + (state.usage.output_tokens || 0)} tokens`)
        : null,
    ]);
    head.appendChild(meta);
  }

  head.appendChild(el("div", "spacer"));

  const conn = el("div", "", [el("span", "dot"), el("span", "label", connectionLabel())]);
  conn.id = "conn";
  conn.className = state.connection === "open" ? "on" : state.connection === "connecting" ? "" : "off";
  head.appendChild(conn);

  head.appendChild(button("icon-btn", icon(ICON.details), () => {
    const frame = $("frame");
    const open = frame.dataset.details === "open";
    frame.dataset.details = open ? "closed" : "open";
  }, { title: t("app.details") }));
}

function connectionLabel() {
  if (state.connection === "open") return t("conn.open");
  if (state.connection === "connecting") return t("conn.connecting");
  return t("conn.closed");
}
