/** Session actions and the reducer that turns the wire into flow blocks.
 *
 * Two sources produce the same block list: `session.history` (the transcript,
 * authoritative up to its own depth) and `nest.event` frames (the live turn,
 * plus whatever the hub replayed on attach). The catch-up order is history
 * first, replay second — never the other way round; see
 * docs/architecture.md §5.
 *
 * Blocks are plain objects with a stable `key` and a `rev` counter. A view
 * re-renders only the blocks whose `rev` moved, so a thousand text deltas
 * touch one node. */

import { call, notify, errorText } from "../runtime/client.js";
import { state, emit, resetSession } from "../runtime/state.js";
import { t } from "../runtime/i18n/index.js";

let nextKey = 1;
const HISTORY_PAGE = 200;
const HISTORY_PAGES_AT_OPEN = 5;

function push(block, { silent = false } = {}) {
  block.key = nextKey++;
  block.rev = 0;
  state.blocks.push(block);
  if (!silent) emit("flow");
  return block;
}

function touch(block) {
  block.rev += 1;
  emit("flow");
}

export function banner(text, tone) {
  state.banner = text ? { text, tone: tone || "warn" } : null;
  emit("banner");
}

/* ── opening ──────────────────────────────────────────────────────────── */

export async function openSession(sessionId) {
  if (state.sessionId && state.sessionId !== sessionId) {
    notify("nest.detach", { session_id: state.sessionId });
  }
  resetSession(sessionId);
  banner(null);
  emit("flow", "session", "turn", "queue", "attachments", "detail", "sessions");

  let attached;
  try {
    attached = await call("nest.attach", { session_id: sessionId });
  } catch (e) {
    push({ kind: "note", text: t("flow.openFailed", { error: errorText(e) }), error: true });
    return;
  }
  if (state.sessionId !== sessionId) return; // the user moved on while we waited

  state.session = attached.session || {};
  state.seq = attached.seq || 0;
  state.queue = attached.queue || [];
  state.usage = (attached.session && attached.session.usage) || null;
  state.turn = attached.running_turn ? { turnId: attached.running_turn, state: "running" } : null;
  if (attached.truncated) {
    banner(t("banner.replayTruncated"));
  }

  await loadHistory(sessionId, attached.history_total || 0);
  if (state.sessionId !== sessionId) return;

  for (const frame of attached.replay || []) {
    if (frame.seq > state.seq) state.seq = frame.seq;
    applyEvent(frame.event, frame.turn_id, { silent: true });
  }
  for (const prompt of attached.pending_prompts || []) {
    applyEvent(prompt, state.turn ? state.turn.turnId : "", { silent: true });
  }
  emit("flow", "session", "turn", "queue");

  // Last, so the envelope row lands after everything the transcript and the
  // replay put in the flow — which is where it belongs: it says what the
  // calls from here on are carrying.
  await refreshRequestHeaders(sessionId);
}

async function loadHistory(sessionId, total) {
  if (!total) return;
  const start = Math.max(0, total - HISTORY_PAGE * HISTORY_PAGES_AT_OPEN);
  if (start > 0) {
    push({ kind: "note", text: t("flow.olderHidden", { count: start }) }, { silent: true });
  }
  for (let offset = start; offset < total; offset += HISTORY_PAGE) {
    const page = await call("session.history", {
      session_id: sessionId,
      offset,
      limit: HISTORY_PAGE,
    });
    if (state.sessionId !== sessionId) return;
    for (const message of page.messages || []) historyMessage(message);
  }
}

function historyMessage(message) {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content || "") }];

  for (const part of content) {
    if (part.type === "text") {
      if (!part.text || !part.text.trim()) continue;
      // Injected context (memory recall, hook output) is logged as a user
      // message. It is not something the user said, so it does not get a
      // bubble — but dropping it would misrepresent what the model answered
      // from, so it becomes a collapsed row.
      if (message.role === "user" && part.text.startsWith("<system-reminder>")) {
        push({ kind: "context", text: part.text }, { silent: true });
        continue;
      }
      push(
        message.role === "user"
          ? { kind: "user", text: part.text }
          : { kind: "assistant", text: part.text },
        { silent: true },
      );
    } else if (part.type === "thinking") {
      push({ kind: "think", text: part.thinking || "" }, { silent: true });
    } else if (part.type === "tool_use") {
      const block = push(
        { kind: "tool", id: part.id, name: part.name, input: part.input, status: "ok" },
        { silent: true },
      );
      state.tools.set(part.id, block);
    } else if (part.type === "tool_result") {
      const block = state.tools.get(part.tool_use_id);
      const text = toolResultText(part.content);
      if (block) {
        block.result = text;
        block.error = !!part.is_error;
        block.status = part.is_error ? "error" : "ok";
      } else {
        push(
          {
            kind: "tool",
            id: part.tool_use_id,
            name: t("flow.result"),
            result: text,
            error: !!part.is_error,
            status: part.is_error ? "error" : "ok",
          },
          { silent: true },
        );
      }
    } else if (part.type === "image") {
      push({ kind: "image", src: imageSource(part.source) }, { silent: true });
    }
  }
}

export function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part.type === "text" ? part.text : part.type === "image" ? t("flow.image") : JSON.stringify(part),
      )
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function imageSource(source) {
  if (!source) return "";
  if (source.type === "url") return source.url;
  return `data:${source.media_type || "image/png"};base64,${source.data || ""}`;
}

/* ── the reducer ──────────────────────────────────────────────────────── */

export function applyEvent(event, turnId, options = {}) {
  const silent = options.silent === true;
  const kind = event && event.kind;

  switch (kind) {
    case "user_message":
      endStream();
      push({ kind: "user", text: event.text || "" }, { silent });
      break;

    case "text_delta": {
      if (!state.stream) {
        state.stream = push({ kind: "assistant", text: "", streaming: true }, { silent });
      }
      state.stream.text += event.text || "";
      if (!silent) touch(state.stream);
      break;
    }

    case "tool_use": {
      endStream();
      const block = push(
        { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
        { silent },
      );
      state.tools.set(event.id, block);
      break;
    }

    case "tool_result": {
      const block = state.tools.get(event.id);
      const text = toolResultText(event.content);
      if (block) {
        block.result = text;
        block.error = !!event.is_error;
        block.status = event.is_error ? "error" : "ok";
        if (!silent) touch(block);
      } else {
        push(
          {
            kind: "tool",
            id: event.id,
            name: event.name || t("flow.result"),
            result: text,
            error: !!event.is_error,
            status: event.is_error ? "error" : "ok",
          },
          { silent },
        );
      }
      break;
    }

    case "prompt": {
      endStream();
      const timeout = (state.hello && state.hello.limits && state.hello.limits.prompt_timeout_secs) || 300;
      push({ kind: "ask", prompt: event, left: timeout }, { silent });
      break;
    }

    case "turn_state":
      state.turn = { turnId, state: event.state };
      if (event.state === "complete" || event.state === "interrupted") endStream();
      if (event.state === "interrupted") push({ kind: "note", text: t("flow.interrupted") }, { silent });
      emit("turn");
      break;

    case "compact":
      endStream();
      push({ kind: "compact", info: event }, { silent });
      break;

    case "turn_complete":
      endStream();
      state.usage = event.usage || state.usage;
      if (event.stop_reason && event.stop_reason !== "end_turn") {
        push({ kind: "note", text: t("flow.stopReason", { reason: event.stop_reason }) }, { silent });
      }
      emit("turn");
      // The envelope is on disk, not on the wire, so a turn is the cue to go
      // look. Not awaited: nothing in the conversation waits on a diagnostic,
      // and a replayed frame is not a fresh turn.
      if (!silent) refreshRequestHeaders(state.sessionId);
      break;

    case "subagent_progress":
      subagentEvent(event, silent);
      break;

    case "agent_state": {
      const group = agentGroup(event.agent_id, event.label || event.kind_of, silent);
      group.state = event.state;
      if (!silent) touch(group);
      break;
    }

    default:
      break;
  }
}

/* ── the request envelope ─────────────────────────────────────────────────
 *
 * What the model was sent minus the messages. AttaCore does not stream it;
 * it writes every call to a recording and `nest.requestHeaders` folds that
 * into the changes (see crates/hub/src/recordings.rs). So this is pulled at
 * the two moments it can have moved — opening a session, and finishing a
 * turn — rather than pushed.
 *
 * Reading files instead of frames is what makes an envelope survive a reload:
 * a session whose turns ran in a previous process still has one. The boundary
 * is the run — a resumed session's first call starts a new recording — so
 * `seen` is compared position by position rather than counted, and a
 * recording that no longer begins where ours did simply produces new rows. */
export async function refreshRequestHeaders(sessionId) {
  if (!sessionId) return;
  let answer;
  try {
    answer = await call("nest.requestHeaders", { session_id: sessionId });
  } catch (e) {
    // A diagnostic that cannot be read is not a reason to disturb a
    // conversation that is otherwise working.
    return;
  }
  if (state.sessionId !== sessionId) return;

  const headers = answer.headers || [];
  let shown = 0;
  while (
    shown < headers.length
    && shown < state.requestSeen.length
    && state.requestSeen[shown] === envelopeSignature(headers[shown])
  ) shown += 1;

  const fresh = headers.slice(shown);
  state.requestSeen = headers.map(envelopeSignature);
  for (const header of fresh) {
    const previous = state.request;
    push(
      { kind: "request", header, previous, change: headerChange(previous, header) },
      { silent: true },
    );
    state.request = header;
  }
  if (fresh.length) emit("flow");
}

/** What moved between two envelopes: the classification the row shows. */
export function headerChange(previous, header) {
  if (!previous) return "initial";
  const sameSystem = systemSignature(previous) === systemSignature(header);
  const sameTools = toolSignature(previous) === toolSignature(header);
  if (!sameSystem && !sameTools) return "systemAndTools";
  if (!sameSystem) return "system";
  if (!sameTools) return "tools";
  // The hub only reports an envelope that differs from the one before it, so
  // whatever is left is the call configuration: a model fallback, a changed
  // token ceiling, a thinking-mode switch.
  return "config";
}

function systemSignature(header) {
  return (header.system || [])
    .map((block) => `${block.role}\u0000${block.cache || ""}\u0000${block.text || ""}`)
    .join("\u0001");
}

function toolSignature(header) {
  return JSON.stringify(header.tools || []);
}

/** Identity of an envelope, for deciding what has already been rendered.
 *
 * Joined on NUL like `systemSignature` above, and for the same reason: a
 * separator that cannot occur inside a field is the only one that cannot make
 * two different envelopes agree by accident. */
function envelopeSignature(header) {
  return [
    header.model, header.max_tokens, JSON.stringify(header.thinking_mode),
    systemSignature(header), toolSignature(header),
  ].join("\0");
}

function subagentEvent(event, silent) {
  const group = agentGroup(event.agent_id, event.agent_label || event.agent_type, silent);
  const inner = event.event || {};
  if (inner.kind === "text_delta") {
    const last = group.lines[group.lines.length - 1];
    if (last && last.streaming) last.text += inner.text || "";
    else group.lines.push({ streaming: true, text: inner.text || "" });
  } else if (inner.kind === "tool_use") {
    group.lines.push({ text: `→ ${inner.name}` });
  } else if (inner.kind === "tool_result") {
    group.lines.push({ text: `← ${inner.name}${inner.is_error ? ` ${t("flow.toolFailed")}` : ""}` });
  } else if (inner.kind === "turn_complete") {
    group.lines.push({ text: t("flow.done") });
  }
  if (group.lines.length > 200) group.lines.splice(0, group.lines.length - 200);
  if (!silent) touch(group);
}

function agentGroup(id, label, silent) {
  let group = state.agents.get(id);
  if (!group) {
    endStream();
    group = push(
      { kind: "agent", id, label: label || "subagent", state: "running", lines: [] },
      { silent },
    );
    state.agents.set(id, group);
  }
  return group;
}

function endStream() {
  if (!state.stream) return;
  state.stream.streaming = false;
  touch(state.stream);
  state.stream = null;
}

/* ── actions ──────────────────────────────────────────────────────────── */

export async function send(text) {
  const message = text.trim();
  if (!message || !state.sessionId) return;
  const attachments = state.attachments.map((a) => a.attachment);
  state.attachments = [];
  emit("attachments");
  try {
    const result = await call("nest.send", {
      session_id: state.sessionId,
      message,
      attachments,
      on_busy: "queue",
    });
    if (result.queued) {
      state.queue = [...state.queue, result.item];
      emit("queue");
    } else {
      state.turn = { turnId: result.turn_id, state: "running" };
      emit("turn");
    }
  } catch (e) {
    push({ kind: "note", text: t("flow.sendFailed", { error: errorText(e) }), error: true });
  }
}

export async function interrupt() {
  if (!state.sessionId) return;
  try {
    await call("session.interrupt", { session_id: state.sessionId });
  } catch (e) {
    banner(t("composer.interruptFailed", { error: errorText(e) }));
  }
}

export async function answerPrompt(block, decision, label) {
  block.answered = label;
  touch(block);
  try {
    await call("session.respondToPrompt", {
      session_id: state.sessionId,
      prompt_id: block.prompt.prompt_id,
      decision,
    });
  } catch (e) {
    banner(t("perm.answerFailed", { error: errorText(e) }));
  }
}

export async function removeQueued(itemId) {
  try {
    const result = await call("nest.queue.remove", {
      session_id: state.sessionId,
      item_id: itemId,
    });
    state.queue = result.items || [];
    emit("queue");
  } catch (e) {
    banner(errorText(e));
  }
}

/** The session list, and the notes this product keeps about it.
 *
 * Two calls, because they come from two places on purpose: the hub holds
 * sessions and knows nothing about workspaces, and the store holds titles,
 * archived flags and view preferences and knows nothing about sessions. The
 * join is here because this is the only layer that has both halves.
 *
 * It used to be one call, back when both lived in the hub. Splitting the
 * layers moved the store out and this was not updated, so for a while a
 * rename wrote to disk and nothing read it back — and archiving, grouping
 * and every preference went with it. Nothing failed; the features simply
 * stopped happening. */
export async function refreshSessions() {
  try {
    const [listed, notes] = await Promise.all([
      call("nest.sessions"),
      call("nest.workspaces.list").catch(() => ({})),
    ]);

    state.workspaces = notes.workspaces || [];
    state.prefs = notes.prefs || {};
    if (typeof state.prefs.showArchived === "boolean") {
      state.showArchived = state.prefs.showArchived;
    }
    const overlay = notes.sessions || {};

    state.sessions = (listed.sessions || []).map((session) => {
      const note = overlay[session.session_id] || {};
      // A session's workspace is its project root matched against a
      // workspace's path — the one fact neither side could compute alone.
      const workspace = state.workspaces.find(
        (w) => w.path && w.path === session.project_root);
      return {
        ...session,
        // A title someone typed outranks the engine's generated name.
        name: note.title ?? session.name,
        renamed: Boolean(note.title),
        archived: Boolean(note.archived),
        workspace_id: workspace ? workspace.id : null,
      };
    });

    for (const session of state.sessions) {
      if (session.running) state.running.add(session.session_id);
      else state.running.delete(session.session_id);
    }
    emit("sessions");
  } catch (e) {
    banner(t("banner.sessionsFailed", { error: errorText(e) }));
  }
}

/* ── server notifications ─────────────────────────────────────────────── */

export function handleNotification(method, params) {
  if (method === "nest.event") {
    if (params.session_id !== state.sessionId) {
      state.running.add(params.session_id);
      emit("sessions");
      return;
    }
    if (params.seq <= state.seq) return;
    state.seq = params.seq;
    applyEvent(params.event, params.turn_id);
    return;
  }

  if (method === "nest.turn_settled") {
    state.running.delete(params.session_id);
    emit("sessions");
    if (params.session_id !== state.sessionId) return;
    endStream();
    state.turn = null;
    if (params.error) {
      push({ kind: "note", text: t("flow.turnFailed", { error: errorText(params.error) }), error: true });
    } else if (params.result) {
      if (params.result.usage) state.usage = params.result.usage;
      if (params.result.name && state.session) state.session.name = params.result.name;
    }
    emit("turn", "session");
    refreshSessions();
    return;
  }

  if (method === "nest.queue") {
    if (params.session_id !== state.sessionId) return;
    state.queue = params.items || [];
    emit("queue");
    return;
  }

  if (method === "nest.host_event") hostEvent(params);
}

/** Host events: not tied to any session.
 *
 * AttaCore emits exactly three kinds, and its protocol says so in as many
 * words. Handling kinds it does not send would be dead code that reads like
 * a feature — anyone looking would conclude the interface reports evictions
 * and config reloads, and it cannot, because nothing tells it. */
function hostEvent(params) {
  switch (params.kind) {
    case "mcp_connected":
      break;
    case "mcp_connect_failed":
      banner(t("banner.mcpFailed", { server: params.server, error: params.error || "" }));
      break;
    case "import_detected":
      break;
    default:
      break;
  }
}

