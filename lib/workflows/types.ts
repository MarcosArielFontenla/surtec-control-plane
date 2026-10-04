import type { ClientContextCategory } from "../client-portfolio";
import type { AuthorizedScope } from "../issues/types";
import type { WorkScale } from "../organization/issue-lifecycle";
import type { SandboxMode } from "../state/types";

export const WORKFLOW_TEMPLATES = ["analysis", "implementation", "quality-review", "operations-investigation", "trivial-change"] as const;
export const WORKFLOW_ROLES = ["portfolio-analyst", "planner", "software-engineer", "reviewer", "qa-evaluator", "operations-observer"] as const;
export const WORKFLOW_LIMITS = Object.freeze({ workflows: 500, stages: 10_000, handoffs: 5_000, reviewReceipts: 5_000, events: 20_000, documentBytes: 16 * 1024 * 1024, outputBytes: 32 * 1024 });
export type WorkflowTemplateId = typeof WORKFLOW_TEMPLATES[number];
export type WorkflowRoleId = typeof WORKFLOW_ROLES[number];
export type WorkflowStatus = "running" | "waiting-human" | "needs-decision" | "completed" | "cancelled";
export type WorkflowStageKind = "analysis" | "planning" | "implementation" | "review" | "qa" | "operations" | "correction";
export type WorkflowStageStatus = "pending" | "reserved" | "queued" | "running" | "completed" | "needs-review" | "failed" | "cancelled";
export type WorkflowReviewDepth = "passive" | "focused" | "full";
export type WorkflowVerdict = "approve" | "correction-required" | "inconclusive";

export interface WorkflowBudget {
  max_tasks: number;
  max_attempts: number;
  max_runtime_ms: number;
  max_total_tokens: number;
}
export interface WorkflowCounters { tasks: number; attempts: number; runtime_ms: number; total_tokens: number; accounting_complete: boolean }
export interface WorkflowCorrection { enabled: boolean; max_corrections: 0 | 1; budget: WorkflowBudget | null }
export interface WorkflowRoleAssignment { role_id: WorkflowRoleId; agent_id: string; sandbox: SandboxMode; client_context_categories: ClientContextCategory[] }
export interface WorkflowReviewPolicy {
  intrinsic_depth: WorkflowReviewDepth;
  minimum_depth: "focused" | "full";
  effective_depth: "focused" | "full";
  qa_required: boolean;
  reasons: string[];
  fingerprint: string;
}
export interface WorkflowCandidateBinding {
  candidate_id: string;
  issue_id: string;
  repository_id: string;
  task_id: string;
  execution_id: string;
  scope_revision: number;
  base_revision: string;
  candidate_revision: string;
  changed_paths: string[];
  diff_fingerprint: string;
  content_fingerprint: string;
  testing_evidence_fingerprint: string;
}
export interface WorkflowGrant {
  schema_version: 1;
  id: string;
  workflow_id: string;
  project_id: string;
  issue_id: string;
  issue_revision: number;
  scope_revision: number;
  authority_revision: number;
  template_id: WorkflowTemplateId;
  template_version: 1;
  authorized_scope: AuthorizedScope;
  role_assignments: WorkflowRoleAssignment[];
  permitted_stage_kinds: WorkflowStageKind[];
  source_fingerprints: { id: string; fingerprint: string }[];
  policy_fingerprint: string;
  preview_fingerprint: string;
  testing_policy_fingerprint: string;
  minimum_review_depth: "focused" | "full";
  testing_mode: "functional" | "strict-tdd";
  budget: WorkflowBudget;
  correction: WorkflowCorrection;
  approved_by: "human";
  approval_id: string;
  approved_at: string;
}
export interface GovernedWorkflow {
  schema_version: 1;
  id: string;
  revision: number;
  project_id: string;
  issue_id: string;
  scope_revision: number;
  template_id: WorkflowTemplateId;
  template_version: 1;
  status: WorkflowStatus;
  work_scale: WorkScale;
  current_grant_id: string;
  authority_revision: number;
  stage_ids: string[];
  current_stage_id: string | null;
  pending_decision_id: string | null;
  lineage_id: string | null;
  candidate: WorkflowCandidateBinding | null;
  approved_plan: { stage_id: string; output_fingerprint: string; decision_id: string } | null;
  review_policy: WorkflowReviewPolicy | null;
  budget: WorkflowBudget;
  counters: WorkflowCounters;
  blocked_reason: string | null;
  recovery_state: "none" | "reconciling" | "awaiting-human";
  next_action: string;
  stop_requested_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface WorkflowStage {
  schema_version: 1;
  id: string;
  workflow_id: string;
  grant_id: string;
  authority_revision: number;
  generation: number;
  ordinal: number;
  kind: WorkflowStageKind;
  role_id: WorkflowRoleId;
  agent_id: string;
  sandbox: SandboxMode;
  status: WorkflowStageStatus;
  phase: "execution" | "verification";
  task_id: string | null;
  execution_id: string | null;
  predecessor_stage_id: string | null;
  supersedes_stage_id: string | null;
  handoff_id: string | null;
  output: WorkflowRoleOutput | null;
  output_fingerprint: string | null;
  candidate: WorkflowCandidateBinding | null;
  context_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}
export interface RoleHandoff {
  schema_version: 1;
  id: string;
  issue_id: string;
  from_role_id: WorkflowRoleId;
  to_role_id: WorkflowRoleId;
  execution_id: string;
  outcome_summary: string;
  evidence_ids: string[];
  unresolved_questions: string[];
  risks: string[];
  recommended_next_action: string;
  requested_decision: string | null;
  created_at: string;
}
export interface WorkflowFinding {
  id: string;
  severity: "advisory" | "blocking";
  summary: string;
  path: string | null;
  evidence_ids: string[];
  scope_change_required: boolean;
}
export interface WorkflowOutputBase {
  schema_version: 1;
  status: "completed" | "blocked" | "needs-review" | "failed";
  summary: string;
  evidence_ids: string[];
  unresolved_questions: string[];
  risks: string[];
  recommended_next_action: string;
  requested_decision: string | null;
}
export type WorkflowRoleOutput = WorkflowOutputBase & (
  | { kind: "plan"; plan: string[]; scope_change_required: boolean }
  | { kind: "analysis"; recommendations: string[] }
  | { kind: "operations"; proposed_issue: { title: string; expected_outcome: string; acceptance_criteria: string[]; plan: string[]; allowed_path_patterns: string[]; next_action: string } | null }
  | { kind: "review"; verdict: WorkflowVerdict; findings: WorkflowFinding[] }
  | { kind: "qa"; verdict: WorkflowVerdict; findings: WorkflowFinding[]; criteria: { criterion: string; status: "supported" | "missing" | "contradictory"; evidence_ids: string[] }[] }
);
export interface ReviewReceipt {
  schema_version: 1;
  id: string;
  workflow_id: string;
  stage_id: string;
  task_id: string;
  execution_id: string;
  role_id: "reviewer" | "qa-evaluator";
  agent_id: string;
  issue_id: string;
  scope_revision: number;
  candidate: WorkflowCandidateBinding;
  grant_id: string;
  authority_revision: number;
  context_fingerprint: string;
  review_policy_fingerprint: string;
  output_fingerprint: string;
  verdict: WorkflowVerdict;
  findings: WorkflowFinding[];
  created_at: string;
  fingerprint: string;
}
export interface WorkflowDecision {
  schema_version: 1;
  id: string;
  workflow_id: string;
  kind: "plan-approval" | "scope-authorization" | "candidate-acceptance" | "risk-acknowledgement" | "recovery" | "replacement" | "proposal-acknowledgement";
  status: "pending" | "approved" | "rejected";
  expected_workflow_revision: number;
  expected_issue_revision: number;
  resource_fingerprint: string;
  candidate_id: string | null;
  review_receipt_ids: string[];
  summary: string;
  approval_id: string | null;
  decided_by: "human" | null;
  rationale: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface WorkflowAdmissionIntent {
  schema_version: 1;
  id: string;
  workflow_id: string;
  stage_id: string;
  grant_id: string;
  authority_revision: number;
  task_id: string;
  status: "reserved" | "committed" | "blocked" | "cancelled";
  expected_issue_revision: number;
  expected_workflow_revision: number;
  context_fingerprint: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface WorkflowRunAccounting {
  schema_version: 1;
  id: string;
  workflow_id: string;
  stage_id: string;
  task_id: string;
  execution_id: string;
  attempt: number;
  attempt_charged: true;
  active_runtime_ms: number;
  observed_tokens: number;
  usage_complete: boolean;
  captured_at: string;
}
export interface WorkflowCandidateLineage {
  schema_version: 1;
  id: string;
  project_id: string;
  issue_id: string;
  scope_revision: number;
  origin_task_id: string;
  workflow_ids: string[];
  candidate_ids: string[];
  correction_limit: 0 | 1;
  corrections_consumed: 0 | 1;
  consumed_stage_id: string | null;
  consumed_at: string | null;
}
export interface WorkflowEvent {
  schema_version: 1;
  id: string;
  workflow_id: string;
  stage_id: string | null;
  execution_id: string | null;
  revision: number;
  type: "created" | "grant-approved" | "stage-reserved" | "stage-admitted" | "stage-started" | "stage-finished" | "handoff-sealed" | "review-sealed" | "decision-requested" | "decision-resolved" | "correction-consumed" | "budget-stopped" | "recovery-required" | "reconciled" | "cancel-requested" | "cancelled" | "completed";
  summary: string;
  at: string;
}
export interface WorkflowDocument {
  schema_version: 1;
  workflows: Record<string, GovernedWorkflow>;
  stages: Record<string, WorkflowStage>;
  grants: Record<string, WorkflowGrant>;
  decisions: Record<string, WorkflowDecision>;
  handoffs: Record<string, RoleHandoff>;
  review_receipts: Record<string, ReviewReceipt>;
  admission_intents: Record<string, WorkflowAdmissionIntent>;
  accounting: Record<string, WorkflowRunAccounting>;
  lineages: Record<string, WorkflowCandidateLineage>;
  events: WorkflowEvent[];
}
export interface WorkflowPolicy {
  schema_version: 1;
  default_budget: WorkflowBudget;
  correction_budget: WorkflowBudget;
  automated_correction_default: false;
  minimum_review_depth: "focused" | "full";
  qa_on_full: true;
  protected_path_patterns: string[];
}
