/** Locale: one dictionary at a time, one `t()` everywhere.
 *
 * No user-facing string is written in a view. A view asks for a key; the
 * dictionary decides the words. A missing key renders as the key itself (and
 * warns once) — a visible `sidebar.search` on screen is a bug report, while a
 * silent empty string is a mystery.
 *
 * Switching locales re-renders the whole app rather than re-mounting it:
 * every view already re-renders from the store, so `setLocale` just tells them
 * all to. */

import zhCN from "./zh-CN.js";
import en from "./en.js";

const DICTIONARIES = { "zh-CN": zhCN, en };
const KEY = "nest.locale";

let locale = resolveInitial();
const listeners = [];
const warned = new Set();

/**
 * Translate.
 * @param {string} key dotted key, e.g. `sidebar.newSession`
 * @param {object} [vars] values for `{name}` placeholders
 */
export function t(key, vars) {
  const dictionary = DICTIONARIES[locale] || DICTIONARIES.en;
  let text = dictionary[key];
  if (text === undefined) {
    text = DICTIONARIES.en[key];
    if (text === undefined) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[i18n] missing key: ${key}`);
      }
      return key;
    }
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined ? whole : String(vars[name]));
}

/** Every locale the app ships, for the settings row. */
export function locales() {
  return [
    { id: "system", label: t("settings.language.system") },
    { id: "zh-CN", label: "简体中文" },
    { id: "en", label: "English" },
  ];
}

/** What the user chose (`"system"` included), not what is being rendered. */
export function localeChoice() {
  return stored() || "system";
}

/** The dictionary actually in use. */
export function currentLocale() {
  return locale;
}

export function setLocale(choice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice does not survive a reload */
  }
  const next = choice === "system" ? fromSystem() : choice;
  if (next === locale) return;
  locale = DICTIONARIES[next] ? next : "en";
  document.documentElement.lang = locale;
  for (const fn of listeners) fn(locale);
}

export function onLocaleChange(fn) {
  listeners.push(fn);
}

function resolveInitial() {
  const chosen = stored();
  const initial = chosen && DICTIONARIES[chosen] ? chosen : fromSystem();
  return initial;
}

function fromSystem() {
  const languages = (typeof navigator !== "undefined" && navigator.languages) || [];
  const tags = [...languages, (typeof navigator !== "undefined" && navigator.language) || ""];
  return tags.some((tag) => String(tag).toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
