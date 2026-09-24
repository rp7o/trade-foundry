import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProfileScore,
  combineProfileScores,
  type ProfileScore,
  type ScoreProfile,
} from "../research/trade-long/score-model.js";

function profileScore(profile: ScoreProfile, score: number, failures: string[] = []): ProfileScore {
  return {
    profile,
    score,
    earnedProfit: score,
    finalCapital: 10_000 + score,
    totalTrades: 20,
    winRate: 50,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    timeFactor: 1,
    timeContributionFactor: 1,
    recencyFactor: 1,
    concentrationFactor: 1,
    symbolFactor: 1,
    tradeFactor: 1,
    riskFactor: 1,
    drawdownPenalty: 0,
    topTradeContributionPct: 0,
    profitableQuarterRate: 1,
    scoreGateFailures: failures,
    timeWindows: [],
  };
}

test("cross-profile score uses conservative/moderate/aggressive 2/3/1 weights", () => {
  const combined = combineProfileScores({
    conservative: profileScore("conservative", 10),
    moderate: profileScore("moderate", 20),
    aggressive: profileScore("aggressive", 60),
  });

  assert.equal(combined.weightedScore, (2 * 10 + 3 * 20 + 1 * 60) / 6);
  assert.equal(combined.score, combined.weightedScore);
});

test("combined score is the weighted average of return-only profile scores", () => {
  const combined = combineProfileScores({
    conservative: profileScore("conservative", 100),
    moderate: profileScore("moderate", 100),
    aggressive: profileScore("aggressive", -100),
  });

  assert.equal(combined.score, (2 * 100 + 3 * 100 - 1 * 100) / 6);
  assert.equal(combined.score, combined.weightedScore);
});

test("profile score is exactly overall return regardless of other diagnostics", () => {
  const score = calculateProfileScore({
    profile: "moderate",
    initialCapital: 10_000,
    trades: [{ symbol: "BHP.AX", profit: 1_000, exitDate: "2026-01-02" }],
    capitalSeries: [
      { date: "2026-01-01", capital: 15_000 },
      { date: "2026-01-02", capital: 11_000 },
    ],
    allDates: ["2026-01-01", "2026-01-02"],
    ruinProbability: 1,
    confidenceDrawdown: 1,
  });

  assert.equal(score.earnedProfit, 1_000);
  assert.equal(score.score, 1_000);
  assert.equal(score.drawdownPenalty, 0);
  assert.deepEqual(score.scoreGateFailures, []);
});

test("a losing window scores its honest negative return", () => {
  const score = calculateProfileScore({
    profile: "moderate",
    initialCapital: 10_000,
    trades: [
      { symbol: "BHP.AX", profit: -50, exitDate: "2026-01-10" },
      { symbol: "CBA.AX", profit: -30, exitDate: "2026-04-10" },
    ],
    capitalSeries: [
      { date: "2026-01-10", capital: 9_950 },
      { date: "2026-04-10", capital: 9_920 },
    ],
    allDates: ["2026-01-10", "2026-04-10"],
  });

  assert.equal(score.score, -80);
  assert.deepEqual(score.scoreGateFailures, []);
});

test("drawdown gate uses the largest percentage drawdown on the path", () => {
  const score = calculateProfileScore({
    profile: "moderate", initialCapital: 10_000, trades: [],
    capitalSeries: [
      { date: "2020-01-01", capital: 10_000 },
      { date: "2020-01-02", capital: 8_000 },
      { date: "2020-01-03", capital: 20_000 },
      { date: "2020-01-04", capital: 17_000 },
    ],
    allDates: ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"],
  });
  assert.equal(score.maxDrawdown, 3_000);
  assert.equal(score.maxDrawdownPct, 20);
});
