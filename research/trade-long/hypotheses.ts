import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BestResult } from "../../src/types.js";

export type HypothesisStatus = "active" | "suspended" | "archived" | "champion";

export interface Hypothesis {
  id: string;
  status: HypothesisStatus;
  forecastingFamily: string;
  attemptCount: number;
  consecutiveNonImprovingAttempts: number;
  generation: number;
  completedCycles?: number;
  parent?: string;
  parents?: string[];
}

export interface SchedulerState {
  assignments: string[];
  nextAssignment: number;
  suspended: string[];
}

const DEFAULT_FAMILIES = [
  "signal-processing",
  "failure-forecasting",
  "weather-ensemble-forecasting",
  "control-theory",
  "information-theory",
  "anomaly-detection"
];

const FAMILY_DESCRIPTIONS: Record<string, string> = {
  "signal-processing": `# Hypothesis Direction

## Family
signal-processing

## Approach
Treat price action as a noisy signal and apply signal-processing concepts to
extract high-probability entry points. Use EMA-based filters to separate trend
from noise, and enter when the high-frequency component (price) pulls back
toward the low-frequency component (trend EMA) without the trend reversing.
Consider frequency separation, signal-to-noise ratio (candle integrity), and
adaptive bandwidth (ATR-based risk sizing).

## Rationale
Signal-processing frameworks are natural fits for financial time series because
price data is fundamentally a noisy signal with embedded trend components.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`,
  "failure-forecasting": `# Hypothesis Direction

## Family
failure-forecasting

## Approach
Frame trade entry as a failure-avoidance problem: instead of predicting when
price will rise, identify conditions where pullback-to-support failures are
least likely. Use SMA-based support zones and filter out conditions associated
with high failure probability (overextension, weak intraday action, declining
volume). Model the hazard rate of hitting stop-loss.

## Rationale
Most pullback strategies fail because they enter at support levels about to
break. Explicitly modeling support reliability should improve win rates.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`,
  "weather-ensemble-forecasting": `# Hypothesis Direction

## Family
weather-ensemble-forecasting

## Approach
Apply ensemble forecasting concepts from meteorology. Treat multiple technical
signals (trend, volatility, momentum, volume) as independent ensemble members
and enter when sufficient consensus exists. Use volatility expansion as a
forecast trigger (analogous to atmospheric instability) and Fractal Efficiency
Ratio as a directional-content measure.

## Rationale
Combining multiple imperfect models outperforms any single model. Requiring
consensus across diverse indicators should reduce false signals.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`,
  "control-theory": `# Hypothesis Direction

## Family
control-theory

## Approach
Model the trend-pullback system as a control loop where price oscillates around
a moving-average setpoint. Entry is triggered when price enters a specific
control zone between two moving averages, analogous to a system returning to
its setpoint after a disturbance. Use ATR-scaled dead-bands/hysteresis to avoid
false triggers.

## Rationale
Control theory provides a rigorous framework for understanding mean-reversion
within trends. The inter-MA zone is a natural control-zone concept.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`,
  "information-theory": `# Hypothesis Direction

## Family
information-theory

## Approach
Apply information-theoretic concepts to trade entry: measure the information
content of recent price action and enter when the market transmits a
high-confidence directional signal with low entropy. Identify which technical
conditions carry the most mutual information with future returns and weight
entry conditions accordingly.

## Rationale
Information theory provides a framework for distinguishing signal from noise.
Entering only when the market clearly communicates directional intent should
improve signal quality.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`,
  "anomaly-detection": `# Hypothesis Direction

## Family
anomaly-detection

## Approach
Frame trade entry as anomaly detection: identify when price is in an anomalously
favorable position relative to its support structure and enter before the anomaly
resolves. Price near a rising support level in a confirmed uptrend is anomalously
cheap. Keep the anomaly detector as simple as possible — over-specified detectors
overfit to noise.

## Rationale
Anomaly detection is well-suited to mean-reversion-within-trend strategies because
a pullback to support is the anomaly to exploit.

## Key Constraints
None yet — new hypothesis.

## Parents
None — original family assignment.
`
};

export function hypothesesDir(cwd: string): string {
  return path.join(cwd, "research/trade-long/hypotheses");
}

export function hypothesisDir(cwd: string, id: string): string {
  return path.join(hypothesesDir(cwd), id);
}

export function hypothesisStateDir(cwd: string, id: string): string {
  return path.join(cwd, ".autoresearch/hypotheses", id);
}

export function hypothesisTrackedPaths(id: string): string[] {
  return [
    `research/trade-long/hypotheses/${id}/hypothesis.json`,
    `research/trade-long/hypotheses/${id}/hypothesis.md`,
    `research/trade-long/hypotheses/${id}/strategy.ts`,
    `research/trade-long/hypotheses/${id}/strategy.md`,
    `research/trade-long/hypotheses/${id}/falsifications.md`,
    `research/trade-long/hypotheses/${id}/cycles`
  ];
}

export async function initializeHypotheses(cwd: string, count: number): Promise<Hypothesis[]> {
  const existing = await listHypotheses(cwd);
  const active = existing.filter((hypothesis) => hypothesis.status === "active" || hypothesis.status === "champion");
  for (const hypothesis of active) await ensureHypothesisFalsifications(cwd, hypothesis.id);
  for (let index = active.length; index < count; index += 1) {
    active.push(await createHypothesis(cwd, DEFAULT_FAMILIES[index % DEFAULT_FAMILIES.length], 1));
  }
  return active;
}

export async function createHypothesis(
  cwd: string,
  forecastingFamily: string,
  generation: number,
  parent?: string
): Promise<Hypothesis> {
  const id = await nextHypothesisId(cwd);
  const hypothesis: Hypothesis = {
    id,
    status: "active",
    forecastingFamily,
    attemptCount: 0,
    consecutiveNonImprovingAttempts: 0,
    generation,
    ...(parent ? { parent } : {})
  };
  const target = hypothesisDir(cwd, id);
  await mkdir(target, { recursive: true });
  await cp(path.join(cwd, "research/trade-long/strategy-boilerplate.ts"), path.join(target, "strategy.ts"));
  await cp(path.join(cwd, "research/trade-long/strategy-boilerplate.md"), path.join(target, "strategy.md"));
  const directionContent = FAMILY_DESCRIPTIONS[forecastingFamily] ?? defaultHypothesisDirection(forecastingFamily);
  await writeFile(path.join(target, "hypothesis.md"), hypothesisFromDirection(directionContent));
  await writeFile(path.join(target, "falsifications.md"), defaultFalsifications());
  await writeHypothesis(cwd, hypothesis);
  return hypothesis;
}

export async function listHypotheses(cwd: string): Promise<Hypothesis[]> {
  let entries: string[];
  try {
    entries = await readdir(hypothesesDir(cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const hypotheses = await Promise.all(entries.map((id) => readHypothesis(cwd, id)));
  return hypotheses.filter((hypothesis): hypothesis is Hypothesis => hypothesis !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function readHypothesis(cwd: string, id: string): Promise<Hypothesis | null> {
  try {
    return JSON.parse(await readFile(path.join(hypothesisDir(cwd, id), "hypothesis.json"), "utf8")) as Hypothesis;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeHypothesis(cwd: string, hypothesis: Hypothesis): Promise<void> {
  await mkdir(hypothesisDir(cwd, hypothesis.id), { recursive: true });
  await writeFile(
    path.join(hypothesisDir(cwd, hypothesis.id), "hypothesis.json"),
    `${JSON.stringify(hypothesis, null, 2)}\n`
  );
}

export async function restoreHypothesis(cwd: string, id: string): Promise<void> {
  await cp(path.join(hypothesisDir(cwd, id), "strategy.ts"), path.join(cwd, "research/trade-long/strategy.ts"));
  await cp(path.join(hypothesisDir(cwd, id), "strategy.md"), path.join(cwd, "research/trade-long/strategy.md"));
  await cp(path.join(hypothesisDir(cwd, id), "falsifications.md"), path.join(cwd, "research/trade-long/falsifications.md"));
  try {
    await cp(path.join(hypothesisDir(cwd, id), "hypothesis.md"), path.join(cwd, "research/trade-long/hypothesis.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function persistHypothesisStrategy(cwd: string, id: string): Promise<void> {
  await cp(path.join(cwd, "research/trade-long/strategy.ts"), path.join(hypothesisDir(cwd, id), "strategy.ts"));
  await cp(path.join(cwd, "research/trade-long/strategy.md"), path.join(hypothesisDir(cwd, id), "strategy.md"));
  await cp(path.join(cwd, "research/trade-long/falsifications.md"), path.join(hypothesisDir(cwd, id), "falsifications.md"));
  // hypothesis.md is a frozen direction document, not agent-editable.
}

export async function readHypothesisBest(cwd: string, id: string): Promise<BestResult | null> {
  try {
    return JSON.parse(await readFile(path.join(hypothesisStateDir(cwd, id), "best.json"), "utf8")) as BestResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeHypothesisBest(cwd: string, id: string, best: BestResult): Promise<void> {
  await mkdir(hypothesisStateDir(cwd, id), { recursive: true });
  await writeFile(path.join(hypothesisStateDir(cwd, id), "best.json"), `${JSON.stringify(best, null, 2)}\n`);
}

export async function recordHypothesisAttempt(cwd: string, id: string, improved: boolean): Promise<Hypothesis> {
  const hypothesis = await readHypothesis(cwd, id);
  if (!hypothesis) throw new Error(`unknown hypothesis: ${id}`);
  hypothesis.attemptCount += 1;
  hypothesis.consecutiveNonImprovingAttempts = improved
    ? 0
    : hypothesis.consecutiveNonImprovingAttempts + 1;
  await writeHypothesis(cwd, hypothesis);
  return hypothesis;
}

export async function recordCompletedCycle(cwd: string, id: string): Promise<Hypothesis> {
  const hypothesis = await readHypothesis(cwd, id);
  if (!hypothesis) throw new Error(`unknown hypothesis: ${id}`);
  hypothesis.completedCycles = (hypothesis.completedCycles ?? 0) + 1;
  await writeHypothesis(cwd, hypothesis);
  return hypothesis;
}

export async function retireAndReseed(cwd: string, id: string, bestScore?: number): Promise<Hypothesis> {
  const hypothesis = await archiveHypothesis(cwd, id, bestScore);
  return createHypothesis(cwd, nextFamily(hypothesis.forecastingFamily), hypothesis.generation + 1, hypothesis.id);
}

// Breeding: replace a retired lineage with a recombination of the two
// strongest surviving lineages. The child card carries both parents' claims
// (agents cannot see other hypothesis directories), the child strategy starts
// from the stronger parent's code, and the child inherits both parents'
// local falsifications — constraints on the components constrain the hybrid.
export interface BreedingParent {
  id: string;
  score: number;
}

export async function retireAndBreed(
  cwd: string,
  retiredId: string,
  parentA: BreedingParent,
  parentB: BreedingParent,
  bestScore?: number
): Promise<Hypothesis> {
  const retired = await archiveHypothesis(cwd, retiredId, bestScore);
  const [stronger, weaker] = parentA.score >= parentB.score
    ? [parentA, parentB]
    : [parentB, parentA];
  const strongerHypothesis = await readHypothesis(cwd, stronger.id);
  const weakerHypothesis = await readHypothesis(cwd, weaker.id);
  if (!strongerHypothesis || !weakerHypothesis) {
    throw new Error(`unknown breeding parent: ${stronger.id} / ${weaker.id}`);
  }

  const id = await nextHypothesisId(cwd);
  const child: Hypothesis = {
    id,
    status: "active",
    forecastingFamily: `hybrid:${strongerHypothesis.forecastingFamily}+${weakerHypothesis.forecastingFamily}`,
    attemptCount: 0,
    consecutiveNonImprovingAttempts: 0,
    generation: Math.max(strongerHypothesis.generation, weakerHypothesis.generation, retired.generation) + 1,
    parents: [stronger.id, weaker.id]
  };
  const target = hypothesisDir(cwd, id);
  await mkdir(target, { recursive: true });
  await cp(path.join(hypothesisDir(cwd, stronger.id), "strategy.ts"), path.join(target, "strategy.ts"));
  await cp(path.join(hypothesisDir(cwd, stronger.id), "strategy.md"), path.join(target, "strategy.md"));
  await writeFile(
    path.join(target, "hypothesis.md"),
    await bredHypothesisCard(cwd, stronger, strongerHypothesis, weaker, weakerHypothesis)
  );
  await writeFile(
    path.join(target, "falsifications.md"),
    await mergedFalsifications(cwd, stronger.id, weaker.id)
  );
  await writeHypothesis(cwd, child);
  return child;
}

async function archiveHypothesis(cwd: string, id: string, bestScore?: number): Promise<Hypothesis> {
  const hypothesis = await readHypothesis(cwd, id);
  if (!hypothesis) throw new Error(`unknown hypothesis: ${id}`);
  hypothesis.status = "archived";
  await writeHypothesis(cwd, hypothesis);
  await appendArchiveToGlobalLedger(cwd, hypothesis, bestScore);
  return hypothesis;
}

const GLOBAL_LEDGER_PATH = "research/trade-long/falsifications-global.md";

// Every retirement is itself a negative result: the family, the attempts it
// consumed, and whatever local falsifications it accumulated become shared
// knowledge instead of being rediscovered by the next lineage.
async function appendArchiveToGlobalLedger(
  cwd: string,
  hypothesis: Hypothesis,
  bestScore?: number
): Promise<void> {
  const target = path.join(cwd, GLOBAL_LEDGER_PATH);
  let existing: string;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = "# Global Falsifications (all hypotheses)\n\n## Archived lineages\n";
  }

  let localNotes = "";
  try {
    const local = await readFile(path.join(hypothesisDir(cwd, hypothesis.id), "falsifications.md"), "utf8");
    const body = local
      .split("\n")
      .filter((line) => !line.startsWith("# ") &&
        !line.includes("Record local, evidence-backed negative constraints only.") &&
        !line.includes("No durable local falsifications have been compacted"))
      .join("\n")
      .trim();
    if (body) localNotes = `\n  Local falsifications carried over:\n${body.split("\n").map((line) => `  ${line}`).join("\n")}\n`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const entry =
    `\n- **${new Date().toISOString().slice(0, 10)} — ${hypothesis.id} retired** ` +
    `(family: ${hypothesis.forecastingFamily}, generation ${hypothesis.generation}, ` +
    `${hypothesis.attemptCount} attempts, best score ${bestScore !== undefined ? bestScore.toFixed(2) : "n/a"}). ` +
    `Stagnated without clearing the gates.${localNotes}`;
  await writeFile(target, `${existing.trimEnd()}\n${entry}\n`);
}

async function bredHypothesisCard(
  cwd: string,
  stronger: BreedingParent,
  strongerHypothesis: Hypothesis,
  weaker: BreedingParent,
  weakerHypothesis: Hypothesis
): Promise<string> {
  const claimOf = async (id: string): Promise<string> => {
    try {
      const card = await readFile(path.join(hypothesisDir(cwd, id), "hypothesis.md"), "utf8");
      return /(?:^|\n)## Claim\n\n([\s\S]*?)(?:\n\n## |$)/.exec(card)?.[1]?.trim() ??
        "No claim recorded.";
    } catch {
      return "No claim recorded.";
    }
  };
  const strongerClaim = await claimOf(stronger.id);
  const weakerClaim = await claimOf(weaker.id);

  return `# Hypothesis Card

## Claim

Recombine two independently developed approaches. Parent A
(${strongerHypothesis.forecastingFamily}, walk-forward score ${stronger.score.toFixed(2)}) provides the
BASE strategy — its full code is your starting point in strategy.ts. Parent B
(${weakerHypothesis.forecastingFamily}, walk-forward score ${weaker.score.toFixed(2)}) provides a COMPONENT
to graft on: take its strongest distinct element (entry trigger, regime
filter, exit rule, or conditioning variable) and integrate it into the base.
Do NOT average the two strategies or rewrite from scratch — identify the one
component of Parent B most likely to add timing information the base lacks,
and combine at the logic level.

Parent A claim: ${strongerClaim}

Parent B claim: ${weakerClaim}

## Signal Family

hybrid: ${strongerHypothesis.forecastingFamily} + ${weakerHypothesis.forecastingFamily}

## Allowed Features

- Single-symbol OHLCV history supplied to proposeTrade.
- Optional market context (index, volatility, lagged US) second argument.
- Deterministic price, volume, trend, volatility, and range features.

## Forbidden Shortcuts

- Symbol-specific constants or price-level assumptions.
- Future candles, portfolio state, prior trade outcomes, wall-clock time, or randomness.
- Evaluator internals, private data, other hypotheses, prior score logs, or global research notes.

## Tunable Parameters

- The integration point and thresholds where the grafted component gates or
  modifies the base strategy.
- Stop, target, and hold-period parameters that preserve valid reward/risk geometry.

## Local Constraints

Both parents' local falsifications apply to this hybrid; see falsifications.md.

## Exhaustion Criteria

Treat this hypothesis as exhausted when the graft has been tried at the
plausible integration points and none clears the gates the base alone could
not — that is evidence the components carry no complementary information.
`;
}

async function mergedFalsifications(cwd: string, idA: string, idB: string): Promise<string> {
  const bodyOf = async (id: string): Promise<string> => {
    try {
      const raw = await readFile(path.join(hypothesisDir(cwd, id), "falsifications.md"), "utf8");
      return raw
        .split("\n")
        .filter((line) => !line.startsWith("# ") &&
          !line.includes("Record local, evidence-backed negative constraints only.") &&
          !line.includes("No durable local falsifications have been compacted"))
        .join("\n")
        .trim();
    } catch {
      return "";
    }
  };
  const bodyA = await bodyOf(idA);
  const bodyB = await bodyOf(idB);
  const sections = [
    bodyA ? `## Inherited from ${idA}\n\n${bodyA}` : "",
    bodyB ? `## Inherited from ${idB}\n\n${bodyB}` : ""
  ].filter(Boolean);
  return `# Local Falsifications\n\nRecord local, evidence-backed negative constraints only.\n\n${
    sections.length > 0
      ? `${sections.join("\n\n")}\n`
      : "No durable local falsifications have been compacted for this hypothesis yet.\n"
  }`;
}

export async function loadScheduler(cwd: string, activeIds: string[], slotCount: number): Promise<SchedulerState> {
  const statePath = path.join(cwd, ".autoresearch/scheduler.json");
  let state: SchedulerState | null = null;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const active = new Set(activeIds);
  const assignments = (state?.assignments ?? []).filter((id) => active.has(id));
  for (const id of activeIds) {
    if (assignments.length >= slotCount) break;
    if (!assignments.includes(id)) assignments.push(id);
  }
  const suspended = (state?.suspended ?? []).filter((id) => assignments.includes(id));
  const normalized = {
    assignments,
    nextAssignment: (state?.nextAssignment ?? 0) % Math.max(assignments.length, 1),
    suspended
  };
  await saveScheduler(cwd, normalized);
  return normalized;
}

export function selectMaturationBlock(state: SchedulerState): string {
  if (state.assignments.length === 0) throw new Error("scheduler has no active hypothesis assignments");
  for (let offset = 0; offset < state.assignments.length; offset += 1) {
    const id = state.assignments[(state.nextAssignment + offset) % state.assignments.length];
    if (!state.suspended.includes(id)) return id;
  }
  throw new Error("scheduler has no non-stagnant hypothesis assignments");
}

export async function advanceScheduler(cwd: string, state: SchedulerState): Promise<void> {
  const current = selectMaturationBlock(state);
  state.nextAssignment = (state.assignments.indexOf(current) + 1) % state.assignments.length;
  await saveScheduler(cwd, state);
}

export async function suspendAssignment(cwd: string, state: SchedulerState, id: string): Promise<void> {
  if (!state.suspended.includes(id)) state.suspended.push(id);
  await saveScheduler(cwd, state);
}

export function allAssignmentsSuspended(state: SchedulerState): boolean {
  return state.assignments.length > 0 &&
    state.assignments.every((id) => state.suspended.includes(id));
}

export async function replaceAssignment(
  cwd: string,
  state: SchedulerState,
  retiredId: string,
  replacementId: string
): Promise<void> {
  const retiredIndex = state.assignments.indexOf(retiredId);
  state.assignments = state.assignments.map((id) => id === retiredId ? replacementId : id);
  state.suspended = state.suspended.filter((id) => id !== retiredId);
  if (retiredIndex >= 0) state.nextAssignment = retiredIndex;
  await saveScheduler(cwd, state);
}

export async function promoteChampion(cwd: string, id: string): Promise<string[]> {
  await restoreHypothesis(cwd, id);
  const hypotheses = await listHypotheses(cwd);
  const changedIds: string[] = [];
  for (const hypothesis of hypotheses) {
    if (hypothesis.status === "champion") {
      hypothesis.status = "active";
      await writeHypothesis(cwd, hypothesis);
      changedIds.push(hypothesis.id);
    }
  }
  const promoted = await readHypothesis(cwd, id);
  if (!promoted) throw new Error(`unknown hypothesis: ${id}`);
  promoted.status = "champion";
  await writeHypothesis(cwd, promoted);
  if (!changedIds.includes(id)) changedIds.push(id);
  return changedIds;
}

async function saveScheduler(cwd: string, state: SchedulerState): Promise<void> {
  const target = path.join(cwd, ".autoresearch/scheduler.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`);
}

async function nextHypothesisId(cwd: string): Promise<string> {
  const existing = await listHypotheses(cwd);
  const next = existing.reduce((max, hypothesis) => {
    const match = /^hypothesis-(\d+)$/.exec(hypothesis.id);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `hypothesis-${String(next).padStart(4, "0")}`;
}

function nextFamily(previous: string): string {
  const index = DEFAULT_FAMILIES.indexOf(previous);
  // Hybrid/unknown families rotate back into the standard cycle.
  return DEFAULT_FAMILIES[index >= 0 ? (index + 1) % DEFAULT_FAMILIES.length : 0];
}

async function ensureHypothesisFalsifications(cwd: string, id: string): Promise<void> {
  const hypothesis = await readHypothesis(cwd, id);
  if (!hypothesis) throw new Error(`unknown hypothesis: ${id}`);

  const target = path.join(hypothesisDir(cwd, id), "falsifications.md");
  try {
    await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(target, defaultFalsifications());
  }

  const cardPath = path.join(hypothesisDir(cwd, id), "hypothesis.md");
  const card = await readFile(cardPath, "utf8");
  if (isIncompleteHypothesisCard(card)) {
    const directionContent = FAMILY_DESCRIPTIONS[hypothesis.forecastingFamily] ??
      defaultHypothesisDirection(hypothesis.forecastingFamily);
    await writeFile(cardPath, hypothesisFromDirection(directionContent));
  }
}

function defaultHypothesisDirection(family: string): string {
  return `# Hypothesis Direction\n\n## Family\n${family}\n\n## Approach\nExplore the ${family} approach to trade entry. Design a deterministic strategy\ninspired by ${family} concepts.\n\n## Rationale\nOriginal family assignment.\n\n## Key Constraints\nNone yet — new hypothesis.\n\n## Parents\nNone — original family assignment.\n`;
}

function hypothesisFromDirection(direction: string): string {
  const family = /(?:^|\n)## Family\n([\s\S]*?)(?:\n\n|$)/.exec(direction)?.[1]?.trim() ?? "unspecified";
  const approach = /(?:^|\n)## Approach\n([\s\S]*?)(?:\n\n## |$)/.exec(direction)?.[1]?.trim() ??
    "Explore the assigned market hypothesis with deterministic OHLCV features.";
  const constraints = /(?:^|\n)## Key Constraints\n([\s\S]*?)(?:\n\n## |$)/.exec(direction)?.[1]?.trim() ??
    "No additional local constraints.";
  return `# Hypothesis Card\n\n## Claim\n\n${approach}\n\n## Signal Family\n\n${family}\n\n## Allowed Features\n\n- Single-symbol OHLCV history supplied to proposeTrade.\n- Optional broad-market context (index, volatility) via the second MarketContext argument. Using it is OPTIONAL and never required; it may help as a regime/exposure filter (e.g. stand aside or size down when the broad market is weak or volatility is elevated). The strategy MUST remain valid and deterministic when this context is absent or a series is missing.\n- Deterministic price, volume, trend, volatility, and range features.\n\n## Forbidden Shortcuts\n\n- Symbol-specific constants or price-level assumptions.\n- Future candles, portfolio state, prior trade outcomes, wall-clock time, or randomness.\n- Evaluator internals, private data, other hypotheses, prior score logs, or global research notes.\n\n## Tunable Parameters\n\n- Entry threshold values inside the assigned signal family.\n- Stop, target, and hold-period parameters that preserve valid reward/risk geometry.\n\n## Local Constraints\n\n${constraints}\n\n## Exhaustion Criteria\n\nTreat this hypothesis as exhausted when repeated evaluated attempts show insufficient frequency, unstable slices, invalid execution geometry, or repeated violation of local falsifications.\n`;
}

function isIncompleteHypothesisCard(card: string): boolean {
  const claim = /(?:^|\n)## Claim\n\n([\s\S]*?)(?:\n\n## |$)/.exec(card)?.[1]?.trim() ?? "";
  return claim.length < 80;
}

function defaultFalsifications(): string {
  return `# Local Falsifications\n\nRecord local, evidence-backed negative constraints only.\n\nNo durable local falsifications have been compacted for this hypothesis yet.\n`;
}
