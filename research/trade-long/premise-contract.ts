import { readFileSync } from "node:fs";

const hypothesis = readFileSync("research/trade-long/hypothesis.md", "utf8");
const signalFamily = /^## Signal Family\n\n([\s\S]*?)(?:\n\n|$)/m.exec(hypothesis)?.[1]?.trim();

console.log(`premise contract skipped for signal family: ${signalFamily ?? "unspecified"}`);
