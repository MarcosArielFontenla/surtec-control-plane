import { isDeepStrictEqual } from "node:util";
import { contextHash } from "../context/assemble";
import { assertTestingEvidenceBinding, evidenceHash, testingEvidenceStatus } from "../context/testing-evidence";
import type { IssueDocument, WorkIssue } from "../issues/types";
import type { TaskRecord } from "../state/types";
import { validateTaskRecord } from "../state/validation";
import { validateRoleOutput } from "./role-output";
import { assertRoleHandoff, assertReviewReceipt, WorkflowContractError } from "./validation";
import type { GovernedWorkflow, ReviewReceipt, RoleHandoff, WorkflowCandidateBinding, WorkflowDocument, WorkflowStage } from "./types";

export const workflowEvidenceHash = (value: unknown): string => contextHash(JSON.stringify(value));
function requireEvidence(ok: unknown, message: string): asserts ok {
  if (!ok) throw new WorkflowContractError(message);
}

/** Pure cross-record guard, not a lease, runtime capability or human approval. */
export function assertTerminalWorkflowTask(document: WorkflowDocument, stage: WorkflowStage, task: TaskRecord | null): asserts task is TaskRecord {
  const workflow = document.workflows[stage.workflow_id], admission = task?.envelope.context_admission;
  const charge = stage.execution_id ? document.accounting[stage.execution_id] : null;
  const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === stage.id);
  requireEvidence(workflow && workflow.current_grant_id === stage.grant_id && workflow.authority_revision === stage.authority_revision
    && !workflow.stop_requested_at && workflow.counters.accounting_complete && task && validateTaskRecord(task)
    && task.lifecycle === "finished" && task.outcome === "completed" && task.envelope.id === stage.task_id
    && !task.orchestration?.lease && !task.orchestration?.cancel_requested_at && !task.orchestration?.last_failure
    && admission?.schema_version === 2 && admission.workflow_id === workflow.id && admission.stage_id === stage.id
    && admission.task_id === stage.task_id && admission.stage_generation === stage.generation && admission.grant_id === stage.grant_id
    && admission.authority_revision === stage.authority_revision && admission.role_id === stage.role_id
    && admission.manifest_fingerprint === stage.context_fingerprint && task.envelope.context_manifest?.fingerprint === stage.context_fingerprint
    && intent?.status === "committed" && intent.task_id === stage.task_id && intent.context_fingerprint === stage.context_fingerprint
    && charge?.usage_complete && charge.stage_id === stage.id && charge.task_id === task.envelope.id && charge.attempt === task.orchestration?.attempts,
  "Terminal workflow task, authority or accounting differs");
}

/** Only canonical, attributable owned progress may advance a grant's revision. */
export function assertOwnedWorkflowIssueProgress(document: WorkflowDocument, workflow: GovernedWorkflow, issues: IssueDocument, revision: number): void {
  const issue = issues.issues[workflow.issue_id], grant = document.grants[workflow.current_grant_id];
  requireEvidence(Number.isSafeInteger(revision) && revision >= 1 && issue && grant && issue.scope_revision === grant.scope_revision && isDeepStrictEqual(issue.authorized_scope, grant.authorized_scope)
    && issue.project_id === workflow.project_id && issue.revision >= revision && !issue.scope_change_proposal, "Workflow issue scope or revision changed");
  const events = issues.events.filter((event) => event.issue_id === issue.id);
  // Issue revision starts at 1 and each audit event advances it once.
  requireEvidence(events.length === issue.revision - 1, "Workflow issue audit is incomplete");
  // The event producing revision N is at index N-2; only facts after the
  // admission revision may be checked as owned workflow progress.
  for (const event of events.slice(revision - 1)) {
    const payload = event.payload;
    const stage = Object.values(document.stages).find((entry) => entry.workflow_id === workflow.id && entry.task_id === payload.task_id);
    const candidate = typeof payload.candidate_id === "string" ? issues.candidates[payload.candidate_id] : null;
    const owned = stage && event.scope_revision === grant.scope_revision;
    const link = ["execution-admitted", "workflow-role-task-linked"].includes(event.type) && payload.workflow_id === workflow.id && payload.stage_id === stage?.id
      || event.type === "bounded-correction-authorized" && stage?.kind === "correction" && payload.workflow_id === workflow.id && payload.stage_id === stage.id
        && payload.task_id === stage.task_id && payload.scope_revision === grant.scope_revision
        && !!stage.predecessor_stage_id && payload.candidate_id === document.stages[stage.predecessor_stage_id]?.candidate?.candidate_id
        && payload.diff_fingerprint === document.stages[stage.predecessor_stage_id]?.candidate?.diff_fingerprint;
    const produced = event.type === "candidate-produced" && (stage?.kind === "implementation" || stage?.kind === "correction")
      && candidate?.task_id === stage.task_id && candidate.execution_id === stage.execution_id;
    const captured = event.type === "workflow-verification-passed" && payload.workflow_id === workflow.id && candidate?.task_id === stage?.task_id && candidate?.execution_id === stage?.execution_id;
    const review = event.type === "workflow-review-recorded" && payload.workflow_id === workflow.id && typeof payload.receipt_id === "string"
      && document.review_receipts[payload.receipt_id]?.stage_id === stage?.id && document.review_receipts[payload.receipt_id]?.fingerprint === payload.receipt_fingerprint;
    const ready = event.type === "verification-passed" && payload.workflow_id === workflow.id && payload.candidate_id === workflow.candidate?.candidate_id;
    requireEvidence(owned && (link || produced || captured || review || ready), "Unrelated issue progress cannot preserve workflow authority");
  }
}

/** Caller reads the exact bounded contained artifact; Git/tree checks are separate. */
export function bindVerifiedWorkflowCandidate(issues: IssueDocument, issue: WorkIssue, task: TaskRecord, patch: Buffer): WorkflowCandidateBinding {
  const candidate = issues.candidates[issue.candidate_ids.at(-1) ?? ""], receipt = task.testing_evidence;
  const run = task.envelope.metadata.run as Record<string, unknown> | undefined;
  requireEvidence(validateTaskRecord(task) && task.lifecycle === "finished" && task.outcome === "completed" && !task.orchestration?.lease
    && !task.orchestration?.cancel_requested_at && !task.orchestration?.last_failure && candidate && candidate.invalidated_at === null
    && candidate.task_id === task.envelope.id && candidate.issue_id === issue.id && candidate.repository_id === issue.project_id
    && task.envelope.project === issue.project_id && candidate.scope_revision === issue.scope_revision && issue.task_ids.includes(task.envelope.id)
    && receipt && run?.committed === true && run.diff_truncated === false && run.diff_path === `reports/${task.envelope.id}-${candidate.execution_id}.diff`
    && patch.length > 0 && patch.length <= 512 * 1024, "Candidate task or complete diff artifact is unavailable");
  assertTestingEvidenceBinding(receipt, task, candidate);
  requireEvidence(receipt.scope_fingerprint === workflowEvidenceHash(issue.authorized_scope) && testingEvidenceStatus(receipt) === "passed"
    && candidate.diff_fingerprint === contextHash(`${candidate.repository_id}\0${candidate.base_revision}\0${candidate.candidate_revision}\0${candidate.changed_paths.join("\0")}`)
    && issue.evidence_ids.some((id) => {
      const entry = issues.evidence[id];
      return entry?.kind === "verification" && entry.status === "passed" && entry.issue_id === issue.id && entry.task_id === task.envelope.id
        && entry.execution_id === candidate.execution_id && entry.candidate_id === candidate.id && entry.candidate_revision === candidate.candidate_revision
        && entry.scope_revision === issue.scope_revision && entry.diff_fingerprint === candidate.diff_fingerprint && entry.testing_evidence_fingerprint === receipt.fingerprint;
    }), "Candidate lacks exact passing captured verification");
  return { candidate_id: candidate.id, issue_id: issue.id, repository_id: candidate.repository_id, task_id: candidate.task_id, execution_id: candidate.execution_id,
    scope_revision: candidate.scope_revision, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, changed_paths: [...candidate.changed_paths],
    diff_fingerprint: candidate.diff_fingerprint, content_fingerprint: evidenceHash(patch), testing_evidence_fingerprint: receipt.fingerprint };
}

export function sealWorkflowHandoff(document: WorkflowDocument, from: WorkflowStage, to: WorkflowStage, issues: IssueDocument, id: string, at: string): RoleHandoff {
  const workflow = document.workflows[from.workflow_id]!, issue = issues.issues[workflow.issue_id]!;
  requireEvidence(from.status === "completed" && from.execution_id && from.output_fingerprint && to.workflow_id === from.workflow_id
    && to.predecessor_stage_id === from.id && to.ordinal === from.ordinal + 1, "Handoff producer or finite recipient differs");
  if (from.output) validateRoleOutput(from.output, { kind: from.kind as "planning" | "analysis" | "operations" | "review" | "qa", issue, evidence: issues.evidence, candidate: from.candidate });
  const evidence = issue.evidence_ids.filter((key) => {
    const entry = issues.evidence[key];
    return entry?.issue_id === issue.id && entry.task_id === from.task_id && entry.execution_id === from.execution_id
      && entry.scope_revision === issue.scope_revision && (!from.candidate || entry.candidate_id === from.candidate.candidate_id);
  });
  requireEvidence(evidence.length <= 50 && (from.output ? workflowEvidenceHash(from.output) : workflowEvidenceHash(from.candidate)) === from.output_fingerprint, "Handoff evidence is unsealed or exceeds bounds");
  const handoff: RoleHandoff = { schema_version: 1, id, issue_id: issue.id, from_role_id: from.role_id, to_role_id: to.role_id, execution_id: from.execution_id,
    outcome_summary: from.output?.summary ?? "Owned implementation produced the exact verified candidate.", evidence_ids: evidence,
    unresolved_questions: from.output?.unresolved_questions ?? [], risks: from.output?.risks ?? [],
    recommended_next_action: from.output?.recommended_next_action ?? "Inspect the sealed candidate and captured verification without changing files.",
    requested_decision: from.output?.requested_decision ?? null, created_at: at };
  assertRoleHandoff(handoff); return structuredClone(handoff);
}

export function sealWorkflowReviewReceipt(document: WorkflowDocument, stage: WorkflowStage, issues: IssueDocument, id: string, at: string): ReviewReceipt {
  const workflow = document.workflows[stage.workflow_id]!, issue = issues.issues[workflow.issue_id]!, output = stage.output;
  requireEvidence(stage.status === "completed" && (stage.role_id === "reviewer" || stage.role_id === "qa-evaluator") && stage.task_id && stage.execution_id
    && stage.context_fingerprint && stage.candidate && workflow.review_policy && isDeepStrictEqual(stage.candidate, workflow.candidate)
    && output && (output.kind === "review" || output.kind === "qa") && output.status === "completed" && workflowEvidenceHash(output) === stage.output_fingerprint,
  "Review stage has no exact sealed output/candidate");
  validateRoleOutput(output, { kind: stage.kind as "review" | "qa", issue, evidence: issues.evidence, candidate: stage.candidate });
  const unsigned: Omit<ReviewReceipt, "fingerprint"> = { schema_version: 1, id, workflow_id: workflow.id, stage_id: stage.id, task_id: stage.task_id, execution_id: stage.execution_id,
    role_id: stage.role_id, agent_id: stage.agent_id, issue_id: issue.id, scope_revision: issue.scope_revision, candidate: structuredClone(stage.candidate), grant_id: stage.grant_id,
    authority_revision: stage.authority_revision, context_fingerprint: stage.context_fingerprint, review_policy_fingerprint: workflow.review_policy.fingerprint,
    output_fingerprint: stage.output_fingerprint!, verdict: output.verdict, findings: structuredClone(output.findings), created_at: at };
  const receipt = { ...unsigned, fingerprint: workflowEvidenceHash(unsigned) }; assertReviewReceipt(receipt); return receipt;
}

export function workflowReviewAllowsContinuation(output: WorkflowStage["output"]): boolean {
  if (!output || (output.kind !== "review" && output.kind !== "qa")) return false;
  return output.status === "completed" && output.verdict === "approve" && !output.requested_decision && output.unresolved_questions.length === 0
    && !output.findings.some((finding) => finding.severity === "blocking")
    && (output.kind !== "qa" || output.criteria.every((criterion) => criterion.status === "supported"));
}

export function applicableWorkflowReviews(document: WorkflowDocument, workflow: GovernedWorkflow, issues: IssueDocument, taskReader: (id: string) => TaskRecord | null) {
  requireEvidence(workflow.candidate && workflow.review_policy, "Workflow has no candidate or current review policy");
  const required = workflow.review_policy.qa_required || workflow.template_id === "quality-review" ? ["reviewer", "qa-evaluator"] : ["reviewer"];
  const receipts = required.map((role) => {
    const matches = Object.values(document.review_receipts).filter((receipt) => receipt.workflow_id === workflow.id && receipt.role_id === role
      && workflow.stage_ids.includes(receipt.stage_id) && isDeepStrictEqual(receipt.candidate, workflow.candidate));
    requireEvidence(matches.length === 1, "Required current review receipt is missing or conflicting");
    const receipt = matches[0]!, stage = document.stages[receipt.stage_id]!;
    assertTerminalWorkflowTask(document, stage, taskReader(receipt.task_id));
    const { fingerprint, ...unsigned } = receipt;
    requireEvidence(stage.status === "completed" && workflowEvidenceHash(unsigned) === fingerprint && receipt.grant_id === workflow.current_grant_id
      && receipt.authority_revision === workflow.authority_revision && receipt.review_policy_fingerprint === workflow.review_policy!.fingerprint
      && isDeepStrictEqual(sealWorkflowReviewReceipt(document, stage, issues, receipt.id, receipt.created_at), receipt)
      && workflowReviewAllowsContinuation(stage.output),
    "Review is stale, incomplete or requires a decision");
    return receipt;
  });
  const fingerprint = workflowEvidenceHash({ candidate: workflow.candidate, grant_id: workflow.current_grant_id, authority_revision: workflow.authority_revision,
    review_policy: workflow.review_policy, receipts: receipts.map((entry) => ({ id: entry.id, fingerprint: entry.fingerprint })) });
  const risks = receipts.some((receipt) => receipt.findings.some((finding) => finding.severity === "advisory")
    || document.stages[receipt.stage_id]!.output!.risks.length > 0);
  return { receipts, fingerprint, risks };
}

export function hasCurrentRiskAcknowledgement(document: WorkflowDocument, workflow: GovernedWorkflow, fingerprint: string, ids: string[]): boolean {
  return Object.values(document.decisions).some((decision) => decision.workflow_id === workflow.id && decision.kind === "risk-acknowledgement" && decision.status === "approved"
    && decision.candidate_id === workflow.candidate?.candidate_id && decision.resource_fingerprint === fingerprint && isDeepStrictEqual(decision.review_receipt_ids, ids));
}
