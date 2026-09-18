export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeProposal {
  side: "long" | "short";
  entry: {
    min: number;
    max: number;
  };
  stopLoss: number;
  target: number;
  maxHoldDays: number;
  setup: string;
  regime: string;
  strategyVersion: string;
}

export const STRATEGY_BOILERPLATE = true;

/**
 * Optional market context passed by the evaluator as a second argument.
 * Each series is daily candles ending at the last date of `history` — no
 * lookahead. Series may be absent; strategies must work when `market` is
 * undefined or a series is missing.
 *
 * These are LOCAL-market context series only, keyed by generic role so the
 * strategy logic stays portable across markets. Do not rely on any foreign
 * lead market (e.g. an overnight US index) — that is a region-specific
 * artifact that will not transfer to other exchanges.
 *
 * - `index`: local broad-market index (currently ^AXJO for the ASX universe)
 * - `volatility`: local implied-volatility index (currently ^AXVI)
 *
 * Matching training CSVs are provided as training-data/market-<name>.csv.
 */
export interface MarketContext {
  /** Optional exact-date forecast data. Strategy may use or ignore it and owns missing-data behavior. Percent units, not confidence. */
  timesfm?: { asOf: string; horizonDays: 10; predictedReturnPct: number };
  index?: Candle[];
  volatility?: Candle[];
}

export function proposeTrade(
  _history: Candle[],
  _market?: MarketContext,
): TradeProposal | null {
  return null;
}
