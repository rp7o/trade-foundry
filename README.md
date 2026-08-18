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

There is nothing else to install. The backtest engine is vendored in
`research/engine/` and imported directly, so a clone plus `pnpm install` has
everything it needs to score a strategy.

## Quickstart

The repository ships **no market data**. Obtain daily market data from a
provider whose licence permits your intended use, then import it locally. The
CSV must contain `symbol,date,open,high,low,close,adj_close,volume`.

```bash
pnpm install
pnpm run market:import -- ./path/to/licensed-prices.csv
pnpm run generate-training    # writes research/trade-long/training-data/*.csv
```

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

`SETUP.md` covers the same ground step by step. To see the harness working
without any trading setup at all, run the toy example — it optimises a single
number and needs no market data:

```bash
pnpm run example:simple
```

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

The evaluator prints `score: <walkForwardScore>`. Candidates are scored on the
latest rolling three years of walk-forward folds (defined in
`autoresearch.config.json` under `evaluation`). Each fold is scored across
conservative, moderate, and aggressive portfolio profiles using 2/3/1
weighting, and the emitted score is the median overall-return score.

Promotion separately requires positive overall returns in at least 40% of folds
and drawdown no higher than 30%. Alpha, random-entry comparisons, trade-count
floors, signal-screen checks, and holdout checks do not participate in the
score.

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
  strategy.ts             global champion
  eval.ts                 frozen evaluator
  hypotheses/<id>/        per-hypothesis incumbent, direction, falsifications
  training-data/          generated OHLCV CSVs (not committed)
scripts/                  market data, agent launcher, contract checks
examples/simple/          toy research program, no market data needed
docs/                     design and planning notes
test/                     unit tests
```

The boundary between `src/` and `research/` is strict: `src/` is domain-neutral
infrastructure and must contain no trading knowledge. Read the local `README.md`
in each directory before changing files there.

### Committed research history

`research/trade-long/hypotheses/` contains the real output of past runs —
accepted incumbents, per-cycle evidence, and falsification logs. These are
committed deliberately as a record of what the loop actually explored and
rejected. They are not required to run anything.

## Key files

- `AGENTS.md` — operational rules for automated agents.
- `autoresearch.config.json` — harness commands, metric, scope, agent config.
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
