import assert from "node:assert/strict";
import test from "node:test";
import { calculatePbo } from "../research/trade-long/campaign-diagnostics.js";

test("PBO is zero when the training winner is consistently the test winner", () => {
  const diagnostic = calculatePbo([
    { id: "stable", scores: [5, 5, 5, 5] },
    { id: "weak", scores: [1, 1, 1, 1] }
  ]);
  assert.ok(diagnostic);
  assert.equal(diagnostic.probability, 0);
  assert.equal(diagnostic.splits, 6);
});

test("PBO refuses evidence with too few candidates or folds", () => {
  assert.equal(calculatePbo([{ id: "only", scores: [1, 2, 3, 4] }]), null);
  assert.equal(calculatePbo([{ id: "a", scores: [1, 2] }, { id: "b", scores: [2, 1] }]), null);
});
