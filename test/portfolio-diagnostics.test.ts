import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertAligned,
  correlationBetween,
  correlationWithCI,
  isConfidentlyCorrelated,
  isRedundantAgainst,
  jaccard,
  loadArchiveLineages,
  pearson,
  pairwiseRedundancy,
  type LineageEntry
} from "../research/trade-long/portfolio-diagnostics.js";

test("pearson is deterministic and null on a constant vector", () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test("bootstrap CI is seeded and reproducible", () => {
  const a = [1, 2, 3, 4, 5, 6];
  const b = [1.1, 1.9, 3.2, 3.8, 5.1, 6.2];
  const first = correlationWithCI(a, b);
  const second = correlationWithCI(a, b);
  assert.deepEqual(first, second);
  assert.ok(first.estimate !== null && first.estimate > 0.98);
  assert.ok(first.lower !== null && first.upper !== null && first.lower <= first.upper);
});

test("perfectly correlated many-fold vectors clear the CI gate", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = a.map((v) => v * 2 + 3);
  const ci = correlationWithCI(a, b);
  assert.ok(isConfidentlyCorrelated(ci));
});

test("scheduler refuses to act on an interval spanning zero", () => {
  // Six noisy folds: the point estimate can look high, but the interval is wide.
  const a = [10, -5, 3, 8, -2, 6];
  const b = [9, 4, -1, 2, -3, 7];
  const ci = correlationWithCI(a, b);
  assert.ok(ci.lower !== null && ci.lower < 0.9, "interval should not clear the threshold");
  assert.equal(isConfidentlyCorrelated(ci), false);
});

test("assertAligned refuses entries whose fold signatures differ", () => {
  const base: Omit<LineageEntry, "foldNames" | "foldVector"> = {
    lineage: "x",
    entryId: "x-1",
    score: 1,
    tradeKeys: new Set()
  };
  const entries: LineageEntry[] = [
    { ...base, lineage: "a", entryId: "a", foldNames: ["fold-1", "fold-2"], foldVector: [1, 2] },
    { ...base, lineage: "b", entryId: "b", foldNames: ["fold-1", "fold-3"], foldVector: [1, 2] }
  ];
  assert.throws(() => assertAligned(entries), /fold signatures differ/);
});

test("jaccard reflects trade overlap", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test("admission rejects a confidently-correlated, low-overlap duplicate", () => {
  const folds = ["fold-1", "fold-2", "fold-3", "fold-4", "fold-5", "fold-6", "fold-7", "fold-8"];
  const existing = {
    foldNames: folds,
    foldVector: [10, 20, 30, 40, 50, 60, 70, 80],
    tradeKeys: new Set(["AAA|fold-1|d1|d2"])
  };
  const duplicate = {
    foldNames: folds,
    // Same shape, different trades: high fold correlation, zero shared trades.
    foldVector: [11, 21, 29, 41, 49, 61, 69, 81],
    tradeKeys: new Set(["ZZZ|fold-3|d9|d9"])
  };
  assert.equal(isRedundantAgainst(duplicate, existing), true);

  const diversifier = {
    foldNames: folds,
    foldVector: [80, 70, 60, 50, 40, 30, 20, 10], // anti-correlated
    tradeKeys: new Set(["QQQ|fold-2|d3|d4"])
  };
  assert.equal(isRedundantAgainst(diversifier, existing), false);
});

async function archiveEntry(
  cwd: string,
  candidateId: string,
  hypothesisId: string,
  score: number,
  foldValues: number[],
  tradeKey: string
): Promise<void> {
  const dir = path.join(cwd, ".autoresearch/qualified", candidateId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ candidateId, hypothesisId, score })
  );
  await writeFile(
    path.join(dir, "evaluation.json"),
    JSON.stringify({
      segments: foldValues.map((value, index) => ({ name: `fold-${index + 1}`, group: "fold", value })),
      trades: [{ symbol: tradeKey, fold: "fold-1", entryDate: "2023-01-01", exitDate: "2023-01-05" }]
    })
  );
}

test("loadArchiveLineages keeps the best entry per lineage and reports comparable pairs", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "portfolio-test-"));
  await archiveEntry(cwd, "h1-c1", "h1", 100, [1, 2, 3, 4, 5, 6], "A");
  await archiveEntry(cwd, "h1-c2", "h1", 300, [2, 3, 4, 5, 6, 7], "B"); // higher score wins
  await archiveEntry(cwd, "h2-c1", "h2", 200, [6, 5, 4, 3, 2, 1], "C");

  const { entries, excluded } = await loadArchiveLineages(cwd);
  assert.equal(entries.length, 2);
  assert.equal(excluded.length, 0);
  const h1 = entries.find((entry) => entry.lineage === "h1");
  assert.equal(h1?.entryId, "h1-c2");
  const pairs = pairwiseRedundancy(entries);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].correlation.estimate !== null && pairs[0].correlation.estimate < 0);
});

test("correlationBetween finds the least-correlated breeding partner", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "portfolio-test-"));
  await archiveEntry(cwd, "champ-c1", "champ", 500, [1, 2, 3, 4, 5, 6], "A");
  await archiveEntry(cwd, "dup-c1", "dup", 400, [2, 3, 4, 5, 6, 7], "B"); // correlated with champ
  await archiveEntry(cwd, "div-c1", "div", 300, [6, 5, 4, 3, 2, 1], "C"); // anti-correlated
  const { entries } = await loadArchiveLineages(cwd);

  const dup = correlationBetween(entries, "champ", "dup");
  const div = correlationBetween(entries, "champ", "div");
  assert.ok(dup?.estimate !== null && div?.estimate !== null);
  assert.ok((dup?.estimate as number) > (div?.estimate as number));
  assert.equal(correlationBetween(entries, "champ", "missing"), null);
});
