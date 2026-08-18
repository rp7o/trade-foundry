import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHypothesis,
  readHypothesis,
  retireAndBreed,
  retireAndReseed,
} from "../research/trade-long/hypotheses.js";

async function fixtureCwd(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "breeding-test-"));
  await mkdir(path.join(cwd, "research/trade-long"), { recursive: true });
  await writeFile(path.join(cwd, "research/trade-long/strategy-boilerplate.ts"), "// boilerplate ts\n");
  await writeFile(path.join(cwd, "research/trade-long/strategy-boilerplate.md"), "# boilerplate md\n");
  return cwd;
}

test("breeds a child carrying both parents' claims and the stronger parent's code", async () => {
  const cwd = await fixtureCwd();
  const parentA = await createHypothesis(cwd, "signal-processing", 1);
  const parentB = await createHypothesis(cwd, "control-theory", 1);
  const retiree = await createHypothesis(cwd, "anomaly-detection", 1);

  const dir = (id: string) => path.join(cwd, "research/trade-long/hypotheses", id);
  await writeFile(path.join(dir(parentA.id), "strategy.ts"), "// parent A strategy\n");
  await writeFile(
    path.join(dir(parentB.id), "falsifications.md"),
    "# Local Falsifications\n\n- volume filters below 500k ADV add nothing\n"
  );

  const child = await retireAndBreed(
    cwd,
    retiree.id,
    { id: parentA.id, score: 300 },
    { id: parentB.id, score: 120 },
    -50
  );

  assert.deepEqual(child.parents, [parentA.id, parentB.id]);
  assert.equal(child.forecastingFamily, "hybrid:signal-processing+control-theory");
  assert.equal(child.generation, 2);

  const card = await readFile(path.join(dir(child.id), "hypothesis.md"), "utf8");
  assert.match(card, /signal-processing, walk-forward score 300\.00/);
  assert.match(card, /control-theory, walk-forward score 120\.00/);

  // Stronger parent's strategy seeds the child.
  const strategy = await readFile(path.join(dir(child.id), "strategy.ts"), "utf8");
  assert.equal(strategy, "// parent A strategy\n");

  // Parent falsifications are inherited.
  const falsifications = await readFile(path.join(dir(child.id), "falsifications.md"), "utf8");
  assert.match(falsifications, /Inherited from hypothesis-0002/);
  assert.match(falsifications, /volume filters below 500k ADV/);

  // Retiree is archived and logged to the global ledger.
  const archived = await readHypothesis(cwd, retiree.id);
  assert.equal(archived?.status, "archived");
  const ledger = await readFile(path.join(cwd, "research/trade-long/falsifications-global.md"), "utf8");
  assert.match(ledger, new RegExp(`${retiree.id} retired`));
  assert.match(ledger, /best score -50\.00/);
});

test("reseed also appends the retirement to the global ledger", async () => {
  const cwd = await fixtureCwd();
  const retiree = await createHypothesis(cwd, "information-theory", 3);
  const replacement = await retireAndReseed(cwd, retiree.id, -12.5);

  assert.equal(replacement.generation, 4);
  assert.equal(replacement.forecastingFamily, "anomaly-detection");
  const ledger = await readFile(path.join(cwd, "research/trade-long/falsifications-global.md"), "utf8");
  assert.match(ledger, new RegExp(`${retiree.id} retired`));
  assert.match(ledger, /family: information-theory, generation 3/);
});
