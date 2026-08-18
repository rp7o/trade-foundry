import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  foldVectorFromArtifact,
  isRedundantAgainst,
  tradeKeysFromArtifact
} from "./portfolio-diagnostics.js";

export type CycleOutcome = "active" | "qualified" | "falsified" | "inconclusive" | "invalid";

export interface ResearchCycle {
  schemaVersion: 1;
  id: string;
  hypothesisId: string;
  forecastingFamily: string;
  structuralBudget: number;
  attemptsConsumed: number;
  acceptedAttempts: number;
  outcome: CycleOutcome;
  startedAt: string;
  completedAt?: string;
}

export interface TrialLedgerEntry {
  schemaVersion: 1;
  timestamp: string;
  source: "baseline" | "agent-structure" | "parameter-search" | "manual" | "rescore";
  score?: number;
  error?: string;
  accepted: boolean;
  hypothesisId?: string;
  cycleId?: string;
  runRecord?: string;
  artifactFile?: string;
}

export function startCycle(
  hypothesisId: string,
  forecastingFamily: string,
  ordinal: number,
  structuralBudget: number,
  startedAt = new Date().toISOString()
): ResearchCycle {
  if (!Number.isInteger(structuralBudget) || structuralBudget <= 0) {
    throw new Error("structuralBudget must be a positive integer");
  }
  return {
    schemaVersion: 1,
    id: `${hypothesisId}-cycle-${String(ordinal).padStart(4, "0")}`,
    hypothesisId,
    forecastingFamily,
    structuralBudget,
    attemptsConsumed: 0,
    acceptedAttempts: 0,
    outcome: "active",
    startedAt
  };
}

export function recordCycleAttempt(
  cycle: ResearchCycle,
  accepted: boolean,
  completedAt = new Date().toISOString()
): ResearchCycle {
  if (cycle.outcome !== "active") throw new Error(`cycle ${cycle.id} is already ${cycle.outcome}`);
  const attemptsConsumed = cycle.attemptsConsumed + 1;
  const terminal = accepted || attemptsConsumed >= cycle.structuralBudget;
  return {
    ...cycle,
    attemptsConsumed,
    acceptedAttempts: cycle.acceptedAttempts + (accepted ? 1 : 0),
    outcome: accepted ? "qualified" : terminal ? "inconclusive" : "active",
    ...(terminal ? { completedAt } : {})
  };
}

export async function readCycle(cwd: string, hypothesisId: string): Promise<ResearchCycle | null> {
  try {
    return JSON.parse(await readFile(activeCyclePath(cwd, hypothesisId), "utf8")) as ResearchCycle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCycle(cwd: string, cycle: ResearchCycle): Promise<void> {
  const target = activeCyclePath(cwd, cycle.hypothesisId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(cycle, null, 2)}\n`);
}

export async function archiveCycle(cwd: string, cycle: ResearchCycle): Promise<void> {
  const target = path.join(cwd, "research/trade-long/hypotheses", cycle.hypothesisId, "cycles", `${cycle.id}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(cycle, null, 2)}\n`);
}

export async function appendTrial(cwd: string, entry: TrialLedgerEntry): Promise<void> {
  const target = path.join(cwd, ".autoresearch/trials.jsonl");
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`);
}

export async function readTrialSummary(cwd: string): Promise<{
  total: number;
  accepted: number;
  bySource: Record<string, number>;
}> {
  const entries = await readTrials(cwd);
  const bySource: Record<string, number> = {};
  for (const entry of entries) bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
  return { total: entries.length, accepted: entries.filter((entry) => entry.accepted).length, bySource };
}

export async function readTrials(cwd: string): Promise<TrialLedgerEntry[]> {
  let entries: TrialLedgerEntry[] = [];
  try {
    entries = (await readFile(path.join(cwd, ".autoresearch/trials.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrialLedgerEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const knownRuns = new Set(entries.map((entry) => entry.runRecord).filter(Boolean));
  const runsDir = path.join(cwd, ".autoresearch/runs");
  try {
    for (const file of (await readdir(runsDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".artifact.json"))) {
      const runRecord = path.posix.join(".autoresearch/runs", file);
      if (knownRuns.has(runRecord)) continue;
      const run = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as {
        timestamp?: unknown;
        score?: unknown;
        accepted?: unknown;
        contextId?: unknown;
        cycleId?: unknown;
        artifactFile?: unknown;
      };
      if (typeof run.timestamp !== "string" || typeof run.score !== "number" || typeof run.accepted !== "boolean") continue;
      entries.push({
        schemaVersion: 1,
        timestamp: run.timestamp,
        source: typeof run.contextId === "string" ? "agent-structure" : "manual",
        score: run.score,
        accepted: run.accepted,
        ...(typeof run.contextId === "string" ? { hypothesisId: run.contextId } : {}),
        ...(typeof run.cycleId === "string" ? { cycleId: run.cycleId } : {}),
        runRecord,
        ...(typeof run.artifactFile === "string" ? { artifactFile: run.artifactFile } : {})
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function preserveQualifiedCandidate(
  cwd: string,
  cycle: ResearchCycle,
  score: number,
  artifactFile?: string
): Promise<string> {
  const strategySource = await readFile(path.join(cwd, "research/trade-long/strategy.ts"), "utf8");
  const strategyHash = sha256(strategySource);
  let tradeFingerprint: string | undefined;
  let candidateFingerprint: { foldNames: string[]; foldVector: number[]; tradeKeys: Set<string> } | undefined;
  if (artifactFile) {
    const artifact = JSON.parse(await readFile(path.join(cwd, artifactFile), "utf8")) as {
      trades?: Array<{ symbol?: unknown; fold?: unknown; entryDate?: unknown; exitDate?: unknown }>;
      segments?: Array<{ name?: unknown; group?: unknown; value?: unknown }>;
    };
    if (artifact.trades?.length) {
      tradeFingerprint = sha256(JSON.stringify(artifact.trades.map((trade) => [
        trade.symbol, trade.fold, trade.entryDate, trade.exitDate
      ]).sort()));
    }
    const { names, values } = foldVectorFromArtifact(artifact);
    if (names.length > 0) {
      candidateFingerprint = { foldNames: names, foldVector: values, tradeKeys: tradeKeysFromArtifact(artifact) };
    }
  }
  const qualifiedRoot = path.join(cwd, ".autoresearch/qualified");
  try {
    for (const entry of await readdir(qualifiedRoot)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(qualifiedRoot, entry, "manifest.json"), "utf8")) as {
          strategyHash?: string;
          tradeFingerprint?: string;
        };
        if (manifest.strategyHash === strategyHash || (tradeFingerprint && manifest.tradeFingerprint === tradeFingerprint)) {
          return path.posix.join(".autoresearch/qualified", entry);
        }
        // Correlation-aware admission: a strategy that shares almost no trades
        // with an existing entry can still be the same bet (high fold
        // correlation). Reject it as redundant only when the correlation is
        // confidently high — the CI clears the threshold, never a point
        // estimate — so this stays inert until the folds actually support it.
        if (candidateFingerprint) {
          const existing = await readExistingFingerprint(path.join(qualifiedRoot, entry));
          if (existing && isRedundantAgainst(candidateFingerprint, existing)) {
            console.log(`admission: ${cycle.id} is confidently correlated with ${entry} despite low trade overlap; treated as redundant`);
            return path.posix.join(".autoresearch/qualified", entry);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const target = path.join(cwd, ".autoresearch/qualified", cycle.id);
  await mkdir(path.join(target, "research/trade-long"), { recursive: true });
  await copyFile(
    path.join(cwd, "research/trade-long/strategy.ts"),
    path.join(target, "research/trade-long/strategy.ts")
  );
  await copyFile(
    path.join(cwd, "research/trade-long/strategy.md"),
    path.join(target, "research/trade-long/strategy.md")
  );
  if (artifactFile) {
    await copyFile(path.join(cwd, artifactFile), path.join(target, "evaluation.json"));
  }
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    candidateId: cycle.id,
    hypothesisId: cycle.hypothesisId,
    forecastingFamily: cycle.forecastingFamily,
    score,
    attemptsConsumed: cycle.attemptsConsumed,
    strategyHash,
    tradeFingerprint,
    trialLedger: ".autoresearch/trials.jsonl",
    artifact: artifactFile ? "evaluation.json" : undefined
  }, null, 2)}\n`);
  return path.relative(cwd, target).replaceAll("\\", "/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readExistingFingerprint(
  entryDir: string
): Promise<{ foldNames: string[]; foldVector: number[]; tradeKeys: Set<string> } | null> {
  try {
    const artifact = JSON.parse(await readFile(path.join(entryDir, "evaluation.json"), "utf8")) as {
      trades?: Array<{ symbol?: unknown; fold?: unknown; entryDate?: unknown; exitDate?: unknown }>;
      segments?: Array<{ name?: unknown; group?: unknown; value?: unknown }>;
    };
    const { names, values } = foldVectorFromArtifact(artifact);
    if (names.length === 0) return null;
    return { foldNames: names, foldVector: values, tradeKeys: tradeKeysFromArtifact(artifact) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function activeCyclePath(cwd: string, hypothesisId: string): string {
  return path.join(cwd, ".autoresearch/hypotheses", hypothesisId, "cycle.json");
}
