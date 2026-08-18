import process from "node:process";
import path from "node:path";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../../../src/config.js";
import { checkScope } from "../../../src/guards.js";
import { commitFiles, dirtyStatus, isInsideGitRepo, listChangedFiles, listChangedFilesForPaths, revertFiles } from "../../../src/git.js";
import {
  bestPath,
  ensureState,
  preserveAcceptedArtifact,
  readBest,
  readLastRun,
  runRecordPath,
  runLogPath,
  writeBest,
  writeAgentAttempt,
  writeLog,
  writeRun
} from "../../../src/ledger.js";
import { extractMetric, isImprovement } from "../../../src/metrics.js";
import { cleanUpChildren, runCommand } from "../../../src/runner.js";
import {
  advanceScheduler,
  allAssignmentsSuspended,
  initializeHypotheses,
  hypothesisTrackedPaths,
  listHypotheses,
  loadScheduler,
  persistHypothesisStrategy,
  promoteChampion,
  readHypothesis,
  readHypothesisBest,
  recordHypothesisAttempt,
  recordCompletedCycle,
  replaceAssignment,
  restoreHypothesis,
  retireAndBreed,
  retireAndReseed,
  selectMaturationBlock,
  suspendAssignment,
  writeHypothesisBest
} from "../hypotheses.js";
import {
  appendTrial,
  archiveCycle,
  readCycle,
  recordCycleAttempt,
  preserveQualifiedCandidate,
  readTrialSummary,
  startCycle,
  writeCycle,
  type ResearchCycle
} from "../cycles.js";
import { campaignPbo } from "../campaign-diagnostics.js";
import { correlationBetween, loadArchiveLineages, type LineageEntry } from "../portfolio-diagnostics.js";
import {
  auditArtifact,
  selectBestSurviving,
  type ArchiveCandidate,
  type EvaluationArtifact,
} from "../falsification.js";
import {
  changedSinceManifest,
  changedSinceSnapshotInRoot,
  createFileManifest,
  createSnapshot,
  removeSnapshot,
  restoreSnapshot
} from "../../../src/snapshot.js";
import type { Snapshot } from "../../../src/snapshot.js";
import type { AgentAttemptRecord, BestResult, CommandResult, Config, RunRecord } from "../../../src/types.js";
import {
  copyResultArtifact,
  decideAcceptance,
  metricFromArtifact,
  readResultArtifact
} from "../../../src/artifacts.js";

interface TradeLongConfig {
  numSlots: number;
  maturationBlockSize: number;
  structuralAttemptsPerCycle: number;
  maxCyclesPerLineage: number;
}

let activeSnapshot: Snapshot | null = null;
let activeShutdownCleanup: (() => Promise<void>) | null = null;

async function shutdown(exitCode: number): Promise<void> {
  cleanUpChildren();

  if (activeSnapshot) {
    try {
      console.log("\nRestoring editable files to previous accepted state from snapshot...");
      await restoreSnapshot(activeSnapshot);
      console.log("Editable files successfully restored.");
    } catch (error) {
      console.error("Failed to restore editable files from snapshot:", error);
    }
  }
  if (activeShutdownCleanup) {
    try {
      await activeShutdownCleanup();
    } catch (error) {
      console.error("Failed to restore scheduler state during shutdown:", error);
    }
  }

  process.exit(exitCode);
}

process.on("SIGINT", () => {
  shutdown(130).catch(() => process.exit(130));
});

process.on("SIGTERM", () => {
  shutdown(143).catch(() => process.exit(143));
});

process.on("exit", () => {
  cleanUpChildren();
});


let commandArgs: string[] = [];

export async function run(args: string[], rootDir: string): Promise<void> {
const commandIndex = args[0] === "--" ? 1 : 0;
const command = args[commandIndex];
commandArgs = args.slice(commandIndex + 1);

try {
  if (command === "--help" || command === "-h" || command === "help") {
    usage();
  } else if (command === "baseline") {
    await baseline(rootDir);
  } else if (command === "run-once") {
    await runOnce(rootDir);
  } else if (command === "agent-once") {
    await loop(rootDir, 1);
  } else if (command === "loop") {
    await loop(rootDir);
  } else if (command === "status") {
    await status(rootDir);
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
}

async function baseline(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  await ensureState(cwd);
  await runSetup(config, cwd);

  const timestamp = new Date().toISOString();
  await runCandidateChecks(cwd, config, timestamp);

  const result = await runCommand(
    config.commands.experiment,
    cwd,
    config.budget.timeoutSeconds
  );
  const logFile = await writeLog(cwd, timestamp, result);

  if (result.timedOut) {
    throw new Error(`experiment timed out after ${config.budget.timeoutSeconds}s`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`experiment failed with exit code ${result.exitCode}; see ${logFile}`);
  }

  const artifact = config.metric.artifactPath
    ? await readResultArtifact(cwd, config.metric.artifactPath)
    : undefined;
  const artifactFile = await copyResultArtifact(cwd, timestamp, config.metric.artifactPath);
  const score = artifact
    ? metricFromArtifact(artifact, config)
    : extractMetric(`${result.stdout}\n${result.stderr}`, config.metric.regex);
  const best = createBestRecord(config, timestamp, score, logFile, artifactFile);
  const existingBest = await readBest(cwd);
  const reset = commandArgs.includes("--reset");
  const baselineAccepted = !existingBest || reset || isImprovement(score, existingBest.score, 0);
  await appendTrial(cwd, {
    schemaVersion: 1,
    timestamp,
    source: "baseline",
    score,
    accepted: baselineAccepted,
    ...(artifactFile ? { artifactFile } : {})
  });
  if (!baselineAccepted) {
    console.log(`baseline score: ${score}`);
    console.log(`existing best preserved: ${existingBest.score}`);
    console.log("use `pnpm run ar -- baseline --reset` to replace it explicitly");
    return;
  }

  await writeBest(cwd, best);

  console.log(`baseline score: ${score}`);
  console.log(`metric: ${config.metric.name}`);
  console.log(`saved: ${path.relative(cwd, bestPath(cwd)).replaceAll("\\", "/")}`);
}

async function runOnce(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const best = await readBest(cwd);
  if (!best) {
    throw new Error("no best score found; run `pnpm run ar -- baseline` first");
  }

  const gitReady = config.git.enabled && await isInsideGitRepo(cwd);
  let changedFiles: string[] = [];
  if (gitReady) {
    changedFiles = await listChangedFiles(cwd);
    checkScope(config, changedFiles);
  } else {
    console.warn("warning: git is unavailable or this is not a git repo; skipping changed-file scope checks");
  }

  const run = await evaluateCurrentCandidate(cwd, config, best, changedFiles);
  printRunResult(run);
  if (!run.accepted && gitReady && config.git.autoRevertRejected && changedFiles.length > 0) {
    await revertFiles(cwd, changedFiles);
    console.log(`auto-reverted rejected changes: ${changedFiles.join(", ")}`);
  }
}

async function evaluateCurrentCandidate(
  cwd: string,
  config: Config,
  best: BestResult,
  changedFiles: string[],
  options: { updateBest?: boolean } = {}
): Promise<RunRecord> {
  await ensureState(cwd);
  await runSetup(config, cwd);

  const timestamp = new Date().toISOString();
  const result = await runCommand(
    config.commands.experiment,
    cwd,
    config.budget.timeoutSeconds
  );
  const logFile = runLogPath(timestamp);

  if (result.timedOut) {
    await writeLog(cwd, timestamp, result);
    throw new Error(`experiment timed out after ${config.budget.timeoutSeconds}s; see ${logFile}`);
  }
  if (result.exitCode !== 0) {
    await writeLog(cwd, timestamp, result);
    throw new Error(`experiment failed with exit code ${result.exitCode}; see ${logFile}`);
  }

  const artifact = config.metric.artifactPath
    ? await readResultArtifact(cwd, config.metric.artifactPath)
    : undefined;
  const artifactFile = await copyResultArtifact(cwd, timestamp, config.metric.artifactPath);
  const score = artifact
    ? metricFromArtifact(artifact, config)
    : extractMetric(`${result.stdout}\n${result.stderr}`, config.metric.regex);
  const decision = decideAcceptance(
    config,
    { score, checks: artifact?.checks },
    { score: best.score }
  );
  let accepted = decision.accepted;

  // Noise-aware acceptance: an improvement must clear the incumbent's
  // bootstrap noise band, not just its point score. See significance.ts.
  if (accepted && artifact && best.artifactFile) {
    const gate = await runSignificanceGate(cwd, artifact, best.artifactFile);
    if (!gate.passed) {
      accepted = false;
      console.log(`significance gate: ${gate.reason}; rejected`);
    } else if (gate.reason) {
      console.log(`significance gate: ${gate.reason}`);
    }
  }

  const run: RunRecord = {
    timestamp,
    command: config.commands.experiment,
    metricName: config.metric.name,
    score,
    bestBefore: best.score,
    accepted,
    durationMs: result.durationMs,
    changedFiles,
    logFile,
    ...(artifactFile ? { artifactFile } : {}),
    ...(process.env.AR_HYPOTHESIS_ID ? { contextId: process.env.AR_HYPOTHESIS_ID } : {}),
    acceptanceReason: accepted
      ? "score and evidence gates passed"
      : decision.failures.join(",") || "not a meaningful improvement"
  };

  await writeRun(cwd, timestamp, run, result);
  await appendTrial(cwd, {
    schemaVersion: 1,
    timestamp,
    source: process.env.AR_HYPOTHESIS_ID ? "agent-structure" : "manual",
    score,
    accepted,
    ...(process.env.AR_HYPOTHESIS_ID ? { hypothesisId: process.env.AR_HYPOTHESIS_ID } : {}),
    ...(process.env.AR_CYCLE_ID ? { cycleId: process.env.AR_CYCLE_ID } : {}),
    runRecord: runRecordPath(timestamp),
    ...(artifactFile ? { artifactFile } : {})
  });

  if (accepted && (options.updateBest ?? true)) {
    await writeBest(cwd, createBestRecord(config, timestamp, score, logFile, artifactFile));
    await preserveAcceptedArtifact(cwd, timestamp, config.accepted.preserve);
  }

  return run;
}

async function runCandidateChecks(cwd: string, config: Config, timestamp: string): Promise<void> {
  for (const command of config.commands.candidateChecks) {
    const result = await runCommand(command, cwd, config.budget.timeoutSeconds);
    if (result.timedOut || result.exitCode !== 0) {
      const logFile = await writeLog(cwd, `${timestamp}-${command.replaceAll(/[^a-z0-9]+/gi, "-")}`, result);
      throw new Error(`candidate check failed: ${command}; see ${logFile}`);
    }
  }
}

function printRunResult(run: RunRecord): void {
  if (run.accepted) {
    console.log(`accepted: ${run.score} improved on ${run.bestBefore}`);
  } else {
    console.log(`rejected: ${run.score} did not improve on ${run.bestBefore}`);
  }

  console.log(`run: ${run.logFile}`);
}

async function agentOnce(
  cwd: string,
  options: {
    skipPreLoop?: boolean;
    updateBest?: boolean;
    evaluateAgentErrors?: boolean;
  } = {}
): Promise<AgentAttemptRecord> {
  const config = await loadConfig(cwd);
  if (!config.agent) {
    throw new Error("agent.command is not configured");
  }
  if (config.scope.editable.length === 0) {
    throw new Error("scope.editable must list files or directories before using agent-once");
  }

  // Refresh stale incumbents before reading the acceptance bar, unless the loop
  // already ran the pre-loop hook for this batch of attempts. The hook is gated
  // on the scoring basis, so this is a no-op when nothing changed.
  if (!options.skipPreLoop) {
    await ensureState(cwd);
    await runPreLoopHook(cwd, config);
  }

  const best = await readBest(cwd);
  if (!best) {
    throw new Error("no best score found; run `pnpm run ar -- baseline` first");
  }

  await ensureState(cwd);
  await clearSandbox(cwd);
  const timestamp = new Date().toISOString();
  const snapshot = await createSnapshot(
    cwd,
    [...config.scope.editable, ...config.scope.frozen],
    timestamp
  );
  const treeManifest = await createFileManifest(cwd);
  activeSnapshot = snapshot;

  try {
    const persistentSnapshot = await createSnapshot(
      cwd,
      config.scope.persistent,
      `${timestamp}-persistent`
    );
  const agentResult = await runCommand(
    config.agent.command,
    cwd,
    config.agent.timeoutSeconds,
    {
      detached: true,
      env: agentEnvironment(commandArgs),
      streamStderr: true
    }
  );
  let changedFiles = [...new Set([
    ...await changedSinceSnapshotInRoot(snapshot, cwd, config.scope.editable),
    ...await changedSinceSnapshotInRoot(persistentSnapshot, cwd, config.scope.persistent),
    ...await changedSinceManifest(treeManifest)
  ])].sort();
  let attempt: AgentAttemptRecord | undefined;

  const frozenChanged = await changedSinceSnapshotInRoot(snapshot, cwd, config.scope.frozen);
  if (frozenChanged.length > 0) {
    await restoreSnapshot(snapshot);
    attempt = {
      ...baseAgentAttempt(config, timestamp, agentResult, frozenChanged, "scope-violation", true),
      error: `agent modified frozen files: ${frozenChanged.join(", ")}`
    };
    await recordAttempt(cwd, timestamp, attempt, agentResult);
    await removeSnapshot(persistentSnapshot);
    await removeSnapshot(snapshot);
    console.log(`${attempt.error}; restored snapshot`);
    return attempt;
  }

  if (
    (agentResult.timedOut || agentResult.exitCode !== 0) &&
    (changedFiles.length === 0 || options.evaluateAgentErrors === false)
  ) {
    await restoreSnapshot(snapshot);
    attempt = {
      timestamp,
      agentCommand: config.agent.command,
      agentTimedOut: agentResult.timedOut,
      agentExitCode: agentResult.exitCode,
      agentDurationMs: agentResult.durationMs,
      changedFiles,
      outcome: "agent-error",
      restored: true,
      error: agentResult.timedOut
        ? `agent timed out after ${config.agent.timeoutSeconds}s`
        : `agent exited with code ${agentResult.exitCode}`
    };
    await recordAttempt(cwd, timestamp, attempt, agentResult);
    await removeSnapshot(persistentSnapshot);
    await removeSnapshot(snapshot);
    console.log(`${attempt.error}; restored snapshot`);
    return attempt;
  }

  if (changedFiles.length === 0) {
    await restoreSnapshot(snapshot);
    attempt = {
      ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "no-change", true),
      error: `no changes detected`
    };
    await recordAttempt(cwd, timestamp, attempt, agentResult);
    await removeSnapshot(persistentSnapshot);
    await removeSnapshot(snapshot);
    console.log("no candidate changes; skipped evaluation");
    console.log(attempt.error);
    return attempt;
  }

  try {
    checkScope(config, changedFiles);
  } catch (error) {
    await restoreSnapshot(snapshot);
    attempt = {
      ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "scope-violation", true),
      error: (error as Error).message
    };
    await recordAttempt(cwd, timestamp, attempt, agentResult);
    await removeSnapshot(persistentSnapshot);
    await removeSnapshot(snapshot);
    console.log(`${attempt.error}; restored snapshot`);
    return attempt;
  }

  if (agentResult.timedOut || agentResult.exitCode !== 0) {
    console.log(
      agentResult.timedOut
        ? `agent timed out after ${config.agent.timeoutSeconds}s with changes; validating candidate`
        : `agent exited with code ${agentResult.exitCode} with changes; validating candidate`
    );
  }

  try {
    await runPrepareCandidateHook(cwd, config);
    changedFiles = [...new Set([
      ...await changedSinceSnapshotInRoot(snapshot, cwd, config.scope.editable),
      ...await changedSinceSnapshotInRoot(persistentSnapshot, cwd, config.scope.persistent),
      ...await changedSinceManifest(treeManifest)
    ])].sort();
    checkScope(config, changedFiles);
  } catch (error) {
    attempt = {
      ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "validation-error", true),
      error: (error as Error).message
    };
    console.log(attempt.error);
  }

  try {
    if (!attempt) await runCandidateChecks(cwd, config, timestamp);
  } catch (error) {
    attempt = {
      ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "validation-error", true),
      error: (error as Error).message
    };
    console.log(attempt.error);
  }

  if (!attempt) {
    try {
    const run = await evaluateCurrentCandidate(cwd, config, best, changedFiles, {
      updateBest: options.updateBest ?? true
    });
    if (run.accepted) {
      attempt = {
        ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "accepted", false),
        runRecord: runRecordPath(run.timestamp)
      };
      printRunResult(run);
    } else {
      attempt = {
        ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "rejected", true),
        runRecord: runRecordPath(run.timestamp)
      };
      printRunResult(run);
    }
    } catch (error) {
      attempt = {
        ...baseAgentAttempt(config, timestamp, agentResult, changedFiles, "eval-error", true),
        error: (error as Error).message
      };
      console.log(`${attempt.error}`);
    }
  }

    if (!attempt) throw new Error("candidate attempt produced no outcome");
    const record = await writeAgentAttempt(cwd, timestamp, attempt, agentResult);
    console.log(`agent attempt: ${record}`);
    
    if (attempt.restored) {
      await restoreSnapshot(snapshot);
      console.log("restored snapshot after rejected candidate");
    }
    
    await removeSnapshot(persistentSnapshot);
    await removeSnapshot(snapshot);
    return attempt;
  } finally {
    activeSnapshot = null;
  }
}

export function agentEnvironment(args: string[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (args.includes("--diagnostics")) env.AR_AGENT_DIAGNOSTICS = "1";
  const provider = optionValue(args, "--agent");
  const model = optionValue(args, "--model");
  const reasoning = optionValue(args, "--reasoning");
  if (provider) env.AUTORESEARCH_AGENT = provider;
  if (model) env.AR_AGENT_MODEL = model;
  if (reasoning) env.CODEX_REASONING_EFFORT = reasoning;
  return Object.keys(env).length > 0 ? env : undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
      index += 1;
    } else if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  if (values.length > 1) throw new Error(`${name} may only be provided once`);
  return values[0];
}

async function runPrepareCandidateHook(cwd: string, config: Config): Promise<void> {
  const command = config.commands.prepareCandidate;
  if (!command) {
    return;
  }

  const result = await runCommand(command, cwd, config.budget.timeoutSeconds, {
    streamStdout: true,
    streamStderr: true,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `prepare candidate hook timed out after ${config.budget.timeoutSeconds}s`
        : `prepare candidate hook exited with code ${result.exitCode}`
    );
  }
}

async function recordAttempt(
  cwd: string,
  timestamp: string,
  attempt: AgentAttemptRecord,
  agentResult: CommandResult
): Promise<void> {
  const record = await writeAgentAttempt(cwd, timestamp, attempt, agentResult);
  console.log(`agent attempt: ${record}`);
}

// Generic pre-loop hook. Fires once before the loop begins.
//
// The harness knows nothing about why this hook exists; it only exposes its own
// state: the experiment command and the incumbent score cache. A domain hook
// may use these to refresh stale scores or veto starting the loop.
async function runPreLoopHook(cwd: string, config: Config): Promise<void> {
  const command = config.commands.preLoop;
  if (!command) {
    return;
  }

  const env: Record<string, string> = {
    AR_TIMESTAMP: new Date().toISOString(),
    AR_EXPERIMENT_CMD: config.commands.experiment,
    AR_METRIC_REGEX: config.metric.regex,
    AR_BEST_JSON: path.relative(cwd, bestPath(cwd)).replaceAll("\\", "/")
  };
  console.log("running pre-loop hook...");
  const result = await runCommand(
    command,
    cwd,
    config.agent?.timeoutSeconds ?? 300,
    { env, streamStdout: true, streamStderr: true }
  );

  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `pre-loop hook ${result.timedOut ? "timed out" : `exited with code ${result.exitCode}`}; aborting loop`
    );
  }
}

async function loop(cwd: string, maxIterationsOverride?: number): Promise<void> {
  const config = await loadConfig(cwd);
  const tradeLong = await loadTradeLongConfig(cwd);
  const maxIterations = maxIterationsOverride ?? config.loop.maxIterations;
  const maxNonImprovingRuns = config.loop.maxNonImprovingRuns;
  const commitAccepted = commandArgs.includes("--commit-accepted");
  if (commitAccepted) {
    await ensureAutoCommitReady(cwd, config);
  }

  await ensureState(cwd);
  await runPreLoopHook(cwd, config);

  if (tradeLong.numSlots > 1) {
    await hypothesisLoop(cwd, config, tradeLong, commitAccepted, maxIterations);
    return;
  }

  let iteration = 0;
  let consecutiveNonImproving = 0;
  while (maxIterations === 0 || iteration < maxIterations) {
    if (maxNonImprovingRuns > 0 && consecutiveNonImproving >= maxNonImprovingRuns) {
      console.log(`stopping: ${consecutiveNonImproving} consecutive non-improving runs`);
      return;
    }

    iteration += 1;
    console.log("");
    console.log("");
    console.log(`iteration ${iteration}`);
    const attempt = await agentOnce(cwd, { skipPreLoop: true });
    await printIterationSummary(cwd, iteration, attempt);

    if (attempt.outcome === "accepted") {
      if (commitAccepted) {
        await commitAcceptedAttempt(cwd, config, attempt);
      }
      consecutiveNonImproving = 0;
    } else if (attempt.outcome === "rejected") {
      consecutiveNonImproving += 1;
    }
  }

  console.log(`stopping: reached maxIterations ${maxIterations}`);
}

async function hypothesisLoop(
  cwd: string,
  config: Config,
  tradeLong: TradeLongConfig,
  commitAccepted: boolean,
  maxIterations: number
): Promise<void> {
  const globalBest = await readBest(cwd);
  if (!globalBest) {
    throw new Error("no best score found; run `pnpm run ar -- baseline` first");
  }
  await reconcileChampion(cwd, config, globalBest, commitAccepted);

  const numSlots = tradeLong.numSlots;
  const blockSize = tradeLong.maturationBlockSize;
  await preserveRootChampion(cwd);
  activeShutdownCleanup = async () => {
    clearHypothesisEnvironment();
    await restoreChampion(cwd, globalBest);
  };
  const hypotheses = await initializeHypotheses(cwd, numSlots);
  const scheduler = await loadScheduler(cwd, hypotheses.map((hypothesis) => hypothesis.id), numSlots);
  let iteration = 0;

  try {
    while (maxIterations === 0 || iteration < maxIterations) {
      const hypothesisId = selectMaturationBlock(scheduler);
      const selectedHypothesis = await readHypothesis(cwd, hypothesisId);
      if (!selectedHypothesis) throw new Error(`unknown hypothesis: ${hypothesisId}`);
      let cycle = await ensureActiveCycle(cwd, selectedHypothesis, tradeLong.structuralAttemptsPerCycle);
      for (
        let blockAttempt = 1;
        blockAttempt <= blockSize && (maxIterations === 0 || iteration < maxIterations);
        blockAttempt += 1
      ) {
        iteration += 1;
        const hypothesis = await readHypothesis(cwd, hypothesisId);
        if (!hypothesis) throw new Error(`unknown hypothesis: ${hypothesisId}`);
        await restoreHypothesis(cwd, hypothesisId);
        const incumbent = await ensureHypothesisBest(cwd, config, hypothesisId);
        await writeBest(cwd, incumbent);

        process.env.AUTORESEARCH_MODE = hypothesis.attemptCount > 0 ? "refine" : "explore";
        process.env.AR_HYPOTHESIS_ID = hypothesisId;
        process.env.AR_HYPOTHESIS_FAMILY = hypothesis.forecastingFamily;
        process.env.AR_HYPOTHESIS_STREAK = String(hypothesis.consecutiveNonImprovingAttempts);
        process.env.AR_CYCLE_ID = cycle.id;
        process.env.AR_CYCLE_ATTEMPT = String(cycle.attemptsConsumed + 1);
        process.env.AR_CYCLE_BUDGET = String(cycle.structuralBudget);
        console.log("");
        console.log(`iteration ${iteration}: ${hypothesisId} block attempt ${blockAttempt}/${blockSize}`);

        const attempt = await agentOnce(cwd, {
          skipPreLoop: true,
          updateBest: false
        });
        let cycleQualified = false;
        if (attempt.outcome === "accepted" && attempt.runRecord) {
          const cycleRun = await readRunRecord(cwd, attempt.runRecord);
          cycleQualified = cycleRun
            ? await passesPromotionGates(cwd, cycleRun.artifactFile)
            : false;
        }
        if (["accepted", "rejected", "no-change", "validation-error", "eval-error"].includes(attempt.outcome)) {
          cycle = recordCycleAttempt(cycle, cycleQualified);
          await writeCycle(cwd, cycle);
        }
        if (attempt.outcome === "accepted" && attempt.runRecord) {
          const run = await readRunRecord(cwd, attempt.runRecord);
          if (!run) {
            throw new Error("accepted hypothesis attempt is missing its run record");
          }
          const hypothesisBest = createBestRecord(config, run.timestamp, run.score, run.logFile, run.artifactFile);
          await persistHypothesisStrategy(cwd, hypothesisId);
          await writeHypothesisBest(cwd, hypothesisId, hypothesisBest);
          await recordHypothesisAttempt(cwd, hypothesisId, true);
          await preserveAcceptedArtifact(cwd, run.timestamp, config.accepted.preserve);
          let promoted = isImprovement(run.score, globalBest.score, 0);
          if (promoted) {
            promoted = await passesPromotionGates(cwd, run.artifactFile);
          }
          if (promoted) {
            promoted = await survivesFalsification(cwd, run.artifactFile);
          }
          let promotionHypothesisIds: string[] = [];
          if (promoted) {
            await writeBest(cwd, hypothesisBest);
            promotionHypothesisIds = await promoteChampion(cwd, hypothesisId);
            Object.assign(globalBest, hypothesisBest);
          }
          if (commitAccepted) {
            await commitAcceptedHypothesis(
              cwd,
              config,
              attempt,
              hypothesisId,
              incumbent.score,
              run.score,
              promoted,
              promotionHypothesisIds
            );
          }
        } else if (attempt.outcome === "rejected" || attempt.outcome === "no-change") {
          await recordHypothesisAttempt(cwd, hypothesisId, false);
        }
        await printIterationSummary(cwd, iteration, attempt, {
          slotBest: (await readHypothesisBest(cwd, hypothesisId))?.score,
          globalBest: globalBest.score
        });
        if (cycle.outcome !== "active") {
          await archiveCycle(cwd, cycle);
          const owner = await recordCompletedCycle(cwd, hypothesisId);
          console.log(`cycle ${cycle.id}: ${cycle.outcome} after ${cycle.attemptsConsumed}/${cycle.structuralBudget} attempts`);
          if (cycle.outcome === "qualified" && attempt.runRecord) {
            const qualifiedRun = await readRunRecord(cwd, attempt.runRecord);
            if (qualifiedRun) {
              const saved = await preserveQualifiedCandidate(cwd, cycle, qualifiedRun.score, qualifiedRun.artifactFile);
              console.log(`qualified candidate: ${saved}`);
            }
          }
          if (cycle.outcome !== "qualified" && (owner.completedCycles ?? 0) >= tradeLong.maxCyclesPerLineage) {
            await suspendAssignment(cwd, scheduler, hypothesisId);
            console.log(`suspended ${hypothesisId}: exhausted ${owner.completedCycles} bounded cycles`);
          }
          if (allAssignmentsSuspended(scheduler)) {
            await replaceExhaustedLineage(cwd, scheduler);
          } else {
            await advanceScheduler(cwd, scheduler);
          }
          await restoreChampion(cwd, globalBest);
          clearHypothesisEnvironment();
          break;
        }
        await restoreChampion(cwd, globalBest);
        clearHypothesisEnvironment();
      }
      // An active cycle keeps its assignment. Rotation happens only at the
      // explicit terminal boundary above, never because one attempt failed.
    }
  } finally {
    clearHypothesisEnvironment();
    await restoreChampion(cwd, globalBest);
    activeShutdownCleanup = null;
  }

  console.log(`stopping: reached maxIterations ${maxIterations}`);
}

async function replaceExhaustedLineage(cwd: string, scheduler: Awaited<ReturnType<typeof loadScheduler>>): Promise<void> {
  const scored = await Promise.all(scheduler.assignments.map(async (id) => ({
    id,
    score: (await readHypothesisBest(cwd, id))?.score
  })));
  const leastDesired = scored.reduce((worst, candidate) => {
    if (candidate.score === undefined) return candidate;
    if (worst.score === undefined) return worst;
    return isImprovement(worst.score, candidate.score, 0) ? candidate : worst;
  });
  const parents = await selectBreedingParents(cwd, scored, leastDesired.id);
  const replacement = parents
    ? await retireAndBreed(cwd, leastDesired.id, parents[0], parents[1], leastDesired.score)
    : await retireAndReseed(cwd, leastDesired.id, leastDesired.score);
  await replaceAssignment(cwd, scheduler, leastDesired.id, replacement.id);
  console.log(
    parents
      ? `all hypotheses exhausted; archived ${leastDesired.id}; bred ${replacement.id} from ${parents[0].id} + ${parents[1].id}`
      : `all hypotheses exhausted; archived ${leastDesired.id}; assigned fresh ${replacement.id}`
  );
}

// Breeding parents: the highest-scoring surviving lineage (other than the
// retiree) paired with the distinct-family partner it is *least correlated*
// with. Distinct families are required because recombination only adds search
// power when the components are different in kind, not two variants of the same
// idea. A lineage whose best strategy is killed by an offline falsification
// attack is excluded: breeding from a lucky edge only propagates the luck.
//
// Score alone cannot see redundancy: two lineages can share zero trades yet
// bet the same way (high fold correlation). Given the champion, pairing it with
// the least-correlated partner spends the evaluation budget on a direction the
// archive lacks rather than on a near-duplicate. Correlation only *re-orders*
// otherwise-eligible partners; it never admits a same-family or killed pair, and
// it falls back to score order when the archive carries no comparable folds.
async function selectBreedingParents(
  cwd: string,
  scored: Array<{ id: string; score: number | undefined }>,
  retiredId: string
): Promise<[{ id: string; score: number }, { id: string; score: number }] | null> {
  const scoredCandidates = scored
    .filter((entry): entry is { id: string; score: number } =>
      entry.id !== retiredId && typeof entry.score === "number" && entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const candidates: Array<{ id: string; score: number }> = [];
  for (const candidate of scoredCandidates) {
    const best = await readHypothesisBest(cwd, candidate.id);
    if (await falsificationVerdict(cwd, best?.artifactFile) === "killed") {
      console.log(`breeding: excluding ${candidate.id}; its best strategy is killed by an offline attack`);
      continue;
    }
    candidates.push(candidate);
  }
  const { entries } = await loadArchiveLineages(cwd);
  for (const first of candidates) {
    const firstHypothesis = await readHypothesis(cwd, first.id);
    if (!firstHypothesis) continue;
    const partners: Array<{ id: string; score: number }> = [];
    for (const second of candidates) {
      if (second.id === first.id) continue;
      const secondHypothesis = await readHypothesis(cwd, second.id);
      if (!secondHypothesis) continue;
      if (secondHypothesis.forecastingFamily !== firstHypothesis.forecastingFamily) partners.push(second);
    }
    if (partners.length === 0) continue;
    const partner = leastCorrelatedPartner(entries, first.id, partners);
    if (partner.id !== partners[0].id) {
      console.log(`breeding: pairing champion ${first.id} with least-correlated partner ${partner.id}`);
    }
    return [first, partner];
  }
  return null;
}

// Among the distinct-family partners of `championId`, prefer the one whose best
// archived fold-profit vector is least correlated with the champion's. Partners
// with no comparable archive entry keep their score rank (they sort after every
// partner with a known correlation, and among themselves by the incoming order,
// which is score-descending).
function leastCorrelatedPartner(
  entries: LineageEntry[],
  championId: string,
  partners: Array<{ id: string; score: number }>
): { id: string; score: number } {
  let best = partners[0];
  let bestKey = Number.POSITIVE_INFINITY;
  for (const partner of partners) {
    const ci = correlationBetween(entries, championId, partner.id);
    const key = ci?.estimate ?? Number.POSITIVE_INFINITY;
    if (key < bestKey) {
      bestKey = key;
      best = partner;
    }
  }
  return best;
}

interface ArtifactWithTrades {
  trades?: Array<{ fold?: unknown; profit?: unknown }>;
  diagnostics?: { folds?: Array<{ name?: unknown }> };
}

function significanceTrades(artifact: ArtifactWithTrades): Array<{ fold: string; profit: number }> {
  return (artifact.trades ?? [])
    .filter((trade) => typeof trade.fold === "string" && typeof trade.profit === "number")
    .map((trade) => ({ fold: trade.fold as string, profit: trade.profit as number }));
}

async function runSignificanceGate(
  cwd: string,
  candidateArtifact: unknown,
  incumbentArtifactFile: string,
): Promise<{ passed: boolean; reason: string }> {
  let incumbent: ArtifactWithTrades;
  try {
    incumbent = JSON.parse(
      await readFile(path.join(cwd, incumbentArtifactFile), "utf8")
    ) as ArtifactWithTrades;
  } catch {
    return { passed: true, reason: "no incumbent artifact; gate waived" };
  }

  const candidate = candidateArtifact as ArtifactWithTrades;
  const candidateTrades = significanceTrades(candidate);
  const incumbentTrades = significanceTrades(incumbent);
  if (candidateTrades.length === 0) {
    return { passed: true, reason: "candidate artifact has no fold trades; gate waived" };
  }
  const folds = [...new Set([
    ...(candidate.diagnostics?.folds ?? []).map((fold) => String(fold.name ?? "")),
    ...candidateTrades.map((trade) => trade.fold),
  ])].filter(Boolean).sort();

  const { assessSignificance } = await import("../significance.js");
  const result = assessSignificance(candidateTrades, incumbentTrades, folds);
  return { passed: result.passed, reason: result.reason };
}

// Fold-robustness promotion gate. The score itself is the honest median fold
// score (so lineages can climb through negative territory), which means a
// candidate can beat the global best while still failing promotion robustness.
// A candidate must clear the evaluator's positive-fold-return and
// maximum-drawdown gates before becoming the root champion.
async function passesPromotionGates(cwd: string, artifactFile?: string): Promise<boolean> {
  if (!artifactFile) {
    console.log("promotion gate: no candidate artifact; promotion denied");
    return false;
  }
  let summary: { promotable?: unknown; promotionGates?: Record<string, unknown> };
  try {
    const artifact = JSON.parse(await readFile(path.join(cwd, artifactFile), "utf8")) as {
      summary?: { promotable?: unknown; promotionGates?: Record<string, unknown> };
    };
    summary = artifact.summary ?? {};
  } catch {
    console.log("promotion gate: candidate artifact unreadable; promotion denied");
    return false;
  }
  if (summary.promotable === true) {
    console.log("promotion gate: positive-fold-return and drawdown gates passed");
    return true;
  }
  const blocked = Object.entries(summary.promotionGates ?? {})
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  console.log(`promotion gate: blocked (${blocked.join(",") || "not promotable"}); promotion denied`);
  return false;
}

// Falsification verdict for a scored artifact. A "killed" verdict (thin sample
// or an edge that vanishes when one trade/fold is removed) blocks the artifact
// from becoming champion or a breeding parent; "weakened" and "survived" pass.
// Only the offline attacks run here — no backtest — so this is cheap enough to
// call on every promotion and parent-selection decision.
async function falsificationVerdict(cwd: string, artifactFile?: string): Promise<"survived" | "weakened" | "killed" | "unknown"> {
  if (!artifactFile) return "unknown";
  try {
    const artifact = JSON.parse(
      await readFile(path.join(cwd, artifactFile), "utf8")
    ) as EvaluationArtifact;
    return auditArtifact(artifactFile, artifact, new Date().toISOString()).verdict;
  } catch {
    return "unknown";
  }
}

async function survivesFalsification(cwd: string, artifactFile?: string): Promise<boolean> {
  const verdict = await falsificationVerdict(cwd, artifactFile);
  if (verdict === "killed") {
    console.log(`falsification gate: candidate killed by an offline attack; promotion denied`);
    return false;
  }
  return true;
}

// Audit the standing champion. If it survives, nothing changes. If it is killed
// by an offline attack (e.g. promoted before the falsification gate existed),
// demote to the best-scoring qualified entry that survives — a lower-scoring
// survivor is preferable to a champion whose edge does not withstand attack.
// Restores the survivor's strategy into the working tree and rewrites best.json;
// leaves the tree dirty for the operator to commit when auto-commit is off.
async function reconcileChampion(cwd: string, config: Config, globalBest: BestResult, commitAccepted: boolean): Promise<void> {
  if (await falsificationVerdict(cwd, globalBest.artifactFile) !== "killed") return;

  console.log("reconcile: standing champion is KILLED by an offline attack; searching for a survivor");
  const qualifiedRoot = path.join(cwd, ".autoresearch", "qualified");
  let entries: string[];
  try {
    entries = (await readdir(qualifiedRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    console.log("reconcile: no qualified archive; leaving killed champion in place");
    return;
  }

  const candidates: ArchiveCandidate[] = [];
  for (const entry of entries) {
    try {
      const artifact = JSON.parse(
        await readFile(path.join(qualifiedRoot, entry, "evaluation.json"), "utf8")
      ) as EvaluationArtifact & { primary?: { value?: unknown } };
      const score = Number((artifact.primary as { value?: unknown } | undefined)?.value);
      candidates.push({
        entry,
        score,
        verdict: auditArtifact(entry, artifact, new Date().toISOString()).verdict,
      });
    } catch {
      // unreadable entry; skip
    }
  }

  const survivor = selectBestSurviving(candidates);
  if (!survivor) {
    console.log("reconcile: no surviving qualified entry; leaving killed champion in place");
    return;
  }

  const entryRoot = path.join(qualifiedRoot, survivor.entry, "research", "trade-long");
  for (const file of CHAMPION_EDITABLE) {
    await cp(path.join(entryRoot, path.basename(file)), path.join(cwd, file));
  }
  const demoted = createBestRecord(
    config,
    new Date().toISOString(),
    survivor.score,
    globalBest.logFile,
    path.join(".autoresearch", "qualified", survivor.entry, "evaluation.json"),
  );
  await writeBest(cwd, demoted);
  Object.assign(globalBest, demoted);
  await preserveRootChampion(cwd);

  if (commitAccepted && await isInsideGitRepo(cwd)) {
    await commitFiles(
      cwd,
      CHAMPION_EDITABLE,
      `Demote killed champion to ${survivor.entry} ${survivor.score}\n\n` +
        `The standing champion was killed by an offline falsification attack.\n` +
        `Reconciled to the best surviving qualified entry.`
    );
    console.log(`reconcile: demoted killed champion to ${survivor.entry} (score ${survivor.score}); committed`);
  } else {
    console.log(`reconcile: demoted killed champion to ${survivor.entry} (score ${survivor.score}); working tree left dirty for commit`);
  }
}

async function ensureHypothesisBest(cwd: string, config: Config, hypothesisId: string): Promise<BestResult> {
  const existing = await readHypothesisBest(cwd, hypothesisId);
  if (existing) return existing;

  await runSetup(config, cwd);
  const timestamp = new Date().toISOString();
  const result = await runCommand(config.commands.experiment, cwd, config.budget.timeoutSeconds);
  const logFile = await writeLog(cwd, `${timestamp}-hypothesis-baseline`, result);
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`failed to score initial incumbent for ${hypothesisId}; see ${logFile}`);
  }
  const artifact = config.metric.artifactPath
    ? await readResultArtifact(cwd, config.metric.artifactPath)
    : undefined;
  const artifactFile = await copyResultArtifact(cwd, timestamp, config.metric.artifactPath);
  const score = artifact
    ? metricFromArtifact(artifact, config)
    : extractMetric(`${result.stdout}\n${result.stderr}`, config.metric.regex);
  const best = createBestRecord(config, timestamp, score, logFile, artifactFile);
  await writeHypothesisBest(cwd, hypothesisId, best);
  await appendTrial(cwd, {
    schemaVersion: 1,
    timestamp,
    source: "baseline",
    score,
    accepted: true,
    hypothesisId,
    ...(process.env.AR_CYCLE_ID ? { cycleId: process.env.AR_CYCLE_ID } : {}),
    ...(artifactFile ? { artifactFile } : {})
  });
  return best;
}

// Wipe the scratchpad so each agent run starts with an empty sandbox/ — throwaway
// analysis scripts from a prior iteration never leak into the next one. The dir is
// gitignored and scope-excluded, so removing it is safe and never touched by git.
async function clearSandbox(cwd: string): Promise<void> {
  await rm(path.join(cwd, "sandbox"), { recursive: true, force: true });
  await mkdir(path.join(cwd, "sandbox"), { recursive: true });
}

function clearHypothesisEnvironment(): void {
  delete process.env.AUTORESEARCH_MODE;
  delete process.env.AR_HYPOTHESIS_ID;
  delete process.env.AR_HYPOTHESIS_FAMILY;
  delete process.env.AR_HYPOTHESIS_STREAK;
  delete process.env.AR_CYCLE_ID;
  delete process.env.AR_CYCLE_ATTEMPT;
  delete process.env.AR_CYCLE_BUDGET;
}

async function ensureActiveCycle(
  cwd: string,
  hypothesis: NonNullable<Awaited<ReturnType<typeof readHypothesis>>>,
  structuralBudget: number
): Promise<ResearchCycle> {
  const existing = await readCycle(cwd, hypothesis.id);
  if (existing?.outcome === "active") return existing;
  const cycle = startCycle(
    hypothesis.id,
    hypothesis.forecastingFamily,
    (hypothesis.completedCycles ?? 0) + 1,
    structuralBudget
  );
  await writeCycle(cwd, cycle);
  return cycle;
}

const CHAMPION_EDITABLE = [
  "research/trade-long/strategy.ts",
  "research/trade-long/strategy.md",
];

async function restoreChampion(cwd: string, best: BestResult): Promise<void> {
  // Always restore root editable files from git (the source of truth for the
  // last globally promoted version). The champion's hypothesis directory may
  // have drifted ahead with local improvements that failed promotion gates —
  // copying those into root would leave the tree dirty and inconsistent with
  // best.json. Fall back to the champion's files or cached snapshot only when
  // git is unavailable.
  let restored = false;
  if (await isInsideGitRepo(cwd)) {
    try {
      await revertFiles(cwd, CHAMPION_EDITABLE);
      restored = true;
    } catch {
      // fall through to hypothesis dir or cached snapshot
    }
  }
  if (!restored) {
    const champion = (await initializeHypotheses(cwd, 0)).find((hypothesis) => hypothesis.status === "champion");
    if (champion) {
      await restoreHypothesis(cwd, champion.id);
    } else {
      const source = path.join(cwd, ".autoresearch/champion");
      await cp(path.join(source, "strategy.ts"), path.join(cwd, "research/trade-long/strategy.ts"));
      await cp(path.join(source, "strategy.md"), path.join(cwd, "research/trade-long/strategy.md"));
    }
  }
  await writeBest(cwd, best);
}

async function preserveRootChampion(cwd: string): Promise<void> {
  // Snapshot the current champion code as a non-git fallback for restoreChampion
  // (used only when git is unavailable). Always refresh it so it never drifts
  // from the current boilerplate — the write-once behaviour it replaced left the
  // snapshot stale and resurrected removed code on loop exit.
  const target = path.join(cwd, ".autoresearch/champion");
  await mkdir(target, { recursive: true });
  await cp(path.join(cwd, "research/trade-long/strategy.ts"), path.join(target, "strategy.ts"));
  await cp(path.join(cwd, "research/trade-long/strategy.md"), path.join(target, "strategy.md"));
}

async function ensureAutoCommitReady(cwd: string, config: Config): Promise<void> {
  if (!await isInsideGitRepo(cwd)) {
    throw new Error("--commit-accepted requires a git repo");
  }

  const dirtyCommitFiles = await listChangedFilesForPaths(cwd, commitPaths(config));
  if (dirtyCommitFiles.length > 0) {
    throw new Error(`--commit-accepted requires clean editable files before loop: ${dirtyCommitFiles.join(", ")}`);
  }
}

async function commitAcceptedAttempt(cwd: string, config: Config, attempt: AgentAttemptRecord): Promise<void> {
  if (!await isInsideGitRepo(cwd)) {
    console.log("accepted candidate not committed: not inside a git repo");
    return;
  }

  const changedFiles = await listChangedFilesForPaths(cwd, commitPaths(config));
  if (changedFiles.length === 0) {
    console.log("accepted candidate not committed: no tracked changes");
    return;
  }

  const run = attempt.runRecord
    ? await readRunRecord(cwd, attempt.runRecord)
    : null;
  const subjectScore = run ? formatNumber(run.score) : "accepted";
  const body = [
    `Metric: ${config.metric.name}`,
    run ? `Score: ${run.score}` : null,
    run ? `Previous best: ${run.bestBefore}` : null,
    `Run: ${attempt.timestamp}`
  ].filter((line): line is string => line !== null);

  await commitFiles(
    cwd,
    changedFiles,
    `Accept candidate ${subjectScore}\n\n${body.join("\n")}`
  );
  console.log(`committed accepted candidate: ${changedFiles.join(", ")}`);
}

async function commitAcceptedHypothesis(
  cwd: string,
  config: Config,
  attempt: AgentAttemptRecord,
  hypothesisId: string,
  previousScore: number,
  score: number,
  promoted: boolean,
  promotionHypothesisIds: string[]
): Promise<void> {
  const paths = [
    ...hypothesisTrackedPaths(hypothesisId),
    ...promotionHypothesisIds.flatMap((id) => hypothesisTrackedPaths(id)),
    ...config.scope.persistent,
    ...(promoted ? config.scope.editable : [])
  ];
  const changedFiles = await listChangedFilesForPaths(cwd, [...new Set(paths)]);
  if (changedFiles.length === 0) {
    console.log(`accepted ${hypothesisId} not committed: no tracked changes`);
    return;
  }

  const body = [
    `Hypothesis: ${hypothesisId}`,
    `Metric: ${config.metric.name}`,
    `Score: ${score}`,
    `Previous hypothesis best: ${previousScore}`,
    `Global promotion: ${promoted ? "yes" : "no"}`,
    `Run: ${attempt.timestamp}`
  ];
  await commitFiles(
    cwd,
    changedFiles,
    `Accept ${hypothesisId} ${formatNumber(score)}\n\n${body.join("\n")}`
  );
  console.log(`committed accepted ${hypothesisId}: ${changedFiles.join(", ")}`);
}

function commitPaths(config: Config): string[] {
  return [...new Set([...config.scope.editable, ...config.scope.persistent])];
}

async function printIterationSummary(
  cwd: string,
  iteration: number,
  attempt: AgentAttemptRecord,
  slotScores?: {
    slotBest: number | undefined;
    globalBest: number | undefined;
  }
): Promise<void> {
  const best = await readBest(cwd);
  const run = attempt.runRecord
    ? await readRunRecord(cwd, attempt.runRecord)
    : null;

  const score = run ? formatNumber(run.score) : "n/a";
  const bestBefore = run ? formatNumber(run.bestBefore) : "n/a";
  const currentBest = formatNumber(best?.score);
  const displayedScore = run ? score : attempt.outcome === "no-change" ? currentBest : "n/a";
  const bestFields = slotScores
    ? [
        `slotBest=${formatNumber(slotScores.slotBest)}`,
        `globalBest=${formatNumber(slotScores.globalBest)}`
      ]
    : [`currentBest=${currentBest}`];

  console.log(
    [
      `iteration ${iteration} summary:`,
      `outcome=${attempt.outcome}`,
      `score=${displayedScore}`,
      `bestBefore=${bestBefore}`,
      ...bestFields
    ].join(" ")
  );
}

async function readRunRecord(cwd: string, relativePath: string): Promise<RunRecord | null> {
  try {
    const raw = await readFile(path.join(cwd, relativePath), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "n/a";
}

function baseAgentAttempt(
  config: Config,
  timestamp: string,
  agentResult: { exitCode: number | null; durationMs: number; timedOut: boolean },
  changedFiles: string[],
  outcome: AgentAttemptRecord["outcome"],
  restored: boolean
): AgentAttemptRecord {
  return {
    timestamp,
    agentCommand: config.agent?.command ?? "",
    agentTimedOut: agentResult.timedOut,
    agentExitCode: agentResult.exitCode,
    agentDurationMs: agentResult.durationMs,
    changedFiles,
    outcome,
    restored
  };
}

function createBestRecord(
  config: Config,
  timestamp: string,
  score: number,
  logFile: string,
  artifactFile?: string
): BestResult {
  return {
    timestamp,
    command: config.commands.experiment,
    metricName: config.metric.name,
    score,
    logFile,
    ...(artifactFile ? { artifactFile } : {})
  };
}

async function status(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const tradeLong = await loadTradeLongConfig(cwd);
  const best = await readBest(cwd);
  const lastRun = await readLastRun(cwd);
  const gitReady = config.git.enabled && await isInsideGitRepo(cwd);
  console.log(`metric: ${config.metric.name}`);
  console.log(`best score: ${best ? best.score : "none"}`);
  const trials = await readTrialSummary(cwd);
  console.log(`trials: ${trials.total} total, ${trials.accepted} accepted (${Object.entries(trials.bySource).map(([source, count]) => `${source}=${count}`).join(", ") || "none"})`);
  const pbo = await campaignPbo(cwd);
  console.log(`campaign PBO: ${pbo ? `${(pbo.probability * 100).toFixed(1)}% (${pbo.candidates} candidates, ${pbo.splits} splits)` : "insufficient evidence"}`);
  if (tradeLong.numSlots > 1) {
    const hypotheses = await listHypotheses(cwd);
    console.log(
      `hypotheses: ${hypotheses.map((hypothesis) =>
        `${hypothesis.id}=${hypothesis.status}/cycles:${hypothesis.completedCycles ?? 0}`
      ).join(", ") || "none"}`
    );
  }

  if (lastRun) {
    const result = lastRun.accepted ? "accepted" : "rejected";
    console.log(`last run: ${result}, score ${lastRun.score}, ${lastRun.timestamp}`);
  } else {
    console.log("last run: none");
  }

  if (gitReady) {
    console.log("git dirty state:");
    console.log(await dirtyStatus(cwd));
  } else {
    console.log("git dirty state: unavailable or not a git repo");
  }
  await printStateWarnings(cwd, best, lastRun);
}

async function printStateWarnings(
  cwd: string,
  best: BestResult | null,
  lastRun: RunRecord | null
): Promise<void> {
  const warnings: string[] = [];
  if (best?.logFile && !await pathExists(cwd, best.logFile)) {
    warnings.push(`best log is missing: ${best.logFile}`);
  }
  if (best?.artifactFile && !await pathExists(cwd, best.artifactFile)) {
    warnings.push(`best artifact is missing: ${best.artifactFile}`);
  }
  if (lastRun?.artifactFile && !await pathExists(cwd, lastRun.artifactFile)) {
    warnings.push(`last run artifact is missing: ${lastRun.artifactFile}`);
  }

  const schedulerPath = path.join(cwd, ".autoresearch/scheduler.json");
  try {
    const scheduler = JSON.parse(await readFile(schedulerPath, "utf8")) as { assignments?: unknown };
    if (Array.isArray(scheduler.assignments)) {
      const hypotheses = await listHypotheses(cwd);
      const existing = new Set(hypotheses.map((hypothesis) => hypothesis.id));
      const missing = scheduler.assignments
        .filter((id): id is string => typeof id === "string")
        .filter((id) => !existing.has(id));
      if (missing.length > 0) {
        warnings.push(`scheduler assignments missing from hypothesis directory: ${missing.join(", ")}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (warnings.length > 0) {
    console.log("state warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

async function pathExists(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(cwd, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadTradeLongConfig(cwd: string): Promise<TradeLongConfig> {
  const raw = JSON.parse(
    await readFile(path.join(cwd, "autoresearch.config.json"), "utf8")
  ) as { tradeLong?: Partial<TradeLongConfig> };
  const config = raw.tradeLong;
  if (!config) throw new Error("tradeLong config is required");
  return {
    numSlots: positiveInteger(config.numSlots, "tradeLong.numSlots"),
    maturationBlockSize: positiveInteger(
      config.maturationBlockSize,
      "tradeLong.maturationBlockSize"
    ),
    structuralAttemptsPerCycle: positiveInteger(
      config.structuralAttemptsPerCycle ?? 8,
      "tradeLong.structuralAttemptsPerCycle"
    ),
    maxCyclesPerLineage: positiveInteger(
      config.maxCyclesPerLineage ?? 3,
      "tradeLong.maxCyclesPerLineage"
    )
  };
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

async function runSetup(config: Config, cwd: string): Promise<void> {
  if (!config.commands.setup.trim()) {
    return;
  }

  const result = await runCommand(config.commands.setup, cwd, config.budget.timeoutSeconds);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("setup command failed");
  }
}

function usage(): void {
  console.log(`AutoResearch CLI

Usage:
  pnpm run ar -- <command> [options]
  pnpm run ar -- --help

Commands:
  baseline [--reset]
      Seed or update .autoresearch/best.json.
      Without flags, evaluates the current candidate and saves it if it improves
      on the existing best. Use --reset to replace the existing best explicitly.

  run-once
      Evaluate the current working candidate against the saved best.

  agent-once [--agent <pi|codex>] [--model <name>] [--reasoning <level>] [--commit-accepted] [--diagnostics]
      Run the same scheduler and acceptance path as loop for exactly one
      iteration.

  loop [--agent <pi|codex>] [--model <name>] [--reasoning <level>] [--commit-accepted] [--diagnostics]
      Run repeated agent attempts using loop settings from autoresearch.config.json.
      Runs the configured pre-loop hook before attempts begin.
      With --commit-accepted, commit every accepted hypothesis local best.
      Global promotions also include the root editable strategy files.
      With --diagnostics, retain detailed agent events in the normal
      .autoresearch/agent attempt log without streaming them live.
      Agent flags override environment variables, which override config.

  status
      Show metric, best score, last run, and git dirty state.

  help, --help, -h
      Show this help.
`);
}
