/** Boot: handshake, register the interface's parts, load what packages
 *  contribute, mount the shell, open a session.
 *
 * The order matters twice. Nothing is drawn before the registrations are in,
 * because the shell draws by asking the registry who claims what — including
 * for its own rows and panels. And packages load *after* the built-ins,
 * because a later registration wins a claim: that is how a package replaces
 * a row rather than being ignored behind one. */

import { $, el, button, icon } from "./runtime/dom.js";
import { ICON } from "./runtime/icons.js";
import { connect, call, notify, onNotify, onStatus, errorText, session } from "./runtime/client.js";
import { load as loadPackages, refusals } from "./runtime/contrib.js";
import { registerBuiltins } from "./builtin/index.js";
import { state, emit, subscribe } from "./runtime/state.js";
import { handleNotification, refreshSessions, openSession, banner } from "./shell/session.js";
import { initTheme } from "./runtime/theme.js";
import { t, onLocaleChange, currentLocale } from "./runtime/i18n/index.js";
import { mountSidebar, toggleSidebar } from "./shell/sidebar.js";
import { mountConversation, watchScroll } from "./shell/conversation.js";
import { mountComposer, focusComposer } from "./shell/composer.js";
import { mountDetails } from "./shell/details.js";
import { mountModals, newSessionDialog, closeModal } from "./shell/modals.js";

initTheme();
document.documentElement.lang = currentLocale();
// Views render from the store, so a locale change is a repaint, not a remount.
onLocaleChange(() => {
  mountComposer(); // rebuilds the card's copy; subscriptions are mounted once
  emit("sessions", "session", "flow", "turn", "queue", "attachments", "detail", "banner", "connection", "search", "commands");
});
mountSidebar();
mountConversation();
mountComposer();
mountDetails();
mountModals();
mountBanner();
watchScroll();
bindKeys();

onStatus((status, detail) => {
  if (status === "incompatible") {
    // Refused on purpose, and retrying cannot fix it. Which side is out of
    // date is in the message; a silent downgrade here would turn this into a
    // bug report nobody can act on.
    state.connection = "incompatible";
    banner(t("banner.incompatible", { reason: detail || "" }));
    emit("connection");
    return;
  }
  state.connection = status === "open" ? "open" : status === "closed" ? "closed" : "connecting";
  emit("connection");
  if (status === "open") boot();
});

onNotify(handleNotification);
connect();

let contributionsReady = false;

async function boot() {
  try {
    state.hello = await call("nest.hello");
    state.commands = state.hello.commands || [];
    state.scenes = state.hello.scenes || [];
    state.negotiated = session();

    // Once per page, not once per reconnect: a reconnect re-attaches a
    // session, it does not rebuild the interface.
    if (!contributionsReady) {
      // What this subject may call, from the layer that decides it. A
      // contribution's RPC client is filtered by this, so a plugin author
      // sees the same refusal whether the client or the server catches it.
      const reachable = await call("nest.reachable").then((r) => r.methods).catch(() => []);
      const host = registerBuiltins(reachable);
      // What the installed packages contribute, after the built-ins — later
      // registrations win a claim, which is what lets a package take over a
      // row the product already draws.
      await loadPackages(state.hello.contributions, host);
      state.contributionRefusals = refusals();
      contributionsReady = true;
      emit("flow", "sessions", "detail");
    }
    emit("commands", "connection");
    await refreshSessions();
    // Reopening the same session after a reconnect re-attaches it, which is
    // how a refresh catches up on a turn that kept running without us.
    if (state.sessionId) openSession(state.sessionId);
  } catch (e) {
    banner(t("banner.bootFailed", { error: errorText(e) }));
  }
}

function mountBanner() {
  subscribe("banner", () => {
    const node = $("banner");
    node.innerHTML = "";
    if (!state.banner) {
      node.className = "";
      return;
    }
    node.className = "on";
    node.appendChild(icon(ICON.alert, "glyph"));
    node.appendChild(el("span", "", state.banner.text));
    node.appendChild(button("icon-btn close", icon(ICON.close), () => banner(null), { title: t("banner.dismiss") }));
  });
}

function bindKeys() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      newSessionDialog();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      toggleSidebar();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "/") {
      event.preventDefault();
      focusComposer();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.sessionId) notify("nest.detach", { session_id: state.sessionId });
  });
}
