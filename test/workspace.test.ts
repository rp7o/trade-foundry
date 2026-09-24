import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { engineRoot, initializeWorkspace, selectedWorkspace, syncWorkspace } from "../scripts/workspace.mjs";
import { changedSinceSnapshot, createSnapshot, restoreSnapshot } from "../src/snapshot.js";
import { commitFiles } from "../src/git.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "trade-foundry-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("private workspace tracks research only; links stay live and do not enter Git", t => {
  const root = fixture(t);
  const workspace = initializeWorkspace(path.join(root, "personal"));
  assert.equal(readlinkSync(path.join(workspace, "scripts")), path.join(engineRoot, "scripts"));
  const strategy = path.join(workspace, "research/trade-long/strategy.ts");
  writeFileSync(strategy, "// private strategy sentinel\n");
  mkdirSync(path.join(workspace, "db"));
  writeFileSync(path.join(workspace, "db/prices.db"), "private data");
  mkdirSync(path.join(workspace, "research/trade-long/hypotheses/a/cycles"), { recursive: true });
  writeFileSync(path.join(workspace, "research/trade-long/hypotheses/a/strategy.ts"), "private candidate");
  writeFileSync(path.join(workspace, "research/trade-long/hypotheses/a/cycles/run.json"), "{}");
  git(workspace, "add", ".");
  const tracked = git(workspace, "ls-files").split("\n");
  assert.ok(tracked.includes("research/trade-long/strategy.ts"));
  assert.ok(tracked.includes("autoresearch.config.json"));
  assert.ok(tracked.includes("research/trade-long/hypotheses/a/strategy.ts"));
  assert.ok(tracked.includes("research/trade-long/hypotheses/a/cycles/run.json"));
  assert.ok(!tracked.some(file => file.startsWith("db/") || file.startsWith("src/") || file === "scripts" || file === "package.json" || file.startsWith(".trade-foundry")));
  syncWorkspace(workspace);
  assert.equal(readFileSync(strategy, "utf8"), "// private strategy sentinel\n");
  assert.throws(() => initializeWorkspace(workspace), /preserving existing/);
});

test("workspace selection supports an ignored default and explicit environment override", t => {
  const root = fixture(t);
  assert.equal(selectedWorkspace(root, {}), root);
  writeFileSync(path.join(root, ".trade-foundry-workspace"), "../personal\n");
  assert.equal(selectedWorkspace(root, {}), path.resolve(root, "../personal"));
  assert.equal(selectedWorkspace(root, { TRADE_FOUNDRY_WORKSPACE: "." }), root);
});

test("workspace sync refuses to overwrite a regular engine file", t => {
  const root = fixture(t);
  const workspace = initializeWorkspace(path.join(root, "personal"));
  const linked = path.join(workspace, "research/trade-long/eval.ts");
  rmSync(linked);
  writeFileSync(linked, "local work");
  assert.throws(() => syncWorkspace(workspace), /occupied/);
  assert.equal(readFileSync(linked, "utf8"), "local work");
});

test("contract command imports the private workspace strategy, not the public starter", t => {
  const root = fixture(t);
  const workspace = initializeWorkspace(path.join(root, "personal"));
  writeFileSync(path.join(workspace, "research/trade-long/strategy.ts"), 'export const invalid: number = "no"; throw new Error("PRIVATE_WORKSPACE_STRATEGY");\n');
  const result = spawnSync("pnpm", ["run", "strategy:contract"], { cwd: engineRoot, encoding: "utf8",
    env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRIVATE_WORKSPACE_STRATEGY/);
  const check = spawnSync("pnpm", ["run", "strategy:check"], { cwd: engineRoot, encoding: "utf8",
    env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace } });
  assert.notEqual(check.status, 0);
  assert.match(check.stdout + check.stderr, /Type 'string' is not assignable to type 'number'/);
});

test("a cloned private repository can reattach without copying or tracking engine files", t => {
  const root = fixture(t);
  const workspace = initializeWorkspace(path.join(root, "personal"));
  git(workspace, "config", "user.name", "Workspace test");
  git(workspace, "config", "user.email", "workspace@example.invalid");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "Initial research");
  const clone = path.join(root, "cloned");
  git(root, "clone", "--quiet", "--no-local", workspace, clone);
  const result = spawnSync("node", [path.join(engineRoot, "scripts/workspace.mjs"), "attach", clone], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(path.join(clone, "scripts")), path.join(engineRoot, "scripts"));
  assert.equal(git(clone, "status", "--porcelain"), "");
});

test("snapshot detects linked frozen edits and restores contents without unlinking engine", async t => {
  const root = fixture(t);
  const shared = path.join(root, "engine/src");
  const workspace = path.join(root, "personal");
  mkdirSync(shared, { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(shared, "engine.ts"), "original");
  symlinkSync(shared, path.join(workspace, "src"));
  writeFileSync(path.join(workspace, "strategy.ts"), "original candidate");
  const snapshot = await createSnapshot(workspace, ["src", "strategy.ts"], "test");
  writeFileSync(path.join(shared, "engine.ts"), "changed");
  writeFileSync(path.join(workspace, "strategy.ts"), "rejected candidate");
  assert.deepEqual(await changedSinceSnapshot(snapshot), ["src/engine.ts", "strategy.ts"]);
  await restoreSnapshot(snapshot);
  assert.equal(readFileSync(path.join(shared, "engine.ts"), "utf8"), "original");
  assert.equal(readFileSync(path.join(workspace, "strategy.ts"), "utf8"), "original candidate");
  assert.ok(lstatSync(path.join(workspace, "src")).isSymbolicLink());
  assert.deepEqual(await changedSinceSnapshot(snapshot), []);
});

test("accepted commits affect only requested private files and leave unrelated staging alone", async t => {
  const root = fixture(t);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Workspace test");
  git(root, "config", "user.email", "workspace@example.invalid");
  writeFileSync(path.join(root, "strategy.ts"), "initial");
  writeFileSync(path.join(root, "config.json"), "initial");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial");
  writeFileSync(path.join(root, "strategy.ts"), "accepted");
  writeFileSync(path.join(root, "config.json"), "unrelated");
  git(root, "add", "config.json");
  await commitFiles(root, ["strategy.ts"], "Accepted");
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "strategy.ts");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "config.json");
});

for (const accepted of [false, true]) {
  test(`real loop ${accepted ? "commits accepted" : "restores rejected"} candidates inside private workspace`, t => {
    const root = fixture(t);
    const workspace = initializeWorkspace(path.join(root, "personal"));
    const configPath = path.join(workspace, "autoresearch.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.tradeLong.numSlots = 1;
    config.loop.maxIterations = 1;
    config.commands.preLoop = "";
    config.commands.prepareCandidate = "";
    config.commands.candidateChecks = [];
    config.commands.experiment = accepted ? "printf 'score: 2\\n'" : "printf 'score: 0\\n'";
    delete config.metric.artifactPath;
    config.agent.command = `node -e 'require("node:fs").appendFileSync("research/trade-long/strategy.ts", "\\n// synthetic candidate\\n")'`;
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(path.join(workspace, ".autoresearch"));
    writeFileSync(path.join(workspace, ".autoresearch/best.json"), JSON.stringify({ score: 1, metricName: "walkForwardScore", timestamp: "2020-01-01T00:00:00Z" }));
    git(workspace, "config", "user.name", "Workspace test");
    git(workspace, "config", "user.email", "workspace@example.invalid");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "Initial research");
    const original = readFileSync(path.join(workspace, "research/trade-long/strategy.ts"), "utf8");
    const initial = git(workspace, "rev-parse", "HEAD");
    const publicHead = git(engineRoot, "rev-parse", "HEAD");
    const result = spawnSync("pnpm", ["run", "research:loop", "--commit-accepted"], {
      cwd: engineRoot, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(engineRoot, "rev-parse", "HEAD"), publicHead);
    assert.equal(lstatSync(path.join(workspace, "scripts")).isSymbolicLink(), true);
    assert.equal(git(workspace, "status", "--porcelain"), "");
    if (accepted) {
      assert.notEqual(git(workspace, "rev-parse", "HEAD"), initial);
      assert.match(readFileSync(path.join(workspace, "research/trade-long/strategy.ts"), "utf8"), /synthetic candidate/);
    } else {
      assert.equal(git(workspace, "rev-parse", "HEAD"), initial);
      assert.equal(readFileSync(path.join(workspace, "research/trade-long/strategy.ts"), "utf8"), original);
    }
  });
}
