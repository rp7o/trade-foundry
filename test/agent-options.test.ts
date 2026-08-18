import assert from "node:assert/strict";
import test from "node:test";
import { agentEnvironment } from "../research/trade-long/hooks/workflow.js";

test("agent CLI options map to wrapper environment overrides", () => {
  assert.deepEqual(
    agentEnvironment([
      "--agent", "codex",
      "--model=gpt-5.5",
      "--reasoning", "high",
      "--diagnostics"
    ]),
    {
      AR_AGENT_DIAGNOSTICS: "1",
      AUTORESEARCH_AGENT: "codex",
      AR_AGENT_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "high"
    }
  );
});

test("agent CLI options are optional", () => {
  assert.equal(agentEnvironment([]), undefined);
});

test("agent CLI options fail loudly when ambiguous or incomplete", () => {
  assert.throws(() => agentEnvironment(["--model"]), /--model requires a value/);
  assert.throws(
    () => agentEnvironment(["--agent", "pi", "--agent=codex"]),
    /--agent may only be provided once/
  );
});
