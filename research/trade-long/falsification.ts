// Adversarial falsification: offline attacks over archived qualified
// evaluation artifacts. Attacks consume stored evidence only — no backtests.
// Every threshold is pre-registered here as a constant; an attack whose
// threshold is chosen after seeing its result is not a falsification.
//
// Verdicts: "survived" (evidence holds), "weakened" (edge is real but
// concentrated or fragile), "killed" (the archived promotable flag is not
// supported by the stored evidence).

export type AuditVerdict = "survived" | "weakened" | "killed";

export interface AuditTrade {
  fold: string;
  symbol: string;
  profit: number;
}

export interface AuditRecord {
  attack: string;
  attackVersion: number;
  verdict: AuditVerdict;
  reasons: string[];
  metrics: Record<string, number>;
}

export interface EntryAudit {
  entry: string;
  auditedAt: string;
  verdict: AuditVerdict;
  audits: AuditRecord[];
}

// ─── Attack 1: sample adequacy ───────────────────────────────────────────────
// A promotable flag earned on a handful of trades is not evidence. Thresholds:
// below MIN_TOTAL_TRADES the fold statistics the promotion gates rely on are
// dominated by single trades. A long-only strategy may rationally remain
// inactive in weak years, but it must trade in at least half the periods.

export const MIN_TOTAL_TRADES = 30;

export function auditSampleAdequacy(trades: AuditTrade[], folds: string[]): AuditRecord {
  const perFold = new Map<string, number>(folds.map((fold) => [fold, 0]));
  for (const trade of trades) {
    perFold.set(trade.fold, (perFold.get(trade.fold) ?? 0) + 1);
  }
  const emptyFolds = folds.filter((fold) => (perFold.get(fold) ?? 0) === 0);
  const minFoldTrades = folds.length > 0
    ? Math.min(...folds.map((fold) => perFold.get(fold) ?? 0))
    : 0;

  const reasons: string[] = [];
  if (trades.length < MIN_TOTAL_TRADES) {
    reasons.push(`${trades.length} trades is below the ${MIN_TOTAL_TRADES}-trade evidence floor`);
  }
  if (folds.length === 0 || folds.length - emptyFolds.length < Math.ceil(folds.length / 2)) {
    reasons.push(`trades occur in fewer than half of ${folds.length} periods`);
  }

  return {
    attack: "sample-adequacy",
    attackVersion: 1,
    verdict: reasons.length > 0 ? "killed" : "survived",
    reasons,
    metrics: {
      totalTrades: trades.length,
      minTotalTrades: MIN_TOTAL_TRADES,
      emptyFolds: emptyFolds.length,
      minFoldTrades,
    },
  };
}

// ─── Attack 2: concentration and luck ────────────────────────────────────────
// Drop the single best trade, the best fold, and the best symbol, and see what
// remains. An edge that evaporates when one trade is removed is one trade.
// Killed when the best trade or best period alone supplies all profit. A
// strategy that depends on one calendar year is not stable across periods.
// Symbol concentration remains a weaker warning.

export const MAX_SINGLE_TRADE_SHARE = 0.5;

export function auditConcentration(trades: AuditTrade[], periodProfits?: number[]): AuditRecord {
  const total = sum(trades.map((trade) => trade.profit));
  const bestTrade = trades.length > 0 ? Math.max(...trades.map((trade) => trade.profit)) : 0;
  const withoutBestTrade = total - bestTrade;

  const byFold = groupProfit(trades, (trade) => trade.fold);
  const bySymbol = groupProfit(trades, (trade) => trade.symbol);
  const bestFoldProfit = periodProfits?.length ? Math.max(...periodProfits) : maxValue(byFold);
  const bestSymbolProfit = maxValue(bySymbol);
  const withoutBestFold = (periodProfits?.length ? sum(periodProfits) : total) - bestFoldProfit;
  const withoutBestSymbol = total - bestSymbolProfit;

  const reasons: string[] = [];
  let verdict: AuditVerdict = "survived";
  if (trades.length === 0 || withoutBestTrade <= 0) {
    verdict = "killed";
    reasons.push(
      trades.length === 0
        ? "no trades to audit"
        : `dropping the single best trade (${bestTrade.toFixed(2)}) erases the entire profit (${total.toFixed(2)})`
    );
  } else {
    if (total > 0 && bestTrade / total > MAX_SINGLE_TRADE_SHARE) {
      verdict = "weakened";
      reasons.push(`best trade carries ${((bestTrade / total) * 100).toFixed(0)}% of total profit (limit ${MAX_SINGLE_TRADE_SHARE * 100}%)`);
    }
    if (withoutBestFold <= 0) {
      verdict = "killed";
      reasons.push(`dropping the best fold (${bestFoldProfit.toFixed(2)}) flips total profit to ${withoutBestFold.toFixed(2)}`);
    }
    if (withoutBestSymbol <= 0) {
      if (verdict === "survived") verdict = "weakened";
      reasons.push(`dropping the best symbol (${bestSymbolProfit.toFixed(2)}) flips total profit to ${withoutBestSymbol.toFixed(2)}`);
    }
  }

  return {
    attack: "concentration",
    attackVersion: 1,
    verdict,
    reasons,
    metrics: {
      totalProfit: round2(total),
      bestTradeProfit: round2(bestTrade),
      profitWithoutBestTrade: round2(withoutBestTrade),
      profitWithoutBestFold: round2(withoutBestFold),
      profitWithoutBestSymbol: round2(withoutBestSymbol),
      profitGini: round2(profitGini(trades.map((trade) => trade.profit))),
    },
  };
}

// ─── Combined audit ──────────────────────────────────────────────────────────

export function auditEntry(entry: string, trades: AuditTrade[], folds: string[], auditedAt: string,
  periodProfits?: number[]): EntryAudit {
  const audits = [auditSampleAdequacy(trades, folds), auditConcentration(trades, periodProfits)];
  const verdict: AuditVerdict = audits.some((audit) => audit.verdict === "killed")
    ? "killed"
    : audits.some((audit) => audit.verdict === "weakened")
      ? "weakened"
      : "survived";
  return { entry, auditedAt, verdict, audits };
}

// ─── Artifact adapters ───────────────────────────────────────────────────────
// Both the falsify CLI and the workflow audit the same evaluation-artifact
// shape (`trades` array + `diagnostics.folds`). Keep the extraction here so a
// change to the artifact never leaves the two callers disagreeing.

export interface EvaluationArtifact {
  trades?: Array<{ fold?: unknown; symbol?: unknown; profit?: unknown }>;
  diagnostics?: { folds?: Array<{ name?: unknown; start?: unknown; end?: unknown }>;
    periodProfits?: Array<{ name?: unknown; profit?: unknown }> };
}

export function artifactTrades(artifact: EvaluationArtifact): AuditTrade[] {
  return (artifact.trades ?? [])
    .filter((trade) => typeof trade.fold === "string" && typeof trade.profit === "number")
    .map((trade) => ({
      fold: trade.fold as string,
      symbol: typeof trade.symbol === "string" ? trade.symbol : "unknown",
      profit: trade.profit as number,
    }));
}

export function artifactFolds(artifact: EvaluationArtifact, trades: AuditTrade[]): string[] {
  const named = (artifact.diagnostics?.folds ?? [])
    .map((fold) => String(fold.name ?? ""))
    .filter(Boolean);
  return named.length > 0 ? named : [...new Set(trades.map((trade) => trade.fold))].sort();
}

export function auditArtifact(entry: string, artifact: EvaluationArtifact, auditedAt: string): EntryAudit {
  const trades = artifactTrades(artifact);
  const folds = artifactFolds(artifact, trades);
  const periodProfits = artifact.diagnostics?.periodProfits;
  const aligned = periodProfits?.length === folds.length && periodProfits.every((period, index) =>
    period.name === folds[index] && typeof period.profit === "number" && Number.isFinite(period.profit));
  return auditEntry(entry, trades, folds, auditedAt,
    aligned ? periodProfits!.map((period) => period.profit as number) : undefined);
}

// ─── Archive reconciliation ──────────────────────────────────────────────────
// Pick the best-scoring archive entry that was not killed. Used to demote a
// killed champion: a survivor with a lower score is preferable to a champion
// whose edge does not withstand attack. Ties break on entry name for
// determinism. Returns null when nothing survives.

export interface ArchiveCandidate {
  entry: string;
  score: number;
  verdict: AuditVerdict;
}

export function selectBestSurviving(candidates: ArchiveCandidate[]): ArchiveCandidate | null {
  const survivors = candidates
    .filter((candidate) => candidate.verdict !== "killed" && Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.entry.localeCompare(b.entry));
  return survivors[0] ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function groupProfit(trades: AuditTrade[], key: (trade: AuditTrade) => string): Map<string, number> {
  const groups = new Map<string, number>();
  for (const trade of trades) {
    groups.set(key(trade), (groups.get(key(trade)) ?? 0) + trade.profit);
  }
  return groups;
}

function maxValue(groups: Map<string, number>): number {
  return groups.size > 0 ? Math.max(...groups.values()) : 0;
}

// Gini coefficient over positive trade profits: 0 = evenly spread wins,
// approaching 1 = one trade carries everything. Losses are excluded — the
// question is where the profit comes from, not the loss distribution.
function profitGini(profits: number[]): number {
  const wins = profits.filter((profit) => profit > 0).sort((a, b) => a - b);
  if (wins.length === 0) return 0;
  const total = sum(wins);
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < wins.length; i++) {
    weighted += (i + 1) * wins[i];
  }
  return (2 * weighted) / (wins.length * total) - (wins.length + 1) / wins.length;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}
