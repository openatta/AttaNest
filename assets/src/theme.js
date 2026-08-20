/** Light/dark: stored preference first, OS second, and a `<meta
 *  name="theme-color">` so the browser chrome follows the page. */

const KEY = "nest.theme";

export function initTheme() {
  apply(stored() || (prefersDark() ? "dark" : "light"));
  if (window.matchMedia) {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      if (!stored()) apply(query.matches ? "dark" : "light");
    };
    if (query.addEventListener) query.addEventListener("change", listener);
  }
}

export function toggleTheme() {
  setTheme(themeIsDark() ? "light" : "dark");
}

/** `"system"`, `"light"` or `"dark"` — what the user chose, not what is shown. */
export function currentThemeChoice() {
  return stored() || "system";
}

/** Store a choice and apply it. `"system"` clears the stored preference. */
export function setTheme(choice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice just does not survive a reload */
  }
  apply(choice === "system" ? (prefersDark() ? "dark" : "light") : choice);
}

export const themeIsDark = () => document.documentElement.dataset.theme === "dark";

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  // Measured after the attribute lands, so the tab color is whatever the page
  // actually paints rather than a second copy of the token.
  meta.content = getComputedStyle(document.body).backgroundColor || "";
}

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
