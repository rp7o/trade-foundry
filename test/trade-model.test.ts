import assert from "node:assert/strict";
import test from "node:test";
import {
  assessEligibility,
  applyProposalToLongPosition,
  calculateRMultiple,
  proposalRewardRisk,
  resolveEntryFill,
  resolveRawExit,
  shouldTimeExit,
  tradeConfidenceFactor,
  type ProposalLike,
  type ShadowOutcome,
} from "../research/trade-long/trade-model.js";

const longProposal: ProposalLike = {
  side: "long",
  entry: { min: 99, max: 101 },
  stopLoss: 95,
  target: 110,
  maxHoldDays: 3,
  setup: "pullback",
  regime: "uptrend",
};

test("entry ranges fill at the open when acceptable and at the first boundary when crossed", () => {
  assert.equal(resolveEntryFill(longProposal.entry, { open: 100, high: 102, low: 98, close: 101 }), 100);
  assert.equal(resolveEntryFill(longProposal.entry, { open: 103, high: 104, low: 100, close: 101 }), 101);
  assert.equal(resolveEntryFill(longProposal.entry, { open: 97, high: 100, low: 96, close: 99 }), 99);
  assert.equal(resolveEntryFill(longProposal.entry, { open: 103, high: 104, low: 102, close: 103 }), null);
});

test("contract economics use the least favorable price in the entry range", () => {
  assert.equal(proposalRewardRisk(longProposal), 1.5);
  assert.equal(proposalRewardRisk({
    ...longProposal,
    side: "short",
    stopLoss: 105,
    target: 90,
  }), 1.5);
});

test("same-candle stop and target ambiguity resolves to the stop", () => {
  assert.deepEqual(
    resolveRawExit("long", 95, 110, { open: 100, high: 111, low: 94, close: 105 }),
    { price: 95, reason: "stop" },
  );
  assert.deepEqual(
    resolveRawExit("short", 105, 90, { open: 100, high: 106, low: 89, close: 95 }),
    { price: 105, reason: "stop" },
  );
});

test("R multiples and hold periods are symmetric for long and short trades", () => {
  assert.equal(calculateRMultiple("long", 100, 95, 110), 2);
  assert.equal(calculateRMultiple("short", 100, 105, 90), 2);
  assert.equal(shouldTimeExit(1, 1), true);
  assert.equal(shouldTimeExit(2, 3), false);
  assert.equal(shouldTimeExit(3, 3), true);
});

test("open long positions tighten on long proposals and exit on short proposals", () => {
  assert.deepEqual(applyProposalToLongPosition(96, longProposal), {
    action: "adjust",
    stopLoss: 96,
    target: 110,
  });
  assert.deepEqual(applyProposalToLongPosition(94, longProposal), {
    action: "adjust",
    stopLoss: 95,
    target: 110,
  });
  assert.deepEqual(applyProposalToLongPosition(96, {
    ...longProposal,
    side: "short",
    stopLoss: 105,
    target: 90,
  }), { action: "exit" });
});

test("performance gating warms up, blocks a losing regime, and ignores unrelated outcomes", () => {
  const unrelated: ShadowOutcome[] = Array.from({ length: 10 }, () => ({
    side: "short",
    setup: "pullback",
    regime: "downtrend",
    rMultiple: -1,
  }));
  assert.equal(assessEligibility(unrelated, longProposal).reason, "warmup");

  const losing: ShadowOutcome[] = Array.from({ length: 10 }, (_, index) => ({
    side: "long",
    setup: "pullback",
    regime: "uptrend",
    rMultiple: index < 3 ? 1 : -1,
  }));
  const blocked = assessEligibility(losing, longProposal);
  assert.equal(blocked.actionable, false);
  assert.equal(blocked.reason, "negative-expectancy");

  const winning: ShadowOutcome[] = Array.from({ length: 10 }, (_, index) => ({
    side: "long",
    setup: "pullback",
    regime: "uptrend",
    rMultiple: index < 6 ? 1 : -1,
  }));
  assert.equal(assessEligibility(winning, longProposal).reason, "eligible");
});

test("trade confidence blocks sparse strategies and ramps to full confidence", () => {
  assert.equal(tradeConfidenceFactor(0), 0);
  assert.equal(tradeConfidenceFactor(7), 0);
  assert.equal(tradeConfidenceFactor(8), 0.4);
  assert.equal(tradeConfidenceFactor(15), 0.75);
  assert.equal(tradeConfidenceFactor(19), 0.95);
  assert.equal(tradeConfidenceFactor(20), 1);
  assert.equal(tradeConfidenceFactor(30), 1);
});
