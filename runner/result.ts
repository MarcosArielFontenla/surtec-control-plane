import type { AgentResult, TaskEnvelope, VerificationReport } from "../lib/state/types";
import Ajv2020 from "ajv/dist/2020.js";
import agentResultSchema from "../schemas/agent-result.schema.json";
import { validateAgentReport } from "./agent-report";

const validateResult = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(agentResultSchema);

export function assertAgentResult(value: unknown): AgentResult {
  if (!validateResult(value)) {
    const detail = validateResult.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") || "unknown validation error";
    throw new Error(`AgentResult schema validation failed: ${detail}`);
  }
  return value as unknown as AgentResult;
}

export function toAgentResult(
  envelope: TaskEnvelope,
  structuredOutput: unknown,
  rawText: string,
  logsPath: string,
  filesChanged: string[] = [],
  verification: VerificationReport | null = null,
): AgentResult {
  const validated = validateAgentReport(structuredOutput);
  if (!validated.ok) {
    return assertAgentResult({
      task_id: envelope.id,
      agent: envelope.agent,
      status: "needs-review",
      summary: rawText.trim() || "Agent returned no usable structured report.",
      files_changed: filesChanged,
      commands_run: [],
      tests_run: [],
      risks: [`Invalid agent report: ${validated.reason}`],
      blockers: [],
      next_steps: ["Review the raw run log and retry the task."],
      artifacts: [],
      logs_path: logsPath,
      verification,
    });
  }
  const report = validated.report;
  return assertAgentResult({
    task_id: envelope.id,
    agent: envelope.agent,
    status: report.status,
    summary: report.summary,
    files_changed: filesChanged,
    commands_run: report.commands_run,
    tests_run: report.tests_run,
    risks: report.risks,
    blockers: report.blockers,
    next_steps: report.next_steps,
    artifacts: report.artifacts,
    logs_path: logsPath,
    verification,
  });
}

export function failureResult(envelope: TaskEnvelope, reason: string, logsPath: string): AgentResult {
  return assertAgentResult({
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
    verification: null,
  });
}
