import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { buildSetupConfig, inspectSetup, protectResearch, saveSetup } from "../scripts/setup.js";
import { engineRoot, initializeWorkspace } from "../scripts/workspace.mjs";
import { SCHEMA } from "../scripts/market-db.js";

const template = () => JSON.parse(readFileSync(path.join(engineRoot, "autoresearch.example.json"), "utf8"));
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "trade-foundry-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("setup customizes execution and research settings without changing evaluation standards or unknown config", () => {
  const base = template();
  base.custom = { keep: "operator setting" };
  const before = structuredClone(base);
  const next = buildSetupConfig(base, { exchange: "NYSE", currency: "USD", symbols: ["aaa", "bbb", "AAA"],
    initialCapital: 25000, maxPositions: 4, minAvgTradedValue: 1000000, brokeragePerSide: 1, slippageBpsPerSide: 12,
    provider: "pi", model: "user/model", agentTimeoutSeconds: 480, evalTimeoutSeconds: 900, maxIterations: 10, timesfm: true });
  assert.deepEqual(base, before);
  assert.deepEqual(next.evaluation.symbols, ["AAA", "BBB"]);
  assert.deepEqual(next.evaluation.marketSymbols, {});
  assert.deepEqual(next.evaluation.portfolio, { initialCapital: 25000, maxPositions: 4, minAvgTradedValue: 1000000 });
  assert.equal(next.executionCosts.slippageBpsPerSide, 12);
  assert.equal(next.agent.model, "user/model");
  assert.equal(next.setup.timesfmRequested, true);
  assert.equal(next.evaluation.timesfm, undefined);
  assert.deepEqual(next.acceptance, base.acceptance);
  assert.equal(next.evaluation.foldStart, base.evaluation.foldStart);
  assert.equal(next.evaluation.trainingEnd, base.evaluation.trainingEnd);
  assert.deepEqual(next.custom, base.custom);
});

test("setup rejects invalid numbers, unsafe paths, unsupported answers and ambiguous markets", () => {
  for (const answers of [{ initialCapital: 0 }, { maxPositions: 1.5 }, { minAvgTradedValue: -1 },
    { symbols: [] }, { symbols: ["../secret"] }, { slippageBpsPerSide: NaN }, { agentTimeoutSeconds: 0 },
    { dbPath: "db/../../public.db" }, { provider: "other" }, { exchange: "OTHER" },
    { timesfm: "yes" }, { baseline: "false" }, { foldStart: "2025-01-01" }]) {
    assert.throws(() => buildSetupConfig(template(), answers as any));
  }
});

test("existing research freezes scoring assumptions but allows agent and budget changes", t => {
  const root = fixture(t);
  mkdirSync(path.join(root, ".autoresearch"));
  writeFileSync(path.join(root, ".autoresearch/best.json"), '{"score":123}');
  const base = template();
  assert.doesNotThrow(() => protectResearch(root, base, buildSetupConfig(base, { maxIterations: 7, model: "new-model" })));
  for (const answers of [{ initialCapital: 50000 }, { brokeragePerSide: 0 }, { symbols: ["AAA"] }, { currency: "USD" }]) {
    assert.throws(() => protectResearch(root, base, buildSetupConfig(base, answers)), /new private workspace/);
  }
  assert.equal(readFileSync(path.join(root, ".autoresearch/best.json"), "utf8"), '{"score":123}');
});

test("saving backs up config only and refuses a concurrent edit", t => {
  const root = fixture(t);
  const base = template();
  const original = JSON.stringify(base);
  const configPath = path.join(root, "autoresearch.config.json");
  writeFileSync(configPath, original);
  writeFileSync(path.join(root, "strategy.ts"), "private strategy");
  const next = buildSetupConfig(base, { maxIterations: 4 });
  saveSetup(root, next, original);
  const backupDir = path.join(root, ".autoresearch/setup");
  assert.equal(readFileSync(path.join(backupDir, readdirSync(backupDir)[0]), "utf8"), original);
  assert.equal(readFileSync(path.join(root, "strategy.ts"), "utf8"), "private strategy");
  assert.throws(() => saveSetup(root, base, original), /changed during setup/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).loop.maxIterations, 4);
});

function prices(root: string) {
  mkdirSync(path.join(root, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "db/market.db"));
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT INTO prices VALUES (?, ?, 100, 102, 98, 100, 100, 1000000)");
  for (const [year, count] of [[2016, 500], [2019, 180]]) {
    for (let day = 0; day < count; day++) insert.run("AAA", new Date(Date.UTC(year, 0, day + 1)).toISOString().slice(0, 10));
  }
  db.close();
}

test("preflight is read-only and reports per-symbol training/evaluation coverage", t => {
  const root = fixture(t);
  const config = buildSetupConfig(template(), { symbols: ["AAA"], indexSymbol: "", volatilitySymbol: "", timesfm: true });
  assert.match(inspectSetup(root, config).errors.join("\n"), /Missing market/);
  assert.equal(existsSync(path.join(root, "db")), false);
  prices(root);
  const before = readFileSync(path.join(root, "db/market.db"));
  assert.deepEqual(inspectSetup(root, config).errors, []);
  assert.match(inspectSetup(root, config).warnings.join("\n"), /TimesFM requested but inactive/);
  assert.deepEqual(readFileSync(path.join(root, "db/market.db")), before);
  config.evaluation.symbols.push("MISSING");
  assert.match(inspectSetup(root, config).errors.join("\n"), /MISSING/);
});

test("CLI preview writes nothing; apply and rerun preserve the existing baseline and strategy", t => {
  const root = fixture(t);
  const workspace = initializeWorkspace(path.join(root, "personal"));
  prices(workspace);
  const answersPath = path.join(root, "answers.json");
  writeFileSync(answersPath, JSON.stringify({ symbols: ["AAA"], initialCapital: 25000,
    indexSymbol: "", volatilitySymbol: "", baseline: true }));
  const target = path.join(workspace, "autoresearch.config.json");
  const before = readFileSync(target, "utf8");
  const strategy = readFileSync(path.join(workspace, "research/trade-long/strategy.ts"), "utf8");
  const selectionPath = path.join(engineRoot, ".trade-foundry-workspace");
  const selection = existsSync(selectionPath) ? readFileSync(selectionPath, "utf8") : undefined;
  const run = (...flags: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", path.join(engineRoot, "scripts/setup.ts"), "--answers", answersPath, ...flags],
    { cwd: engineRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace } });
  const preview = run("--dry-run");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(existsSync(path.join(workspace, ".autoresearch")), false);
  const applied = run("--yes", "--no-select");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const bestPath = path.join(workspace, ".autoresearch/best.json");
  const best = readFileSync(bestPath, "utf8");
  assert.equal(JSON.parse(best).score, 0); // Neutral strategy at custom capital must still score zero.
  assert.equal(JSON.parse(readFileSync(target, "utf8")).evaluation.portfolio.initialCapital, 25000);
  const repeated = run("--yes", "--no-select");
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.match(repeated.stdout, /Existing baseline preserved/);
  assert.equal(readFileSync(bestPath, "utf8"), best);
  assert.equal(readFileSync(path.join(workspace, "research/trade-long/strategy.ts"), "utf8"), strategy);
  assert.equal(existsSync(selectionPath) ? readFileSync(selectionPath, "utf8") : undefined, selection);
});
