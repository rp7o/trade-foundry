#!/usr/bin/env bash
set -euo pipefail

HIDDEN_DIR="$(mktemp -d /tmp/autoresearch-agent-hidden.XXXXXX)"

cleanup() {
  # Automatically remove any temp training scripts, compiled js files, or sandbox folders
  find . -maxdepth 1 -name "train-*.mjs" -delete
  find . -maxdepth 1 -name "*.js" -delete
  find research/trade-long -maxdepth 1 -name "*.js" -delete
  if [ -d "sandbox" ]; then
    rm -rf "sandbox"
  fi
  if [[ -d "${HIDDEN_DIR}/hypotheses" ]]; then
    mkdir -p research/trade-long
    mv "${HIDDEN_DIR}/hypotheses" research/trade-long/hypotheses
  fi
  rmdir "$HIDDEN_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Iteration agents receive only the staged hypothesis. Other hypotheses and raw
# evidence are removed from their visible tree for the duration of the run.
if [[ -d research/trade-long/hypotheses ]]; then
  mv research/trade-long/hypotheses "${HIDDEN_DIR}/hypotheses"
fi
# Create sandbox directory for agent scratch work
mkdir -p sandbox

# ---------------------------------------------------------------------------
# Mode selection: refine (start from best), explore (start from boilerplate),
# or auto (80% refine / 20% explore).  Set via AUTORESEARCH_MODE env var.
# ---------------------------------------------------------------------------
MODE="${AUTORESEARCH_MODE:-auto}"

resolve_best_dir() {
  local accepted_dir=".autoresearch/accepted"
  if [[ ! -d "$accepted_dir" ]]; then
    return 1
  fi
  local latest
  latest="$(ls -1t "$accepted_dir" 2>/dev/null | head -1)"
  if [[ -z "$latest" ]]; then
    return 1
  fi
  local best_dir="$accepted_dir/$latest"
  if [[ -f "$best_dir/research/trade-long/strategy.ts" && \
        -f "$best_dir/research/trade-long/strategy.md" ]]; then
    echo "$best_dir"
    return 0
  fi
  return 1
}

if [[ "$MODE" == "auto" ]]; then
  if (( RANDOM < 6554 )); then
    MODE="explore"
  else
    MODE="refine"
  fi
  echo "mode selection: auto -> $MODE" >&2
fi

# The generic runner restores the selected hypothesis. Single-hypothesis mode keeps
# its existing refine/explore preparation.
if [[ -z "${AR_HYPOTHESIS_ID:-}" ]]; then
  BEST_DIR=""
  if [[ "$MODE" == "refine" ]]; then
    if BEST_DIR="$(resolve_best_dir)"; then
      echo "mode: refine (starting from best accepted strategy)" >&2
      cp "$BEST_DIR/research/trade-long/strategy.ts" research/trade-long/strategy.ts
      cp "$BEST_DIR/research/trade-long/strategy.md"  research/trade-long/strategy.md
    else
      echo "mode: refine requested but no accepted snapshot found; falling back to explore" >&2
      MODE="explore"
    fi
  fi

  if [[ "$MODE" == "explore" ]]; then
    echo "mode: explore (starting from boilerplate)" >&2
    cp research/trade-long/strategy-boilerplate.ts research/trade-long/strategy.ts
    cp research/trade-long/strategy-boilerplate.md research/trade-long/strategy.md
  fi

else
  if [[ "$MODE" == "explore" ]]; then
    cp research/trade-long/strategy-boilerplate.ts research/trade-long/strategy.ts
    cp research/trade-long/strategy-boilerplate.md research/trade-long/strategy.md
  fi
  echo "mode: $MODE (hypothesis ${AR_HYPOTHESIS_ID})" >&2
fi

# ---------------------------------------------------------------------------
# Run header
# ---------------------------------------------------------------------------
if [[ -n "${AR_HYPOTHESIS_ID:-}" ]]; then
  _header="${AR_HYPOTHESIS_ID} | ${AR_HYPOTHESIS_FAMILY:-original} | ${MODE} | cycle ${AR_CYCLE_ATTEMPT:-?}/${AR_CYCLE_BUDGET:-?}"
else
  _header="${MODE}"
fi
_sep=$(printf '%0.s=' $(seq 1 ${#_header}))
if true 2>/dev/null >/dev/tty; then
  {
    echo "$_sep"
    echo "$_header"
    echo "$_sep"
    echo ""
  } > /dev/tty
else
  {
    echo "$_sep"
    echo "$_header"
    echo "$_sep"
    echo ""
  } >&2
fi

# ---------------------------------------------------------------------------
# Build mode-specific prompt section
# ---------------------------------------------------------------------------
if [[ "$MODE" == "refine" ]]; then
  read -r -d '' mode_prompt <<'EOF' || true
# MODE: REFINE (Improving Existing Strategy)

You are improving an existing, working strategy that is the current best performer.
Your job is to make ONE targeted, well-reasoned change that you hypothesize will improve the score.

## MANDATORY WORKFLOW
1. **Read the hypothesis card**: Open and study `research/trade-long/hypothesis.md` — this defines the exploration space and approach for this hypothesis. All changes must stay within this direction.
2. **Read the existing code**: Open and carefully study `research/trade-long/strategy.ts` — understand every component before changing anything.
3. **Read durable constraints**: Read `research/trade-long/falsifications.md` for repeatedly demonstrated local failure mechanisms only.
4. **State your hypothesis**: In `strategy.md`, clearly document WHAT you are changing and WHY you expect it to improve the score.
5. **Make ONE targeted change**: Do not rewrite the entire strategy. Modify one specific aspect (e.g., a threshold, a filter condition, a weighting scheme, or adding/removing one indicator).
6. **Verify (HARD COMPLETION GATE)**: Before you finish, run ALL FOUR of these and confirm each exits 0 — they are the exact checks the harness runs, and ANY failure rejects your strategy outright and wastes the entire iteration:
   - `pnpm run strategy:check`
   - `pnpm run strategy:contract`
   - `pnpm run strategy:shared-contract`
   - `pnpm run strategy:premise`
   You MUST NOT end your turn while any of the four is failing. If one fails, read its error and fix your code, then re-run — repeat until all four pass. A strategy that fails `strategy:contract` (returns null on all three synthetic histories) or any other check is invalid no matter how good the idea is; do not hand it back broken. Also run `pnpm run strategy:signal-screen`: it tests your raw entries against a random-entry baseline on TRAINING data only — if it reports `signalScreen: FAILED`, your entries carry no timing information and the evaluator will reject the strategy, so rework the entry logic before finishing. Do NOT run `pnpm run eval` — the harness scores your strategy; running eval yourself wastes your turn budget and is forbidden (rule 9).

## RUNTIME CONTRACT REQUIREMENT
`pnpm run strategy:contract` feeds `proposeTrade()` three simple synthetic histories:
- 90-bar steady uptrend
- 90-bar uptrend with a late pullback
- 30-bar steady uptrend

Each is tested with missing, positive, and negative synthetic TimesFM context.
Returning null when the forecast is absent is allowed; at least one scenario
must produce a valid proposal. A forecast-dependent strategy does not need a
fabricated OHLCV fallback merely to pass the contract.

Your strategy must return a non-null valid proposal for at least one of these histories. Do not make every entry path depend on conditions absent from those fixtures, such as unusual volume spikes, rare volatility compression, calendar effects, or extreme oscillators. If the contract fails with "proposeTrade must return a proposal for at least one contract history", loosen or adapt the trigger until one contract history produces a proposal while preserving valid risk geometry.

## STRATEGY GUIDELINES
* **Incremental, Not Revolutionary**: You are refining a working strategy. Preserve what works and change one thing at a time so the effect is measurable.
* **Hypothesis-Driven**: Every change must have a stated reason (e.g., "tightening the curvature threshold should filter out weak signals and improve win rate").
* **Follow the Hypothesis Direction**: Your changes must align with the approach described in `hypothesis.md`. Do not pivot to a fundamentally different approach.

If you believe the current approach has been fully exhausted and no further targeted improvements are possible, state this clearly at the top of `strategy.md` under "## Exhaustion Signal" so the system can switch to exploration mode.
EOF
else
  read -r -d '' mode_prompt <<'EOF' || true
# MODE: EXPLORE (Fresh Strategy Design)

You are designing a fundamentally new strategy from scratch. The current best approach has been explored — your job is to try something structurally different.

## MANDATORY WORKFLOW
1. **Read the hypothesis card**: Study `research/trade-long/hypothesis.md` — this is your PRIMARY instruction. It defines the specific approach, mathematical concepts, and exploration space for this hypothesis. Follow it.
2. **Read the falsification ledger**: Study `research/trade-long/falsifications.md` for local hard constraints and repeatedly demonstrated failure mechanisms.
3. **Design within the direction**: Use the approach described in `hypothesis.md` as your guide. It may specify a family of techniques, a hybrid combination, or a specific mathematical concept. Implement that.
4. **Document first**: Write your hypothesis in `strategy.md` BEFORE coding. Explain the mathematical or scientific basis.
5. **Implement**: Code the full strategy in `strategy.ts`.
6. **Verify (HARD COMPLETION GATE)**: Before you finish, run ALL FOUR of these and confirm each exits 0 — they are the exact checks the harness runs, and ANY failure rejects your strategy outright and wastes the entire iteration:
   - `pnpm run strategy:check`
   - `pnpm run strategy:contract`
   - `pnpm run strategy:shared-contract`
   - `pnpm run strategy:premise`
   You MUST NOT end your turn while any of the four is failing. If one fails, read its error and fix your code, then re-run — repeat until all four pass. A strategy that fails `strategy:contract` (returns null on all three synthetic histories) or any other check is invalid no matter how good the idea is; do not hand it back broken. Also run `pnpm run strategy:signal-screen`: it tests your raw entries against a random-entry baseline on TRAINING data only — if it reports `signalScreen: FAILED`, your entries carry no timing information and the evaluator will reject the strategy, so rework the entry logic before finishing. Do NOT run `pnpm run eval` — the harness scores your strategy; running eval yourself wastes your turn budget and is forbidden (rule 9).

## RUNTIME CONTRACT REQUIREMENT
`pnpm run strategy:contract` feeds `proposeTrade()` three simple synthetic histories:
- 90-bar steady uptrend
- 90-bar uptrend with a late pullback
- 30-bar steady uptrend

Your strategy must return a non-null valid proposal for at least one of these histories. Do not make every entry path depend on conditions absent from those fixtures, such as unusual volume spikes, rare volatility compression, calendar effects, or extreme oscillators. If the contract fails with "proposeTrade must return a proposal for at least one contract history", loosen or adapt the trigger until one contract history produces a proposal while preserving valid risk geometry.

## STRATEGY GUIDELINES
* **Follow the Hypothesis Direction**: The `hypothesis.md` file defines what this hypothesis should explore. Do not ignore it or go in a completely different direction.
* **Bold Execution Within Direction**: Within the prescribed approach, be bold in your implementation. Don't just make trivial variations — build a strong, well-reasoned implementation of the directed approach.
* **Learn From Constraints**: The `falsifications.md` file tells you what has already been tried and failed locally. Avoid repeating those mistakes.
EOF
fi

# ---------------------------------------------------------------------------
# Assemble the full prompt
# ---------------------------------------------------------------------------
read -r -d '' base_prompt << 'EOF' || true
Read research/trade-long/AGENTS.md, research/trade-long/hypothesis.md, research/trade-long/strategy.md, research/trade-long/falsifications.md, research/trade-long/falsifications-global.md.

The global ledger (`falsifications-global.md`) records negative results proven
across ALL prior research lines — approaches on that list are dead ends; do not
re-implement them. You may APPEND a new entry only when your own evaluated
evidence demonstrates a constraint that generalizes beyond this hypothesis.
Never delete or weaken existing entries.

Before modifying any code, **open and read `research/trade-long/strategy.ts` to understand the exact TypeScript input/output contract**. Implement your deterministic candidate there.

# TRAINING DATA SAMPLES — the ONLY training data you may consult
The portfolio is evaluated across 30 ASX symbols. Three representative samples
from the TRAINING window — a bank (CBA), a miner (BHP), and a defensive (WOW) —
are embedded below so you can confirm the schema and gauge typical price and
volatility magnitudes across sectors. Every other training-data file is the
evaluation set and is off-limits (rule 7).

__TRAINING_SAMPLE__

Schema: `date` (YYYY-MM-DD), `open`, `high`, `low`, `close`, `volume` — all
OHLCV floats except `date`. Your hypothesis card defines which market event or
signal family to express from this schema.

# MISSION
Improve the performance metric of the strategy on the private evaluation period.
This is one attempt in a fixed-budget research cycle. The cycle may end without
an improvement; do not make an arbitrary numeric-only change merely to produce
activity. A well-reasoned negative result is preferable to evaluator chasing.

# TECHNICAL CONSTRAINTS
* **Optional TimesFM data**: `market?.timesfm` may contain `{ asOf, horizonDays: 10, predictedReturnPct }` for this stock at the last history date. `2` means +2%, not confidence. This is another data source: decide whether and how to use it for your hypothesis, or ignore it entirely. No check requires its use; execution and scoring are unchanged. Missing means unavailable, not zero; document how your strategy handles it. Training-only `training-data/timesfm-*.csv` files are allowed inputs. The harness supplies forecasts only when configured; do not access the database or import model libraries. Declare this optional field in your local MarketContext type if needed. Do not add fields to TradeProposal.
* **Pure Stateless Generator**: `proposeTrade` must be completely stateless. It receives no capital, position state, prior trade outcomes, or future candles. It sees trailing candle history and optional date-aligned market context. Do not make assumptions about capital, open-trade state, or prior proposals. Emit honest, market-derived signals; the evaluator handles all execution and trade state.

# STRICT RULES & BOUNDARIES
1. **Strategy Title**: The first thing you must write in `strategy.md` is a short, descriptive slug on the `## Title:` line (e.g. `## Title: multi-curve-sma`). Use lowercase-hyphenated words, max 4 words, capturing the core mathematical idea.
2. **Valid Proposals**: Return non-null proposals under appropriate market conditions (returning null for all inputs is invalid). 
3. **Complete Proposal Contract**: Every proposal must include `side`, `entry.min`,
   `entry.max`, `stopLoss`, `target`, `maxHoldDays`, `setup`, `regime`, and
   `strategyVersion`. Entries are valid for the next session only; do not add
   a strategy-controlled expiry field. Long proposals can open trades. Short
   proposals only exit existing long trades.
4. **Reward/Risk Validation**: Both long and short proposals must have a minimum
   worst-case Reward/Risk of 1.05:
   * Long: `entry.min > stopLoss`, `target > entry.max`, and
     `(target - entry.max) / (entry.max - stopLoss) >= 1.05`
   * Short: `stopLoss > entry.max`, `entry.min > target`, and
     `(entry.min - target) / (stopLoss - entry.min) >= 1.05`
5. **Statistical Viability, Regime Selectivity & Alpha**: The evaluator scores several out-of-sample time windows (folds). Within a fold, more trades earn more confidence (scores ramp up to a ~20-trade full-confidence line; below ~8 trades a window is treated as no-evidence and scores a neutral 0). To be promoted a strategy is judged on **alpha** — its total-capital return (cash included) MINUS a buy-and-hold benchmark over the same window. Promotion gates require positive mean fold alpha, plus either positive median fold alpha or only a narrow losing-fold breadth miss. This has sharp consequences: (a) sitting in cash through a FALLING window beats the falling benchmark → positive alpha, so standing aside in a downtrend is rewarded, not merely neutral; (b) sitting in cash through a RISING window lags the benchmark → negative alpha, so you must actually be invested when the market rises. So: be long and beat the market in up-regimes, be defensive/in-cash in down-regimes, and concentrate trades where your edge holds. You still need enough total activity to be trusted (tens of trades over several windows) — an almost-never-fires strategy is invalid — but the winning shape is a regime-aware book that adds active return versus simply holding the index.
6. **Workspace Hygiene & Sandbox Limits**: Your only strategy edits go to files inside `research/trade-long/` (strategy.ts / strategy.md). Any throwaway analysis scripts must go in the top-level `sandbox/` directory — it is a free scratchpad that the harness wipes clean before every run, so you do NOT need to delete it yourself, and writing there never trips the scope guard. Do not scatter scratch scripts elsewhere in the tree. Do not run iterative trial-and-error loops or repeatedly overwrite scratch scripts to test many different variations. Focus on a single strong, well-reasoned mathematical concept. You are allowed to test **at most one or two distinct ideas** in `sandbox/` scripts total, utilizing **at most 1 or 2 files on disk**.
7. **Restricted Inspection**: Do not inspect `eval.ts`, `db/market.db`, `autoresearch.config.json`, `.autoresearch/`, or any global research notes. Do not open any `research/trade-long/training-data/*.csv` file other than the samples embedded above; the other CSVs are the portfolio evaluation set and reading them is forbidden. Do not enumerate or open other files in the repository to "understand the structure" — read only the files named in this prompt (`AGENTS.md`, `hypothesis.md`, `strategy.md`, `falsifications.md`, `strategy.ts`). Raw attempt evidence, historical scores, the global champion, and other hypotheses are intentionally unavailable.
8. **No External Packages**: Code all logic in pure, deterministic TypeScript. No network calls, randomness, or system time.
9. **No Scoring Self-Runs**: Do NOT run `pnpm run eval`, `tsx research/trade-long/eval.ts`, or any other harness scoring/experiment script yourself. The harness runs `eval` under its own time budget after your code passes its gates. Your verify steps are strictly limited to the harness checks `pnpm run strategy:check`, `pnpm run strategy:contract`, `pnpm run strategy:shared-contract`, `pnpm run strategy:premise` (all four are required — see the Verify gate above; run them as many times as needed to get them green) and `pnpm run strategy:signal-screen` (training-window entry-alpha screen; at most 3 runs per turn). Re-reading prior run output is also disallowed — trust the harness to score you.
EOF

# Inject diverse, TRAINING-WINDOW-truncated OHLCV samples (bank/miner/defensive)
# read live from the training CSVs — so nothing past trainingEnd can leak, and the
# sample self-updates whenever the training window changes. ~6 rows/symbol is
# enough to gauge price scale and volatility per sector without token bloat.
build_training_sample() {
  local pair sym desc f
  for pair in "CBA:bank" "BHP:miner" "WOW:defensive"; do
    sym="${pair%%:*}"; desc="${pair##*:}"
    f="research/trade-long/training-data/${sym}.AX.csv"
    [[ -f "$f" ]] || continue
    printf '%s.AX (%s):\n```csv\n' "$sym" "$desc"
    head -1 "$f"
    tail -6 "$f"
    printf '```\n\n'
    f="research/trade-long/training-data/timesfm-${sym}.AX.csv"
    if [[ -f "$f" ]]; then
      printf '%s.AX TimesFM training features (percent units):\n```csv\n' "$sym"
      head -1 "$f"
      tail -6 "$f"
      printf '```\n\n'
    fi
  done
}
training_sample="$(build_training_sample)"
base_prompt="${base_prompt/__TRAINING_SAMPLE__/$training_sample}"

prompt="${mode_prompt}

${base_prompt}"

before_hash="$(
  sha256sum research/trade-long/strategy.ts research/trade-long/strategy.md
)"

# Agent selection is config-driven (autoresearch.config.json → "agent" block),
# with env vars taking precedence for ad-hoc overrides:
#   provider:        agent.provider        | env AUTORESEARCH_AGENT   (pi|codex)
#   model:           agent.model           | env AR_AGENT_MODEL
#   reasoningEffort: agent.reasoningEffort | env CODEX_REASONING_EFFORT
read_agent_config() {  # <key> <default>
  pnpm exec tsx scripts/read-config.ts "agent.$1" "$2" 2>/dev/null || echo "$2"
}
AGENT_PROVIDER="${AUTORESEARCH_AGENT:-$(read_agent_config provider pi)}"
AGENT_MODEL="${AR_AGENT_MODEL:-$(read_agent_config model '')}"
AGENT_REASONING="${CODEX_REASONING_EFFORT:-$(read_agent_config reasoningEffort none)}"

run_agent() {
echo "agent: provider=${AGENT_PROVIDER} model=${AGENT_MODEL:-<default>} reasoning=${AGENT_REASONING}" >&2
case "$AGENT_PROVIDER" in
  pi)
    pi_args=(-p)
    [[ -n "$AGENT_MODEL" ]] && pi_args+=(--model "$AGENT_MODEL")
    if [[ "${AR_AGENT_DIAGNOSTICS:-0}" == "1" ]]; then
      pi_args+=(--mode json)
      pi "${pi_args[@]}" "$prompt" \
        | node scripts/filter-pi-diagnostics.mjs
      return
    fi
    pi "${pi_args[@]}" "$prompt"
    ;;
  codex)
    codex_args=(
      exec
      --color never
      -m "${AGENT_MODEL:-gpt-5.5}"
      -c "model_reasoning_effort=\"${AGENT_REASONING:-none}\""
      --dangerously-bypass-approvals-and-sandbox
      --skip-git-repo-check
      --ignore-user-config
    )
    # codex exec streams its whole transcript to stderr, which the harness
    # streams live to the console. pi stays quiet by writing to stdout (captured
    # to the run log, not streamed). Merge codex's stderr into stdout for the
    # same behaviour: transcript goes to the run log, console stays clean.
    codex "${codex_args[@]}" "$prompt" 2>&1
    ;;
  *)
    echo "unknown agent provider: ${AGENT_PROVIDER}" >&2
    echo "expected: pi or codex (set agent.provider in autoresearch.config.json or env AUTORESEARCH_AGENT)" >&2
    exit 2
    ;;
esac
}


run_agent

after_hash="$(
  sha256sum research/trade-long/strategy.ts research/trade-long/strategy.md
)"

if [[ "$before_hash" == "$after_hash" ]]; then
  echo "agent made no changes to strategy.ts or strategy.md" >&2
  exit 3
fi
