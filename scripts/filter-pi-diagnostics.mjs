import readline from "node:readline";

const startedAt = Date.now();
const toolStartedAt = new Map();

for await (const line of readline.createInterface({ input: process.stdin })) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }

  const elapsedMs = Date.now() - startedAt;
  if (event.type === "agent_start" || event.type === "turn_start") {
    write({ elapsedMs, event: event.type });
    continue;
  }

  if (event.type === "tool_execution_start") {
    toolStartedAt.set(event.toolCallId, Date.now());
    write({
      elapsedMs,
      event: "tool_start",
      tool: event.toolName,
      target: compactTarget(event.args),
    });
    continue;
  }

  if (event.type === "tool_execution_end") {
    const toolStart = toolStartedAt.get(event.toolCallId);
    toolStartedAt.delete(event.toolCallId);
    write({
      elapsedMs,
      event: "tool_end",
      tool: event.toolName,
      status: event.isError ? "error" : "ok",
      durationMs: toolStart === undefined ? undefined : Date.now() - toolStart,
      error: event.isError ? compactText(event.result) : undefined,
    });
    continue;
  }

  if (event.type === "turn_end" || event.type === "agent_end") {
    const usage = event.message?.usage ?? event.usage;
    write({
      elapsedMs,
      event: event.type,
      status: event.message?.stopReason ?? event.stopReason,
      tokens: usage?.totalTokens,
      inputTokens: usage?.input,
      outputTokens: usage?.output,
    });
  }
}

function compactTarget(args) {
  if (!args || typeof args !== "object") return undefined;
  const value =
    args.path ??
    args.file_path ??
    args.command ??
    args.pattern ??
    args.query;
  return compactText(value);
}

function compactText(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

function write(record) {
  const compact = Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
  process.stdout.write(`${JSON.stringify(compact)}\n`);
}
