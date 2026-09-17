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

If a local application database at `db/prices.db` contains newer rows, sync
them into the research database without replacing it:

```bash
pnpm run market:sync-local
```

The sync uses each symbol's current maximum date in `db/market.db`, so new
dates are appended and overlapping dates are skipped. Use `--after YYYY-MM-DD`
to set an explicit lower bound; the target maximum date remains the effective
cutoff. The source database is read-only, and all rows are validated before
the target transaction begins.

To update the database later, export new or overlapping rows in the same format
and run `market:import` again. Existing `(symbol, date)` rows are updated.
The importer is the only market-data acquisition path; the repository does not
depend on a particular data vendor.

The universe comes from `research/trade-long/universe.csv`, and the evaluation
symbols and training cutoff come from the `evaluation` block in
`autoresearch.config.json`. Agents only ever see data up to
`evaluation.trainingEnd`; the walk-forward folds and the locked holdout that
actually score candidates lie strictly after that date.

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

With the boilerplate strategy this evaluates to `score: 0.00`, because it makes
no trades and fails the evaluator's trade-count gate. Check the saved state:

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

## Trying it without market data

The toy example optimises a single number and needs no data, no engine, and no
agent:

```bash
pnpm run example:simple
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `evaluation.dbPath is required` | `autoresearch.config.json` was edited or truncated. |
| Evaluator errors about missing prices | `db/market.db` was not built. See step 3. |
| Agents see no training CSVs | `pnpm run generate-training` was not run. |
