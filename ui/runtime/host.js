/** The API a contribution gets. Small, and enumerable on purpose.
 *
 * What is here: a place to mount, an RPC client filtered by what the caller
 * may reach, store subscription, design tokens, `t()`, and the icon set.
 *
 * What is deliberately not here: the connection. A contribution cannot get at
 * the socket, so the code it writes runs unchanged under any topology. Nor is
 * there a way out to the network — that is a capability to declare and have
 * disclosed, not one to get by running inside a browser. The CSP blocks it,
 * and that is intentional rather than incidental.
 *
 * This table is the contract. It goes in the catalog, and it is generated. */

import { call } from "./client.js";
import { el, button, icon, clip, append } from "./dom.js";
import { ICON } from "./icons.js";
import { t } from "./i18n/index.js";
import { markdown } from "./markdown.js";
import { state, subscribe, emit } from "./state.js";
import * as envelope from "./request.js";

/** Build the host API for one owner.
 *
 * `reachable` is the method list the backend said this subject may call. A
 * call to anything else is refused here with the same words the backend would
 * use — so a plugin author sees the same message whether they hit the client
 * check or the server's authorization table, and neither reads like a bug. */
export function hostApi(owner, reachable) {
  const allowed = new Set(reachable || []);
  return {
    owner,

    /** One unary call, filtered by what this owner may reach. */
    async call(method, params) {
      if (allowed.size && !allowed.has(method)) {
        throw { message: t("contrib.methodNotDeclared", { method, owner }) };
      }
      return call(method, params);
    },

    /** Read-only view of the store, and a subscription to one slice. */
    state,
    subscribe,
    emit,

    /** Build DOM. Tokens only — a contribution that hard-codes a color is
     *  unreadable in the other theme, which is why the admission check
     *  refuses one rather than letting it ship. */
    el,
    button,
    icon,
    clip,
    append,
    ICON,
    markdown,

    /** Reading a recorded request envelope: which blocks, from where, how
     *  big. A contribution that draws one of these should not have to
     *  reimplement the folding. */
    envelope,

    /** Keys only — a contribution that hard-codes text turns the whole
     *  interface into two languages the moment someone switches. */
    t,
  };
}
