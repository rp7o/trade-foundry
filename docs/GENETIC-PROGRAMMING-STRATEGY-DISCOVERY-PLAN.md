# Genetic Programming Strategy Discovery Project Plan

## Purpose

Build a separate greenfield project that discovers deterministic trading
strategies through genetic programming (GP). It must evolve interpretable,
contract-valid strategy programs under a fixed evaluation budget and export
qualified candidates for deeper independent validation elsewhere.

This is an alternative discovery engine, not an extension of the `trade-foundry`
AutoResearch codebase. Reuse data formats or strategy contracts only through
explicit versioned interfaces; do not couple the projects through source imports.

## Recommended Technical Direction

Use strongly typed genetic programming over a constrained strategy DSL. Do not
evolve arbitrary TypeScript source. A typed DSL makes every generated program
valid by construction, limits dangerous lookahead/state access, enables
complexity control, and permits structural hashing and reproducible mutation.

Suggested implementation stack: TypeScript on Node.js, a SQLite or Parquet data
adapter, worker threads/processes for parallel evaluation, and JSON artifacts.
The evaluator/backtest engine should be injected behind an interface so the GP
project can use a local fast evaluator initially and export candidates to a
separate system later.

## Scope and Non-goals

The project owns:

- the typed strategy DSL and executable interpreter/compiler;
- population initialization, selection, crossover, mutation, and elitism;
- deterministic historical fitness evaluation;
- trial lineage, caching, checkpointing, and reproducibility;
- robustness diagnostics and qualified candidate export.

It does not own paper trading, brokerage integration, live orders, portfolio
operations, UI, or LLM-generated trading decisions. An LLM may optionally name
or explain evolved programs after selection, but it must not participate in
routing, mutation, evaluation, or acceptance.

## Strategy DSL

### Types

Start with a compact type system:

- `Price`, `Return`, `Ratio`, `Volatility`, `VolumeRatio`, `Duration`
- `Bool`, `Direction`, and `Optional<T>`
- `Series<T>` for historical features and scalar values at the signal timestamp
- `EntryRule`, `ExitRule`, `StopRule`, `TargetRule`, `Strategy`

Prevent invalid combinations such as comparing a price directly with a return
or using a Boolean as a stop distance.

### Primitive set

Initial terminals and functions should be deliberately small:

- OHLCV and optional broad-market OHLCV histories;
- lagged values and rolling min/max/mean/median;
- SMA/EMA, ATR, rate of change, range position, volatility, and relative volume;
- typed arithmetic, comparisons, `and`, `or`, `not`, and bounded conditionals;
- cross-above/cross-below and within-band predicates;
- volatility-scaled stop/target distances and bounded hold duration;
- optional market-regime predicates.

All observations must be available at signal time. No symbol constants, future
data, wall-clock time, prior trade outcome, portfolio state, or randomness may
appear in a strategy.

### Genome

Represent a strategy as an immutable typed abstract syntax tree with separate
components:

```text
Strategy
├── regime filter: Bool
├── entry rule: Bool
├── stop rule: Price or volatility-scaled distance
├── target rule: Price or reward multiple
└── exit rule: Bool plus maximum hold
```

Canonicalize commutative nodes and constants before hashing. Store a stable
serialized form and generate human-readable pseudocode and executable code from
the same AST.

## Evolution Algorithm

Begin with a deterministic `(mu + lambda)` evolutionary algorithm rather than
a more complex island system.

Recommended initial defaults, configurable and recorded per run:

- population `mu = 200`;
- offspring `lambda = 800` per generation;
- maximum 50 generations or 40,000 unique evaluations;
- tournament selection of size 5;
- 5% unchanged elites;
- offspring mix: 45% typed subtree mutation, 30% typed crossover, 15% constant
  mutation, 10% fresh random immigrants;
- maximum tree depth 8 and maximum node count 80;
- fixed random seed per replicate.

These are engineering starting points, not scientifically privileged values.
Run multiple independent seeds instead of trusting one evolutionary trajectory.

### Initialization

Use ramped half-and-half typed tree generation across permitted depths. Seed a
minority of the first population with simple known archetypes—trend, breakout,
pullback, mean reversion—but ensure most individuals are generated independently.
Record seed provenance so seeded and novel discoveries can be distinguished.

### Validity and repair

Prefer operators that preserve types and bounds by construction. After mutation:

- simplify constant expressions and redundant predicates;
- clamp numeric constants to declared domains;
- reject lookahead or insufficient-history programs;
- reject impossible stop/target geometry;
- reject semantic duplicates by canonical hash.

Do not repeatedly repair arbitrary invalid trees; excessive invalidity indicates
that the grammar or operator needs redesign.

### Diversity

Prevent convergence to cosmetic variations of one rule:

- deduplicate canonical ASTs;
- track behavioural fingerprints from signal dates across a fixed probe set;
- penalize or reject near-identical signal vectors;
- maintain novelty niches by entry-rule behaviour;
- inject fresh random individuals each generation;
- preserve a Pareto archive, not only the highest scalar fitness individual.

## Evaluation Design

### Data splits

Use nested chronological evaluation:

- development/training periods for evolution;
- inner validation periods for selection and parameter constants;
- outer walk-forward periods never used for reproductive fitness;
- a sealed final discovery holdout used once per completed campaign.

Add symbol-level separation: some symbols/sectors should be absent from
reproductive fitness and used only in outer evaluation. Persist exact dataset,
universe, corporate-action, and split hashes in every artifact.

### Backtest contract

The evaluator must enforce next-bar executable entries, costs, slippage,
liquidity, position sizing, concurrent-position limits, stops, targets, gaps,
and maximum hold. It must return trades and equity paths, not only a score.

Fitness evaluation must be deterministic for a genome, dataset, configuration,
and seed. Cache by the combined hash of those inputs.

### Multi-objective fitness

Use constrained Pareto optimization rather than one unconstrained profit score.
Hard-invalid individuals receive no fitness. Viable individuals are compared on:

- median out-of-sample fold return or risk-adjusted return;
- worst-fold outcome/downside risk;
- drawdown;
- signal breadth across time and symbols;
- alpha versus benchmark and matched random entry;
- parameter/noise stability;
- program complexity;
- novelty relative to the archive.

Use NSGA-II-style nondominated ranking and crowding distance, or an equivalent
deterministic Pareto method. If a scalar is required for tournament tie-breaking,
derive it only after constraints and Pareto rank.

### Multiple-testing control

Every unique genome evaluation is a trial. Report total generated, valid,
unique, selected, outer-tested, and holdout-tested counts. At campaign end,
calculate selection-bias diagnostics such as Probability of Backtest Overfitting
and Deflated Sharpe Ratio using all eligible candidates, not only winners.

Never evolve against outer or sealed holdout outcomes. A failed campaign is a
valid outcome and must not be resumed against the same sealed holdout.

## Repositories and Modules

Suggested initial layout:

```text
src/
  cli.ts
  config.ts
  dsl/
    types.ts
    ast.ts
    primitives.ts
    generate.ts
    simplify.ts
    serialize.ts
    compile.ts
  evolution/
    population.ts
    initialize.ts
    select.ts
    crossover.ts
    mutate.ts
    novelty.ts
    pareto.ts
    engine.ts
  evaluation/
    contract.ts
    data.ts
    splits.ts
    evaluator.ts
    cache.ts
    robustness.ts
  artifacts/
    ledger.ts
    checkpoint.ts
    export.ts
test/
examples/
```

Keep the evolution engine independent of trading semantics where practical, but
do not abstract prematurely for unrelated problem domains.

## CLI Contract

Provide non-interactive commands suitable for another agent or automation:

```text
gp-strategy validate-config <file>
gp-strategy baseline --config <file>
gp-strategy evolve --config <file> --seed <n>
gp-strategy resume --run <id>
gp-strategy status --run <id>
gp-strategy evaluate --genome <file> --split <name>
gp-strategy finalize --run <id>
gp-strategy export --run <id> --candidate <id> --out <dir>
```

`evolve` must checkpoint atomically at each generation. `resume` must reproduce
the same subsequent population as an uninterrupted run. `finalize` performs
outer/campaign evaluation under explicit policy and must not silently continue
evolution.

## Artifacts

Each run must preserve:

- immutable configuration and data hashes;
- random seeds and software version;
- every unique genome and parent/operator lineage;
- raw fitness components and constraint failures;
- behavioural fingerprints and canonical hashes;
- generation summaries and Pareto fronts;
- checkpoints and termination reason;
- campaign diagnostics and sealed-holdout access record.

Candidate export should contain a manifest, canonical AST, generated readable
strategy source, feature/lookback requirements, evidence summary, limitations,
and all provenance needed for an independent evaluator.

## Implementation Phases

### Phase 1: DSL and interpreter

Implement types, AST, primitives, generation, canonical serialization,
simplification, and execution against candle history. Add property tests proving
type safety, determinism, no lookahead, bounded depth, and serialization
round-trips.

Success: generate and execute 10,000 random strategies without an invalid type,
lookahead access, or nondeterministic result.

### Phase 2: Evaluator and baselines

Implement data/split contracts and integrate a realistic deterministic
backtester. Establish no-trade, buy-and-hold, random-entry, and simple seeded
strategy baselines.

Success: repeated evaluation is byte-for-byte reproducible, and deliberately
leaky or impossible strategies fail loudly.

### Phase 3: Evolution core

Implement population initialization, typed operators, tournament selection,
elitism, deduplication, Pareto ranking, budgets, and checkpoints.

Success: controlled synthetic fitness problems demonstrate improvement,
diversity retention, exact budget enforcement, and deterministic resume.

### Phase 4: Robustness and campaign protocol

Add behavioural novelty, parameter/noise perturbation, nested walk-forward
evaluation, symbol holdbacks, campaign finalization, and selection-bias reports.

Success: reproductive fitness cannot access outer/holdout results, and all
generated/evaluated trial counts reconcile exactly.

### Phase 5: Candidate export

Generate executable strategy code and complete manifests. Test exported
strategies through an independent contract runner rather than the GP interpreter.

Success: an exported candidate produces identical signals in both runtimes and
can be consumed without importing this project's internals.

## Test Strategy

- Unit tests for every primitive and genetic operator.
- Property-based tests for typed generation, mutation, crossover, and AST limits.
- Golden tests for serialization, hashes, compilation, and artifacts.
- Leakage tests for every data-access boundary.
- Reproducibility tests across fresh and resumed runs.
- Metamorphic tests under price scaling and symbol renaming.
- Synthetic-landscape tests where the known optimum and deceptive local optima
  verify selection behaviour.
- Integration tests covering a small complete campaign and export.
- Failure tests for corrupt checkpoints, incompatible schemas, exhausted
  budgets, absent data, and evaluator crashes.

## Project Completion Criteria

The first usable release is complete when it can run multiple seeded,
budget-limited GP campaigns; generate only typed deterministic strategies;
reproduce or resume every run; prevent evaluation leakage; retain a diverse
Pareto archive; account for every trial; quantify campaign selection risk; and
export independently executable candidates with complete provenance.

The success criterion is not that it necessarily discovers a profitable
strategy. It is that any claimed discovery is reproducible, interpretable,
budget-accounted, and difficult to explain as grammar invalidity, leakage,
duplicate behaviour, or best-of-many backtest luck.
