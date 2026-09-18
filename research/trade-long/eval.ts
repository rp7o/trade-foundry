// Walk-forward evaluator for the trade-long domain.
//
// The candidate strategy is scored on out-of-sample walk-forward folds defined
// in autoresearch.config.json (evaluation block). Each fold is backtested
// through the shared portfolio engine across the three portfolio profiles and
// scored with the cross-profile score model. The emitted walkForwardScore is
// the median fold return score.
//
// The evaluator always scores the latest rolling window configured in
// autoresearch.config.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { SCORE_PROFILES } from "./score-model.js";
import {
  aggregateFolds,
  assessSampleAdequacyGate,
  foldRanges,
  loadAllCandles,
  loadEvaluationConfig,
  loadEvaluationFeatures,
  runWindows,
  writeMarketContext,
  INITIAL_CAPITAL,
  MAX_FOLD_DRAWDOWN_PCT,
  MAX_POSITIONS,
  MIN_AVG_TRADED_VALUE,
  MIN_POSITIVE_FOLD_RATE,
  type WindowTrade,
} from "./walkforward.js";

const ARTIFACT_PATH = ".autoresearch/trade-long/latest.json";

const config = loadEvaluationConfig();
const features = loadEvaluationFeatures(config);
const allCandles = loadAllCandles(config);
const marketSeries = writeMarketContext(config);
const latestDataDate = Object.values(allCandles)
  .flatMap((candles) => candles.map((candle) => candle.date))
  .sort()
  .at(-1);
if (!latestDataDate) throw new Error("evaluation data contains no candles");
const folds = foldRanges(config, latestDataDate);

const foldResults = await runWindows(allCandles, folds, config.executionCosts, { timesfm: features?.forecasts });
const aggregate = aggregateFolds(foldResults);
interface FoldTrade extends WindowTrade {
  fold: string;
}

const allModerateTrades: FoldTrade[] = foldResults.flatMap((result) =>
  result.profileResults.moderate.trades.map((trade) => ({
    fold: result.range.name,
    ...trade,
  }))
);

const totalModerateTrades = allModerateTrades.length;
const totalModerateProfit = allModerateTrades.reduce((sum, trade) => sum + trade.profit, 0);
const moderateWins = allModerateTrades.filter((trade) => trade.profit > 0).length;

// ─── Final score ──────────────────────────────────────────────────────────────
// The score is the overall return score only. Gates below are independent and
// do not alter the score.

const finalScore = aggregate.score;

// ─── Promotion gates (do NOT affect the score) ─────────────────────────────────
// Enforced at champion promotion by the workflow hook, never at lineage
// acceptance — acceptance follows the score gradient. A candidate is
// promotable only when at least 40% of folds have positive overall returns and
// no fold exceeds the 30% drawdown ceiling.

const positiveReturnFoldsPass = aggregate.positiveFolds >= aggregate.minimumPositiveFolds;
const maximumDrawdownPass = aggregate.maxFoldDrawdownPct <= MAX_FOLD_DRAWDOWN_PCT;
const sampleAdequacy = assessSampleAdequacyGate(
  foldResults.map((result) => result.profileScores.moderate.totalTrades)
);
const promotionGates = {
  positiveReturnFolds: positiveReturnFoldsPass,
  maximumDrawdown: maximumDrawdownPass,
  sampleAdequacy: sampleAdequacy.passed,
};
const promotable = Object.values(promotionGates).every(Boolean);

// ─── Console output ───────────────────────────────────────────────────────────

console.log("--- Walk-Forward Folds ---");
console.log(
  `${"Fold".padEnd(8)} ${"Start".padEnd(11)} ${"End".padEnd(11)} ` +
  `${"Score".padStart(10)} ${"Return".padStart(8)} ${"DD".padStart(7)} ${"Trades".padStart(6)} Gates`
);
foldResults.forEach((result) => {
  const moderate = result.profileScores.moderate;
  const gates = moderate.maxDrawdownPct > MAX_FOLD_DRAWDOWN_PCT
    ? "maximum-drawdown"
    : "passed";
  console.log(
    `${result.range.name.padEnd(8)} ${result.range.start.padEnd(11)} ${result.range.end.padEnd(11)} ` +
    `${result.combined.score.toFixed(2).padStart(10)} ` +
    `${((moderate.earnedProfit / INITIAL_CAPITAL) * 100).toFixed(2).padStart(7)}% ` +
    `${moderate.maxDrawdownPct.toFixed(2).padStart(6)}% ` +
    `${String(moderate.totalTrades).padStart(6)} ${gates}`
  );
});

console.log("---");
console.log(`symbols:          ${config.symbols.length}`);
console.log(`maxPositions:     ${MAX_POSITIONS}`);
console.log(`brokerageSide:    ${config.executionCosts.brokeragePerSide.toFixed(2)}`);
console.log(`slippageBpsSide:  ${config.executionCosts.slippageBpsPerSide.toFixed(2)}`);
console.log(`minAvgTradedVal:  ${MIN_AVG_TRADED_VALUE}`);
console.log(`marketSeries:     ${marketSeries.join(",") || "none"}`);
console.log(`rollingWindow:    ${folds[0].start} → ${folds.at(-1)?.end} (${config.rollingYears} years)`);
console.log(`folds:            ${folds.length} x ${config.foldMonths} months`);
console.log(`positiveReturnFolds: ${aggregate.positiveFolds}/${folds.length} (${(aggregate.positiveFoldRate * 100).toFixed(1)}%; min ${(MIN_POSITIVE_FOLD_RATE * 100).toFixed(0)}% to promote)`);
console.log(`maxFoldDrawdown:     ${aggregate.maxFoldDrawdownPct.toFixed(2)}% (max ${MAX_FOLD_DRAWDOWN_PCT}% to promote)`);
console.log(`sampleAdequacy:      ${sampleAdequacy.totalTrades} trades, ${sampleAdequacy.emptyFolds} empty fold(s) (min ${sampleAdequacy.minTotalTrades} trades, no empty folds to promote)`);
console.log(`medianFoldScore:     ${aggregate.medianFoldScore.toFixed(2)}`);
console.log(`promotionGates:   ${promotable ? "all passed" : `blocked (${Object.entries(promotionGates).filter(([, ok]) => !ok).map(([name]) => name).join(",") || "inactive"})`}`);
console.log(`score: ${finalScore.toFixed(2)}`);

// ─── Artifact output ──────────────────────────────────────────────────────────
// `checks` is intentionally empty: the generic harness rejects acceptance on any
// failed check, but these gates are enforced at promotion only (see summary.
// promotionGates, read by the workflow hook). Lineage acceptance follows the
// score gradient alone.

const artifact = {
  primary: {
    name: "walkForwardScore",
    value: Number(finalScore.toFixed(2)),
    direction: "maximize",
  },
  checks: [] as Array<{ name: string; passed: boolean; value?: number; threshold?: number }>,
  secondary: [
    { name: "medianFoldScore", value: Number(aggregate.medianFoldScore.toFixed(2)), direction: "maximize" },
    { name: "positiveReturnFolds", value: aggregate.positiveFolds, direction: "maximize" },
    { name: "positiveReturnFoldRatePct", value: Number((aggregate.positiveFoldRate * 100).toFixed(2)), direction: "maximize" },
    { name: "maxFoldDrawdownPct", value: Number(aggregate.maxFoldDrawdownPct.toFixed(2)), direction: "minimize" },
    { name: "losingFolds", value: aggregate.losingFolds, direction: "minimize" },
    { name: "worstFoldScore", value: Number(Math.min(...aggregate.foldScores).toFixed(2)), direction: "maximize" },
    { name: "bestFoldScore", value: Number(Math.max(...aggregate.foldScores).toFixed(2)), direction: "maximize" },
    { name: "totalModerateTrades", value: totalModerateTrades, direction: "maximize" },
    {
      name: "moderateWinRate",
      value: Number((totalModerateTrades > 0 ? (moderateWins / totalModerateTrades) * 100 : 0).toFixed(2)),
      direction: "maximize",
    },
    { name: "totalModerateProfit", value: Number(totalModerateProfit.toFixed(2)), direction: "maximize" },
  ],
  segments: foldResults.map((result) => ({
    name: result.range.name,
    group: "fold",
    value: Number(result.combined.score.toFixed(2)),
    passed: result.profileScores.moderate.earnedProfit > 0,
  })),
  diagnostics: {
    evaluation: {
      mode: "walk-forward",
      dbPath: config.dbPath,
      rollingStart: folds[0].start,
      rollingEnd: folds.at(-1)?.end,
      latestDataDate,
      foldMonths: config.foldMonths,
      foldCount: config.foldCount,
      marketSeries,
      timesfm: features?.metadata ?? null,
      minAvgTradedValue: MIN_AVG_TRADED_VALUE,
      rollingYears: config.rollingYears,
    },
    returns: {
      positiveFolds: aggregate.positiveFolds,
      totalFolds: aggregate.foldReturns.length,
      positiveFoldRatePct: Number((aggregate.positiveFoldRate * 100).toFixed(2)),
      maxFoldDrawdownPct: Number(aggregate.maxFoldDrawdownPct.toFixed(2)),
    },
    folds: foldResults.map((result) => ({
      name: result.range.name,
      start: result.range.start,
      end: result.range.end,
      score: Number(result.combined.score.toFixed(2)),
      scoreGateFailures: result.combined.scoreGateFailures,
      profiles: Object.fromEntries(SCORE_PROFILES.map((profile) => {
        const score = result.profileScores[profile];
        const raw = result.profileResults[profile].raw;
        return [profile, {
          score: Number(score.score.toFixed(2)),
          earnedProfit: Number(score.earnedProfit.toFixed(2)),
          returnPct: Number(((score.earnedProfit / INITIAL_CAPITAL) * 100).toFixed(2)),
          totalTrades: score.totalTrades,
          winRate: Number(score.winRate.toFixed(2)),
          maxDrawdownPct: Number(score.maxDrawdownPct.toFixed(2)),
          riskPerTrade: raw.riskPerTrade,
          ruinProbability: raw.ruinProbability,
          confidenceDrawdown: raw.confidenceDrawdown,
          scoreGateFailures: score.scoreGateFailures,
        }];
      })),
    })),
  },
  generatedAt: new Date().toISOString(),
  mode: "walk-forward",
  symbols: config.symbols,
  maxPositions: MAX_POSITIONS,
  executionCosts: config.executionCosts,
  summary: {
    walkForwardScore: Number(finalScore.toFixed(2)),
    promotable,
    promotionGates,
    medianFoldScore: Number(aggregate.medianFoldScore.toFixed(2)),
    positiveReturnFolds: aggregate.positiveFolds,
    positiveReturnFoldRatePct: Number((aggregate.positiveFoldRate * 100).toFixed(2)),
    minimumPositiveReturnFolds: aggregate.minimumPositiveFolds,
    maxFoldDrawdownPct: Number(aggregate.maxFoldDrawdownPct.toFixed(2)),
    maxFoldDrawdownPctForPromotion: MAX_FOLD_DRAWDOWN_PCT,
    totalTrades: sampleAdequacy.totalTrades,
    minTotalTradesForPromotion: sampleAdequacy.minTotalTrades,
    emptyFolds: sampleAdequacy.emptyFolds,
    losingFolds: aggregate.losingFolds,
    foldScores: aggregate.foldScores.map((score) => Number(score.toFixed(2))),
    gateFailures: aggregate.gateFailures,
    totalModerateTrades,
    totalModerateProfit: Number(totalModerateProfit.toFixed(2)),
  },
  trades: allModerateTrades.map((trade) => ({
    ...trade,
    profit: Number(trade.profit.toFixed(2)),
  })),
};

mkdirSync(".autoresearch/trade-long", { recursive: true });
writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
