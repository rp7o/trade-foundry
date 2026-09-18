#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadEvaluationConfig, loadEvaluationFeatures } from "../research/trade-long/walkforward.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scoringHash(configPath: string, paths: string[]): void {
  const hash = createHash("sha256");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const subset = { evaluation: config.evaluation, executionCosts: config.executionCosts };
    hash.update(stableJson(subset));
  } catch {
    hash.update("<config-missing>");
  }
  hash.update("\0");
  const features = loadEvaluationFeatures(loadEvaluationConfig(configPath));
  if (features) hash.update(stableJson(features.metadata));
  for (const path of paths) {
    try { hash.update(readFileSync(path)); } catch { hash.update("<missing>"); }
    hash.update("\0");
  }
  console.log(hash.digest("hex"));
}

function writeScore(path: string, score: string): void {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* create it */ }
  data.score = Number(score);
  data.rescoredAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function resetState(): void {
  const schedulerPath = ".autoresearch/scheduler.json";
  if (existsSync(schedulerPath)) {
    const scheduler = JSON.parse(readFileSync(schedulerPath, "utf8")) as { suspended?: string[] };
    if (scheduler.suspended?.length) {
      console.log(`pre-loop: clearing stale scheduler suspensions: ${scheduler.suspended.join(", ")}`);
      scheduler.suspended = [];
      writeFileSync(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`);
    }
  }
  const root = "research/trade-long/hypotheses";
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    const path = `${root}/${id}/hypothesis.json`;
    if (!existsSync(path)) continue;
    const hypothesis = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (hypothesis.status === "archived") continue;
    if (hypothesis.consecutiveNonImprovingAttempts !== 0) {
      hypothesis.consecutiveNonImprovingAttempts = 0;
      writeFileSync(path, `${JSON.stringify(hypothesis, null, 2)}\n`);
    }
  }
}

function readStatus(path: string): void {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { status?: string };
    console.log(data.status ?? "");
  } catch {
    console.log("");
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "hash") scoringHash(args[0], args.slice(1));
else if (command === "write-score") writeScore(args[0], args[1]);
else if (command === "reset-state") resetState();
else if (command === "read-status") readStatus(args[0]);
else throw new Error("usage: pre-loop-utils.ts {hash|write-score|reset-state} ...");
