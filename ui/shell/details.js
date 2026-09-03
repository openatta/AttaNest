/** The details column: chrome, selection, and whoever claims the selection.
 *
 * This file owns the pane, not the page in it. What a selected item looks
 * like belongs to the `details.panel` contribution point, so a plugin adding
 * a panel for its own kind of row does exactly what the built-in panels do. */

import { $, el, button, icon } from "../runtime/dom.js";
import { ICON } from "../runtime/icons.js";
import { claim, render as renderPoint } from "../runtime/contrib.js";
import { state, subscribe } from "../runtime/state.js";
import { t } from "../runtime/i18n/index.js";

export function mountDetails() {
  subscribe("detail", render);
  render();
}

function render() {
  const pane = $("details");
  const block = state.detail;
  pane.innerHTML = "";

  const contribution = block ? claim("details.panel", block) : null;

  pane.appendChild(el("div", "head", [
    el("span", "truncate", title(block, contribution)),
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

  // Nothing claimed it, or the claim threw. Either way the pane says so
  // rather than going blank: an empty panel gives the reader no way to find
  // out what happened, and the registry has already recorded which
  // contribution failed and why.
  const page = contribution ? renderPoint("details.panel", contribution, block) : null;
  if (page) body.appendChild(page);
  else body.appendChild(el("div", "empty", t("details.noPanel")));

  if (state.detail) $("frame").dataset.details = "open";
}

function title(block, contribution) {
  if (!block) return t("details.title");
  if (contribution && typeof contribution.title === "function") {
    try {
      return contribution.title(block);
    } catch {
      // A title that throws must not take the pane with it.
    }
  }
  return block.name || t("details.title");
}
