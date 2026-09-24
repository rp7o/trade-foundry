#!/usr/bin/env bash
# Domain pre-loop hook for trade-long.
#
# Owns all trading-specific staleness/decay logic. The generic harness knows
# nothing about prices or scoring versions; it only fires this once before a
# loop and hands over the global champion score cache via env:
#
#   AR_EXPERIMENT_CMD     command that prints `score: <n>` (the evaluator)
#   AR_BEST_JSON          path to the global champion's best.json
#
# Responsibility:
#   1. Decide whether the *scoring basis* changed since last loop — i.e. the
#      price data, evaluator, OR evaluator config. Any of these
#      invalidates the cached champion score.
#   2. If it changed, re-score the champion AND every non-archived hypothesis
#      lineage on the current basis, overwriting their stored scores (allow
#      them to fall — that is how decay surfaces and lets challengers overtake
#      stale incumbents). Stale stagnation state is also reset: scheduler
#      suspensions and non-improving streaks were judged against the old bar.
#   3. Apply a retirement floor: if the best incumbent's fresh score is below
#      AR_RETIREMENT_FLOOR, exit non-zero so the harness aborts the loop rather
#      than trade a measurably broken champion.
#
# Re-scoring a strategy means swapping its strategy.ts into the evaluator's
# input path and running the evaluator — this hook owns that knowledge, not src/.

set -euo pipefail

ROOT="$(pwd)"
EXPERIMENT_CMD="${AR_EXPERIMENT_CMD:-pnpm run eval}"
BEST_JSON="${AR_BEST_JSON:-.autoresearch/best.json}"
RETIREMENT_FLOOR="${AR_RETIREMENT_FLOOR:-}"   # empty = disabled

# Inputs that define the scoring basis. Any change invalidates all cached scores.
PRICES_DB="$(pnpm exec tsx scripts/read-config.ts evaluation.dbPath db/market.db)"
EVAL_TS="research/trade-long/eval.ts"
WALKFORWARD_TS="research/trade-long/walkforward.ts"
SIGNAL_SCREEN_TS="research/trade-long/signal-screen.ts"
SCORE_MODEL_TS="research/trade-long/score-model.ts"
TRADE_MODEL_TS="research/trade-long/trade-model.ts"
CONFIG_JSON="autoresearch.config.json"
STRATEGY_TS="research/trade-long/strategy.ts"
STRATEGY_MD="research/trade-long/strategy.md"
VERSION_FILE=".autoresearch/trade-long/scoring-version.txt"

mkdir -p "$(dirname "$VERSION_FILE")"

# ── 1. Has the scoring basis changed? ────────────────────────────────────────
# The config is hashed by SCORING-RELEVANT SUBSET only (evaluation windows +
# execution costs), NOT the whole file. Otherwise unrelated edits — notably the
# agent model/reasoning, loop, or git blocks — would change the hash and trigger
# a spurious full rescore + streak reset (defeating stagnation/retirement) even
# though a strategy's score is unaffected.
compute_version() {
  pnpm exec tsx scripts/pre-loop-utils.ts hash "$CONFIG_JSON" "$PRICES_DB" "$EVAL_TS" "$WALKFORWARD_TS" "$SIGNAL_SCREEN_TS" "$SCORE_MODEL_TS" "$TRADE_MODEL_TS" scripts/timesfm-features.ts research/engine/timesfm-context.mjs research/engine/portfolio-backtest.mjs
}

NEW_VERSION="$(compute_version)"
OLD_VERSION=""
[[ -f "$VERSION_FILE" ]] && OLD_VERSION="$(cat "$VERSION_FILE")"

if [[ "$NEW_VERSION" == "$OLD_VERSION" ]]; then
  echo "pre-loop: scoring basis unchanged; incumbents are current."
  exit 0
fi

echo "pre-loop: scoring basis changed (data and/or evaluator) - re-scoring champion."

# ── 2. Re-score helpers ──────────────────────────────────────────────────────
# Run the evaluator against a given strategy.ts (and optional strategy.md) by
# swapping it into the evaluator's input path. Prints the parsed score.
score_strategy() {
  local strat_ts="$1"
  local strat_md="${2:-}"
  local best_json="$3"

  cp -f "$strat_ts" "$STRATEGY_TS"
  [[ -n "$strat_md" && -f "$strat_md" ]] && cp -f "$strat_md" "$STRATEGY_MD"

  local out
  out="$(eval "$EXPERIMENT_CMD" 2>/dev/null)" || {
    echo "pre-loop: evaluator failed while re-scoring $strat_ts" >&2
    return 1
  }
  cp -f .autoresearch/trade-long/latest.json "${best_json%.json}.artifact.json"
  # Last `score:` line wins.
  echo "$out" | sed -n 's/^score:[[:space:]]*\(-\{0,1\}[0-9][0-9.]*\).*/\1/p' | tail -n1
}

# Overwrite the "score" field of a best.json in place.
write_score() {
  local best_json="$1" score="$2"
  pnpm exec tsx scripts/pre-loop-utils.ts write-score "$best_json" "$score" "${best_json%.json}.artifact.json"
}

# Snapshot the root strategy while evaluating the champion.
RESTORE_TS="$(mktemp)"; RESTORE_MD="$(mktemp)"
cp -f "$STRATEGY_TS" "$RESTORE_TS"
[[ -f "$STRATEGY_MD" ]] && cp -f "$STRATEGY_MD" "$RESTORE_MD"
restore_root() {
  cp -f "$RESTORE_TS" "$STRATEGY_TS"
  [[ -s "$RESTORE_MD" ]] && cp -f "$RESTORE_MD" "$STRATEGY_MD"
  rm -f "$RESTORE_TS" "$RESTORE_MD"
}
trap restore_root EXIT

best_overall=""
if [[ -f "$STRATEGY_TS" ]]; then
  echo "pre-loop: re-scoring global champion"
  if s="$(score_strategy "$RESTORE_TS" "$RESTORE_MD" "$BEST_JSON")" && [[ -n "$s" ]]; then
    write_score "$BEST_JSON" "$s"
    best_overall="$s"
    echo "pre-loop:   -> $s"
  fi
fi

# ── 3. Re-score every non-archived hypothesis lineage ────────────────────────
# Slot bests are the per-lineage acceptance bar; leaving them on the old basis
# would make every slot unwinnable (or trivially winnable) after an evaluator
# change. Suspended lineages are included — the new basis may rank them
# differently.
HYPOTHESES_DIR="research/trade-long/hypotheses"
best_lineage=""
best_lineage_id=""
if [[ -d "$HYPOTHESES_DIR" ]]; then
  for hyp_dir in "$HYPOTHESES_DIR"/*/; do
    hyp_id="$(basename "$hyp_dir")"
    hyp_json="$hyp_dir/hypothesis.json"
    [[ -f "$hyp_json" ]] || continue
    status="$(pnpm exec tsx scripts/pre-loop-utils.ts read-status "$hyp_json")"
    [[ "$status" == "archived" ]] && continue
    hyp_best=".autoresearch/hypotheses/$hyp_id/best.json"
    if [[ ! -f "$hyp_best" || ! -f "$hyp_dir/strategy.ts" ]]; then
      echo "pre-loop: $hyp_id has no cached best; the loop will baseline it fresh."
      continue
    fi
    echo "pre-loop: re-scoring $hyp_id ($status)"
    if s="$(score_strategy "$hyp_dir/strategy.ts" "$hyp_dir/strategy.md" "$hyp_best")" && [[ -n "$s" ]]; then
      write_score "$hyp_best" "$s"
      echo "pre-loop:   -> $s"
      if [[ -z "$best_lineage" ]] || awk "BEGIN{exit !($s > $best_lineage)}"; then
        best_lineage="$s"
        best_lineage_id="$hyp_id"
      fi
    else
      echo "pre-loop:   evaluator failed for $hyp_id; keeping stale score" >&2
    fi
  done
fi

if [[ -n "$best_lineage" && -n "$best_overall" ]]; then
  if awk "BEGIN{exit !($best_lineage > $best_overall)}"; then
    echo "pre-loop: NOTE: $best_lineage_id ($best_lineage) now outscores the champion ($best_overall) on the new rolling basis; it can promote via the loop once it clears the promotion gates."
  fi
fi

# ── 4. Reset stale stagnation state ──────────────────────────────────────────
# Suspensions and non-improving streaks were judged against the old scoring
# basis; every surviving lineage gets a fresh run at the new bar.
pnpm exec tsx scripts/pre-loop-utils.ts reset-state

restore_root
trap - EXIT

# ── 5. Persist the new scoring-basis version ─────────────────────────────────
echo "$NEW_VERSION" > "$VERSION_FILE"

# ── 6. Retirement floor ──────────────────────────────────────────────────────
if [[ -n "$RETIREMENT_FLOOR" && -n "$best_overall" ]]; then
  below=$(awk "BEGIN{print ($best_overall < $RETIREMENT_FLOOR)?1:0}")
  if [[ "$below" -eq 1 ]]; then
    echo "pre-loop: best incumbent $best_overall is past the retirement floor $RETIREMENT_FLOOR; aborting loop." >&2
    exit 1
  fi
fi

echo "pre-loop: champion re-scored on current basis; best = ${best_overall:-n/a}"
exit 0
