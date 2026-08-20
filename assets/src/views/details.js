/** Details pane: the full input and output of whatever row was opened. */

import { $, el, button, icon } from "../dom.js";
import { ICON } from "../icons.js";
import { state, subscribe } from "../state.js";
import { t } from "../i18n/index.js";
import {
  configLine, systemBlocks, systemLabel, toolLine, tools,
} from "../request.js";

export function mountDetails() {
  subscribe("detail", render);
  render();
}

function render() {
  const pane = $("details");
  const block = state.detail;
  pane.innerHTML = "";

  pane.appendChild(el("div", "head", [
    el("span", "truncate", title(block)),
    button("icon-btn close", icon(ICON.close), () => {
      $("frame").dataset.details = "closed";
    }, { title: t("common.close") }),
  ]));

  const body = el("div", "body");
  pane.appendChild(body);

  if (!block) {
    body.appendChild(el("div", "empty", t("details.empty")));
    return;
  }

  if (block.kind === "request") requestDetails(body, block);
  else toolDetails(body, block);

  if (state.detail) $("frame").dataset.details = "open";
}

function title(block) {
  if (!block) return t("details.title");
  if (block.kind === "request") return t("request.title");
  return block.name || t("details.title");
}

function labelled(body, label, text) {
  body.appendChild(el("div", "label", label));
  body.appendChild(el("pre", "", String(text == null ? "" : text)));
}

function toolDetails(body, block) {
  if (block.id) labelled(body, t("details.callId"), block.id);
  if (block.input !== undefined) {
    labelled(body, t("flow.input"), typeof block.input === "string"
      ? block.input
      : JSON.stringify(block.input, null, 2));
  }
  if (block.result != null) {
    labelled(body, block.error ? t("flow.error") : t("flow.result"), block.result);
  }
}

/** Everything the model was sent except the messages, at full length.
 *
 * Uncut on purpose: the pane exists for the reader who needs the exact text —
 * a truncated system prompt answers none of the questions that bring someone
 * here. The flow row is the place that clips. */
function requestDetails(body, block) {
  const header = block.header || {};

  body.appendChild(el("div", "note", t("request.inForce")));

  labelled(body, t("request.config"), configLine(header));
  // Which endpoint this actually went to. With `providers` configured, the
  // model name alone does not say — two providers can serve the same name.
  if (header.provider) labelled(body, t("request.provider"), header.provider);
  labelled(body, t("request.at"), t("request.turnStep", {
    turn: header.turn == null ? "?" : header.turn,
    step: header.step == null ? "?" : header.step,
  }));

  for (const [index, part] of systemBlocks(header).entries()) {
    labelled(body, systemLabel(part, index), part.text || "");
  }

  const catalog = tools(header);
  labelled(body, t("request.tools", { count: catalog.length }),
    catalog.map(toolLine).join("\n") || t("request.noTools"));
  if (catalog.length) {
    labelled(body, t("request.schemas"), JSON.stringify(
      Object.fromEntries(catalog.map((tool) => [tool.name, tool.input_schema])), null, 2));
  }

  // Only the system prompt is worth carrying the old copy of: it is the part
  // a reader diffs by eye, and the tool catalog's change already shows as a
  // different list above.
  if (block.previous && (block.change === "system" || block.change === "systemAndTools")) {
    labelled(body, t("request.previousSystem"),
      systemBlocks(block.previous).map((part) => part.text || "").join("\n\n"));
  }
}
