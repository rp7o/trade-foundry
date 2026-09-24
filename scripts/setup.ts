#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { engineRoot, initializeWorkspace, selectedWorkspace, syncWorkspace } from "./workspace.mjs";
import { foldRanges, loadEvaluationFeatures, MARKET_SYMBOLS, parseEvaluationConfig, resolvePortfolioSettings } from "../research/trade-long/walkforward.js";

// Keep unknown operator/hook settings intact when rerunning setup.
export type SetupConfig = Record<string, any>;
export interface SetupAnswers {
  mode?: "current" | "local" | "new-private";
  workspace?: string;
  exchange?: string;
  currency?: string;
  symbols?: string[];
  dbPath?: string;
  sourcePath?: string;
  indexSymbol?: string;
  volatilitySymbol?: string;
  initialCapital?: number;
  maxPositions?: number;
  minAvgTradedValue?: number;
  brokeragePerSide?: number;
  slippageBpsPerSide?: number;
  provider?: "pi" | "codex";
  model?: string;
  agentTimeoutSeconds?: number;
  evalTimeoutSeconds?: number;
  maxIterations?: number;
  timesfm?: boolean;
  baseline?: boolean;
}
export interface SetupReport { errors: string[]; warnings: string[]; coverage: string[] }

function numeric(value: unknown, name: string, minimum: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${minimum}`);
  }
  return value;
}
function symbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^_-]*$/.test(normalized)) throw new Error(`Invalid symbol: ${value}`);
  return normalized;
}
function insidePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("db/") || normalized.split("/").includes("..") || !normalized.endsWith(".db")) {
    throw new Error("Market database must be a .db file inside workspace db/ (for example db/market.db)");
  }
  return normalized;
}

export function buildSetupConfig(base: SetupConfig, answers: SetupAnswers): SetupConfig {
  const allowed = new Set(["mode", "workspace", "exchange", "currency", "symbols", "dbPath", "sourcePath", "indexSymbol", "volatilitySymbol", "initialCapital", "maxPositions", "minAvgTradedValue", "brokeragePerSide", "slippageBpsPerSide", "provider", "model", "agentTimeoutSeconds", "evalTimeoutSeconds", "maxIterations", "timesfm", "baseline"]);
  for (const key of Object.keys(answers)) if (!allowed.has(key)) throw new Error(`Unknown setup answer: ${key}`);
  if (answers.baseline !== undefined && typeof answers.baseline !== "boolean") throw new Error("baseline must be a boolean");
  const next = structuredClone(base);
  next.setup = { ...next.setup, exchange: answers.exchange ?? next.setup?.exchange ?? "ASX",
    currency: answers.currency ?? next.setup?.currency ?? "AUD" };
  if (typeof next.setup.exchange !== "string" || !next.setup.exchange.trim() || !/^[A-Z]{3}$/.test(next.setup.currency)) {
    throw new Error("Provide an exchange name and a three-letter uppercase currency code");
  }
  const changedMarket = answers.exchange !== undefined && answers.exchange !== (base.setup?.exchange ?? "ASX");
  const e = next.evaluation;
  e.symbols = [...new Set((answers.symbols ?? e.symbols).map(symbol))];
  if (!e.symbols.length) throw new Error("Select at least one stock symbol");
  if (changedMarket && !answers.symbols) throw new Error("A different exchange requires explicit stock symbols");
  e.dbPath = insidePath(answers.dbPath ?? e.dbPath);
  next.scope = { ...next.scope, frozen: [...new Set([
    ...(next.scope?.frozen ?? []).map((file: string) => file === base.evaluation.dbPath ? e.dbPath : file),
    e.dbPath, "timesfm-research.json",
  ])] };
  next.data = { ...next.data, sourcePath: answers.sourcePath ?? next.data?.sourcePath ?? "db/prices.db" };
  if (typeof next.data.sourcePath !== "string" || !next.data.sourcePath.trim()) throw new Error("Price source path is required");
  const market = changedMarket ? {} : (e.marketSymbols ?? MARKET_SYMBOLS);
  e.marketSymbols = { ...market };
  for (const [role, answer] of [["index", answers.indexSymbol], ["volatility", answers.volatilitySymbol]] as const) {
    if (answer === "") delete e.marketSymbols[role];
    else if (answer !== undefined) e.marketSymbols[role] = symbol(answer);
  }
  const previousPortfolio = resolvePortfolioSettings(e.portfolio);
  e.portfolio = resolvePortfolioSettings({
    initialCapital: answers.initialCapital ?? previousPortfolio.initialCapital,
    maxPositions: answers.maxPositions ?? previousPortfolio.maxPositions,
    minAvgTradedValue: answers.minAvgTradedValue ?? previousPortfolio.minAvgTradedValue,
  });
  next.executionCosts = { ...next.executionCosts,
    brokeragePerSide: numeric(answers.brokeragePerSide ?? next.executionCosts.brokeragePerSide, "Brokerage", 0),
    slippageBpsPerSide: numeric(answers.slippageBpsPerSide ?? next.executionCosts.slippageBpsPerSide, "Slippage", 0) };
  next.agent = { ...next.agent,
    provider: answers.provider ?? next.agent?.provider ?? "pi",
    model: answers.model ?? next.agent?.model ?? "",
    timeoutSeconds: numeric(answers.agentTimeoutSeconds ?? next.agent?.timeoutSeconds ?? 360, "Agent timeout", 1, true) };
  if (!["pi", "codex"].includes(next.agent.provider)) throw new Error("Agent provider must be pi or codex");
  if (typeof next.agent.model !== "string") throw new Error("Agent model must be a string");
  next.budget = { ...next.budget, timeoutSeconds: numeric(answers.evalTimeoutSeconds ?? next.budget.timeoutSeconds, "Evaluation timeout", 1, true) };
  next.loop = { ...next.loop, maxIterations: numeric(answers.maxIterations ?? next.loop.maxIterations, "Attempt budget (0 = unbounded)", 0, true) };
  if (answers.timesfm !== undefined && typeof answers.timesfm !== "boolean") throw new Error("timesfm must be a boolean");
  next.setup.timesfmRequested = answers.timesfm ?? (Boolean(next.setup.timesfmRequested) || Boolean(e.timesfm));
  if (!next.setup.timesfmRequested) delete e.timesfm;
  if (e.trainingEnd >= e.foldStart) throw new Error("Training and evaluation periods must not overlap");
  parseEvaluationConfig(next);
  // No date, risk-profile or acceptance-threshold tuning in onboarding.
  return next;
}

function scoringSettings(config: SetupConfig): string {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize({ evaluation: { ...config.evaluation,
    portfolio: resolvePortfolioSettings(config.evaluation.portfolio), marketSymbols: config.evaluation.marketSymbols ?? MARKET_SYMBOLS },
    executionCosts: config.executionCosts, acceptance: config.acceptance,
    exchange: config.setup?.exchange ?? "ASX", currency: config.setup?.currency ?? "AUD" }));
}
export function protectResearch(workspace: string, before: SetupConfig, after: SetupConfig): void {
  const active = [".autoresearch/best.json", ".autoresearch/trials.jsonl", ".autoresearch/trade-long/latest.json", "research/trade-long/hypotheses"]
    .some(file => existsSync(path.join(workspace, file)));
  if (active && scoringSettings(before) !== scoringSettings(after)) {
    throw new Error("This workspace already has research results. Use a new private workspace to change symbols, data, costs, portfolio assumptions or TimesFM. Existing results are preserved.");
  }
}
function executable(name: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some(dir => {
    try { accessSync(path.join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
}

export function inspectSetup(workspace: string, config: SetupConfig): SetupReport {
  const report: SetupReport = { errors: [], warnings: [], coverage: [] };
  for (const name of ["pnpm", "bash", config.agent?.provider ?? "pi"]) {
    if (!executable(name)) report.warnings.push(`${name} is not on PATH; install it before running the research loop.`);
  }
  if (config.agent?.command !== "bash scripts/run-agent.sh") report.warnings.push("Custom agent command preserved; provider/model fields apply only if that command reads them.");
  if (config.setup?.timesfmRequested && !executable("uv")) report.warnings.push("TimesFM preparation needs uv and Python/model access.");
  if (config.setup?.timesfmRequested && !config.evaluation.timesfm) report.warnings.push("TimesFM requested but inactive: run research:refresh explicitly after importing prices. No model is downloaded by setup.");
  const e = parseEvaluationConfig(config);
  const dbPath = path.resolve(workspace, e.dbPath);
  const sourcePath = path.resolve(workspace, config.data?.sourcePath ?? "db/prices.db");
  const canonical = (p: string) => existsSync(p) ? realpathSync(p) : p;
  if (canonical(dbPath) === canonical(sourcePath)) report.errors.push("Source prices and evaluation market database must be separate files.");
  if (!existsSync(sourcePath)) report.warnings.push(`No SQLite price source at ${sourcePath}; supply it or use market:import with an adjusted OHLCV CSV.`);
  if (!existsSync(dbPath)) {
    report.errors.push(`Missing market database: ${dbPath}. Import prices before baseline.`);
    return report;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = db.prepare("PRAGMA table_info(prices)").all().map(row => row.name);
    if (!["symbol", "date", "open", "high", "low", "close", "adj_close", "volume"].every(name => columns.includes(name))) {
      throw new Error("prices table must contain symbol, date, adjusted OHLCV columns");
    }
    const query = db.prepare("SELECT MIN(date) first, MAX(date) last, SUM(CASE WHEN date >= ? AND date <= ? THEN 1 ELSE 0 END) training FROM prices WHERE symbol = ?");
    const count = db.prepare("SELECT COUNT(*) n FROM prices WHERE symbol = ? AND date >= ? AND date <= ?");
    for (const stock of e.symbols) {
      const row = query.get(e.trainingStart ?? "0000-01-01", e.trainingEnd, stock)!;
      report.coverage.push(`${stock}: ${row.first ?? "missing"} → ${row.last ?? "missing"}; ${row.training ?? 0} training rows`);
      if (Number(row.training) < 500) report.errors.push(`${stock}: need at least 500 training rows through ${e.trainingEnd}.`);
      if (!row.last || String(row.last) < e.foldStart) report.errors.push(`${stock}: no evaluation data from ${e.foldStart}.`);
    }
    const latest = db.prepare("SELECT MAX(date) last FROM prices WHERE symbol IN (" + e.symbols.map(() => "?").join(",") + ")").get(...e.symbols)?.last;
    if (typeof latest === "string" && latest >= e.foldStart) {
      const ranges = foldRanges(e, latest);
      for (const range of ranges) {
        for (const stock of e.symbols) {
          const rows = Number(count.get(stock, range.start, range.end)?.n);
          const days = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
          if (!rows) report.errors.push(`${stock}: no data in ${range.name} (${range.start}–${range.end}).`);
          else if (rows < days * 0.4) report.warnings.push(`${stock}: sparse coverage in ${range.name} (${rows} rows); inspect gaps before research.`);
        }
      }
      report.coverage.push(`Evaluation: ${ranges[0].start} → ${ranges.at(-1)!.end}; ${ranges.length} anchored periods.`);
    }
    for (const [role, stock] of Object.entries(e.marketSymbols ?? MARKET_SYMBOLS)) {
      if (!db.prepare("SELECT 1 FROM prices WHERE symbol = ? LIMIT 1").get(stock)) report.warnings.push(`Optional ${role} context missing: ${stock}.`);
    }
    if (e.timesfm) loadEvaluationFeatures({ ...e, dbPath, timesfm: { ...e.timesfm, dbPath: path.resolve(workspace, e.timesfm.dbPath) } });
  } catch (error) { report.errors.push((error as Error).message); }
  finally { db?.close(); }
  return report;
}

export function saveSetup(workspace: string, config: SetupConfig, original: string | undefined): void {
  const target = path.join(workspace, "autoresearch.config.json");
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (current !== original) throw new Error("Configuration changed during setup; refusing to overwrite it.");
  if (current) protectResearch(workspace, JSON.parse(current), config);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized === current) return;
  if (current !== undefined) {
    const backups = path.join(workspace, ".autoresearch/setup");
    mkdirSync(backups, { recursive: true });
    writeFileSync(path.join(backups, `config-${Date.now()}-${process.pid}.json`), current, { flag: "wx" });
  }
  const pending = `${target}.setup-${process.pid}.tmp`;
  writeFileSync(pending, serialized, { flag: "wx" });
  renameSync(pending, target);
}

type Ask = (label: string, fallback: string) => Promise<string>;
async function questions(ask: Ask, base: SetupConfig): Promise<SetupAnswers> {
  const e = base.evaluation;
  const portfolio = resolvePortfolioSettings(e.portfolio);
  const exchange = await ask("Exchange (one local market per workspace)", base.setup?.exchange ?? "ASX");
  const marketChanged = exchange !== (base.setup?.exchange ?? "ASX");
  const currency = await ask("Portfolio currency (three-letter code; no FX conversion)", marketChanged ? "" : base.setup?.currency ?? "AUD");
  const symbols = (await ask("Stock symbols, comma-separated", marketChanged ? "" : e.symbols.join(","))).split(",");
  const market = marketChanged ? {} : e.marketSymbols ?? MARKET_SYMBOLS;
  const indexSymbol = await ask("Same-market index symbol (- for none)", market.index ?? "-");
  const volatilitySymbol = await ask("Same-market volatility symbol (- for none)", market.volatility ?? "-");
  return { exchange, currency: currency.toUpperCase(), symbols,
    indexSymbol: indexSymbol === "-" ? "" : indexSymbol,
    volatilitySymbol: volatilitySymbol === "-" ? "" : volatilitySymbol,
    dbPath: await ask("Evaluation database inside workspace db/", e.dbPath),
    sourcePath: await ask("SQLite price source (or planned source; CSV import is also supported)", base.data?.sourcePath ?? "db/prices.db"),
    initialCapital: Number(await ask(`Starting capital (${currency})`, String(portfolio.initialCapital))),
    maxPositions: Number(await ask("Maximum simultaneous positions", String(portfolio.maxPositions))),
    minAvgTradedValue: Number(await ask(`Minimum average daily traded value (${currency})`, String(portfolio.minAvgTradedValue))),
    brokeragePerSide: Number(await ask(`Brokerage per side (${currency})`, String(base.executionCosts.brokeragePerSide))),
    slippageBpsPerSide: Number(await ask("Slippage per side (basis points)", String(base.executionCosts.slippageBpsPerSide))),
    provider: await ask("Agent provider (pi/codex)", base.agent.provider ?? "pi") as SetupAnswers["provider"],
    model: await ask("Agent model (- for configured provider default)", base.agent.model || "-"),
    agentTimeoutSeconds: Number(await ask("Agent timeout (seconds)", String(base.agent.timeoutSeconds))),
    evalTimeoutSeconds: Number(await ask("Evaluator timeout (seconds)", String(base.budget.timeoutSeconds))),
    maxIterations: Number(await ask("Attempts per loop (0 = unbounded)", String(base.loop.maxIterations))),
    timesfm: await yesNo(ask, "Request optional TimesFM preparation? No downloads now", Boolean(base.setup?.timesfmRequested ?? e.timesfm)),
    baseline: await yesNo(ask, "Generate training CSVs and baseline if data is ready? Existing baseline is preserved", false),
  };
}
async function yesNo(ask: Ask, label: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(`${label} (yes/no)`, fallback ? "yes" : "no")).toLowerCase();
  if (!["yes", "y", "no", "n"].includes(answer)) throw new Error("Answer yes or no");
  return ["yes", "y"].includes(answer);
}
function printReport(report: SetupReport) {
  for (const line of report.coverage) console.log(`  ${line}`);
  for (const line of report.warnings) console.log(`NOTE: ${line}`);
  for (const line of report.errors) console.log(`NOT READY: ${line}`);
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.includes("--help")) {
    console.log("Usage: pnpm run setup [--dry-run] [--answers answers.json --yes] [--no-select] | --check\nInteractive, reviewed local configuration. Never starts an agent loop, downloads models, resets results or pushes Git.\nExisting research requires a fresh workspace for changed evaluation assumptions.");
    return;
  }
  const flags = new Set(["--dry-run", "--yes", "--check", "--answers", "--no-select"]);
  for (let i = 0; i < args.length; i++) {
    if (!flags.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (args[i] === "--answers" && (!args[++i] || args[i].startsWith("--"))) throw new Error("--answers requires a JSON file");
  }
  const selected = selectedWorkspace();
  if (args.includes("--check")) {
    const config = buildSetupConfig(JSON.parse(readFileSync(path.join(selected, "autoresearch.config.json"), "utf8")), {});
    const report = inspectSetup(selected, config);
    console.log(`Workspace: ${selected}`); printReport(report);
    process.exitCode = report.errors.length ? 1 : 0;
    return;
  }
  const answersIndex = args.indexOf("--answers");
  if (answersIndex < 0 && !process.stdin.isTTY) throw new Error("Interactive setup needs a terminal; use --answers <json> with --dry-run or --yes.");
  const rl = answersIndex < 0 ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask: Ask = async (label, fallback) => (await rl!.question(`${label} [${fallback}]: `)).trim() || fallback;
  try {
    const input: SetupAnswers = answersIndex >= 0 ? JSON.parse(readFileSync(args[answersIndex + 1], "utf8")) : {};
    input.mode ??= rl ? await ask("Workspace (current/local/new-private)", "current") as SetupAnswers["mode"] : "current";
    if (!input.mode || !["current", "local", "new-private"].includes(input.mode)) throw new Error("Invalid workspace mode");
    if (input.mode === "new-private") input.workspace ??= rl ? await ask("New private repo directory", "../my-research") : undefined;
    if (input.mode === "new-private" && !input.workspace) throw new Error("new-private requires workspace");
    const workspace = input.mode === "new-private" ? path.resolve(engineRoot, input.workspace!) : input.mode === "local" ? engineRoot : selected;
    if (input.mode === "new-private" && (existsSync(workspace) || workspace.startsWith(`${engineRoot}${path.sep}`))) throw new Error("Choose a new private directory outside the engine checkout");
    const target = path.join(workspace, "autoresearch.config.json");
    const original = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const base = JSON.parse(original ?? readFileSync(path.join(engineRoot, "autoresearch.example.json"), "utf8"));
    const answers = rl ? { ...input, ...await questions(ask, base) } : input;
    if (answers.model === "-") answers.model = "";
    const config = buildSetupConfig(base, answers);
    protectResearch(workspace, base, config);
    console.log(`\nWorkspace: ${workspace}\nProposed settings (unlisted settings are preserved):`);
    console.log(JSON.stringify({ setup: config.setup, data: config.data, evaluation: config.evaluation, executionCosts: config.executionCosts,
      agent: { provider: config.agent.provider, model: config.agent.model || "provider default", timeoutSeconds: config.agent.timeoutSeconds },
      budget: config.budget, loop: config.loop }, null, 2));
    console.log("Evaluation dates, risk profiles and stability requirements are preserved. Setup never optimizes thresholds against returns.");
    const report = inspectSetup(workspace, config); printReport(report);
    if (report.errors.some(error => error.startsWith("Source prices and evaluation"))) throw new Error("Choose separate source and evaluation database paths before saving.");
    if (args.includes("--dry-run")) { console.log("Dry run: no files or workspace selection changed."); return; }
    if (!args.includes("--yes") && (!rl || !await yesNo(ask, "Save these settings and select this workspace?", false))) { console.log("No changes saved."); return; }
    if (input.mode === "new-private") initializeWorkspace(workspace);
    else if (workspace !== engineRoot) syncWorkspace(workspace);
    else {
      const result = spawnSync(process.execPath, [path.join(engineRoot, "scripts/init-local.mjs")], { cwd: engineRoot, stdio: "inherit" });
      if (result.status !== 0) throw new Error("Local initialization failed");
    }
    // New workspaces now have their own neutral config; existing ones must not have changed during review.
    saveSetup(workspace, config, original ?? readFileSync(target, "utf8"));
    if (!args.includes("--no-select")) writeFileSync(path.join(engineRoot, ".trade-foundry-workspace"), `${workspace}\n`);
    console.log("Saved configuration; previous config backed up under .autoresearch/setup/. Strategies and research history preserved.");
    if (process.env.TRADE_FOUNDRY_WORKSPACE && path.resolve(engineRoot, process.env.TRADE_FOUNDRY_WORKSPACE) !== workspace) console.log("NOTE: unset TRADE_FOUNDRY_WORKSPACE to use the saved selection in subsequent commands.");
    if (answers.baseline && !report.errors.length) {
      const best = path.join(workspace, ".autoresearch/best.json");
      if (existsSync(best)) console.log("Existing baseline preserved; no baseline run.");
      else if (config.setup.timesfmRequested && !config.evaluation.timesfm) console.log("Prepare requested forecasts first: pnpm run research:refresh (explicit model download/inference).");
      else {
        for (const command of [["strategy:check"], ["strategy:contract"], ["generate-training"], ["ar", "--", "baseline"]]) {
          const result = spawnSync("pnpm", ["run", ...command], { cwd: engineRoot, stdio: "inherit", env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace } });
          if (result.status !== 0) throw new Error(`Setup saved; ${command[0]} failed. Fix the reported issue and retry; no research reset.`);
        }
        console.log("Baseline complete. A neutral starter produces score 0; that is expected.");
      }
    } else if (answers.baseline) console.log("Baseline skipped until the data issues above are resolved.");
    console.log("Next: import/sync prices if needed, then pnpm run setup --check.");
    if (!existsSync(path.join(workspace, ".autoresearch/best.json"))) {
      console.log(config.setup.timesfmRequested
        ? "Before the loop, prepare forecasts/training and baseline with: pnpm run research:refresh"
        : "Before the loop, run: pnpm run generate-training && pnpm run ar -- baseline");
    }
    console.log("Start research separately with pnpm run research:loop.");
  } finally { rl?.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
