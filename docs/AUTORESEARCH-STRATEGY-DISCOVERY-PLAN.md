# Bounded AutoResearch Strategy Discovery Plan

## Decision

Retain AutoResearch as this project's strategy-discovery framework, but replace
open-ended score hill-climbing with bounded, hypothesis-led experiments.

The agent should be used for judgment: proposing market mechanisms, designing
structural variants, interpreting falsifications, and implementing strategy
logic. Deterministic code should own scheduling, budgets, parameter search,
acceptance, bookkeeping, and reproducibility.

This project discovers candidates. Deeper validation, portfolio simulation,
paper trading, and deployment belong to the separate `shareanalysis` project.

## Problem Being Fixed

The current loop rewards any local score improvement and can repeatedly query
the same evaluation folds. Requiring the agent to continue until it improves
would convert random evaluation noise into apparent progress. It would also
hide the number of failed trials behind each accepted result.

The revised system must:

- allow a research cycle to conclude with no improvement;
- cap the evaluations consumed by each hypothesis and structural idea;
- separate semantic strategy invention from numeric parameter optimization;
- count every evaluated candidate, including rejected and tuned variants;
- promote only statistically and economically meaningful improvements;
- preserve several qualified, structurally different discoveries rather than
  treating one scalar-score champion as the only useful output.

## Non-goals

- Do not add paper trading, live execution, portfolio allocation, or production
  readiness checks.
- Do not move trading-domain policy into `src/`.
- Do not allow agents to edit evaluators, schedules, budgets, or ledgers.
- Do not implement generic AutoML or unconstrained strategy generation.
- Do not guarantee that every cycle produces a winner.

## Core Research Unit

Replace the implicit unit "one agent attempt" with an explicit research cycle.
One cycle tests one preregistered structural claim.

Each cycle records:

- cycle ID, hypothesis lineage, forecasting family, and parent strategy;
- market mechanism and why it could create an edge;
- expected regime, holding horizon, and failure regime;
- exactly one structural question being tested;
- permitted parameter names and ranges;
- falsification conditions defined before evaluation;
- structural-attempt and parameter-evaluation budgets;
- all evaluated candidate IDs and results;
- terminal outcome: `qualified`, `falsified`, `inconclusive`, or `invalid`.

Store cycle records as versioned JSON under the existing hypothesis directories.
Keep human-readable rationale in Markdown. Runtime logs and bulky artifacts can
remain under `.autoresearch/`; durable conclusions remain Git-tracked.

## Search Policy

### 1. Hypothesis formulation

The scheduler selects or creates a hypothesis family. Before editing code, the
agent must write a cycle proposal conforming to a deterministic schema. A hook
validates that the proposal contains one testable structural change, explicit
falsification conditions, and bounded parameters.

Reject proposals that merely say "improve the score", contain symbol-specific
rules, combine several unrelated changes, or only tweak numeric thresholds.

### 2. Structural exploration

Give a cycle a fixed default budget of 8 structural attempts. Make the budget
configurable, but never let the agent extend it. Each attempt may change
strategy structure and its notes while remaining inside the active hypothesis
direction.

An attempt may be rejected, accepted as the cycle incumbent, or recorded as a
falsification. Exhausting the budget without qualification is a valid result.

### 3. Parameter optimization

When a structural candidate passes basic gates, extract only its declared
numeric parameters. Run deterministic coarse search with a fixed evaluation
budget, followed by local stability analysis around the best region.

Initially use seeded random or Latin-hypercube sampling rather than an elaborate
optimizer. These behave predictably on discontinuous backtest objectives. Add
Bayesian optimization only if evaluation cost later justifies the complexity.

Select a representative point from a broad stable region, not the isolated
maximum. Reject structures whose performance collapses under small neighbouring
parameter changes.

### 4. Cycle termination

A cycle ends when any of these occurs:

- its complete budget is consumed;
- its preregistered falsification condition is met;
- a candidate clears all qualification requirements;
- repeated invalid implementations demonstrate that the proposal is not
  executable under the strategy contract.

Never loop until improvement. Additional research requires a new cycle with a
new structural question and a fresh explicit budget.

## Evaluation and Acceptance

Keep the existing execution, walk-forward, signal-screen, alpha, breadth,
perturbation, and holdout machinery initially. Change how its evidence is used.

### Constraint-first qualification

A candidate must first pass hard requirements for:

- contract and premise validity;
- executable trade geometry and costs;
- minimum sample and fold breadth;
- signal timing versus the unconditional baseline;
- alpha versus matched random entry;
- tolerable drawdown and concentration;
- parameter-neighbourhood stability;
- no disqualifying catastrophic fold.

Only candidates clearing the constraints are ranked. Do not turn failed hard
requirements into compensating terms inside one score.

### Meaningful improvement

Remove microscopic acceptance as evidence of progress. Candidate acceptance
must exceed both:

- a configured economic effect floor; and
- an uncertainty threshold derived from the incumbent/candidate fold and trade
  distributions.

Reuse and strengthen the existing bootstrap significance path. Acceptance must
compare candidate and incumbent directly using paired fold evidence where
possible. Record the reason and uncertainty estimate in the artifact.

### Trial accounting

Create a durable trial ledger containing every evaluator invocation and its
origin: agent structure, parameter sample, rescore, baseline, or manual run.
Deduplicate identical strategy/data/config hashes, but do not erase repeated
selection decisions.

Artifacts must report lineage and campaign trial counts. Add a campaign-level
selection-bias diagnostic, such as Deflated Sharpe Ratio or Probability of
Backtest Overfitting, as a qualification diagnostic rather than a score target.

### Qualified archive

Keep the global champion for compatibility, but add a qualified strategy
archive. Admit a strategy only when it clears qualification and is materially
different from archived strategies by logic fingerprint and trade overlap.

An archive entry contains strategy source, notes, cycle card, parameter ranges,
selected parameters, hashes, full trial ancestry, evaluator artifact, known
failure regimes, and discovery timestamp. Exporting these artifacts is the
boundary with `shareanalysis`.

## Scheduler Changes

Replace consecutive-non-improvement scheduling with budgeted cycle scheduling.

The scheduler should:

1. ensure multiple forecasting families remain active;
2. assign an initial equal cycle budget;
3. stop exhausted or falsified cycles;
4. allocate a new cycle only to a new structural question;
5. retire families that exhaust a configured number of cycles without a
   qualified candidate;
6. preserve negative findings before replacement;
7. prefer diversity and unresolved uncertainty over tiny incumbent gains.

Do not let performance alone monopolize research slots. The scheduler is a
deterministic policy; the model may propose candidates but may not route itself.

## Proposed Implementation Sequence

### Phase 1: Cycle contract and budgets

- Add cycle types and schema beside `research/trade-long/hypotheses.ts`.
- Extend hypothesis metadata with active cycle ID and consumed budgets.
- Add deterministic validation and lifecycle transitions.
- Update the workflow hook to create, execute, and close cycles.
- Update agent instructions to require a preregistered structural proposal.
- Add fixtures covering success, exhaustion, falsification, and invalid cycles.

Success: a loop terminates after its configured budget and can finish honestly
with no improvement.

### Phase 2: Trial ledger and meaningful acceptance

- Record every unique evaluation with source, hashes, lineage, cycle, and trial
  counts.
- Replace the tiny delta rule with effect-size and uncertainty requirements.
- Emit paired candidate/incumbent diagnostics.
- Rebuild status output around cycle state rather than consecutive failures.

Success: every accepted result exposes exactly how many adaptive evaluations
preceded it, and score noise cannot qualify as improvement.

### Phase 3: Parameter stability search

- Define a small parameter declaration contract for strategy candidates.
- Make parameter search seeded, bounded, and fully artifacted.
- Evaluate neighbourhood stability and select a plateau representative.
- Prevent agents from consuming structural attempts on numeric-only edits.

Success: rerunning a cycle produces identical parameter samples and selection;
  isolated maxima are rejected.

### Phase 4: Qualified diverse archive

- Add immutable qualified-candidate manifests.
- Calculate trade-overlap and structural fingerprints.
- Preserve champion compatibility while allowing multiple discoveries.
- Add an explicit export/installation manifest for `shareanalysis` to consume.

Success: two genuinely different qualified strategies can coexist and be
handed off without treating the lower-scoring one as a failed discovery.

### Phase 5: Campaign diagnostics

- Add PBO/selection-bias diagnostics using the complete trial ledger.
- Report results by cycle, family, regime, symbol, and time fold.
- Add a deterministic campaign summary command.

Success: a reviewer can distinguish genuine repeated evidence from the best of
many noisy trials.

## Testing Requirements

- Unit-test every lifecycle transition and budget boundary.
- Test that rejected, invalid, parameter, and rescore evaluations all count.
- Test deterministic hashes, seeds, schedules, and parameter samples.
- Test that an agent cannot alter budgets or evaluator configuration.
- Test acceptance at both sides of effect-size and uncertainty boundaries.
- Test that archive admission rejects duplicates and permits diverse survivors.
- Keep existing strategy contract and evaluator regression tests passing.

## Completion Criteria

The redesign is complete when an unattended run can consume a declared budget,
produce a reproducible record of every trial, terminate without improvement,
preserve evidence-backed falsifications, qualify only meaningful stable results,
and export multiple distinct candidate strategies for independent evaluation by
`shareanalysis`.
