#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvaluationConfig, loadEvaluationFeatures, researchForecastRanges } from "../research/trade-long/walkforward.js";

export interface RefreshOptions {
  forecastConfig: string;
  dryRun: boolean;
  help: boolean;
}

export function parseRefreshArgs(args: string[]): RefreshOptions {
  if (args[0] === "--") args = args.slice(1);
  const options: RefreshOptions = { forecastConfig: existsSync("timesfm-research.json") ? "timesfm-research.json" : "docs/timesfm-research.json", dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prepare-only") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--forecast-config") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options.forecastConfig = value;
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

function validateSettings(settings: any): void {
  if (!settings || !["timesfm_ohlcv", "timesfm_close"].includes(settings.variant) || settings.horizon !== 10 ||
      "development" in settings || "holdout" in settings || "ranges" in settings) {
    throw new Error("Use research model settings, not benchmark dates; research ranges come from autoresearch.config.json and the market database");
  }
  if (typeof settings.model !== "string" || !settings.model ||
      typeof settings.revision !== "string" || !/^[a-f0-9]{40}$/.test(settings.revision)) {
    throw new Error("Research settings require a model and a full pinned revision");
  }
  const inference = settings.inference;
  if (!inference || [settings.context, settings.stride, inference.batch_size, inference.threads]
    .some(value => !Number.isSafeInteger(value) || value < 1) || settings.context < 32 || settings.context > 15360 ||
    [inference.use_symmetric_averaging, inference.use_znorm, inference.sort_quantiles].some(value => typeof value !== "boolean")) {
    throw new Error("Invalid research context, stride or inference settings");
  }
}

/** Explicit optional preparation; the ordinary import and research loop need no model. */
export function refreshResearch(root: string, options: RefreshOptions, run = runStep(root)): void {
  const configPath = resolve(root, "autoresearch.config.json");
  const original = readFileSync(configPath, "utf8");
  const raw = JSON.parse(original);
  const config = loadEvaluationConfig(configPath);
  const settings = JSON.parse(readFileSync(resolve(root, options.forecastConfig), "utf8"));
  validateSettings(settings);
  const market = resolve(root, config.dbPath);
  const cachePath = ".autoresearch/timesfm/research-forecasts.db";
  const cache = resolve(root, cachePath);
  if (!existsSync(market)) throw new Error(`Missing market database: ${market}. Import your own prices with pnpm run market:import first.`);
  if (realpathSync(market) === (existsSync(cache) ? realpathSync(cache) : cache)) {
    throw new Error("Market and forecast databases must be different files");
  }
  const localConfig = { ...config, dbPath: market };
  const ranges = researchForecastRanges(localConfig);
  console.log("Generate/resume forecasts → validate campaign → export training data → baseline if missing (no agent loop)");
  if (options.dryRun) {
    console.log(JSON.stringify({ market, ranges, cache: cachePath, model: settings.model, revision: settings.revision }, null, 2));
    console.log("Dry run: no writes, model downloads or inference. Coverage is validated during preparation.");
    return;
  }

  const stateDir = resolve(root, ".autoresearch");
  const lock = resolve(stateDir, "refresh-research.lock");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(lock); // Exclusive; never steal another preparation's lock.
  try {
    run("uv", ["--version"]);
    const requestPath = resolve(lock, "research-request.json");
    writeFileSync(requestPath, JSON.stringify({ settings, symbols: config.symbols, ranges }), { flag: "wx" });
    const result = JSON.parse(run("uv", ["run", "--locked", "scripts/timesfm-research.py", "run",
      "--request", requestPath, "--db", market, "--cache", cache], true));
    if (result.status !== "complete" || typeof result.campaign !== "string" || !result.campaign) {
      throw new Error("Forecast generation did not produce a complete campaign; configuration left untouched");
    }
    const nextTimesfm = { dbPath: cachePath, model: settings.variant, campaign: result.campaign };
    const features = loadEvaluationFeatures({ ...localConfig, timesfm: { ...nextTimesfm, dbPath: cache } }, ranges);
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
      console.log(`Enabled local forecast campaign; dates unchanged. Previous config saved to ${backup}`);
    }
    run("pnpm", ["run", "generate-training"]);
    if (!existsSync(resolve(stateDir, "best.json"))) run("pnpm", ["run", "ar", "--", "baseline"]);
    console.log("Preparation complete. Run pnpm run research:loop when ready.");
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
  [--forecast-config docs/timesfm-research.json]

After market:import, explicitly enable optional TimesFM inputs using the
configured local market database and existing research dates. Generate/resume
historical forecasts, validate coverage, back up and select the local campaign,
export training CSVs, and baseline only if missing. Never starts an agent loop.

Requires uv and Python/model access for preparation only.
--dry-run validates setup and shows ranges without writes or model downloads.
--prepare-only is an alias for the default preparation behavior.
Run only while no other research loop or market-data writer is active.
After a hard interruption, verify the old process is gone before removing
the leftover .autoresearch/refresh-research.lock directory.
Does not reset research, change dates, commit or push code.
Start research separately with: pnpm run research:loop`);
    return;
  }
  refreshResearch(process.cwd(), options);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
