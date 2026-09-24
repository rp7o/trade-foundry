import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runWindow, resolvePortfolioSettings } from "../research/trade-long/walkforward.js";

test("configured capital, liquidity and position limits reach portfolio workers and scoring", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "portfolio-settings-"));
  const previous = process.cwd();
  symlinkSync(path.join(previous, "node_modules"), path.join(root, "node_modules"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  t.after(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(path.join(root, "research/trade-long"), { recursive: true });
  writeFileSync(path.join(root, "research/trade-long/strategy.ts"), `
    export const STRATEGY_BOILERPLATE = false;
    export function proposeTrade(history) {
      const close = history.at(-1).close;
      return { side: 'long', entry: { min: close - 1, max: close + 1 },
        stopLoss: close - 4, target: close + 9, maxHoldDays: 4,
        setup: 'fixture', regime: 'fixture', strategyVersion: 'fixture' };
    }
  `);
  process.chdir(root);
  const candles = Array.from({ length: 250 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i * 0.4, high: 101 + i * 0.4, low: 99 + i * 0.4, close: 100 + i * 0.4, volume: 1e6,
  }));
  const symbols = { AAA: candles, BBB: candles, CCC: candles };
  const range = { name: "test", start: candles[90].date, end: candles.at(-1)!.date };
  const costs = { brokeragePerSide: 0, slippageBpsPerSide: 0 };
  const portfolio = resolvePortfolioSettings({ initialCapital: 25000, maxPositions: 1, minAvgTradedValue: 0 });
  const one = await runWindow(symbols, range, costs, { portfolio });
  const two = await runWindow(symbols, range, costs, { portfolio: { ...portfolio, maxPositions: 2 } });
  const blocked = await runWindow(symbols, range, costs, { portfolio: { ...portfolio, minAvgTradedValue: 1e15 } });
  assert.ok(one.profileResults.moderate.trades.length > 0);
  assert.ok(two.profileResults.moderate.trades.length > one.profileResults.moderate.trades.length);
  assert.equal(blocked.profileResults.moderate.trades.length, 0);
  assert.equal(blocked.profileResults.moderate.capitalSeries.at(-1)!.capital, 25000);
  assert.equal(blocked.profileScores.moderate.earnedProfit, 0);
  assert.equal(blocked.combined.score, 0);
});
