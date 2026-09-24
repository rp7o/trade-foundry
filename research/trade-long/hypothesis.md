# Hypothesis Card

## Claim

Choose a testable market mechanism before starting an agent run. Describe the
proposed entry and exit logic here; the neutral strategy makes no trades.

## Signal Family

unassigned

## Allowed Features

- Single-symbol OHLCV history supplied to `proposeTrade`.
- Optional current-date market context and TimesFM forecast when configured.

## Forbidden Shortcuts

- Future candles, outcome data, symbol-specific constants, and random behavior.

## Tunable Parameters

Document the parameters of the chosen hypothesis here.

## Local Constraints

None yet.

## Exhaustion Criteria

Define the evidence that would reject the chosen hypothesis here.
