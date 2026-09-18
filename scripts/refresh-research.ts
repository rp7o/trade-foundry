#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvaluationConfig, loadEvaluationFeatures, researchForecastRanges } from "../research/trade-long/walkforward.js";

export interface RefreshOptions {
  source: string;
  forecastConfig: string;
  dryRun: boolean;
  help: boolean;
}

export function parseRefreshArgs(args: string[]): RefreshOptions {
  if (args[0] === "--") args = args.slice(1);
  const options: RefreshOptions = { source: "db/prices.db",
    forecastConfig: "docs/timesfm-research.json", dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prepare-only") continue; // Backward-compatible alias for the default.
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--source" || arg === "--forecast-config") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--source") options.source = value;
      else options.forecastConfig = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export type RunStep = (command: string, args: string[], capture?: boolean) => string;

function runStep(root: string): RunStep {
  return (command, args, capture = false) => {
    console.log(`> ${[command, ...args].map(value => JSON.stringify(value)).join(" ")}`);
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8",
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}); research not continued`);
    return result.stdout ?? "";
  };
}

/** Enables separate research features without changing dates, benchmark state or strategy logic. */
export function refreshResearch(root: string, options: RefreshOptions, run = runStep(root)): void {
  const configPath = resolve(root, "autoresearch.config.json");
  const original = readFileSync(configPath, "utf8");
  const raw = JSON.parse(original);
  const config = loadEvaluationConfig(configPath);
  const forecastPath = resolve(root, options.forecastConfig);
  const settings = JSON.parse(readFileSync(forecastPath, "utf8"));
  if (!["timesfm_ohlcv", "timesfm_close"].includes(settings.variant) || settings.horizon !== 10 ||
      "development" in settings || "holdout" in settings || "ranges" in settings) {
    throw new Error("Use research model settings, not benchmark dates; research ranges come from autoresearch.config.json and market.db");
  }
  const source = resolve(root, options.source);
  const market = resolve(root, config.dbPath);
  const cachePath = ".autoresearch/timesfm/research-forecasts.db";
  const cache = resolve(root, cachePath);
  const identities = [source, market, cache].map(path => existsSync(path) ? realpathSync(path) : path);
  if (new Set(identities).size !== 3) throw new Error("Source, market and forecast databases must be different files");
  if (!existsSync(source)) throw new Error(`Missing updated source database: ${source}`);
  console.log("Sync prices → generate/resume forecasts → validate campaign → export training data → baseline if missing (no agent loop)");
  const localConfig = { ...config, dbPath: market };
  if (options.dryRun) {
    if (existsSync(market)) console.log(JSON.stringify({ ranges: researchForecastRanges(localConfig), cache: cachePath }, null, 2));
    else console.log("Market database will be created by sync; ranges will then be derived from its dates.");
    console.log("Dry run: dates shown use existing market.db; actual preparation resolves dates again after sync.");
    return;
  }

  // Exclude other preparations; the separate loop must not run concurrently.
  const stateDir = resolve(root, ".autoresearch");
  const lock = resolve(stateDir, "refresh-research.lock");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(lock); // Exclusive; never steal another run's lock.
  try {
    run("uv", ["--version"]);
    run("pnpm", ["run", "market:sync-local", "--source", source, "--target", market]);
    const ranges = researchForecastRanges(localConfig);
    console.log(`Research: training ${ranges[0].start}..${ranges[0].end}; evaluation ${ranges[1].start}..${ranges.at(-1)!.end}`);
    const requestPath = resolve(lock, "research-request.json");
    writeFileSync(requestPath, JSON.stringify({ settings, symbols: config.symbols, ranges }), { flag: "wx" });
    const args = ["run", "--locked", "scripts/timesfm-research.py", "run",
      "--request", requestPath, "--db", market, "--cache", cache];
    const result = JSON.parse(run("uv", args, true));
    if (result.status !== "complete" || typeof result.campaign !== "string" || !result.campaign) {
      throw new Error("Forecast generation did not produce a complete campaign; config and loop left untouched");
    }
    const nextTimesfm = { dbPath: cachePath, model: settings.variant, campaign: result.campaign };
    const features = loadEvaluationFeatures({ ...localConfig,
      timesfm: { ...nextTimesfm, dbPath: cache } }, ranges);
    console.log(`Validated campaign ${result.campaign} for ${Object.keys(features!.forecasts).length} stocks`);
    if (readFileSync(configPath, "utf8") !== original) {
      throw new Error("Research config changed during forecast generation; refusing to overwrite it");
    }
    if (JSON.stringify(config.timesfm) !== JSON.stringify(nextTimesfm)) {
      const backup = resolve(stateDir, `autoresearch.config.before-refresh-${Date.now()}.json`);
      writeFileSync(backup, original, { flag: "wx" });
      raw.evaluation.timesfm = nextTimesfm;
      const pending = resolve(lock, "autoresearch.config.json");
      writeFileSync(pending, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" });
      renameSync(pending, configPath);
      console.log(`Enabled research forecast campaign; dates unchanged. Previous config saved to ${backup}`);
    }
    run("pnpm", ["run", "generate-training"]);
    if (!existsSync(resolve(stateDir, "best.json"))) run("pnpm", ["run", "ar", "--", "baseline"]);
    console.log("Preparation complete. No agent loop started. Run pnpm run research:loop when ready.");
  } finally {
    rmSync(resolve(lock, "autoresearch.config.json"), { force: true });
    rmSync(resolve(lock, "research-request.json"), { force: true });
    rmdirSync(lock);
  }
}

function main(): void {
  const options = parseRefreshArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm run research:refresh [--dry-run]
  [--source db/prices.db] [--forecast-config docs/timesfm-research.json]

After prices.db is updated: sync market.db, generate/resume the configured
past-only research forecasts for the existing training/rolling dates,
enable the completed campaign, export training CSVs,
and create a baseline only if missing. Never starts an agent loop.

Start research separately with: pnpm run research:loop

No manual forecast configuration is needed. Existing research dates are kept.
The benchmark database, configuration and holdout remain untouched.
Does not reset research or commit/push code.
--prepare-only is a compatibility alias for the default preparation behavior.
--dry-run validates setup without writes.
Run only while no other agent loop or market-data writer is active.
An interrupted hard-killed process may leave .autoresearch/refresh-research.lock;
verify it is no longer running before manually removing that empty lock directory.`);
    return;
  }
  refreshResearch(process.cwd(), options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
