/** 16px line icons, drawn on a 24 viewBox at 1.7 stroke — inline so the page
 *  needs no icon font and no network. */

const wrap = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%"
        aria-hidden="true">${body}</svg>`;

export const ICON = {
  brand: `<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="currentColor" opacity="0.16"/>
    <path d="M10 22V10l12 12V10" stroke="currentColor" stroke-width="2.4" fill="none"
          stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: wrap(`<path d="M12 5v14M5 12h14"/>`),
  send: wrap(`<path d="M12 19V5M5 12l7-7 7 7"/>`),
  stop: wrap(`<rect x="7" y="7" width="10" height="10" rx="2"/>`),
  attach: wrap(`<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l8-8"/>`),
  panel: wrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>`),
  details: wrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>`),
  close: wrap(`<path d="M6 6l12 12M18 6L6 18"/>`),
  more: wrap(`<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>`),
  folder: wrap(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`),
  chat: wrap(`<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>`),
  terminal: wrap(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>`),
  file: wrap(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`),
  edit: wrap(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`),
  search: wrap(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`),
  globe: wrap(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>`),
  agent: wrap(`<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>`),
  shield: wrap(`<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/>`),
  compact: wrap(`<path d="M4 9h16M4 15h16M9 4l3 3 3-3M9 20l3-3 3 3"/>`),
  context: wrap(`<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>`),
  envelope: wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/>`),
  sun: wrap(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: wrap(`<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>`),
  check: wrap(`<path d="M20 6L9 17l-5-5"/>`),
  alert: wrap(`<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`),
  trash: wrap(`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`),
  fork: wrap(`<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="12" r="2"/><path d="M7 7v10M9 12h6M7 12c0-3 2-5 5-5"/>`),
  chevronDown: wrap(`<path d="m6 9 6 6 6-6"/>`),
  chevronRight: wrap(`<path d="m9 6 6 6-6 6"/>`),
  settings: wrap(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>`),
  refresh: wrap(`<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>`),
  key: wrap(`<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8-8M17 3l3 3-2 2-3-3"/>`),
  archive: wrap(`<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>`),
};

/** The icon that best matches a tool's name. */
export function toolIcon(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal")) return ICON.terminal;
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return ICON.edit;
  if (n.includes("read") || n.includes("file") || n.includes("notebook")) return ICON.file;
  if (n.includes("grep") || n.includes("glob") || n.includes("search")) return ICON.search;
  if (n.includes("web") || n.includes("fetch") || n.includes("url")) return ICON.globe;
  if (n.includes("agent") || n.includes("task") || n.includes("team")) return ICON.agent;
  if (n.includes("todo") || n.includes("plan")) return ICON.check;
  return ICON.terminal;
}
