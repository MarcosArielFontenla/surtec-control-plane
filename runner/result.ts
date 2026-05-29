import type { AgentResult, AgentOutcome, TaskEnvelope } from "../lib/state/types";

const OUTCOMES: AgentOutcome[] = ["completed", "partial", "blocked", "failed", "needs-review"];

interface ParsedReport {
  summary?: string;
  risks?: string[];
  blockers?: string[];
  next_steps?: string[];
  status?: string;
}

function parseTrailingJson(text: string): ParsedReport | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]) as ParsedReport;
  } catch {
    return null;
  }
}

export function toAgentResult(envelope: TaskEnvelope, text: string, logsPath: string): AgentResult {
  const parsed = parseTrailingJson(text);
  const status: AgentOutcome =
    parsed && OUTCOMES.includes(parsed.status as AgentOutcome)
      ? (parsed.status as AgentOutcome)
      : "completed";
  return {
    task_id: envelope.id,
    agent: envelope.agent,
    status,
    summary: parsed?.summary ?? text.trim(),
    files_changed: [],
    commands_run: [],
    tests_run: [],
    risks: parsed?.risks ?? [],
    blockers: parsed?.blockers ?? [],
    next_steps: parsed?.next_steps ?? [],
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
