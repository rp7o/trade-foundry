// CLI wrapper for the training-only signal screen. Safe for iteration agents:
// it touches training-window data only and reports aggregate entry alpha, so
// running it leaks nothing about fold or holdout windows.
//
// Usage: pnpm run strategy:signal-screen

import { runSignalScreen, SCREEN_MIN_SIGNALS } from "../signal-screen.js";
import { proposeTrade } from "../strategy.js";
import {
  loadAllCandles,
  loadEvaluationConfig,
  loadMarketCandles,
  LOOKBACK_DAYS,
} from "../walkforward.js";

const config = loadEvaluationConfig();
const result = runSignalScreen(
  loadAllCandles(config),
  loadMarketCandles(config),
  proposeTrade,
  { trainingEnd: config.trainingEnd, lookback: LOOKBACK_DAYS },
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
