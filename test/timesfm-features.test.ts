import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTimesfmFeatures } from "../scripts/timesfm-features.js";
import { timesfmAsOf } from "../research/engine/timesfm-context.mjs";
import { runSignalScreen } from "../research/trade-long/signal-screen.js";
import type { Candle } from "../research/trade-long/strategy.js";
import { runPortfolioBacktest } from "../research/engine/index.mjs";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "timesfm-features-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "forecasts.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE campaigns (id TEXT PRIMARY KEY, manifest TEXT, status TEXT);
    CREATE TABLE forecasts (campaign TEXT, symbol TEXT, model TEXT, horizon INTEGER,
    origin TEXT, origin_price REAL, forecast_price REAL, actual_price REAL, target_date TEXT);`);
  const manifest = { partition: "development", data_sha256: "input-hash", config: {
    revision: "pinned", stride: 5, development: { start: "2022-01-01", end: "2024-12-31" },
  } };
  db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)").run("test", JSON.stringify(manifest), "complete");
  db.exec(`INSERT INTO forecasts VALUES ('test', 'AAA', 'timesfm_ohlcv', 10, '2022-01-20', 100, 102, 999, '2022-02-03');
    INSERT INTO forecasts VALUES ('test', 'AAA', 'timesfm_ohlcv', 10, '2023-01-20', 100, 90, 999, '2023-02-03');`);
  t.after(() => db.close());
  return { db, manifest, config: { dbPath, campaign: "test", model: "timesfm_ohlcv" as const } };
}
const training = [{ name: "training", start: "2022-01-01", end: "2022-12-31" }];

test("feature loader strips outcomes, excludes later rows, and fingerprints only selected forecasts", t => {
  const { db, config } = fixture(t);
  const first = loadTimesfmFeatures(config, ["AAA"], training);
  assert.deepEqual(Object.keys(first.forecasts.AAA), ["2022-01-20"]);
  const feature = first.forecasts.AAA["2022-01-20"];
  assert.deepEqual(Object.keys(feature).sort(), ["asOf", "horizonDays", "predictedReturnPct"]);
  assert.ok(Math.abs(feature.predictedReturnPct - 2) < 1e-10);
  db.exec("UPDATE forecasts SET actual_price = -12345");
  assert.deepEqual(loadTimesfmFeatures(config, ["AAA"], training), first);
  db.exec("UPDATE forecasts SET forecast_price = 110 WHERE origin = '2022-01-20'");
  assert.notEqual(loadTimesfmFeatures(config, ["AAA"], training).metadata.featureFingerprint, first.metadata.featureFingerprint);
});

test("loader fails closed on absent coverage, incomplete campaigns, and holdout access", t => {
  const { db, config, manifest } = fixture(t);
  assert.throws(() => loadTimesfmFeatures(config, ["BBB"], training), /No TimesFM/);
  assert.throws(() => loadTimesfmFeatures(config, ["AAA"], [{ name: "holdout", start: "2025-01-01", end: "2025-12-31" }]), /development partition/);
  db.exec("UPDATE campaigns SET status = 'partial'");
  assert.throws(() => loadTimesfmFeatures(config, ["AAA"], training), /complete/);
  db.prepare("UPDATE campaigns SET status = 'complete', manifest = ?").run(JSON.stringify({ ...manifest, partition: "holdout" }));
  assert.throws(() => loadTimesfmFeatures(config, ["AAA"], training), /holdout forecasts are forbidden/);
});

test("lookup never carries forward or crosses symbols and returns a defensive whitelist copy", t => {
  const { config } = fixture(t);
  const { forecasts } = loadTimesfmFeatures(config, ["AAA"], training);
  assert.equal(timesfmAsOf(forecasts, "AAA", "2022-01-19"), undefined);
  assert.equal(timesfmAsOf(forecasts, "AAA", "2022-01-21"), undefined);
  assert.equal(timesfmAsOf(forecasts, "BBB", "2022-01-20"), undefined);
  const value = timesfmAsOf(forecasts, "AAA", "2022-01-20")!;
  value.predictedReturnPct = -100;
  assert.ok(timesfmAsOf(forecasts, "AAA", "2022-01-20")!.predictedReturnPct > 0);
});

test("signal screen injects exact-date features and never exposes post-training dates", t => {
  const { config } = fixture(t);
  const { forecasts } = loadTimesfmFeatures(config, ["AAA"], training);
  const candles: Candle[] = Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100, high: 102, low: 98, close: 100, volume: 1e6,
  }));
  let received = 0;
  runSignalScreen({ AAA: candles, BBB: candles }, {}, (history, market) => {
    assert.ok(history.at(-1)!.date <= "2022-02-01");
    if (market?.timesfm) {
      received++;
      assert.equal(market.timesfm.asOf, history.at(-1)!.date);
    }
    return null;
  }, { trainingStart: "2022-01-01", trainingEnd: "2022-02-01", lookback: 15, timesfm: forecasts });
  assert.equal(received, 1);
});

test("portfolio engine follows the strategy's forecast rule, not a built-in positive-forecast rule", async t => {
  const dir = mkdtempSync(join(tmpdir(), "timesfm-engine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "strategy.mjs"), `
    export function proposeTrade(history, market) {
      const last = history.at(-1);
      if (!market?.timesfm || market.timesfm.asOf !== last.date) return null;
      if (market.timesfm.predictedReturnPct >= 0) return null;
      return { side: 'long', entry: { min: 99, max: 101 }, stopLoss: 95, target: 110,
        maxHoldDays: 3, setup: 'forecast', regime: 'test', strategyVersion: 'test' };
    }
  `);
  const candles = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100, high: 101, low: 99, close: 100, volume: 1e6,
  }));
  const date = candles[95].date;
  const context = { symbols: { AAA: candles, BBB: candles }, initial_capital: 10000,
    risk_per_trade: 0.02, max_positions: 2 };
  const options = { engineRoot: dir, strategyPath: "strategy.mjs" };
  const baseline = await runPortfolioBacktest(context, options);
  const empty = await runPortfolioBacktest({ ...context, timesfm_forecasts: {} }, options);
  assert.deepEqual(empty, baseline);
  assert.equal(baseline.totalTrades, 0);
  const positive = await runPortfolioBacktest({ ...context, timesfm_forecasts: {
    AAA: { [date]: { asOf: date, horizonDays: 10, predictedReturnPct: 2 } },
  } }, options);
  assert.deepEqual(positive, baseline);
  const enabled = await runPortfolioBacktest({ ...context, timesfm_forecasts: {
    AAA: { [date]: { asOf: date, horizonDays: 10, predictedReturnPct: -2 } },
  } }, options);
  assert.equal(enabled.totalTrades, 1);
  assert.equal(enabled.trades[0].symbol, "AAA");
  assert.equal(enabled.trades[0].signalDate, date);
  assert.ok(enabled.trades[0].brokerage > 0);
});

test("a strategy that ignores forecasts has identical trades and results with positive, negative or missing data", async t => {
  const dir = mkdtempSync(join(tmpdir(), "timesfm-optional-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "strategy.mjs"), `
    export function proposeTrade(history) {
      if (history.at(-1).date !== '2022-04-06') return null;
      return { side: 'long', entry: { min: 99, max: 101 }, stopLoss: 95, target: 110,
        maxHoldDays: 3, setup: 'ohlcv', regime: 'test', strategyVersion: 'test' };
    }
  `);
  const candles = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100, high: 101, low: 99, close: 100, volume: 1e6,
  }));
  const context = { symbols: { AAA: candles, BBB: candles }, initial_capital: 10000,
    risk_per_trade: 0.02, max_positions: 2 };
  const options = { engineRoot: dir, strategyPath: "strategy.mjs" };
  const baseline = await runPortfolioBacktest(context, options);
  assert.equal(baseline.totalTrades, 2);
  for (const predictedReturnPct of [-2, 2]) {
    const forecasts = Object.fromEntries(candles.map(({ date }) => [date,
      { asOf: date, horizonDays: 10 as const, predictedReturnPct }]));
    const result = await runPortfolioBacktest({ ...context,
      timesfm_forecasts: { AAA: forecasts, BBB: forecasts } }, options);
    assert.deepEqual(result, baseline);
  }
});

test("training CSV export contains only training forecast features", t => {
  const { config } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), "timesfm-training-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marketPath = join(dir, "market.db");
  const market = new DatabaseSync(marketPath);
  market.exec(`CREATE TABLE prices (symbol TEXT, date TEXT, open REAL, high REAL, low REAL,
    close REAL, adj_close REAL, volume INTEGER, PRIMARY KEY(symbol, date));`);
  market.close();
  writeFileSync(join(dir, "autoresearch.config.json"), JSON.stringify({
    evaluation: { dbPath: marketPath, symbols: ["AAA"], trainingStart: "2022-01-01",
      trainingEnd: "2022-12-31", foldStart: "2023-01-01", foldMonths: 6,
      foldCount: 4, rollingYears: 2, evaluationEnd: "2024-12-31", timesfm: config },
    executionCosts: { brokeragePerSide: 3, slippageBpsPerSide: 5 },
  }));
  execFileSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"),
    resolve("scripts/generate-training-data.ts")], { cwd: dir });
  const csv = readFileSync(join(dir, "research/trade-long/training-data/timesfm-AAA.csv"), "utf8");
  assert.ok(csv.startsWith("asOf,horizonDays,predictedReturnPct\n2022-01-20,10,"));
  assert.ok(!csv.includes("2023") && !csv.includes("actual_price"));
});
