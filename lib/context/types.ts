import type { SandboxMode } from "../state/types";
import type { WorkScale } from "../organization/issue-lifecycle";
import type { GovernedWorkflow, WorkflowCandidateBinding, WorkflowRoleId, WorkflowStageKind, WorkflowTemplateId } from "../workflows/types";

/** Persisted references only. Shape validity never grants workflow execution. */
export interface ContextAdmissionV2 {
  schema_version: 2;
  kind: "workflow-stage";
  workflow_id: string;
  stage_id: string;
  stage_generation: number;
  stage_kind: WorkflowStageKind;
  task_id: string;
  template_id: WorkflowTemplateId;
  template_version: 1;
  grant_id: string;
  authority_revision: number;
  role_id: WorkflowRoleId;
  issue_id: string;
  issue_revision: number;
  scope_revision: number;
  scope_fingerprint: string;
  approved_plan: GovernedWorkflow["approved_plan"];
  predecessor_stage_id: string | null;
  handoff_id: string | null;
  candidate: WorkflowCandidateBinding | null;
  manifest_fingerprint: string;
  instructions_length: number;
  instructions_hash: string;
  // V1-only implementation status is deliberately unavailable to v2 callers.
  issue_status?: never;
}

export const CONTEXT_LAYERS = ["runtime-safety", "company", "objective", "project", "issue", "harness-routing", "instructions", "role", "execution-policy", "resume"] as const;
export type ContextLayer = typeof CONTEXT_LAYERS[number];
export type ToolCapability = "inspect" | "edit-authorized-scope" | "verify-configured";
export type ReviewDepth = "focused" | "full";
export interface ExecutionBudget { max_attempts: number; max_runtime_ms: number; max_total_tokens: number }
export interface ContextLimits { max_lines: number; max_bytes: number; max_sources: number }
export interface AgentRole {
  schema_version: 1;
  id: string;
  display_name: string;
  responsibility: string;
  agent_ids: string[];
  allowed_task_kinds: string[];
  sandbox_ceiling: SandboxMode;
  required_skill_ids: string[];
  required_evaluation_ids: string[];
  allowed_tool_capabilities: ToolCapability[];
  approval_rules: string[];
  default_budget_policy_id: string;
  handoff_contract_ids: string[];
  minimum_review_depth: ReviewDepth;
}
export interface AgentRoleRegistry { schema_version: 1; roles: AgentRole[] }
export interface TestingConstraint {
  mode: "functional" | "strict-tdd";
  minimum_review_depth: ReviewDepth;
  runner_ids: string[];
}
export interface AssertionProbe { sources: { path: string; sha256: string }[]; assertion_ids: string[] }
export interface ContextRunner { command: string; stage: "functional" | "red" | "green" | "refactor"; probe?: AssertionProbe }
export interface TestingPlan { mode: "functional" | "strict-tdd"; runners: ContextRunner[]; noRefactorJustification?: string }
export interface ContextRoute { id: string; role_ids: string[]; task_kinds: string[]; affected_domains: string[]; paths: string[]; required: boolean }
export interface ContextConfig {
  schema_version: 1;
  limits: ContextLimits;
  budgets: Record<string, ExecutionBudget>;
  routes: ContextRoute[];
  runners: Record<string, ContextRunner>;
  testing: { global: TestingConstraint; archetypes: Record<string, TestingConstraint>; projects: Record<string, TestingConstraint>; issues: Record<string, TestingConstraint>; roles: Record<string, TestingConstraint>; no_refactor_justification?: string };
}
export interface EffectiveTestingPolicy extends TestingConstraint { commands: string[]; reasons: string[]; requires_red_evidence: boolean }
export interface RoutingDecision {
  work_scale: WorkScale;
  action: "direct" | "planning" | "review" | "qa" | "needs-decision";
  review_depth: ReviewDepth;
  qa_required: boolean;
  reasons: string[];
  delegation: { admitted: boolean; executable: false; reasons: string[] };
}
export interface ContextSourceEntry {
  id: string;
  layer: ContextLayer;
  source_type: "policy" | "record" | "instruction" | "skill" | "decision" | "summary";
  revision: string;
  reason: string;
  bytes: number;
  lines: number;
  sensitivity: "public" | "local" | "client-selected";
}
export interface ContextManifest {
  schema_version: 1;
  fingerprint: string;
  project_id: string;
  role_id: string;
  agent_id: string;
  task_kind: string;
  sandbox: SandboxMode;
  tools: ToolCapability[];
  approval_rules: string[];
  budget: ExecutionBudget;
  limits: ContextLimits;
  sources: ContextSourceEntry[];
  excluded_categories: string[];
  selected_categories: string[];
  omitted_sources: string[];
  total_bytes: number;
  total_lines: number;
  routing: RoutingDecision;
  testing: EffectiveTestingPolicy;
}
