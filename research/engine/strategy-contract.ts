// Vendored verbatim from the trading-strategy-engine project.
//
// Validates that a strategy file exports a well-behaved proposeTrade(history):
// correct proposal shape, no mutation of the supplied history, and sane
// reward/risk and stop-distance bounds. Run via: pnpm run strategy:shared-contract

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const strategyPathArg = process.argv[2];
if (!strategyPathArg) {
  console.error("Error: strategy path argument is required");
  process.exit(1);
}

const MIN_REWARD_RISK = 1.05;
const MIN_STOP_DISTANCE_PCT = 0.0025;
let proposeTrade: any;

async function main() {
  const strategy = await import(pathToFileURL(resolve(strategyPathArg)).href);
  proposeTrade = strategy.proposeTrade;
  if (typeof proposeTrade !== "function") {
    throw new Error("Strategy file must export proposeTrade(history)");
  }
  const isNeutralBoilerplate = strategy.STRATEGY_BOILERPLATE === true;

  const histories = [
    makeHistory(90, "trend"),
    makeHistory(90, "pullback"),
    makeHistory(30, "trend")
  ];

  let nonNullProposals = 0;
  for (const history of histories) {
    const before = JSON.stringify(history);
    const market = { index: makeMarketIndex(history) };
    const first = proposeTrade(cloneHistory(history), market);
    const second = proposeTrade(cloneHistory(history), market);
    assert.deepEqual(second, first, "proposeTrade must be deterministic for identical input");
    assert.equal(JSON.stringify(history), before, "proposeTrade must not mutate history");
    assertProposalContract(first);
    if (first !== null) nonNullProposals += 1;
  }

  if (isNeutralBoilerplate && nonNullProposals === 0) {
    console.log("strategy contract skipped for neutral boilerplate");
    return;
  }
  assert.ok(nonNullProposals > 0, "proposeTrade must return a proposal for at least one contract history");
  console.log("strategy contract ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function assertProposalContract(proposal: unknown): void {
  if (proposal === null) {
    return;
  }

  assert.equal(typeof proposal, "object", "proposal must be an object or null");
  assert.ok(proposal, "proposal must be an object or null");

  const keys = Object.keys(proposal as object).sort();
  assert.deepEqual(
    keys,
    ["entry", "maxHoldDays", "regime", "setup", "side", "stopLoss", "strategyVersion", "target"],
    "proposal must contain exactly the strategy contract fields"
  );

  const typed = proposal as {
    side: unknown;
    entry: unknown;
    stopLoss: unknown;
    target: unknown;
    maxHoldDays: unknown;
    setup: unknown;
    regime: unknown;
    strategyVersion: unknown;
  };
  assert.ok(typed.side === "long" || typed.side === "short", "side must be 'long' or 'short'");
  assert.equal(typeof typed.entry, "object", "entry must be an object");
  assert.ok(typed.entry, "entry must be an object");
  assert.deepEqual(
    Object.keys(typed.entry as object).sort(),
    ["max", "min"],
    "entry must contain exactly min and max"
  );
  const entry = typed.entry as { min: unknown; max: unknown };
  assertFiniteNumber(entry.min, "entry.min");
  assertFiniteNumber(entry.max, "entry.max");
  assertFiniteNumber(typed.stopLoss, "stopLoss");
  // target === null means "no profit target": the position exits on stop,
  // max hold, or an exit signal only. Any other value must be a finite number.
  if (typed.target !== null) {
    assertFiniteNumber(typed.target, "target");
  }
  assertPositiveInteger(typed.maxHoldDays, "maxHoldDays");
  assertNonEmptyString(typed.setup, "setup");
  assertNonEmptyString(typed.regime, "regime");
  assertNonEmptyString(typed.strategyVersion, "strategyVersion");

  const entryMin = entry.min as number;
  const entryMax = entry.max as number;
  const stopLoss = typed.stopLoss as number;
  const target = typed.target as number | null;
  const side = typed.side as "long" | "short";
  const validProposal = typed as {
    side: "long" | "short";
    entry: { min: number; max: number };
    stopLoss: number;
    target: number | null;
  };

  assert.ok(entryMin > 0, "entry.min must be positive");
  assert.ok(entryMax >= entryMin, "entry.max must be at least entry.min");
  const worstEntry = worstCaseEntry(validProposal);
  if (side === "long") {
    assert.ok(entryMin > stopLoss, "entry range must be above stopLoss for long trades");
    if (target !== null) {
      assert.ok(target > entryMax, "target must be above entry range for long trades");
    }
    assertStopDistance(worstEntry - stopLoss, worstEntry);
  } else {
    assert.ok(stopLoss > entryMax, "stopLoss must be above entry range for short trades");
    if (target !== null) {
      assert.ok(entryMin > target, "entry range must be above target for short trades");
    }
    assertStopDistance(stopLoss - worstEntry, worstEntry);
  }
  assert.ok(
    proposalRewardRisk(validProposal) >= MIN_REWARD_RISK,
    `worst-case reward/risk must be at least ${MIN_REWARD_RISK}`
  );
}

function worstCaseEntry(proposal: { side: "long" | "short"; entry: { min: number; max: number } }): number {
  return proposal.side === "long" ? proposal.entry.max : proposal.entry.min;
}

function proposalRewardRisk(proposal: {
  side: "long" | "short";
  entry: { min: number; max: number };
  stopLoss: number;
  target: number | null;
}): number {
  const entry = worstCaseEntry(proposal);
  const risk = proposal.side === "long"
    ? entry - proposal.stopLoss
    : proposal.stopLoss - entry;
  if (risk <= 0) return -Infinity;
  // No profit target means upside is not capped, so there is no finite
  // reward/risk to test against the minimum.
  if (proposal.target === null) return Infinity;
  const reward = proposal.side === "long"
    ? proposal.target - entry
    : entry - proposal.target;
  return reward / risk;
}

function assertStopDistance(stopDistance: number, entry: number): void {
  assert.ok(
    stopDistance / entry >= MIN_STOP_DISTANCE_PCT,
    `stop distance must be at least ${(MIN_STOP_DISTANCE_PCT * 100).toFixed(2)}% of entry`
  );
}

function assertFiniteNumber(value: unknown, name: string): void {
  assert.equal(typeof value, "number", `${name} must be a number`);
  assert.ok(Number.isFinite(value), `${name} must be finite`);
}

function assertPositiveInteger(value: unknown, name: string): void {
  assert.equal(typeof value, "number", `${name} must be a number`);
  assert.ok(Number.isInteger(value) && (value as number) > 0, `${name} must be a positive integer`);
}

function assertNonEmptyString(value: unknown, name: string): void {
  assert.equal(typeof value, "string", `${name} must be a string`);
  assert.ok((value as string).trim().length > 0, `${name} must not be empty`);
}

function cloneHistory(history: Candle[]): Candle[] {
  return history.map((candle) => ({ ...candle }));
}

function makeMarketIndex(history: Candle[]): { date: string; close: number }[] {
  // Synthetic benchmark aligned to the contract history so market-relative
  // strategies (e.g. genomes reading marketRoc) can evaluate their entry.
  return history.map((candle, index) => ({ date: candle.date, close: 1000 + index * 0.5 }));
}

function makeHistory(length: number, mode: "trend" | "pullback"): Candle[] {
  const candles: Candle[] = [];
  let close = 100;

  for (let index = 0; index < length; index += 1) {
    const trend = mode === "trend" ? 0.08 : 0.06;
    const wave = Math.sin(index / 4) * 0.18;
    close += trend + wave;
    if (mode === "pullback" && index > length - 6) {
      close -= 0.22;
    }

    const open = close - 0.12;
    const high = Math.max(open, close) + 0.35;
    const low = Math.min(open, close) - 0.35;
    candles.push({
      date: `2025-01-${String(index + 1).padStart(2, "0")}`,
      open,
      high,
      low,
      close,
      volume: 200_000 + index * 1000
    });
  }

  return candles;
}
