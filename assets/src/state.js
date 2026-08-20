/** The store: one object plus a change feed.
 *
 * Views subscribe to the slices they render and re-render on their own; there
 * is no diffing layer, because every slice is small and the flow is append-
 * mostly. `emit` is coalesced to one microtask so a burst of events (a turn
 * settling touches turn, usage, queue and sessions) repaints once. */

export const state = {
  connection: "connecting",
  hello: null,
  commands: [],
  scenes: [],
  sessions: [],
  workspaces: [],
  prefs: {},
  running: new Set(),
  searchQuery: "",
  searchHits: null,
  searchTruncated: false,
  showArchived: false,
  /// Workspace ids currently showing every session rather than the first page.
  expandedGroups: new Set(),
  settings: null,
  settingsTier: "global",

  sessionId: null,
  session: null,
  blocks: [],
  tools: new Map(),
  agents: new Map(),
  stream: null,
  seq: 0,
  turn: null,
  queue: [],
  usage: null,
  attachments: [],
  detail: null,
  banner: null,
  /// The request envelope in force: the newest one `nest.requestHeaders`
  /// reported. The hub folds a recording down to its changes, so this is what
  /// every call since then carried.
  request: null,
  /// Signatures of the envelopes already rendered as rows, in order — what
  /// tells a re-read which of them are new. Positions, not a count: a resumed
  /// session records into a fresh file, so the list can be replaced rather
  /// than extended.
  requestSeen: [],
};

const subscribers = new Map();
let queued = null;

/**
 * Subscribe to a topic.
 * @param {string} topic one of: connection, sessions, session, flow, turn,
 *   queue, attachments, detail, banner, commands, search, settings
 */
export function subscribe(topic, fn) {
  if (!subscribers.has(topic)) subscribers.set(topic, []);
  subscribers.get(topic).push(fn);
}

export function emit(...topics) {
  if (!queued) {
    queued = new Set();
    Promise.resolve().then(() => {
      const flushing = queued;
      queued = null;
      for (const topic of flushing) {
        for (const fn of subscribers.get(topic) || []) fn(state);
      }
    });
  }
  for (const topic of topics) queued.add(topic);
}

/** Reset everything that belongs to one open session. */
export function resetSession(sessionId) {
  state.sessionId = sessionId;
  state.session = null;
  state.blocks = [];
  state.tools = new Map();
  state.agents = new Map();
  state.stream = null;
  state.seq = 0;
  state.turn = null;
  state.queue = [];
  state.usage = null;
  state.attachments = [];
  state.detail = null;
  state.request = null;
  state.requestSeen = [];
}
