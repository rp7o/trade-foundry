// Whitelist the strategy-visible fields. Never expose benchmark outcomes or
// other symbols/dates, and never carry a sparse forecast forward.
export function timesfmAsOf(forecasts, symbol, date) {
  const value = forecasts?.[symbol]?.[date];
  if (!value || value.asOf !== date || value.horizonDays !== 10 ||
      !Number.isFinite(value.predictedReturnPct)) return undefined;
  return {
    asOf: date,
    horizonDays: 10,
    predictedReturnPct: value.predictedReturnPct,
  };
}
