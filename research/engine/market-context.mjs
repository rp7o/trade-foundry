// Vendored verbatim from the trading-strategy-engine project.

// Build a market-index series positionally aligned to a symbol's candles.
//
// Market-relative strategies (e.g. genetic-trader genomes using marketRoc)
// read `_market.index[i].close`, expecting element i to correspond to the same
// trading day as `history[i]`. Symbol and index calendars can differ, so we
// join by date and forward-fill gaps rather than concatenating positionally.
//
// Returns null when no usable index is supplied, so callers can omit the market
// context entirely (proposeTrade tolerates a missing second argument).
export function buildAlignedIndex(candles, marketIndex) {
  if (!Array.isArray(marketIndex) || marketIndex.length === 0) return null;
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const byDate = new Map();
  for (const point of marketIndex) {
    if (point && point.date != null && point.close != null) {
      byDate.set(String(point.date), Number(point.close));
    }
  }
  if (byDate.size === 0) return null;

  const aligned = [];
  let last;
  for (const candle of candles) {
    const value = byDate.get(String(candle.date));
    if (value !== undefined && Number.isFinite(value)) last = value;
    aligned.push({ date: candle.date, close: last });
  }
  return aligned;
}
