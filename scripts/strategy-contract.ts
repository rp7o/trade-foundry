import assert from "node:assert/strict";
import type { Candle, TradeProposal } from "../research/trade-long/strategy.js";
import { proposalRewardRisk, worstCaseEntry } from "../research/trade-long/trade-model.js";

const strategy = await import("../research/trade-long/strategy.js") as {
  proposeTrade: (history: Candle[]) => TradeProposal | null;
  STRATEGY_BOILERPLATE?: boolean;
};
const { proposeTrade } = strategy;

const MIN_REWARD_RISK = 1.05;
const MIN_STOP_DISTANCE_PCT = 0.0025;

const histories = [
  { name: "90-bar steady uptrend", candles: makeHistory(90, "trend") },
  { name: "90-bar uptrend with late pullback", candles: makeHistory(90, "pullback") },
  { name: "30-bar steady uptrend", candles: makeHistory(30, "trend") }
];

let nonNullProposals = 0;
const contractOutcomes: string[] = [];
for (const { name, candles } of histories) {
  const history = candles;
  const before = JSON.stringify(history);
  const first = proposeTrade(cloneHistory(history));
  const second = proposeTrade(cloneHistory(history));
  assert.deepEqual(second, first, "proposeTrade must be deterministic for identical input");
  assert.equal(JSON.stringify(history), before, "proposeTrade must not mutate history");
  assertProposalContract(first);
  if (first !== null) {
    nonNullProposals += 1;
    contractOutcomes.push(`${name}: proposal ${String((first as { setup?: unknown }).setup ?? "unknown setup")}`);
  } else {
    contractOutcomes.push(`${name}: null`);
  }
}

assert.ok(
  strategy.STRATEGY_BOILERPLATE === true || nonNullProposals > 0,
  `proposeTrade must return a proposal for at least one contract history\n${contractOutcomes.join("\n")}`
);
if (strategy.STRATEGY_BOILERPLATE === true && nonNullProposals === 0) {
  console.log("strategy contract skipped for neutral boilerplate");
} else {
  console.log("strategy contract ok");
}

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
  assertFiniteNumber(typed.target, "target");
  assertPositiveInteger(typed.maxHoldDays, "maxHoldDays");
  assertNonEmptyString(typed.setup, "setup");
  assertNonEmptyString(typed.regime, "regime");
  assertNonEmptyString(typed.strategyVersion, "strategyVersion");

  const entryMin = entry.min as number;
  const entryMax = entry.max as number;
  const stopLoss = typed.stopLoss as number;
  const target = typed.target as number;
  const side = typed.side as "long" | "short";
  const validProposal = typed as Parameters<typeof proposalRewardRisk>[0];

  assert.ok(entryMin > 0, "entry.min must be positive");
  assert.ok(entryMax >= entryMin, "entry.max must be at least entry.min");
  const worstEntry = worstCaseEntry(validProposal);
  if (side === "long") {
    assert.ok(entryMin > stopLoss, "entry range must be above stopLoss for long trades");
    assert.ok(target > entryMax, "target must be above entry range for long trades");
    assertStopDistance(worstEntry - stopLoss, worstEntry);
  } else {
    assert.ok(stopLoss > entryMax, "stopLoss must be above entry range for short trades");
    assert.ok(entryMin > target, "entry range must be above target for short trades");
    assertStopDistance(stopLoss - worstEntry, worstEntry);
  }
  assert.ok(
    proposalRewardRisk(validProposal) >= MIN_REWARD_RISK,
    `worst-case reward/risk must be at least ${MIN_REWARD_RISK}`
  );
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
