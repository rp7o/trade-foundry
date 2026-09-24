// Create working research files without overwriting strategies or local config.
import { constants, copyFileSync } from "node:fs";

const templates = [
  ["autoresearch.example.json", "autoresearch.config.json"],
  ["research/trade-long/strategy-boilerplate.ts", "research/trade-long/strategy.ts"],
  ["research/trade-long/strategy-boilerplate.md", "research/trade-long/strategy.md"],
  ["research/trade-long/hypothesis-boilerplate.md", "research/trade-long/hypothesis.md"],
  ["research/trade-long/falsifications-boilerplate.md", "research/trade-long/falsifications.md"],
  ["research/trade-long/falsifications-global-boilerplate.md", "research/trade-long/falsifications-global.md"],
];

for (const [source, target] of templates) {
  try {
    copyFileSync(new URL(`../${source}`, import.meta.url), new URL(`../${target}`, import.meta.url), constants.COPYFILE_EXCL);
    console.log(`created ${target}`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}
