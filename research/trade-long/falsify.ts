// Falsification pass over the qualified archive. Reads each entry's stored
// evaluation artifact, runs the offline attack battery, writes a verdict to
// <entry>/audits/offline.json, and prints a summary. No backtests are run and
// no archive entry is deleted — a killed verdict is a status label, and the
// scheduler decides what to do with it.
//
// Usage: pnpm run falsify

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditArtifact, type EntryAudit, type EvaluationArtifact } from "./falsification.js";

const cwd = process.cwd();
const qualifiedDir = path.join(cwd, ".autoresearch", "qualified");

let entries: string[];
try {
  entries = (await readdir(qualifiedDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch {
  console.log(`no qualified archive at ${qualifiedDir}`);
  process.exit(0);
}

const auditedAt = new Date().toISOString();
const results: EntryAudit[] = [];

for (const entry of entries) {
  const artifactPath = path.join(qualifiedDir, entry, "evaluation.json");
  let artifact: EvaluationArtifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8")) as EvaluationArtifact;
  } catch {
    console.log(`${entry}: no readable evaluation.json; skipped`);
    continue;
  }
  const audit = auditArtifact(entry, artifact, auditedAt);
  const auditsDir = path.join(qualifiedDir, entry, "audits");
  await mkdir(auditsDir, { recursive: true });
  await writeFile(path.join(auditsDir, "offline.json"), `${JSON.stringify(audit, null, 2)}\n`);
  results.push(audit);
}

console.log("--- Falsification Audit (offline attacks) ---");
console.log(`${"Entry".padEnd(36)} ${"Verdict".padEnd(9)} Reasons`);
for (const result of results) {
  const reasons = result.audits.flatMap((audit) => audit.reasons);
  console.log(`${result.entry.padEnd(36)} ${result.verdict.padEnd(9)} ${reasons.join("; ") || "-"}`);
}
const counts = { survived: 0, weakened: 0, killed: 0 };
for (const result of results) counts[result.verdict] += 1;
console.log("---");
console.log(`audited: ${results.length}  survived: ${counts.survived}  weakened: ${counts.weakened}  killed: ${counts.killed}`);
