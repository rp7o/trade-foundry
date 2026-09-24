# Optional TimesFM forecast preparation

TimesFM is an optional input to the research harness. It is not a built-in
strategy, signal, ranking rule, sizing rule, exit rule, or scoring bonus. The
public checkout remains useful with the feature disabled, with no market data,
and with the neutral strategy scaffold unchanged.

## What is prepared

Install `uv` for this optional workflow. It manages the launcher's Python 3.12
environment and locked TimesFM/CPU PyTorch dependencies. The first preparation
downloads the model weights from Hugging Face; a GPU is not required. Model
packages and weights are not needed for ordinary evaluation with TimesFM off.
Once dependencies and weights are cached, `HF_HUB_OFFLINE=1` can be used for
preparation without fetching weights again.

`research:refresh` uses the configured market database created by
`market:import`. It reads that database directly; it does not sync a private
`prices.db`, accept a `--source` database, or add a second market-data path.
The command generates or resumes the historical forecast campaign described by
[`docs/timesfm-research.json`](timesfm-research.json), validates that its
training and research/fold ranges are covered, then enables the selected local
campaign in the local configuration. It also generates training inputs and
creates a baseline only if none exists. It always stops before the research
loop.

```bash
pnpm run market:import -- ./path/to/licensed-prices.csv
pnpm run research:refresh
pnpm run research:loop
```

The refresh command is resumable. A failed step stops the preparation; it does
not start the loop or reset existing research state. A local configuration
backup is made before enabling `evaluation.timesfm`. The normal loop remains
responsible for strategy attempts and acceptance.

Preview validation and the planned ranges without writes, model imports, or
configuration changes:

```bash
pnpm run research:refresh -- --dry-run
```

An explicitly reviewed settings file can be supplied when needed:

```bash
pnpm run research:refresh -- --forecast-config ./path/to/reviewed-config.json
```

`--forecast-config` changes forecast preparation settings only; it does not
change the public evaluator dates or unlock a holdout. The default pinned
settings are in `docs/timesfm-research.json`. `research:loop` is an alias for
the ordinary bounded loop and does not perform refresh work, sync prices,
generate forecasts, export training CSVs, or reset a baseline.

The selected campaign is recorded as `evaluation.timesfm` with `dbPath`,
`campaign`, and `model` (`timesfm_ohlcv` or `timesfm_close`). The committed
configuration omits this block. Forecasts default to a 256-session context,
a five-session stride, and a 10-session horizon; missing dates stay missing.
Training and rolling fold dates come from the existing evaluation settings.
For a fixed research period, `evaluationEnd` must match the end of the configured
folds; optional `trainingStart` bounds training forecast origins. Keep any final
holdout outside the configured research ranges; this command does not reserve
a particular calendar year automatically.

To disable the feature locally, remove `evaluation.timesfm` and rerun
`pnpm run generate-training` to remove stale forecast samples. The next loop's
pre-loop check invalidates scores when the supplied features change.

Forecasts are cached under `.autoresearch/timesfm/`. Run preparation while no
research loop or market-data writer is active. A lock excludes other refresh
commands; after a hard interruption, verify the previous process is gone
before removing `.autoresearch/refresh-research.lock`. Completed forecast batches
survive failures. If training export fails after activation, the validated
campaign remains selected and the previous configuration is backed up under
`.autoresearch/`; rerun preparation to finish.

## Forecast boundary

When enabled by the evaluator, a strategy may receive only the current
symbol's exact-date feature:

```ts
timesfm?: {
  asOf: string;
  horizonDays: 10;
  predictedReturnPct: number;
}
```

`predictedReturnPct: 2` means a predicted return of positive two percent; it
is not a probability or confidence score. Missing forecasts are unavailable,
not zero. Forecasts must not be carried forward, and the strategy must remain
deterministic and valid when the field is absent. The proposal contract,
execution costs, walk-forward scoring, and promotion gates do not change.

Evaluation and the signal screen use the same symbol/date lookup. Training
CSV exports and the signal screen stop at the training cutoff; evaluation
supplies forecasts within each fold. Each proposal sees only its own symbol
and current date. Raw cache rows, realized outcomes, and evaluation forecasts
are not training inputs for the agent. No Python package, model library,
database read, or model inference belongs in `strategy.ts`.

## Licensing and point-in-time limits

The pinned model is
[`google/timesfm-3.0-pytorch`](https://huggingface.co/google/timesfm-3.0-pytorch/tree/43046b85ec22d584a13f8098c2ed39c889e129c2)
at revision
`43046b85ec22d584a13f8098c2ed39c889e129c2`. The model card identifies the
separate [TimesFM Non-Commercial License v1.0](https://huggingface.co/google/timesfm-3.0-pytorch/blob/43046b85ec22d584a13f8098c2ed39c889e129c2/LICENSE).
It limits model use to non-commercial, non-production research, restricts
commercial or production use of outputs, and prohibits distribution of the
model or derivatives under that licence. The harness's MIT licence does not
replace these terms. Weights are downloaded separately and are not included here.

The [pinned model card](https://huggingface.co/google/timesfm-3.0-pytorch/blob/43046b85ec22d584a13f8098c2ed39c889e129c2/README.md)
also describes pretraining data with historical cutoffs,
including Wikipedia pageviews through November 2023 and Google Trends through
the end of 2022. Forecast date alignment and leakage controls therefore do not
by themselves establish a fully point-in-time investable result. Historical
forecast accuracy is not evidence of profitability, and this workflow makes no
profitability, performance, or investment-advice claim.

## Repository boundary

Do not commit market data, training CSVs, forecast databases, model weights,
campaign IDs, reports, or actual strategy candidates. Keep TimesFM preparation
artifacts under ignored local paths. Because `strategy.ts` is tracked, use a
separate local clone without a remote for private strategy research rather than
placing a personal strategy in this starter repository.
