import assert from "node:assert/strict";
import test from "node:test";
import { assessSignificance } from "../research/trade-long/significance.js";

const FOLDS = ["fold-1", "fold-2", "fold-3"];

function trades(profitsByFold: Record<string, number[]>) {
  return Object.entries(profitsByFold).flatMap(([fold, profits]) =>
    profits.map((profit) => ({ fold, profit }))
  );
}

test("falls back to an inconclusive point comparison when the incumbent has too few trades", () => {
  const result = assessSignificance(
    trades({ "fold-1": [50, 60], "fold-2": [40], "fold-3": [30] }),
    trades({ "fold-1": [10] }),
    FOLDS,
  );
  assert.equal(result.passed, true);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /inconclusive/);
});

test("thin incumbent no longer grants a free pass to a worse candidate", () => {
  const result = assessSignificance(
    trades({ "fold-1": [-50], "fold-2": [-40], "fold-3": [-30] }),
    trades({ "fold-1": [10], "fold-2": [10], "fold-3": [10] }),
    FOLDS,
  );
  assert.equal(result.passed, false);
  assert.equal(result.inconclusive, true);
});

test("rejects a candidate inside the incumbent noise band", () => {
  const incumbent = trades({
    "fold-1": [120, -40, 80, -30, 60, 90, -50, 70],
    "fold-2": [100, -20, 50, 40, -60, 110, 30, -10],
    "fold-3": [90, 20, -30, 60, 40, -20, 80, 10],
  });
  // Candidate is a hair better than the incumbent point estimate — the kind
  // of delta trade-sequence luck produces.
  const candidate = trades({
    "fold-1": [125, -40, 80, -30, 60, 90, -50, 70],
    "fold-2": [100, -20, 55, 40, -60, 110, 30, -10],
    "fold-3": [90, 20, -30, 60, 45, -20, 80, 10],
  });
  const result = assessSignificance(candidate, incumbent, FOLDS);
  assert.equal(result.passed, false);
});

test("accepts a candidate clearly above the incumbent noise band", () => {
  const incumbent = trades({
    "fold-1": [20, -10, 15, -5, 10, 25, -15, 5],
    "fold-2": [15, -5, 10, 5, -10, 20, 5, -5],
    "fold-3": [10, 5, -5, 15, 10, -5, 20, 5],
  });
  const candidate = trades({
    "fold-1": [200, 150, 180],
    "fold-2": [220, 160],
    "fold-3": [190, 170, 210],
  });
  const result = assessSignificance(candidate, incumbent, FOLDS);
  assert.equal(result.passed, true);
});

test("is deterministic across repeated runs", () => {
  const incumbent = trades({
    "fold-1": [120, -40, 80, -30, 60, 90, -50, 70],
    "fold-2": [100, -20, 50, 40, -60, 110, 30, -10],
    "fold-3": [90, 20, -30, 60, 40, -20, 80, 10],
  });
  const candidate = trades({ "fold-1": [300], "fold-2": [280], "fold-3": [290] });
  const first = assessSignificance(candidate, incumbent, FOLDS);
  const second = assessSignificance(candidate, incumbent, FOLDS);
  assert.deepEqual(second, first);
});
