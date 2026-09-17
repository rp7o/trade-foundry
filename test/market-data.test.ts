import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMarketDatabase } from "../scripts/market-db.js";
import { parseImportRows, upsertPrices } from "../scripts/market-data.js";
import { syncMissingRows } from "../scripts/sync-market-data.js";

test("market CSV import preserves adjusted prices and upserts by symbol/date", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trade-foundry-market-"));
  const csvPath = path.join(directory, "prices.csv");
  await writeFile(csvPath, [
    "symbol,date,open,high,low,close,adj_close,volume,provider_note",
    "TEST.AX,2025-01-02,10,11,9,10.5,10.4,1000,first",
    "TEST.AX,2025-01-03,10.5,12,10,11.5,11.3,1200,first",
  ].join("\n"));
  const rows = parseImportRows(csvPath);
  const db = openMarketDatabase(path.join(directory, "db", "market.db"));
  try {
    upsertPrices(db, rows);
    upsertPrices(db, [{ ...rows[0], close: 10.6, adj_close: 10.5 }]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM prices").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT adj_close FROM prices WHERE date = '2025-01-02'").get() as { adj_close: number }).adj_close, 10.5);
  } finally {
    db.close();
  }
});

test("market CSV import rejects missing adjusted close and malformed dates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trade-foundry-market-"));
  const missingColumnPath = path.join(directory, "missing.csv");
  await writeFile(missingColumnPath, "symbol,date,open,high,low,close,volume\nTEST.AX,2025-01-02,1,2,1,1.5,10\n");
  assert.throws(() => parseImportRows(missingColumnPath), /missing required columns:.*adj_close/);

  const malformedPath = path.join(directory, "malformed.csv");
  await writeFile(malformedPath, "symbol,date,open,high,low,close,adj_close,volume\nTEST.AX,2025-1-2,1,2,1,1.5,1.5,10\n");
  assert.throws(() => parseImportRows(malformedPath), /invalid symbol\/date\/price\/volume/);
});

function createSourceDatabase(pathname: string): DatabaseSync {
  const db = new DatabaseSync(pathname);
  db.exec(`
    CREATE TABLE prices (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      adj_close REAL,
      volume INTEGER,
      PRIMARY KEY (symbol, date)
    )
  `);
  return db;
}

test("local database sync imports only dates newer than each target symbol", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trade-foundry-sync-"));
  const sourcePath = path.join(directory, "prices.db");
  const targetPath = path.join(directory, "market.db");
  const source = createSourceDatabase(sourcePath);
  source.exec(`
    INSERT INTO prices VALUES
      ('TEST.AX', '2026-07-17', 10, 11, 9, 10.5, 10.4, 1000),
      ('TEST.AX', '2026-07-20', 11, 12, 10, 11.5, 11.3, 1200),
      ('TEST.AX', '2026-07-21', 12, 13, 11, 12.5, 12.3, 1300)
  `);
  source.close();

  const target = openMarketDatabase(targetPath);
  try {
    upsertPrices(target, [{
      symbol: "TEST.AX",
      date: "2026-07-17",
      open: 9,
      high: 10,
      low: 8,
      close: 9.5,
      adj_close: 9.4,
      volume: 900,
    }]);
  } finally {
    target.close();
  }

  const result = syncMissingRows({ sourcePath, targetPath, symbols: ["TEST.AX"] });
  assert.equal(result.rowsImported, 2);
  const synced = openMarketDatabase(targetPath);
  try {
    assert.equal((synced.prepare("SELECT COUNT(*) AS count FROM prices").get() as { count: number }).count, 3);
    assert.equal((synced.prepare("SELECT adj_close FROM prices WHERE date = '2026-07-17'").get() as { adj_close: number }).adj_close, 9.4);
  } finally {
    synced.close();
  }
});

test("local database sync validates all rows before writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trade-foundry-sync-"));
  const sourcePath = path.join(directory, "prices.db");
  const targetPath = path.join(directory, "market.db");
  const source = createSourceDatabase(sourcePath);
  source.exec(`
    INSERT INTO prices VALUES
      ('TEST.AX', '2026-07-20', 11, 12, 10, 11.5, 11.3, 1200),
      ('TEST.AX', '2026-07-21', 12, 13, 11, 12.5, NULL, 1300)
  `);
  source.close();

  assert.throws(
    () => syncMissingRows({ sourcePath, targetPath, symbols: ["TEST.AX"] }),
    /invalid row for TEST\.AX on 2026-07-21/
  );
  const target = openMarketDatabase(targetPath);
  try {
    assert.equal((target.prepare("SELECT COUNT(*) AS count FROM prices").get() as { count: number }).count, 0);
  } finally {
    target.close();
  }
});
