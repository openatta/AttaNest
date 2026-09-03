/** The 24px disclosure row, shared by every contribution that draws one.
 *
 * Part of the host API's DOM helpers in spirit: a contribution that wants to
 * look like the rest of the flow uses this rather than reproducing the
 * geometry, and one that wants to look different does not have to. */

import { el, button, icon, append } from "../runtime/dom.js";
import { emit } from "../runtime/state.js";

export function row(block, spec) {
  const node = el("div", `blk row-item${block.open ? " open" : ""}`);
  if (spec.state) node.dataset.state = spec.state;

  node.appendChild(
    button(
      "row-head",
      [
        icon(spec.icon, "lead"),
        el("span", "name", spec.name),
        spec.summary ? el("span", "summary truncate", spec.summary) : null,
        spec.tail ? el("span", "tail", spec.tail) : null,
      ],
      () => {
        block.open = !block.open;
        block.rev += 1;
        emit("flow");
      },
    ),
  );

  const body = el("div", "row-body");
  for (const part of spec.body || []) append(body, part);
  if (spec.actions) append(body, el("div", "actions", spec.actions));
  node.appendChild(body);
  return node;
}

export function labelled(label, text) {
  return [el("div", "label", label), el("pre", "", String(text == null ? "" : text))];
}
