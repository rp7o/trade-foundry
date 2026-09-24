// CLI wrapper for the training-only signal screen. Safe for iteration agents:
// it touches training-window data only and reports aggregate entry alpha, so
// running it leaks nothing about fold or holdout windows.
//
// Usage: pnpm run strategy:signal-screen

import { runSignalScreen, SCREEN_MIN_SIGNALS } from "../signal-screen.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadAllCandles,
  loadEvaluationConfig,
  loadEvaluationFeatures,
  trainingForecastRange,
  loadMarketCandles,
  LOOKBACK_DAYS,
} from "../walkforward.js";

const { proposeTrade } = await import(pathToFileURL(path.resolve("research/trade-long/strategy.ts")).href);
const config = loadEvaluationConfig();
const features = loadEvaluationFeatures(config, config.timesfm ? [trainingForecastRange(config)] : undefined);
const result = runSignalScreen(
  loadAllCandles(config),
  loadMarketCandles(config),
  proposeTrade,
  { trainingStart: config.trainingStart, trainingEnd: config.trainingEnd, lookback: LOOKBACK_DAYS, timesfm: features?.forecasts },
);

console.log("--- Signal Screen (training window only) ---");
console.log(`signals:        ${result.signals} (gate applies at >= ${SCREEN_MIN_SIGNALS})`);
console.log(`actualMean:     ${(result.actualMean * 100).toFixed(3)}% per signal`);
console.log(`baselineMean:   ${(result.baselineMean * 100).toFixed(3)}% per signal (unconditional same-horizon)`);
console.log(`signalAlpha:    ${(result.alpha * 100).toFixed(3)}% per signal`);
console.log(
  `signalScreen:   ${result.applies ? (result.passed ? "PASSED" : "FAILED") : "waived (too few signals)"}`
);

if (!result.passed) process.exitCode = 1;
