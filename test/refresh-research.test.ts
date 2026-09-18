import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRefreshArgs, refreshResearch, type RunStep } from "../scripts/refresh-research.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "research-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["db", "docs"]) mkdirSync(join(root, dir));
  const settings = { model: "example/model", revision: "a".repeat(40), variant: "timesfm_ohlcv",
    horizon: 10, context: 32, stride: 5,
    inference: { batch_size: 2, threads: 1, use_symmetric_averaging: false, use_znorm: false, sort_quantiles: true } };
  writeFileSync(join(root, "docs/timesfm-research.json"), JSON.stringify(settings));
  const config = { evaluation: { dbPath: "db/market.db", symbols: ["AAA"],
    trainingStart: "2022-01-01", trainingEnd: "2022-12-31", foldStart: "2023-01-01",
    foldMonths: 6, foldCount: 2, rollingYears: 1, evaluationEnd: "2023-12-31" },
    executionCosts: { brokeragePerSide: 3, slippageBpsPerSide: 5 } };
  const configPath = join(root, "autoresearch.config.json");
  const original = JSON.stringify(config);
  writeFileSync(configPath, original);
  const marketPath = join(root, "db/market.db");
  const market = new DatabaseSync(marketPath);
  market.exec("CREATE TABLE prices (symbol TEXT, date TEXT)");
  for (const date of ["2021-01-01", "2022-06-01", "2023-02-01", "2023-08-01", "2024-06-01"]) {
    market.prepare("INSERT INTO prices VALUES (?, ?)").run("AAA", date);
  }
  market.close();
  const marketBefore = readFileSync(marketPath);
  const calls: string[][] = [];
  let request: { settings: typeof settings; symbols: string[]; ranges: Array<{ name: string; start: string; end: string }> };
  const run: RunStep = (command, args) => {
    calls.push([command, ...args]);
    if (command !== "uv" || args[0] !== "run") return "";
    request = JSON.parse(readFileSync(args[args.indexOf("--request") + 1], "utf8"));
    assert.equal(args[args.indexOf("--db") + 1], marketPath);
    const cache = args[args.indexOf("--cache") + 1];
    mkdirSync(join(root, ".autoresearch/timesfm"), { recursive: true });
    const db = new DatabaseSync(cache);
    db.exec(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, manifest TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS forecasts (campaign TEXT, symbol TEXT, model TEXT, horizon INTEGER,
        origin TEXT, origin_price REAL, forecast_price REAL); DELETE FROM forecasts;`);
    const manifest = { partition: "research", data_sha256: "fixture", config: {
      ...request.settings, ranges: request.ranges, symbols: request.symbols } };
    db.prepare("INSERT OR REPLACE INTO campaigns VALUES (?, ?, ?)").run("synthetic-campaign", JSON.stringify(manifest), "complete");
    for (const range of request.ranges) {
      db.prepare("INSERT INTO forecasts VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("synthetic-campaign", "AAA", settings.variant, 10, range.start, 100, 102);
    }
    db.close();
    return JSON.stringify({ campaign: "synthetic-campaign", status: "complete" });
  };
  return { root, config, configPath, original, settings, calls, run, marketPath, marketBefore, request: () => request };
}

const backups = (root: string) => readdirSync(join(root, ".autoresearch")).filter(name => name.startsWith("autoresearch.config.before"));

test("refresh CLI accepts pnpm separators and rejects missing values, source sync and loop flags", () => {
  assert.deepEqual(parseRefreshArgs(["--", "--prepare-only"]), parseRefreshArgs([]));
  assert.equal(parseRefreshArgs(["--forecast-config", "a path/settings.json"]).forecastConfig, "a path/settings.json");
  assert.throws(() => parseRefreshArgs(["--forecast-config"]), /requires a path/);
  assert.throws(() => parseRefreshArgs(["--forecast-config", "--dry-run"]), /requires a path/);
  for (const flag of ["--source", "--run-loop", "--unlock-holdout"]) {
    assert.throws(() => parseRefreshArgs([flag]), /Unknown argument/);
  }
});

test("fresh preparation uses imported prices, preserves dates, enables validated forecasts and baselines once", t => {
  const f = fixture(t);
  refreshResearch(f.root, parseRefreshArgs([]), f.run);
  assert.deepEqual(f.calls.map(call => call.slice(0, 3)), [
    ["uv", "--version"], ["uv", "run", "--locked"], ["pnpm", "run", "generate-training"], ["pnpm", "run", "ar"],
  ]);
  assert.equal(f.calls.at(-1)!.at(-1), "baseline");
  assert.ok(!f.calls.flat().includes("loop") && !f.calls.flat().includes("--reset"));
  assert.deepEqual(f.request().settings, f.settings);
  assert.deepEqual(f.request().ranges.map(r => [r.start, r.end]), [
    ["2022-01-01", "2022-12-31"], ["2023-01-01", "2023-06-30"], ["2023-07-01", "2023-12-31"],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")), { ...f.config,
    evaluation: { ...f.config.evaluation, timesfm: { dbPath: ".autoresearch/timesfm/research-forecasts.db",
      model: f.settings.variant, campaign: "synthetic-campaign" } } });
  assert.equal(backups(f.root).length, 1);
  assert.equal(readFileSync(join(f.root, ".autoresearch", backups(f.root)[0]), "utf8"), f.original);
  assert.deepEqual(readFileSync(f.marketPath), f.marketBefore);
  assert.ok(!existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
  f.calls.length = 0;
  writeFileSync(join(f.root, ".autoresearch/best.json"), "preserve incumbent");
  refreshResearch(f.root, parseRefreshArgs([]), f.run);
  assert.equal(f.calls.at(-1)![2], "generate-training");
  assert.ok(!f.calls.flat().includes("baseline"));
  assert.equal(readFileSync(join(f.root, ".autoresearch/best.json"), "utf8"), "preserve incumbent");
  assert.equal(backups(f.root).length, 1);
});

test("dry run is read-only and needs no Python or model installation", t => {
  const f = fixture(t);
  refreshResearch(f.root, parseRefreshArgs(["--dry-run"]), f.run);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(f.configPath, "utf8"), f.original);
  assert.deepEqual(readFileSync(f.marketPath), f.marketBefore);
  assert.ok(!existsSync(join(f.root, ".autoresearch")));
});

test("research:loop invokes only the existing loop", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["research:loop"], "tsx src/cli.ts loop");
  assert.equal(pkg.scripts["research:refresh"], "tsx scripts/refresh-research.ts");
});

test("missing prices, invalid settings and overlapping dates fail before writes or subprocesses", t => {
  const f = fixture(t);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, evaluation: { ...f.config.evaluation, dbPath: "missing.db" } }));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /market:import/);
  writeFileSync(f.configPath, f.original);
  writeFileSync(join(f.root, "custom.json"), JSON.stringify({ ...f.settings, development: { start: "2022-01-01" } }));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs(["--forecast-config", "custom.json"]), f.run), /not benchmark dates/);
  writeFileSync(join(f.root, "custom.json"), JSON.stringify({ ...f.settings, revision: "main" }));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs(["--forecast-config", "custom.json"]), f.run), /pinned revision/);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, evaluation: { ...f.config.evaluation, trainingEnd: "2023-01-01" } }));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /follow training/);
  assert.equal(f.calls.length, 0);
  assert.ok(!existsSync(join(f.root, ".autoresearch")));
});

test("cache path cannot alias the market database", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".autoresearch/timesfm"), { recursive: true });
  symlinkSync(f.marketPath, join(f.root, ".autoresearch/timesfm/research-forecasts.db"));
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /different files/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readFileSync(f.marketPath), f.marketBefore);
});

test("failed or partial inference keeps the config and cleans the lock", t => {
  const f = fixture(t);
  for (const failure of ["throws", "partial", "bad-json"]) {
    const calls: string[] = [];
    assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args) => {
      calls.push(args.join(" "));
      if (command === "uv" && args[0] === "run") {
        if (failure === "throws") throw new Error("inference failed");
        return failure === "partial" ? JSON.stringify({ campaign: "synthetic-campaign", status: "partial" }) : "bad-json";
      }
      return "";
    }));
    assert.ok(!calls.some(call => call.includes("generate-training") || call.includes("baseline")));
    assert.equal(readFileSync(f.configPath, "utf8"), f.original);
    assert.deepEqual(readdirSync(join(f.root, ".autoresearch")), []);
  }
});

test("missing forecast coverage refuses activation even when inference reports completion", t => {
  const f = fixture(t);
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args, capture) => {
    const result = f.run(command, args, capture);
    if (command === "uv" && args[0] === "run") {
      const db = new DatabaseSync(args[args.indexOf("--cache") + 1]);
      db.exec("DELETE FROM forecasts WHERE origin >= '2023-07-01'");
      db.close();
    }
    return result;
  }), /No TimesFM forecasts/);
  assert.equal(readFileSync(f.configPath, "utf8"), f.original);
  assert.ok(!f.calls.flat().includes("generate-training"));
  assert.ok(!existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
});

test("concurrent preparations do not remove another run's lock", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".autoresearch/refresh-research.lock"), { recursive: true });
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), f.run), /EEXIST/);
  assert.equal(f.calls.length, 0);
  assert.ok(existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
});

test("concurrent config edits are preserved", t => {
  const f = fixture(t);
  const changed = `${f.original}\n`;
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args, capture) => {
    const result = f.run(command, args, capture);
    if (command === "uv" && args[0] === "run") writeFileSync(f.configPath, changed);
    return result;
  }), /refusing to overwrite/);
  assert.equal(readFileSync(f.configPath, "utf8"), changed);
  assert.equal(backups(f.root).length, 0);
});

test("training export failure preserves validated campaign and backup for retry without resetting results", t => {
  const f = fixture(t);
  assert.throws(() => refreshResearch(f.root, parseRefreshArgs([]), (command, args, capture) => {
    if (args.includes("generate-training")) throw new Error("training export failed");
    return f.run(command, args, capture);
  }), /training export failed/);
  assert.ok(!f.calls.flat().includes("ar"));
  assert.equal(JSON.parse(readFileSync(f.configPath, "utf8")).evaluation.timesfm.campaign, "synthetic-campaign");
  assert.equal(backups(f.root).length, 1);
  assert.ok(!existsSync(join(f.root, ".autoresearch/refresh-research.lock")));
});
