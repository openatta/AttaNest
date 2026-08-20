/** Dialogs: new session (scene + permission mode + project) and the
 *  per-session menu. */

import { $, el, button, icon, append } from "../dom.js";
import { ICON } from "../icons.js";
import { call, errorText } from "../rpc.js";
import { state, emit } from "../state.js";
import { openSession, refreshSessions, banner } from "../session.js";
import { t } from "../i18n/index.js";

export function openModal(title, build) {
  const modal = $("modal");
  modal.innerHTML = "";
  modal.appendChild(el("div", "head", title));
  const body = el("div", "body");
  const foot = el("div", "foot");
  modal.append(body, foot);
  build(body, foot);
  if (!foot.children.length) {
    foot.appendChild(button("btn outline", t("common.close"), closeModal));
  }
  $("veil").classList.add("on");
  return { body, foot };
}

export function closeModal() {
  $("veil").classList.remove("on");
}

/**
 * A directory browser rooted at `$HOME`, shared by the new-session dialog and
 * the add-workspace flow.
 * @param {(path: string) => void} onPick called with the directory chosen
 * @returns {{node: HTMLElement, open: (path?: string) => Promise<void>}}
 */
export function directoryPicker(onPick) {
  const crumbs = el("div", "crumbs");
  const list = el("div", "list");
  const node = el("div", "picker", [crumbs, list]);

  const open = async (path) => {
    try {
      const result = await call("nest.listDirectory", path ? { path } : {});
      crumbs.innerHTML = "";
      result.breadcrumbs.forEach((crumb, index) => {
        crumbs.appendChild(button("", crumb.name, () => open(crumb.path)));
        if (index < result.breadcrumbs.length - 1) crumbs.appendChild(el("span", "", "/"));
      });
      crumbs.appendChild(el("span", "", " "));
      crumbs.appendChild(button("btn sm outline", t("dialog.useThisDirectory"), () => onPick(result.path)));
      list.innerHTML = "";
      for (const entry of result.entries) {
        if (entry.hidden) continue;
        list.appendChild(button("entry", [
          icon(ICON.folder, "glyph"),
          el("span", "truncate", entry.name),
        ], () => open(`${result.path.replace(/\/$/, "")}/${entry.name}`)));
      }
      if (!list.children.length) list.appendChild(el("div", "empty", t("dialog.noSubdirectories")));
    } catch (e) {
      banner(errorText(e));
    }
  };
  return { node, open };
}

/**
 * Add a project: either create a new directory under the projects root, or
 * point at one that already exists.
 */
export function addWorkspaceDialog() {
  let chosen = null;
  openModal(t("dialog.addProject"), (body, foot) => {
    const nameInput = el("input", { type: "text", placeholder: t("dialog.projectNamePlaceholder") });
    const createField = el("div", "field", [
      el("label", "", t("dialog.newProject")),
      nameInput,
      el("div", "hint", t("dialog.newProjectHint")),
    ]);
    body.appendChild(createField);

    const picked = el("div", "picked", t("dialog.noDirectoryChosen"));
    const field = el("div", "field", el("label", "", t("dialog.existingProject")));
    const picker = directoryPicker((path) => {
      chosen = path;
      picked.textContent = path;
    });
    field.append(picker.node, picked);
    body.appendChild(field);
    picker.open(null);

    const create = async () => {
      const name = nameInput.value.trim();
      try {
        if (name) await call("nest.projects.create", { name });
        else if (chosen) await call("nest.workspaces.create", { path: chosen });
        else return banner(t("dialog.pickDirectoryFirst"));
        closeModal();
        refreshSessions();
      } catch (e) {
        banner(t("dialog.addFailed", { error: errorText(e) }));
      }
    };
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") create();
    });

    foot.appendChild(button("btn outline", t("common.cancel"), closeModal));
    foot.appendChild(button("btn primary", t("common.add"), create));
  });
}

/** Rename anything that has a title: a workspace or a session. */
export function renameDialog(title, current, onSave) {
  openModal(title, (body, foot) => {
    const input = el("input", { type: "text", value: current || "" });
    body.appendChild(el("div", "field", [el("label", "", t("common.name")), input]));
    const save = async () => {
      try {
        await onSave(input.value);
        closeModal();
        refreshSessions();
      } catch (e) {
        banner(errorText(e));
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
    });
    foot.appendChild(button("btn outline", t("common.cancel"), closeModal));
    foot.appendChild(button("btn primary", t("common.save"), save));
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * @param {string} [preselectPath] project root to start on — the workspace
 *   menu's "new session here" passes the group's path.
 */
export async function newSessionDialog(preselectPath) {
  const scenes = (state.hello && state.hello.scenes) || [];
  const active = scenes.filter((scene) => scene.active);
  const choice = {
    scene: (active[0] && active[0].scene) || "coding",
    root: null,
    mode: "default",
  };

  let recents = { projects: [], cwd: null };
  try {
    recents = await call("nest.recentProjects");
  } catch {
    /* the picker still works without recents */
  }
  choice.root = typeof preselectPath === "string" ? preselectPath : (recents.cwd || null);

  openModal(t("dialog.newSession"), (body, foot) => {
    // scene
    const sceneField = el("div", "field", el("label", "", t("dialog.scene")));
    const sceneSelect = el("select");
    for (const scene of scenes) {
      const option = el("option", "", [
        scene.name || scene.scene,
        scene.capabilities && scene.capabilities.requires_project ? t("dialog.sceneNeedsProject") : "",
        scene.active ? "" : t("dialog.sceneInactive"),
      ].join(""));
      option.value = scene.scene;
      sceneSelect.appendChild(option);
    }
    sceneSelect.value = choice.scene;
    sceneSelect.onchange = () => {
      choice.scene = sceneSelect.value;
      syncProjectRequirement();
    };
    sceneField.appendChild(sceneSelect);
    body.appendChild(sceneField);

    // permission mode
    const modeField = el("div", "field", el("label", "", t("dialog.permissionMode")));
    const modeSelect = el("select");
    for (const [value, label] of [
      ["default", t("dialog.mode.default")],
      ["acceptEdits", t("dialog.mode.acceptEdits")],
      ["plan", t("dialog.mode.plan")],
      ["bypassPermissions", t("dialog.mode.bypass")],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      modeSelect.appendChild(option);
    }
    modeSelect.onchange = () => (choice.mode = modeSelect.value);
    modeField.appendChild(modeSelect);
    body.appendChild(modeField);

    // project
    const projectField = el("div", "field", el("label", "", t("dialog.projectRoot")));
    const picked = el("div", "picked", choice.root || t("dialog.noProject"));

    const recentList = el("div", "menu-list");
    const addRecent = (label, path, sub) => {
      recentList.appendChild(button("", [
        icon(ICON.folder, "glyph"),
        el("span", "truncate", label),
        sub ? el("span", "sub", sub) : null,
      ], () => {
        choice.root = path;
        picked.textContent = path || t("dialog.noProject");
      }));
    };
    if (recents.projects_root) {
      addRecent(recents.projects_root, recents.projects_root, t("dialog.projectsRoot"));
    }
    if (recents.cwd && recents.cwd !== recents.projects_root) {
      addRecent(recents.cwd, recents.cwd, t("dialog.currentDirectory"));
    }
    for (const project of recents.projects || []) {
      if (project.project_root !== recents.cwd && project.project_root !== recents.projects_root) {
        addRecent(project.project_root, project.project_root);
      }
    }
    addRecent(t("dialog.noProjectSession"), null);
    projectField.appendChild(recentList);

    const picker = directoryPicker((path) => {
      choice.root = path;
      picked.textContent = path;
    });
    projectField.appendChild(el("label", "", t("dialog.orBrowse")));
    projectField.appendChild(picker.node);
    projectField.appendChild(picked);
    body.appendChild(projectField);

    const syncProjectRequirement = () => {
      const scene = scenes.find((s) => s.scene === choice.scene);
      const optional = scene && scene.capabilities && scene.capabilities.requires_project === false;
      projectField.style.opacity = optional ? "0.65" : "1";
    };
    syncProjectRequirement();
    picker.open(null);

    foot.appendChild(button("btn outline", t("common.cancel"), closeModal));
    foot.appendChild(button("btn primary", t("common.create"), async () => {
      try {
        const created = await call("session.create", {
          scene: choice.scene,
          project_root: choice.root,
          options: { permission_mode: choice.mode },
        });
        closeModal();
        await refreshSessions();
        openSession(created.session_id);
      } catch (e) {
        banner(t("dialog.createFailed", { error: errorText(e) }));
      }
    }));
  });
}

export function sessionMenu(session) {
  openModal(session.name || t("sidebar.untitled"), (body) => {
    body.appendChild(el("div", "picked", session.session_id));
    const list = el("div", "menu-list");
    body.appendChild(list);

    list.appendChild(button("", [icon(ICON.chat, "glyph"), t("common.open")], () => {
      closeModal();
      openSession(session.session_id);
    }));

    list.appendChild(button("", [icon(ICON.edit, "glyph"), t("common.rename")], () => {
      renameDialog(t("dialog.renameSession"), session.name, (title) =>
        call("nest.sessions.rename", { session_id: session.session_id, title }));
    }));

    list.appendChild(button("", [icon(ICON.archive, "glyph"), el("span", "", [
      session.archived ? t("dialog.unarchive") : t("dialog.archive"),
      el("span", "sub", t("dialog.archiveHint")),
    ])], async () => {
      await call("nest.sessions.archive", {
        session_id: session.session_id,
        archived: !session.archived,
      });
      closeModal();
      refreshSessions();
    }));

    list.appendChild(button("", [icon(ICON.fork, "glyph"), t("dialog.fork")], async () => {
      try {
        const forked = await call("session.fork", { session_id: session.session_id });
        closeModal();
        await refreshSessions();
        openSession(forked.session_id);
      } catch (e) {
        banner(t("dialog.forkFailed", { error: errorText(e) }));
      }
    }));

    list.appendChild(button("", [icon(ICON.archive, "glyph"), el("span", "", [
      t("dialog.closeSession"),
      el("span", "sub", t("dialog.closeSessionHint")),
    ])], async () => {
      try {
        await call("session.close", { session_id: session.session_id });
        closeModal();
        refreshSessions();
      } catch (e) {
        banner(t("dialog.closeFailed", { error: errorText(e) }));
      }
    }));

    list.appendChild(button("danger", [icon(ICON.trash, "glyph"), el("span", "", [
      t("dialog.deleteSession"),
      el("span", "sub", t("dialog.deleteSessionHint")),
    ])], async () => {
      try {
        const plan = await call("session.delete", {
          session_id: session.session_id,
          dry_run: true,
        });
        confirmDialog(
          t("dialog.deleteConfirm", { count: plan.sidechains_deleted || 0 }),
          async () => {
            await call("session.delete", { session_id: session.session_id });
            closeModal();
            if (state.sessionId === session.session_id) {
              state.sessionId = null;
              state.blocks = [];
              emit("flow", "session");
            }
            refreshSessions();
          },
        );
      } catch (e) {
        banner(t("dialog.deleteFailed", { error: errorText(e) }));
      }
    }));
  });
}

export function confirmDialog(message, onConfirm) {
  openModal(t("dialog.confirm"), (body, foot) => {
    body.appendChild(el("div", "", message));
    foot.appendChild(button("btn outline", t("common.cancel"), closeModal));
    foot.appendChild(button("btn primary", t("common.confirm"), async () => {
      try {
        await onConfirm();
      } catch (e) {
        banner(errorText(e));
      }
    }));
  });
}

export function mountModals() {
  $("veil").addEventListener("click", (event) => {
    if (event.target === $("veil")) closeModal();
  });
}
