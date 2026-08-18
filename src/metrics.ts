export function extractMetric(log: string, regex: string): number {
  const match = log.match(new RegExp(regex, "m"));
  if (!match?.[1]) {
    throw new Error("metric was not found in experiment output");
  }

  const score = Number(match[1]);
  if (!Number.isFinite(score)) {
    throw new Error(`metric capture is not a finite number: ${match[1]}`);
  }

  return score;
}

export function isImprovement(
  candidateScore: number,
  bestScore: number,
  minDeltaPct: number
): boolean {
  const minDelta = Math.abs(bestScore) * minDeltaPct;
  return candidateScore > bestScore + minDelta;
}
