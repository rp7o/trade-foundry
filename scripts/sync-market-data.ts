#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  MARKET_DB_PATH,
  openMarketDatabase,
  type PriceRow,
} from "./market-db.js";
import { upsertPrices } from "./market-data.js";

const DEFAULT_SOURCE_PATH = "db/prices.db";
const MARKET_CONTEXT_SYMBOLS = ["^AXJO", "^AXVI"];

export interface SyncOptions {
  sourcePath: string;
  targetPath: string;
  symbols: string[];
  after?: string;
}

export interface SyncResult {
  rowsImported: number;
  symbolsImported: number;
  importedBySymbol: Record<string, number>;
}

interface EvaluationConfigFile {
  data?: { sourcePath?: string };
  evaluation?: {
    symbols?: unknown;
    dbPath?: string;
    marketSymbols?: Record<string, string>;
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  } catch {
    return false;
  }
}

function loadSymbols(configPath = "autoresearch.config.json"): string[] {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as EvaluationConfigFile;
  const symbols = config.evaluation?.symbols;
  if (!Array.isArray(symbols) || symbols.some((symbol) => typeof symbol !== "string")) {
    throw new Error("autoresearch.config.json evaluation.symbols must be an array of strings");
  }
  return [...new Set([...symbols, ...(config.evaluation?.marketSymbols ? Object.values(config.evaluation.marketSymbols) : MARKET_CONTEXT_SYMBOLS)])];
}

function validateSourceRow(raw: Record<string, unknown>, sourcePath: string, requestedSymbol: string): PriceRow {
  const symbol = raw.symbol;
  const date = raw.date;
  const requiredValues = [raw.open, raw.high, raw.low, raw.close, raw.adj_close, raw.volume];
  if (
    typeof symbol !== "string" || symbol !== requestedSymbol ||
    typeof date !== "string" || !isIsoDate(date) ||
    requiredValues.some((value) => value === null || value === undefined)
  ) {
    throw new Error(`${sourcePath}: invalid row for ${requestedSymbol} on ${String(date ?? "<unknown>")}`);
  }

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  const adj_close = Number(raw.adj_close);
  const volume = Number(raw.volume);
  if (
    ![open, high, low, close, adj_close, volume].every(Number.isFinite) ||
    ![open, high, low, close, adj_close].every((value) => value > 0) ||
    volume < 0 || volume !== Math.trunc(volume) || high < low
  ) {
    throw new Error(`${sourcePath}: invalid row for ${requestedSymbol} on ${date}`);
  }

  return { symbol, date, open, high, low, close, adj_close, volume };
}

function targetMaximumDate(db: DatabaseSync, symbol: string): string {
  const row = db.prepare("SELECT MAX(date) AS last FROM prices WHERE symbol = ?").get(symbol) as { last: string | null };
  return row.last ?? "";
}

function sourceRowsAfter(
  db: DatabaseSync,
  sourcePath: string,
  symbol: string,
  cutoff: string,
): PriceRow[] {
  const rows = db.prepare(`
    SELECT symbol, date, open, high, low, close, adj_close, volume
    FROM prices
    WHERE symbol = ? AND date > ?
    ORDER BY date
  `).all(symbol, cutoff) as Array<Record<string, unknown>>;
  return rows.map((row) => validateSourceRow(row, sourcePath, symbol));
}

export function syncMissingRows(options: SyncOptions): SyncResult {
  if (options.after !== undefined && !isIsoDate(options.after)) {
    throw new Error(`--after must be an ISO date (YYYY-MM-DD): ${options.after}`);
  }
  if (!existsSync(options.sourcePath)) {
    throw new Error(`source database does not exist: ${options.sourcePath}`);
  }
  if (resolve(options.sourcePath) === resolve(options.targetPath)) {
    throw new Error("source and target databases must be different files");
  }

  const source = new DatabaseSync(options.sourcePath, { readOnly: true });
  const target = openMarketDatabase(options.targetPath);
  try {
    const rows: PriceRow[] = [];
    const importedBySymbol: Record<string, number> = {};
    for (const symbol of options.symbols) {
      const targetDate = targetMaximumDate(target, symbol);
      const cutoff = [targetDate, options.after ?? ""].sort().at(-1) ?? "";
      const newRows = sourceRowsAfter(source, options.sourcePath, symbol, cutoff);
      rows.push(...newRows);
      if (newRows.length > 0) importedBySymbol[symbol] = newRows.length;
    }

    // Validate all source rows before this transaction begins.
    upsertPrices(target, rows);
    return {
      rowsImported: rows.length,
      symbolsImported: Object.keys(importedBySymbol).length,
      importedBySymbol,
    };
  } finally {
    target.close();
    source.close();
  }
}

interface ParsedArgs {
  sourcePath: string;
  targetPath: string;
  after?: string;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "--") args = args.slice(1);
  const config: EvaluationConfigFile = existsSync("autoresearch.config.json")
    ? JSON.parse(readFileSync("autoresearch.config.json", "utf8")) : {};
  const parsed: ParsedArgs = {
    sourcePath: config.data?.sourcePath ?? DEFAULT_SOURCE_PATH,
    targetPath: config.evaluation?.dbPath ?? MARKET_DB_PATH,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--source" || argument === "--target" || argument === "--after") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--source") parsed.sourcePath = value;
      else if (argument === "--target") parsed.targetPath = value;
      else parsed.after = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function usage(): void {
  console.log([
    "usage: sync-market-data.ts [--source <path>] [--target <path>] [--after YYYY-MM-DD]",
    "",
    "Sync newer configured-symbol rows from a source prices database into market.db.",
    "The target's maximum date remains the effective per-symbol cutoff.",
  ].join("\n"));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const result = syncMissingRows({
    sourcePath: args.sourcePath,
    targetPath: args.targetPath,
    symbols: loadSymbols(),
    after: args.after,
  });
  for (const [symbol, count] of Object.entries(result.importedBySymbol)) {
    console.log(`${symbol}: ${count} new rows`);
  }
  console.log(`imported ${result.rowsImported} rows for ${result.symbolsImported} symbols`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
