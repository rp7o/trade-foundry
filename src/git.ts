import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isScratchPath } from "./guards.js";

const execFileAsync = promisify(execFile);

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function isIgnored(cwd: string, file: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", file], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function listChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim())
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file)
    .filter((file) => !isScratchPath(file));
}

export async function dirtyStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd });
  return stdout.trim() || "clean";
}

export async function revertFiles(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  await execFileAsync("git", ["checkout", "--", ...files], { cwd });
}

export async function listChangedFilesForPaths(cwd: string, files: string[]): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", ...files], { cwd });
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim())
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file);
}

export async function commitFiles(cwd: string, files: string[], message: string): Promise<void> {
  if (files.length === 0) {
    return;
  }

  await execFileAsync("git", ["add", "--", ...files], { cwd });
  await execFileAsync("git", ["commit", "-m", message], { cwd });
}
