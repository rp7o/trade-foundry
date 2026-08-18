import * as fs from "node:fs";
import * as path from "node:path";

// Helper function to empty a directory if it exists
function emptyDirIfExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) return;
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
    console.log(`Cleaned up directory: ${dirPath}`);
  } catch (error) {
    console.error(`Failed to clean up directory ${dirPath}:`, error);
  }
}

// Helper function to keep only latest 10 files of each extension type in a directory
function keepLatestFiles(dirPath: string, keepCount: number = 10) {
  if (!fs.existsSync(dirPath)) return;
  try {
    const entries = fs.readdirSync(dirPath);
    const filesByExt: Record<string, string[]> = {};

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        const ext = path.extname(entry).toLowerCase();
        if (!filesByExt[ext]) {
          filesByExt[ext] = [];
        }
        filesByExt[ext].push(fullPath);
      }
    }

    for (const [ext, files] of Object.entries(filesByExt)) {
      // Sort files by mtime descending (newest first). If mtimes are equal, fallback to filename comparison descending.
      files.sort((a, b) => {
        const statA = fs.statSync(a);
        const statB = fs.statSync(b);
        const timeDiff = statB.mtimeMs - statA.mtimeMs;
        if (timeDiff !== 0) return timeDiff;
        return b.localeCompare(a);
      });

      if (files.length > keepCount) {
        const toDelete = files.slice(keepCount);
        console.log(`Directory ${dirPath}: keeping ${keepCount} latest ${ext} files, deleting ${toDelete.length} older files.`);
        for (const fileToDelete of toDelete) {
          fs.rmSync(fileToDelete, { force: true });
        }
      } else {
        console.log(`Directory ${dirPath}: has ${files.length} ${ext} files (limit is ${keepCount}). None deleted.`);
      }
    }
  } catch (error) {
    console.error(`Error cleaning up files in ${dirPath}:`, error);
  }
}

function main() {
  console.log("Starting cleanup...");

  // 1. Empty snapshot workspaces from interrupted runs.
  emptyDirIfExists(".autoresearch/snapshots");

  // 2. Keep only latest 10 files of each extension in runs and agent directories.
  keepLatestFiles(".autoresearch/runs", 10);
  keepLatestFiles(".autoresearch/agent", 10);

  console.log("Cleanup completed.");
}

main();
