import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  aggregateFolds,
  assessMaximumDrawdownGate,
  assessPositiveFoldReturnGate,
  assessSampleAdequacyGate,
  foldRanges,
  parseEvaluationConfig,
  MIN_TOTAL_TRADES,
  MAX_FOLD_DRAWDOWN_PCT,
  MIN_POSITIVE_FOLD_RATE,
  type EvaluationConfig,
  type WindowResult,
} from "../research/trade-long/walkforward.js";

test("positive-return gate requires at least 60% of periods to be positive", () => {
  const result = assessPositiveFoldReturnGate([100, 50, -10, 0, -20]);

  assert.equal(MIN_POSITIVE_FOLD_RATE, 0.6);
  assert.equal(result.positiveFolds, 2);
  assert.equal(result.minimumPositiveFolds, 3);
  assert.equal(result.positiveFoldRate, 0.4);
  assert.equal(result.passed, false);
});

test("zero-return folds do not count as positive folds", () => {
  const result = assessPositiveFoldReturnGate([100, 0, -10, 0]);

  assert.equal(result.positiveFolds, 1);
  assert.equal(result.passed, false);
});

test("configured positive-return rate requires nine of sixteen periods", () => {
  const raw = JSON.parse(readFileSync(new URL("../autoresearch.example.json", import.meta.url), "utf8"));
  assert.equal(parseEvaluationConfig(raw).minPositiveFoldRate, 0.6);
  raw.evaluation.minPositiveFoldRate = 9 / 16;
  const rate = parseEvaluationConfig(raw).minPositiveFoldRate;
  const nine = [...Array(9).fill(1), ...Array(7).fill(-1)];
  assert.equal(assessPositiveFoldReturnGate(nine, rate).minimumPositiveFolds, 9);
  assert.equal(assessPositiveFoldReturnGate(nine, rate).passed, true);
  assert.equal(assessPositiveFoldReturnGate(nine).passed, false);
  assert.equal(assessPositiveFoldReturnGate([...Array(8).fill(1), ...Array(8).fill(0)], rate).passed, false);
  assert.equal(aggregateFolds(nine.map(earnedProfit => ({
    combined: { score: earnedProfit },
    profileScores: { moderate: { earnedProfit, maxDrawdownPct: 0 } },
  } as WindowResult)), rate).minimumPositiveFolds, 9);
  for (const invalid of [0, -1, 1.01, NaN, Infinity, null, "0.5625"]) {
    raw.evaluation.minPositiveFoldRate = invalid;
    assert.throws(() => parseEvaluationConfig(raw), /minPositiveFoldRate/);
  }
});

test("drawdown at 30% is accepted but anything above it fails", () => {
  assert.equal(MAX_FOLD_DRAWDOWN_PCT, 30);
  assert.equal(assessMaximumDrawdownGate([12, 30]).passed, true);
  assert.equal(assessMaximumDrawdownGate([12, 30.01]).passed, false);
});

test("positive-return gate rounds the 60% requirement up", () => {
  const result = assessPositiveFoldReturnGate([1, 1, -1, -1, -1, -1]);

  assert.equal(result.minimumPositiveFolds, 4);
  assert.equal(result.passed, false);
});

test("fold ranges stay anchored while the final period extends with new data", () => {
  const config: EvaluationConfig = {
    dbPath: "db/market.db",
    symbols: ["CBA.AX"],
    trainingEnd: "2017-12-31",
    foldStart: "2018-01-01",
    foldMonths: 6,
    foldCount: 16,
    rollingYears: 3,
    executionCosts: { brokeragePerSide: 3, slippageBpsPerSide: 5 },
  };

  const ranges = foldRanges(config, "2025-06-30");
  assert.equal(ranges.length, 15);
  assert.equal(ranges[0].start, "2018-01-01");
  assert.equal(ranges.at(-1)?.end, "2025-06-30");
  assert.equal(ranges[1].start, "2018-07-01");
  const sixDaysLater = foldRanges(config, "2025-07-06");
  assert.equal(sixDaysLater[0].start, ranges[0].start);
  assert.equal(sixDaysLater[1].start, ranges[1].start);
  assert.equal(sixDaysLater.at(-1)?.end, "2025-07-06");
  const fixed = { ...config, trainingStart: "2022-01-01", trainingEnd: "2022-12-31",
    foldStart: "2023-01-01", foldCount: 4, rollingYears: 2, evaluationEnd: "2024-12-31" };
  const fixedRanges = foldRanges(fixed, "2026-09-01");
  assert.equal(fixedRanges[0].start, "2023-01-01");
  assert.equal(fixedRanges.at(-1)?.end, "2024-12-31");
  assert.throws(() => foldRanges({ ...fixed, trainingEnd: "2023-01-01" }), /follow training/);
  assert.throws(() => foldRanges({ ...fixed, evaluationEnd: "2025-12-31" }), /end exactly/);
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
  assert.equal(atLimit.gateFailures.includes("minimum-positive-return-folds"), true);
  assert.equal(atLimit.gateFailures.includes("maximum-drawdown"), false);

  const aboveLimit = aggregateFolds([makeFold(100, 30.01)]);
  assert.equal(aboveLimit.gateFailures.includes("maximum-drawdown"), true);
});

test("sample adequacy allows inactive bearish periods but requires broad activity", () => {
  const perFold = Math.ceil(MIN_TOTAL_TRADES / 6);
  assert.equal(assessSampleAdequacyGate(Array(6).fill(perFold)).passed, true);
  // hypothesis-0004-cycle-0003 shape: 7 trades, one empty fold.
  const thin = assessSampleAdequacyGate([1, 1, 1, 2, 2, 0]);
  assert.equal(thin.passed, false);
  assert.equal(thin.totalTrades, 7);
  assert.equal(thin.emptyFolds, 1);
  // Enough trades overall, but one silent fold still blocks promotion.
  assert.equal(assessSampleAdequacyGate([20, 20, 20, 20, 20, 0]).passed, true);
  assert.equal(assessSampleAdequacyGate([20, 20, 0, 0, 0, 0]).passed, false);
  // One below the floor blocks promotion.
  assert.equal(assessSampleAdequacyGate([MIN_TOTAL_TRADES - 6, 1, 1, 1, 1, 1]).passed, false);
  assert.equal(assessSampleAdequacyGate([MIN_TOTAL_TRADES - 5, 1, 1, 1, 1, 1]).passed, true);
  assert.equal(assessSampleAdequacyGate([]).passed, false);
});
