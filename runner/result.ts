import type { AgentResult, AgentOutcome, TaskEnvelope } from "../lib/state/types";

const OUTCOMES: AgentOutcome[] = ["completed", "partial", "blocked", "failed", "needs-review"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Parses the LAST ```json fenced block. The content is untrusted LLM output, so we
// only accept a plain JSON object — bare arrays/scalars/garbage fall back to null.
function parseTrailingJson(text: string): Record<string, unknown> | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  try {
    const value: unknown = JSON.parse(matches[matches.length - 1][1]);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function toAgentResult(
  envelope: TaskEnvelope,
  text: string,
  logsPath: string,
  filesChanged: string[] = [],
): AgentResult {
  const parsed = parseTrailingJson(text);
  const rawStatus = parsed?.status;
  const status: AgentOutcome = OUTCOMES.includes(rawStatus as AgentOutcome)
    ? (rawStatus as AgentOutcome)
    : "completed";
  return {
    task_id: envelope.id,
    agent: envelope.agent,
    status,
    summary: typeof parsed?.summary === "string" ? parsed.summary : text.trim(),
    files_changed: filesChanged,
    commands_run: [],
    tests_run: [],
    risks: asStringArray(parsed?.risks),
    blockers: asStringArray(parsed?.blockers),
    next_steps: asStringArray(parsed?.next_steps),
    artifacts: [],
    logs_path: logsPath,
  };
}

export function failureResult(envelope: TaskEnvelope, reason: string, logsPath: string): AgentResult {
  return {
    task_id: envelope.id,
    agent: envelope.agent,
    status: "failed",
    summary: `Run failed: ${reason}`,
    files_changed: [],
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [reason],
    next_steps: [],
    artifacts: [],
    logs_path: logsPath,
  };
}
