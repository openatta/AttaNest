/** The composer: status strip, queue rows, attachment chips, input card. */

import { $, el, button, icon, clip } from "../runtime/dom.js";
import { ICON } from "../runtime/icons.js";
import { at, render as renderPoint } from "../runtime/contrib.js";
import { state, subscribe, emit } from "../runtime/state.js";
import { send, interrupt, removeQueued, banner } from "../shell/session.js";
import { call, errorText } from "../runtime/client.js";
import { scrollToBottom } from "../shell/conversation.js";
import { t } from "../runtime/i18n/index.js";

let input = null;
let menuOpen = false;
let menuIndex = 0;
let menuItems = [];
/** Which trigger opened the menu: `/` for commands, `@` for project files. */
let menuKind = null;

let mounted = false;

/**
 * Mount once; rebuild the card whenever the copy it renders changes.
 *
 * Subscriptions and the file-input listener are registered exactly once — a
 * second `mountComposer()` used to add another set of both, so switching the
 * language twice meant two renders per event and two uploads per picked file.
 */
export function mountComposer() {
  buildCard();
  if (mounted) return;
  mounted = true;

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  $("file").addEventListener("change", onFiles);

  subscribe("turn", renderStatus);
  subscribe("session", renderStatus);
  subscribe("queue", renderQueue);
  subscribe("attachments", renderAttachments);
  subscribe("commands", () => {
    const trigger = currentTrigger();
    if (menuOpen && trigger && trigger.kind === "/") openCommandMenu(trigger);
  });

  // Images arrive by paste and by drop as often as through the file dialog.
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    uploadAll(files);
  });
  const dock = $("dock");
  for (const type of ["dragover", "dragenter"]) {
    dock.addEventListener(type, (event) => {
      event.preventDefault();
      dock.classList.add("dropping");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dock.addEventListener(type, () => dock.classList.remove("dropping"));
  }
  dock.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    uploadAll(files);
  });
}

function buildCard() {
  const dock = $("dock");
  dock.innerHTML = "";

  const stack = el("div", "stack");
  stack.appendChild(el("div", "", []));
  dock.appendChild(stack);

  const status = el("div", "");
  status.id = "status";
  const queue = el("div", "");
  queue.id = "queue";
  const atts = el("div", "");
  atts.id = "atts";

  input = el("textarea", {
    id: "input",
    rows: 1,
    spellcheck: false,
    placeholder: t("composer.placeholder"),
  });

  const menu = el("div", "");
  menu.id = "menu";

  const actions = el("div", "");
  actions.id = "actions";
  actions.appendChild(button("icon-btn", icon(ICON.attach), () => $("file").click(), {
    title: t("composer.attach"),
  }));
  actions.appendChild(el("div", "spacer"));
  actions.appendChild(el("span", "hint", t("composer.hint")));
  const sendButton = button("icon-btn", icon(ICON.send), onSendClick, { id: "send", title: t("composer.send") });
  actions.appendChild(sendButton);

  const box = el("div", "", [menu, input, actions]);
  box.id = "box";

  stack.replaceWith(el("div", "stack", [status, queue, atts, box]));

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);

  renderStatus();
  renderQueue();
  renderAttachments();
}

function running() {
  return !!state.turn && state.turn.state !== "complete" && state.turn.state !== "interrupted";
}

function renderStatus() {
  const status = $("status");
  if (!status) return;
  status.innerHTML = "";
  const sendButton = $("send");
  if (sendButton) {
    sendButton.disabled = !state.sessionId;
    sendButton.classList.toggle("stop", running());
    sendButton.innerHTML = "";
    sendButton.appendChild(icon(running() ? ICON.stop : ICON.send));
    sendButton.title = running() ? t("composer.stop") : t("composer.send");
  }
  if (!state.sessionId) return;

  if (running()) {
    status.appendChild(el("span", "spinner"));
    status.appendChild(el("span", "",
      state.turn.state === "blocked" ? t("composer.blocked") : t("composer.running")));
  } else if (state.session && state.session.turn_state === "running") {
    status.appendChild(el("span", "spinner"));
    status.appendChild(el("span", "", t("composer.runningElsewhere")));
  }
}

function renderQueue() {
  const queue = $("queue");
  if (!queue) return;
  queue.innerHTML = "";
  state.queue.forEach((item, index) => {
    queue.appendChild(el("div", "queue-item", [
      el("span", "idx", t("composer.queued", { index: index + 1 })),
      el("span", "truncate", item.message),
      button("icon-btn", icon(ICON.close), () => removeQueued(item.item_id), { title: t("composer.queueCancel") }),
    ]));
  });
}

/** Draft attachments: 64px thumbnails for images, a chip for anything else. */
function renderAttachments() {
  const atts = $("atts");
  if (!atts) return;
  atts.innerHTML = "";
  state.attachments.forEach((attachment, index) => {
    const remove = button("icon-btn remove", icon(ICON.close), () => {
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      state.attachments.splice(index, 1);
      emit("attachments");
    }, { title: t("composer.remove") });

    if (attachment.preview) {
      const thumb = el("div", "att-thumb", [remove]);
      const image = el("img");
      image.src = attachment.preview;
      image.alt = attachment.label;
      thumb.insertBefore(image, remove);
      thumb.title = attachment.label;
      atts.appendChild(thumb);
      return;
    }
    atts.appendChild(el("div", "att-chip", [
      icon(ICON.file, "glyph"),
      el("span", "truncate", attachment.label),
      remove,
    ]));
  });
}

function onSendClick() {
  if (running()) interrupt();
  else submit();
}

function submit() {
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  autoGrow();
  closeMenu();
  scrollToBottom();
  send(text);
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

/**
 * What the caret is currently inside, if anything: a leading `/command`, or an
 * `@path` token anywhere in the text. Returning the token's span lets a pick
 * replace exactly what was typed.
 */
function currentTrigger() {
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  if (value.startsWith("/") && !value.slice(0, caret).includes(" ")) {
    return { kind: "/", query: value.slice(1, caret), from: 0, to: caret };
  }
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // A mention starts at a word boundary and has no whitespace in it.
  const boundary = at === 0 || /\s/.test(before[at - 1]);
  const token = before.slice(at + 1);
  if (!boundary || /\s/.test(token)) return null;
  return { kind: "@", query: token, from: at, to: caret };
}

function onInput() {
  autoGrow();
  const trigger = currentTrigger();
  if (!trigger) closeMenu();
  else if (trigger.kind === "/") openCommandMenu(trigger);
  else openFileMenu(trigger);
}

function onKeyDown(event) {
  if (menuOpen) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : menuItems.length - 1;
      menuIndex = (menuIndex + delta) % Math.max(menuItems.length, 1);
      paintMenuSelection();
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      choose(menuItems[menuIndex]);
      return;
    }
    if (event.key === "Escape") {
      closeMenu();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

/** Candidates come from the `command` point, in registration order.
 *
 * Every contribution is asked, and one that throws contributes nothing rather
 * than emptying the palette — the registry records which one and why. */
function openCommandMenu(trigger) {
  const query = trigger.query.toLowerCase();
  const items = [];
  for (const contribution of at("command")) {
    const some = renderPoint("command", { ...contribution, render: contribution.complete }, query);
    if (Array.isArray(some)) items.push(...some);
  }
  paintMenu("/", trigger, items.slice(0, 40));
}

let fileRequest = 0;

async function openFileMenu(trigger) {
  const projectRoot = state.session && state.session.project_root;
  if (!projectRoot) return closeMenu();
  const mine = ++fileRequest;
  try {
    const result = await call("nest.files", { project_root: projectRoot, query: trigger.query });
    if (mine !== fileRequest) return; // a later keystroke already asked
    const current = currentTrigger();
    if (!current || current.kind !== "@") return closeMenu();
    paintMenu("@", current, (result.files || []).map((file) => ({
      replacement: `@${file.path} `,
      label: file.path,
      description: "",
      source: file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : "",
    })));
  } catch {
    closeMenu();
  }
}

function paintMenu(kind, trigger, items) {
  const menu = $("menu");
  menuItems = items.map((item) => ({ ...item, trigger }));
  if (!menuItems.length) {
    closeMenu();
    return;
  }
  menu.innerHTML = "";
  menuItems.forEach((item, index) => {
    menu.appendChild(button(`item${index === 0 ? " sel" : ""}`, [
      el("span", "cmd truncate", item.label),
      el("span", "desc truncate", clip(item.description, 90)),
      item.source ? el("span", "src", item.source) : null,
    ], () => choose(item)));
  });
  menuIndex = 0;
  menuOpen = true;
  menuKind = kind;
  menu.classList.add("on");
}

function paintMenuSelection() {
  const items = $("menu").querySelectorAll(".item");
  items.forEach((item, index) => item.classList.toggle("sel", index === menuIndex));
}

/** Replace exactly the trigger token with the picked value. */
function choose(item) {
  if (!item) return;
  const { from, to } = item.trigger;
  const value = input.value;
  input.value = value.slice(0, from) + item.replacement + value.slice(to);
  const caret = from + item.replacement.length;
  closeMenu();
  input.focus();
  if (input.setSelectionRange) input.setSelectionRange(caret, caret);
  autoGrow();
}

function closeMenu() {
  menuOpen = false;
  menuItems = [];
  menuKind = null;
  const menu = $("menu");
  if (menu) menu.classList.remove("on");
}

export function focusComposer() {
  if (input) input.focus();
}

async function onFiles(event) {
  await uploadAll([...event.target.files]);
  event.target.value = "";
}

async function uploadAll(files) {
  const limit = (state.hello && state.hello.limits && state.hello.limits.max_upload_bytes) || 0;
  for (const file of files) {
    if (limit && file.size > limit) {
      banner(t("composer.uploadTooLarge", { name: file.name, limit: Math.round(limit / 1048576) }));
      continue;
    }
    try {
      const grant = await call("nest.upload.begin", { name: file.name, bytes: file.size });
      const response = await fetch(grant.url, { method: "POST", body: file });
      if (!response.ok) throw { message: await response.text() };
      const { path } = await response.json();
      state.attachments.push({
        label: file.name,
        // Local preview only; the model gets the uploaded path.
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        attachment: { kind: "file", path },
      });
      emit("attachments");
    } catch (e) {
      banner(t("composer.uploadFailed", { error: errorText(e) }));
    }
  }
}
