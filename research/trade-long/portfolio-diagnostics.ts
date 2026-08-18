// Offline redundancy diagnostics over the qualified archive.
//
// The leaderboard ranks strategies by their individual walk-forward score and
// cannot see how they relate to one another. Two lineages can share zero trades
// yet be nearly the same bet (high fold-profit correlation), and a lower-scoring
// lineage can be the most valuable thing in the archive precisely because it is
// uncorrelated with the champion. This module surfaces that structure from data
// already on disk — no new evaluations.
//
// Everything here is deterministic and seeded. Every correlation is reported
// with a bootstrap confidence interval, and n is small (one point per fold), so
// the intervals are wide on purpose: the qualitative disagreement between
// correlation and trade overlap is robust; the point estimates are not.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface LineageEntry {
  lineage: string; // hypothesisId — the breeding unit
  entryId: string; // candidateId — the specific qualified cycle
  score: number;
  foldNames: string[]; // sorted; the fold "signature"
  foldVector: number[]; // per-fold profit, aligned to foldNames
  tradeKeys: Set<string>; // symbol|fold|entryDate|exitDate, the trade identity
}

export interface CorrelationCI {
  estimate: number | null; // null when a vector has zero variance
  lower: number | null;
  upper: number | null;
  resamples: number;
}

export interface PairRedundancy {
  a: string;
  b: string;
  correlation: CorrelationCI;
  sharedTrades: number;
  jaccard: number;
  // The interesting signal: confidently correlated yet almost no shared trades —
  // the same exposure reached through different logic, invisible to the existing
  // trade-overlap admission check.
  flagged: boolean;
}

export interface RedundancyReport {
  foldSignature: string[];
  lineages: string[];
  excluded: Array<{ lineage: string; entryId: string; reason: string }>;
  pairs: PairRedundancy[];
  generatedAt: string;
}

// A correlation is only trustworthy enough to act on when its confidence
// interval clears the threshold — a point estimate at n≈6 is nearly
// uninformative. `flagged` and every scheduler decision use this, never the
// point estimate alone.
export const REDUNDANCY_CORRELATION = 0.9;
export const REDUNDANCY_MAX_JACCARD = 0.1;

const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 0xbeef;
const BOOTSTRAP_ALPHA = 0.05;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Pearson correlation. Returns null when either vector is constant — an
// undefined correlation, not zero.
export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2 || b.length !== n) return null;
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa === 0 || sbb === 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function sharedTradeCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[Math.min(base + 1, sorted.length - 1)];
  return sorted[base] + rest * (next - sorted[base]);
}

// Paired bootstrap over fold indices, seeded for determinism. The interval is
// the percentile band of the resampled correlation. Degenerate resamples (a
// constant vector) are dropped, not counted as zero.
export function correlationWithCI(
  a: number[],
  b: number[],
  options: { resamples?: number; seed?: number; alpha?: number } = {}
): CorrelationCI {
  const estimate = pearson(a, b);
  if (estimate === null) return { estimate: null, lower: null, upper: null, resamples: 0 };
  const n = a.length;
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const alpha = options.alpha ?? BOOTSTRAP_ALPHA;
  const rand = mulberry32(options.seed ?? BOOTSTRAP_SEED);
  const draws: number[] = [];
  for (let k = 0; k < resamples; k += 1) {
    const ra: number[] = new Array(n);
    const rb: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rand() * n);
      ra[i] = a[idx];
      rb[i] = b[idx];
    }
    const r = pearson(ra, rb);
    if (r !== null) draws.push(r);
  }
  if (draws.length === 0) return { estimate, lower: null, upper: null, resamples: 0 };
  draws.sort((x, y) => x - y);
  return {
    estimate,
    lower: quantile(draws, alpha / 2),
    upper: quantile(draws, 1 - alpha / 2),
    resamples: draws.length
  };
}

// A correlation is confidently high only when the whole interval clears the
// threshold — i.e. the interval does not span down toward zero. This is the
// "refuse to act on intervals spanning zero" rule the plan requires.
export function isConfidentlyCorrelated(
  ci: CorrelationCI,
  threshold: number = REDUNDANCY_CORRELATION
): boolean {
  return ci.lower !== null && ci.lower >= threshold;
}

interface EvaluationArtifact {
  segments?: Array<{ name?: unknown; group?: unknown; value?: unknown }>;
  trades?: Array<{ symbol?: unknown; fold?: unknown; entryDate?: unknown; exitDate?: unknown }>;
}

export function foldVectorFromArtifact(artifact: EvaluationArtifact): { names: string[]; values: number[] } {
  const folds = new Map<string, number>();
  for (const segment of artifact.segments ?? []) {
    if (segment.group === "fold" && typeof segment.name === "string" && typeof segment.value === "number") {
      folds.set(segment.name, segment.value);
    }
  }
  const names = [...folds.keys()].sort();
  return { names, values: names.map((name) => folds.get(name) as number) };
}

export function tradeKeysFromArtifact(artifact: EvaluationArtifact): Set<string> {
  const keys = new Set<string>();
  for (const trade of artifact.trades ?? []) {
    keys.add(`${String(trade.symbol)}|${String(trade.fold)}|${String(trade.entryDate)}|${String(trade.exitDate)}`);
  }
  return keys;
}

// Refuse to compare entries whose fold signatures differ. Correlating profit
// vectors that are indexed by different folds is meaningless; nothing else in
// the codebase enforces that the archive's fold signatures agree.
export function assertAligned(entries: LineageEntry[]): void {
  if (entries.length < 2) return;
  const signature = entries[0].foldNames.join("\n");
  for (const entry of entries.slice(1)) {
    if (entry.foldNames.join("\n") !== signature) {
      throw new Error(
        `fold signatures differ: ${entries[0].entryId} vs ${entry.entryId} — refusing to compare`
      );
    }
  }
}

// Load the best qualified entry per lineage. Entries whose fold signature does
// not match the dominant (largest) aligned group are excluded from comparison
// and reported, never silently correlated against a mismatched index.
export async function loadArchiveLineages(
  cwd: string
): Promise<{ entries: LineageEntry[]; excluded: RedundancyReport["excluded"] }> {
  const qualifiedRoot = path.join(cwd, ".autoresearch/qualified");
  let dirs: string[];
  try {
    dirs = (await readdir(qualifiedRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], excluded: [] };
    throw error;
  }

  const bestByLineage = new Map<string, LineageEntry>();
  for (const dir of dirs) {
    let manifest: { hypothesisId?: unknown; candidateId?: unknown; score?: unknown };
    let artifact: EvaluationArtifact;
    try {
      manifest = JSON.parse(await readFile(path.join(qualifiedRoot, dir, "manifest.json"), "utf8"));
      artifact = JSON.parse(await readFile(path.join(qualifiedRoot, dir, "evaluation.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const lineage = typeof manifest.hypothesisId === "string" ? manifest.hypothesisId : dir;
    const score = typeof manifest.score === "number" ? manifest.score : Number.NEGATIVE_INFINITY;
    const { names, values } = foldVectorFromArtifact(artifact);
    if (names.length === 0) continue;
    const entry: LineageEntry = {
      lineage,
      entryId: typeof manifest.candidateId === "string" ? manifest.candidateId : dir,
      score,
      foldNames: names,
      foldVector: values,
      tradeKeys: tradeKeysFromArtifact(artifact)
    };
    const existing = bestByLineage.get(lineage);
    if (!existing || score > existing.score) bestByLineage.set(lineage, entry);
  }

  const all = [...bestByLineage.values()];
  // Choose the dominant fold signature; exclude everything that does not align.
  const bySignature = new Map<string, LineageEntry[]>();
  for (const entry of all) {
    const signature = entry.foldNames.join("\n");
    const group = bySignature.get(signature) ?? [];
    group.push(entry);
    bySignature.set(signature, group);
  }
  const dominant = [...bySignature.values()].sort(
    (x, y) => y.length - x.length || y[0].foldNames.length - x[0].foldNames.length
  )[0];
  const dominantSignature = dominant ? dominant[0].foldNames.join("\n") : "";
  const entries = (dominant ?? []).sort((x, y) => x.lineage.localeCompare(y.lineage));
  const excluded = all
    .filter((entry) => entry.foldNames.join("\n") !== dominantSignature)
    .map((entry) => ({
      lineage: entry.lineage,
      entryId: entry.entryId,
      reason: "fold signature does not match the dominant aligned group"
    }));
  return { entries, excluded };
}

export function pairwiseRedundancy(entries: LineageEntry[]): PairRedundancy[] {
  assertAligned(entries);
  const pairs: PairRedundancy[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const correlation = correlationWithCI(a.foldVector, b.foldVector);
      const shared = sharedTradeCount(a.tradeKeys, b.tradeKeys);
      const overlap = jaccard(a.tradeKeys, b.tradeKeys);
      pairs.push({
        a: a.lineage,
        b: b.lineage,
        correlation,
        sharedTrades: shared,
        jaccard: overlap,
        flagged: isConfidentlyCorrelated(correlation) && overlap <= REDUNDANCY_MAX_JACCARD
      });
    }
  }
  return pairs;
}

// Correlation between two lineages' best archived entries, or null when either
// is absent from the aligned archive or their signatures differ. Used by the
// scheduler to pick diversifying breeding partners.
export function correlationBetween(
  entries: LineageEntry[],
  lineageA: string,
  lineageB: string
): CorrelationCI | null {
  const a = entries.find((entry) => entry.lineage === lineageA);
  const b = entries.find((entry) => entry.lineage === lineageB);
  if (!a || !b) return null;
  if (a.foldNames.join("\n") !== b.foldNames.join("\n")) return null;
  return correlationWithCI(a.foldVector, b.foldVector);
}

// Would admitting `candidate` be redundant against `existing`? Only when the
// fold signatures align, the correlation is confidently high (CI clears the
// threshold — never a point estimate), and the trade overlap is low: the
// high-correlation / low-overlap duplicate the trade-overlap check misses.
export function isRedundantAgainst(
  candidate: { foldNames: string[]; foldVector: number[]; tradeKeys: Set<string> },
  existing: { foldNames: string[]; foldVector: number[]; tradeKeys: Set<string> },
  options: { correlation?: number; maxJaccard?: number } = {}
): boolean {
  if (candidate.foldNames.join("\n") !== existing.foldNames.join("\n")) return false;
  const ci = correlationWithCI(candidate.foldVector, existing.foldVector);
  if (!isConfidentlyCorrelated(ci, options.correlation ?? REDUNDANCY_CORRELATION)) return false;
  return jaccard(candidate.tradeKeys, existing.tradeKeys) <= (options.maxJaccard ?? REDUNDANCY_MAX_JACCARD);
}

export async function buildRedundancyReport(cwd: string): Promise<RedundancyReport> {
  const { entries, excluded } = await loadArchiveLineages(cwd);
  return {
    foldSignature: entries[0]?.foldNames ?? [],
    lineages: entries.map((entry) => entry.lineage),
    excluded,
    pairs: pairwiseRedundancy(entries),
    generatedAt: new Date().toISOString()
  };
}

function fmt(value: number | null): string {
  return value === null ? "   n/a" : value.toFixed(2).padStart(6);
}

export function formatRedundancyReport(report: RedundancyReport): string {
  const lines: string[] = [];
  lines.push("--- Portfolio Redundancy Diagnostics (offline, no evaluations) ---");
  if (report.lineages.length < 2) {
    lines.push(`not enough aligned archive lineages to compare (${report.lineages.length}).`);
    return lines.join("\n");
  }
  lines.push(`fold signature: ${report.foldSignature.join(", ")}`);
  lines.push(`lineages: ${report.lineages.join(", ")}`);
  if (report.excluded.length > 0) {
    lines.push("excluded (fold signature mismatch):");
    for (const entry of report.excluded) lines.push(`  ${entry.entryId} — ${entry.reason}`);
  }
  lines.push("");
  lines.push(
    `${"Pair".padEnd(28)} ${"r".padStart(6)} ${"[lo".padStart(6)} ${"hi]".padStart(6)} ${"shared".padStart(7)} ${"jacc".padStart(6)}  flag`
  );
  for (const pair of report.pairs) {
    lines.push(
      `${`${pair.a} · ${pair.b}`.padEnd(28)} ${fmt(pair.correlation.estimate)} ${fmt(pair.correlation.lower)} ${fmt(
        pair.correlation.upper
      )} ${String(pair.sharedTrades).padStart(7)} ${pair.jaccard.toFixed(3).padStart(6)}  ${pair.flagged ? "REDUNDANT" : "-"}`
    );
  }
  const flagged = report.pairs.filter((pair) => pair.flagged);
  lines.push("");
  lines.push(
    flagged.length > 0
      ? `flagged ${flagged.length} confidently-correlated low-overlap pair(s): ${flagged
          .map((pair) => `${pair.a}·${pair.b}`)
          .join(", ")}`
      : "no pair is confidently correlated at the current interval width — point estimates are not actionable at this n."
  );
  return lines.join("\n");
}
