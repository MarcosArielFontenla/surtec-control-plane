import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import type { TaskRecord } from "../state/types";
import type { validateTerminalUsageEvidence } from "../../runner/terminal-usage-evidence";
import type { PlannerRecovery, WorkflowDocument, WorkflowRoleOutput, WorkflowStage } from "./types";

export const plannerRecoveryHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function plannerRecoveryFingerprint(receipt: Omit<PlannerRecovery, "fingerprint"> | PlannerRecovery): string {
  const { fingerprint: _ignored, ...body } = receipt as PlannerRecovery;
  return plannerRecoveryHash(body);
}
export const plannerRecoveryDecisionFingerprint = (receipt: PlannerRecovery): string => plannerRecoveryHash({ output_fingerprint: receipt.output_fingerprint, recovery_fingerprint: receipt.fingerprint });

function requireRecovery(ok: unknown): asserts ok { if (!ok) throw new Error("Retained Planner recovery facts are missing, stale or ineligible"); }
export function assertPlannerRecoveryPlainData(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  requireRecovery(value && typeof value === "object" && !utilTypes.isProxy(value) && !seen.has(value) && depth < 32);
  requireRecovery(Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype) || Object.getPrototypeOf(value) === null);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    requireRecovery(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireRecovery("value" in descriptor);
    assertPlannerRecoveryPlainData(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}
export function assertPlannerDispositions(output: WorkflowRoleOutput, receipt: Pick<PlannerRecovery, "questions" | "risks">): void {
  requireRecovery(receipt.questions.length === output.unresolved_questions.length && receipt.risks.length === output.risks.length);
  for (const [index, text] of output.unresolved_questions.entries()) {
    const q = receipt.questions[index];
    requireRecovery(q && q.index === index && q.fingerprint === plannerRecoveryHash(text)
      && ["plan-approval-gate", "operator-clarification"].includes(q.kind) && typeof q.answer === "string" && q.answer.trim().length > 0 && q.answer.length <= 500);
  }
  for (const [index, text] of output.risks.entries()) requireRecovery(receipt.risks[index]?.index === index && receipt.risks[index]?.fingerprint === plannerRecoveryHash(text));
}

/** Structural provenance only. A stored receipt cannot replace live task/policy checks. */
export function offeredPlannerRecovery(document: WorkflowDocument, stage: WorkflowStage): PlannerRecovery | null {
  const owner = document.workflows[stage.workflow_id], r = owner?.planner_recovery;
  if (!r || r.stage_id !== stage.id) return null;
  const grant = document.grants[stage.grant_id], charge = stage.execution_id ? document.accounting[stage.execution_id] : null;
  requireRecovery(owner.template_id === "implementation" && stage.kind === "planning" && stage.role_id === "planner" && stage.ordinal === 1
    && stage.sandbox === "read-only" && stage.status === "needs-review" && stage.output?.kind === "plan" && stage.output.status === "needs-review" && !stage.output.scope_change_required
    && stage.output_fingerprint === plannerRecoveryHash(stage.output) && r.schema_version === 1 && r.requested_by === "human"
    && r.workflow_id === owner.id && r.project_id === owner.project_id && r.issue_id === owner.issue_id && r.scope_revision === owner.scope_revision
    && r.stage_id === stage.id && r.generation === stage.generation && r.task_id === stage.task_id && r.execution_id === stage.execution_id
    && r.context_fingerprint === stage.context_fingerprint && r.output_fingerprint === stage.output_fingerprint
    && r.grant_id === stage.grant_id && r.authority_revision === stage.authority_revision && owner.current_grant_id === r.grant_id && owner.authority_revision === r.authority_revision
    && grant && r.grant_fingerprint === plannerRecoveryHash(grant) && charge?.usage_complete && r.accounting_fingerprint === plannerRecoveryHash(charge)
    && r.fingerprint === plannerRecoveryFingerprint(r) && r.original_counters.accounting_complete
    && Object.entries(r.original_counters).every(([key, value]) => key === "accounting_complete" || owner.counters[key as "tasks" | "attempts" | "runtime_ms" | "total_tokens"] >= Number(value)));
  assertPlannerDispositions(stage.output!, r);
  const decision = document.decisions[r.decision_id];
  requireRecovery(decision?.workflow_id === owner.id && decision.kind === "plan-approval" && decision.resource_fingerprint === plannerRecoveryDecisionFingerprint(r));
  return r;
}
export function approvedPlannerRecovery(document: WorkflowDocument, stage: WorkflowStage): PlannerRecovery | null {
  const r = offeredPlannerRecovery(document, stage);
  if (!r) return null;
  const owner = document.workflows[stage.workflow_id]!, decision = document.decisions[r.decision_id];
  return decision?.status === "approved" && decision.decided_by === "human" && decision.approval_id && decision.rationale
    && owner.approved_plan?.stage_id === stage.id && owner.approved_plan.output_fingerprint === r.output_fingerprint && owner.approved_plan.decision_id === r.decision_id ? r : null;
}

/** Checks an existing incomplete plan's exact terminal facts. Never changes a task. */
export function assertRetainedPlannerTask(document: WorkflowDocument, stage: WorkflowStage, task: TaskRecord | null, verify: typeof validateTerminalUsageEvidence): asserts task is TaskRecord {
  const owner = document.workflows[stage.workflow_id], grant = owner && document.grants[owner.current_grant_id];
  const admission = task?.envelope.context_admission, run = task?.envelope.metadata.run as Record<string, unknown> | undefined;
  const charge = stage.execution_id ? document.accounting[stage.execution_id] : null;
  const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === stage.id);
  requireRecovery(owner && grant && owner.template_id === "implementation" && owner.counters.accounting_complete && !owner.stop_requested_at
    && stage.kind === "planning" && stage.role_id === "planner" && stage.ordinal === 1 && stage.sandbox === "read-only" && stage.generation === 1 && !stage.supersedes_stage_id && !stage.predecessor_stage_id
    && ["running", "needs-review"].includes(stage.status) && stage.output?.kind === "plan" && stage.output.status === "needs-review" && !stage.output.scope_change_required
    && stage.output_fingerprint === plannerRecoveryHash(stage.output) && task?.lifecycle === "finished" && task.outcome === "needs-review" && Number.isSafeInteger(task.revision) && task.revision! >= 1
    && task.envelope.sandbox === "read-only" && task.envelope.context_manifest?.sandbox === "read-only"
    && !Object.hasOwn(task.envelope, "budget_admission") && !task.orchestration?.lease && !task.orchestration?.cancel_requested_at
    && task.orchestration?.last_failure?.kind === "terminal" && task.orchestration.last_failure.run_id === stage.execution_id
    && task.envelope.id === stage.task_id && task.envelope.project === owner.project_id && task.envelope.agent === stage.agent_id
    && admission?.schema_version === 2 && admission.workflow_id === owner.id && admission.stage_id === stage.id && admission.task_id === stage.task_id
    && admission.stage_generation === stage.generation && admission.grant_id === grant.id && admission.authority_revision === grant.authority_revision
    && admission.role_id === stage.role_id && admission.stage_kind === "planning" && admission.manifest_fingerprint === stage.context_fingerprint
    && task.envelope.context_manifest?.fingerprint === stage.context_fingerprint && admission.issue_id === owner.issue_id && admission.scope_revision === owner.scope_revision
    && stage.grant_id === grant.id && stage.authority_revision === grant.authority_revision && intent?.status === "committed" && intent.task_id === task.envelope.id && intent.context_fingerprint === stage.context_fingerprint
    && charge?.usage_complete && charge.stage_id === stage.id && charge.task_id === task.envelope.id && charge.attempt === 1 && task.orchestration.attempts === 1
    && run?.usage_complete === true && typeof run.thread_id === "string" && typeof run.turn_id === "string" && typeof run.context_fingerprint === "string" && /^[a-f0-9]{64}$/.test(run.context_fingerprint));
  const proof = verify(run!.terminal_usage_evidence, { taskId: task!.envelope.id, executionId: stage.execution_id!, contextFingerprint: run!.context_fingerprint as string,
    threadId: run!.thread_id as string, turnId: run!.turn_id as string, usage: run!.usage as Parameters<typeof verify>[1]["usage"] });
  requireRecovery(proof && charge!.observed_tokens === proof.usage.totalTokens
    && charge!.observed_tokens < task!.envelope.context_manifest!.budget.max_total_tokens && charge!.active_runtime_ms < task!.envelope.context_manifest!.budget.max_runtime_ms);
  const r = owner!.planner_recovery;
  if (r) requireRecovery(r.task_revision === task!.revision && r.task_fingerprint === plannerRecoveryHash(task) && r.terminal_receipt_fingerprint === plannerRecoveryHash(proof));
  const output = stage.output!;
  // Full normalization is checked by the service as well; no error text alone qualifies.
  requireRecovery(task!.result?.status === output.status && task!.result.summary === output.summary
    && isDeepStrictEqual(task!.result.risks, output.risks) && isDeepStrictEqual(task!.result.blockers, ["Workflow role reported an incomplete result."])
    && task!.result.files_changed.length === 0 && task!.result.commands_run.length === 0 && task!.result.tests_run.length === 0);
}
