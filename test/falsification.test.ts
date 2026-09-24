import assert from "node:assert/strict";
import test from "node:test";
import {
  auditArtifact,
  auditConcentration,
  auditEntry,
  auditSampleAdequacy,
  selectBestSurviving,
  MIN_TOTAL_TRADES,
  type AuditTrade,
} from "../research/trade-long/falsification.js";

const FOLDS = ["fold-1", "fold-2", "fold-3", "fold-4", "fold-5", "fold-6"];

function spread(count: number, profit: number): AuditTrade[] {
  return Array.from({ length: count }, (_, i) => ({
    fold: FOLDS[i % FOLDS.length],
    symbol: `SYM${i % 10}.AX`,
    profit,
  }));
}

// Regression fixture: hypothesis-0004-cycle-0003 — 7 trades, fold-6 empty,
// archived as promotable. The sample-adequacy attack must kill it.
const H0004_TRADES: AuditTrade[] = [
  { fold: "fold-1", symbol: "ALD.AX", profit: 160.55 },
  { fold: "fold-2", symbol: "ALD.AX", profit: 330.41 },
  { fold: "fold-3", symbol: "BXB.AX", profit: 29.61 },
  { fold: "fold-4", symbol: "IAG.AX", profit: 139.08 },
  { fold: "fold-4", symbol: "NAB.AX", profit: 47.02 },
  { fold: "fold-5", symbol: "QAN.AX", profit: 163.48 },
  { fold: "fold-5", symbol: "TLS.AX", profit: -65.81 },
];

test("sample adequacy kills the hypothesis-0004 fixture", () => {
  const audit = auditSampleAdequacy(H0004_TRADES, FOLDS);
  assert.equal(audit.verdict, "killed");
  assert.equal(audit.metrics.totalTrades, 7);
  assert.equal(audit.metrics.emptyFolds, 1);
  assert.equal(audit.reasons.length, 1);
});

test("sample adequacy passes a healthy entry", () => {
  const audit = auditSampleAdequacy(spread(60, 10), FOLDS);
  assert.equal(audit.verdict, "survived");
  assert.deepEqual(audit.reasons, []);
});

test("sample adequacy boundary: exactly the floor with no empty folds survives", () => {
  const audit = auditSampleAdequacy(spread(MIN_TOTAL_TRADES, 10), FOLDS);
  assert.equal(audit.verdict, "survived");
});

test("sample adequacy boundary: one below the floor is killed", () => {
  const audit = auditSampleAdequacy(spread(MIN_TOTAL_TRADES - 1, 10), FOLDS);
  assert.equal(audit.verdict, "killed");
});

test("sample adequacy allows one inactive period with many trades", () => {
  const trades = spread(60, 10).map((trade) =>
    trade.fold === "fold-6" ? { ...trade, fold: "fold-1" } : trade
  );
  const audit = auditSampleAdequacy(trades, FOLDS);
  assert.equal(audit.verdict, "survived");
  assert.equal(audit.metrics.emptyFolds, 1);
});

test("sample adequacy rejects activity confined to fewer than half the periods", () => {
  const trades = spread(60, 10).map((trade) => ({ ...trade, fold: "fold-1" }));
  assert.equal(auditSampleAdequacy(trades, FOLDS).verdict, "killed");
});

test("concentration kills when the best trade carries the entire profit", () => {
  const trades: AuditTrade[] = [
    ...spread(40, -5),
    { fold: "fold-1", symbol: "BIG.AX", profit: 300 },
  ];
  const audit = auditConcentration(trades);
  assert.equal(audit.verdict, "killed");
  assert.ok(audit.metrics.profitWithoutBestTrade <= 0);
});

test("concentration weakens when the best trade exceeds half of total profit", () => {
  const trades: AuditTrade[] = [
    ...spread(40, 5),
    { fold: "fold-1", symbol: "BIG.AX", profit: 500 },
  ];
  const audit = auditConcentration(trades);
  assert.equal(audit.verdict, "weakened");
});

test("concentration weakens when one symbol carries the total", () => {
  const trades: AuditTrade[] = [
    ...spread(30, -2),
    ...Array.from({ length: 12 }, (_, i) => ({
      fold: FOLDS[i % FOLDS.length],
      symbol: "ONE.AX",
      profit: 10,
    })),
  ];
  const audit = auditConcentration(trades);
  assert.equal(audit.verdict, "weakened");
  assert.ok(audit.metrics.profitWithoutBestSymbol <= 0);
});

test("concentration kills profit dependent on a single period", () => {
  const trades: AuditTrade[] = [
    ...spread(36, -1),
    ...Array.from({ length: 6 }, () => ({ fold: "fold-1", symbol: "CBA.AX", profit: 10 })),
  ];
  const audit = auditConcentration(trades);
  assert.equal(audit.verdict, "killed");
  assert.ok(audit.metrics.profitWithoutBestFold <= 0);
});

test("artifact period concentration uses portfolio equity including open positions", () => {
  const trades = spread(36, 10);
  const artifact = {
    trades,
    diagnostics: {
      folds: FOLDS.map((name) => ({ name })),
      periodProfits: FOLDS.map((name, index) => ({ name, profit: index === 0 ? 500 : -50 })),
    },
  };
  const audit = auditArtifact("candidate", artifact, "2026-01-01T00:00:00Z");
  assert.equal(audit.verdict, "killed");
  assert.equal(audit.audits[1].metrics.profitWithoutBestFold, -250);
});

test("concentration survives an evenly spread profitable book", () => {
  const audit = auditConcentration(spread(60, 10));
  assert.equal(audit.verdict, "survived");
  assert.equal(audit.metrics.profitGini, 0);
});

test("entry verdict is the worst attack verdict", () => {
  const killed = auditEntry("fixture", H0004_TRADES, FOLDS, "2026-01-01T00:00:00Z");
  assert.equal(killed.verdict, "killed");
  const survived = auditEntry("healthy", spread(60, 10), FOLDS, "2026-01-01T00:00:00Z");
  assert.equal(survived.verdict, "survived");
  assert.equal(survived.audits.length, 2);
});

test("auditArtifact extracts trades and folds from an evaluation artifact", () => {
  const artifact = {
    trades: [
      { fold: "fold-1", symbol: "AAA.AX", profit: 100 },
      { fold: "fold-2", symbol: "BBB.AX", profit: -20 },
      { symbol: "CCC.AX", profit: 10 }, // no fold — dropped
    ],
    diagnostics: { folds: [{ name: "fold-1" }, { name: "fold-2" }] },
  };
  const audit = auditArtifact("entry-1", artifact, "2026-01-01T00:00:00Z");
  assert.equal(audit.entry, "entry-1");
  // 2 usable trades, below the floor → killed.
  assert.equal(audit.verdict, "killed");
  assert.equal(audit.audits[0].metrics.totalTrades, 2);
});

test("selectBestSurviving picks the highest-scoring non-killed entry", () => {
  const chosen = selectBestSurviving([
    { entry: "a", score: 900, verdict: "killed" },
    { entry: "b", score: 500, verdict: "survived" },
    { entry: "c", score: 700, verdict: "weakened" },
  ]);
  assert.equal(chosen?.entry, "c");
});

test("selectBestSurviving returns null when everything is killed", () => {
  const chosen = selectBestSurviving([
    { entry: "a", score: 900, verdict: "killed" },
    { entry: "b", score: 500, verdict: "killed" },
  ]);
  assert.equal(chosen, null);
});

test("selectBestSurviving breaks ties on entry name and ignores non-finite scores", () => {
  const chosen = selectBestSurviving([
    { entry: "z", score: 500, verdict: "survived" },
    { entry: "a", score: 500, verdict: "survived" },
    { entry: "b", score: NaN, verdict: "survived" },
  ]);
  assert.equal(chosen?.entry, "a");
});
