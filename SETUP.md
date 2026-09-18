# Setup

Step-by-step first run. See `README.md` for what this project is.

## 1. Prerequisites

- **Node.js >= 22.13** and **pnpm 11** (`corepack enable` picks up the pinned version).
- **A coding-agent CLI** — `pi` by default, `codex` also supported. Optional:
  everything except `ar -- agent-once` and `ar -- loop` works without one.

## 2. Install

```bash
pnpm install
```

## 3. Build the market data

No market data is committed. Obtain daily market data from a provider whose
licence permits your intended use. The importer expects one CSV containing
these columns:

```text
symbol,date,open,high,low,close,adj_close,volume
```

Dates must be `YYYY-MM-DD`; prices must be positive; and `adj_close` must be
present because the evaluator uses adjusted prices. Extra provider columns are
ignored. The database is created locally and the import is safe to repeat.

```bash
pnpm run market:import -- ./path/to/licensed-prices.csv
pnpm run market:status        # row counts and date ranges per symbol
pnpm run generate-training    # writes research/trade-long/training-data/*.csv
```

To update the database later, export new or overlapping rows in the same format
and run `market:import` again. Existing `(symbol, date)` rows are updated.
The importer is the only market-data acquisition path; the repository does not
depend on a particular data vendor.

The universe comes from `research/trade-long/universe.csv`, and the evaluation
symbols and training cutoff come from the `evaluation` block in
`autoresearch.config.json`. Agents only ever see data up to
`evaluation.trainingEnd`; the walk-forward folds and the locked holdout that
actually score candidates lie strictly after that date.

The importer writes `db/market.db`. Keep `evaluation.dbPath` pointed at that
database, or supply an equivalent local database at your configured path.

## Optional TimesFM preparation

TimesFM is off unless `evaluation.timesfm` is enabled locally. Forecast
preparation requires `uv`, which manages a separate Python 3.12 environment
with pinned TimesFM and CPU PyTorch packages. The first run downloads the
packages and model weights. Ordinary research needs neither Python nor TimesFM.
Read the [model licence and setup details](docs/timesfm-strategy-search.md)
before enabling it.

The optional preparation command reads the database at `evaluation.dbPath`, then generates
or resumes the forecast campaign described by the pinned settings in
`docs/timesfm-research.json`:

```bash
pnpm run research:refresh
```

`research:refresh` stops after preparation. It does not run an agent loop or
reset a baseline. It validates forecast coverage for the configured research
ranges, backs up the local config before enabling the selected campaign,
generates training inputs, and creates a baseline only when one does not
already exist. Existing scores and accepted state are preserved. It never
requires a private `prices.db` or a `--source` database option.

Use `--dry-run` to validate and show the planned ranges and steps without
writing files, importing a model, or changing configuration:

```bash
pnpm run research:refresh -- --dry-run
```

An alternative model settings file may be supplied with `--forecast-config`.
Research dates always come from the evaluation configuration and market data;
the settings file cannot override them. After preparation, start the ordinary bounded
loop separately:

```bash
pnpm run research:loop
```

`research:loop` is an alias for the normal loop and does not sync prices,
generate forecasts, export training data, or reset state. Forecasts are an
optional feature supplied to the strategy; they do not prescribe an entry,
exit, sizing rule, or score bonus.

## 4. Run the checks

```bash
pnpm run check                # typecheck
pnpm run test                 # unit tests
pnpm run strategy:check
pnpm run strategy:contract
```

## 5. Seed the baseline

```bash
pnpm run ar -- baseline --reset
```

The neutral scaffold makes no trades. Use the baseline command only when you
intend to evaluate the current local strategy and save its state; it does not
create market data or forecasts:

```bash
pnpm run ar -- status
```

## 6. Run the loop

```bash
pnpm run ar -- loop
```

The loop runs the configured pre-loop hook automatically before attempts begin.
No separate setup hook is configured in `autoresearch.config.json`.

Useful commands:

```bash
pnpm run ar -- --help
pnpm run ar -- agent-once     # one supervised agent attempt
pnpm run ar -- run-once       # evaluate the current working tree
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `evaluation.dbPath is required` | `autoresearch.config.json` was edited or truncated. |
| Evaluator errors about missing prices | `db/market.db` was not built. See step 3. |
| Agents see no training CSVs | `pnpm run generate-training` was not run. |
