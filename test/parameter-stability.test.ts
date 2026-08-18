import assert from "node:assert/strict";
import test from "node:test";
import { selectStableCandidate } from "../research/trade-long/parameter-stability.js";

test("parameter selection prefers a broad plateau over an isolated maximum", () => {
  const selected = selectStableCandidate([
    { score: 100, values: { threshold: 1, hold: 5 }, payload: "spike" },
    { score: 20, values: { threshold: 1, hold: 10 }, payload: "weak-neighbor" },
    { score: 60, values: { threshold: 2, hold: 10 }, payload: "plateau-a" },
    { score: 62, values: { threshold: 3, hold: 10 }, payload: "plateau-b" },
    { score: 61, values: { threshold: 4, hold: 10 }, payload: "plateau-c" }
  ]);
  assert.equal(selected.payload, "plateau-b");
  assert.equal(selected.stabilityScore, 61);
});

test("parameter selection is deterministic for equal evidence", () => {
  const candidates = [
    { score: 5, values: { x: 2 }, payload: "b" },
    { score: 5, values: { x: 1 }, payload: "a" }
  ];
  assert.equal(selectStableCandidate(candidates).payload, "a");
  assert.equal(selectStableCandidate(candidates).payload, "a");
});
