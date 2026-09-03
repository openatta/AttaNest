/** Nest's interface, assembled out of named registrations.
 *
 * Every tool row, flow block, details panel, sidebar grouping, command and
 * settings section arrives through the registry. Nothing has a private
 * channel, and that is what makes the seams real: a seam the product itself
 * routes around is one that exists only in the catalog, and everything would
 * still work while it quietly did not. */

import { register } from "../runtime/contrib.js";
import { hostApi } from "../runtime/host.js";

import { toolRows } from "./tool-rows.js";
import { row, labelled } from "./rows.js";
import * as envelope from "../runtime/request.js";
import { answerPrompt } from "../shell/session.js";
import { flowBlocks, interactiveBlocks } from "./flow-blocks.js";
import { detailsPanels } from "./details-panels.js";
import { sidebarGroups } from "./sidebar-groups.js";
import { commands } from "./commands.js";
import { settingsSections } from "./settings-sections.js";

export function registerBuiltins(reachable) {
  const host = hostApi("builtin", reachable);
  const all = [
    ["tool.row", toolRows(host)],
    // Order matters: the plain kinds first, the two that need more than the
    // DOM helpers after them, and the catch-all note last within `flowBlocks`.
    // Later registrations win a match, which is what lets a plugin take over a
    // kind the product already draws.
    ["flow.block", [
      ...flowBlocks(host),
      ...interactiveBlocks(host, { row, labelled, answer: answerPrompt, envelope }),
    ]],
    ["details.panel", detailsPanels(host)],
    ["sidebar.group", sidebarGroups(host)],
    ["command", commands(host)],
    ["settings.section", settingsSections(host)],
  ];
  for (const [point, contributions] of all) {
    for (const contribution of contributions) {
      register(point, { ...contribution, owner: "builtin" });
    }
  }
  return host;
}
