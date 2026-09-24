// Walk-forward evaluator for the trade-long domain.
//
// The candidate strategy is scored on out-of-sample walk-forward folds defined
// in autoresearch.config.json (evaluation block). Each fold is backtested
// through the shared portfolio engine across the three portfolio profiles and
// scored with the cross-profile score model. The emitted walkForwardScore is
// full-period portfolio profit after costs; configured folds test robustness.
//
// The evaluator keeps an anchored start and extends through the latest data.

import { mkdirSync, writeFileSync } from "node:fs";
import { researchProvenance } from "../../scripts/research-provenance.js";
import { SCORE_PROFILES } from "./score-model.js";
import {
  aggregateFolds,
  assessPositiveFoldReturnGate,
  assessSampleAdequacyGate,
  foldRanges,
  loadAllCandles,
  loadEvaluationConfig,
  loadEvaluationFeatures,
  runWindows,
  runWindow,
  writeMarketContext,
  resolvePortfolioSettings,
  MAX_FOLD_DRAWDOWN_PCT,
  MIN_POSITIVE_FOLD_RATE,
  type WindowTrade,
} from "./walkforward.js";

const ARTIFACT_PATH = ".autoresearch/trade-long/latest.json";
const provenance = researchProvenance();

const config = loadEvaluationConfig();
const minimumPositiveRate = config.minPositiveFoldRate ?? MIN_POSITIVE_FOLD_RATE;
const portfolio = resolvePortfolioSettings(config.portfolio);
const { initialCapital: INITIAL_CAPITAL, maxPositions: MAX_POSITIONS, minAvgTradedValue: MIN_AVG_TRADED_VALUE } = portfolio;
const features = loadEvaluationFeatures(config);
const allCandles = loadAllCandles(config);
const marketSeries = writeMarketContext(config);
const latestDataDate = Object.values(allCandles)
  .flatMap((candles) => candles.map((candle) => candle.date))
  .sort()
  .at(-1);
if (!latestDataDate) throw new Error("evaluation data contains no candles");
const folds = foldRanges(config, latestDataDate);

const foldResults = await runWindows(allCandles, folds, config.executionCosts, { timesfm: features?.forecasts, portfolio });
const aggregate = aggregateFolds(foldResults, minimumPositiveRate);
// Rank on one cost-aware portfolio path. Fold runs are independent stress
// diagnostics; their reset capital must not define total growth.
const fullPeriod = await runWindow(allCandles,
  { name: "full-period", start: folds[0].start, end: folds.at(-1)!.end },
  config.executionCosts, { timesfm: features?.forecasts, portfolio });
interface FoldTrade extends WindowTrade {
  fold: string;
}

const allModerateTrades: FoldTrade[] = fullPeriod.profileResults.moderate.trades.map((trade) => {
  const fold = folds.find((range) => trade.exitDate >= range.start && trade.exitDate <= range.end);
  if (!fold) throw new Error(`Trade exits outside evaluation periods: ${trade.exitDate}`);
  return { ...trade, fold: fold.name };
});
let previousPeriodCapital = INITIAL_CAPITAL;
const fullPeriodProfits = folds.map((range) => {
  const lastPoint = fullPeriod.profileResults.moderate.capitalSeries
    .filter((point) => point.date <= range.end).at(-1);
  if (!lastPoint) throw new Error(`No portfolio equity in ${range.name}`);
  const profit = lastPoint.capital - previousPeriodCapital;
  previousPeriodCapital = lastPoint.capital;
  return { name: range.name, profit: Number(profit.toFixed(2)) };
});
const positivePeriodGate = assessPositiveFoldReturnGate(
  fullPeriodProfits.map((period) => period.profit), minimumPositiveRate
);

const totalModerateTrades = allModerateTrades.length;
const totalModerateProfit = allModerateTrades.reduce((sum, trade) => sum + trade.profit, 0);
const moderateWins = allModerateTrades.filter((trade) => trade.profit > 0).length;

// ─── Final score ──────────────────────────────────────────────────────────────
// The score is full-period portfolio profit. Gates below are independent and
// do not alter the score.

const finalScore = fullPeriod.combined.score;

// ─── Promotion gates (do NOT affect the score) ─────────────────────────────────
// Enforced at champion promotion by the workflow hook, never at lineage
// acceptance — acceptance follows the score gradient. A candidate is
// promotable only when the configured share of periods is profitable and
// drawdown stays within the 30% ceiling across each fold and the full period.

const positiveReturnFoldsPass = positivePeriodGate.passed;
const maximumDrawdownPass = aggregate.maxFoldDrawdownPct <= MAX_FOLD_DRAWDOWN_PCT;
const fullPeriodReturnPass = fullPeriod.profileScores.moderate.earnedProfit > 0;
const fullPeriodDrawdownPass = fullPeriod.profileScores.moderate.maxDrawdownPct <= MAX_FOLD_DRAWDOWN_PCT;
const sampleAdequacy = assessSampleAdequacyGate(
  folds.map((range) => allModerateTrades.filter((trade) => trade.fold === range.name).length)
);
const promotionGates = {
  positiveReturnFolds: positiveReturnFoldsPass,
  maximumDrawdown: maximumDrawdownPass,
  fullPeriodReturn: fullPeriodReturnPass,
  fullPeriodDrawdown: fullPeriodDrawdownPass,
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
console.log(`evaluationPeriod: ${folds[0].start} → ${folds.at(-1)?.end}`);
console.log(`folds:            ${folds.length} x ${config.foldMonths} months`);
console.log(`positiveReturnPeriods: ${positivePeriodGate.positiveFolds}/${folds.length} (${(positivePeriodGate.positiveFoldRate * 100).toFixed(1)}%; min ${positivePeriodGate.minimumPositiveFolds}/${folds.length}, ${minimumPositiveRate * 100}% to promote)`);
console.log(`maxFoldDrawdown:     ${aggregate.maxFoldDrawdownPct.toFixed(2)}% (max ${MAX_FOLD_DRAWDOWN_PCT}% to promote)`);
console.log(`sampleAdequacy:      ${sampleAdequacy.totalTrades} trades, ${sampleAdequacy.emptyFolds} inactive period(s) (min ${sampleAdequacy.minTotalTrades} trades, active in at least half the periods)`);
console.log(`medianFoldScore:     ${aggregate.medianFoldScore.toFixed(2)}`);
console.log(`promotionGates:   ${promotable ? "all passed" : `blocked (${Object.entries(promotionGates).filter(([, ok]) => !ok).map(([name]) => name).join(",") || "inactive"})`}`);
console.log(`score: ${finalScore.toFixed(2)}`);

// ─── Artifact output ──────────────────────────────────────────────────────────
// `checks` is intentionally empty: the generic harness rejects acceptance on any
// failed check, but these gates are enforced at promotion only (see summary.
// promotionGates, read by the workflow hook). Lineage acceptance follows the
// score gradient alone.

const artifact = {
  provenance,
  primary: {
    name: "walkForwardScore",
    value: Number(finalScore.toFixed(2)),
    direction: "maximize",
  },
  checks: [] as Array<{ name: string; passed: boolean; value?: number; threshold?: number }>,
  secondary: [
    { name: "fullPeriodNetProfit", value: Number(finalScore.toFixed(2)), direction: "maximize" },
    { name: "medianFoldScore", value: Number(aggregate.medianFoldScore.toFixed(2)), direction: "maximize" },
    { name: "positiveReturnFolds", value: positivePeriodGate.positiveFolds, direction: "maximize" },
    { name: "positiveReturnFoldRatePct", value: Number((positivePeriodGate.positiveFoldRate * 100).toFixed(2)), direction: "maximize" },
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
    value: fullPeriodProfits.find((period) => period.name === result.range.name)?.profit ?? 0,
    passed: (fullPeriodProfits.find((period) => period.name === result.range.name)?.profit ?? 0) > 0,
  })),
  diagnostics: {
    evaluation: {
      mode: "walk-forward",
      scoringModel: "continuous-portfolio-v1",
      portfolio,
      dbPath: config.dbPath,
      rollingStart: folds[0].start,
      rollingEnd: folds.at(-1)?.end,
      latestDataDate,
      foldMonths: config.foldMonths,
      foldCount: config.foldCount,
      minPositiveFoldRate: minimumPositiveRate,
      marketSeries,
      timesfm: features?.metadata ?? null,
      minAvgTradedValue: MIN_AVG_TRADED_VALUE,
      rollingYears: config.rollingYears,
    },
    returns: {
      fullPeriodNetProfit: Number(finalScore.toFixed(2)),
      fullPeriodMaxDrawdownPct: Number(fullPeriod.profileScores.moderate.maxDrawdownPct.toFixed(2)),
      positiveFolds: positivePeriodGate.positiveFolds,
      totalFolds: fullPeriodProfits.length,
      positiveFoldRatePct: Number((positivePeriodGate.positiveFoldRate * 100).toFixed(2)),
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
    periodProfits: fullPeriodProfits,
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
    positiveReturnFolds: positivePeriodGate.positiveFolds,
    positiveReturnFoldRatePct: Number((positivePeriodGate.positiveFoldRate * 100).toFixed(2)),
    minimumPositiveReturnFolds: positivePeriodGate.minimumPositiveFolds,
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
