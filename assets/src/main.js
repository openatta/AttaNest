/** Boot: wire the transport to the store, mount the views, open a session. */

import { $, el, button, icon } from "./dom.js";
import { ICON } from "./icons.js";
import { connect, call, notify, onNotify, onStatus, errorText } from "./rpc.js";
import { state, emit, subscribe } from "./state.js";
import { handleNotification, refreshSessions, openSession, banner } from "./session.js";
import { initTheme } from "./theme.js";
import { t, onLocaleChange, currentLocale } from "./i18n/index.js";
import { mountSidebar, toggleSidebar } from "./views/sidebar.js";
import { mountConversation, watchScroll } from "./views/conversation.js";
import { mountComposer, focusComposer } from "./views/composer.js";
import { mountDetails } from "./views/details.js";
import { mountModals, newSessionDialog, closeModal } from "./views/modals.js";

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

onStatus((status) => {
  state.connection = status === "open" ? "open" : status === "closed" ? "closed" : "connecting";
  emit("connection");
  if (status === "open") boot();
});

onNotify(handleNotification);
connect();

async function boot() {
  try {
    state.hello = await call("nest.hello");
    state.commands = state.hello.commands || [];
    state.scenes = state.hello.scenes || [];
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
