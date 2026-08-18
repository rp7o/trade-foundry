import assert from "node:assert/strict";
import test from "node:test";
import { runSignalScreen } from "../research/trade-long/signal-screen.js";
import type { Candle, TradeProposal } from "../research/trade-long/strategy.js";

const LOOKBACK = 20;

// Synthetic series: flat except a +2% close-to-close jump on day i whenever
// (i - 2) % 10 === 0. The day two bars before each jump (i % 10 === 0) is
// flagged with a volume spike, so an informed signal can anticipate it:
// signal at i, entry at open of i+1, exit at close of i+2 (horizon 1).
function syntheticCandles(days: number): Candle[] {
  const candles: Candle[] = [];
  let close = 100;
  const start = new Date("2020-01-01T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const open = close;
    close = (i >= 2 && (i - 2) % 10 === 0) ? open * 1.02 : open;
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    candles.push({
      date,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: i % 10 === 0 ? 999_999 : 1_000,
    });
  }
  return candles;
}

function longProposal(price: number): TradeProposal {
  return {
    side: "long",
    entry: { min: price * 0.99, max: price * 1.01 },
    stopLoss: price * 0.95,
    target: price * 1.10,
    maxHoldDays: 1,
    setup: "test",
    regime: "test",
    strategyVersion: "test",
  };
}

const CANDLES = { "TEST.AX": syntheticCandles(300) };
const OPTIONS = { trainingEnd: "2099-01-01", lookback: LOOKBACK, minSignals: 10 };

test("passes entries that anticipate forward moves", () => {
  const informed = (history: Candle[]) => {
    const last = history[history.length - 1];
    return last.volume > 100_000 ? longProposal(last.close) : null;
  };
  const result = runSignalScreen(CANDLES, {}, informed, OPTIONS);
  assert.equal(result.applies, true);
  assert.ok(result.alpha > 0.005, `expected strong alpha, got ${result.alpha}`);
  assert.equal(result.passed, true);
});

test("fails entries that systematically miss forward moves", () => {
  // Fires only on days never adjacent to a jump: actual return 0 while the
  // unconditional baseline is positive.
  const uninformed = (history: Candle[]) => {
    const index = history.length - 1;
    // Recover position in the full series from the flat/jump/flag pattern:
    // volume flags at i % 10 === 0 let the stub count from the last flag.
    const lastFlag = [...history].reverse().findIndex((candle) => candle.volume > 100_000);
    if (lastFlag === -1) return null;
    const sinceFlag = lastFlag; // 0 means the flag day itself
    return sinceFlag === 4 && index >= 0 ? longProposal(history[index].close) : null;
  };
  const result = runSignalScreen(CANDLES, {}, uninformed, OPTIONS);
  assert.equal(result.applies, true);
  assert.ok(result.alpha < 0, `expected negative alpha, got ${result.alpha}`);
  assert.equal(result.passed, false);
});

test("waives the gate when there are too few signals", () => {
  const silent = () => null;
  const result = runSignalScreen(CANDLES, {}, silent, OPTIONS);
  assert.equal(result.signals, 0);
  assert.equal(result.applies, false);
  assert.equal(result.passed, true);
});

test("is deterministic across repeated runs", () => {
  const informed = (history: Candle[]) => {
    const last = history[history.length - 1];
    return last.volume > 100_000 ? longProposal(last.close) : null;
  };
  const first = runSignalScreen(CANDLES, {}, informed, OPTIONS);
  const second = runSignalScreen(CANDLES, {}, informed, OPTIONS);
  assert.deepEqual(second, first);
});
