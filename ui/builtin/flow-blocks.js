/** `flow.block` — a kind of block in the conversation flow.
 *
 * Every kind the product draws is a contribution here, matched on
 * `block.kind`. There is no switch statement behind this: adding a new kind of
 * block — a diff view, a chart, a domain-specific card — is a registration,
 * and the built-ins prove the point is expressive enough to build the product
 * out of.
 *
 * Evaluated on block state change. The streaming assistant block is the one
 * that moves often, and it moves by re-rendering *one* node whose revision
 * changed, not by asking every contribution what it thinks. */

import { claim, render as renderPoint } from "../runtime/contrib.js";
import { row, labelled } from "./rows.js";

export function flowBlocks(host) {
  const { t, el, icon, clip, button, markdown, ICON, state, emit } = host;

  const kind = (k, render) => ({ id: `builtin.${k}`, match: (block) => block.kind === k, render });

  return [
    // First, so it is checked *last*: `claim` searches newest-first, so a
    // catch-all registered after the specific kinds would swallow all of
    // them. An unknown kind draws as a note rather than as nothing — a blank
    // flow gives whoever is looking at it no way to find out what happened.
    {
      id: "builtin.note",
      match: () => true,
      render: (block) => el("div", `blk note${block.error ? " err" : ""}`, block.text || ""),
    },

    kind("user", (block) => el("div", "blk u-row", el("div", "u", block.text))),

    kind("assistant", (block) => {
      const node = el("div", `blk a md${block.streaming ? " streaming" : ""}`);
      node.innerHTML = markdown(block.text);
      return node;
    }),

    kind("think", (block) => {
      const node = el("div", "blk think md");
      node.innerHTML = markdown(block.text);
      return node;
    }),

    // A tool block is drawn by whichever `tool.row` contribution claims it,
    // so the two points compose rather than one shadowing the other.
    kind("tool", (block) => {
      const contribution = claim("tool.row", block);
      return contribution ? renderPoint("tool.row", contribution, block) : null;
    }),

    kind("context", (block) =>
      row(block, {
        icon: ICON.context,
        name: t("flow.injectedContext"),
        summary: clip(block.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 120),
        body: [labelled(t("flow.injectedBody"), block.text)],
      })),

    kind("compact", (block) =>
      row(block, {
        icon: ICON.compact,
        name: t("flow.compacted"),
        summary: t("flow.compactedSummary", {
          before: block.info.messages_before,
          after: block.info.messages_after,
        }),
        tail: block.info.tokens_saved
          ? t("flow.compactedSaved", { tokens: block.info.tokens_saved })
          : "",
        body: [labelled(t("flow.compactedStrategy"), String(block.info.strategy || "auto"))],
      })),

    kind("image", (block) => {
      const img = el("img");
      img.src = block.src;
      return el("div", "blk", img);
    }),

    kind("agent", (block) =>
      el("div", "blk agent", [
        el("div", "head", [
          icon(ICON.agent, "lead"),
          el("span", "tag", t("flow.subagent")),
          el("span", "truncate", block.label || ""),
          el("span", "pill", block.state || ""),
        ]),
        el(
          "div",
          "lines",
          block.lines.slice(-40).map((line) => el("div", "truncate", clip(line.text, 200))),
        ),
      ])),
  ].map((c) => ({ ...c, button, state, emit }));
}

/** `ask` and `request` need more than the DOM helpers — a permission answer
 *  is an out-of-band call, and the request envelope reads the recorded
 *  header. Registered separately so the plain kinds above stay plain. */
export function interactiveBlocks(host, deps) {
  const { t, el, icon, clip, button, ICON, state, emit } = host;
  const { row, labelled, answer, envelope } = deps;

  return [
    {
      id: "builtin.request",
      match: (block) => block.kind === "request",
      render(block) {
        const header = block.header || {};
        const body = [
          labelled(t("request.config"), envelope.configLine(header)),
          ...envelope.systemBlocks(header).map((part, index) =>
            labelled(envelope.systemLabel(part, index), clip(part.text || "", 4000))),
          labelled(
            t("request.tools", { count: envelope.tools(header).length }),
            envelope.toolNames(header),
          ),
        ];
        const sources = envelope.toolSources(header);
        if (sources) body.push(labelled(t("request.toolSources"), sources));
        return row(block, {
          icon: ICON.envelope,
          name: t("request.title"),
          summary: t(`request.change.${block.change}`),
          tail: envelope.sizeSummary(header),
          body,
          actions: button("btn sm outline", t("flow.openInDetails"), () => {
            state.detail = block;
            emit("detail");
          }),
        });
      },
    },

    {
      id: "builtin.ask",
      match: (block) => block.kind === "ask",
      render(block) {
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

        // Any client watching this session may answer, and the first answer
        // wins; a second is a silent success. So these buttons stay live on
        // every open tab rather than being disabled on all but one.
        const give = (decision, label) => answer(block, decision, label);
        node.appendChild(el("div", "actions", [
          button("btn sm primary", t("perm.allowOnce"), () =>
            give({ type: "permit" }, t("perm.decisionAllow"))),
          button("btn sm outline", t("perm.allowSession"), () =>
            give({ type: "permit_always", scope: "session" }, t("perm.decisionAllow"))),
          button("btn sm outline", t("perm.allowLocal"), () =>
            give({ type: "permit_always", scope: "local" }, t("perm.decisionAllow")),
            { title: t("perm.allowLocalHint") }),
          button("btn sm danger", t("perm.deny"), () =>
            give({ type: "deny", reason: "user denied" }, t("perm.decisionDeny"))),
          el("span", "countdown", block.left > 0 ? t("perm.countdown", { seconds: block.left }) : ""),
        ]));

        // The engine denies an unanswered ask after its timeout. Showing the
        // countdown is not decoration: without it the session looks stuck,
        // when it is actually walking towards a silent refusal.
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
            const live = document.querySelector(`[data-ask="${block.key}"] .countdown`);
            if (live) live.textContent = t("perm.countdown", { seconds: block.left });
          }, 1000);
        }
        if (block.answered && block.timer) {
          clearInterval(block.timer);
          block.timer = null;
        }
        node.dataset.ask = block.key;
        return node;
      },
    },
  ];
}
