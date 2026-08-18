import type { Config } from "./types.js";

// Harness scratch areas: never scored, never committed, never scope-checked.
// `.autoresearch/` holds run state; `sandbox/` is a free scratchpad the agent
// may write throwaway analysis scripts into without tripping the scope guard.
export const SCRATCH_PREFIXES = [".autoresearch/", "sandbox/"];

export function isScratchPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^.\//, "");
  return SCRATCH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function checkScope(config: Config, changedFiles: string[]): void {
  const files = changedFiles.filter((file) => !isScratchPath(file));

  const frozenViolations = files.filter((file) => matchesAny(file, config.scope.frozen));
  if (frozenViolations.length > 0) {
    throw new Error(`changed frozen files: ${frozenViolations.join(", ")}`);
  }

  if (config.scope.editable.length === 0) {
    return;
  }

  const allowed = [...config.scope.editable, ...config.scope.persistent];
  const editableViolations = files.filter((file) => !matchesAny(file, allowed));
  if (editableViolations.length > 0) {
    throw new Error(`changed files outside editable scope: ${editableViolations.join(", ")}`);
  }
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPath(file, pattern));
}

function matchesPath(file: string, pattern: string): boolean {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.endsWith("/")) {
    return normalizedFile.startsWith(normalizedPattern);
  }

  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^.\//, "");
}
