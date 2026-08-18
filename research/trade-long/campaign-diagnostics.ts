import { readFile } from "node:fs/promises";
import path from "node:path";
import { readTrials } from "./cycles.js";

export interface FoldCandidate {
  id: string;
  scores: number[];
}

export interface PboDiagnostic {
  probability: number;
  splits: number;
  candidates: number;
  folds: number;
}

export function calculatePbo(candidates: FoldCandidate[]): PboDiagnostic | null {
  if (candidates.length < 2) return null;
  const folds = candidates[0].scores.length;
  if (folds < 4 || candidates.some((candidate) => candidate.scores.length !== folds)) return null;
  const trainSize = Math.floor(folds / 2);
  const splits = combinations(folds, trainSize);
  let overfit = 0;
  for (const train of splits) {
    const trainSet = new Set(train);
    const test = Array.from({ length: folds }, (_, index) => index).filter((index) => !trainSet.has(index));
    let selected = candidates[0];
    let selectedTrain = mean(selected.scores, train);
    for (const candidate of candidates.slice(1)) {
      const candidateTrain = mean(candidate.scores, train);
      if (candidateTrain > selectedTrain || (candidateTrain === selectedTrain && candidate.id < selected.id)) {
        selected = candidate;
        selectedTrain = candidateTrain;
      }
    }
    const selectedTest = mean(selected.scores, test);
    const percentile = candidates.filter((candidate) => mean(candidate.scores, test) <= selectedTest).length / candidates.length;
    if (percentile <= 0.5) overfit += 1;
  }
  return { probability: overfit / splits.length, splits: splits.length, candidates: candidates.length, folds };
}

export async function campaignPbo(cwd: string): Promise<PboDiagnostic | null> {
  const artifactFiles = [...new Set((await readTrials(cwd)).map((trial) => trial.artifactFile).filter((file): file is string => Boolean(file)))];
  const loaded: Array<{ id: string; folds: Map<string, number> }> = [];
  for (const artifactFile of artifactFiles) {
    try {
      const artifact = JSON.parse(await readFile(path.join(cwd, artifactFile), "utf8")) as {
        segments?: Array<{ name?: unknown; group?: unknown; value?: unknown }>;
      };
      const folds = new Map<string, number>();
      for (const segment of artifact.segments ?? []) {
        if (segment.group === "fold" && typeof segment.name === "string" && typeof segment.value === "number") {
          folds.set(segment.name, segment.value);
        }
      }
      if (folds.size > 0) loaded.push({ id: artifactFile, folds });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (loaded.length < 2) return null;
  const groups = new Map<string, typeof loaded>();
  for (const candidate of loaded) {
    const signature = [...candidate.folds.keys()].sort().join("\n");
    const group = groups.get(signature) ?? [];
    group.push(candidate);
    groups.set(signature, group);
  }
  const comparable = [...groups.values()].sort((a, b) =>
    b.length - a.length || b[0].folds.size - a[0].folds.size
  )[0];
  const common = [...comparable[0].folds.keys()].sort();
  return calculatePbo(comparable.map((candidate) => ({
    id: candidate.id,
    scores: common.map((name) => candidate.folds.get(name) as number)
  })));
}

function mean(values: number[], indices: number[]): number {
  return indices.reduce((sum, index) => sum + values[index], 0) / indices.length;
}

function combinations(size: number, choose: number): number[][] {
  const result: number[][] = [];
  const visit = (start: number, selected: number[]): void => {
    if (selected.length === choose) {
      result.push(selected);
      return;
    }
    for (let index = start; index <= size - (choose - selected.length); index += 1) {
      visit(index + 1, [...selected, index]);
    }
  };
  visit(0, []);
  return result;
}
