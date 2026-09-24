import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadTimesfmFeatures, validateTimesfmConfig, type TimesfmConfig } from "../../scripts/timesfm-features.js";
import type { TimesfmForecasts } from "../engine/timesfm-context.mjs";
import type { Candle } from "./strategy.js";
import { runPortfolioBacktestInWorker, SCHEMA_VERSION } from "../engine/index.mjs";
import type { PortfolioBacktestResult } from "../engine/index.mjs";
import { openMarketDatabase, queryPrices } from "../../scripts/market-db.js";
import {
  calculateProfileScore,
  combineProfileScores,
  SCORE_PROFILES,
  type CombinedScore,
  type ProfileScore,
  type ScoreProfile,
} from "./score-model.js";
import { MIN_TOTAL_TRADES } from "./falsification.js";

export { MIN_TOTAL_TRADES };

// ─── Evaluation configuration ────────────────────────────────────────────────
// Window shape and execution costs live in autoresearch.config.json. The
// evaluation starts at foldStart and extends to the latest loaded market date.

export interface ExecutionCosts {
  brokeragePerSide: number;
  slippageBpsPerSide: number;
}

export interface EvaluationConfig {
  trainingStart?: string;
  evaluationEnd?: string;
  timesfm?: TimesfmConfig;
  dbPath: string;
  symbols: string[];
  trainingEnd: string;
  foldStart: string;
  foldMonths: number;
  foldCount: number;
  rollingYears: number;
  executionCosts: ExecutionCosts;
}

export const LOOKBACK_DAYS = 90;
export const INITIAL_CAPITAL = 10_000;
// 2% risk per trade. With 2 concurrent positions this lifts risk-sized exposure
// from ~40% to ~66-100% of capital (stop-width dependent), so the book can be
// meaningfully invested in favourable regimes while staying below the
// ~50%/position capital cap for normal stops and holding portfolio heat to a
// defensible 4%.
export const RISK_FRACTION = 0.02;
export const MAX_POSITIONS = 2;
export const HURDLE_RATE = 5.0;
export const MIN_POSITIVE_FOLD_RATE = 0.6;
export const MAX_FOLD_DRAWDOWN_PCT = 30;
// Liquidity floor passed to the shared engine (A$ average daily traded value).
export const MIN_AVG_TRADED_VALUE = 2_000_000;
// Market-context series provided to strategies as an optional second argument.
// Local-market context only, keyed by generic role so strategy logic stays
// portable across exchanges. No foreign lead market (e.g. an overnight US
// index): that is a region-specific artifact that does not transfer.
export const MARKET_SYMBOLS: Record<string, string> = {
  index: "^AXJO",
  volatility: "^AXVI",
};
// Plateau robustness: replicas of the fold backtests on perturbed data.
export const PLATEAU_REPLICAS = 2;
export const PLATEAU_NOISE = 0.002; // ±0.2% daily level shift
// Concurrency for shared-engine invocations.
const ENGINE_CONCURRENCY = 7;

const SHARED_SCHEMA_VERSION = SCHEMA_VERSION;
const STRATEGY_PATH = "research/trade-long/strategy.ts";
const WINDOWED_STRATEGY_PATH = ".autoresearch/trade-long/windowed-strategy.ts";
const MARKET_CONTEXT_PATH = ".autoresearch/trade-long/market-context.json";

export function loadEvaluationConfig(configPath = "autoresearch.config.json"): EvaluationConfig {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    evaluation?: Partial<EvaluationConfig>;
    executionCosts?: Partial<ExecutionCosts>;
  };
  const evaluation = raw.evaluation;
  if (!evaluation) throw new Error("autoresearch.config.json must define evaluation");
  if (evaluation.evaluationEnd !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(evaluation.evaluationEnd)) {
    throw new Error("evaluationEnd must be YYYY-MM-DD");
  }
  if (evaluation.timesfm) {
    validateTimesfmConfig(evaluation.timesfm);
  }
  if (evaluation.trainingStart !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(evaluation.trainingStart) || evaluation.trainingStart > evaluation.trainingEnd!)) {
    throw new Error("trainingStart must be YYYY-MM-DD and no later than trainingEnd");
  }
  const {
    dbPath, symbols, trainingEnd, foldStart, foldMonths, foldCount, rollingYears,
  } = evaluation;
  if (typeof dbPath !== "string" || !dbPath) throw new Error("evaluation.dbPath is required");
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("evaluation.symbols must be a non-empty array");
  }
  for (const field of [trainingEnd, foldStart]) {
    if (typeof field !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(field)) {
      throw new Error("evaluation dates must be YYYY-MM-DD strings");
    }
  }
  if (!Number.isInteger(foldMonths) || (foldMonths as number) <= 0) {
    throw new Error("evaluation.foldMonths must be a positive integer");
  }
  if (!Number.isInteger(foldCount) || (foldCount as number) <= 0) {
    throw new Error("evaluation.foldCount must be a positive integer");
  }
  if (!Number.isInteger(rollingYears) || (rollingYears as number) <= 0) {
    throw new Error("evaluation.rollingYears must be a positive integer");
  }
  const brokeragePerSide = raw.executionCosts?.brokeragePerSide;
  const slippageBpsPerSide = raw.executionCosts?.slippageBpsPerSide;
  if (
    typeof brokeragePerSide !== "number" || !Number.isFinite(brokeragePerSide) || brokeragePerSide < 0 ||
    typeof slippageBpsPerSide !== "number" || !Number.isFinite(slippageBpsPerSide) || slippageBpsPerSide < 0
  ) {
    throw new Error("executionCosts must define non-negative brokeragePerSide and slippageBpsPerSide");
  }
  return {
    trainingStart: evaluation.trainingStart,
    evaluationEnd: evaluation.evaluationEnd,
    timesfm: evaluation.timesfm,
    dbPath,
    symbols: symbols as string[],
    trainingEnd: trainingEnd as string,
    foldStart: foldStart as string,
    foldMonths: foldMonths as number,
    foldCount: foldCount as number,
    rollingYears: rollingYears as number,
    executionCosts: { brokeragePerSide, slippageBpsPerSide },
  };
}

// ─── Splits ──────────────────────────────────────────────────────────────────

export interface DateRange {
  name: string;
  start: string;
  end: string;
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const total = (year * 12 + (month - 1)) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function foldRanges(config: EvaluationConfig, latestDate?: string): DateRange[] {
  if (config.evaluationEnd) {
    const ranges = foldRanges({ ...config, evaluationEnd: undefined }, config.evaluationEnd);
    if (ranges.length !== config.foldCount || ranges.at(-1)?.end !== config.evaluationEnd ||
        config.trainingEnd >= ranges[0].start) {
      throw new Error("Fixed evaluation folds must follow training and end exactly at evaluationEnd");
    }
    return ranges;
  }
  if (latestDate) {
    if (config.trainingEnd >= config.foldStart || latestDate < config.foldStart) {
      throw new Error("Evaluation folds must follow training and start no later than the latest data");
    }
    const ranges: DateRange[] = [];
    for (let start = config.foldStart; start <= latestDate; start = addMonths(start, config.foldMonths)) {
      const nextStart = addMonths(start, config.foldMonths);
      ranges.push({ name: `fold-${ranges.length + 1}`, start,
        end: nextStart <= latestDate ? previousDay(nextStart) : latestDate });
    }
    return ranges;
  }

  const folds: DateRange[] = [];
  for (let i = 0; i < config.foldCount; i++) {
    const start = addMonths(config.foldStart, i * config.foldMonths);
    const end = previousDay(addMonths(config.foldStart, (i + 1) * config.foldMonths));
    folds.push({ name: `fold-${i + 1}`, start, end });
  }
  return folds;
}

// ─── Data loading ────────────────────────────────────────────────────────────

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number;
  volume: number;
}

function adjustCandles(raw: RawCandle[]): Candle[] {
  return raw.map(r => {
    const factor = r.close !== 0 ? r.adj_close / r.close : 1;
    return {
      date: r.date,
      open: r.open * factor,
      high: r.high * factor,
      low: r.low * factor,
      close: r.adj_close,
      volume: r.volume,
    };
  });
}

function querySymbols(dbPath: string, symbols: string[]): Record<string, RawCandle[]> {
  const db = openMarketDatabase(dbPath);
  try {
    return queryPrices(db, symbols) as Record<string, RawCandle[]>;
  } finally {
    db.close();
  }
}

export function loadAllCandles(config: EvaluationConfig): Record<string, Candle[]> {
  const raw = querySymbols(config.dbPath, config.symbols);
  const result: Record<string, Candle[]> = {};
  for (const symbol of config.symbols) {
    const rows = (raw[symbol] ?? []).filter(row => !config.evaluationEnd || row.date <= config.evaluationEnd);
    if (rows.length < LOOKBACK_DAYS) {
      throw new Error(`not enough ${symbol} rows for ${LOOKBACK_DAYS}-day strategy window: ${rows.length}`);
    }
    result[symbol] = adjustCandles(rows);
  }
  return result;
}

// Market-context series keyed by logical name (index/volatility). Missing
// series are simply omitted so evaluation still works if a symbol has no data.
export function loadMarketCandles(config: EvaluationConfig): Record<string, Candle[]> {
  const raw = querySymbols(config.dbPath, Object.values(MARKET_SYMBOLS));
  const context: Record<string, Candle[]> = {};
  for (const name of Object.keys(MARKET_SYMBOLS)) {
    const rows = raw[MARKET_SYMBOLS[name]] ?? [];
    if (rows.length >= LOOKBACK_DAYS) {
      context[name] = adjustCandles(rows);
    }
  }
  return context;
}

export function writeMarketContext(config: EvaluationConfig): string[] {
  const context = loadMarketCandles(config);
  mkdirSync(".autoresearch/trade-long", { recursive: true });
  writeFileSync(MARKET_CONTEXT_PATH, JSON.stringify(context));
  return Object.keys(context);
}

export function dataEndDate(allCandles: Record<string, Candle[]>): string {
  let end = "";
  for (const candles of Object.values(allCandles)) {
    const last = candles[candles.length - 1]?.date ?? "";
    if (last > end) end = last;
  }
  return end;
}

// ─── Deterministic data perturbation (plateau robustness) ────────────────────
// Applies a small per-day multiplicative level shift to every candle. A
// strategy tuned to knife-edge thresholds on exact prices degrades under this
// noise; a genuine edge does not.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function perturbCandles(
  allCandles: Record<string, Candle[]>,
  seed: number,
  amplitude: number = PLATEAU_NOISE,
): Record<string, Candle[]> {
  const perturbed: Record<string, Candle[]> = {};
  const symbols = Object.keys(allCandles).sort();
  for (let s = 0; s < symbols.length; s++) {
    const symbol = symbols[s];
    const rand = mulberry32(seed * 100_003 + s * 1009 + 17);
    perturbed[symbol] = allCandles[symbol].map((candle) => {
      const factor = 1 + (rand() * 2 - 1) * amplitude;
      return {
        date: candle.date,
        open: candle.open * factor,
        high: candle.high * factor,
        low: candle.low * factor,
        close: candle.close * factor,
        volume: candle.volume,
      };
    });
  }
  return perturbed;
}

// ─── Windowed backtest via the shared engine ─────────────────────────────────

// The engine's own declaration is the contract; do not restate its shape here.
type SharedPortfolioResult = PortfolioBacktestResult;

export interface WindowTrade {
  symbol: string;
  setup: string;
  regime: string;
  strategyVersion: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entry: number;
  exitPrice: number;
  stopLoss: number;
  target: number;
  shares: number;
  profit: number;
  brokerage: number;
  slippage: number;
  reason: string;
}

export interface WindowProfileResult {
  raw: SharedPortfolioResult;
  trades: WindowTrade[];
  capitalSeries: Array<{ date: string; capital: number }>;
}

export interface WindowResult {
  range: DateRange;
  combined: CombinedScore;
  profileScores: Record<ScoreProfile, ProfileScore>;
  profileResults: Record<ScoreProfile, WindowProfileResult>;
  windowDates: string[];
}

// The windowed wrapper trims history to the strategy lookback and attaches the
// market-context series (sliced with no lookahead) as an optional second
// strategy argument.
function ensureWindowedStrategy(): void {
  mkdirSync(".autoresearch/trade-long", { recursive: true });
  writeFileSync(
    WINDOWED_STRATEGY_PATH,
    [
      `import { readFileSync } from "node:fs";`,
      `import { proposeTrade as baseProposeTrade } from "../../${STRATEGY_PATH}";`,
      `export { STRATEGY_BOILERPLATE } from "../../${STRATEGY_PATH}";`,
      "let marketContext = {};",
      "try {",
      `  marketContext = JSON.parse(readFileSync(${JSON.stringify(MARKET_CONTEXT_PATH)}, "utf8"));`,
      "} catch {}",
      "const marketNames = Object.keys(marketContext);",
      "// Local index/volatility bars for date d are known at the local close of",
      "// d, so no series is lagged. (A foreign lead market would need lagging,",
      "// but none are provided — the strategy must stay portable.)",
      "const LAGGED = {};",
      "function marketAsOf(lastDate) {",
      "  const market = {};",
      "  for (const name of marketNames) {",
      "    const series = marketContext[name];",
      "    const usable = LAGGED[name]",
      "      ? (date) => date < lastDate",
      "      : (date) => date <= lastDate;",
      "    let hi = series.length;",
      "    let lo = 0;",
      "    while (lo < hi) {",
      "      const mid = (lo + hi) >> 1;",
      "      if (usable(series[mid].date)) lo = mid + 1; else hi = mid;",
      "    }",
      `    market[name] = series.slice(Math.max(0, lo - ${LOOKBACK_DAYS}), lo);`,
      "  }",
      "  return market;",
      "}",
      "export function proposeTrade(history, suppliedMarket) {",
      `  const trimmed = history.slice(-${LOOKBACK_DAYS});`,
      "  const lastDate = trimmed[trimmed.length - 1]?.date ?? \"\";",
      "  return baseProposeTrade(trimmed, { ...suppliedMarket, ...marketAsOf(lastDate) });",
      "}",
      "",
    ].join("\n"),
  );
}

export interface BacktestFeatures {
  timesfm?: TimesfmForecasts;
}

export function trainingForecastRange(config: EvaluationConfig): DateRange {
  if (config.trainingStart) return { name: "training", start: config.trainingStart, end: config.trainingEnd };
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const query = db.prepare("SELECT MIN(date) AS first FROM prices WHERE symbol = ? AND date <= ?");
    const starts = config.symbols.map(symbol => {
      const first = query.get(symbol, config.trainingEnd)?.first;
      if (typeof first !== "string") throw new Error(`No training data for ${symbol}`);
      return first;
    });
    return { name: "training", start: starts.sort()[0], end: config.trainingEnd };
  } finally { db.close(); }
}

/** Uses the same latest configured-symbol date and fold calculation as evaluation. */
export function researchForecastRanges(config: EvaluationConfig): DateRange[] {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  let latest: string;
  try {
    const query = db.prepare("SELECT MAX(date) AS last FROM prices WHERE symbol = ? AND date <= ?");
    latest = config.symbols.map(symbol => {
      const last = query.get(symbol, config.evaluationEnd ?? "9999-12-31")?.last;
      if (typeof last !== "string") throw new Error(`No evaluation data for ${symbol}`);
      return last;
    }).sort().at(-1)!;
  } finally { db.close(); }
  const training = trainingForecastRange(config);
  const folds = foldRanges(config, latest);
  if (training.end >= folds[0].start) throw new Error("Forecast training and evaluation ranges must not overlap");
  return [training, ...folds];
}

export function loadEvaluationFeatures(config: EvaluationConfig, ranges?: DateRange[]) {
  if (!config.timesfm) return undefined;
  return loadTimesfmFeatures(config.timesfm, config.symbols, ranges ?? researchForecastRanges(config));
}

function sliceWindow(
  allCandles: Record<string, Candle[]>,
  range: DateRange,
): Record<string, Candle[]> {
  const sliced: Record<string, Candle[]> = {};
  for (const [symbol, candles] of Object.entries(allCandles)) {
    let startIdx = candles.findIndex((candle) => candle.date >= range.start);
    if (startIdx === -1) continue;
    let endIdx = candles.length - 1;
    while (endIdx >= 0 && candles[endIdx].date > range.end) endIdx--;
    if (endIdx < startIdx) continue;
    // Provide exactly the strategy lookback as warmup so the engine's first
    // eligible proposal lands on the window's first trading day.
    const warmupStart = Math.max(0, startIdx - LOOKBACK_DAYS);
    sliced[symbol] = candles.slice(warmupStart, endIdx + 1);
  }
  return sliced;
}

async function runSharedBacktests(
  windowCandles: Record<string, Candle[]>,
  profiles: ScoreProfile[],
  costs: ExecutionCosts,
  features: BacktestFeatures = {},
): Promise<WindowProfileResult[]> {
  const payload = {
    timesfm_forecasts: features.timesfm,
    symbols: windowCandles,
    initial_capital: INITIAL_CAPITAL,
    risk_per_trade: RISK_FRACTION,
    max_positions: MAX_POSITIONS,
    min_avg_traded_value: MIN_AVG_TRADED_VALUE,
    strategy_lookback_days: LOOKBACK_DAYS,
    cache_strategy_proposals: true,
    hurdle_rate: HURDLE_RATE,
    execution_costs: {
      brokerage_per_side: costs.brokeragePerSide,
      slippage_bps_per_side: costs.slippageBpsPerSide,
    },
  };

  const results = await runPortfolioBacktestInWorker(payload, {
    engineRoot: ".",
    side: "long",
    strategyPath: WINDOWED_STRATEGY_PATH,
    profiles,
  });
  return results.map((result) => normalizeBacktestResult(result));
}

function normalizeBacktestResult(result: import("../engine/index.mjs").PortfolioBacktestResult): WindowProfileResult {
  if (result.schemaVersion !== SHARED_SCHEMA_VERSION) {
    throw new Error(
      `shared portfolio runner returned schema ${String(result.schemaVersion)}; expected ${SHARED_SCHEMA_VERSION}`
    );
  }
  return {
    raw: result,
    capitalSeries: result.capitalSeries.map((point) => ({
      date: String(point.date),
      capital: Number(point.capital),
    })),
    trades: result.trades.map((trade) => ({
      symbol: String(trade.symbol),
      setup: String(trade.setup || "shared-engine"),
      regime: String(trade.regime || trade.reason || "shared-engine"),
      strategyVersion: String(trade.strategyVersion || "shared-engine"),
      signalDate: String(trade.signalDate),
      entryDate: String(trade.entryDate),
      exitDate: String(trade.exitDate),
      entry: Number(trade.entryPrice),
      exitPrice: Number(trade.exitPrice),
      stopLoss: Number(trade.stopLoss),
      target: Number(trade.target),
      shares: Number(trade.qty),
      profit: Number(trade.pnl),
      brokerage: Number(trade.brokerage),
      slippage: Number(trade.slippage),
      reason: String(trade.reason),
    })),
  };
}

// Simple concurrency limiter for engine invocations.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function windowDatesFor(windowCandles: Record<string, Candle[]>, range: DateRange): string[] {
  const set = new Set<string>();
  for (const candles of Object.values(windowCandles)) {
    for (const candle of candles) {
      if (candle.date >= range.start) set.add(candle.date);
    }
  }
  return [...set].sort();
}

function scoreProfileWindow(
  profile: ScoreProfile,
  result: WindowProfileResult,
  range: DateRange,
  windowDates: string[],
): ProfileScore {
  // Warmup days precede the window; score only the in-window equity path.
  const capitalSeries = result.capitalSeries.filter((point) => point.date >= range.start);
  return calculateProfileScore({
    profile,
    initialCapital: INITIAL_CAPITAL,
    trades: result.trades,
    capitalSeries,
    allDates: windowDates,
    ruinProbability: result.raw.ruinProbability,
    confidenceDrawdown: result.raw.confidenceDrawdown,
  });
}

export async function runWindow(
  allCandles: Record<string, Candle[]>,
  range: DateRange,
  costs: ExecutionCosts,
  features: BacktestFeatures = {},
): Promise<WindowResult> {
  ensureWindowedStrategy();
  const windowCandles = sliceWindow(allCandles, range);
  if (Object.keys(windowCandles).length === 0) {
    throw new Error(`no symbol data inside window ${range.name} (${range.start}..${range.end})`);
  }
  const windowDates = windowDatesFor(windowCandles, range);

  const results = await runSharedBacktests(windowCandles, SCORE_PROFILES, costs, features);
  const profileResults = Object.fromEntries(
    SCORE_PROFILES.map((profile, i) => [profile, results[i]])
  ) as Record<ScoreProfile, WindowProfileResult>;

  const profileScores = Object.fromEntries(
    SCORE_PROFILES.map((profile) => [
      profile,
      scoreProfileWindow(profile, profileResults[profile], range, windowDates),
    ])
  ) as Record<ScoreProfile, ProfileScore>;

  return {
    range,
    combined: combineProfileScores(profileScores),
    profileScores,
    profileResults,
    windowDates,
  };
}

export async function runWindows(
  allCandles: Record<string, Candle[]>,
  ranges: DateRange[],
  costs: ExecutionCosts,
  features: BacktestFeatures = {},
): Promise<WindowResult[]> {
  ensureWindowedStrategy();
  const tasks = ranges.map((range) => {
    const windowCandles = sliceWindow(allCandles, range);
    if (Object.keys(windowCandles).length === 0) {
      throw new Error(`no symbol data inside window ${range.name} (${range.start}..${range.end})`);
    }
    return { range, windowCandles };
  });
  const results = await mapLimit(
    tasks,
    ENGINE_CONCURRENCY,
    (task) => runSharedBacktests(task.windowCandles, SCORE_PROFILES, costs, features),
  );

  return ranges.map((range, r) => {
    const windowCandles = sliceWindow(allCandles, range);
    const windowDates = windowDatesFor(windowCandles, range);
    const profileResults = Object.fromEntries(
      SCORE_PROFILES.map((profile, p) => [profile, results[r][p]])
    ) as Record<ScoreProfile, WindowProfileResult>;
    const profileScores = Object.fromEntries(
      SCORE_PROFILES.map((profile) => [
        profile,
        scoreProfileWindow(profile, profileResults[profile], range, windowDates),
      ])
    ) as Record<ScoreProfile, ProfileScore>;
    return {
      range,
      combined: combineProfileScores(profileScores),
      profileScores,
      profileResults,
      windowDates,
    };
  });
}

// Moderate-profile-only fold runs for plateau replicas (cheaper than a full
// three-profile sweep; the factor compares moderate medians only).
export async function runModerateFoldScores(
  allCandles: Record<string, Candle[]>,
  ranges: DateRange[],
  costs: ExecutionCosts,
  features: BacktestFeatures = {},
): Promise<number[]> {
  ensureWindowedStrategy();
  const tasks = ranges.map((range) => ({ range, windowCandles: sliceWindow(allCandles, range) }));
  const results = await mapLimit(
    tasks,
    ENGINE_CONCURRENCY,
    (task) => runSharedBacktests(task.windowCandles, ["moderate"], costs, features),
  );
  return tasks.map((task, i) =>
    scoreProfileWindow("moderate", results[i][0], task.range, windowDatesFor(task.windowCandles, task.range)).score
  );
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Fold aggregation ────────────────────────────────────────────────────────

export interface PositiveFoldReturnGate {
  passed: boolean;
  positiveFolds: number;
  totalFolds: number;
  positiveFoldRate: number;
  minimumPositiveFolds: number;
}

export function assessPositiveFoldReturnGate(foldReturns: number[]): PositiveFoldReturnGate {
  const positiveFolds = foldReturns.filter((value) => value > 0).length;
  const totalFolds = foldReturns.length;
  const minimumPositiveFolds = Math.ceil(totalFolds * MIN_POSITIVE_FOLD_RATE);
  return {
    passed: totalFolds > 0 && positiveFolds >= minimumPositiveFolds,
    positiveFolds,
    totalFolds,
    positiveFoldRate: totalFolds > 0 ? positiveFolds / totalFolds : 0,
    minimumPositiveFolds,
  };
}

// A promotable verdict needs enough trades to mean something: below the
// evidence floor the fold statistics are dominated by single trades, and an
// An inactive year may be a prudent choice for a long-only strategy.
// Threshold shared with the falsification audit (see falsification.ts).
export interface SampleAdequacyGate {
  passed: boolean;
  totalTrades: number;
  minTotalTrades: number;
  emptyFolds: number;
}

export function assessSampleAdequacyGate(foldTradeCounts: number[]): SampleAdequacyGate {
  const totalTrades = foldTradeCounts.reduce((sum, count) => sum + count, 0);
  const emptyFolds = foldTradeCounts.filter((count) => count === 0).length;
  return {
    passed: totalTrades >= MIN_TOTAL_TRADES &&
      foldTradeCounts.length > 0 &&
      foldTradeCounts.length - emptyFolds >= Math.ceil(foldTradeCounts.length / 2),
    totalTrades,
    minTotalTrades: MIN_TOTAL_TRADES,
    emptyFolds,
  };
}

export interface MaximumDrawdownGate {
  passed: boolean;
  maxDrawdownPct: number;
}

export function assessMaximumDrawdownGate(drawdowns: number[]): MaximumDrawdownGate {
  const maxDrawdownPct = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
  return {
    passed: maxDrawdownPct <= MAX_FOLD_DRAWDOWN_PCT,
    maxDrawdownPct,
  };
}

export interface WalkForwardAggregate {
  score: number;
  medianFoldScore: number;
  losingFolds: number;
  foldScores: number[];
  foldReturns: number[];
  positiveFolds: number;
  positiveFoldRate: number;
  minimumPositiveFolds: number;
  maxFoldDrawdownPct: number;
  gateFailures: string[];
}

export function aggregateFolds(folds: WindowResult[]): WalkForwardAggregate {
  const foldScores = folds.map((fold) => fold.combined.score);
  const medianFoldScore = median(foldScores);
  const foldReturns = folds.map((fold) => fold.profileScores.moderate.earnedProfit);
  const positiveFoldGate = assessPositiveFoldReturnGate(foldReturns);
  const drawdownGate = assessMaximumDrawdownGate(
    folds.map((fold) => fold.profileScores.moderate.maxDrawdownPct)
  );
  // A losing fold is strictly negative and retained as a diagnostic only.
  const losingFolds = foldScores.filter((score) => score < 0).length;

  const gateFailures: string[] = [];
  if (!positiveFoldGate.passed) gateFailures.push("minimum-positive-return-folds");
  if (!drawdownGate.passed) gateFailures.push("maximum-drawdown");

  // The score is the honest median fold score — it may be negative. Gate
  // failures are recorded for reporting and promotion, but NOT folded into the
  // score as a sign flip. A sign flip destroys the search gradient (a
  // profitable-but-imperfect strategy would rank below a timid one, and the
  // optimizer is pushed toward doing nothing). Gates are enforced at champion
  // promotion instead (see the workflow hook), so lineages can climb up
  // through negative territory toward a real edge.
  return {
    score: medianFoldScore,
    medianFoldScore,
    losingFolds,
    foldScores,
    foldReturns,
    positiveFolds: positiveFoldGate.positiveFolds,
    positiveFoldRate: positiveFoldGate.positiveFoldRate,
    minimumPositiveFolds: positiveFoldGate.minimumPositiveFolds,
    maxFoldDrawdownPct: drawdownGate.maxDrawdownPct,
    gateFailures,
  };
}
