import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAttemptRecord, BestResult, CommandResult, RunRecord } from "./types.js";

const STATE_DIR = ".autoresearch";
const RUNS_DIR = "runs";
const AGENT_DIR = "agent";

export function statePath(rootDir: string): string {
  return path.join(rootDir, STATE_DIR);
}

export function bestPath(rootDir: string): string {
  return path.join(statePath(rootDir), "best.json");
}

export async function ensureState(rootDir: string): Promise<void> {
  await mkdir(path.join(statePath(rootDir), RUNS_DIR), { recursive: true });
  await mkdir(path.join(statePath(rootDir), AGENT_DIR), { recursive: true });
}

export async function readBest(rootDir: string): Promise<BestResult | null> {
  try {
    const raw = await readFile(bestPath(rootDir), "utf8");
    return JSON.parse(raw) as BestResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeBest(rootDir: string, best: BestResult): Promise<void> {
  await ensureState(rootDir);
  await writeFile(bestPath(rootDir), `${JSON.stringify(best, null, 2)}\n`);
}

export async function writeRun(
  rootDir: string,
  timestamp: string,
  run: RunRecord,
  result: CommandResult
): Promise<void> {
  await ensureState(rootDir);
  const runBase = path.join(statePath(rootDir), RUNS_DIR, safeTimestamp(timestamp));
  await writeFile(`${runBase}.log`, formatLog(result));
  await writeFile(`${runBase}.json`, `${JSON.stringify(run, null, 2)}\n`);
}

export async function preserveAcceptedArtifact(
  rootDir: string,
  timestamp: string,
  preserve: string[]
): Promise<string[]> {
  if (preserve.length === 0) {
    return [];
  }

  const acceptedId = safeTimestamp(timestamp);
  const baseRel = `${STATE_DIR}/accepted/${acceptedId}`;
  const baseAbs = path.join(rootDir, baseRel);
  const preserved: string[] = [];

  for (const relative of preserve) {
    const source = path.join(rootDir, relative);
    const target = path.join(baseAbs, relative);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      preserved.push(path.posix.join(baseRel, relative.replaceAll("\\", "/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return preserved;
}

export async function writeAgentAttempt(
  rootDir: string,
  timestamp: string,
  attempt: AgentAttemptRecord,
  result: CommandResult
): Promise<string> {
  await ensureState(rootDir);
  const relativeBase = `${STATE_DIR}/${AGENT_DIR}/${safeTimestamp(timestamp)}`;
  const absoluteBase = path.join(rootDir, relativeBase);
  await writeFile(`${absoluteBase}.log`, formatLog(result));
  await writeFile(`${absoluteBase}.json`, `${JSON.stringify(attempt, null, 2)}\n`);
  return `${relativeBase}.json`;
}

export async function writeLog(
  rootDir: string,
  timestamp: string,
  result: CommandResult
): Promise<string> {
  await ensureState(rootDir);
  const relative = `${STATE_DIR}/${RUNS_DIR}/${safeTimestamp(timestamp)}.log`;
  await writeFile(path.join(rootDir, relative), formatLog(result));
  return relative;
}

export async function readLastRun(rootDir: string): Promise<RunRecord | null> {
  const runsDir = path.join(statePath(rootDir), RUNS_DIR);
  try {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(runsDir))
      .filter((file) => file.endsWith(".json"))
      .sort();
    const last = files.at(-1);
    if (!last) {
      return null;
    }
    const raw = await readFile(path.join(runsDir, last), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function runLogPath(timestamp: string): string {
  return `${STATE_DIR}/${RUNS_DIR}/${safeTimestamp(timestamp)}.log`;
}

export function runRecordPath(timestamp: string): string {
  return `${STATE_DIR}/${RUNS_DIR}/${safeTimestamp(timestamp)}.json`;
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-");
}

function formatLog(result: CommandResult): string {
  return [
    `$ ${result.command}`,
    "",
    "## stdout",
    result.stdout.trimEnd(),
    "",
    "## stderr",
    result.stderr.trimEnd(),
    ""
  ].join("\n");
}
