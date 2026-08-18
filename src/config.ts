import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./types.js";

const CONFIG_FILE = "autoresearch.config.json";

export async function loadConfig(rootDir: string): Promise<Config> {
  const raw = await readFile(path.join(rootDir, CONFIG_FILE), "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const workflow = parsed.hooks?.workflow;

  const experiment = parsed.commands?.experiment;
  const metricName = parsed.metric?.name;
  const metricRegex = parsed.metric?.regex;
  const artifactPath = parsed.metric?.artifactPath;

  if (!workflow) {
    throw new Error("hooks.workflow is required");
  }
  assertRelativePaths([workflow], "hooks.workflow");
  if (!experiment) {
    throw new Error("commands.experiment is required");
  }
  if (!metricName) {
    throw new Error("metric.name is required");
  }
  if (!metricRegex) {
    throw new Error("metric.regex is required");
  }
  assertMetricRegex(metricRegex);
  if (artifactPath !== undefined) assertRelativePaths([artifactPath], "metric.artifactPath");
  assertStringArray(parsed.commands?.candidateChecks, "commands.candidateChecks");
  assertStringArray(parsed.scope?.editable, "scope.editable");
  assertStringArray(parsed.scope?.persistent, "scope.persistent");
  assertStringArray(parsed.scope?.frozen, "scope.frozen");
  assertStringArray(parsed.accepted?.preserve, "accepted.preserve");
  assertRelativePaths(parsed.scope?.editable, "scope.editable");
  assertRelativePaths(parsed.scope?.persistent, "scope.persistent");
  assertRelativePaths(parsed.scope?.frozen, "scope.frozen");
  assertRelativePaths(parsed.accepted?.preserve, "accepted.preserve");

  const minDeltaPct = parsed.acceptance?.minDeltaPct ?? 0;
  assertNonNegativeNumber(minDeltaPct, "acceptance.minDeltaPct");

  const timeoutSeconds = parsed.budget?.timeoutSeconds ?? 360;
  assertPositiveNumber(timeoutSeconds, "budget.timeoutSeconds");

  const maxIterations = parsed.loop?.maxIterations ?? 20;
  assertNonNegativeInteger(maxIterations, "loop.maxIterations");

  const maxNonImprovingRuns = parsed.loop?.maxNonImprovingRuns ?? 5;
  assertNonNegativeInteger(maxNonImprovingRuns, "loop.maxNonImprovingRuns");

  return {
    hooks: {
      workflow
    },
    commands: {
      setup: parsed.commands?.setup ?? "",
      experiment,
      candidateChecks: parsed.commands?.candidateChecks ?? [],
      prepareCandidate: parsed.commands?.prepareCandidate,
      preLoop: parsed.commands?.preLoop
    },
    metric: {
      name: metricName,
      regex: metricRegex,
      artifactPath
    },
    acceptance: {
      minDeltaPct,
    },
    scope: {
      editable: parsed.scope?.editable ?? [],
      persistent: parsed.scope?.persistent ?? [],
      frozen: parsed.scope?.frozen ?? []
    },
    budget: {
      timeoutSeconds
    },
    git: {
      enabled: parsed.git?.enabled ?? true,
      autoRevertRejected: parsed.git?.autoRevertRejected ?? false
    },
    agent: parseAgentConfig(parsed.agent),
    loop: {
      maxIterations,
      maxNonImprovingRuns
    },
    accepted: {
      preserve: parsed.accepted?.preserve ?? []
    }
  };
}

function assertMetricRegex(regex: string): void {
  let compiled: RegExp;
  try {
    compiled = new RegExp(regex, "m");
  } catch (error) {
    throw new Error(`metric.regex is invalid: ${(error as Error).message}`);
  }

  const captureGroups = countCaptureGroups(regex);
  if (captureGroups !== 1) {
    throw new Error("metric.regex must contain exactly one capture group for the numeric metric");
  }

  const matches = "score: 1.23".match(compiled);
  if (!matches || matches.length < 2) {
    throw new Error("metric.regex must contain a capture group for the numeric metric");
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function assertRelativePaths(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  for (const item of value as string[]) {
    const normalized = item.replaceAll("\\", "/");
    if (path.isAbsolute(item) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(`${field} entries must be relative paths inside the repository`);
    }
  }
}

function assertPositiveNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
}

function assertNonNegativeNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function countCaptureGroups(regex: string): number {
  let count = 0;
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < regex.length; index += 1) {
    const char = regex[index];
    const next = regex[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "[") {
      inCharacterClass = true;
      continue;
    }

    if (char === "]") {
      inCharacterClass = false;
      continue;
    }

    if (!inCharacterClass && char === "(" && next !== "?") {
      count += 1;
    }
  }

  return count;
}

function parseAgentConfig(value: Partial<Config>["agent"]): Config["agent"] {
  if (!value) {
    return undefined;
  }

  if (!value.command) {
    throw new Error("agent.command is required when agent is configured");
  }
  if (value.timeoutSeconds !== undefined && value.timeoutSeconds <= 0) {
    throw new Error("agent.timeoutSeconds must be greater than 0");
  }

  return {
    command: value.command,
    timeoutSeconds: value.timeoutSeconds ?? 300
  };
}
