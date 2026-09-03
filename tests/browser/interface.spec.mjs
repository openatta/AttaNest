// What the fake DOM cannot check.
//
// `tests/dom.mjs` runs the real modules against a document that renders
// nothing and lays nothing out. It is fast, it is free, and it catches a
// mistyped element id or a reducer that drops an event kind. It cannot catch
// a panel that is four pixels wide, a theme whose text is the same colour as
// its background, or an icon that fills the row because a class lost its
// width.
//
// So this file only asserts things that need pixels or a real engine. Every
// behaviour that can be checked without a browser is checked without one.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { port } = JSON.parse(readFileSync(join(here, ".running.json"), "utf8"));
const URL = `http://127.0.0.1:${port}/`;

/** Console errors are failures. A page that throws while still looking right
 *  is the failure mode a screenshot cannot show. */
async function watchConsole(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("the page loads, connects, and lays out its columns", async ({ page }) => {
  const errors = await watchConsole(page);
  await page.goto(URL);

  // The handshake has to settle before anything is drawn — the shell draws by
  // asking the registry, and the registry is filled after `nest.hello`.
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });

  // The sidebar and the conversation both have real width. A collapsed or
  // zero-width column renders "fine" in a fake DOM and is unusable here.
  const side = await page.locator("#side").boundingBox();
  const main = await page.locator("#main").boundingBox();
  expect(side.width).toBeGreaterThan(120);
  expect(main.width).toBeGreaterThan(320);

  // The details column starts closed — closed is a zero-width grid column,
  // not a hidden element.
  expect((await page.locator("#details").boundingBox())?.width ?? 0).toBeLessThan(2);

  await page.evaluate(() => { document.getElementById("frame").dataset.details = "open"; });
  // The column is animated, so measuring straight after the attribute change
  // measures the first frame of the transition — 1px — not the result. This
  // is the whole reason a browser test is worth having and also the whole
  // reason it is easy to write a flaky one.
  await expect
    .poll(async () => (await page.locator("#details").boundingBox())?.width ?? 0, { timeout: 3_000 })
    .toBeGreaterThan(200);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("nothing scrolls the page sideways", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });
  for (const width of [1440, 1024, 720]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test("text is readable in both themes", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });

  // Contrast, crudely but usefully: the two colours must not be the same one.
  // A token that resolves to the wrong value in one theme usually lands
  // exactly here, and it is invisible to every test that does not paint.
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const { fg, bg } = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { fg: style.color, bg: style.backgroundColor };
    });
    expect(fg, `${theme}: text and background are the same colour`).not.toBe(bg);
    expect(bg, `${theme}: body has no background`).not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("icons are sized by a class, not left to fill the row", async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });
  // This has actually happened: an `icon()` call with no sizing class, and
  // the SVG grew to the height of its row. `tests/style-lint.mjs` checks that
  // every call site names a class; only a browser can check the result.
  const oversized = await page.evaluate(() =>
    [...document.querySelectorAll("svg")]
      .map((s) => s.getBoundingClientRect())
      .filter((r) => r.height > 64 || r.width > 64).length);
  expect(oversized, "an SVG grew past 64px").toBe(0);
});

test("the settings panel opens and every section draws", async ({ page }) => {
  const errors = await watchConsole(page);
  await page.goto(URL);
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });

  // The gear in the footer, clicked — not a module reached into. What is
  // under test includes the button existing and being clickable.
  await page.locator("#side .foot button").first().click();
  await expect(page.locator(".settings-nav")).toBeVisible();

  // Every section is a registration at `settings.section`; clicking each one
  // is how "registered but throws when drawn" is caught.
  const items = page.locator(".settings-nav .nav-item");
  const count = await items.count();
  expect(count, "no settings sections registered").toBeGreaterThan(4);
  for (let i = 0; i < count; i += 1) {
    await items.nth(i).click();
    await expect(page.locator(".settings-page")).toBeVisible();
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
