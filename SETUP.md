# Setup

Step-by-step first run. See `README.md` for what this project is.

## Private research workspaces

Keep shared development in this repository and track your strategies, configs,
hypotheses and falsification notes in a separate private Git repository. The
workspace links to the engine's scripts, so engine changes apply immediately;
there is no engine copy to merge. This optional setup uses filesystem symlinks
(Linux/macOS; Windows requires symlink support). Ordinary local setup is unchanged.

From the engine checkout:

```sh
pnpm run workspace -- init ../my-research
pnpm run workspace -- use ../my-research
pnpm run workspace -- status
```

The first command creates a local Git repo with neutral research files and no
remote. Copy your own working files into it, inspect `git status` there, and commit
them. Its ignore rules exclude shared code links, databases, forecasts, logs and
bulky runtime artifacts. Keep it outside the public engine checkout. Add a private
remote yourself if you want hosted backup; the harness never configures or pushes
a private remote automatically.

Use the normal commands from the engine checkout:

```sh
pnpm run market:sync-local
pnpm run research:refresh --dry-run
pnpm run eval
pnpm run research:loop --commit-accepted
```

They use the selected workspace's `autoresearch.config.json`, working strategy,
`db/`, training CSVs and `.autoresearch/`. `timesfm-research.json` in the private
workspace contains your forecast preparation settings. Accepted commits go into
the private repo. Commit engine improvements in the public checkout as usual.
`pnpm run check` and `pnpm test` remain engine development checks; `strategy:*`
commands check the selected strategy. Raw `pnpm exec`, `tsx`, Python and shell
commands are not redirected: run those from the private workspace, or use
`pnpm run workspace -- run <command> <args>`.

Selection is stored in the ignored `.trade-foundry-workspace` file. Override it
for one command with `TRADE_FOUNDRY_WORKSPACE=/path/to/workspace`; use
`TRADE_FOUNDRY_WORKSPACE=.` to check the public starter. `pnpm run workspace -- local`
clears the saved selection. Do not switch workspaces or edit shared engine code
while a loop is running.

After cloning your private repo on another machine, install dependencies in the
engine checkout, then run:

```sh
pnpm run workspace -- attach ../my-research
pnpm run workspace -- use ../my-research
```

Generated links reconnect to the current engine checkout on each routed command.
`engine.json` records the engine revision at initialization; update it when saving
a research milestone. Each new evaluation artifact also records the actual engine
revision, dirty-tree flag, diff fingerprint, strategy hash and config hash. Use a
committed engine revision for reproducible milestones; a dirty-tree fingerprint
alone cannot reconstruct uncommitted source changes.

Back up ignored `db/` and `.autoresearch/` separately if you need the exact market
snapshot, forecast caches, champion state and run archives. When migrating an old
checkout, copy these along with `research/trade-long/hypotheses/`, working strategy,
notes, ledgers, training data and config. Copy data only while no loop, importer or
forecast process is writing. Preserve the old checkout as an archive until the new
workspace has been evaluated successfully.

## 1. Prerequisites

- **Node.js >= 22.13** and **pnpm 11** (`corepack enable` picks up the pinned version).
- **A coding-agent CLI** — `pi` by default, `codex` also supported. Optional:
  everything except `ar -- agent-once` and `ar -- loop` works without one.

## 2. Install

```bash
pnpm install
```

Install creates local, ignored strategy, hypothesis, ledger, and config files
from tracked templates only when they are missing. It never overwrites existing
research. If install scripts were skipped, run `pnpm run init:local`.

### Guided setup

Run `pnpm run setup` after install. Choose the current workspace, the engine's
local ignored files, or a new private research repo. Review the proposed config
before saving. The wizard configures one exchange/currency, stock symbols,
optional same-market index/volatility context, database/source paths, capital,
position and liquidity limits, execution costs, agent provider/model, timeouts
and attempt budget. All monetary inputs and prices must use the same currency;
the evaluator does not perform FX conversion.

New workspaces retain the template's training period and anchored 2019-onward
annual evaluation. Setup does not tune dates, risk profiles or acceptance gates
against results. Existing workspaces retain their configured dates. Once a
workspace has research results, changing scoring assumptions through setup
requires a new workspace; agent/model and run-budget changes remain allowed.

```sh
pnpm run setup --dry-run  # answer questions and preview, without writes
pnpm run setup --check    # validate current config, dependencies and data coverage
```

Missing market data does not prevent saving a config, but blocks the optional
baseline. Import adjusted OHLCV prices or supply the configured SQLite source and
run `pnpm run market:sync-local`, then rerun `setup --check`. Optional baseline
preparation checks the strategy, exports training data, and seeds a baseline only
when one does not already exist. A neutral starter's zero score is expected.
Setup never starts the agent loop. Existing strategy files and run history are
preserved; config backups are stored in `.autoresearch/setup/`.

TimesFM is an explicit opt-in request, recorded as `setup.timesfmRequested`.
It stays inactive until `pnpm run research:refresh` generates and validates a
campaign. Setup downloads no models and runs no inference. An existing enabled
campaign is preserved unless explicitly disabled in a workspace without results.

For repeatable non-interactive setup, create an ignored `setup.answers.json`:

```json
{
  "mode": "new-private",
  "workspace": "../my-research",
  "exchange": "ASX",
  "currency": "AUD",
  "symbols": ["CBA.AX", "BHP.AX", "WBC.AX"],
  "initialCapital": 25000,
  "maxPositions": 2,
  "minAvgTradedValue": 2000000,
  "brokeragePerSide": 3,
  "slippageBpsPerSide": 5,
  "provider": "pi",
  "model": "",
  "maxIterations": 20,
  "timesfm": false,
  "baseline": false
}
```

```sh
pnpm run setup --answers setup.answers.json --dry-run
pnpm run setup --answers setup.answers.json --yes
```

Only supplied answers change existing values. Use `"mode": "current"` for
reruns. `--no-select` saves settings without changing the saved workspace
selection; `TRADE_FOUNDRY_WORKSPACE` still overrides that selection. Setup does
not create Git commits or configure/push remotes.

The public config template leaves TimesFM disabled. `research:refresh` enables
its selected campaign only in your ignored `autoresearch.config.json`.
Because working strategy files are ignored, `--commit-accepted` is unavailable
in this public checkout; use a private repository that tracks them if you want
Git commits of accepted candidates. Research snapshots still live locally in
`.autoresearch/`.

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
