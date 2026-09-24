import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./ledger.js";

export interface Snapshot {
  id: string;
  rootDir: string;
  dir: string;
  paths: string[];
  links?: Record<string, string>;
}

export interface FileManifest {
  rootDir: string;
  hashes: Map<string, string>;
}

export async function createSnapshot(rootDir: string, paths: string[], id: string): Promise<Snapshot> {
  const snapshotDir = path.join(statePath(rootDir), "snapshots", safeId(id));
  await rm(snapshotDir, { recursive: true, force: true });
  await mkdir(snapshotDir, { recursive: true });

  const existingPaths: string[] = [];
  const links: Record<string, string> = {};
  for (const relativePath of uniqueNormalized(paths)) {
    const absolutePath = path.join(rootDir, relativePath);
    if (!await exists(absolutePath)) {
      continue;
    }
    const targetPath = path.join(snapshotDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    if ((await lstat(absolutePath)).isSymbolicLink()) links[relativePath] = await readlink(absolutePath);
    // Freeze contents, not live links to mutable engine files.
    await cp(absolutePath, targetPath, { recursive: true, force: true, dereference: true });
    existingPaths.push(relativePath);
  }

  return {
    id,
    rootDir,
    dir: snapshotDir,
    paths: existingPaths,
    links,
  };
}

export async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  for (const relativePath of snapshot.paths) {
    const sourcePath = path.join(snapshot.dir, relativePath);
    const targetPath = path.join(snapshot.rootDir, relativePath);
    const originalLink = snapshot.links?.[relativePath];
    if (originalLink) {
      const originalTarget = path.resolve(path.dirname(targetPath), originalLink);
      const before = await fileHashes(sourcePath, relativePath);
      const after = await fileHashes(originalTarget, relativePath);
      if (before.size !== after.size || [...before].some(([file, hash]) => after.get(file) !== hash)) {
        await rm(originalTarget, { recursive: true, force: true });
        await cp(sourcePath, originalTarget, { recursive: true, force: true });
      }
      // Keep the link topology even if an editor replaced a link with a file.
      const currentLink = await readlink(targetPath).catch(() => undefined);
      if (currentLink !== originalLink) {
        await rm(targetPath, { recursive: true, force: true });
        await symlink(originalLink, targetPath);
      }
      continue;
    }
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

export async function removeSnapshot(snapshot: Snapshot): Promise<void> {
  await rm(snapshot.dir, { recursive: true, force: true });
}

export async function changedSinceSnapshot(snapshot: Snapshot): Promise<string[]> {
  return changedSinceSnapshotInRoot(snapshot, snapshot.rootDir, snapshot.paths);
}

export async function createFileManifest(rootDir: string): Promise<FileManifest> {
  return {
    rootDir,
    hashes: await fileHashes(rootDir, "")
  };
}

export async function changedSinceManifest(manifest: FileManifest): Promise<string[]> {
  const after = await fileHashes(manifest.rootDir, "");
  const keys = new Set([...manifest.hashes.keys(), ...after.keys()]);
  const changed: string[] = [];

  for (const key of keys) {
    if (manifest.hashes.get(key) !== after.get(key)) {
      changed.push(key);
    }
  }

  return changed.sort();
}

export async function changedSinceSnapshotInRoot(
  snapshot: Snapshot,
  rootDir: string,
  paths: string[] = snapshot.paths
): Promise<string[]> {
  const changed: string[] = [];
  const requestedPaths = new Set(uniqueNormalized(paths));

  for (const relativePath of snapshot.paths.filter((item) => requestedPaths.has(item))) {
    const sourcePath = path.join(snapshot.dir, relativePath);
    const targetPath = path.join(rootDir, relativePath);
    const before = await fileHashes(sourcePath, relativePath);
    const after = await fileHashes(targetPath, relativePath);
    const keys = new Set([...before.keys(), ...after.keys()]);

    for (const key of keys) {
      if (before.get(key) !== after.get(key)) {
        changed.push(key);
      }
    }
  }

  return [...new Set(changed)].sort();
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function uniqueNormalized(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.replaceAll("\\", "/").replace(/^.\//, "")))];
}

function safeId(id: string): string {
  return id.replaceAll(":", "-");
}

async function fileHashes(absolutePath: string, relativePath: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (!await exists(absolutePath)) {
    return hashes;
  }

  const info = await stat(absolutePath);
  if (info.isFile()) {
    hashes.set(relativePath, await hashFile(absolutePath));
    return hashes;
  }

  if (!info.isDirectory()) {
    return hashes;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const childAbsolute = path.join(absolutePath, entry.name);
    const parentRelative = relativePath.replace(/\/$/, "");
    const childRelative = parentRelative ? `${parentRelative}/${entry.name}` : entry.name;
    if (shouldSkipManifestPath(childRelative)) {
      continue;
    }
    const childHashes = await fileHashes(childAbsolute, childRelative);
    for (const [key, value] of childHashes) {
      hashes.set(key, value);
    }
  }

  return hashes;
}

async function hashFile(absolutePath: string): Promise<string> {
  const data = await readFile(absolutePath);
  return createHash("sha256").update(data).digest("hex");
}

function shouldSkipManifestPath(relativePath: string): boolean {
  return relativePath === ".git" ||
    relativePath.startsWith(".git/") ||
    relativePath === ".autoresearch" ||
    relativePath.startsWith(".autoresearch/") ||
    relativePath === "node_modules" ||
    relativePath.startsWith("node_modules/") ||
    // sandbox/ is a free scratchpad: the agent may write throwaway analysis
    // scripts there without tripping the tree-manifest scope guard.
    relativePath === "sandbox" ||
    relativePath.startsWith("sandbox/");
}
