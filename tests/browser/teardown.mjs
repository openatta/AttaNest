import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const marker = join(here, ".running.json");

export default async function teardown() {
  if (!existsSync(marker)) return;
  const { pid, scratch } = JSON.parse(readFileSync(marker, "utf8"));
  try { process.kill(pid); } catch { /* already gone */ }
  rmSync(marker, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
