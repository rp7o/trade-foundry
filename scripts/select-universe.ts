#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { openMarketDatabase } from "./market-db.js";

const CONFIG_PATH = "autoresearch.config.json";
const TOP_N = 30;
const HISTORY_START_BY = "2014-01-31";
const EXCLUDED = new Set(["VAS.AX", "^AXJO", "^AXVI", "^GSPC"]);

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const write = args.includes("--write");
  const topIndex = args.indexOf("--top");
  const top = topIndex >= 0 ? Number(args[topIndex + 1]) : TOP_N;
  if (!Number.isInteger(top) || top <= 0) throw new Error("--top must be a positive integer");
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { evaluation: { dbPath: string; trainingEnd: string; symbols: string[] } };
  const db = openMarketDatabase(config.evaluation.dbPath);
  try {
    const rows = db.prepare(`
      SELECT symbol, AVG(close * volume) AS adv, MIN(date) AS first_date, COUNT(*) AS n
      FROM prices WHERE date <= ? GROUP BY symbol
      HAVING first_date <= ? ORDER BY adv DESC
    `).all(config.evaluation.trainingEnd, HISTORY_START_BY) as Array<{ symbol: string; adv: number }>;
    const selected = rows.filter((row) => !EXCLUDED.has(row.symbol)).slice(0, top);
    console.log(`top ${top} by ADV over training window (<= ${config.evaluation.trainingEnd}):`);
    selected.forEach((row, index) => console.log(`  ${String(index + 1).padStart(2)}. ${row.symbol.padEnd(10)} A$${(row.adv / 1_000_000).toFixed(1)}M`));
    if (write) {
      config.evaluation.symbols = selected.map((row) => row.symbol);
      writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`\nwrote ${selected.length} symbols to ${CONFIG_PATH}`);
    }
  } finally {
    db.close();
  }
}

main();
