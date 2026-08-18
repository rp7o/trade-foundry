// Offline portfolio redundancy diagnostics over the qualified archive.
// Computes pairwise fold-profit correlation (with bootstrap confidence
// intervals) and trade overlap across the best entry per lineage, writes a
// deterministic report to .autoresearch/portfolio-diagnostics.json, and prints
// a summary. Runs no backtests and mutates no archive entry.
//
// Usage: pnpm run portfolio:diagnose

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRedundancyReport, formatRedundancyReport } from "./portfolio-diagnostics.js";

const cwd = process.cwd();
const report = await buildRedundancyReport(cwd);

const serialisable = {
  ...report,
  pairs: report.pairs.map((pair) => ({ ...pair }))
};
const outDir = path.join(cwd, ".autoresearch");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "portfolio-diagnostics.json"),
  `${JSON.stringify(serialisable, null, 2)}\n`
);

console.log(formatRedundancyReport(report));
console.log(`\nwrote .autoresearch/portfolio-diagnostics.json`);
