import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";

const cwd = process.cwd();
const config = await loadConfig(cwd);
const modulePath = path.resolve(cwd, config.hooks.workflow);
const workflow = await import(pathToFileURL(modulePath).href) as {
  run(args: string[], cwd: string): Promise<void>;
};

if (typeof workflow.run !== "function") {
  throw new Error(`workflow hook must export run(args, cwd): ${config.hooks.workflow}`);
}

await workflow.run(process.argv.slice(2), cwd);
