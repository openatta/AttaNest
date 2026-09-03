/** The flow: one node per block, re-rendered only when its `rev` moves.
 *
 * This file owns the list and the scroll, not the drawing. What a block looks
 * like belongs to the `flow.block` contribution point, which is how a plugin
 * can add a kind of block without this file knowing it exists. */

import { $, el, button, icon } from "../runtime/dom.js";
import { ICON } from "../runtime/icons.js";
import { claim, render as renderPoint } from "../runtime/contrib.js";
import { state, subscribe, emit } from "../runtime/state.js";
import { t } from "../runtime/i18n/index.js";

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

/** Draw one block by asking the `flow.block` point who claims it.
 *
 * There is no switch here on purpose. Every kind the product draws is a
 * registered contribution — see `ui/builtin/flow-blocks.js` — so a new kind of
 * block is a registration rather than an edit to this file, and the built-ins
 * exercise the same path a plugin takes.
 *
 * A contribution that throws loses its own block and nothing else; the point
 * records it, and the diagnostics panel can say which one and why. */
function renderBlock(block) {
  const contribution = claim("flow.block", block);
  if (!contribution) return el("div", "blk note", "");
  const node = renderPoint("flow.block", contribution, block);
  return node || el("div", "blk note err", t("flow.blockFailed", { owner: contribution.owner }));
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
