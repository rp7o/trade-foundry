#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MARKET_DB_PATH, openMarketDatabase, parseCsv, readCsv, type PriceRow } from "./market-db.js";

const REQUIRED_COLUMNS = ["symbol", "date", "open", "high", "low", "close", "adj_close", "volume"] as const;
const UNIVERSE_PATH = "research/trade-long/universe.csv";
const MAX_DAILY_MOVE = 0.5;

function parseIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

export function parseImportRows(path: string): PriceRow[] {
  const records = parseCsv(readFileSync(path, "utf8"));
  const header = records.shift() ?? [];
  const positions = Object.fromEntries(header.map((name, index) => [name, index]));
  const missing = REQUIRED_COLUMNS.filter((column) => positions[column] === undefined);
  if (missing.length > 0) {
    throw new Error(`${path}: missing required columns: ${missing.join(", ")}`);
  }

  return records.map((values, rowIndex) => {
    const line = rowIndex + 2;
    const get = (column: (typeof REQUIRED_COLUMNS)[number]) => values[positions[column]] ?? "";
    const symbol = get("symbol").trim();
    const date = get("date").trim();
    const open = Number(get("open"));
    const high = Number(get("high"));
    const low = Number(get("low"));
    const close = Number(get("close"));
    const adj_close = Number(get("adj_close"));
    const volumeValue = Number(get("volume"));
    const volume = Math.trunc(volumeValue);
    if (
      !symbol || !parseIsoDate(date) ||
      ![open, high, low, close, adj_close].every(Number.isFinite) ||
      ![open, high, low, close, adj_close].every((value) => value > 0) ||
      !Number.isFinite(volumeValue) || volumeValue < 0 || volumeValue !== volume || high < low
    ) {
      throw new Error(`${path}:${line}: invalid symbol/date/price/volume`);
    }
    return { symbol, date, open, high, low, close, adj_close, volume };
  });
}

export function upsertPrices(db: DatabaseSync, rows: PriceRow[]): void {
  const statement = db.prepare(`
    INSERT INTO prices (symbol, date, open, high, low, close, adj_close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, adj_close=excluded.adj_close, volume=excluded.volume
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(row.symbol, row.date, row.open, row.high, row.low, row.close, row.adj_close, row.volume);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateSymbol(db: DatabaseSync, symbol: string): string[] {
  const problems: string[] = [];
  const bad = db.prepare(`
    SELECT COUNT(*) AS count FROM prices WHERE symbol = ?
      AND (open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
           OR adj_close <= 0 OR high < low)
  `).get(symbol) as { count: number };
  if (Number(bad.count) > 0) problems.push(`${symbol}: ${bad.count} malformed rows`);

  const rows = db.prepare("SELECT date, adj_close FROM prices WHERE symbol = ? ORDER BY date").all(symbol) as Array<{ date: string; adj_close: number }>;
  let previous: number | null = null;
  for (const row of rows) {
    if (previous !== null && Math.abs(row.adj_close / previous - 1) > MAX_DAILY_MOVE) {
      problems.push(`${symbol}: >50% adjusted move into ${row.date}`);
    }
    previous = row.adj_close;
  }
  return problems;
}

function status(validate: boolean): void {
  const db = openMarketDatabase();
  try {
    const universe = readCsv(UNIVERSE_PATH).filter((row) => row.status !== "no-yahoo-data");
    let total = 0;
    const problems: string[] = [];
    console.log(`${"symbol".padEnd(10)} ${"rows".padStart(6)}  ${"first".padEnd(10)}  last`);
    for (const { symbol } of universe) {
      const row = db.prepare("SELECT COUNT(*) AS count, MIN(date) AS first, MAX(date) AS last FROM prices WHERE symbol = ?").get(symbol) as { count: number; first: string | null; last: string | null };
      const count = Number(row.count);
      total += count;
      if (count === 0) {
        console.log(`${symbol.padEnd(10)} ${"-".padStart(6)}  missing`);
        continue;
      }
      if (validate) problems.push(...validateSymbol(db, symbol));
      console.log(`${symbol.padEnd(10)} ${String(count).padStart(6)}  ${row.first}  ${row.last}`);
    }
    console.log(`total rows: ${total}`);
    if (validate) {
      console.log(problems.length > 0 ? `validation problems:\n${problems.map((p) => `  ${p}`).join("\n")}` : "validation: clean");
    }
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const [command, ...commandArgs] = args;
  if (commandArgs[0] === "--") commandArgs.shift();
  const [argument] = commandArgs;
  if (command === "import") {
    if (argument === "--help" || argument === "-h") {
      console.log("usage: market-data.ts import <csv-path>");
      return;
    }
    if (!argument) throw new Error("usage: market-data.ts import <csv-path>");
    const rows = parseImportRows(argument);
    if (rows.length === 0) throw new Error(`import file contains no data rows: ${argument}`);
    const db = openMarketDatabase();
    try {
      upsertPrices(db, rows);
    } finally {
      db.close();
    }
    console.log(`imported ${rows.length} rows for ${new Set(rows.map((row) => row.symbol)).size} symbols from ${argument}`);
  } else if (command === "status") {
    if (argument === "--help" || argument === "-h") {
      console.log("usage: market-data.ts status [--validate]");
      return;
    }
    status(commandArgs.includes("--validate"));
  } else {
    throw new Error(`usage: market-data.ts {import <csv-path>|status [--validate]} (database: ${MARKET_DB_PATH})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
