// The interface, driven the way a person drives it, against a real backend.
//
// This is the layer that was missing. `reducer-smoke` runs the real modules
// against a scripted socket — fast, free, and it never touches the backend.
// `tests/api/` drives the backend with a bare client — thorough, and it never
// renders anything. Neither can tell you that clicking send makes a tool row
// appear.
//
// Turns are **replayed** from a recorded fixture, so what the model does is
// fixed: the same tool, the same arguments, every run. What is under test is
// everything between a keystroke and a pixel.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { port } = JSON.parse(readFileSync(join(here, ".running.json"), "utf8"));
const URL = `http://127.0.0.1:${port}/`;

/** Console errors are failures: a page that throws while still looking right
 *  is the failure a screenshot cannot show. */
async function watchConsole(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/** Open the app and start a session, the way the interface does it.
 *
 * The fixture is named through the same path a client uses, which is only
 * meaningful because the backend was started in replay — outside it, the name
 * is ignored and a real model is called. */
async function newSession(page, fixture) {
  await page.goto(URL);
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });
  const session = await page.evaluate(async (name) => {
    const { call } = await import("/runtime/client.js");
    const { openSession } = await import("/shell/session.js");
    const created = await call("session.create", {
      scene: "coding",
      project_root: null,
      options: { recorder: { name } },
    }).catch(() => call("session.create", { options: { recorder: { name } } }));
    await openSession(created.session_id);
    return created.session_id;
  }, fixture);
  expect(session, "no session was created").toBeTruthy();
  return session;
}

/** Type into the composer and press Enter, as a person would. */
async function say(page, text) {
  const input = page.locator("#input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

test("typing a message and pressing Enter puts it in the flow", async ({ page }) => {
  const errors = await watchConsole(page);
  await newSession(page, "says-ready");

  await say(page, "Say exactly: fixture ready");

  // The user's own message appears immediately — the engine emits no event
  // for it, so this is the hub's synthetic one arriving and being drawn.
  await expect(page.locator(".blk.u-row")).toContainText("fixture ready", { timeout: 15_000 });

  // And the model's reply streams into its own block.
  await expect(page.locator(".blk.a").first()).toContainText(/fixture ready/i, { timeout: 30_000 });

  // The composer clears itself, or the next message would carry the last one.
  await expect(page.locator("#input")).toHaveValue("");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a tool call draws a row that expands into its input and result", async ({ page }) => {
  const errors = await watchConsole(page);
  await newSession(page, "calls-a-tool");

  await say(page, "Use the Bash tool right now to run exactly: echo nest-fixture. "
    + "Call the tool. Do not answer in prose.");

  // By what it is, not by where it is.
  //
  // `.blk.row-item` is the 24px disclosure row, and tools are not the only
  // thing that uses it — injected context and compaction do too. On a backend
  // that has served a few sessions, a memory recall puts a context row above
  // the tool row, and "the first row" stops being the one under test.
  const row = page.locator(".blk.row-item").filter({ has: page.locator(".name", { hasText: /bash/i }) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator(".name")).toContainText(/bash/i);

  // Closed rows are one line high. A row that renders its whole result inline
  // buries the conversation, and the 24px geometry is the product.
  const closed = await row.boundingBox();
  expect(closed.height, "a closed tool row is taller than one line").toBeLessThan(64);

  await row.locator(".row-head").click();
  await expect
    .poll(async () => (await row.boundingBox()).height, { timeout: 3_000 })
    .toBeGreaterThan(closed.height);
  await expect(row).toContainText(/echo nest-fixture/);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("opening a tool row in the details pane shows it in full", async ({ page }) => {
  await newSession(page, "calls-a-tool");
  await say(page, "Use the Bash tool right now to run exactly: echo nest-fixture. "
    + "Call the tool. Do not answer in prose.");

  const row = page.locator(".blk.row-item")
    .filter({ has: page.locator(".name", { hasText: /bash/i }) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator(".row-head").click();
  await row.getByRole("button").filter({ hasText: /详情|details/i }).first().click();

  // `details.panel` — the other registered point — drawn, with real width.
  await expect
    .poll(async () => (await page.locator("#details").boundingBox())?.width ?? 0, { timeout: 3_000 })
    .toBeGreaterThan(200);
  await expect(page.locator("#details")).toContainText(/bash/i);
});

test("a permission ask is answerable from the flow", async ({ page }) => {
  const errors = await watchConsole(page);
  await newSession(page, "asks-permission");

  await say(page, "Use the Bash tool right now to run exactly: rm -f /tmp/nest-fixture-probe. "
    + "Call the tool. Do not answer in prose.");

  // The card, with its four answers and a countdown. The countdown is not
  // decoration: without it a session waiting on an unanswered ask looks
  // stuck, when it is actually walking towards a silent refusal.
  const ask = page.locator(".blk.ask").first();
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask.locator(".countdown")).not.toBeEmpty();
  const buttons = await ask.getByRole("button").count();
  expect(buttons, "a permission card with fewer than four answers").toBeGreaterThanOrEqual(4);

  await ask.getByRole("button").first().click();
  // Answered, and it says so rather than leaving the card looking live.
  await expect(ask).toHaveClass(/done/, { timeout: 15_000 });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("the session appears in the sidebar and reopens from it", async ({ page }) => {
  const session = await newSession(page, "says-ready");
  await say(page, "Say exactly: fixture ready");
  await expect(page.locator(".blk.a").first()).toContainText(/fixture ready/i, { timeout: 30_000 });

  // By id, not by position. The sidebar carries every session this backend
  // has — including the ones the other tests in this file made — so "the
  // first row" is whichever ran most recently, which is not a thing to
  // assert about.
  const row = page.locator(`#side .srow[data-sid="${session}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.locator("#conn.on")).toBeVisible({ timeout: 15_000 });
  await page.locator(`#side .srow[data-sid="${session}"]`).click();

  // Reopened from the transcript — a reload cleared whatever was in memory,
  // so what comes back has to have been read from disk.
  await expect(page.locator(".blk.a").first()).toContainText(/fixture ready/i, { timeout: 30_000 });
});
