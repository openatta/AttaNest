// Browser tests. Everything else in `tests/` runs on node alone and is what
// you run constantly; this is what the fake DOM cannot do — it renders
// nothing and lays nothing out, so it catches a wrong element id and misses a
// panel that is 4px wide or a theme that is unreadable.
//
//   npm install && npx playwright install chromium
//   node tests/browser/serve.mjs &        # or run `nest` yourself
//   npx playwright test

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  // A real backend is started by the suite itself, so there is one place that
  // knows how to stand this up rather than a paragraph in a README.
  globalSetup: "./tests/browser/setup.mjs",
  globalTeardown: "./tests/browser/teardown.mjs",
  // Failures here are usually layout, and a screenshot is the only useful
  // artifact for that.
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure", trace: "retain-on-failure" },
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
});
