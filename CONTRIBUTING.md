# Contributing

Thanks for taking a look. This is a research project, so the bar is less
"ship features" and more "don't quietly break the thing that makes results
trustworthy."

## Getting set up

Follow `SETUP.md`. The market database is a one-time local build; nothing in
this repository ships price data.

## Before you open a pull request

```bash
pnpm run check
pnpm run test
```

Both must pass. If you touched the strategy, also run:

```bash
pnpm run strategy:check
pnpm run strategy:contract
pnpm run strategy:premise
```

## The architecture boundary

This is the one rule that is not negotiable:

- **`src/` is domain-neutral.** It is a generic AutoResearch harness. No
  trading concepts, no ticker symbols, no notion of a price or a trade.
- **`research/` owns all domain knowledge.** Strategies, evaluators,
  hypotheses, market wiring.

A change that leaks trading vocabulary into `src/` will be asked to move, even
if it works. Each directory has its own `README.md` describing what it owns;
read the local one before editing.

## Things to be careful with

- **The evaluator is frozen.** `research/trade-long/eval.ts` and the fold
  schema in `autoresearch.config.json` define what a score means. Changing them
  invalidates every recorded score in the repository. If you have a genuine
  reason to change evaluation, say so explicitly in the PR description and
  expect a conversation about re-baselining.
- **Don't commit market data.** `db/` and `research/trade-long/training-data/`
  are ignored on purpose. See the note in `.gitignore`.
- **Don't commit secrets.** No API keys, no `.env` files, no agent credentials.
  If you add a new agent integration, read its key from the environment and
  document the variable name.
- **The tracked strategy is intentionally neutral.** Do not commit private
  strategy candidates, market data, forecast caches, campaign IDs, reports, or
  model weights. Strategy edits are tracked by Git, so use a separate local
  clone without a remote for personal research when the result should stay
  private.

## Reporting a strategy result

If you are contributing a strategy change rather than harness code, include
the evaluator output (`score:` line), the fold breakdown, and what you
falsified along the way. Do not include private data or an unpublished actual
strategy in the public repository.

## Optional TimesFM feature

TimesFM preparation is local and opt-in. Follow
[`docs/timesfm-strategy-search.md`](docs/timesfm-strategy-search.md); do not
commit generated forecasts, model weights, campaign reports, or local
configuration containing campaign IDs.
