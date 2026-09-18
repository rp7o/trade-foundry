// Signal-level pre-screen: does the raw entry signal carry timing information
// on TRAINING data only?
//
// For every training day, the strategy's proposeTrade is called on the trailing
// lookback window (with lagged market context, mirroring the evaluator's
// windowed wrapper). Each long proposal is treated as a raw entry signal:
// enter at the next day's open, exit at the close maxHoldDays later. The
// signal's forward return is compared against the unconditional mean forward
// return for the same symbol and horizon over the training window — the exact
// expectation of a random entry, with no sampling noise.
//
// Pure candle math, no portfolio engine: it answers only "do these entries
// know something a dart board does not?" — the cheapest possible falsification
// of an idea, run before fold budget is spent on it. Training-only, so it
// leaks nothing about fold or holdout windows and is safe for iteration
// agents to run themselves (`pnpm run strategy:signal-screen`).

import type { Candle, TradeProposal } from "./strategy.js";
import { timesfmAsOf, type TimesfmForecast, type TimesfmForecasts } from "../engine/timesfm-context.mjs";

export type ProposeFn = (history: Candle[], market?: { index?: Candle[]; volatility?: Candle[]; timesfm?: TimesfmForecast }) => TradeProposal | null;

export interface SignalScreenResult {
  signals: number;
  // Mean per-signal forward return minus the matched unconditional baseline.
  alpha: number;
  actualMean: number;
  baselineMean: number;
  // The gate only applies with a meaningful signal sample.
  applies: boolean;
  passed: boolean;
}

export const SCREEN_MIN_SIGNALS = 30;
const MAX_HORIZON_DAYS = 30;

// Mirrors the evaluator's windowed wrapper. Local index/volatility bars are
// known at the local close, so nothing is lagged. (A foreign lead market would
// need lagging, but none are provided — the strategy must stay portable.)
const LAGGED: Record<string, boolean> = {};

function marketAsOf(
  marketCandles: Record<string, Candle[]>,
  lastDate: string,
  lookback: number,
): Record<string, Candle[]> {
  const market: Record<string, Candle[]> = {};
  for (const [name, series] of Object.entries(marketCandles)) {
    const usable = LAGGED[name]
      ? (date: string) => date < lastDate
      : (date: string) => date <= lastDate;
    let lo = 0;
    let hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (usable(series[mid].date)) lo = mid + 1; else hi = mid;
    }
    market[name] = series.slice(Math.max(0, lo - lookback), lo);
  }
  return market;
}

export function runSignalScreen(
  allCandles: Record<string, Candle[]>,
  marketCandles: Record<string, Candle[]>,
  propose: ProposeFn,
  options: { trainingStart?: string; trainingEnd: string; lookback: number; minSignals?: number; timesfm?: TimesfmForecasts },
): SignalScreenResult {
  const { trainingEnd, lookback } = options;
  const minSignals = options.minSignals ?? SCREEN_MIN_SIGNALS;

  const trainingMarket: Record<string, Candle[]> = {};
  for (const [name, series] of Object.entries(marketCandles)) {
    trainingMarket[name] = series.filter((candle) => candle.date <= trainingEnd);
  }

  const actualReturns: number[] = [];
  const baselineReturns: number[] = [];

  for (const symbol of Object.keys(allCandles).sort()) {
    const candles = allCandles[symbol].filter((candle) => candle.date <= trainingEnd);
    if (candles.length <= lookback + 1) continue;

    // Unconditional mean forward return per horizon, computed lazily over the
    // same signal-eligible region the strategy sees.
    const baselineCache = new Map<number, number>();
    const baselineFor = (horizon: number): number => {
      const cached = baselineCache.get(horizon);
      if (cached !== undefined) return cached;
      let sum = 0;
      let count = 0;
      for (let entry = lookback; entry + horizon < candles.length; entry++) {
        if (options.trainingStart && candles[entry - 1].date < options.trainingStart) continue;
        sum += candles[entry + horizon].close / candles[entry].open - 1;
        count++;
      }
      const mean = count > 0 ? sum / count : 0;
      baselineCache.set(horizon, mean);
      return mean;
    };

    for (let i = lookback - 1; i < candles.length - 1; i++) {
      if (options.trainingStart && candles[i].date < options.trainingStart) continue;
      const window = candles.slice(i - lookback + 1, i + 1);
      const market = {
        ...marketAsOf(trainingMarket, candles[i].date, lookback),
        timesfm: timesfmAsOf(options.timesfm, symbol, candles[i].date),
      };
      let proposal: TradeProposal | null;
      try {
        proposal = propose(window, market);
      } catch {
        continue;
      }
      if (!proposal || proposal.side !== "long") continue;

      const horizon = Math.min(
        Math.max(1, Math.floor(proposal.maxHoldDays)),
        MAX_HORIZON_DAYS,
      );
      const entryIdx = i + 1;
      // Skip signals whose full horizon runs past the training window so the
      // actual return and its baseline are measured over identical horizons.
      if (entryIdx + horizon >= candles.length) continue;

      actualReturns.push(candles[entryIdx + horizon].close / candles[entryIdx].open - 1);
      baselineReturns.push(baselineFor(horizon));
    }
  }

  const mean = (values: number[]): number =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const actualMean = mean(actualReturns);
  const baselineMean = mean(baselineReturns);
  const alpha = actualMean - baselineMean;
  const applies = actualReturns.length >= minSignals;

  return {
    signals: actualReturns.length,
    alpha,
    actualMean,
    baselineMean,
    applies,
    passed: !applies || alpha > 0,
  };
}
