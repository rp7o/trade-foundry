export type ScoreProfile = "conservative" | "moderate" | "aggressive";

export interface ScoreTrade {
  symbol: string;
  profit: number;
  exitDate: string;
}

export interface ScoreEquityPoint {
  date: string;
  capital: number;
}

export interface ProfileScoreInput {
  profile: ScoreProfile;
  initialCapital: number;
  trades: ScoreTrade[];
  capitalSeries: ScoreEquityPoint[];
  allDates: string[];
  ruinProbability?: number;
  confidenceDrawdown?: number;
}

export interface ProfileScore {
  profile: ScoreProfile;
  score: number;
  earnedProfit: number;
  finalCapital: number;
  totalTrades: number;
  winRate: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  timeFactor: number;
  timeContributionFactor: number;
  recencyFactor: number;
  concentrationFactor: number;
  symbolFactor: number;
  tradeFactor: number;
  riskFactor: number;
  drawdownPenalty: number;
  topTradeContributionPct: number;
  profitableQuarterRate: number;
  scoreGateFailures: string[];
  timeWindows: number[];
}

export interface CombinedScore {
  score: number;
  weightedScore: number;
  weights: Record<ScoreProfile, number>;
  profileScores: Record<ScoreProfile, ProfileScore>;
  scoreGateFailures: string[];
}

export const SCORE_PROFILES: ScoreProfile[] = ["conservative", "moderate", "aggressive"];
export const PROFILE_WEIGHTS: Record<ScoreProfile, number> = {
  conservative: 2,
  moderate: 3,
  aggressive: 1,
};

const TIME_WINDOWS = 6;
const TRADE_TRIM_PCT = 0.05;
const TIME_FACTOR_FLOOR = 0.80;
const RECENCY_WEIGHT_DECAY = 0.85;
const SYMBOL_FACTOR_FLOOR = 0.85;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export function calculateProfileScore(input: ProfileScoreInput): ProfileScore {
  const trades = input.trades;
  const finalCapital = input.capitalSeries.length > 0
    ? input.capitalSeries[input.capitalSeries.length - 1].capital
    : input.initialCapital;
  const earnedProfit = finalCapital - input.initialCapital;
  const wins = trades.filter((trade) => trade.profit > 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

  let peakCapital = input.initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const point of input.capitalSeries) {
    if (point.capital > peakCapital) peakCapital = point.capital;
    const drawdown = peakCapital - point.capital;
    const drawdownPct = peakCapital > 0 ? (drawdown / peakCapital) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  let timeFactor = 1;
  let timeContributionFactor = 1;
  let recencyFactor = 1;
  const timeWindows: number[] = [];
  if (input.capitalSeries.length >= TIME_WINDOWS * 2) {
    const n = input.capitalSeries.length;
    let prevEnd = input.initialCapital;
    for (let w = 0; w < TIME_WINDOWS; w++) {
      const endIdx = Math.floor((n * (w + 1)) / TIME_WINDOWS) - 1;
      const endCap = input.capitalSeries[endIdx].capital;
      timeWindows.push(prevEnd > 0 ? endCap / prevEnd - 1 : 0);
      prevEnd = endCap;
    }

    const positiveReturnSum = timeWindows.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (positiveReturnSum > 0) {
      const shares = timeWindows.map((value) => Math.max(0, value) / positiveReturnSum);
      const effectiveWindows = 1 / shares.reduce((sum, share) => sum + share * share, 0);
      timeContributionFactor = TIME_FACTOR_FLOOR + (1 - TIME_FACTOR_FLOOR) * (effectiveWindows / TIME_WINDOWS);
    }

    let weightedReturnSum = 0;
    let weightSum = 0;
    for (let i = 0; i < timeWindows.length; i++) {
      const age = timeWindows.length - 1 - i;
      const weight = RECENCY_WEIGHT_DECAY ** age;
      weightedReturnSum += timeWindows[i] * weight;
      weightSum += weight;
    }
    const weightedMean = weightSum > 0 ? weightedReturnSum / weightSum : 0;
    const simpleMean = timeWindows.reduce((sum, value) => sum + value, 0) / timeWindows.length;
    recencyFactor = simpleMean > 0
      ? clamp((1 + weightedMean) / (1 + simpleMean), 0.90, 1.05)
      : 1;
    timeFactor = clamp(timeContributionFactor * recencyFactor, TIME_FACTOR_FLOOR, 1.05);
  }

  let concentrationFactor = 1;
  if (earnedProfit > 0 && trades.length > 0) {
    const profits = trades.map((trade) => trade.profit);
    const winners = profits.filter((profit) => profit > 0).sort((a, b) => a - b);
    const medianWinner = winners.length ? winners[Math.floor(winners.length / 2)] : 0;
    const trimCount = Math.floor(profits.length * TRADE_TRIM_PCT);
    const desc = [...profits].sort((a, b) => b - a);
    let trimmedGain = 0;
    for (let i = 0; i < desc.length; i++) {
      trimmedGain += i < trimCount ? Math.min(desc[i], medianWinner) : desc[i];
    }
    concentrationFactor = clamp(trimmedGain / earnedProfit, 0, 1);
  }

  const symbolProfits: Record<string, number> = {};
  for (const trade of trades) {
    symbolProfits[trade.symbol] = (symbolProfits[trade.symbol] ?? 0) + trade.profit;
  }
  const bestSymbolProfit = Object.values(symbolProfits).length > 0
    ? Math.max(...Object.values(symbolProfits))
    : 0;
  const profitExBestSymbol = earnedProfit > 0 ? earnedProfit - Math.max(0, bestSymbolProfit) : earnedProfit;
  const symbolFactor = earnedProfit > 0
    ? clamp(profitExBestSymbol / earnedProfit, SYMBOL_FACTOR_FLOOR, 1)
    : 1;

  const tradeFactor = 1;
  const riskFactor = calculateRiskFactor(input.ruinProbability, input.confidenceDrawdown);
  const drawdownPenalty = 0;

  const grossWinningProfit = wins.reduce((sum, trade) => sum + trade.profit, 0);
  const topThreeWinningProfit = wins
    .map((trade) => trade.profit)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, profit) => sum + profit, 0);
  const topTradeContributionPct = grossWinningProfit > 0
    ? (topThreeWinningProfit / grossWinningProfit) * 100
    : 0;

  const quarterSegments = profitSegments(completeQuarterKeys(input.allDates), trades, (trade) => quarterKey(trade.exitDate));
  // Coverage is judged only over quarters the strategy actually traded.
  // Sitting out a quarter (e.g. a long-only strategy in a falling market) is
  // neutral, not a failure — an untraded quarter is no evidence either way.
  const tradedQuarterKeys = new Set(trades.map((trade) => quarterKey(trade.exitDate)));
  const activeQuarterSegments = quarterSegments.filter((segment) => tradedQuarterKeys.has(segment.name));
  const profitableQuarterRate = activeQuarterSegments.length > 0
    ? activeQuarterSegments.filter((segment) => segment.passed).length / activeQuarterSegments.length
    : 1;

  // Scoring is deliberately return-only. Drawdown, fold breadth, and every
  // other robustness rule are evaluated separately by the promotion gates.
  const score = earnedProfit;

  return {
    profile: input.profile,
    score,
    earnedProfit,
    finalCapital,
    totalTrades: trades.length,
    winRate,
    maxDrawdown,
    maxDrawdownPct,
    timeFactor,
    timeContributionFactor,
    recencyFactor,
    concentrationFactor,
    symbolFactor,
    tradeFactor,
    riskFactor,
    drawdownPenalty,
    topTradeContributionPct,
    profitableQuarterRate,
    scoreGateFailures: [],
    timeWindows,
  };
}

export function combineProfileScores(profileScores: Record<ScoreProfile, ProfileScore>): CombinedScore {
  const totalWeight = SCORE_PROFILES.reduce((sum, profile) => sum + PROFILE_WEIGHTS[profile], 0);
  const weightedScore = SCORE_PROFILES.reduce(
    (sum, profile) => sum + profileScores[profile].score * PROFILE_WEIGHTS[profile],
    0,
  ) / totalWeight;
  const scoreGateFailures = SCORE_PROFILES.flatMap((profile) =>
    profileScores[profile].scoreGateFailures.map((failure) => `${profile}:${failure}`)
  );
  // Each profile score is already sign-corrected for its own robustness
  // failures, so the weighted average is the honest combined value. Do not
  // re-flip here — that double-punished a fold and flipped a profitable
  // combined result negative because a single profile ran thin.
  const score = weightedScore;
  return {
    score,
    weightedScore,
    weights: PROFILE_WEIGHTS,
    profileScores,
    scoreGateFailures,
  };
}

function calculateRiskFactor(ruinProbability?: number, confidenceDrawdown?: number): number {
  const ruinFactor = Number.isFinite(ruinProbability)
    ? clamp(1 - Number(ruinProbability) * 5, 0.75, 1)
    : 1;
  const confidenceDrawdownFactor = Number.isFinite(confidenceDrawdown)
    ? clamp(1 - Math.max(0, Number(confidenceDrawdown) - 0.25), 0.75, 1)
    : 1;
  return ruinFactor * confidenceDrawdownFactor;
}

function profitSegments(
  keys: string[],
  sourceTrades: ScoreTrade[],
  keyFn: (trade: ScoreTrade) => string,
): Array<{ name: string; value: number; passed: boolean }> {
  const profitByKey: Record<string, number> = {};
  for (const key of keys) profitByKey[key] = 0;
  for (const trade of sourceTrades) {
    const key = keyFn(trade);
    profitByKey[key] = (profitByKey[key] ?? 0) + trade.profit;
  }
  return Object.entries(profitByKey).map(([name, profit]) => ({
    name,
    value: profit,
    passed: profit > 0,
  }));
}

function completeQuarterKeys(dates: string[]): string[] {
  return [...new Set(dates.map(quarterKey))].sort();
}

function quarterKey(date: string): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}
