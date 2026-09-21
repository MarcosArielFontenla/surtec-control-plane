import type { AgentOutcome } from "../lib/state/types";
import agentReportSchema from "../schemas/agent-report.schema.json";

const OUTCOMES = ["completed", "partial", "blocked", "failed", "needs-review"] as const;
const STRING_ARRAY_FIELDS = ["commands_run", "tests_run", "risks", "blockers", "next_steps", "artifacts"] as const;

export interface AgentReport {
  status: AgentOutcome;
  summary: string;
  commands_run: string[];
  tests_run: string[];
  risks: string[];
  blockers: string[];
  next_steps: string[];
  artifacts: string[];
}

export const AGENT_REPORT_SCHEMA = agentReportSchema;

export type AgentReportValidation =
  | { ok: true; report: AgentReport }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAgentReport(value: unknown): AgentReportValidation {
  if (!isRecord(value)) return { ok: false, reason: "structured output is not an object" };
  const allowed = new Set(["status", "summary", ...STRING_ARRAY_FIELDS]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return { ok: false, reason: `structured output has unexpected field: ${extra}` };
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    return { ok: false, reason: "structured output summary is missing or empty" };
  }
  if (typeof value.status !== "string" || !(OUTCOMES as readonly string[]).includes(value.status)) {
    return { ok: false, reason: "structured output status is invalid" };
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) {
      return { ok: false, reason: `structured output ${field} must be an array of strings` };
    }
  }
  return { ok: true, report: value as unknown as AgentReport };
}
