import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";
import process from "node:process";

const activeChildren = new Set<{ pid: number | undefined; detached: boolean }>();

export function cleanUpChildren(): void {
  for (const childRecord of activeChildren) {
    stopChild(childRecord.pid, childRecord.detached);
  }
  activeChildren.clear();
}


export function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  options: {
    detached?: boolean;
    env?: Record<string, string>;
    streamStderr?: boolean;
    streamStdout?: boolean;
  } = {}
): Promise<CommandResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      detached: options.detached ?? false,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env
    });

    const childRecord = { pid: child.pid, detached: options.detached ?? false };
    activeChildren.add(childRecord);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild(child.pid, options.detached ?? false);
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      const dataStr = chunk.toString();
      stdout += dataStr;
      if (options.streamStdout) {
        process.stdout.write(dataStr);
      }
    });
    child.stderr.on("data", (chunk) => {
      const dataStr = chunk.toString();
      stderr += dataStr;
      if (options.streamStderr) {
        process.stderr.write(dataStr);
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      activeChildren.delete(childRecord);
      resolve({
        command,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        exitCode: null,
        durationMs: Date.now() - started,
        timedOut
      });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      activeChildren.delete(childRecord);
      resolve({
        command,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - started,
        timedOut
      });
    });
  });
}

function stopChild(pid: number | undefined, detached: boolean): void {
  if (!pid) {
    return;
  }

  try {
    if (detached && process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    return;
  }

  setTimeout(() => {
    try {
      if (detached && process.platform !== "win32") {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Process already exited.
    }
  }, 5000).unref();
}
