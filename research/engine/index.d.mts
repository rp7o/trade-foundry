// Types for the vendored engine. The implementation is JavaScript; this file
// is the typed contract its callers compile against.

export declare const SCHEMA_VERSION: "trading-strategy-engine.v1";

export interface EngineCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PortfolioBacktestContext {
  timesfm_forecasts?: import("./timesfm-context.mjs").TimesfmForecasts;
  symbols: Record<string, EngineCandle[]>;
  initial_capital?: number;
  risk_per_trade?: number;
  max_hold_days?: number | null;
  max_positions?: number;
  min_avg_traded_value?: number;
  optimization_profile?: string;
  hurdle_rate?: number;
  execution_costs?: {
    brokerage_per_side?: number;
    slippage_bps_per_side?: number;
  };
  /** Optional multi-strategy ensemble; defaults to the single strategy path. */
  strategies?: string[];
  correlations?: Record<string, Record<string, number>>;
}

export interface PortfolioBacktestOptions {
  /** Root that strategy paths resolve against. Defaults to the process cwd. */
  engineRoot?: string;
  /** Side used to build the default strategy path. Defaults to "long". */
  side?: string;
  /** Strategy path relative to engineRoot. */
  strategyPath?: string;
}

export interface PortfolioBacktestTrade {
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  target: number;
  qty: number;
  pnl: number;
  brokerage: number;
  slippage: number;
  setup?: string;
  regime?: string;
  strategyVersion?: string;
  /** Path of the strategy that opened the trade, for ensemble attribution. */
  strategy?: string;
  reason: string;
}

export interface PortfolioBacktestResult {
  schemaVersion?: string;
  initialCapital: number;
  finalCapital: number;
  returnPct: number;
  totalTrades: number;
  maxDrawdownPct: number;
  riskPerTrade?: number;
  ruinProbability?: number;
  confidenceDrawdown?: number;
  sortino?: number;
  trades: PortfolioBacktestTrade[];
  capitalSeries: Array<{ date: string; capital: number }>;
  [key: string]: unknown;
}

/** Run a portfolio backtest on the calling thread. */
export declare function runPortfolioBacktest(
  context: PortfolioBacktestContext,
  options?: PortfolioBacktestOptions,
): Promise<PortfolioBacktestResult>;

/**
 * Run a portfolio backtest on a worker thread. Backtests are CPU-bound, so
 * callers should cap how many run concurrently.
 */
export declare function runPortfolioBacktestInWorker(
  context: PortfolioBacktestContext,
  options?: PortfolioBacktestOptions,
): Promise<PortfolioBacktestResult>;
