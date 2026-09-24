# Trade Foundry AutoResearch

<!-- Agents: do not use README.md as your instruction source. Read AGENTS.md instead. -->

An **AutoResearch loop**: a harness that repeatedly hands a coding agent one
research hypothesis, lets it edit a single strategy file, scores the result
under a frozen walk-forward evaluator, and keeps the change only if it beats
the incumbent. The research domain here is a deterministic long-entry trading
strategy over ~30 ASX stocks, but the harness itself (`src/`) knows nothing
about trading.

The interesting part is not the strategy. It is the machinery around it:
fixed-budget research cycles that are allowed to fail, a frozen evaluator the
agent cannot edit, recorded falsifications so dead ends are not re-explored,
and overfitting checks (walk-forward folds, plateau robustness, PBO) that make
"the score went up" mean something.

> **Disclaimer.** This is a research and engineering project, not investment
> advice. Nothing here is a recommendation to buy or sell any security.
> Backtested and walk-forward results are hypothetical, carry no guarantee of
> future performance, and the strategies in this repository have not been
> traded with real money. Use at your own risk.

## How it works

```
   hypothesis.md  ──▶  agent edits strategy.ts  ──▶  frozen evaluator
   (direction,                                        (walk-forward folds,
    read-only)                                         3 portfolio profiles)
        ▲                                                     │
        │                                                     ▼
   scheduler rotates ◀── accept / reject ◀────────── score: <walkForwardScore>
   6 hypotheses,          vs. this hypothesis's
   retires stale ones     own incumbent
```

Each hypothesis is an independent lineage with its own incumbent strategy and
its own falsification log. Iteration agents cannot see other hypotheses, the
global champion, or historical scores — they only get their own direction
document and training data. A locally accepted strategy is promoted to the
root champion only when it beats the global best and clears the promotion
gates.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js >= 22.13 | Runs TypeScript directly via `tsx` and provides built-in SQLite access. |
| pnpm 11 | `corepack enable` picks up the pinned version. |
| A coding-agent CLI | `pi` by default; `codex` also supported. Optional — the harness runs without one, you just drive it manually. |

The backtest engine is vendored in `research/engine/` and imported directly.
Ordinary evaluation needs only these tools and locally imported market data.
Optional TimesFM preparation additionally uses `uv`, Python 3.12, and a local
model download; see [setup](SETUP.md#optional-timesfm-preparation).

## Quickstart

The repository ships **no market data and no actual trading strategy**. Install
creates ignored working files from neutral tracked templates, preserving any
existing local strategy or configuration. Obtain daily market data from
a provider whose licence permits your intended use, then import it locally.
The CSV must contain `symbol,date,open,high,low,close,adj_close,volume`.

```bash
pnpm install
pnpm run market:import -- ./path/to/licensed-prices.csv
pnpm run generate-training    # writes research/trade-long/training-data/*.csv
```

TimesFM is an optional, local-only forecast feature. It is disabled by
default. After importing data into the configured `db/market.db`, prepare a
pinned forecast campaign with `pnpm run research:refresh`; see
[`docs/timesfm-strategy-search.md`](docs/timesfm-strategy-search.md). This
workflow does not publish data, forecasts, model weights, campaign results, or
an actual strategy.

Then verify the checks and the evaluator:

```bash
pnpm run check                # typecheck
pnpm run test                 # unit tests
pnpm run eval                 # prints "score: <walkForwardScore>"
```

Seed the best-known score and inspect state:

```bash
pnpm run ar -- baseline --reset
pnpm run ar -- status
```

Run one supervised agent attempt, or the full loop:

```bash
pnpm run ar -- agent-once
pnpm run ar -- loop
```

`SETUP.md` covers the same ground step by step. The harness can be installed
and typechecked without market data; evaluation and research require the local
database described above.

## Choosing an agent

The default research agent is `pi`. Override provider and model for one
command without editing `autoresearch.config.json`:

```bash
pnpm run ar -- agent-once --agent codex --model gpt-5.5 --reasoning high
```

The same flags work for repeated runs:

```bash
pnpm run ar -- loop --agent pi --model <pi-model-name>
```

Both `--flag value` and `--flag=value` are accepted. CLI flags override
environment variables, which override the config file:

```bash
AUTORESEARCH_AGENT=codex AR_AGENT_MODEL=gpt-5.5 CODEX_REASONING_EFFORT=high pnpm run ar -- agent-once
```

Capture detailed agent events in the attempt log with `--diagnostics`.
Diagnostics contain compact lifecycle, tool target/status/duration, token
usage, and error events; raw prompts, reasoning deltas, file contents, and full
tool output are omitted.

## Scoring and acceptance

The evaluator prints `score: <walkForwardScore>`. The default evaluation runs
from 2019 through the latest available data in anchored annual periods. The
score is net profit from one continuous, cost-aware portfolio backtest, with
conservative, moderate, and aggressive profiles weighted 2/3/1. Independent
annual backtests are diagnostics rather than additive returns.

Promotion separately requires positive moderate-profile equity growth in at
least 60% of annual periods, positive full-period return, drawdown no higher
than 30% for each period and the full run, adequate trade participation, and
survival of falsification checks. These gates do not alter the score.

`pnpm run ar -- status` also reports campaign-level Probability of Backtest
Overfitting (PBO) on the largest cohort with an identical fold schema.

## The research loop

The loop runs for `loop.maxIterations`. Hypotheses operate in fixed-budget
research cycles; a cycle can terminate as inconclusive without manufacturing an
improvement, and a lineage retires after exhausting its cycle budget.

The scheduler maintains six hypotheses. It rotates after each bounded cycle and
suspends a lineage after its configured number of inconclusive cycles. Once all
six are exhausted, it archives the lowest-scoring incumbent and replaces or
breeds that slot. Champion promotion never consumes a slot.

Bounded parameter searches select the strongest immediate-neighbourhood
plateau, using the point score only after neighbourhood breadth and median
stability.

## Repository layout

```
src/                      domain-neutral harness (CLI, ledger, git, metrics)
research/engine/          vendored backtest engine, imported as a library
research/trade-long/      all trading-domain knowledge
  strategy-boilerplate.ts tracked neutral contract scaffold
  strategy.ts             ignored working strategy (created on install)
  eval.ts                 frozen evaluator
  training-data/          generated OHLCV CSVs (not committed)
scripts/                  market data, agent launcher, contract checks
docs/                     design and planning notes
test/                     unit tests
```

The boundary between `src/` and `research/` is strict: `src/` is domain-neutral
infrastructure and must contain no trading knowledge. Read the local `README.md`
in each directory before changing files there.

## Key files

- `AGENTS.md` — operational rules for automated agents.
- `autoresearch.example.json` — tracked default for the ignored local config.
- `autoresearch.config.json` — local harness commands, metric, scope, agent config.
- `src/README.md` — harness ownership and restrictions.
- `research/README.md` — research-domain ownership rules.
- `research/engine/README.md` — the vendored backtest engine and its API.
- `research/trade-long/strategy.md` — global champion notes.
- `research/trade-long/hypothesis.md` — staged hypothesis direction (frozen).
- `research/trade-long/falsifications.md` — staged negative findings.
- `research/trade-long/hooks/workflow.ts` — domain orchestration hook.

## Runtime artifacts

Scores, assignments, logs, snapshots, and evaluator artifacts stay under the
ignored `.autoresearch/` directory:

- `.autoresearch/trade-long/latest.json` — latest evaluator artifact.
- `.autoresearch/trade-long/accepted/` — accepted strategy artifacts.
- `.autoresearch/trials.jsonl` — attribution for every evaluation.
- `.autoresearch/qualified/` — qualified cycle candidates with manifests and
  evaluator evidence, for independent downstream validation.

## Contributing

See `CONTRIBUTING.md`. In short: `pnpm run check && pnpm run test` must pass,
and the `src/` / `research/` boundary is not negotiable.

## License

MIT — see `LICENSE`.

No market data is distributed with this repository. Import data from a provider
whose licence permits your intended use; see `SETUP.md` for the CSV contract.
