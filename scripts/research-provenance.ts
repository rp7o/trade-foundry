import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Record the actual linked engine, never the private repository's HEAD. */
export function researchProvenance(workspace = process.cwd()) {
  const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  let revision: string | null = null;
  let dirty: boolean | null = null;
  let diffSha256: string | null = null;
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: engine, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    revision = git(["rev-parse", "HEAD"]).trim();
    dirty = git(["status", "--porcelain", "--untracked-files=normal"]).trim().length > 0;
    diffSha256 = dirty ? digest(git(["diff", "HEAD", "--binary"])) : null;
  } catch { /* Source archives need not contain Git metadata. */ }
  return {
    engine: { revision, dirty, diffSha256 },
    strategySha256: digest(readFileSync(path.join(workspace, "research/trade-long/strategy.ts"))),
    configSha256: digest(readFileSync(path.join(workspace, "autoresearch.config.json"))),
  };
}
