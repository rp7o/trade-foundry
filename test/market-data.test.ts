import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMarketDatabase } from "../scripts/market-db.js";
import { parseImportRows, upsertPrices } from "../scripts/market-data.js";

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
