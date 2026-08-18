import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { selectStableCandidate } from "../parameter-stability.js";

interface ParameterSpec {
  templateTs: string;
  templateMd?: string;
  outputTs?: string;
  outputMd?: string;
  parameters: Array<{
    name: string;
    values: Array<string | number | boolean>;
  }>;
  maxCombinations?: number;
  metricRegex?: string;
  evaluateCommand?: string;
}

const root = process.cwd();
const specPath = path.join(root, "research/trade-long/parameter-search.json");

if (!existsSync(specPath)) {
  console.log("parameter-search: no spec found; using agent-written strategy");
  process.exit(0);
}

const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")) as unknown);
const templateTs = readFileSync(path.join(root, spec.templateTs), "utf8");
const templateMd = spec.templateMd
  ? readFileSync(path.join(root, spec.templateMd), "utf8")
  : undefined;
const outputTs = path.join(root, spec.outputTs ?? "research/trade-long/strategy.ts");
const outputMd = path.join(root, spec.outputMd ?? "research/trade-long/strategy.md");
// Hard cap: each combination costs a full walk-forward evaluation, and wide
// grids are exactly the knife-edge tuning the plateau factor penalizes.
const COMBINATION_CAP = 8;
const combinations = buildCombinations(spec.parameters)
  .slice(0, Math.min(spec.maxCombinations ?? COMBINATION_CAP, COMBINATION_CAP));
const metricRegex = new RegExp(spec.metricRegex ?? "^score:\\s*(-?[0-9.]+)", "m");
const evaluateCommand = spec.evaluateCommand ?? "pnpm run eval";
const trialLedger = path.join(root, ".autoresearch/trials.jsonl");
mkdirSync(path.dirname(trialLedger), { recursive: true });

const validCandidates: Array<{
  score: number;
  values: Record<string, string | number | boolean>;
  payload: { ts: string; md?: string };
}> = [];

for (const values of combinations) {
  const renderedTs = render(templateTs, values);
  const renderedMd = templateMd ? render(templateMd, values) : undefined;
  writeFileSync(outputTs, renderedTs);
  if (renderedMd !== undefined) writeFileSync(outputMd, renderedMd);

  try {
    execFileSync("pnpm", ["run", "strategy:check"], { cwd: root, stdio: "pipe" });
    execFileSync("pnpm", ["run", "strategy:contract"], { cwd: root, stdio: "pipe" });
    const output = execFileSync("bash", ["-lc", evaluateCommand], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const score = extractScore(output, metricRegex);
    appendFileSync(trialLedger, `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      source: "parameter-search",
      score,
      accepted: false,
      hypothesisId: process.env.AR_HYPOTHESIS_ID,
      cycleId: process.env.AR_CYCLE_ID,
      parameters: values
    })}\n`);
    validCandidates.push({ score, values, payload: { ts: renderedTs, md: renderedMd } });
  } catch (error) {
    // Invalid parameter points are expected in bounded searches.
    appendFileSync(trialLedger, `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      source: "parameter-search",
      accepted: false,
      hypothesisId: process.env.AR_HYPOTHESIS_ID,
      cycleId: process.env.AR_CYCLE_ID,
      parameters: values,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
  }
}

if (validCandidates.length === 0) {
  throw new Error("parameter-search: no valid parameter combination passed checks and evaluation");
}

const best = selectStableCandidate(validCandidates);
writeFileSync(outputTs, best.payload.ts);
if (best.payload.md !== undefined) writeFileSync(outputMd, best.payload.md);
console.log(
  `parameter-search: selected score=${best.score} stability=${best.stabilityScore} ` +
  `neighbors=${best.neighborhoodSize} values=${JSON.stringify(best.values)}`
);

function parseSpec(value: unknown): ParameterSpec {
  if (!isRecord(value)) throw new Error("parameter-search spec must be an object");
  if (typeof value.templateTs !== "string") {
    throw new Error("parameter-search spec requires templateTs");
  }
  if (value.templateMd !== undefined && typeof value.templateMd !== "string") {
    throw new Error("parameter-search templateMd must be a string");
  }
  if (value.outputTs !== undefined && typeof value.outputTs !== "string") {
    throw new Error("parameter-search outputTs must be a string");
  }
  if (value.outputMd !== undefined && typeof value.outputMd !== "string") {
    throw new Error("parameter-search outputMd must be a string");
  }
  if (!Array.isArray(value.parameters) || value.parameters.length === 0) {
    throw new Error("parameter-search requires at least one parameter");
  }
  const parameters = value.parameters.map((item, index) => {
    if (!isRecord(item)) throw new Error(`parameter-search parameters[${index}] must be an object`);
    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`parameter-search parameters[${index}].name is required`);
    }
    if (
      !Array.isArray(item.values) ||
      item.values.length === 0 ||
      item.values.some((entry) => !isScalar(entry))
    ) {
      throw new Error(`parameter-search parameters[${index}].values must be scalar values`);
    }
    return {
      name: item.name,
      values: item.values,
    };
  });
  const maxCombinations = value.maxCombinations;
  if (maxCombinations !== undefined) {
    if (typeof maxCombinations !== "number" || !Number.isInteger(maxCombinations) || maxCombinations <= 0) {
      throw new Error("parameter-search maxCombinations must be a positive integer");
    }
  }
  if (value.metricRegex !== undefined && typeof value.metricRegex !== "string") {
    throw new Error("parameter-search metricRegex must be a string");
  }
  if (value.evaluateCommand !== undefined && typeof value.evaluateCommand !== "string") {
    throw new Error("parameter-search evaluateCommand must be a string");
  }
  return {
    templateTs: value.templateTs,
    templateMd: value.templateMd,
    outputTs: value.outputTs,
    outputMd: value.outputMd,
    parameters,
    maxCombinations,
    metricRegex: value.metricRegex,
    evaluateCommand: value.evaluateCommand,
  };
}

function buildCombinations(
  parameters: ParameterSpec["parameters"]
): Array<Record<string, string | number | boolean>> {
  return parameters.reduce<Array<Record<string, string | number | boolean>>>(
    (acc, parameter) => acc.flatMap((existing) =>
      parameter.values.map((value) => ({ ...existing, [parameter.name]: value }))
    ),
    [{}],
  );
}

function render(template: string, values: Record<string, string | number | boolean>): string {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output
      .replaceAll(`{{${name}}}`, String(value))
      .replaceAll(`{{json:${name}}}`, JSON.stringify(value))
      .replaceAll(`__PARAM_${name}__`, String(value));
  }
  return output;
}

function extractScore(output: string, regex: RegExp): number {
  const match = output.match(regex);
  if (!match?.[1]) throw new Error("parameter-search metric not found");
  const score = Number(match[1]);
  if (!Number.isFinite(score)) throw new Error("parameter-search metric is not finite");
  return score;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}
