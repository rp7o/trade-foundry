import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decideAcceptance,
  metricFromArtifact,
  readResultArtifact,
} from "../src/artifacts.js";
import { extractMetric } from "../src/metrics.js";
import type { Config, ResultArtifact } from "../src/types.js";

function config(): Config {
  return {
    hooks: { workflow: "hook.ts" },
    commands: {
      setup: "",
      experiment: "run",
      candidateChecks: [],
    },
    metric: {
      name: "score",
      regex: "^score:\\s*(-?[0-9.]+)",
      artifactPath: ".state/result.json",
    },
    acceptance: {
      minDeltaPct: 0.01,
    },
    scope: { editable: [], persistent: [], frozen: [] },
    budget: { timeoutSeconds: 60 },
    git: { enabled: false, autoRevertRejected: false },
    loop: { maxIterations: 1, maxNonImprovingRuns: 0 },
    accepted: { preserve: [] },
  };
}

function artifact(overrides: Partial<ResultArtifact> = {}): ResultArtifact {
  return {
    primary: { name: "score", value: 120 },
    checks: [{ name: "enough-samples", passed: true }],
    secondary: [{ name: "coverage", value: 80 }],
    segments: [
      { name: "a", group: "fold", passed: true, value: 1 },
      { name: "b", group: "fold", passed: false, value: -1 },
    ],
    ...overrides,
  };
}

test("reads generic result artifacts and extracts the primary metric", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-artifact-"));
  await mkdir(path.join(cwd, ".state"), { recursive: true });
  await writeFile(path.join(cwd, ".state/result.json"), JSON.stringify(artifact()));
  const loaded = await readResultArtifact(cwd, ".state/result.json");
  assert.equal(metricFromArtifact(loaded, config()), 120);
});

test("scalar-only acceptance still works without an artifact", async () => {
  const decision = decideAcceptance(
    config(),
    { score: 102 },
    { score: 100 },
  );
  assert.equal(decision.accepted, true);
});

test("acceptance ignores artifact diagnostics and only compares score", () => {
  const decision = decideAcceptance(
    config(),
    { score: 120 },
    { score: 100 },
  );
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.failures, []);
});

test("acceptance rejects improved scores when artifact checks fail", () => {
  const decision = decideAcceptance(
    config(),
    { score: 120, checks: [{ name: "positive-net-profit", passed: false }] },
    { score: 100 },
  );
  assert.equal(decision.primaryImproved, true);
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.failures, ["positive-net-profit"]);
});

test("metric extraction accepts negative scores for losing strategies", () => {
  assert.equal(extractMetric("score: -218.49\n", config().metric.regex), -218.49);
});

test("artifact direction fields are ignored for compatibility", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autoresearch-artifact-"));
  await mkdir(path.join(cwd, ".state"), { recursive: true });
  await writeFile(
    path.join(cwd, ".state/result.json"),
    JSON.stringify({
      ...artifact(),
      primary: { name: "score", value: 120, direction: "maximize" },
      secondary: [{ name: "coverage", value: 80, direction: "minimize" }],
    }),
  );
  const loaded = await readResultArtifact(cwd, ".state/result.json");
  assert.equal(metricFromArtifact(loaded, config()), 120);
});
