// Offline stdio producer only. Fixed scenarios never invoke Codex or a shell.
import { createInterface } from "node:readline";
const scenario = process.argv[2], role = process.argv[3] ?? "report";
if (!["success", "late-usage", "nonzero", "malformed-tail", "missing-phase", "usage-before-final"].includes(scenario)
  || !["report", "planner"].includes(role)) throw new Error("Unknown synthetic protocol scenario");
const usage = { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 };
const report = { status: "completed", summary: "Synthetic inspection", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
const plan = { schema_version: 1, kind: "plan", status: "completed", summary: "Bounded synthetic output", evidence_ids: [], unresolved_questions: [], risks: [],
  recommended_next_action: "Human inspection", requested_decision: null, plan: ["Only authorized paths"], scope_change_required: false };
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function sample(value = usage) { return { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: value, total: value, modelContextWindow: 1000 } } }; }
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "config/read") send({ id: message.id, result: { config: { skills: { include_instructions: false } } } });
  else if (message.method === "thread/start" || message.method === "thread/resume") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    if (scenario === "usage-before-final") send(sample());
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "agentMessage", text: JSON.stringify(role === "planner" ? plan : report), phase: scenario === "missing-phase" ? null : "final_answer" } } });
    if (scenario !== "usage-before-final") send(sample());
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, items: [] } } });
  } else if (Object.hasOwn(message, "id")) {
    send({ id: message.id, error: { code: -32601, message: "Unsupported synthetic protocol method" } });
  }
});
lines.on("close", () => {
  if (scenario === "late-usage") {
    const late = { ...usage, inputTokens: 20, totalTokens: 25 };
    // Deliberately omit newline: EOF must parse the last frame before settlement.
    process.stdout.write(JSON.stringify(sample(late)));
  }
  if (scenario === "malformed-tail") process.stdout.write("{");
  process.exitCode = scenario === "nonzero" ? 7 : 0;
  process.stdout.end(); process.stderr.end();
});
