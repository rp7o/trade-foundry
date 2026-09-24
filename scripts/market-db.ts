import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MARKET_DB_PATH = "db/market.db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prices (
    symbol     TEXT NOT NULL,
    date       TEXT NOT NULL,
    open       REAL NOT NULL,
    high       REAL NOT NULL,
    low        REAL NOT NULL,
    close      REAL NOT NULL,
    adj_close  REAL NOT NULL,
    volume     INTEGER NOT NULL,
    PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
`;

export interface PriceRow {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number;
  volume: number;
}

export function configuredMarketDbPath(): string {
  if (!existsSync("autoresearch.config.json")) return MARKET_DB_PATH;
  return JSON.parse(readFileSync("autoresearch.config.json", "utf8")).evaluation?.dbPath ?? MARKET_DB_PATH;
}

export function openMarketDatabase(dbPath = configuredMarketDbPath()): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** Parse RFC 4180-style CSV while retaining empty fields. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      field = "";
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
    } else {
      field += char;
    }
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    if (record.some((value) => value.length > 0)) records.push(record);
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  return records;
}

export function readCsv(path: string): Record<string, string>[] {
  const records = parseCsv(readFileSync(path, "utf8"));
  const header = records.shift() ?? [];
  if (header.length === 0) return [];
  return records.map((values, index) => {
    if (values.length !== header.length) {
      throw new Error(`${path}:${index + 2}: wrong number of CSV columns`);
    }
    return Object.fromEntries(header.map((name, column) => [name, values[column]]));
  });
}

export function queryPrices(
  db: DatabaseSync,
  symbols: string[],
): Record<string, PriceRow[]> {
  const statement = db.prepare(`
    SELECT symbol, date, open, high, low, close, adj_close, volume
    FROM prices WHERE symbol = ? ORDER BY date
  `);
  return Object.fromEntries(symbols.map((symbol) => [
    symbol,
    (statement.all(symbol) as Array<Record<string, unknown>>).map((row) => ({
      symbol: String(row.symbol),
      date: String(row.date),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      adj_close: Number(row.adj_close),
      volume: Number(row.volume),
    })),
  ]));
}
