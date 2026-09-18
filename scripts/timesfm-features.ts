import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TimesfmForecasts } from "../research/engine/timesfm-context.mjs";

export interface TimesfmConfig {
  dbPath: string;
  campaign: string;
  model: "timesfm_ohlcv" | "timesfm_close";
}

export function validateTimesfmConfig(value: TimesfmConfig): void {
  if (!value || typeof value.dbPath !== "string" || !value.dbPath ||
      typeof value.campaign !== "string" || !value.campaign ||
      !["timesfm_ohlcv", "timesfm_close"].includes(value.model)) {
    throw new Error("evaluation.timesfm requires dbPath, campaign and model (timesfm_ohlcv or timesfm_close)");
  }
}

/** Read-only, explicit campaign; outcomes never cross the feature boundary. */
export function loadTimesfmFeatures(
  config: TimesfmConfig,
  symbols: string[],
  ranges: Array<{ name: string; start: string; end: string }>,
) {
  validateTimesfmConfig(config);
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const campaign = db.prepare("SELECT manifest, status FROM campaigns WHERE id = ?").get(config.campaign);
    if (!campaign || campaign.status !== "complete") throw new Error("TimesFM campaign must exist and be complete");
    const manifest = JSON.parse(String(campaign.manifest));
    if (!["development", "research"].includes(manifest.partition) || !manifest.config?.revision) {
      throw new Error("Strategy search requires a pinned research/development campaign; holdout forecasts are forbidden");
    }
    const allowed = manifest.partition === "research" ? manifest.config.ranges : [manifest.config.development];
    if (!Array.isArray(allowed) || !allowed.length || allowed.some(r => !r?.start || !r?.end) ||
        !ranges.length || ranges.some(r => r.start > r.end ||
          !allowed.some(bounds => r.start >= bounds.start && r.end <= bounds.end))) {
      throw new Error("TimesFM ranges must stay inside the campaign research/development partition; run research:refresh for current dates");
    }
    const forecasts: TimesfmForecasts = {};
    const coverage: Record<string, Record<string, number>> = {};
    const query = db.prepare(`SELECT origin, origin_price, forecast_price FROM forecasts
      WHERE campaign = ? AND symbol = ? AND model = ? AND horizon = 10
        AND origin >= ? AND origin <= ? ORDER BY origin`);
    for (const symbol of symbols) {
      forecasts[symbol] = {};
      coverage[symbol] = {};
      for (const range of ranges) {
        const rows = query.all(config.campaign, symbol, config.model, range.start, range.end);
        if (!rows.length) throw new Error(`No TimesFM forecasts for ${symbol} in ${range.name}; generate matching forecasts first`);
        coverage[symbol][range.name] = rows.length;
        for (const row of rows) {
          const origin = Number(row.origin_price), predicted = Number(row.forecast_price);
          if (!(origin > 0) || !(predicted > 0) || !Number.isFinite(origin) || !Number.isFinite(predicted)) {
            throw new Error(`Invalid TimesFM price for ${symbol} ${row.origin}`);
          }
          const asOf = String(row.origin);
          const predictedReturnPct = 100 * (predicted / origin - 1);
          if (!Number.isFinite(predictedReturnPct)) throw new Error(`Invalid TimesFM return for ${symbol} ${asOf}`);
          forecasts[symbol][asOf] = { asOf, horizonDays: 10, predictedReturnPct };
        }
      }
    }
    return {
      forecasts,
      metadata: {
        campaign: config.campaign, model: config.model, revision: manifest.config.revision,
        inputFingerprint: manifest.data_sha256,
        featureFingerprint: createHash("sha256").update(JSON.stringify(forecasts)).digest("hex"),
        stride: manifest.config.stride, coverage,
      },
    };
  } finally {
    db.close();
  }
}
