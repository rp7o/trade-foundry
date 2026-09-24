// Private workspaces own data and Git history; shared code is linked, never copied.
import { execFileSync, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectionFile = ".trade-foundry-workspace";
const marker = ".trade-foundry-engine.json";
const templates = [
  ["autoresearch.example.json", "autoresearch.config.json"],
  ["research/trade-long/strategy-boilerplate.ts", "research/trade-long/strategy.ts"],
  ["research/trade-long/strategy-boilerplate.md", "research/trade-long/strategy.md"],
  ["research/trade-long/hypothesis-boilerplate.md", "research/trade-long/hypothesis.md"],
  ["research/trade-long/falsifications-boilerplate.md", "research/trade-long/falsifications.md"],
  ["research/trade-long/falsifications-global-boilerplate.md", "research/trade-long/falsifications-global.md"],
  ["docs/timesfm-research.json", "timesfm-research.json"],
];

// A deny-by-default private index: runtime links and bulky output never enter Git.
const privateIgnore = `*
!/.gitignore
!/README.md
!/engine.json
!/autoresearch.config.json
!/timesfm-research.json
!/research/
/research/*
!/research/trade-long/
/research/trade-long/*
!/research/trade-long/strategy.ts
!/research/trade-long/strategy.md
!/research/trade-long/hypothesis.md
!/research/trade-long/falsifications.md
!/research/trade-long/falsifications-global.md
!/research/trade-long/parameter-search.json
!/research/trade-long/hypotheses/
!/research/trade-long/hypotheses/**/
!/research/trade-long/hypotheses/**/*.ts
!/research/trade-long/hypotheses/**/*.md
!/research/trade-long/hypotheses/**/*.json
`;

function present(file) {
  try { return lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function selectedWorkspace(root = engineRoot, env = process.env) {
  if (env.TRADE_FOUNDRY_WORKSPACE) return path.resolve(root, env.TRADE_FOUNDRY_WORKSPACE);
  const pointer = path.join(root, selectionFile);
  return existsSync(pointer) ? path.resolve(root, readFileSync(pointer, "utf8").trim()) : root;
}

function linkPlan(root) {
  const fixed = ["src", "scripts", "research/engine", "research/trade-long/hooks",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.strategy.json", "node_modules"];
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "research/trade-long", "docs"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = tracked.filter(file => file.startsWith("docs/") || path.posix.dirname(file) === "research/trade-long");
  return [...fixed, ...files];
}

export function syncWorkspace(workspace, root = engineRoot) {
  workspace = path.resolve(workspace);
  root = realpathSync(root);
  if (realpathSync(workspace) === root) return;
  const info = JSON.parse(readFileSync(path.join(workspace, marker), "utf8"));
  if (info.schemaVersion !== 1) throw new Error("Unsupported private workspace format");
  const files = linkPlan(root);
  // Validate the entire plan before mutating any links. Never overwrite user files.
  for (const file of files) {
    const target = path.join(workspace, file);
    const existing = present(target);
    if (existing && !existing.isSymbolicLink()) throw new Error(`Workspace code path is occupied: ${target}`);
    if (existing && !info.links.includes(file)) throw new Error(`Unmanaged workspace link: ${target}`);
  }
  for (const file of info.links) {
    const target = path.join(workspace, file);
    if (!files.includes(file) && present(target)?.isSymbolicLink()) unlinkSync(target);
  }
  for (const file of files) {
    const target = path.join(workspace, file);
    const source = path.join(root, file);
    if (present(target) && readlinkSync(target) === source) continue;
    if (present(target)) unlinkSync(target);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
  const next = `${JSON.stringify({ schemaVersion: 1, engine: root, links: files }, null, 2)}\n`;
  if (readFileSync(path.join(workspace, marker), "utf8") !== next) writeFileSync(path.join(workspace, marker), next);
}

export function initializeWorkspace(workspace, root = engineRoot) {
  workspace = path.resolve(workspace);
  if (workspace === root || workspace.startsWith(`${root}${path.sep}`)) {
    throw new Error("Private workspaces must be outside the public engine checkout");
  }
  if (existsSync(workspace)) throw new Error(`Choose a new directory; preserving existing ${workspace}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, marker), JSON.stringify({ schemaVersion: 1, links: [] }));
  writeFileSync(path.join(workspace, ".gitignore"), privateIgnore);
  writeFileSync(path.join(workspace, "README.md"), `# Private Trade Foundry research\n\nStrategies, configuration and hypothesis history live here. Shared engine files are ignored links to your Trade Foundry checkout.\n\nReattach after cloning with \`pnpm run workspace -- attach /path/to/this/repo\` from the engine checkout, then select it with \`pnpm run workspace -- use /path/to/this/repo\`. Install dependencies in the engine checkout.\n\nRun normal research commands from the engine checkout. Commit private work with Git in this directory; \`research:loop --commit-accepted\` also commits here. No remote is configured automatically. Back up ignored databases and runtime archives separately. Evaluation artifacts record engine revision and source/config fingerprints.\n`);
  for (const [source, target] of templates) {
    mkdirSync(path.dirname(path.join(workspace, target)), { recursive: true });
    copyFileSync(path.join(root, source), path.join(workspace, target), constants.COPYFILE_EXCL);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(path.join(workspace, "engine.json"), `${JSON.stringify({ repository: "https://github.com/rp7o/trade-foundry.git", commit }, null, 2)}\n`);
  syncWorkspace(workspace, root);
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "pipe" });
  return workspace;
}

export function runInWorkspace(command, args, root = engineRoot) {
  const workspace = selectedWorkspace(root);
  if (workspace !== root) syncWorkspace(workspace, root);
  const result = spawnSync(command, args, {
    cwd: workspace, stdio: "inherit",
    env: { ...process.env, TRADE_FOUNDRY_WORKSPACE: workspace, TRADE_FOUNDRY_ENGINE: root },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(args) {
  if (args[0] === "--") args.shift();
  const [command, directory] = args;
  if (command === "run") {
    if (!directory) throw new Error("workspace run requires a command");
    process.exitCode = runInWorkspace(directory, args.slice(2));
  } else if (command === "init") {
    if (!directory) throw new Error("Usage: pnpm run workspace -- init /path/to/new-private-repo");
    console.log(`Created ${initializeWorkspace(path.resolve(engineRoot, directory))}`);
  } else if (command === "attach" || command === "use") {
    if (!directory) throw new Error(`workspace ${command} requires a directory`);
    const workspace = realpathSync(path.resolve(engineRoot, directory));
    if (command === "attach") {
      // A freshly cloned private repo has no machine-local link manifest.
      if (!existsSync(path.join(workspace, "engine.json")) || !existsSync(path.join(workspace, "autoresearch.config.json"))) {
        throw new Error("Not a private research workspace");
      }
      if (!existsSync(path.join(workspace, marker))) writeFileSync(path.join(workspace, marker), JSON.stringify({ schemaVersion: 1, links: [] }));
    }
    syncWorkspace(workspace);
    if (command === "use") writeFileSync(path.join(engineRoot, selectionFile), `${workspace}\n`);
    console.log(`${command === "use" ? "Selected" : "Attached"} ${workspace}`);
  } else if (command === "local") {
    if (existsSync(path.join(engineRoot, selectionFile))) unlinkSync(path.join(engineRoot, selectionFile));
    console.log("Selected engine checkout's local research files");
  } else if (command === "status") {
    console.log(`Engine: ${engineRoot}\nWorkspace: ${selectedWorkspace()}`);
  } else throw new Error("Usage: pnpm run workspace -- init|attach|use <directory>, local, or status");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
