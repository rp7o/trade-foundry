import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendTrial, archiveCycle, preserveQualifiedCandidate, readTrialSummary, recordCycleAttempt, startCycle } from "../research/trade-long/cycles.js";

test("a bounded cycle can finish honestly without an improvement", () => {
  let cycle = startCycle("hypothesis-0001", "control-theory", 1, 2, "start");
  cycle = recordCycleAttempt(cycle, false, "one");
  assert.equal(cycle.outcome, "active");
  cycle = recordCycleAttempt(cycle, false, "two");
  assert.equal(cycle.outcome, "inconclusive");
  assert.equal(cycle.attemptsConsumed, 2);
  assert.throws(() => recordCycleAttempt(cycle, false), /already inconclusive/);
});

test("an accepted attempt terminates its cycle", () => {
  const cycle = recordCycleAttempt(startCycle("hypothesis-0002", "failure-forecasting", 4, 8, "start"), true, "done");
  assert.equal(cycle.outcome, "qualified");
  assert.equal(cycle.acceptedAttempts, 1);
});

test("cycle archive and trial ledger retain negative results", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-cycle-"));
  const cycle = recordCycleAttempt(startCycle("hypothesis-0003", "anomaly-detection", 1, 1, "start"), false, "done");
  await archiveCycle(cwd, cycle);
  await appendTrial(cwd, { schemaVersion: 1, timestamp: "trial", source: "agent-structure", score: 1, accepted: false, hypothesisId: cycle.hypothesisId, cycleId: cycle.id });
  const archived = JSON.parse(await readFile(path.join(cwd, "research/trade-long/hypotheses/hypothesis-0003/cycles/hypothesis-0003-cycle-0001.json"), "utf8"));
  assert.equal(archived.outcome, "inconclusive");
  assert.match(await readFile(path.join(cwd, ".autoresearch/trials.jsonl"), "utf8"), /"cycleId":"hypothesis-0003-cycle-0001"/);
  assert.deepEqual(await readTrialSummary(cwd), {
    total: 1,
    accepted: 0,
    bySource: { "agent-structure": 1 }
  });
});

test("qualified exports are self-contained for independent validation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-qualified-"));
  const strategyDir = path.join(cwd, "research/trade-long");
  await mkdir(strategyDir, { recursive: true });
  await mkdir(path.join(cwd, ".autoresearch/runs"), { recursive: true });
  await writeFile(path.join(strategyDir, "strategy.ts"), "export const strategy = 1;\n");
  await writeFile(path.join(strategyDir, "strategy.md"), "# Strategy\n");
  await writeFile(path.join(cwd, ".autoresearch/runs/result.json"), "{}\n");
  const cycle = recordCycleAttempt(startCycle("hypothesis-0004", "control-theory", 1, 2, "start"), true, "done");
  const saved = await preserveQualifiedCandidate(cwd, cycle, 12.5, ".autoresearch/runs/result.json");
  const manifest = JSON.parse(await readFile(path.join(cwd, saved, "manifest.json"), "utf8"));
  assert.equal(manifest.score, 12.5);
  assert.equal(await readFile(path.join(cwd, saved, "research/trade-long/strategy.ts"), "utf8"), "export const strategy = 1;\n");
  assert.equal(await readFile(path.join(cwd, saved, "evaluation.json"), "utf8"), "{}\n");
});
