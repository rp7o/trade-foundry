import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("local initialization creates missing files and preserves existing research", t => {
  const root = mkdtempSync(join(tmpdir(), "trade-foundry-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [
    ["autoresearch.example.json", "autoresearch.config.json"],
    ["research/trade-long/strategy-boilerplate.ts", "research/trade-long/strategy.ts"],
    ["research/trade-long/strategy-boilerplate.md", "research/trade-long/strategy.md"],
    ["research/trade-long/hypothesis-boilerplate.md", "research/trade-long/hypothesis.md"],
    ["research/trade-long/falsifications-boilerplate.md", "research/trade-long/falsifications.md"],
    ["research/trade-long/falsifications-global-boilerplate.md", "research/trade-long/falsifications-global.md"],
  ];
  for (const [source] of paths) {
    const target = join(root, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(source), target);
  }
  const script = join(root, "scripts/init-local.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(resolve("scripts/init-local.mjs"), script);
  writeFileSync(join(root, "research/trade-long/strategy.ts"), "private candidate\n");

  execFileSync(process.execPath, [script], { cwd: root });
  for (const [source, target] of paths) {
    const expected = target.endsWith("strategy.ts")
      ? "private candidate\n"
      : readFileSync(join(root, source), "utf8");
    assert.equal(readFileSync(join(root, target), "utf8"), expected);
  }
  execFileSync(process.execPath, [script], { cwd: root });
  assert.equal(readFileSync(join(root, "research/trade-long/strategy.ts"), "utf8"), "private candidate\n");
});
