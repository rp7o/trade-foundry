import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advanceScheduler,
  allAssignmentsSuspended,
  createHypothesis,
  initializeHypotheses,
  hypothesisDir,
  hypothesisTrackedPaths,
  listHypotheses,
  loadScheduler,
  promoteChampion,
  readHypothesis,
  readHypothesisBest,
  recordHypothesisAttempt,
  replaceAssignment,
  retireAndReseed,
  selectMaturationBlock,
  suspendAssignment,
  writeHypothesisBest
} from "../research/trade-long/hypotheses.js";
import { isImprovement } from "../src/metrics.js";
import type { BestResult } from "../src/types.js";

const boilerplateTs = "export const hypothesis = 'boilerplate';\n";
const boilerplateMd = "# Strategy\n";

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-hypotheses-"));
  await mkdir(path.join(cwd, "research/trade-long"), { recursive: true });
  await writeFile(path.join(cwd, "research/trade-long/strategy-boilerplate.ts"), boilerplateTs);
  await writeFile(path.join(cwd, "research/trade-long/strategy-boilerplate.md"), boilerplateMd);
  await writeFile(path.join(cwd, "research/trade-long/strategy.ts"), "global champion\n");
  await writeFile(path.join(cwd, "research/trade-long/strategy.md"), "global docs\n");
  return cwd;
}

function best(score: number): BestResult {
  return {
    timestamp: "2026-06-14T00:00:00.000Z",
    command: "eval",
    metricName: "score",
    score,
    logFile: ".autoresearch/run.log"
  };
}

test("hypothesis persistence keeps strategy and required metadata in Git-tracked paths", async () => {
  const cwd = await fixture();
  const hypothesis = await createHypothesis(cwd, "signal-processing", 1);
  const stored = await readHypothesis(cwd, hypothesis.id);
  assert.deepEqual(stored, hypothesis);
  assert.equal(await readFile(path.join(hypothesisDir(cwd, hypothesis.id), "strategy.ts"), "utf8"), boilerplateTs);
  assert.equal(await readFile(path.join(hypothesisDir(cwd, hypothesis.id), "strategy.md"), "utf8"), boilerplateMd);
  const card = await readFile(path.join(hypothesisDir(cwd, hypothesis.id), "hypothesis.md"), "utf8");
  assert.match(card, /# Hypothesis Card/);
  assert.match(card, /extract high-probability entry points/);
  assert.match(await readFile(path.join(hypothesisDir(cwd, hypothesis.id), "falsifications.md"), "utf8"), /# Local Falsifications/);
});

test("accepted hypothesis commits have a deterministic tracked path set", () => {
  assert.deepEqual(hypothesisTrackedPaths("hypothesis-0003"), [
    "research/trade-long/hypotheses/hypothesis-0003/hypothesis.json",
    "research/trade-long/hypotheses/hypothesis-0003/hypothesis.md",
    "research/trade-long/hypotheses/hypothesis-0003/strategy.ts",
    "research/trade-long/hypotheses/hypothesis-0003/strategy.md",
    "research/trade-long/hypotheses/hypothesis-0003/falsifications.md",
    "research/trade-long/hypotheses/hypothesis-0003/cycles"
  ]);
});

test("local acceptance compares only with the hypothesis incumbent", async () => {
  const cwd = await fixture();
  const hypothesis = await createHypothesis(cwd, "control-theory", 1);
  await writeHypothesisBest(cwd, hypothesis.id, best(110));
  const incumbent = await readHypothesisBest(cwd, hypothesis.id);
  assert.ok(incumbent);
  assert.equal(isImprovement(120, incumbent.score, 0), true);
  assert.equal(isImprovement(120, 200, 0), false);
});

test("scheduler keeps one hypothesis selected until it is explicitly suspended", async () => {
  const cwd = await fixture();
  const hypotheses = await initializeHypotheses(cwd, 3);
  const state = await loadScheduler(cwd, hypotheses.map((hypothesis) => hypothesis.id), 3);
  const selected = selectMaturationBlock(state);
  assert.equal(selectMaturationBlock(state), selected);
  assert.equal(selectMaturationBlock(state), selected);
  assert.equal(selectMaturationBlock(state), selected);
  await suspendAssignment(cwd, state, selected);
  await advanceScheduler(cwd, state);
  assert.notEqual(selectMaturationBlock(state), selected);
  assert.equal(state.assignments.length, 3);
});

test("scheduler reports when every hypothesis is stagnant", async () => {
  const cwd = await fixture();
  const hypotheses = await initializeHypotheses(cwd, 2);
  const state = await loadScheduler(cwd, hypotheses.map((hypothesis) => hypothesis.id), 2);
  assert.equal(allAssignmentsSuspended(state), false);
  for (const hypothesis of hypotheses) await suspendAssignment(cwd, state, hypothesis.id);
  assert.equal(allAssignmentsSuspended(state), true);
});

test("30 non-improving attempts archive and reseed without deleting the hypothesis", async () => {
  const cwd = await fixture();
  const original = await createHypothesis(cwd, "failure-forecasting", 2);
  for (let index = 0; index < 30; index += 1) await recordHypothesisAttempt(cwd, original.id, false);
  const replacement = await retireAndReseed(cwd, original.id);
  const archived = await readHypothesis(cwd, original.id);
  assert.equal(archived?.status, "archived");
  assert.equal(replacement.parent, original.id);
  assert.equal(replacement.generation, 3);
  const state = await loadScheduler(cwd, [original.id], 1);
  await replaceAssignment(cwd, state, original.id, replacement.id);
  assert.deepEqual(state.assignments, [replacement.id]);
  assert.equal(selectMaturationBlock(state), replacement.id);
  assert.equal((await listHypotheses(cwd)).length, 2);
});

test("replacement is selected immediately after all stagnant hypotheses are reseeded", async () => {
  const cwd = await fixture();
  const hypotheses = await initializeHypotheses(cwd, 2);
  const state = await loadScheduler(cwd, hypotheses.map((hypothesis) => hypothesis.id), 2);
  await suspendAssignment(cwd, state, hypotheses[0].id);
  await suspendAssignment(cwd, state, hypotheses[1].id);
  const replacement = await retireAndReseed(cwd, hypotheses[0].id);
  await replaceAssignment(cwd, state, hypotheses[0].id, replacement.id);
  assert.equal(selectMaturationBlock(state), replacement.id);
});

test("champion promotion updates root files but does not consume an assignment", async () => {
  const cwd = await fixture();
  const [hypothesis] = await initializeHypotheses(cwd, 1);
  await writeFile(path.join(hypothesisDir(cwd, hypothesis.id), "strategy.ts"), "promoted\n");
  const state = await loadScheduler(cwd, [hypothesis.id], 1);
  const changedIds = await promoteChampion(cwd, hypothesis.id);
  assert.equal(await readFile(path.join(cwd, "research/trade-long/strategy.ts"), "utf8"), "promoted\n");
  assert.deepEqual(state.assignments, [hypothesis.id]);
  assert.equal((await readHypothesis(cwd, hypothesis.id))?.status, "champion");
  assert.deepEqual(changedIds, [hypothesis.id]);
});

test("champion promotion reports the previous champion metadata for the same commit", async () => {
  const cwd = await fixture();
  const [first, second] = await initializeHypotheses(cwd, 2);
  await promoteChampion(cwd, first.id);
  const changedIds = await promoteChampion(cwd, second.id);
  assert.deepEqual(changedIds, [first.id, second.id]);
  assert.equal((await readHypothesis(cwd, first.id))?.status, "active");
  assert.equal((await readHypothesis(cwd, second.id))?.status, "champion");
});

test("breeding is gated on positive-score parents from distinct families", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow = await readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8");
  // Recombination must never run on zero-alpha parents or same-family pairs;
  // absent eligible parents the loop falls back to a fresh reseed.
  assert.match(workflow, /entry\.score > 0/);
  assert.match(workflow, /forecastingFamily !== firstHypothesis\.forecastingFamily/);
  assert.match(workflow, /: await retireAndReseed\(/);
});

test("generic src modules contain no domain knowledge", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const src = path.join(root, "src");
  const files = (await readdir(src)).filter((file) => file.endsWith(".ts"));
  const sources = await Promise.all(files.map((file) => readFile(path.join(src, file), "utf8")));
  assert.equal(
    sources.some((source) => /\b(trade|strategy|hypothesis|forecast|champion|candle|proposal)\b/i.test(source)),
    false
  );
});

test("agent-once uses the loop scheduler for exactly one iteration", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8");
  assert.match(
    source,
    /command === "agent-once"[\s\S]*?await loop\(rootDir, 1\)/
  );
});

test("hypothesis attempts validate timed-out edits instead of discarding them", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8");
  const hypothesisCall = source.match(
    /const attempt = await agentOnce\(cwd, \{([\s\S]*?)\n        \}\);/
  );
  assert.ok(hypothesisCall);
  assert.doesNotMatch(hypothesisCall[1], /evaluateAgentErrors:\s*false/);
});

test("loop retains a hypothesis until its bounded cycle terminates", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = await readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8");
  assert.match(source, /if \(cycle\.outcome !== "active"\)/);
  assert.doesNotMatch(source, /if \(!schedulerAdvanced && scheduler\.assignments\.length > 1\)/);
});

test("rejected runs no longer use framework-level acceptance gates", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [workflow, wrapper] = await Promise.all([
    readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8"),
    readFile(path.join(root, "scripts/run-agent.sh"), "utf8")
  ]);
  assert.doesNotMatch(workflow, /failed acceptance gates/);
  assert.doesNotMatch(workflow, /run\.acceptanceFailures\.join/);
  assert.doesNotMatch(workflow, /AR_HYPOTHESIS_CLAIM/);
  assert.doesNotMatch(wrapper, /claim:/);
});

test("diagnostics flag captures wrapper diagnostics without live stdout streaming", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [cli, wrapper] = await Promise.all([
    readFile(path.join(root, "research/trade-long/hooks/workflow.ts"), "utf8"),
    readFile(path.join(root, "scripts/run-agent.sh"), "utf8")
  ]);
  assert.match(cli, /AR_AGENT_DIAGNOSTICS\s*=\s*"1"/);
  assert.doesNotMatch(cli, /streamStdout:\s*commandArgs\.includes\("--diagnostics"\)/);
  assert.match(wrapper, /pi_args\+=\(--mode json\)/);
  assert.match(wrapper, /\| node scripts\/filter-pi-diagnostics\.mjs/);
});
