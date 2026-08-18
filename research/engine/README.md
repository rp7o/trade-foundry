# Trading Strategy Engine (vendored)

The deterministic execution boundary shared by every strategy: given candles
and a strategy module exporting `proposeTrade(history)`, it simulates a
multi-symbol portfolio and reports capital, trades, and risk diagnostics.

Output schema: `trading-strategy-engine.v1`. Callers should reject unknown
schema versions rather than guess how to interpret fields.

## Why it lives here

This was previously a separate `trading-strategy-engine` checkout that had to
sit beside this repository, invoked as a subprocess. It is now vendored so the
repository is self-contained, and exposed as a library that callers import.

It sits under `research/` rather than `src/` because it is trading-domain
knowledge, and `src/` must stay domain-neutral.

## Usage

```js
import { runPortfolioBacktest } from "../engine/index.mjs";

const result = await runPortfolioBacktest(context, {
  engineRoot: ".",
  side: "long",
  strategyPath: "research/trade-long/strategy.ts",
});
```

A backtest is CPU-bound and fully synchronous once started, so running several
on the calling thread serialises them. Use the worker form for fold sweeps and
cap the concurrency yourself:

```js
import { runPortfolioBacktestInWorker } from "../engine/index.mjs";
```

`research/trade-long/walkforward.ts` does this, limiting concurrency to
`ENGINE_CONCURRENCY`.

## Files

- `index.mjs` / `index.d.mts` — public entry point and its typed contract.
- `portfolio-backtest.mjs` — the simulation. Vendored from the upstream
  `bin/portfolio_backtest_runner.mjs`; the logic is unchanged, but the CLI
  entry (argv + stdin) and exit (stdout) were replaced by a function signature
  and a return value.
- `worker-pool.mjs` / `backtest-worker.mjs` — run one backtest on a worker thread.
- `market-context.mjs` — aligns a market-index series to a symbol's candles.
- `strategy-contract.ts` — CLI that validates a strategy's `proposeTrade`
  shape. Run via `pnpm run strategy:shared-contract`.

Upstream also carried single-symbol runners (`bin/runner.mjs`,
`bin/backtest_runner.mjs`) used by a different consumer. They are not vendored
because nothing here calls them.

## Changing this code

Treat it as a frozen boundary. Every score recorded in this repository was
produced by this simulation; changing its numerics invalidates comparisons
against past results. If you must, bump `SCHEMA_VERSION` and say so loudly.
