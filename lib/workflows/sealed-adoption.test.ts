import { describe, expect, it } from "vitest";
import type { IssueDocument, WorkIssue } from "../issues/types";
import type { TaskRecord } from "../state/types";
import { bindAdoptionOwner, digest, inspectAdoptionReport, readAdoptionSeal, type AdoptionSeal } from "./sealed-adoption";
import { workflowEvidenceHash } from "./review-evidence";
import type { WorkflowDocument } from "./types";

const scope = { expected_outcome: "Recover the fixture", acceptance_criteria: ["Match the report"], allowed_path_patterns: ["README.md"],
  excluded_path_patterns: [], allowed_change_categories: ["docs"], explicit_exclusions: [] };
const issueId = "I-00000000-0000-4000-8000-000000000001";
const plan = { stage_id: "ST-plan", decision_id: "D-plan", output_fingerprint: digest("plan") };
const reviewFields = { intrinsic_depth: "focused", minimum_depth: "full", effective_depth: "full", qa_required: true, reasons: ["Fixture floor"] };
const review = { ...reviewFields, fingerprint: workflowEvidenceHash(reviewFields) };
const seal: AdoptionSeal = { schema_version: 1, project_id: "fixture", issue_id: issueId, issue_revision: 5, scope_revision: 2,
  scope_sha256: workflowEvidenceHash(scope), workflow_id: "WF-owner", stage_id: "ST-write", task_id: "T-owner", run_id: "R-owner",
  plan_sha256: plan.output_fingerprint, review_policy_sha256: review.fingerprint, testing_policy_sha256: digest("testing"),
  base: "a".repeat(40), commit: "b".repeat(40), tree: "c".repeat(40), report_sha256: digest("report"), verifier_pins_sha256: digest("verifier") };

function state() {
  const issue = {
    id: issueId, project_id: seal.project_id, status: "needs-decision", revision: 5, scope_revision: 2,
    scope_change_proposal: null, authorized_scope: scope, acceptance_criteria: scope.acceptance_criteria,
    task_ids: [seal.task_id], candidate_ids: [] as string[],
  };
  const workflow = {
    id: seal.workflow_id, project_id: issue.project_id, issue_id: issue.id, scope_revision: issue.scope_revision, status: "needs-decision",
    recovery_state: "awaiting-human", pending_decision_id: null, current_stage_id: seal.stage_id, current_grant_id: "G-owner",
    authority_revision: 1, candidate: null, approved_plan: plan, review_policy: review, counters: { accounting_complete: false },
  };
  const stage = {
    id: seal.stage_id, workflow_id: seal.workflow_id, task_id: seal.task_id, execution_id: seal.run_id, grant_id: "G-owner",
    authority_revision: 1, generation: 1, status: "needs-review", kind: "implementation", agent_id: "agent", role_id: "software-engineer",
    sandbox: "workspace-write", context_fingerprint: digest("context"),
  };
  const grant = {
    id: stage.grant_id, workflow_id: workflow.id, project_id: issue.project_id, issue_id: issue.id, scope_revision: issue.scope_revision,
    authority_revision: workflow.authority_revision, authorized_scope: scope, approved_by: "human", testing_mode: "functional",
    testing_policy_fingerprint: seal.testing_policy_sha256, minimum_review_depth: "full", role_assignments: [],
  };
  const charge = { execution_id: seal.run_id, workflow_id: workflow.id, stage_id: stage.id, task_id: stage.task_id,
    attempt: 1, attempt_charged: true, usage_complete: false, observed_tokens: 9000 };
  const intent = { status: "committed", workflow_id: workflow.id, stage_id: stage.id, grant_id: grant.id,
    authority_revision: workflow.authority_revision, task_id: stage.task_id, context_fingerprint: stage.context_fingerprint };
  const portablePath = process.platform === "win32" ? "C:/surtec-test" : "/surtec-test";
  const task = {
    lifecycle: "finished", outcome: "needs-review", orchestration: { lease: null, retry_at: null, attempts: 1, last_failure: { run_id: seal.run_id } },
    envelope: { id: stage.task_id, project: issue.project_id, sandbox: "workspace-write", agent: stage.agent_id, repo_path: portablePath,
      metadata: { run: { branch: "agent/T-owner-agent", worktree_path: portablePath } },
      context_manifest: { fingerprint: stage.context_fingerprint },
      context_admission: { schema_version: 2, workflow_id: workflow.id, stage_id: stage.id, stage_kind: stage.kind,
        stage_generation: stage.generation, task_id: stage.task_id, grant_id: grant.id, authority_revision: stage.authority_revision,
        issue_id: issue.id, scope_revision: issue.scope_revision, scope_fingerprint: seal.scope_sha256,
        role_id: stage.role_id, manifest_fingerprint: stage.context_fingerprint, approved_plan: plan } },
  };
  const decision = { workflow_id: workflow.id, kind: "plan-approval", status: "approved", decided_by: "human", approval_id: "owner" };
  const issues = { issues: { [issue.id]: issue as unknown as WorkIssue }, candidates: {} } as IssueDocument;
  const workflows = { workflows: { [workflow.id]: workflow }, stages: { [stage.id]: stage }, grants: { [grant.id]: grant },
    decisions: { [plan.decision_id]: decision }, accounting: { [charge.execution_id]: charge }, admission_intents: { intent } } as unknown as WorkflowDocument;
  const tasks = [task as unknown as TaskRecord];
  return { issues, workflows, tasks, issue, workflow, stage, task, charge, decision };
}

describe("sealed adoption bindings", () => {
  it("binds the exact stopped, charged execution and leaves incomplete accounting untouched", () => {
    const data = state(), before = JSON.stringify(data);
    expect(bindAdoptionOwner(data, seal)).toMatchObject({ requiredQa: true, issue: { id: seal.issue_id } });
    expect(JSON.stringify(data)).toBe(before);
  });

  it.each([
    ["ISSUE_BINDING_MISMATCH", (data: ReturnType<typeof state>) => { data.issue.revision++; }],
    ["OWNER_NOT_INACTIVE", (data: ReturnType<typeof state>) => { data.stage.status = "running"; }],
    ["EXECUTION_BINDING_MISMATCH", (data: ReturnType<typeof state>) => { data.charge.execution_id = "R-other"; }],
    ["PLAN_BINDING_MISMATCH", (data: ReturnType<typeof state>) => { data.decision.status = "pending"; }],
    ["CANDIDATE_UNAVAILABLE", (data: ReturnType<typeof state>) => { data.issue.candidate_ids.push("C-later"); }],
    ["PROJECT_WRITER_ACTIVE", (data: ReturnType<typeof state>) => {
      data.tasks.push({ ...data.tasks[0]!, lifecycle: "queued", envelope: { ...data.tasks[0]!.envelope, id: "T-competing" } });
    }],
  ] as const)("stops with %s when the live facts differ", (code, mutate) => {
    const data = state();
    mutate(data);
    expect(() => bindAdoptionOwner(data, seal)).toThrow(code);
  });

  it("checks the owner anchor before consuming the seal and rejects unrecognized fields", () => {
    const bytes = Buffer.from(JSON.stringify(seal));
    expect(readAdoptionSeal(bytes, digest(bytes))).toEqual(seal);
    expect(() => readAdoptionSeal(bytes, digest("other"))).toThrow("SEAL_SHA256_MISMATCH");
    const extended = Buffer.from(JSON.stringify({ ...seal, verify_command: "do not run" }));
    expect(() => readAdoptionSeal(extended, digest(extended))).toThrow("UNSUPPORTED_SEAL");
  });

  it("refuses failed reports and treats unsupported or incomplete reports as unknown", () => {
    for (const [report, code] of [[{ schema_version: 1, outcome: "FAIL" }, "VERIFICATION_FAILED"],
      [{ schema_version: 2, outcome: "PASS" }, "UNSUPPORTED_REPORT"], [{ schema_version: 1, outcome: "PASS" }, "REPORT_INCOMPLETE"]] as const) {
      const bytes = Buffer.from(JSON.stringify(report));
      expect(() => inspectAdoptionReport(bytes, { ...seal, report_sha256: digest(bytes) }, digest("content"), { frontend: 82, backend: 10 })).toThrow(code);
    }
  });
});
