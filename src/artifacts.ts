import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config, ResultArtifact } from "./types.js";

export interface Decision {
  accepted: boolean;
  primaryImproved: boolean;
  failures: string[];
}

export async function readResultArtifact(
  rootDir: string,
  relativePath: string
): Promise<ResultArtifact> {
  const raw = await readFile(path.join(rootDir, relativePath), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return assertResultArtifact(parsed, relativePath);
}

export async function copyResultArtifact(
  rootDir: string,
  timestamp: string,
  relativePath: string | undefined
): Promise<string | undefined> {
  if (!relativePath) return undefined;

  const source = path.join(rootDir, relativePath);
  const targetRel = `.autoresearch/runs/${safeTimestamp(timestamp)}.artifact.json`;
  const target = path.join(rootDir, targetRel);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return targetRel;
}

export function metricFromArtifact(
  artifact: ResultArtifact,
  config: Config
): number {
  if (artifact.primary.name !== config.metric.name) {
    throw new Error(
      `artifact primary metric ${artifact.primary.name} does not match configured metric ${config.metric.name}`
    );
  }
  return artifact.primary.value;
}

export function decideAcceptance(
  config: Config,
  current: {
    score: number;
    checks?: ResultArtifact["checks"];
  },
  best: { score: number }
): Decision {
  const primaryImproved = isBetter(
    current.score,
    best.score,
    config.acceptance.minDeltaPct
  );
  const failures = (current.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => check.name);

  return {
    accepted: primaryImproved && failures.length === 0,
    primaryImproved,
    failures,
  };
}

function assertResultArtifact(value: unknown, source: string): ResultArtifact {
  if (!isRecord(value)) throw new Error(`result artifact must be an object: ${source}`);
  const primary = value.primary;
  if (!isRecord(primary)) throw new Error(`result artifact primary must be an object: ${source}`);
  if (typeof primary.name !== "string" || primary.name.trim() === "") {
    throw new Error(`result artifact primary.name is required: ${source}`);
  }
  if (typeof primary.value !== "number" || !Number.isFinite(primary.value)) {
    throw new Error(`result artifact primary.value must be finite: ${source}`);
  }

  return {
    primary: {
      name: primary.name,
      value: primary.value,
    },
    checks: parseChecks(value.checks, source),
    secondary: parseSecondary(value.secondary, source),
    segments: parseSegments(value.segments, source),
    diagnostics: value.diagnostics,
  };
}

function parseChecks(value: unknown, source: string): ResultArtifact["checks"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`result artifact checks must be an array: ${source}`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`result artifact checks[${index}] must be an object: ${source}`);
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`result artifact checks[${index}].name is required: ${source}`);
    }
    if (typeof item.passed !== "boolean") {
      throw new Error(`result artifact checks[${index}].passed must be boolean: ${source}`);
    }
    return {
      name: item.name,
      passed: item.passed,
      value: scalar(item.value),
      threshold: scalar(item.threshold),
    };
  });
}

function parseSecondary(value: unknown, source: string): ResultArtifact["secondary"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`result artifact secondary must be an array: ${source}`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`result artifact secondary[${index}] must be an object: ${source}`);
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`result artifact secondary[${index}].name is required: ${source}`);
    }
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
      throw new Error(`result artifact secondary[${index}].value must be finite: ${source}`);
    }
    return {
      name: item.name,
      value: item.value,
    };
  });
}

function parseSegments(value: unknown, source: string): ResultArtifact["segments"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`result artifact segments must be an array: ${source}`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`result artifact segments[${index}] must be an object: ${source}`);
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`result artifact segments[${index}].name is required: ${source}`);
    }
    if (item.group !== undefined && typeof item.group !== "string") {
      throw new Error(`result artifact segments[${index}].group must be a string: ${source}`);
    }
    return {
      name: item.name,
      group: item.group,
      score: finiteOrUndefined(item.score, `result artifact segments[${index}].score: ${source}`),
      value: finiteOrUndefined(item.value, `result artifact segments[${index}].value: ${source}`),
      passed: item.passed === undefined ? undefined : booleanValue(item.passed, `result artifact segments[${index}].passed: ${source}`),
    };
  });
}

function isBetter(
  value: number,
  benchmark: number,
  minDeltaPct: number
): boolean {
  const minDelta = Math.abs(benchmark) * minDeltaPct;
  return value > benchmark + minDelta;
}

function finiteOrUndefined(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function scalar(value: unknown): number | string | boolean | undefined {
  if (
    value === undefined ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-");
}
