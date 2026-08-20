/** Sidebar: brand, new session, search, workspace-grouped sessions, footer.
 *
 * Workspaces are Nest's own grouping over the engine's `project_root` (the
 * engine has no such concept — see crates/hub/src/store.rs). A group shows
 * five sessions and offers the rest behind one control, the way DSH's
 * workspace browser does; ordering and collapse are remembered server-side so
 * a second tab sees the same shape. */

import { $, el, button, icon, ago, clip } from "../dom.js";
import { ICON } from "../icons.js";
import { call, errorText } from "../rpc.js";
import { state, subscribe, emit } from "../state.js";
import { openSession, refreshSessions, banner } from "../session.js";
import { newSessionDialog, sessionMenu, addWorkspaceDialog, renameDialog, openModal, closeModal } from "./modals.js";
import { openSettings } from "./settings.js";
import { toggleTheme, themeIsDark } from "../theme.js";
import { t } from "../i18n/index.js";

const PAGE = 5;

/**
 * Mount the column once, then re-render only the list.
 *
 * The chrome (brand, new-session, search field, footer) is built once because
 * the search field is in it: rebuilding the column on every store change meant
 * destroying the focused input mid-keystroke and restoring focus afterwards,
 * which restored the caret to the end. Nothing above the list depends on the
 * session list, so nothing above the list needs to be redrawn with it.
 */
export function mountSidebar() {
  const side = $("side");
  side.innerHTML = "";
  const list = el("div", "");
  list.id = "sessions";
  side.append(brand(), newButton(), sectionHeader(), list, footer());
  quietScrollbars(side);

  subscribe("sessions", renderList);
  subscribe("session", renderList);
  subscribe("search", renderList);
  subscribe("connection", renderFooter);
  renderList();
}

/** The thumb is a pointer affordance: it lingers 2s after the pointer leaves. */
function quietScrollbars(side) {
  let timer = null;
  const quiet = () => side.classList.add("quiet");
  side.classList.add("quiet");
  side.addEventListener("pointerenter", () => {
    clearTimeout(timer);
    side.classList.remove("quiet");
  });
  side.addEventListener("pointerleave", () => {
    clearTimeout(timer);
    timer = setTimeout(quiet, 2000);
  });
}

function renderList() {
  const list = $("sessions");
  if (!list) return;
  list.innerHTML = "";
  renderGroups(list);
}

function brand() {
  return el("div", "brand", [
    icon(ICON.brand, "mark"),
    el("span", "name", t("app.title")),
    button("icon-btn collapse", icon(ICON.panel), toggleSidebar, { title: t("app.collapseSidebar") }),
  ]);
}

/**
 * The session section's header: a label that gives way to the search capsule
 * when search opens, and the add-project control. DSH keeps search collapsed
 * to an icon until asked for; a permanently open field spends a row on
 * something used occasionally.
 */
function sectionHeader() {
  const head = el("div", "section-head");
  head.appendChild(el("span", "section-label truncate", t("sidebar.sessions")));

  const input = searchInput();
  const toggle = button("icon-btn", icon(ICON.search), () => {
    const searching = head.classList.contains("searching");
    head.classList.toggle("searching", !searching);
    if (!searching) setTimeout(() => input.focus(), 60);
    else clearSearch();
  }, { title: t("sidebar.search") });

  head.appendChild(el("div", "search-slot", el("div", "search-box", [toggle, input])));
  head.appendChild(button("icon-btn", icon(ICON.plus), addWorkspaceDialog, {
    title: t("app.addProject"),
  }));
  // Reopen it already expanded when a query survives a re-render.
  if (state.searchQuery) head.classList.add("searching");
  return head;
}

function clearSearch() {
  state.searchQuery = "";
  state.searchHits = null;
  const input = $("search");
  if (input) input.value = "";
  emit("search");
}

function newButton() {
  return button("", [icon(ICON.plus, "glyph"), el("span", "label", t("sidebar.newSession"))], newSessionDialog, {
    id: "new",
    title: t("sidebar.newSessionHint"),
  });
}

function searchInput() {
  const input = el("input", {
    id: "search",
    type: "text",
    placeholder: t("sidebar.search"),
    value: state.searchQuery || "",
    spellcheck: false,
  });
  input.addEventListener("input", () => {
    state.searchQuery = input.value;
    state.searchHits = null;
    emit("search");
  });
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      clearSearch();
      const head = $("side").querySelectorAll(".section-head")[0];
      if (head) head.classList.remove("searching");
      return;
    }
    if (event.key !== "Enter" || !input.value.trim()) return;
    // Enter goes past titles into the transcripts.
    state.searchHits = "pending";
    emit("search");
    try {
      const result = await call("nest.search", { query: input.value.trim() });
      state.searchHits = result.hits || [];
      state.searchTruncated = !!result.truncated;
    } catch (e) {
      state.searchHits = [];
      banner(t("banner.searchFailed", { error: errorText(e) }));
    }
    emit("search");
  });
  return input;
}

/* ── the list ─────────────────────────────────────────────────────────── */

function renderGroups(list) {
  if (state.searchHits) {
    renderSearchResults(list);
    return;
  }

  const query = (state.searchQuery || "").trim().toLowerCase();
  const visible = state.sessions.filter((session) => {
    if (session.archived && !state.showArchived) return false;
    if (!query) return true;
    return (session.name || "").toLowerCase().includes(query);
  });

  const groups = groupSessions(visible);
  if (!groups.length) {
    list.appendChild(el("div", "empty", query ? t("sidebar.noMatches") : t("sidebar.noSessions")));
  }

  for (const group of groups) {
    list.appendChild(groupNode(group));
  }

  const archivedCount = state.sessions.filter((s) => s.archived).length;
  if (archivedCount) {
    list.appendChild(button("archive-toggle", [
      icon(ICON.archive, "glyph"),
      el("span", "", state.showArchived ? t("sidebar.archivedHide") : t("sidebar.archivedShow", { count: archivedCount })),
    ], () => {
      state.showArchived = !state.showArchived;
      emit("sessions");
    }));
  }
}

/**
 * Sessions into groups: registered workspaces first (in their stored order),
 * then whatever is left — no project, then sessions this Nest has never
 * opened and therefore knows no project for.
 */
function groupSessions(sessions) {
  const workspaces = state.workspaces || [];
  const groups = workspaces.map((workspace) => ({
    key: workspace.id,
    workspace,
    title: workspace.title,
    hint: workspace.path,
    rows: [],
  }));
  const byId = new Map(groups.map((group) => [group.key, group]));
  const loose = { key: "loose", title: t("sidebar.groupLoose"), rows: [] };
  const unknown = { key: "unknown", title: t("sidebar.groupUnknown"), rows: [] };

  for (const session of sessions) {
    const group = session.workspace_id && byId.get(session.workspace_id);
    if (group) group.rows.push(session);
    else if (session.scene) loose.rows.push(session);
    else unknown.rows.push(session);
  }

  for (const group of groups) sortRows(group.rows, group.workspace.session_order);
  sortRows(loose.rows);
  sortRows(unknown.rows);

  return [...groups, loose, unknown].filter((group) => group.rows.length);
}

function sortRows(rows, manualOrder) {
  const order = manualOrder && manualOrder.length ? manualOrder : null;
  rows.sort((a, b) => {
    if (order) {
      const ia = order.indexOf(a.session_id);
      const ib = order.indexOf(b.session_id);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    }
    return String(b.last_active || "").localeCompare(String(a.last_active || ""));
  });
}

function groupNode(group) {
  const workspace = group.workspace;
  const collapsed = workspace ? workspace.collapsed : false;
  const node = el("div", "group");

  const head = el("div", "title");
  const chevron = button("chev", [
    icon(ICON.folder, "glyph folder"),
    icon(collapsed ? ICON.chevronRight : ICON.chevronDown, "glyph arrow"),
  ], (event) => {
    event.stopPropagation();
    if (workspace) setCollapsed(workspace, !collapsed);
  }, { title: collapsed ? t("sidebar.expand") : t("sidebar.collapse") });
  head.appendChild(chevron);
  const label = el("span", "label", group.title);
  if (group.hint) label.title = group.hint;
  head.appendChild(label);
  head.appendChild(el("span", "count", String(group.rows.length)));
  if (workspace) {
    // Clicking anywhere on the row folds it, the way a tree behaves.
    head.onclick = () => setCollapsed(workspace, !collapsed);
    head.appendChild(button("icon-btn more", icon(ICON.more), (event) => {
      event.stopPropagation();
      workspaceMenu(workspace);
    }, { title: t("sidebar.projectActions") }));
    head.draggable = true;
    head.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", workspace.id);
      node.classList.add("dragging");
    });
    head.addEventListener("dragend", () => node.classList.remove("dragging"));
    node.addEventListener("dragover", (event) => {
      event.preventDefault();
      node.classList.add("drop");
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop"));
    node.addEventListener("drop", async (event) => {
      event.preventDefault();
      node.classList.remove("drop");
      const moved = event.dataTransfer.getData("text/plain");
      if (!moved || moved === workspace.id) return;
      try {
        const result = await call("nest.workspaces.reorder", { id: moved, before_id: workspace.id });
        state.workspaces = result.workspaces || state.workspaces;
        emit("sessions");
      } catch (e) {
        banner(errorText(e));
      }
    });
  }
  node.appendChild(head);

  if (collapsed) return node;

  const showAll = state.expandedGroups.has(group.key);
  const rows = showAll ? group.rows : group.rows.slice(0, PAGE);
  for (const session of rows) node.appendChild(sessionRow(session));

  if (group.rows.length > PAGE) {
    node.appendChild(button("more-rows", showAll
      ? t("sidebar.showLess")
      : t("sidebar.showMore", { count: group.rows.length - PAGE }), () => {
      if (showAll) state.expandedGroups.delete(group.key);
      else state.expandedGroups.add(group.key);
      emit("sessions");
    }));
  }
  return node;
}

async function setCollapsed(workspace, collapsed) {
  workspace.collapsed = collapsed; // optimistic: the list redraws immediately
  emit("sessions");
  try {
    await call("nest.workspaces.update", { id: workspace.id, collapsed });
  } catch (e) {
    banner(errorText(e));
  }
}

function sessionRow(session) {
  // One line, DSH's shape: the timestamp holds the right edge until the
  // pointer arrives, then the actions take its place. Scene and message count
  // move to the row's tooltip rather than a second line — the group already
  // says which project this is.
  const row = button(`srow${session.session_id === state.sessionId ? " on" : ""}`, [
    state.running.has(session.session_id) ? el("span", "live") : null,
    el("span", "name", session.name || t("sidebar.untitled")),
    el("span", "time", session.last_active ? ago(session.last_active) : ""),
    button("icon-btn more", icon(ICON.more), (event) => {
      event.stopPropagation();
      sessionMenu(session);
    }, { title: t("sidebar.sessionActions") }),
  ], () => openSession(session.session_id));
  row.title = [
    session.name || t("sidebar.untitled"),
    session.scene || session.status || "",
    session.message_count ? t("sidebar.messageCount", { count: session.message_count }) : "",
    session.archived ? t("sidebar.archivedTag") : "",
  ].filter(Boolean).join(" · ");
  row.dataset.sid = session.session_id;
  row.oncontextmenu = (event) => {
    event.preventDefault();
    sessionMenu(session);
  };
  return row;
}

function renderSearchResults(list) {
  const hits = state.searchHits;
  if (hits === "pending") {
    list.appendChild(el("div", "empty", t("sidebar.searching")));
    return;
  }
  const head = el("div", "group");
  head.appendChild(el("div", "title", [
    el("span", "label", t("sidebar.searchHits", { count: hits.length })),
    button("icon-btn more", icon(ICON.close), () => {
      state.searchHits = null;
      state.searchQuery = "";
      emit("search");
    }, { title: t("common.clear") }),
  ]));
  for (const hit of hits) {
    head.appendChild(button("srow hit", [
      el("span", "name", hit.name || t("sidebar.untitled")),
      el("span", "snippet", clip(hit.snippet, 120)),
    ], () => openSession(hit.session_id)));
  }
  if (!hits.length) head.appendChild(el("div", "empty", t("sidebar.searchNoHits")));
  if (state.searchTruncated) head.appendChild(el("div", "empty", t("sidebar.searchPartial")));
  list.appendChild(head);
}

/* ── menus ────────────────────────────────────────────────────────────── */

function workspaceMenu(workspace) {
  openModal(workspace.title, (body) => {
    body.appendChild(el("div", "picked", workspace.path || t("dialog.noProject")));
    const menu = el("div", "menu-list");
    body.appendChild(menu);
    menu.appendChild(button("", [icon(ICON.plus, "glyph"), t("dialog.newSessionHere")], () => {
      closeModal();
      newSessionDialog(workspace.path);
    }));
    menu.appendChild(button("", [icon(ICON.edit, "glyph"), t("common.rename")], () => {
      renameDialog(t("dialog.renameProject"), workspace.title, (title) =>
        call("nest.workspaces.update", { id: workspace.id, title }));
    }));
    menu.appendChild(button("danger", [icon(ICON.trash, "glyph"), el("span", "", [
      t("dialog.removeGroup"),
      el("span", "sub", t("dialog.removeGroupHint")),
    ])], async () => {
      await call("nest.workspaces.remove", { id: workspace.id });
      closeModal();
      refreshSessions();
    }));
  });
}

/* ── footer ───────────────────────────────────────────────────────────── */

function renderFooter() {
  const current = $("side").querySelectorAll(".foot")[0];
  if (current) current.replaceWith(footer());
}

function footer() {
  const node = el("div", "foot", [
    button("icon-btn", icon(ICON.settings), openSettings, { title: t("app.settings") }),
    button("icon-btn", icon(themeIsDark() ? ICON.sun : ICON.moon), () => {
      toggleTheme();
      renderFooter();
    }, { title: t("app.theme") }),
    el("span", "text truncate", state.hello ? state.hello.engine.model : ""),
  ]);
  return node;
}

/**
 * Collapse in three phases, DSH's timing: the expanded content fades in place
 * (150ms), the rail layout lands, then the controls slide in from the old
 * right edge (150ms) while the column track finishes (300ms). Reduced motion
 * skips straight to the end state.
 */
export function toggleSidebar() {
  const frame = $("frame");
  const side = $("side");
  const collapsing = frame.dataset.sidebar !== "collapsed";
  const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (still) {
    frame.dataset.sidebar = collapsing ? "collapsed" : "expanded";
    return;
  }

  const land = () => {
    side.classList.remove("fading");
    frame.dataset.sidebar = collapsing ? "collapsed" : "expanded";
    side.classList.add("rail-in");
    setTimeout(() => side.classList.remove("rail-in"), 150);
  };
  side.classList.add("fading");
  setTimeout(land, 150);
}
