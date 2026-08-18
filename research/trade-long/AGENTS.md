# Agent Instructions

These instructions govern automated research runs in this repository.

## Operational Goal

Improve the configured AutoResearch metric by designing a robust, deterministic multi-stock trading strategy candidate. The strategy is evaluated across multiple stocks and might be applied to other stocks; it must not assume any specific stock, price range, or price level.

Research runs are bounded cycles. A cycle may finish without an improvement;
do not make arbitrary threshold changes merely to keep a lineage alive. Each
attempt must test one structural claim, documented in `strategy.md`, and the
harness—not the agent—owns budgets, scheduling, evaluation, and acceptance.

## Editable Scope

You may edit ONLY:
- `research/trade-long/strategy.ts` (the strategy candidate)
- `research/trade-long/strategy.md` (strategy notes and current hypothesis)

Do not edit evaluator, config, scripts, or database files.

## Falsification Ledgers

Two ledgers constrain your search:
- `research/trade-long/falsifications.md` — local negatives for the current
  hypothesis line.
- `research/trade-long/falsifications-global.md` — negatives proven across all
  research lines. These are hard constraints regardless of your hypothesis
  family. Append-only, evidence-backed entries only; never delete or weaken.

## Signal Screen

The evaluator hard-gates on a training-window signal screen: your raw entries
(next-open entry, close after maxHoldDays) must outperform the unconditional
same-horizon baseline. You can and should run it yourself with
`pnpm run strategy:signal-screen` — it uses training data only. A strategy
that fails the screen is scored negative no matter how it backtests.

## Data Boundary

Use only the provided training context, the active hypothesis card, the local
falsification ledger, and workspace strategy notes. Training context includes
per-stock CSVs plus market-context CSVs (`training-data/market-*.csv`: ASX 200
index, A-VIX volatility, and one-day-lagged S&P 500). At evaluation time the
same series are passed to `proposeTrade` as an optional second argument
(`MarketContext` — see the boilerplate); strategies must remain correct when it
is absent or a series is missing. Do not inspect holdout data,
private database files, evaluator scripts, global notes, or raw attempt
evidence.

## Market Context (Optional Tool)

The broad-market series (`index` = ASX 200, `volatility` = A-VIX) are passed to
`proposeTrade` as the optional second `MarketContext` argument. Using them is
entirely OPTIONAL — never required to pass any check — but they are available if
your hypothesis can benefit. A common use is a **regime / exposure filter**: a
long-only book cannot beat a falling benchmark while fully invested, so standing
aside (or sizing down) when the broad market is weak or volatility is elevated
can raise out-of-sample robustness. Prefer short-horizon reads (e.g. a 20-day
index trend, or volatility vs its own recent average) over slow 200-day filters
for a days-to-weeks swing book. If you use market context, the strategy MUST
still return valid, deterministic proposals when it is absent or a series is
missing. Only use it where it is consistent with the active hypothesis direction.

## Hypothesis Direction

Read `research/trade-long/hypothesis.md` before starting any work. This file
defines the exploration space and approach for the current hypothesis. Your
strategy must align with the direction described there. Do not ignore it or
pursue a fundamentally different approach.

## Structural Changes and Parameters

Use agent judgment for market mechanisms and structural strategy changes. Pure
numeric tuning belongs in the deterministic bounded parameter-search hook. Do
not spend structural attempts walking a threshold toward a higher private score.
Prefer a stable parameter region over an isolated maximum.

## Technical Contract

The strategy candidate in `strategy.ts` must adhere to the TypeScript contract exported in the boilerplate. Before writing any code, **read and understand the types and JSDoc comments directly inside `research/trade-long/strategy.ts`**.

## Trade Realism Guardrails

The evaluator rejects trades that do not clear practical execution constraints. Long proposals should leave room for slippage, brokerage, and ordinary daily noise:
- Minimum executable reward/risk after slippage and brokerage: `1.05`, measured
  from `entry.max` for longs and `entry.min` for shorts
- Minimum stop distance: `0.25%` of entry
- Minimum stop distance: `0.20 ATR` using the evaluator guardrail ATR window
- Maximum round-trip cost drag at the stop: `0.25R`

Do not rely on ultra-tight stops, marginal raw reward/risk, or distant targets whose only purpose is to pass a nominal R/R screen.
