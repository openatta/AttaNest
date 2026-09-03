// Build once, start one backend, and tell the tests where it is.
//
// A real engine with a real settings tree, on a throwaway directory. No
// model credential is configured, so nothing here sends a turn — what is
// under test is the interface, and a turn would make the suite depend on a
// provider being reachable.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = 4287;

export default async function setup() {
  const binary = join(root, "target", "release", "nest");
  if (!existsSync(binary)) {
    execFileSync("cargo", ["build", "--release", "-p", "nest"], { cwd: root, stdio: "inherit" });
  }

  const scratch = mkdtempSync(join(tmpdir(), "nest-browser-"));
  // Replaying, so a turn driven from the browser is deterministic and costs
  // nothing. Without it these tests would need a provider to be reachable and
  // in a good mood, and a layout test that fails because a model was slow is
  // a test people learn to ignore.
  const child = spawn(
    binary,
    ["--port", String(PORT), "--ui-dir", join(root, "ui"),
     "--atta-dir", join(scratch, "atta"), "--data-dir", join(scratch, "projects"),
     "--replay-dir", join(root, "tests", "api", "fixtures", "recordings")],
    {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: "browser-test", RUST_LOG: "warn" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  // Wait for the page to answer, rather than sleeping and hoping.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`nest did not start in 30s:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  writeFileSync(
    join(root, "tests", "browser", ".running.json"),
    JSON.stringify({ pid: child.pid, port: PORT, scratch }),
  );
  process.env.NEST_URL = `http://127.0.0.1:${PORT}/`;
  child.unref();
  return () => {};
}
