import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type {
  GovernedWorkflow, ReviewReceipt, RoleHandoff, WorkflowAdmissionIntent, WorkflowCandidateBinding,
  WorkflowCandidateLineage, WorkflowDecision, WorkflowDocument, WorkflowGrant, WorkflowPolicy,
  WorkflowRoleOutput, WorkflowRunAccounting, WorkflowStage,
} from "./types";
import { WORKFLOW_LIMITS, WORKFLOW_ROLES, WORKFLOW_TEMPLATES } from "./types";
import documentSchema from "../../schemas/workflow-document.schema.json";
import recordSchema from "../../schemas/workflow-record.schema.json";
import { WORK_SCALES } from "../organization/issue-lifecycle";
import {
  assertReviewReceipt, assertRoleHandoff, assertWorkflowAdmissionIntent, assertWorkflowCandidateLineage,
  assertWorkflowDecision, assertWorkflowDocument, assertWorkflowDocumentMutation, assertWorkflowGrant, assertWorkflowPolicy,
  assertWorkflowRecord, assertWorkflowRoleOutput, assertWorkflowRunAccounting, assertWorkflowStage,
  WorkflowContractError,
} from "./validation";

// Synthetic data shapes only: these fixtures are not actual approval, sealed
// evidence, issued context, persisted state or permission to call a runtime.
const at = "2026-10-01T12:00:00Z";
const hash = "a".repeat(64);
const budget = () => ({ max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 });
const correctionBudget = () => ({ max_tasks: 3, max_attempts: 4, max_runtime_ms: 300000, max_total_tokens: 40000 });
const candidate = (): WorkflowCandidateBinding => ({ candidate_id: "candidate-1", issue_id: "issue-1", repository_id: "synthetic", task_id: "writer-1", execution_id: "writer-run-1", scope_revision: 1,
  base_revision: "b".repeat(40), candidate_revision: "c".repeat(40), changed_paths: ["src/example.ts"], diff_fingerprint: hash, content_fingerprint: hash, testing_evidence_fingerprint: hash });
const outputBase = () => ({ schema_version: 1 as const, status: "completed" as const, summary: "Synthetic bounded observation", evidence_ids: ["evidence-1"], unresolved_questions: [], risks: [], recommended_next_action: "Review current evidence", requested_decision: null });
const output = (): WorkflowRoleOutput => ({ ...outputBase(), kind: "plan", plan: ["Apply the authorized bounded change"], scope_change_required: false });
const handoff = (): RoleHandoff => ({ schema_version: 1, id: "handoff-1", issue_id: "issue-1", from_role_id: "planner", to_role_id: "software-engineer", execution_id: "plan-run-1", outcome_summary: "Approved scope needs implementation", evidence_ids: ["evidence-1"], unresolved_questions: [], risks: [], recommended_next_action: "Wait for plan approval", requested_decision: "Approve the exact proposal", created_at: at });
const receipt = (): ReviewReceipt => ({ schema_version: 1, id: "receipt-1", workflow_id: "workflow-1", stage_id: "review-stage-1", task_id: "review-task-1", execution_id: "review-run-1", role_id: "reviewer", agent_id: "reality-reviewer", issue_id: "issue-1", scope_revision: 1,
  candidate: candidate(), grant_id: "grant-1", authority_revision: 1, context_fingerprint: hash, review_policy_fingerprint: hash, output_fingerprint: hash, verdict: "approve", findings: [], created_at: at, fingerprint: hash });
const grant = (): WorkflowGrant => ({ schema_version: 1, id: "grant-1", workflow_id: "workflow-1", project_id: "synthetic", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "implementation", template_version: 1,
  authorized_scope: { expected_outcome: "Improve one synthetic behavior", acceptance_criteria: ["The behavior is verified"], allowed_path_patterns: ["src/**"], excluded_path_patterns: ["src/private/**"], allowed_change_categories: ["code"], explicit_exclusions: [] },
  role_assignments: [{ role_id: "planner", agent_id: "tech-lead", sandbox: "read-only", client_context_categories: [] }, { role_id: "software-engineer", agent_id: "backend-dev", sandbox: "workspace-write", client_context_categories: [] }],
  permitted_stage_kinds: ["planning", "implementation"], source_fingerprints: [{ id: "runtime/safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional",
  budget: budget(), correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: "synthetic-approval-1", approved_at: at });
const workflow = (): GovernedWorkflow => ({ schema_version: 1, id: "workflow-1", revision: 1, project_id: "synthetic", issue_id: "issue-1", scope_revision: 1, template_id: "implementation", template_version: 1, status: "running", work_scale: "trivial", current_grant_id: "grant-1", authority_revision: 1,
  stage_ids: ["stage-1"], current_stage_id: "stage-1", pending_decision_id: null, lineage_id: null, candidate: null, approved_plan: null, review_policy: null, budget: budget(), counters: { tasks: 1, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Wait for Planner", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null });
const stage = (): WorkflowStage => ({ schema_version: 1, id: "stage-1", workflow_id: "workflow-1", grant_id: "grant-1", authority_revision: 1, generation: 1, ordinal: 1, kind: "planning", role_id: "planner", agent_id: "tech-lead", sandbox: "read-only", status: "reserved", phase: "execution", task_id: "plan-task-1", execution_id: null, predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output: null, output_fingerprint: null, candidate: null, context_fingerprint: hash, created_at: at, updated_at: at });
const decision = (): WorkflowDecision => ({ schema_version: 1, id: "decision-1", workflow_id: "workflow-1", kind: "plan-approval", status: "pending", expected_workflow_revision: 1, expected_issue_revision: 1, resource_fingerprint: hash, candidate_id: null, review_receipt_ids: [], summary: "Approve the exact plan", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null });
const intent = (): WorkflowAdmissionIntent => ({ schema_version: 1, id: "intent-1", workflow_id: "workflow-1", stage_id: "stage-1", grant_id: "grant-1", authority_revision: 1, task_id: "plan-task-1", status: "reserved", expected_issue_revision: 1, expected_workflow_revision: 1, context_fingerprint: hash, blocked_reason: null, created_at: at, updated_at: at });
const accounting = (): WorkflowRunAccounting => ({ schema_version: 1, id: "account-1", workflow_id: "workflow-1", stage_id: "stage-1", task_id: "plan-task-1", execution_id: "plan-run-1", attempt: 1, attempt_charged: true, active_runtime_ms: 1000, observed_tokens: 200, usage_complete: true, captured_at: at });
const lineage = (): WorkflowCandidateLineage => ({ schema_version: 1, id: "lineage-1", project_id: "synthetic", issue_id: "issue-1", scope_revision: 1, origin_task_id: "writer-1", workflow_ids: ["workflow-1"], candidate_ids: [], correction_limit: 1, corrections_consumed: 0, consumed_stage_id: null, consumed_at: null });
const policy = (): WorkflowPolicy => ({ schema_version: 1, default_budget: budget(), correction_budget: correctionBudget(), automated_correction_default: false, minimum_review_depth: "focused", qa_on_full: true, protected_path_patterns: [".agents/**", "registry/**", "test/probes/**"] });
const empty = (): WorkflowDocument => ({ schema_version: 1, workflows: {}, stages: {}, grants: {}, decisions: {}, handoffs: {}, review_receipts: {}, admission_intents: {}, accounting: {}, lineages: {}, events: [] });
const document = (): WorkflowDocument => ({ ...empty(), workflows: { "workflow-1": workflow() }, stages: { "stage-1": stage() }, grants: { "grant-1": grant() }, admission_intents: { "intent-1": intent() } });
const contracts: Array<{ name: string; fixture: () => unknown; assert: (value: unknown) => void }> = [
  { name: "workflow", fixture: workflow, assert: assertWorkflowRecord }, { name: "grant", fixture: grant, assert: assertWorkflowGrant },
  { name: "stage", fixture: stage, assert: assertWorkflowStage }, { name: "decision", fixture: decision, assert: assertWorkflowDecision },
  { name: "intent", fixture: intent, assert: assertWorkflowAdmissionIntent }, { name: "accounting", fixture: accounting, assert: assertWorkflowRunAccounting },
  { name: "lineage", fixture: lineage, assert: assertWorkflowCandidateLineage }, { name: "handoff", fixture: handoff, assert: assertRoleHandoff },
  { name: "receipt", fixture: receipt, assert: assertReviewReceipt }, { name: "role output", fixture: output, assert: assertWorkflowRoleOutput },
  { name: "policy", fixture: policy, assert: assertWorkflowPolicy }, { name: "aggregate", fixture: document, assert: assertWorkflowDocument },
];

function linkedDocument(): WorkflowDocument {
  const d = document(), w = d.workflows["workflow-1"]!, g = d.grants["grant-1"]!, p = d.stages["stage-1"]!;
  p.status = "completed"; p.execution_id = "plan-run-1"; p.output = output(); p.output_fingerprint = hash;
  d.accounting["account-1"] = accounting();
  g.role_assignments.push({ role_id: "reviewer", agent_id: "reality-reviewer", sandbox: "read-only", client_context_categories: [] });
  g.permitted_stage_kinds.push("review", "correction"); g.correction = { enabled: true, max_corrections: 1, budget: correctionBudget() };
  d.stages["review-stage-1"] = { ...stage(), id: "review-stage-1", ordinal: 2, kind: "review", role_id: "reviewer", agent_id: "reality-reviewer", status: "completed", task_id: "review-task-1", execution_id: "review-run-1", predecessor_stage_id: p.id, handoff_id: "handoff-1", output: { ...outputBase(), kind: "review", verdict: "approve", findings: [] }, output_fingerprint: hash, candidate: candidate() };
  d.handoffs["handoff-1"] = { ...handoff(), to_role_id: "reviewer" };
  d.review_receipts["receipt-1"] = receipt();
  d.accounting["review-account-1"] = { ...accounting(), id: "review-account-1", stage_id: "review-stage-1", task_id: "review-task-1", execution_id: "review-run-1" };
  w.stage_ids.push("review-stage-1"); w.current_stage_id = "review-stage-1"; w.candidate = candidate(); w.lineage_id = "lineage-1";
  w.counters = { tasks: 2, attempts: 2, runtime_ms: 2000, total_tokens: 400, accounting_complete: true };
  d.lineages["lineage-1"] = { ...lineage(), candidate_ids: ["candidate-1"] };
  d.decisions["decision-1"] = { ...decision(), kind: "candidate-acceptance", candidate_id: "candidate-1", review_receipt_ids: ["receipt-1"] };
  w.status = "waiting-human"; w.pending_decision_id = "decision-1";
  d.events.push({ schema_version: 1, id: "event-1", workflow_id: w.id, stage_id: "review-stage-1", execution_id: "review-run-1", revision: 1, type: "review-sealed", summary: "Synthetic review sealed", at });
  return d;
}

function correctionSealFixture() {
  const before = linkedDocument(), owner = before.workflows["workflow-1"]!;
  owner.status = "running"; owner.pending_decision_id = null; owner.current_stage_id = "correction-1"; owner.stage_ids.push("correction-1");
  owner.counters = { tasks: 3, attempts: 3, runtime_ms: 3000, total_tokens: 600, accounting_complete: true };
  const correction: WorkflowStage = { ...stage(), id: "correction-1", ordinal: 3, kind: "correction", role_id: "software-engineer", agent_id: "backend-dev", sandbox: "workspace-write",
    status: "running", task_id: "correction-task", execution_id: "correction-run", predecessor_stage_id: "review-stage-1", candidate: candidate(), output: null, output_fingerprint: null };
  before.stages[correction.id] = correction;
  const lineage = before.lineages["lineage-1"]!; lineage.corrections_consumed = 1; lineage.consumed_stage_id = correction.id; lineage.consumed_at = at;
  before.admission_intents["correction-intent"] = { ...intent(), id: "correction-intent", stage_id: correction.id, task_id: correction.task_id!, status: "committed" };
  before.accounting["correction-account"] = { ...accounting(), id: "correction-account", stage_id: correction.id, task_id: correction.task_id!, execution_id: correction.execution_id! };
  const after = structuredClone(before), current = after.workflows[owner.id]!, sealed = after.stages[correction.id]!;
  const corrected: WorkflowCandidateBinding = { ...candidate(), candidate_id: "candidate-2", task_id: correction.task_id!, execution_id: correction.execution_id!,
    base_revision: candidate().candidate_revision, candidate_revision: "d".repeat(40), testing_evidence_fingerprint: "b".repeat(64), diff_fingerprint: "c".repeat(64), content_fingerprint: "d".repeat(64) };
  sealed.status = "completed"; sealed.candidate = corrected; sealed.output_fingerprint = createHash("sha256").update(JSON.stringify(corrected)).digest("hex");
  current.revision++; current.candidate = structuredClone(corrected); after.lineages[lineage.id]!.candidate_ids.push(corrected.candidate_id);
  return { before, after, correctionId: correction.id };
}

describe("T010 exact correction candidate terminal seal", () => {
  it("does not permit bound candidate replacement on an ordinary writer", () => {
    const before = document(), writer = before.stages["stage-1"]!, owner = before.workflows["workflow-1"]!;
    writer.kind = "implementation"; writer.role_id = "software-engineer"; writer.agent_id = "backend-dev"; writer.sandbox = "workspace-write";
    writer.status = "running"; writer.execution_id = "plan-run-1"; writer.candidate = candidate(); owner.candidate = candidate();
    owner.counters = { tasks: 1, attempts: 1, runtime_ms: 1000, total_tokens: 200, accounting_complete: true }; before.accounting["account-1"] = accounting();
    const after = structuredClone(before), replacement = { ...candidate(), candidate_id: "candidate-2", candidate_revision: "d".repeat(40) };
    after.stages[writer.id]!.candidate = replacement; after.stages[writer.id]!.status = "completed";
    after.stages[writer.id]!.output_fingerprint = createHash("sha256").update(JSON.stringify(replacement)).digest("hex");
    after.workflows[owner.id]!.candidate = replacement; after.workflows[owner.id]!.revision++;
    expect(() => assertWorkflowDocument(before)).not.toThrow(); expect(() => assertWorkflowDocument(after)).not.toThrow();
    expect(() => assertWorkflowDocumentMutation(before, after)).toThrow(/Bound stage evidence/);
  });
  it("replaces only the running correction input with its exact fresh output and preserves sealed history", () => {
    const { before, after } = correctionSealFixture(), bytes = JSON.stringify(before);
    expect(() => assertWorkflowDocumentMutation(before, after)).not.toThrow(); expect(JSON.stringify(before)).toBe(bytes);
    expect(after.stages["review-stage-1"]).toEqual(before.stages["review-stage-1"]); expect(after.review_receipts).toEqual(before.review_receipts);
    expect(after.admission_intents).toEqual(before.admission_intents); expect(after.accounting).toEqual(before.accounting);
    const replay = structuredClone(after); replay.workflows["workflow-1"]!.revision++; replay.stages["correction-1"]!.candidate!.content_fingerprint = "e".repeat(64);
    expect(() => assertWorkflowDocumentMutation(after, replay)).toThrow();
  });
  it.each(["base", "task", "run", "testing", "diff", "output", "workflow-candidate", "queued", "running", "blocked", "stopped", "pending-decision", "uncommitted", "unknown-usage", "lineage"])("rejects correction seal drift in %s without mutating inputs", (change) => {
    const { before, after, correctionId } = correctionSealFixture(), correction = after.stages[correctionId]!, owner = after.workflows["workflow-1"]!;
    const replacement = correction.candidate!;
    if (change === "base") replacement.base_revision = "e".repeat(40);
    if (change === "task") replacement.task_id = "unowned-task";
    if (change === "run") replacement.execution_id = "unowned-run";
    if (change === "testing") replacement.testing_evidence_fingerprint = candidate().testing_evidence_fingerprint;
    if (change === "diff") replacement.diff_fingerprint = candidate().diff_fingerprint;
    if (change === "output") correction.output_fingerprint = hash;
    if (change === "workflow-candidate") owner.candidate = candidate();
    if (change === "queued") before.stages[correctionId]!.status = "queued";
    if (change === "running") correction.status = "running";
    if (change === "blocked") { owner.status = "needs-decision"; owner.blocked_reason = "Synthetic decision"; }
    if (change === "stopped") owner.stop_requested_at = at;
    if (change === "pending-decision") owner.pending_decision_id = "decision-1";
    if (change === "uncommitted") before.admission_intents["correction-intent"]!.status = "reserved";
    if (change === "unknown-usage") { before.accounting["correction-account"]!.usage_complete = false; after.accounting["correction-account"]!.usage_complete = false; }
    if (change === "lineage") { before.lineages["lineage-1"]!.corrections_consumed = 0; before.lineages["lineage-1"]!.consumed_at = null; before.lineages["lineage-1"]!.consumed_stage_id = null; }
    if (["base", "task", "run", "testing", "diff"].includes(change)) {
      owner.candidate = structuredClone(replacement); correction.output_fingerprint = createHash("sha256").update(JSON.stringify(replacement)).digest("hex");
    }
    const bytes = JSON.stringify([before, after]); expect(() => assertWorkflowDocumentMutation(before, after)).toThrow(); expect(JSON.stringify([before, after])).toBe(bytes);
  });
});

describe("Workflow aggregate relationships and mutation fences (T003)", () => {
  it("accepts fully linked synthetic history without treating it as real authority", () => {
    const d = linkedDocument(), before = JSON.stringify(d); assertWorkflowDocument(d);
    assertWorkflowDocumentMutation(d, structuredClone(d)); expect(JSON.stringify(d)).toBe(before);
  });
  it.each<Array<(d: WorkflowDocument) => void>>([
    [(d) => { delete d.grants["grant-1"]; }],
    [(d) => { d.grants["grant-1"]!.workflow_id = "other"; }],
    [(d) => { d.grants["grant-1"]!.issue_id = "other"; }],
    [(d) => { d.grants["grant-1"]!.authority_revision = 2; }],
    [(d) => { d.grants["grant-1"]!.budget.max_tasks = 6; }],
    [(d) => { d.workflows["workflow-1"]!.stage_ids = ["review-stage-1", "stage-1"]; }],
    [(d) => { d.workflows["workflow-1"]!.current_stage_id = "other"; }],
    [(d) => { d.decisions["decision-1"]!.workflow_id = "other"; }],
    [(d) => { d.stages["stage-1"]!.agent_id = "other"; }],
    [(d) => { d.grants["grant-1"]!.permitted_stage_kinds = ["planning"]; }],
    [(d) => { d.stages["review-stage-1"]!.predecessor_stage_id = "other"; }],
    [(d) => { d.stages["stage-1"]!.predecessor_stage_id = "review-stage-1"; }],
    [(d) => { d.stages["stage-1"]!.generation = 2; }],
    [(d) => { d.stages["stage-1"]!.supersedes_stage_id = "review-stage-1"; }],
    [(d) => { d.handoffs["handoff-1"]!.issue_id = "other"; }],
    [(d) => { d.handoffs["handoff-1"]!.from_role_id = "software-engineer"; }],
    [(d) => { d.handoffs["handoff-1"]!.execution_id = "other"; }],
    [(d) => { d.stages["review-stage-1"]!.handoff_id = null; }],
    [(d) => { d.review_receipts["receipt-1"]!.stage_id = "stage-1"; }],
    [(d) => { d.review_receipts["receipt-1"]!.context_fingerprint = "b".repeat(64); }],
    [(d) => { d.review_receipts["receipt-1"]!.candidate.content_fingerprint = "b".repeat(64); }],
    [(d) => { d.decisions["decision-1"]!.candidate_id = "other"; }],
    [(d) => { d.decisions["decision-1"]!.expected_workflow_revision = 2; }],
    [(d) => { d.decisions["decision-1"]!.review_receipt_ids = ["other"]; }],
    [(d) => { d.admission_intents["intent-1"]!.task_id = "other"; }],
    [(d) => { d.accounting["account-1"]!.task_id = "other"; }],
    [(d) => { d.accounting["duplicate"] = { ...d.accounting["account-1"]!, id: "duplicate" }; d.workflows["workflow-1"]!.counters = { tasks: 2, attempts: 3, runtime_ms: 3000, total_tokens: 600, accounting_complete: true }; }],
    [(d) => { d.workflows["workflow-1"]!.counters.total_tokens = 399; }],
    [(d) => { d.accounting["account-1"]!.usage_complete = false; }],
    [(d) => { d.lineages["lineage-1"]!.issue_id = "other"; }],
    [(d) => { d.lineages["lineage-1"]!.candidate_ids.push("other"); }],
    [(d) => { d.lineages["lineage-1"]!.corrections_consumed = 1; d.lineages["lineage-1"]!.consumed_stage_id = "stage-1"; d.lineages["lineage-1"]!.consumed_at = at; }],
    [(d) => { d.events[0]!.workflow_id = "other"; }],
    [(d) => { d.events[0]!.execution_id = "other"; }],
    [(d) => { d.events[0]!.revision = 2; }],
  ])("rejects malformed cross-record fixture %# without modifying it", (change) => {
    const d = linkedDocument(); change(d); const before = JSON.stringify(d);
    expect(() => assertWorkflowDocument(d)).toThrow(WorkflowContractError); expect(JSON.stringify(d)).toBe(before);
  });
  it("retains valid replacement generations in the same seven-slot index", () => {
    const before = linkedDocument(), after = structuredClone(before), old = after.stages["review-stage-1"]!;
    after.stages["review-stage-2"] = { ...old, id: "review-stage-2", generation: 2, supersedes_stage_id: old.id, status: "pending", task_id: null, execution_id: null, output: null, output_fingerprint: null, context_fingerprint: null, handoff_id: null };
    const w = after.workflows["workflow-1"]!; w.stage_ids[1] = "review-stage-2"; w.current_stage_id = "review-stage-2"; w.revision++;
    expect(() => assertWorkflowDocumentMutation(before, after)).not.toThrow();
    delete after.stages[old.id]; expect(() => assertWorkflowDocumentMutation(before, after)).toThrow();
  });
  it("charges one correction before any task reservation and preserves it across cancellation", () => {
    const before = linkedDocument(), after = structuredClone(before), w = after.workflows["workflow-1"]!;
    after.stages["correction-1"] = { ...stage(), id: "correction-1", kind: "correction", role_id: "software-engineer", agent_id: "backend-dev", sandbox: "workspace-write", ordinal: 3, predecessor_stage_id: "review-stage-1", status: "pending", task_id: null, context_fingerprint: null };
    w.stage_ids.push("correction-1"); w.revision++;
    const l = after.lineages["lineage-1"]!; l.corrections_consumed = 1; l.consumed_stage_id = "correction-1"; l.consumed_at = at;
    assertWorkflowDocumentMutation(before, after);
    const cancelled = structuredClone(after); cancelled.stages["correction-1"]!.status = "cancelled"; cancelled.workflows[w.id]!.revision++;
    assertWorkflowDocumentMutation(after, cancelled);
    const reset = structuredClone(cancelled); reset.lineages[l.id]!.corrections_consumed = 0; reset.lineages[l.id]!.consumed_stage_id = null; reset.lineages[l.id]!.consumed_at = null; reset.workflows[w.id]!.revision++;
    expect(() => assertWorkflowDocumentMutation(cancelled, reset)).toThrow(/reset/);
  });
  it.each<Array<(d: WorkflowDocument) => void>>([
    [(d) => { d.grants["grant-1"]!.approval_id = "rewritten"; }],
    [(d) => { d.handoffs["handoff-1"]!.outcome_summary = "rewritten"; }],
    [(d) => { d.review_receipts["receipt-1"]!.fingerprint = "b".repeat(64); }],
    [(d) => { d.stages["stage-1"]!.output = { ...output(), summary: "rewritten" }; }],
    [(d) => { d.events = []; }],
    [(d) => { d.events[0]!.summary = "rewritten"; }],
    [(d) => { d.workflows["workflow-1"]!.counters.tasks = 3; d.workflows["workflow-1"]!.counters.total_tokens = 400; d.workflows["workflow-1"]!.revision = 1; }],
    [(d) => { d.workflows["workflow-1"]!.revision = 3; }],
    [(d) => { d.workflows["workflow-1"]!.work_scale = "bounded"; }],
    [(d) => { d.accounting["account-1"]!.observed_tokens = 201; d.workflows["workflow-1"]!.counters.total_tokens = 401; }],
    [(d) => { d.decisions["decision-1"]!.resource_fingerprint = "b".repeat(64); }],
    [(d) => { d.admission_intents["intent-1"]!.expected_issue_revision = 2; }],
    [(d) => { d.lineages["lineage-1"]!.correction_limit = 0; }],
  ])("rejects rewritten history or authority in mutation fixture %#", (change) => {
    const before = linkedDocument(), after = structuredClone(before); after.workflows["workflow-1"]!.revision++; change(after);
    expect(() => assertWorkflowDocumentMutation(before, after)).toThrow(WorkflowContractError);
  });
  it("cannot regress conservative counters, clear stop intent or reopen terminal roots", () => {
    const before = linkedDocument(), w = before.workflows["workflow-1"]!; w.counters.total_tokens = 500; w.stop_requested_at = at;
    const reduced = structuredClone(before); reduced.workflows[w.id]!.revision++; reduced.workflows[w.id]!.counters.total_tokens = 450;
    expect(() => assertWorkflowDocumentMutation(before, reduced)).toThrow(/regress/);
    const cleared = structuredClone(before); cleared.workflows[w.id]!.revision++; cleared.workflows[w.id]!.stop_requested_at = null;
    expect(() => assertWorkflowDocumentMutation(before, cleared)).toThrow(/stop/);
    w.status = "cancelled"; w.completed_at = at;
    const reopened = structuredClone(before); reopened.workflows[w.id]!.revision++; reopened.workflows[w.id]!.status = "waiting-human"; reopened.workflows[w.id]!.completed_at = null;
    expect(() => assertWorkflowDocumentMutation(before, reopened)).toThrow(/Terminal workflow/);
  });
  it("supports observed in-flight usage, then blocks unknown interrupted usage until reconciled", () => {
    const before = document(), p = before.stages["stage-1"]!, w = before.workflows["workflow-1"]!;
    p.status = "running"; p.execution_id = "plan-run-1"; before.accounting["account-1"] = { ...accounting(), usage_complete: false };
    w.counters = { tasks: 1, attempts: 1, runtime_ms: 1000, total_tokens: 200, accounting_complete: true }; assertWorkflowDocument(before);
    const interrupted = structuredClone(before); interrupted.stages[p.id]!.status = "queued";
    expect(() => assertWorkflowDocument(interrupted)).toThrow(/Unknown run usage/);
    const blocked = interrupted.workflows[w.id]!; blocked.revision++; blocked.status = "needs-decision"; blocked.blocked_reason = "Interrupted usage is unknown"; blocked.counters.accounting_complete = false;
    assertWorkflowDocumentMutation(before, interrupted);
    const reconciled = structuredClone(interrupted); reconciled.workflows[w.id]!.revision++; reconciled.accounting["account-1"]!.usage_complete = true; reconciled.workflows[w.id]!.counters.accounting_complete = true;
    assertWorkflowDocumentMutation(interrupted, reconciled);
  });
  it("retains charged lineage when a new root replaces a terminal workflow", () => {
    const before = linkedDocument(), old = before.workflows["workflow-1"]!;
    old.status = "cancelled"; old.stop_requested_at = at; old.completed_at = at;
    const after = structuredClone(before), w = { ...structuredClone(old), id: "workflow-2", revision: 1, status: "running" as const, current_grant_id: "grant-2", stage_ids: ["stage-2"], current_stage_id: "stage-2", pending_decision_id: null, stop_requested_at: null, completed_at: null, counters: { tasks: 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true } };
    after.workflows[w.id] = w; after.grants["grant-2"] = { ...grant(), id: "grant-2", workflow_id: w.id };
    after.stages["stage-2"] = { ...stage(), id: "stage-2", workflow_id: w.id, grant_id: "grant-2", status: "pending", task_id: null, context_fingerprint: null };
    after.lineages["lineage-1"]!.workflow_ids.push(w.id);
    assertWorkflowDocumentMutation(before, after); expect(after.workflows[old.id]).toEqual(old);
    const detached = structuredClone(after); detached.workflows[w.id]!.lineage_id = null; detached.lineages["lineage-1"]!.workflow_ids.pop();
    expect(() => assertWorkflowDocument(detached)).toThrow(/detach/);
  });
  it("requires a new grant for a changed scope without rewriting the old grant", () => {
    const before = document(), after = structuredClone(before), w = after.workflows["workflow-1"]!;
    w.revision++; w.authority_revision++; w.scope_revision++; w.current_grant_id = "grant-2";
    after.grants["grant-2"] = { ...grant(), id: "grant-2", authority_revision: 2, scope_revision: 2, approval_id: "synthetic-fresh-approval" };
    assertWorkflowDocumentMutation(before, after); expect(after.grants["grant-1"]).toEqual(before.grants["grant-1"]);
  });
  it("binds approved plans to an actual stored planning output and resolved decision", () => {
    const d = linkedDocument(), p = d.stages["stage-1"]!;
    d.decisions["plan-approval"] = { ...decision(), id: "plan-approval", status: "approved", approval_id: "synthetic-plan-approval", decided_by: "human", rationale: "Reviewed exact synthetic output", decided_at: at };
    d.workflows["workflow-1"]!.approved_plan = { stage_id: p.id, output_fingerprint: hash, decision_id: "plan-approval" }; assertWorkflowDocument(d);
    d.decisions["plan-approval"]!.resource_fingerprint = "b".repeat(64); expect(() => assertWorkflowDocument(d)).toThrow(/Approved plan binding/);
  });
  it("rejects duplicate task reservations, orphan generations, ambiguous grant revisions and uncharged correction", () => {
    const d = linkedDocument(); d.stages["review-stage-1"]!.task_id = d.stages["stage-1"]!.task_id;
    expect(() => assertWorkflowDocument(d)).toThrow(/task owners/);
    const orphan = document(); orphan.stages["orphan"] = { ...stage(), id: "orphan", status: "pending", task_id: null }; expect(() => assertWorkflowDocument(orphan)).toThrow(/Orphan/);
    const duplicate = document(); duplicate.grants["grant-2"] = { ...grant(), id: "grant-2" }; expect(() => assertWorkflowDocument(duplicate)).toThrow(/authority revisions/);
    const correction = linkedDocument(), w = correction.workflows["workflow-1"]!;
    correction.stages["correction-1"] = { ...stage(), id: "correction-1", ordinal: 3, kind: "correction", role_id: "software-engineer", agent_id: "backend-dev", sandbox: "workspace-write", task_id: "correction-task" }; w.stage_ids.push("correction-1"); w.counters.tasks++;
    expect(() => assertWorkflowDocument(correction)).toThrow(/durable lineage consumption/);
  });
  it("prevents resolved decision and admission replay without fabricating acknowledgement", () => {
    const before = linkedDocument(), resolved = before.decisions["decision-1"]!, w = before.workflows["workflow-1"]!;
    Object.assign(resolved, { status: "approved", approval_id: "synthetic-approval", decided_by: "human", rationale: "Reviewed exact evidence", decided_at: at }); w.pending_decision_id = null; w.status = "running";
    before.admission_intents["intent-1"]!.status = "committed";
    const replay = structuredClone(before); replay.workflows[w.id]!.revision++; replay.decisions[resolved.id]!.rationale = "rewritten";
    expect(() => assertWorkflowDocumentMutation(before, replay)).toThrow(/Resolved decision/);
    const retry = structuredClone(before); retry.workflows[w.id]!.revision++; retry.admission_intents["intent-1"]!.status = "reserved";
    expect(() => assertWorkflowDocumentMutation(before, retry)).toThrow(/Resolved admission/);
  });
  it("rejects uncompleted roots, future event times and reversed event revisions", () => {
    const completed = linkedDocument(); completed.workflows["workflow-1"]!.status = "completed"; completed.workflows["workflow-1"]!.completed_at = at;
    expect(() => assertWorkflowDocument(completed)).toThrow(/unfinished/);
    const d = linkedDocument(); d.events[0]!.at = "2026-10-02T12:00:00Z"; expect(() => assertWorkflowDocument(d)).toThrow(/timestamp order/);
    const reversed = linkedDocument(); reversed.workflows["workflow-1"]!.revision = 2; reversed.events[0]!.revision = 2; reversed.events.push({ ...reversed.events[0]!, id: "event-2", revision: 1 });
    expect(() => assertWorkflowDocument(reversed)).toThrow(/revision order/);
  });
});

describe("Phase O workflow contracts (T001)", () => {
  it("aligns the workflow schema with all canonical v1 issue work scales without adding a lifecycle edge", () => {
    expect(recordSchema.properties.work_scale.enum).toEqual([...WORK_SCALES]);
    for (const work_scale of WORK_SCALES) {
      const value = { ...workflow(), work_scale }, before = JSON.stringify(value);
      expect(() => assertWorkflowRecord(value)).not.toThrow(); expect(JSON.stringify(value)).toBe(before);
      expect(() => assertWorkflowDocument({ ...document(), workflows: { [value.id]: value } })).not.toThrow();
    }
    expect(() => assertWorkflowRecord({ ...workflow(), work_scale: "unclassified" })).toThrow();
  });
  it.each(contracts)("accepts the strict synthetic $name without modifying it", ({ fixture, assert }) => {
    const value = fixture(); const before = JSON.stringify(value);
    expect(() => assert(value)).not.toThrow(); expect(JSON.stringify(value)).toBe(before);
  });
  it.each(contracts)("rejects unknown fields and future or missing versions for $name", ({ fixture, assert }) => {
    expect(() => assert({ ...(fixture() as object), unexpected: true })).toThrow(WorkflowContractError);
    expect(() => assert({ ...(fixture() as object), schema_version: 2 })).toThrow(/Invalid or unsupported/);
    expect(() => assert({ ...(fixture() as object), schema_version: "1" })).toThrow(/Invalid or unsupported/);
    const missing = fixture() as Record<string, unknown>; delete missing.schema_version;
    expect(() => assert(missing)).toThrow(/Invalid or unsupported/);
  });
  it("has exactly five template identities and the six existing logical roles", () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(5); expect(WORKFLOW_ROLES).toHaveLength(6);
    expect(() => assertWorkflowRecord({ ...workflow(), template_id: "custom-graph" })).toThrow();
    expect(() => assertWorkflowRecord({ ...workflow(), template_version: 2 })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), to_role_id: "human" })).toThrow();
  });
  it.each(["api_token", "credentials", "prompt", "chain_of_thought", "commands", "publication_authority"])("rejects extra persisted %s fields without exposing their bodies", (field) => {
    try { assertRoleHandoff({ ...handoff(), [field]: "SYNTHETIC-PRIVATE-MARKER" }); throw new Error("must reject"); }
    catch (error) { expect(error).toBeInstanceOf(WorkflowContractError); expect((error as Error).message).not.toContain("SYNTHETIC-PRIVATE-MARKER"); }
  });
  it("keeps handoff v1 limited to the exact roadmap fields", () => {
    expect(Object.keys(handoff()).sort()).toEqual(["schema_version", "id", "issue_id", "from_role_id", "to_role_id", "execution_id", "outcome_summary", "evidence_ids", "unresolved_questions", "risks", "recommended_next_action", "requested_decision", "created_at"].sort());
    expect(() => assertRoleHandoff({ ...handoff(), supersedes_id: "previous" })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), outcome_summary: " " })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), outcome_summary: "x".repeat(2001) })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), risks: Array.from({ length: 21 }, (_, index) => `risk-${index}`) })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), risks: ["x".repeat(501)] })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), evidence_ids: ["evidence-1", "evidence-1"] })).toThrow();
  });
  it.each(["2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-13-01T12:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01", "2026-10-01T12:00:00+99:00"])("rejects invalid calendar/timestamp %s", (created_at) => {
    expect(() => assertRoleHandoff({ ...handoff(), created_at })).toThrow();
  });
  it("supports valid leap-day/offset timestamps and rejects reversed chronology", () => {
    expect(() => assertRoleHandoff({ ...handoff(), created_at: "2028-02-29T09:00:00-03:00" })).not.toThrow();
    expect(() => assertWorkflowRecord({ ...workflow(), updated_at: "2026-09-30T12:00:00Z" })).toThrow(/Reversed/);
  });
  it.each([
    { max_tasks: 8 }, { max_attempts: 15 }, { max_runtime_ms: 1800001 }, { max_total_tokens: 300001 },
    { max_tasks: 0 }, { max_attempts: 0.5 }, { max_total_tokens: "100000" },
  ])("rejects unsafe root budget %j", (change) => {
    expect(() => assertWorkflowGrant({ ...grant(), budget: { ...budget(), ...change } })).toThrow();
  });
  it("does not default missing consent, widen sandbox or accept role/source duplicates", () => {
    const value = grant(); value.role_assignments.push({ ...value.role_assignments[0]!, agent_id: "product-manager" });
    expect(() => assertWorkflowGrant(value)).toThrow(/duplicate/);
    const duplicate = grant(); duplicate.source_fingerprints.push({ ...duplicate.source_fingerprints[0]!, fingerprint: "b".repeat(64) });
    expect(() => assertWorkflowGrant(duplicate)).toThrow(/duplicate/);
    const overreach = grant(); overreach.role_assignments[0]!.sandbox = "workspace-write";
    expect(() => assertWorkflowGrant(overreach)).toThrow(/sandbox/);
    const absent = grant() as unknown as { role_assignments: Record<string, unknown>[] }; delete absent.role_assignments[0]!.client_context_categories;
    expect(() => assertWorkflowGrant(absent)).toThrow();
    const extraConsent = grant(); extraConsent.role_assignments[0]!.client_context_categories = ["confidential-notes", "confidential-notes"];
    expect(() => assertWorkflowGrant(extraConsent)).toThrow();
    expect(() => assertWorkflowGrant({ ...grant(), template_id: "quality-review" })).toThrow(/writer/);
  });
  it("requires explicit internally consistent one-correction authority drawn from root budget", () => {
    expect(() => assertWorkflowGrant({ ...grant(), correction: { enabled: true, max_corrections: 1, budget: correctionBudget() } })).not.toThrow();
    for (const correction of [{ enabled: true, max_corrections: 0, budget: null }, { enabled: false, max_corrections: 1, budget: correctionBudget() }, { enabled: true, max_corrections: 2, budget: correctionBudget() }, { enabled: true, max_corrections: 1, budget: { ...correctionBudget(), max_tasks: 4 } }]) {
      expect(() => assertWorkflowGrant({ ...grant(), correction })).toThrow();
    }
    expect(() => assertWorkflowGrant({ ...grant(), budget: { ...budget(), max_total_tokens: 10000 }, correction: { enabled: true, max_corrections: 1, budget: correctionBudget() } })).toThrow(/root budget/);
    expect(() => assertWorkflowPolicy({ ...policy(), automated_correction_default: true })).toThrow();
    expect(() => assertWorkflowPolicy({ ...policy(), qa_on_full: false })).toThrow();
  });
  it("cannot lower full or current focused review floors or omit required QA", () => {
    const full = { intrinsic_depth: "full" as const, minimum_depth: "focused" as const, effective_depth: "full" as const, qa_required: true, reasons: ["Synthetic security impact"], fingerprint: hash };
    expect(() => assertWorkflowRecord({ ...workflow(), review_policy: full })).not.toThrow();
    expect(() => assertWorkflowRecord({ ...workflow(), review_policy: { ...full, effective_depth: "focused" } })).toThrow(/downgraded/);
    expect(() => assertWorkflowRecord({ ...workflow(), review_policy: { ...full, intrinsic_depth: "passive", minimum_depth: "full", effective_depth: "focused" } })).toThrow(/downgraded/);
    expect(() => assertWorkflowRecord({ ...workflow(), review_policy: { ...full, qa_required: false } })).toThrow(/QA/);
    expect(() => assertWorkflowRecord({ ...workflow(), review_policy: { ...full, effective_depth: "passive" } })).toThrow();
  });
  it("binds candidate identity and immutable review to issue/scope and a separate task", () => {
    expect(() => assertWorkflowRecord({ ...workflow(), candidate: { ...candidate(), issue_id: "other" } })).toThrow(/binding/);
    expect(() => assertWorkflowRecord({ ...workflow(), candidate: { ...candidate(), repository_id: "other" } })).toThrow(/binding/);
    expect(() => assertReviewReceipt({ ...receipt(), scope_revision: 2 })).toThrow(/binding/);
    expect(() => assertReviewReceipt({ ...receipt(), task_id: candidate().task_id })).toThrow(/separate task/);
    expect(() => assertReviewReceipt({ ...receipt(), context_fingerprint: "unbound" })).toThrow();
  });
  it.each(["../outside.ts", "C:/private.ts", "/tmp/file", "src\\file.ts", "src/../file.ts", "src//file.ts", "src/file\u0000.ts"])("rejects unsafe candidate/finding/policy/source path %s", (path) => {
    expect(() => assertReviewReceipt({ ...receipt(), candidate: { ...candidate(), changed_paths: [path] } })).toThrow();
    expect(() => assertWorkflowPolicy({ ...policy(), protected_path_patterns: [path] })).toThrow();
    expect(() => assertWorkflowGrant({ ...grant(), source_fingerprints: [{ id: path, fingerprint: hash }] })).toThrow();
    expect(() => assertWorkflowRoleOutput({ ...outputBase(), kind: "review", verdict: "inconclusive", findings: [{ id: "finding-1", severity: "advisory", summary: "Inspect evidence", path, evidence_ids: [], scope_change_required: false }] })).toThrow();
  });
  it("validates each role-specific output without loosening the generic report contract", () => {
    const outputs: WorkflowRoleOutput[] = [output(), { ...outputBase(), kind: "analysis", recommendations: ["Inspect the next bounded concern"] }, { ...outputBase(), kind: "operations", proposed_issue: null },
      { ...outputBase(), kind: "review", verdict: "approve", findings: [] }, { ...outputBase(), kind: "qa", verdict: "approve", findings: [], criteria: [{ criterion: "Current behavior is supported", status: "supported", evidence_ids: ["evidence-1"] }] }];
    for (const value of outputs) expect(() => assertWorkflowRoleOutput(value)).not.toThrow();
    expect(() => assertWorkflowRoleOutput({ ...output(), verdict: "approve" })).toThrow();
    expect(() => assertWorkflowRoleOutput({ ...output(), kind: "engineer" })).toThrow();
    expect(() => assertWorkflowRoleOutput({ ...outputs[4], criteria: [{ criterion: "Current behavior", status: "missing", evidence_ids: [] }] })).toThrow(/contradicts/);
    expect(() => assertWorkflowRoleOutput({ ...outputs[4], criteria: [{ criterion: "Current behavior", status: "supported", evidence_ids: [] }] })).toThrow(/requires evidence/);
    expect(() => assertWorkflowRoleOutput({ ...outputs[3], status: "blocked" })).toThrow(/Uncompleted/);
  });
  it("rejects contradictory/duplicate findings and correction without concrete evidence", () => {
    const finding = { id: "finding-1", severity: "blocking", summary: "A bounded behavior differs", path: "src/example.ts", evidence_ids: ["evidence-1"], scope_change_required: false };
    expect(() => assertReviewReceipt({ ...receipt(), verdict: "correction-required", findings: [finding] })).not.toThrow();
    expect(() => assertReviewReceipt({ ...receipt(), findings: [finding] })).toThrow(/contradicts/);
    expect(() => assertReviewReceipt({ ...receipt(), verdict: "inconclusive", findings: [finding, { ...finding, summary: "Another observation with the same identity" }] })).toThrow(/duplicate/);
    expect(() => assertReviewReceipt({ ...receipt(), verdict: "correction-required", findings: [] })).toThrow(/concrete/);
    expect(() => assertReviewReceipt({ ...receipt(), verdict: "correction-required", findings: [{ ...finding, evidence_ids: [] }] })).toThrow(/evidence-linked/);
    expect(() => assertReviewReceipt({ ...receipt(), findings: [{ ...finding, severity: "advisory", scope_change_required: true }] })).toThrow(/material-scope/);
  });
  it("requires exact stage role, sandbox, output, task, context and execution identities", () => {
    expect(() => assertWorkflowStage({ ...stage(), sandbox: "workspace-write" })).toThrow(/binding/);
    expect(() => assertWorkflowStage({ ...stage(), role_id: "reviewer" })).toThrow(/binding/);
    expect(() => assertWorkflowStage({ ...stage(), phase: "verification" })).toThrow(/verification/);
    expect(() => assertWorkflowStage({ ...stage(), task_id: null })).toThrow(/task and context/);
    expect(() => assertWorkflowStage({ ...stage(), status: "running" })).toThrow(/run identity/);
    expect(() => assertWorkflowStage({ ...stage(), predecessor_stage_id: stage().id })).toThrow(/itself/);
    expect(() => assertWorkflowStage({ ...stage(), output: output(), output_fingerprint: hash })).not.toThrow();
    expect(() => assertWorkflowStage({ ...stage(), output: { ...outputBase(), kind: "analysis", recommendations: ["Inspect concern"] }, output_fingerprint: hash })).toThrow(/output binding/);
  });
  it("cannot fabricate a human decision or silently mark completion", () => {
    expect(() => assertWorkflowDecision({ ...decision(), approval_id: "fake" })).toThrow(/fabricating/);
    expect(() => assertWorkflowDecision({ ...decision(), status: "approved" })).toThrow(/acknowledgement/);
    expect(() => assertWorkflowDecision({ ...decision(), status: "approved", approval_id: "synthetic-approval", decided_by: "human", rationale: "Reviewed the exact binding", decided_at: at })).not.toThrow();
    expect(() => assertWorkflowRecord({ ...workflow(), status: "completed" })).toThrow(/timestamp/);
    expect(() => assertWorkflowRecord({ ...workflow(), status: "waiting-human" })).toThrow(/pending decision/);
    expect(() => assertWorkflowRecord({ ...workflow(), status: "needs-decision" })).toThrow(/explicit reason/);
    expect(() => assertWorkflowAdmissionIntent({ ...intent(), status: "blocked" })).toThrow(/reason/);
  });
  it("keeps overshoot and unknown usage visible instead of fabricating zero accounting", () => {
    const value = workflow(); value.counters.total_tokens = value.budget.max_total_tokens + 1;
    expect(() => assertWorkflowRecord(value)).toThrow(/visible stop/);
    expect(() => assertWorkflowRecord({ ...value, status: "needs-decision", blocked_reason: "Budget exceeded" })).not.toThrow();
    expect(() => assertWorkflowRecord({ ...value, stop_requested_at: at })).not.toThrow();
    const unknown = workflow(); unknown.counters.accounting_complete = false;
    expect(() => assertWorkflowRecord(unknown)).toThrow(/Unknown/);
    const attempts = workflow(); attempts.counters.attempts = attempts.budget.max_attempts + 1;
    expect(() => assertWorkflowRecord(attempts)).toThrow(/caps/);
    expect(() => assertWorkflowRunAccounting({ ...accounting(), observed_tokens: -1 })).toThrow();
    expect(() => assertWorkflowRunAccounting({ ...accounting(), attempt_charged: false })).toThrow();
  });
  it("binds consumed lineage correction to its durable stage and timestamp", () => {
    expect(() => assertWorkflowCandidateLineage({ ...lineage(), corrections_consumed: 1 })).toThrow(/binding/);
    expect(() => assertWorkflowCandidateLineage({ ...lineage(), consumed_stage_id: "correction-stage-1" })).toThrow(/binding/);
    expect(() => assertWorkflowCandidateLineage({ ...lineage(), corrections_consumed: 1, consumed_stage_id: "correction-stage-1", consumed_at: at })).not.toThrow();
    expect(() => assertWorkflowCandidateLineage({ ...lineage(), correction_limit: 0, corrections_consumed: 1, consumed_stage_id: "correction-stage-1", consumed_at: at })).toThrow(/allowance/);
    expect(() => assertWorkflowCandidateLineage({ ...lineage(), corrections_consumed: 2 })).toThrow();
  });
  it("accepts empty optional aggregate data but never substitutes it for missing or malformed input", () => {
    expect(() => assertWorkflowDocument(empty())).not.toThrow();
    for (const value of [undefined, null, "{broken", [], { schema_version: 1 }]) expect(() => assertWorkflowDocument(value)).toThrow();
  });
  it("rejects mismatched map identities, duplicate events and concurrent issue ownership", () => {
    const mismatch = document(); mismatch.workflows["wrong-key"] = mismatch.workflows["workflow-1"]!;
    expect(() => assertWorkflowDocument(mismatch)).toThrow(/map key/);
    const owners = document(); owners.workflows["workflow-2"] = { ...workflow(), id: "workflow-2" };
    expect(() => assertWorkflowDocument(owners)).toThrow(/active issue owners/);
    owners.workflows["workflow-2"]!.status = "cancelled"; owners.workflows["workflow-2"]!.completed_at = at; owners.workflows["workflow-2"]!.stop_requested_at = at;
    owners.workflows["workflow-2"]!.current_grant_id = "grant-2"; owners.workflows["workflow-2"]!.stage_ids = ["stage-2"]; owners.workflows["workflow-2"]!.current_stage_id = "stage-2";
    owners.grants["grant-2"] = { ...grant(), id: "grant-2", workflow_id: "workflow-2" };
    owners.stages["stage-2"] = { ...stage(), id: "stage-2", workflow_id: "workflow-2", grant_id: "grant-2", status: "cancelled", task_id: null };
    expect(() => assertWorkflowDocument(owners)).not.toThrow();
    const events = empty(); const event = { schema_version: 1 as const, id: "event-1", workflow_id: "workflow-1", stage_id: null, execution_id: null, revision: 1, type: "created" as const, summary: "Synthetic checkpoint", at };
    events.events.push(event, event); expect(() => assertWorkflowDocument(events)).toThrow(/duplicate/);
  });
  it("enforces aggregate counts and UTF-8 byte limits without touching files", () => {
    const oversized = empty(); oversized.workflows = Object.fromEntries(Array.from({ length: WORKFLOW_LIMITS.workflows + 1 }, (_, index) => [`workflow-${index}`, { ...workflow(), id: `workflow-${index}` }]));
    expect(() => assertWorkflowDocument(oversized)).toThrow(/Invalid/);
    expect(() => assertWorkflowDocument({ ...empty(), oversized: "x".repeat(WORKFLOW_LIMITS.documentBytes) })).toThrow(/byte limit/);
    const unicode: WorkflowRoleOutput = { ...outputBase(), summary: "界".repeat(2000), kind: "analysis", recommendations: Array.from({ length: 20 }, (_, index) => `${index} ${"界".repeat(1995)}`) };
    expect(() => assertWorkflowRoleOutput(unicode)).toThrow(/byte limit/);
    const cyclic: { reference?: unknown } = {}; cyclic.reference = cyclic;
    expect(() => assertWorkflowDocument(cyclic)).toThrow(/serialization/);
  });
  it("keeps schema count ceilings aligned with the approved code limits", () => {
    expect(documentSchema.properties.workflows.maxProperties).toBe(WORKFLOW_LIMITS.workflows);
    expect(documentSchema.properties.stages.maxProperties).toBe(WORKFLOW_LIMITS.stages);
    expect(documentSchema.properties.handoffs.maxProperties).toBe(WORKFLOW_LIMITS.handoffs);
    expect(documentSchema.properties.review_receipts.maxProperties).toBe(WORKFLOW_LIMITS.reviewReceipts);
    expect(documentSchema.properties.events.maxItems).toBe(WORKFLOW_LIMITS.events);
  });
  it("does not accept prototype-provided fields or omitted evidence bindings", () => {
    expect(() => assertWorkflowRecord(Object.create(workflow()))).toThrow();
    const missing = receipt() as unknown as { candidate: Record<string, unknown> }; delete missing.candidate.testing_evidence_fingerprint;
    expect(() => assertReviewReceipt(missing)).toThrow();
    expect(() => assertReviewReceipt({ ...receipt(), candidate: { ...candidate(), content_fingerprint: null } })).toThrow();
    expect(() => assertRoleHandoff({ ...handoff(), evidence_ids: ["../invented-evidence"] })).toThrow();
  });
  it("cannot smuggle write stages or disabled correction into an otherwise read-only grant", () => {
    const readOnly = grant(); readOnly.template_id = "analysis"; readOnly.role_assignments = [readOnly.role_assignments[0]!];
    expect(() => assertWorkflowGrant(readOnly)).toThrow(/write stages/);
    expect(() => assertWorkflowGrant({ ...grant(), permitted_stage_kinds: ["planning", "implementation", "correction"] })).toThrow(/Disabled correction/);
    expect(() => assertWorkflowStage({ ...stage(), kind: "review", role_id: "reviewer", agent_id: "reality-reviewer" })).toThrow(/candidate binding/);
  });
  it.each([{ max_tasks: 4 }, { max_attempts: 5 }, { max_runtime_ms: 300001 }, { max_total_tokens: 40001 }])("rejects unsafe correction subbudget %j", (change) => {
    expect(() => assertWorkflowPolicy({ ...policy(), correction_budget: { ...correctionBudget(), ...change } })).toThrow();
  });
  it("does not turn stopped or uncertain accounting into terminal success", () => {
    const unknown = workflow(); unknown.counters.accounting_complete = false;
    expect(() => assertWorkflowRecord({ ...unknown, status: "completed", completed_at: at, stop_requested_at: at })).toThrow(/cannot claim completion/);
    expect(() => assertWorkflowRecord({ ...workflow(), status: "completed", completed_at: at, stop_requested_at: at })).toThrow(/cannot claim completion/);
    expect(() => assertWorkflowRecord({ ...workflow(), status: "cancelled", completed_at: at })).toThrow(/durable stop/);
    expect(() => assertWorkflowRecord({ ...workflow(), status: "cancelled", completed_at: at, stop_requested_at: at })).not.toThrow();
    expect(() => assertWorkflowRecord({ ...workflow(), status: "completed", completed_at: at })).not.toThrow();
  });
  it("requires output evidence before a role stage can claim completion", () => {
    expect(() => assertWorkflowStage({ ...stage(), status: "completed", execution_id: "plan-run-1" })).toThrow(/output evidence/);
    expect(() => assertWorkflowStage({ ...stage(), status: "completed", execution_id: "plan-run-1", output: output(), output_fingerprint: hash })).not.toThrow();
    expect(() => assertWorkflowStage({ ...stage(), status: "completed", execution_id: "plan-run-1", output: { ...output(), status: "blocked" }, output_fingerprint: hash })).toThrow(/output evidence/);
  });
});
