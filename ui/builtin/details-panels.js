/** `details.panel` — a page in the details column.
 *
 * Evaluated when the selection changes: a click, not a stream.
 *
 * These are the real panels the product ships. The shell asks the registry
 * who claims the selected item and draws the answer, so a plugin adding a
 * panel for its own kind of row is the same operation Nest performs here —
 * and a plugin replacing one of these is a later registration, not a fork. */

import { toolIcon } from "./tool-rows.js";

export function detailsPanels(host) {
  const { t, el, ICON, icon } = host;
  const envelope = host.envelope;

  const labelled = (body, label, text) => {
    body.appendChild(el("div", "label", label));
    body.appendChild(el("pre", "", String(text == null ? "" : text)));
  };

  return [
    {
      id: "builtin.tool",
      match: (item) => item && item.kind === "tool",
      title: (item) => item.name || t("details.title"),
      render(block) {
        const body = el("div", "");
        body.appendChild(el("div", "panel-head", [
          icon(toolIcon(block.name), "lead"),
          el("span", "", block.name || t("flow.tool")),
        ]));
        if (block.id) labelled(body, t("details.callId"), block.id);
        if (block.input !== undefined) {
          labelled(body, t("flow.input"), typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2));
        }
        if (block.result != null) {
          labelled(body, block.error ? t("flow.error") : t("flow.result"), block.result);
        }
        return body;
      },
    },

    {
      id: "builtin.request",
      match: (item) => item && item.kind === "request",
      title: () => t("request.title"),
      /** Everything the model was sent except the messages, at full length.
       *
       * Uncut on purpose: this pane exists for the reader who needs the exact
       * text, and a truncated system prompt answers none of the questions
       * that bring someone here. The flow row is the place that clips. */
      render(block) {
        const header = block.header || {};
        const body = el("div", "");
        body.appendChild(el("div", "panel-head", [
          icon(ICON.envelope, "lead"),
          el("span", "", t("request.title")),
        ]));
        body.appendChild(el("div", "note", t("request.inForce")));

        labelled(body, t("request.config"), envelope.configLine(header));
        // Which endpoint this actually went to. With `providers` configured
        // the model name alone does not say — two providers can serve one
        // name.
        if (header.provider) labelled(body, t("request.provider"), header.provider);
        labelled(body, t("request.at"), t("request.turnStep", {
          turn: header.turn == null ? "?" : header.turn,
          step: header.step == null ? "?" : header.step,
        }));

        for (const [index, part] of envelope.systemBlocks(header).entries()) {
          labelled(body, envelope.systemLabel(part, index), part.text || "");
        }

        const catalog = envelope.tools(header);
        labelled(body, t("request.tools", { count: catalog.length }),
          catalog.map(envelope.toolLine).join("\n") || t("request.noTools"));
        if (catalog.length) {
          labelled(body, t("request.schemas"), JSON.stringify(
            Object.fromEntries(catalog.map((tool) => [tool.name, tool.input_schema])), null, 2));
        }

        // Only the system prompt is worth carrying the old copy of: it is the
        // part a reader diffs by eye, and a changed tool catalog already
        // shows as a different list above.
        if (block.previous && (block.change === "system" || block.change === "systemAndTools")) {
          labelled(body, t("request.previousSystem"),
            envelope.systemBlocks(block.previous).map((part) => part.text || "").join("\n\n"));
        }
        return body;
      },
    },
  ];
}
