// Noise-aware acceptance: block bootstrap over the incumbent's per-fold trade
// PnL. A candidate is only a real improvement if its median fold profit
// exceeds what the incumbent could plausibly produce by trade-sequence luck.
//
// Used by the workflow hook at acceptance time; not part of the score itself.

export interface SignificanceTrade {
  fold: string;
  profit: number;
}

export interface SignificanceResult {
  passed: boolean;
  // True when the incumbent's evidence is too thin for a bootstrap, so the
  // verdict rests on a point comparison rather than a noise band. Never treat
  // an inconclusive pass as evidence of a real improvement.
  inconclusive: boolean;
  reason: string;
  candidateMedianFoldProfit: number;
  incumbentMedianFoldProfit: number;
  incumbentQ90: number;
}

const BOOTSTRAP_DRAWS = 1000;
const BLOCK_SIZE = 10;
const QUANTILE = 0.9;
// Below this many incumbent trades a bootstrap is meaningless. That is a
// reason for a more conservative verdict, not a free pass: fall back to a
// direct point comparison and mark the result inconclusive.
const MIN_INCUMBENT_TRADES = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function foldProfits(trades: SignificanceTrade[]): Map<string, number[]> {
  const byFold = new Map<string, number[]>();
  for (const trade of trades) {
    const list = byFold.get(trade.fold) ?? [];
    list.push(trade.profit);
    byFold.set(trade.fold, list);
  }
  return byFold;
}

function medianFoldProfit(trades: SignificanceTrade[], folds: string[]): number {
  const byFold = foldProfits(trades);
  return median(folds.map((fold) =>
    (byFold.get(fold) ?? []).reduce((sum, profit) => sum + profit, 0)
  ));
}

// One bootstrap draw: within each fold, resample blocks of consecutive trades
// (with replacement) up to the original trade count, preserving the serial
// dependence of clustered wins/losses; then take the median fold profit.
function bootstrapDraw(
  byFold: Map<string, number[]>,
  folds: string[],
  rand: () => number,
): number {
  const foldSums = folds.map((fold) => {
    const profits = byFold.get(fold) ?? [];
    if (profits.length === 0) return 0;
    // Cap the block size at half the fold so every draw mixes at least two
    // independently placed blocks; a block covering the whole fold circularly
    // would reproduce the exact fold sum and collapse the variance to zero.
    const blockSize = Math.max(1, Math.min(BLOCK_SIZE, Math.floor(profits.length / 2)));
    let sum = 0;
    let drawn = 0;
    while (drawn < profits.length) {
      const start = Math.floor(rand() * profits.length);
      const take = Math.min(blockSize, profits.length - drawn);
      for (let i = 0; i < take; i++) {
        sum += profits[(start + i) % profits.length];
      }
      drawn += take;
    }
    return sum;
  });
  return median(foldSums);
}

export function assessSignificance(
  candidateTrades: SignificanceTrade[],
  incumbentTrades: SignificanceTrade[],
  folds: string[],
): SignificanceResult {
  const candidateMedian = medianFoldProfit(candidateTrades, folds);
  const incumbentMedian = medianFoldProfit(incumbentTrades, folds);

  if (incumbentTrades.length < MIN_INCUMBENT_TRADES) {
    const passed = candidateMedian > incumbentMedian;
    return {
      passed,
      inconclusive: true,
      reason: `incumbent has only ${incumbentTrades.length} trades; bootstrap not meaningful — ` +
        `point comparison ${passed ? "passed" : "failed"} ` +
        `(candidate ${candidateMedian.toFixed(2)} vs incumbent ${incumbentMedian.toFixed(2)}); inconclusive`,
      candidateMedianFoldProfit: candidateMedian,
      incumbentMedianFoldProfit: incumbentMedian,
      incumbentQ90: incumbentMedian,
    };
  }

  const byFold = foldProfits(incumbentTrades);
  const rand = mulberry32(0xC0FFEE);
  const draws: number[] = new Array(BOOTSTRAP_DRAWS);
  for (let i = 0; i < BOOTSTRAP_DRAWS; i++) {
    draws[i] = bootstrapDraw(byFold, folds, rand);
  }
  draws.sort((a, b) => a - b);
  const q90 = draws[Math.min(draws.length - 1, Math.floor(QUANTILE * draws.length))];

  const passed = candidateMedian > q90;
  return {
    passed,
    inconclusive: false,
    reason: passed
      ? `candidate median fold profit ${candidateMedian.toFixed(2)} exceeds incumbent q90 ${q90.toFixed(2)}`
      : `candidate median fold profit ${candidateMedian.toFixed(2)} within incumbent noise band (q90 ${q90.toFixed(2)})`,
    candidateMedianFoldProfit: candidateMedian,
    incumbentMedianFoldProfit: incumbentMedian,
    incumbentQ90: q90,
  };
}
