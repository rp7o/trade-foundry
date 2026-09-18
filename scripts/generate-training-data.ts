#!/usr/bin/env node
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { openMarketDatabase, queryPrices } from "./market-db.js";
import { loadEvaluationConfig, trainingForecastRange } from "../research/trade-long/walkforward.js";
import { loadTimesfmFeatures } from "./timesfm-features.js";

const CONFIG_PATH = "autoresearch.config.json";
const OUT_DIR = "research/trade-long/training-data";
const MIN_TRAINING_ROWS = 500;
const MARKET_SYMBOLS = { index: "^AXJO", volatility: "^AXVI" };

function writeCsv(path: string, rows: Array<Record<string, string | number>>): void {
  const fields = ["date", "open", "high", "low", "close", "volume"];
  const lines = [fields.join(","), ...rows.map((row) => fields.map((field) => row[field]).join(","))];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function main(): void {
  const config = loadEvaluationConfig(CONFIG_PATH);
  const { dbPath, symbols, trainingEnd } = config;
  const features = config.timesfm ? loadTimesfmFeatures(config.timesfm, symbols,
    [trainingForecastRange(config)]) : undefined;
  const db = openMarketDatabase(dbPath);
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const file of readdirSync(OUT_DIR)) unlinkSync(`${OUT_DIR}/${file}`);
    const prices = queryPrices(db, [...symbols, ...Object.values(MARKET_SYMBOLS)]);
    console.log(`training window: <= ${trainingEnd} (from ${dbPath})`);
    let count = 0;
    for (const symbol of symbols) {
      const rows = (prices[symbol] ?? []).filter((row) => row.date <= trainingEnd);
      if (rows.length < MIN_TRAINING_ROWS) {
        console.log(`  ${symbol}: SKIP — only ${rows.length} rows (need ${MIN_TRAINING_ROWS})`);
        continue;
      }
      const adjusted = rows.map((row) => {
        const factor = row.close !== 0 ? row.adj_close / row.close : 1;
        return { date: row.date, open: round(row.open * factor), high: round(row.high * factor), low: round(row.low * factor), close: round(row.adj_close), volume: row.volume };
      });
      writeCsv(`${OUT_DIR}/${symbol}.csv`, adjusted);
      count += 1;
      console.log(`  ${symbol}: ${rows.length} rows (${rows[0].date} → ${rows.at(-1)?.date})`);
    }
    for (const [name, symbol] of Object.entries(MARKET_SYMBOLS)) {
      const rows = (prices[symbol] ?? []).filter((row) => row.date <= trainingEnd);
      if (rows.length === 0) {
        console.log(`  market-${name}: SKIP — no data for ${symbol}`);
        continue;
      }
      writeCsv(`${OUT_DIR}/market-${name}.csv`, rows.map((row) => ({ date: row.date, open: round(row.open), high: round(row.high), low: round(row.low), close: round(row.adj_close), volume: row.volume })));
      console.log(`  market-${name} (${symbol}): ${rows.length} rows`);
    }
    console.log(`\nGenerated training data CSV files for ${count} stocks`);
    if (features) {
      for (const [symbol, forecasts] of Object.entries(features.forecasts)) {
        const rows = Object.values(forecasts).map(f => `${f.asOf},${f.horizonDays},${f.predictedReturnPct}`);
        writeFileSync(`${OUT_DIR}/timesfm-${symbol}.csv`, `asOf,horizonDays,predictedReturnPct\n${rows.join("\n")}\n`);
      }
      console.log(`Generated training-only TimesFM features from ${features.metadata.campaign}`);
    }
  } finally {
    db.close();
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

main();
