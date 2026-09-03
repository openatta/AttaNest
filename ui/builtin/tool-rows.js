/** `tool.row` — how a tool call appears in the flow.
 *
 * Evaluated when the tool block's state changes: it starts, it finishes, it
 * fails. Never per streaming delta — a dozen calls a turn is affordable for
 * any carrier, a few thousand is affordable for none.
 *
 * The built-in row is the fallback: it claims every tool, and it is
 * registered first, so anything registered later wins. That ordering is what
 * makes "give `Bash` a nicer row" a plugin someone can write without
 * replacing this file. */

import { ICON } from "../runtime/icons.js";
import { row, labelled } from "./rows.js";

/** The icon that best fits a tool's name. */
export function toolIcon(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal")) return ICON.terminal;
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return ICON.edit;
  if (n.includes("read") || n.includes("file") || n.includes("notebook")) return ICON.file;
  if (n.includes("grep") || n.includes("glob") || n.includes("search")) return ICON.search;
  if (n.includes("web") || n.includes("fetch") || n.includes("url")) return ICON.globe;
  if (n.includes("agent") || n.includes("task") || n.includes("team")) return ICON.agent;
  if (n.includes("todo") || n.includes("plan")) return ICON.check;
  return ICON.terminal;
}

/** The one argument worth showing on a single line. */
export function argumentSummary(input, clip) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input, 160);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    if (input[key]) return clip(String(input[key]).replace(/\s+/g, " "), 160);
  }
  return clip(JSON.stringify(input), 160);
}

export function toolRows(host) {
  const { t, clip, button, state, emit } = host;
  return [
    {
      id: "builtin.tool",
      // Claims everything, and is registered first so anything more specific
      // wins. A fallback that claimed nothing would leave unknown tools blank.
      match: () => true,
      render(block) {
        const status =
          block.status === "running" ? "running" : block.status === "error" ? "error" : "ok";
        const body = [];
        if (block.input !== undefined) {
          body.push(
            labelled(
              t("flow.input"),
              typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2),
            ),
          );
        }
        if (block.result != null) {
          body.push(labelled(block.error ? t("flow.error") : t("flow.result"), clip(block.result, 4000)));
        }
        return row(block, {
          icon: toolIcon(block.name),
          name: block.name || t("flow.tool"),
          summary: argumentSummary(block.input, clip),
          tail:
            status === "running"
              ? t("flow.toolRunning")
              : status === "error"
                ? t("flow.toolFailed")
                : "",
          state: status,
          body,
          actions: button("btn sm outline", t("flow.openInDetails"), () => {
            state.detail = block;
            emit("detail");
          }),
        });
      },
    },
  ];
}
