import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRefreshArgs, refreshResearch, type RunStep } from "../scripts/refresh-research.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "research-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["db", "docs", ".autoresearch"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "db/prices.db"), "fixture source");
  const forecast = { development: { start: "2022-01-01", end: "2024-12-31" },
    holdout: { start: "2025-01-01", end: "2025-12-31" }, symbols: ["AAA"], horizons: [10] };
  writeFileSync(join(root, "docs/timesfm-benchmark.json"), JSON.stringify(forecast));
  const config = { evaluation: { dbPath: "db/market.db", symbols: ["AAA"],
    trainingStart: "2022-01-01", trainingEnd: "2022-12-31", foldStart: "2023-01-01",
    foldMonths: 6, foldCount: 2, rollingYears: 1, evaluationEnd: "2023-12-31",
    timesfm: { dbPath: "db/forecasts.db", campaign: "old", model: "timesfm_ohlcv" } },
    executionCosts: { brokeragePerSide: 3, slippageBpsPerSide: 5 } };
  const configPath = join(root, "autoresearch.config.json");
  const original = JSON.stringify(config);
  writeFileSync(configPath, original);
  const db = new DatabaseSync(join(root, "db/forecasts.db"));
  db.exec(`CREATE TABLE campaigns (id TEXT, manifest TEXT, status TEXT);
    CREATE TABLE forecasts (campaign TEXT, symbol TEXT, model TEXT, horizon INTEGER,
      origin TEXT, origin_price REAL, forecast_price REAL);`);
  const manifest = { partition: "development", data_sha256: "fixture", config: {
    revision: "pinned", stride: 5, development: forecast.development } };
  db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)").run("new", JSON.stringify(manifest), "complete");
  for (const date of ["2022-06-01", "2023-02-01", "2023-08-01"]) {
    db.prepare("INSERT INTO forecasts VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("new", "AAA", "timesfm_ohlcv", 10, date, 100, 102);
  }
  db.close();
  const calls: string[][] = [];
  const run: RunStep = (command, args) => {
    calls.push([command, ...args]);
    return command === "uv" && args[0] === "run"
      ? JSON.stringify({ campaign: "new", status: "complete" }) : "";
  };
  return { root, config, configPath, original, forecast, calls, run };
}

test("refresh CLI accepts pnpm separators and rejects missing values and unknown flags", () => {
  assert.deepEqual(parseRefreshArgs(["--", "--prepare-only"]), parseRefreshArgs([]));
  assert.equal(parseRefreshArgs(["--source", "a path/prices.db"]).source, "a path/prices.db");
  assert.throws(() => parseRefreshArgs(["--source"]), /requires a path/);
  assert.throws(() => parseRefreshArgs(["--source", "--dry-run"]), /requires a path/);
  assert.throws(() => parseRefreshArgs(["--unlock-holdout"]), /Unknown argument/);
});

test("refresh runs ordered steps, selects the actual campaign and backs up only the config", t => {
  const f = fixture(t);
  refreshResearch(f.root, parseRefreshArgs([]), f.run);
  assert.deepEqual(f.calls.map(call => call.slice(0, 3)), [
    ["uv", "--version"], ["pnpm", "run", "market:sync-local"], ["uv", "run", "--locked"],
    ["pnpm", "run", "generate-training"], ["pnpm", "run", "ar"],
  ]);
  assert.equal(f.calls.at(-1)!.at(-1), "baseline");
  assert.ok(!f.calls.flat().includes("loop"));
  assert.ok(!f.calls.flat().includes("--reset"));
  assert.ok(!f.calls.flat().includes("--unlock-holdout"));
  const next = JSON.parse(readFileSync(f.configPath, "utf8"));
  assert.deepEqual(next, { ...f.config, evaluation: { ...f.config.evaluation,
    timesfm: { ...f.config.evaluation.timesfm, campaign: "new" } } });
  const backups = readdirSync(join(f.root, ".autoresearch")).filter(name => name.startsWith("autoresearch.config.before"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.root, ".autoresearch", backups[0]), "utf8"), f.original);
  assert.ok(!existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
  f.calls.length = 0;
  writeFileSync(join(f.root, ".autoresearch/best.json"), "preserve incumbent");
  refreshResearch(f.root, parseRefreshArgs([]), f.run);
  assert.ok(!f.calls.flat().includes("baseline"));
  assert.equal(f.calls.at(-1)![2], "generate-training");
  assert.ok(!f.calls.flat().includes("loop"));
  assert.equal(readFileSync(join(f.root, ".autoresearch/best.json"), "utf8"), "preserve incumbent");
  assert.equal(readdirSync(join(f.root, ".autoresearch")).filter(name => name.startsWith("autoresearch.config.before")).length, 1);
});

test("prepare-only remains a preparation alias; dry-run is read-only", t => {
  const f = fixture(t);
  refreshResearch(f.root, parseRefreshArgs(["--dry-run"]), f.run);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(f.configPath, "utf8"), f.original);
  assert.deepEqual(readdirSync(join(f.root, ".autoresearch")), []);
  refreshResearch(f.root, parseRefreshArgs(["--prepare-only"]), f.run);
  assert.equal(f.calls.at(-1)!.at(-1), "baseline");
  assert.ok(!f.calls.flat().includes("loop"));
});

test("research:loop invokes only the existing loop entry point", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["research:loop"], "tsx src/cli.ts loop");
  assert.equal(pkg.scripts["research:refresh"], "tsx scripts/refresh-research.ts");
  assert.throws(() => parseRefreshArgs(["--run-loop"]), /Unknown argument/);
});

test("disabled or incompatible forecast setup fails before any write or subprocess", t => {
  const f = fixture(t);
  const raw = JSON.parse(f.original);
  delete raw.evaluation.timesfm;
  writeFileSync(f.configPath, JSON.stringify(raw));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /Enable evaluation.timesfm/);
  raw.evaluation = { ...f.config.evaluation, trainingStart: "2017-01-01", trainingEnd: "2017-12-31" };
  writeFileSync(f.configPath, JSON.stringify(raw));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /must cover the research dates/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(join(f.root, ".autoresearch")), []);
});

test("a custom forecast config cannot relabel the original holdout as development", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "custom.json"), JSON.stringify({ ...f.forecast,
    development: { start: "2022-01-01", end: "2025-12-31" },
    holdout: { start: "2026-01-01", end: "2026-12-31" } }));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs(["--forecast-config", "custom.json"]), f.run), /reserved benchmark holdout/);
  assert.equal(f.calls.length, 0);
});

test("failed or incomplete inference never changes the config or starts research", t => {
  const f = fixture(t);
  for (const failure of ["throws", "partial", "bad-json"]) {
    const calls: string[] = [];
    assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args) => {
      calls.push(args.join(" "));
      if (command === "uv" && args[0] === "run") {
        if (failure === "throws") throw new Error("inference failed");
        return failure === "partial" ? JSON.stringify({ campaign: "new", status: "partial" }) : "bad-json";
      }
      return "";
    }));
    assert.ok(!calls.some(call => call.includes("generate-training") || call.includes(" loop")));
    assert.equal(readFileSync(f.configPath, "utf8"), f.original);
    assert.deepEqual(readdirSync(join(f.root, ".autoresearch")), []);
  }
});

test("concurrent pipeline runs are refused without removing the other lock", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".autoresearch/refresh-research.lock"));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /EEXIST/);
  assert.equal(f.calls.length, 0);
  assert.ok(existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
});

test("training export failure stops before the agent loop and leaves a recoverable config backup", t => {
  const f = fixture(t);
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args, capture) => {
    if (args.includes("generate-training")) throw new Error("training export failed");
    return f.run(command, args, capture);
  }), /training export failed/);
  assert.ok(!f.calls.flat().includes("ar"));
  assert.ok(!existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
  assert.ok(readdirSync(join(f.root, ".autoresearch")).some(name => name.startsWith("autoresearch.config.before")));
});
