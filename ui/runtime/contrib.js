/** The seven seams the interface is assembled out of.
 *
 * Every tool row, flow block, panel, sidebar grouping, command and settings
 * section is a named registration, so the shell asks a registry rather than
 * knowing every case — and replacing the whole interface means replacing
 * registrations instead of editing switch statements.
 *
 * **An installed package can register here too.** Not through a second plugin
 * system: the package is AttaCore's, installed by AttaCore, and this reads
 * one section of it that AttaCore ignores. One package, one manifest, one
 * install, one disclosure.
 *
 * The trust level is the page's, and saying so plainly is the point. A
 * contributed module is same-origin, and no browser mechanism makes it
 * smaller than the page it is in: the CSP stops external sources, inline
 * script and going out, and does not stop a module that was already allowed
 * to load from doing what the page can do. What constrains this layer is
 * disclosure, admission checks, revocability and audit — **not isolation**.
 * A non-isolation relied on as isolation is more dangerous than a place
 * everybody knows is not isolated.
 *
 * Seven is part of the design: an eighth is an argument to be made, not a
 * commit to be pushed. `docs/contribution_points.md` is the catalog, and it
 * is generated from the backend so it cannot go stale.
 *
 * **Frequency is a rule, not advice.** Every point here is evaluated on block
 * state change, on selection change, or when a panel opens — never per
 * streaming delta. A dozen calls a turn is affordable; a few thousand is not. */

/** Each point, and the shape a contribution to it has to have.
 *
 * Stated per point rather than as one rule, because the points genuinely
 * differ: three of them claim a subject and draw it, one folds a list, one
 * produces candidates, one draws a section. A single universal requirement
 * would either be too weak to catch anything or would refuse contributions
 * that are correct — and a contribution refused for the wrong reason is
 * indistinguishable from one that is broken. */
const SHAPE = {
  // Claim a subject, then draw it.
  "tool.row": ["match", "render"],
  "details.panel": ["match", "render"],
  "flow.block": ["match", "render"],
  // Fold the session list into groups.
  "sidebar.group": ["group"],
  // Produce completion candidates for a prefix.
  command: ["complete"],
  // Draw one section of the settings panel.
  "settings.section": ["render"],
};

const points = Object.fromEntries(Object.keys(SHAPE).map((point) => [point, []]));

/** Registrations that failed, and renders that threw. Read by the
 *  diagnostics section, so a part of the interface that quietly does not
 *  appear has somewhere to say why. */
const refused = [];

export function register(point, contribution) {
  const owner = contribution.owner || "?";
  const shape = SHAPE[point];
  if (!shape) {
    refused.push({ point, owner, reason: "no such contribution point" });
    return false;
  }
  const missing = shape.filter((fn) => typeof contribution[fn] !== "function");
  if (missing.length) {
    // Named, not counted: "it needs match() and render()" is actionable and
    // "invalid contribution" is not.
    refused.push({ point, owner, reason: `missing ${missing.map((f) => `${f}()`).join(", ")}` });
    return false;
  }
  points[point].push(contribution);
  return true;
}

/** Everything registered at a point, in registration order. Later
 *  registrations win a `match`, so a plugin can take over a tool row the
 *  built-ins also claim — which is the point of the surface. */
export function at(point) {
  return points[point] || [];
}

/** The first contribution that claims this subject, searched newest first. */
export function claim(point, subject) {
  const all = points[point];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    let claimed = false;
    try {
      claimed = all[i].match(subject);
    } catch (e) {
      note(point, all[i], e);
      continue;
    }
    if (claimed) return all[i];
  }
  return null;
}

/** Run one contribution's render, and let a failure lose only its own
 *  contribution. A point that cannot survive its extension failing hands
 *  every extension author a way to break the interface. */
export function render(point, contribution, ...args) {
  try {
    return contribution.render(...args);
  } catch (e) {
    note(point, contribution, e);
    return null;
  }
}

function note(point, contribution, error) {
  const owner = contribution.owner || "?";
  const already = refused.find((r) => r.point === point && r.owner === owner);
  if (already) {
    already.count += 1;
    // Set aside after repeated failure, rather than failing every turn.
    if (already.count >= 3) contribution.disabled = true;
    return;
  }
  refused.push({ point, owner, reason: String(error && error.message ? error.message : error), count: 1 });
}

export function refusals() {
  return refused.slice();
}

/** Load what the installed packages contribute.
 *
 * A same-origin ES module, imported from the path the backend serves it at.
 * A module that fails to load, exports nothing usable, or throws on activate
 * loses its own contribution and nothing else — and the reason is kept where
 * the diagnostics section can show it. Anything else would let one package
 * take the interface down. */
export async function load(manifest, host) {
  // A backend that answered with a shape this build does not understand must
  // not take the boot down with it — the interface would go blank for a
  // reason the person looking at it cannot see.
  if (!Array.isArray(manifest)) {
    if (manifest) refused.push({ point: "-", owner: "-", reason: "the contribution list is not a list" });
    return;
  }
  for (const entry of manifest) {
    const owner = entry.plugin;
    try {
      const module = await import(entry.module);
      if (typeof module.activate !== "function") {
        refused.push({ point: entry.point, owner, reason: "the module exports no activate()" });
        continue;
      }
      // The host API a package gets is the same one the built-ins get, with
      // one difference: `register` stamps the owner, so a contribution can
      // always be traced back and revoked with its package.
      module.activate({
        ...host,
        owner,
        register: (point, contribution) => register(point, { ...contribution, owner }),
      });
    } catch (e) {
      refused.push({
        point: entry.point,
        owner,
        reason: String(e && e.message ? e.message : e),
      });
    }
  }
}


