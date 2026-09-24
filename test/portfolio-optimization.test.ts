import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPortfolioBacktestInWorker } from "../research/engine/index.mjs";

test("grouped profile risk sweep matches independent backtests", async t => {
  const dir = mkdtempSync(join(tmpdir(), "portfolio-optimization-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "strategy.mjs"), `
    export function proposeTrade(history, market) {
      if (history.length !== 90 || market?.timesfm?.asOf !== history.at(-1).date) return null;
      // Mutating a supplied candle must not affect another strategy call.
      const close = history.at(-1).close;
      history.at(-1).close = -1;
      if (Number(history.at(-1).date.slice(-2)) % 5 !== 0) return null;
      return { side: 'long', entry: { min: close - 1, max: close + 1 },
        stopLoss: close - 4, target: close + 8, maxHoldDays: 4,
        setup: 'fixture', regime: 'fixture', strategyVersion: 'fixture' };
    }
  `);
  const candles = Array.from({ length: 140 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100, high: 102, low: 98, close: 100, volume: 1e6,
  }));
  const forecasts = Object.fromEntries(candles.map(c => [c.date,
    { asOf: c.date, horizonDays: 10 as const, predictedReturnPct: 1 }]));
  const context = { symbols: { AAA: candles, BBB: candles }, initial_capital: 10000,
    risk_per_trade: 0.02, max_positions: 2, strategy_lookback_days: 90,
    timesfm_forecasts: { AAA: forecasts, BBB: forecasts } };
  const options = { engineRoot: dir, strategyPath: "strategy.mjs" };
  const profiles = ["conservative", "moderate", "aggressive"];
  const independent = await Promise.all(profiles.map(profile =>
    runPortfolioBacktestInWorker({ ...context, optimization_profile: profile }, options)));
  const grouped = await runPortfolioBacktestInWorker(
    { ...context, cache_strategy_proposals: true }, { ...options, profiles });
  assert.deepEqual(grouped, independent);
  assert.ok(grouped[1].totalTrades > 0);
});
