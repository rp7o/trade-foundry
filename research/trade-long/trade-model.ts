export type TradeSide = "long" | "short";

export interface EntryRange {
  min: number;
  max: number;
}

export interface ProposalLike {
  side: TradeSide;
  entry: EntryRange;
  stopLoss: number;
  target: number;
  maxHoldDays: number;
  setup: string;
  regime: string;
}

export interface CandleLike {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ShadowOutcome {
  side: TradeSide;
  setup: string;
  regime: string;
  rMultiple: number;
}

export interface Eligibility {
  actionable: boolean;
  reason: "warmup" | "eligible" | "negative-expectancy" | "low-win-rate" | "drawdown";
  sampleSize: number;
  expectancyR: number;
  winRate: number;
  maxDrawdownR: number;
}

export type LongPositionProposalAction =
  | { action: "exit" }
  | { action: "adjust"; stopLoss: number; target: number };

export const PERFORMANCE_WINDOW = 20;
export const PERFORMANCE_MIN_SAMPLE = 10;
export const PERFORMANCE_MIN_WIN_RATE = 0.35;
export const PERFORMANCE_MAX_DRAWDOWN_R = 5;
export const MIN_TRADES_FOR_SCORE = 8;
export const FULL_CONFIDENCE_TRADES = 20;

export function worstCaseEntry(proposal: ProposalLike): number {
  return proposal.side === "long" ? proposal.entry.max : proposal.entry.min;
}

export function proposalRewardRisk(proposal: ProposalLike): number {
  const entry = worstCaseEntry(proposal);
  const risk = proposal.side === "long"
    ? entry - proposal.stopLoss
    : proposal.stopLoss - entry;
  const reward = proposal.side === "long"
    ? proposal.target - entry
    : entry - proposal.target;
  return risk > 0 ? reward / risk : -Infinity;
}

export function resolveEntryFill(entry: EntryRange, candle: CandleLike): number | null {
  if (candle.high < entry.min || candle.low > entry.max) return null;
  return Math.max(entry.min, Math.min(entry.max, candle.open));
}

export function resolveRawExit(
  side: TradeSide,
  stopLoss: number,
  target: number,
  candle: CandleLike,
): { price: number; reason: "stop" | "target" } | null {
  const hitStop = side === "long" ? candle.low <= stopLoss : candle.high >= stopLoss;
  const hitTarget = side === "long" ? candle.high >= target : candle.low <= target;
  if (hitStop) return { price: stopLoss, reason: "stop" };
  if (hitTarget) return { price: target, reason: "target" };
  return null;
}

export function calculateRMultiple(
  side: TradeSide,
  entry: number,
  stopLoss: number,
  exitPrice: number,
): number {
  const risk = side === "long" ? entry - stopLoss : stopLoss - entry;
  if (risk <= 0) return -Infinity;
  return side === "long"
    ? (exitPrice - entry) / risk
    : (entry - exitPrice) / risk;
}

export function shouldTimeExit(daysOpen: number, maxHoldDays: number): boolean {
  return daysOpen >= maxHoldDays;
}

export function applyProposalToLongPosition(
  currentStopLoss: number,
  proposal: ProposalLike,
): LongPositionProposalAction {
  if (proposal.side === "short") return { action: "exit" };
  return {
    action: "adjust",
    stopLoss: Math.max(currentStopLoss, proposal.stopLoss),
    target: proposal.target,
  };
}

export function assessEligibility(
  outcomes: ShadowOutcome[],
  proposal: ProposalLike,
): Eligibility {
  const relevant = outcomes
    .filter((outcome) =>
      outcome.side === proposal.side &&
      outcome.setup === proposal.setup &&
      outcome.regime === proposal.regime
    )
    .slice(-PERFORMANCE_WINDOW);

  const sampleSize = relevant.length;
  const expectancyR = sampleSize > 0
    ? relevant.reduce((sum, outcome) => sum + outcome.rMultiple, 0) / sampleSize
    : 0;
  const winRate = sampleSize > 0
    ? relevant.filter((outcome) => outcome.rMultiple > 0).length / sampleSize
    : 0;

  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const outcome of relevant) {
    cumulativeR += outcome.rMultiple;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
  }

  if (sampleSize < PERFORMANCE_MIN_SAMPLE) {
    return { actionable: true, reason: "warmup", sampleSize, expectancyR, winRate, maxDrawdownR };
  }
  if (expectancyR <= 0) {
    return {
      actionable: false,
      reason: "negative-expectancy",
      sampleSize,
      expectancyR,
      winRate,
      maxDrawdownR,
    };
  }
  if (winRate < PERFORMANCE_MIN_WIN_RATE) {
    return {
      actionable: false,
      reason: "low-win-rate",
      sampleSize,
      expectancyR,
      winRate,
      maxDrawdownR,
    };
  }
  if (maxDrawdownR > PERFORMANCE_MAX_DRAWDOWN_R) {
    return {
      actionable: false,
      reason: "drawdown",
      sampleSize,
      expectancyR,
      winRate,
      maxDrawdownR,
    };
  }
  return { actionable: true, reason: "eligible", sampleSize, expectancyR, winRate, maxDrawdownR };
}

export function tradeConfidenceFactor(trades: number): number {
  if (!Number.isFinite(trades) || trades < MIN_TRADES_FOR_SCORE) return 0;
  return Math.min(1, trades / FULL_CONFIDENCE_TRADES);
}
