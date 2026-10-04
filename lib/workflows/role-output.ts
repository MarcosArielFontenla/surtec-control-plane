import outputSchema from "../../schemas/workflow-role-output.schema.json";
import recordSchema from "../../schemas/workflow-record.schema.json";
import type { IssueDocument, WorkIssue } from "../issues/types";
import type { AgentResult, TaskEnvelope } from "../state/types";
import { redactContextText, contextHash } from "../context/assemble";
import { assertWorkflowRoleOutput, WorkflowContractError } from "./validation";
import type { WorkflowCandidateBinding, WorkflowRoleOutput, WorkflowStageKind } from "./types";

const outputKinds = { planning: "plan", analysis: "analysis", operations: "operations", review: "review", qa: "qa" } as const;

// App Server receives one concrete object contract per role, not the persisted
// discriminated union or unresolved references into another schema document.
export function workflowRoleOutputSchema(kind: WorkflowStageKind): Record<string, unknown> {
  if (kind === "implementation" || kind === "correction") throw new WorkflowContractError("Engineer stages retain the generic agent-report contract");
  const branch = outputSchema.oneOf.find((schema) => schema.properties.kind.const === outputKinds[kind]);
  if (!branch) throw new WorkflowContractError("Unsupported workflow role output kind");
  function inline(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(inline);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string") {
      const prefix = `${recordSchema.$id}#/$defs/`;
      if (!node.$ref.startsWith(prefix)) throw new WorkflowContractError("Unsupported workflow output schema reference");
      const definition = recordSchema.$defs[node.$ref.slice(prefix.length) as keyof typeof recordSchema.$defs];
      if (!definition) throw new WorkflowContractError("Missing workflow output schema definition");
      return inline(definition);
    }
    // Use the same closed object/array/enum vocabulary as agent-report. Storage
    // bounds and semantic predicates stay mandatory in the local validator;
    // they are not delegated to a model/provider's JSON Schema subset.
    const allowed = new Set(["type", "enum", "properties", "required", "additionalProperties", "items", "anyOf"]);
    const projected: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      if (key === "const") projected.enum = [entry];
      else if (key === "properties") projected.properties = Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([name, property]) => [name, inline(property)]));
      else if (allowed.has(key)) projected[key] = inline(entry);
    }
    return projected;
  }
  return inline(branch) as Record<string, unknown>;
}

function assertPlainData(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new WorkflowContractError("Workflow output nesting exceeds bounds");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) throw new WorkflowContractError("Workflow output must be plain JSON data");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new WorkflowContractError("Workflow output must have own plain fields");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) throw new WorkflowContractError("Workflow output has unsupported fields");
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new WorkflowContractError("Workflow output has unsupported field descriptors");
    assertPlainData(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

export interface RoleOutputEvidence {
  kind: Exclude<WorkflowStageKind, "implementation" | "correction">;
  issue: WorkIssue;
  evidence: IssueDocument["evidence"];
  candidate: WorkflowCandidateBinding | null;
}

export function validateRoleOutput(value: unknown, facts: RoleOutputEvidence): WorkflowRoleOutput {
  assertPlainData(value);
  assertWorkflowRoleOutput(value);
  if (value.kind !== outputKinds[facts.kind]) throw new WorkflowContractError("Workflow output belongs to a different stage role");
  const references = [...value.evidence_ids];
  if (value.kind === "review" || value.kind === "qa") references.push(...value.findings.flatMap((finding) => finding.evidence_ids));
  if (value.kind === "qa") {
    references.push(...value.criteria.flatMap((criterion) => criterion.evidence_ids));
    const expected = [...facts.issue.acceptance_criteria].sort(), actual = value.criteria.map((criterion) => criterion.criterion).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new WorkflowContractError("QA must evaluate every exact current acceptance criterion");
  }
  for (const id of new Set(references)) {
    const evidence = facts.evidence[id];
    if (!evidence || evidence.id !== id || evidence.issue_id !== facts.issue.id || !facts.issue.evidence_ids.includes(id)
      || evidence.task_id !== null && !facts.issue.task_ids.includes(evidence.task_id)
      || evidence.scope_revision !== null && evidence.scope_revision !== facts.issue.scope_revision) throw new WorkflowContractError("Workflow output references unavailable or unrelated evidence");
    if (evidence.candidate_id !== null && (!facts.candidate || evidence.candidate_id !== facts.candidate.candidate_id
      || evidence.candidate_revision !== facts.candidate.candidate_revision || evidence.diff_fingerprint !== facts.candidate.diff_fingerprint)) throw new WorkflowContractError("Workflow output references stale candidate evidence");
  }
  // Redacted prose may still be shown, but cannot silently become an approved
  // plan or a positive review of evidence the human cannot actually inspect.
  const encoded = JSON.stringify(value), redacted = redactContextText(encoded);
  if (encoded !== redacted) throw new WorkflowContractError("Workflow role output contains sensitive text; return a safe bounded summary");
  return structuredClone(value);
}

export function roleOutputResult(envelope: TaskEnvelope, value: unknown, facts: RoleOutputEvidence, logsPath: string): { result: AgentResult; output: WorkflowRoleOutput | null; fingerprint: string | null } {
  try {
    const output = validateRoleOutput(value, facts);
    return { output, fingerprint: contextHash(JSON.stringify(output)), result: {
      task_id: envelope.id, agent: envelope.agent, status: output.status, summary: output.summary,
      files_changed: [], commands_run: [], tests_run: [], risks: output.risks,
      blockers: output.status === "completed" ? [] : ["Workflow role reported an incomplete result."],
      next_steps: [output.recommended_next_action], artifacts: [], logs_path: logsPath, verification: null,
    } };
  } catch {
    // Never copy malformed output, parser details or fallback finalText into a
    // task result, log or the generated-evidence context layer.
    return { output: null, fingerprint: null, result: {
      task_id: envelope.id, agent: envelope.agent, status: "needs-review", summary: "Workflow role returned no valid bounded output.",
      files_changed: [], commands_run: [], tests_run: [], risks: [], blockers: ["Invalid, contradictory or unowned workflow role evidence."],
      next_steps: ["Resolve the workflow decision; output is evidence, not authority."], artifacts: [], logs_path: logsPath, verification: null,
    } };
  }
}
