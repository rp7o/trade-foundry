# Optional forecast data for AutoResearch

TimesFM is an additional data source for the AI researcher, not a strategy
imposed by the engine. The agent writes the ordinary `strategy.ts` and decides
whether and how to use forecasts, or ignores them entirely. There is no built-in
forecast entry rule, confirmation filter, stop, target, ranking or scoring bonus.

## Data contract

The optional second argument to `proposeTrade(history, market)` includes:

```ts
timesfm?: {
  asOf: string;
  horizonDays: 10;
  predictedReturnPct: number;
}
```

`2` means a predicted +2% return, not confidence. The field describes the current
stock at the last history date. Missing forecasts are unavailable, not zero;
the strategy owns its missing-data behavior. The existing cache has a
five-session stride, so many dates have no forecast. Nothing is forward-filled.

The data loader reads a pinned development campaign from the forecast cache,
separate from OHLCV storage. It passes only the forecast, never realized prices
or outcomes. The backtest and training signal screen use the same symbol/date
lookup. Their execution and scoring rules remain unchanged. A strategy that
ignores forecasts behaves identically whether the data is supplied or not.

No Python, model, database or additional library belongs in the generated
`strategy.ts`. The proposal contract is unchanged. External consumers must
supply the same optional context if a strategy uses it.

## Research workflow

1. Configure `evaluation.timesfm` with `dbPath`, `campaign` and `model`
   (`timesfm_ohlcv` or `timesfm_close`), plus compatible `trainingStart`,
   `trainingEnd`, fixed folds and `evaluationEnd`.
2. Run `pnpm run generate-training`. It exports training-only forecast CSVs
   alongside the existing training inputs. Samples appear in the agent prompt.
3. Run the normal AutoResearch loop. The agent chooses its strategy logic; the
   normal evaluator supplies matching forecasts when configured.

Contract checks cover missing, positive and negative forecast inputs; no check
requires using forecasts. Configuration/feature fingerprints invalidate old
scores when the supplied data changes. Search agents cannot read the raw cache
or evaluation/holdout outcomes.

## Separate preparation and research commands

Once this checkout has a compatible forecast-enabled research configuration:

```sh
# After updating prices.db, prepare inputs (never starts the agent):
pnpm run research:refresh

# Start only the normal research loop using prepared inputs:
pnpm run research:loop

# Validate configuration and show the sequence without writes:
pnpm run research:refresh --dry-run
```

The runner syncs `db/prices.db` into the configured market database, runs the
resumable historical forecast generator, validates the completed campaign's
training/fold coverage, updates only its campaign ID, exports training CSVs,
and creates a baseline only if none exists. It always stops there. A baseline is
an evaluation of the current strategy, not an AI research attempt. Existing
best results are not reset. `--prepare-only` remains an alias for this default.

`research:loop` runs only the ordinary bounded loop and its existing pre-loop
checks, which re-evaluate stale scores. It does not sync prices, generate
forecasts or export training CSVs. Preparation never prescribes forecast use,
changes research dates, or commits/pushes code.

Use `--source /path/to/prices.db` for another source and `--forecast-config
/path/to/config.json` for an explicitly configured historical campaign. The
generator's development period must cover the research dates and must not
overlap the reserved benchmark holdout. The default remains 2022–2024: newly
synced prices outside that period do not extend the forecast window. This is
not a latest-day/live forecast generator.

Completed windows are reused; changed campaign inputs generate a new campaign.
If the campaign ID changes, the previous config is backed up under
`.autoresearch/autoresearch.config.before-refresh-*.json`. A failed step stops
the pipeline; already synced data and completed forecast work are retained for
retry. A training-export failure leaves the validated campaign configured but
does not start the loop.

Run this only when no other research loop or market-data writer is active.
The runner holds `.autoresearch/refresh-research.lock` through its entire run
to exclude other invocations. After a hard interruption, confirm the old process
is gone before removing a leftover empty lock directory. It requires the same
`pnpm`, `uv` and model access/cache as the individual commands; `HF_HUB_OFFLINE=1`
can be supplied when the model is already cached.

## Existing cache and research dates

The active search remains unchanged: its training window ends in 2017, whereas
the cached development forecasts cover 2022–2024. Enabling that cache against
the current dates fails with a coverage error rather than silently omitting it.

`pnpm run timesfm:search-config` prepares an optional config with training in
2022 and four half-year evaluation folds in 2023–2024. It writes
`.autoresearch/timesfm-search.config.json` exclusively (or a path supplied as
the first argument), validates coverage, and does not start a search or replace
the active config. If that file already exists, use a new output path.

To use it, provide the market database and forecast cache in a separate research
checkout, use the prepared file as its `autoresearch.config.json`, regenerate
training data, and run the normal loop. Keep its scores and champion separate
because the evaluation dates differ. No separate TimesFM trading/comparison
runner is needed. Historical comparison reports are not AutoResearch results.

To measure the value of providing forecasts to the researcher, compare separate
searches with identical dates and attempt budgets, differing only in availability
of this input. This is an experiment design, not a required strategy rule.

The 2025 holdout remains locked. Retrospective model pretraining and adjusted
market-data limitations still apply; date alignment alone does not establish a
fully point-in-time investable result.
