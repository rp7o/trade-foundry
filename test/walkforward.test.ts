import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateFolds,
  assessMaximumDrawdownGate,
  assessPositiveFoldReturnGate,
  assessSampleAdequacyGate,
  foldRanges,
  MIN_TOTAL_TRADES,
  MAX_FOLD_DRAWDOWN_PCT,
  MIN_POSITIVE_FOLD_RATE,
  type EvaluationConfig,
  type WindowResult,
} from "../research/trade-long/walkforward.js";

test("positive-return gate requires at least 40% of folds to be positive", () => {
  const result = assessPositiveFoldReturnGate([100, 50, -10, 0, -20]);

  assert.equal(MIN_POSITIVE_FOLD_RATE, 0.4);
  assert.equal(result.positiveFolds, 2);
  assert.equal(result.minimumPositiveFolds, 2);
  assert.equal(result.positiveFoldRate, 0.4);
  assert.equal(result.passed, true);
});

test("zero-return folds do not count as positive folds", () => {
  const result = assessPositiveFoldReturnGate([100, 0, -10, 0]);

  assert.equal(result.positiveFolds, 1);
  assert.equal(result.passed, false);
});

test("drawdown at 30% is accepted but anything above it fails", () => {
  assert.equal(MAX_FOLD_DRAWDOWN_PCT, 30);
  assert.equal(assessMaximumDrawdownGate([12, 30]).passed, true);
  assert.equal(assessMaximumDrawdownGate([12, 30.01]).passed, false);
});

test("positive-return gate rounds the 40% requirement up for partial fold counts", () => {
  const result = assessPositiveFoldReturnGate([1, 1, -1, -1, -1, -1]);

  assert.equal(result.minimumPositiveFolds, 3);
  assert.equal(result.passed, false);
});

test("fold ranges cover exactly the latest rolling three years", () => {
  const config: EvaluationConfig = {
    dbPath: "db/market.db",
    symbols: ["CBA.AX"],
    trainingEnd: "2017-12-31",
    foldStart: "2018-01-01",
    foldMonths: 6,
    foldCount: 6,
    rollingYears: 3,
    executionCosts: { brokeragePerSide: 3, slippageBpsPerSide: 5 },
  };

  const ranges = foldRanges(config, "2025-06-30");
  assert.equal(ranges.length, 6);
  assert.equal(ranges[0].start, "2022-06-30");
  assert.equal(ranges.at(-1)?.end, "2025-06-30");
  assert.equal(ranges[1].start, "2022-12-30");
});

test("fold aggregation wires return breadth and drawdown into promotion diagnostics", () => {
  const makeFold = (earnedProfit: number, maxDrawdownPct: number) => ({
    combined: { score: earnedProfit },
    profileScores: { moderate: { earnedProfit, maxDrawdownPct } },
  } as WindowResult);

  const atLimit = aggregateFolds([
    makeFold(100, 30),
    makeFold(50, 12),
    makeFold(-10, 5),
    makeFold(0, 2),
    makeFold(-20, 4),
  ]);
  assert.equal(atLimit.positiveFolds, 2);
  assert.equal(atLimit.positiveFoldRate, 0.4);
  assert.equal(atLimit.gateFailures.includes("minimum-positive-return-folds"), false);
  assert.equal(atLimit.gateFailures.includes("maximum-drawdown"), false);

  const aboveLimit = aggregateFolds([makeFold(100, 30.01)]);
  assert.equal(aboveLimit.gateFailures.includes("maximum-drawdown"), true);
});

test("sample adequacy gate requires the trade floor and no empty folds", () => {
  const perFold = Math.ceil(MIN_TOTAL_TRADES / 6);
  assert.equal(assessSampleAdequacyGate(Array(6).fill(perFold)).passed, true);
  // hypothesis-0004-cycle-0003 shape: 7 trades, one empty fold.
  const thin = assessSampleAdequacyGate([1, 1, 1, 2, 2, 0]);
  assert.equal(thin.passed, false);
  assert.equal(thin.totalTrades, 7);
  assert.equal(thin.emptyFolds, 1);
  // Enough trades overall, but one silent fold still blocks promotion.
  assert.equal(assessSampleAdequacyGate([20, 20, 20, 20, 20, 0]).passed, false);
  // One below the floor blocks promotion.
  assert.equal(assessSampleAdequacyGate([MIN_TOTAL_TRADES - 6, 1, 1, 1, 1, 1]).passed, false);
  assert.equal(assessSampleAdequacyGate([MIN_TOTAL_TRADES - 5, 1, 1, 1, 1, 1]).passed, true);
  assert.equal(assessSampleAdequacyGate([]).passed, false);
});
