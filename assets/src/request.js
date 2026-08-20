/** Reading a request envelope: the shared formatting for the flow row and the
 *  details pane.
 *
 * The envelope is what the model was sent minus the messages: the assembled
 * system blocks, the whole tool catalog, and the call configuration. It comes
 * from `nest.requestHeaders`, which folds the engine's recording down to the
 * points where it changed. Both surfaces present the same facts at different
 * depths, so the wording of a fact lives here rather than twice. */

import { t } from "./i18n/index.js";

export function systemBlocks(header) {
  return (header && header.system) || [];
}

export function tools(header) {
  return (header && header.tools) || [];
}

/** Bytes of system prompt — the number that says how big this thing is. */
export function systemBytes(header) {
  return systemBlocks(header).reduce((total, block) => total + (block.text || "").length, 0);
}

export function sizeSummary(header) {
  return t("request.size", {
    kb: (systemBytes(header) / 1024).toFixed(1),
    tools: tools(header).length,
  });
}

export function configLine(header) {
  return t("request.configLine", {
    model: header.model || "?",
    max: header.max_tokens || 0,
    thinking: thinkingLabel(header.thinking_mode),
  });
}

/** `thinking_mode` is a bare string (`off`) or a tagged object (`on_budget`). */
function thinkingLabel(mode) {
  if (mode == null) return "?";
  if (typeof mode === "string") return mode;
  const [name, value] = Object.entries(mode)[0] || [];
  return value === undefined ? String(name) : `${name} ${JSON.stringify(value)}`;
}

/** `System 2 · skills · cache ephemeral`.
 *
 * The source, when the recording carries one, replaces the role: every block
 * is a system block, and which stage assembled it is the thing a numbered
 * list cannot say. Counting blocks does not identify them — rules, MCP and
 * `prompt_append` are each optional, so position shifts with configuration. */
export function systemLabel(block, index) {
  const head = block.source
    ? t("request.systemBlockSource", { n: index + 1, source: block.source })
    : t("request.systemBlock", { n: index + 1, role: block.role || "system" });
  return block.cache ? `${head} · ${t("request.cache", { marker: block.cache })}` : head;
}

export function toolNames(header) {
  const names = tools(header).map((tool) => tool.name);
  return names.length ? names.join(", ") : t("request.noTools");
}

/** `28 builtin · 3 mcp:files` — where a catalog of thirty tools came from.
 *
 * The tally rather than the list: a tool catalog changing is usually an MCP
 * server connecting or a plugin loading, and the count per source says that
 * in one line where thirty names say it in none. */
export function toolSources(header) {
  const tally = new Map();
  for (const tool of tools(header)) {
    const source = tool.source || t("request.sourceUnknown");
    tally.set(source, (tally.get(source) || 0) + 1);
  }
  return [...tally].map(([source, count]) => `${count} ${source}`).join(" · ");
}

/** `Bash · builtin — Run a shell command` */
export function toolLine(tool) {
  const head = tool.source ? `${tool.name} · ${tool.source}` : tool.name;
  return tool.description ? `${head} — ${tool.description}` : head;
}
