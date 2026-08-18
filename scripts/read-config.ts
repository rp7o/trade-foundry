#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [path, fallback] = process.argv.slice(2);
const config = JSON.parse(readFileSync("autoresearch.config.json", "utf8")) as Record<string, unknown>;
const value = path.split(".").reduce<unknown>((current, key) => (
  current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined
), config);
console.log(value == null ? (fallback ?? "") : String(value));

