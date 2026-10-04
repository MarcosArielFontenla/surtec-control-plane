import { describe, expect, it } from "vitest";
import type { IssueDocument, WorkIssue } from "../issues/types";
import type { GovernedWorkflow, WorkflowCandidateBinding, WorkflowDocument, WorkflowStage, WorkflowRoleOutput } from "./types";
import { assertOwnedWorkflowIssueProgress, sealWorkflowHandoff, sealWorkflowReviewReceipt, workflowEvidenceHash, workflowReviewAllowsContinuation } from "./review-evidence";

const fingerprint = (value: string) => workflowEvidenceHash(value);
const candidate: WorkflowCandidateBinding = {
  candidate_id: "C-candidate1", issue_id: "I-workflow1", repository_id: "alpha", task_id: "T-engineer1", execution_id: "run-engineer1", scope_revision: 1,
  base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), changed_paths: ["src/value.txt"], diff_fingerprint: fingerprint("diff"),
  content_fingerprint: fingerprint("content"), testing_evidence_fingerprint: fingerprint("testing"),
};
const outputBase = { schema_version: 1 as const, status: "completed" as const, summary: "Synthetic bounded review", evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Human acceptance", requested_decision: null };
const reviewOutput = (): WorkflowRoleOutput => ({ ...outputBase, kind: "review", verdict: "approve", findings: [] });
const qaOutput = (): WorkflowRoleOutput => ({ ...outputBase, kind: "qa", verdict: "approve", findings: [], criteria: [{ criterion: "Exact result", status: "supported", evidence_ids: [] }] });
const issue = () => ({ id: "I-workflow1", project_id: "alpha", scope_revision: 1, status: "checking", candidate_ids: [candidate.candidate_id], evidence_ids: ["E-engineer-verification"], task_ids: [candidate.task_id],
  authorized_scope: { expected_outcome: "Exact result", acceptance_criteria: ["Exact result"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] },
  acceptance_criteria: ["Exact result"], revision: 1 } as unknown as WorkIssue);
const reviewPolicy = { intrinsic_depth: "focused" as const, minimum_depth: "focused" as const, effective_depth: "focused" as const, qa_required: false, reasons: [], fingerprint: fingerprint("review-policy") };
function reviewStage(output: WorkflowRoleOutput = reviewOutput()): WorkflowStage {
  return { schema_version: 1, id: "WS-review1", workflow_id: "WF-workflow1", grant_id: "WG-grant1", authority_revision: 1, generation: 1, ordinal: 2,
    kind: output.kind === "qa" ? "qa" : "review", role_id: output.kind === "qa" ? "qa-evaluator" : "reviewer", agent_id: output.kind === "qa" ? "qa-reviewer" : "reality-checker",
    sandbox: "read-only", status: "completed", phase: "execution", task_id: "T-review1", execution_id: "run-review1", predecessor_stage_id: "WS-engineer1", supersedes_stage_id: null,
    handoff_id: null, output, output_fingerprint: workflowEvidenceHash(output), candidate, context_fingerprint: fingerprint("review-context"), created_at: "2026-10-03T12:00:00.000Z", updated_at: "2026-10-03T12:00:01.000Z" };
}
function evidenceDocument(): IssueDocument {
  return { issues: { [issue().id]: issue() }, evidence: { "E-engineer-verification": { issue_id: issue().id, task_id: candidate.task_id, execution_id: candidate.execution_id,
    candidate_id: candidate.candidate_id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: 1, kind: "verification", status: "passed" } },
    events: [] } as unknown as IssueDocument;
}

describe("immutable workflow review evidence", () => {
  it.each(["workflow_id", "stage_id", "task_id", "scope_revision", "candidate_id", "diff_fingerprint", "execution_id", "kind"])("accepts only exact correction progress and rejects changed %s", (field) => {
    const previous = reviewStage(), correction: WorkflowStage = { ...previous, id: "WS-correction1", kind: "correction", role_id: "software-engineer", sandbox: "workspace-write",
      agent_id: "backend-engineer", task_id: "T-correction1", execution_id: "run-correction1", predecessor_stage_id: previous.id };
    const owner = { id: "WF-workflow1", issue_id: issue().id, project_id: "alpha", current_grant_id: "WG-grant1", scope_revision: 1 } as unknown as GovernedWorkflow;
    const entry = issue(); entry.revision = 3;
    const issues = { ...evidenceDocument(), issues: { [entry.id]: entry }, candidates: { [candidate.candidate_id]: { ...candidate, id: candidate.candidate_id, task_id: correction.task_id, execution_id: correction.execution_id } }, events: [
      { id: "EV-correction1", at: "2026-10-03T12:00:00.000Z", issue_id: entry.id, scope_revision: 1, type: "bounded-correction-authorized", payload: { workflow_id: owner.id,
        stage_id: correction.id, task_id: correction.task_id, scope_revision: 1, candidate_id: candidate.candidate_id, diff_fingerprint: candidate.diff_fingerprint } },
      { id: "EV-correction2", at: "2026-10-03T12:00:01.000Z", issue_id: entry.id, scope_revision: 1, type: "candidate-produced", payload: { task_id: correction.task_id, candidate_id: candidate.candidate_id } },
    ] } as unknown as IssueDocument;
    const document = { stages: { [previous.id]: previous, [correction.id]: correction }, grants: { [owner.current_grant_id]: { scope_revision: 1, authorized_scope: entry.authorized_scope } } } as unknown as WorkflowDocument;
    expect(() => assertOwnedWorkflowIssueProgress(document, owner, issues, 1)).not.toThrow();
    expect(() => assertOwnedWorkflowIssueProgress(document, owner, issues, -1)).toThrow();
    if (field === "kind") correction.kind = "implementation";
    else if (field === "execution_id") issues.candidates[candidate.candidate_id]!.execution_id = "run-other";
    else issues.events[0]!.payload[field] = field === "scope_revision" ? 2 : "different";
    expect(() => assertOwnedWorkflowIssueProgress(document, owner, issues, 1)).toThrow();
  });
  it("seals the writer handoff against its exact verified candidate and evidence", () => {
    const from: WorkflowStage = { ...reviewStage(), id: "WS-engineer1", kind: "implementation", role_id: "software-engineer", agent_id: "backend-engineer", sandbox: "workspace-write",
      ordinal: 1, task_id: candidate.task_id, execution_id: candidate.execution_id, predecessor_stage_id: null, status: "completed", output: null, output_fingerprint: workflowEvidenceHash(candidate), candidate };
    const to = { ...reviewStage(), status: "pending" as const, output: null, output_fingerprint: null, predecessor_stage_id: from.id, task_id: null, execution_id: null };
    const document = { workflows: { ["WF-workflow1"]: { issue_id: issue().id } } } as unknown as WorkflowDocument;
    const sealed = sealWorkflowHandoff(document, from, to, evidenceDocument(), "WH-writer1", "2026-10-03T12:00:02.000Z");
    expect(sealed).toMatchObject({ id: "WH-writer1", from_role_id: "software-engineer", to_role_id: "reviewer", execution_id: candidate.execution_id,
      evidence_ids: ["E-engineer-verification"], outcome_summary: "Owned implementation produced the exact verified candidate." });
    expect(() => sealWorkflowHandoff(document, { ...from, output_fingerprint: fingerprint("forged") }, to, evidenceDocument(), "WH-forged1", "2026-10-03T12:00:02.000Z")).toThrow();
  });

  it("binds a receipt to its exact immutable candidate, review output, context and policy", () => {
    const stage = reviewStage(), owner = { id: "WF-workflow1", issue_id: issue().id, current_grant_id: "WG-grant1", authority_revision: 1, candidate, review_policy: reviewPolicy } as unknown as GovernedWorkflow;
    const document = { workflows: { [owner.id]: owner } } as unknown as WorkflowDocument;
    const receipt = sealWorkflowReviewReceipt(document, stage, evidenceDocument(), "WR-review1", "2026-10-03T12:00:02.000Z");
    expect(receipt).toMatchObject({ workflow_id: owner.id, stage_id: stage.id, task_id: stage.task_id, execution_id: stage.execution_id, candidate,
      context_fingerprint: stage.context_fingerprint, review_policy_fingerprint: reviewPolicy.fingerprint, output_fingerprint: stage.output_fingerprint, verdict: "approve" });
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => sealWorkflowReviewReceipt(document, { ...stage, output_fingerprint: fingerprint("changed") }, evidenceDocument(), "WR-review2", "2026-10-03T12:00:02.000Z")).toThrow();
  });

  it("requires every QA criterion to be supported and rejects blocking findings before acceptance", () => {
    const unsupported = { ...qaOutput(), criteria: [{ criterion: "Exact result", status: "missing" as const, evidence_ids: [] }] };
    const blocked = { ...reviewOutput(), findings: [{ id: "finding1", severity: "blocking" as const, summary: "Unresolved blocker", path: "src/value.txt", evidence_ids: [], scope_change_required: false }] };
    expect(workflowReviewAllowsContinuation(reviewOutput())).toBe(true);
    expect(workflowReviewAllowsContinuation(qaOutput())).toBe(true);
    expect(workflowReviewAllowsContinuation(unsupported)).toBe(false);
    expect(workflowReviewAllowsContinuation(blocked)).toBe(false);
    expect(workflowReviewAllowsContinuation({ ...outputBase, kind: "review", verdict: "inconclusive", findings: [] })).toBe(false);
  });

  it("preserves authority only across issue events linked to this workflow stage", () => {
    const stage = { ...reviewStage(), status: "queued" as const, task_id: "T-review1", execution_id: null, output: null, output_fingerprint: null };
    const owner = { id: "WF-workflow1", issue_id: issue().id, project_id: "alpha", current_grant_id: "WG-grant1", scope_revision: 1 } as unknown as GovernedWorkflow;
    const grant = { workflow_id: owner.id, project_id: "alpha", issue_id: issue().id, scope_revision: 1, authorized_scope: issue().authorized_scope };
    const entry = issue(); entry.revision = 2;
    const linked = { ...evidenceDocument(), issues: { [entry.id]: entry }, events: [
      { id: "EV-workflow-link1", at: "2026-10-03T12:00:00.000Z", issue_id: entry.id, scope_revision: 1, type: "workflow-role-task-linked", payload: { workflow_id: owner.id, stage_id: stage.id, task_id: stage.task_id } }] } as IssueDocument;
    const document = { workflows: { [owner.id]: owner }, grants: { [owner.current_grant_id]: grant }, stages: { [stage.id]: stage }, review_receipts: {} } as unknown as WorkflowDocument;
    expect(() => assertOwnedWorkflowIssueProgress(document, owner, linked, 1)).not.toThrow();
    const unrelated = structuredClone(linked); unrelated.events[0]!.payload.workflow_id = "WF-other1";
    expect(() => assertOwnedWorkflowIssueProgress(document, owner, unrelated, 1)).toThrow();
  });
});
