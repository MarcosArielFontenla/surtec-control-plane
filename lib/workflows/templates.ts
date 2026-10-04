import { ROLE_HANDOFF_CONTRACT_ID } from "../policy/roles";
import type { PolicyService } from "../policy/service";
import { WORK_SCALES, type WorkScale } from "../organization/issue-lifecycle";
import { assertResolvedWorkflowReviewPolicy } from "./review-policy";
import { WORKFLOW_TEMPLATES, type WorkflowReviewPolicy, type WorkflowRoleAssignment, type WorkflowRoleId, type WorkflowStageKind, type WorkflowTemplateId } from "./types";
import { WorkflowContractError } from "./validation";

export interface TemplateStage {
  kind: WorkflowStageKind;
  role_id: WorkflowRoleId;
  sandbox: "read-only" | "workspace-write";
  before_human_gates: ("plan-approval" | "scope-authorization")[];
  requires_candidate: boolean;
  requires_passed_verification: boolean;
  captures_verification: boolean;
}
export interface WorkflowTemplatePlan {
  template_id: WorkflowTemplateId;
  template_version: 1;
  root_human_gate: "workflow-approval";
  stages: TemplateStage[];
  // Conditional branch only; the controller must prove correction eligibility
  // and durably consume its lineage allowance before admission (T008/T010).
  correction_stages: TemplateStage[];
  final_human_gate: "candidate-acceptance" | "proposal-acknowledgement";
  max_model_tasks: number;
}
export interface TemplateSelection {
  template_id: WorkflowTemplateId;
  template_version: 1;
  work_scale: WorkScale;
  analysis_role?: "portfolio-analyst" | "planner";
  correction_enabled: boolean;
  review_policy: WorkflowReviewPolicy;
}
function stage(kind: WorkflowStageKind, role: WorkflowRoleId): TemplateStage {
  const writer = kind === "implementation" || kind === "correction";
  const review = kind === "review" || kind === "qa";
  return { kind, role_id: role, sandbox: writer ? "workspace-write" : "read-only", before_human_gates: [],
    requires_candidate: review || kind === "correction", requires_passed_verification: review || kind === "correction", captures_verification: writer };
}
export function resolveWorkflowTemplate(input: TemplateSelection): WorkflowTemplatePlan {
  if (!input || Object.keys(input).some((key) => !["template_id", "template_version", "work_scale", "analysis_role", "correction_enabled", "review_policy"].includes(key))
    || !Object.hasOwn(input, "template_id") || !Object.hasOwn(input, "template_version") || !Object.hasOwn(input, "work_scale")
    || !Object.hasOwn(input, "correction_enabled") || !Object.hasOwn(input, "review_policy")
    || !WORKFLOW_TEMPLATES.includes(input.template_id) || input.template_version !== 1 || !WORK_SCALES.includes(input.work_scale)
    || typeof input.correction_enabled !== "boolean") throw new WorkflowContractError("Invalid or unsupported workflow template selection");
  assertResolvedWorkflowReviewPolicy(input.review_policy);
  const writes = input.template_id === "implementation" || input.template_id === "trivial-change";
  if (input.correction_enabled && !writes) throw new WorkflowContractError("Read-only templates cannot automate correction");
  if (input.analysis_role !== undefined && (input.template_id !== "analysis" || !["portfolio-analyst", "planner"].includes(input.analysis_role))) throw new WorkflowContractError("Invalid analysis role selection");
  if (input.template_id === "trivial-change" && input.work_scale !== "trivial") throw new WorkflowContractError("Trivial-change requires trusted trivial classification");
  const reviews = () => [stage("review", "reviewer"), ...(input.review_policy.qa_required || input.template_id === "quality-review" ? [stage("qa", "qa-evaluator")] : [])];
  let stages: TemplateStage[];
  switch (input.template_id) {
    case "analysis": stages = [stage("analysis", input.analysis_role ?? "portfolio-analyst")]; break;
    case "operations-investigation": stages = [stage("operations", "operations-observer")]; break;
    case "quality-review": stages = reviews(); break;
    case "implementation": {
      const engineer = stage("implementation", "software-engineer"); engineer.before_human_gates = ["plan-approval", "scope-authorization"];
      stages = [stage("planning", "planner"), engineer, ...reviews()]; break;
    }
    case "trivial-change": {
      const engineer = stage("implementation", "software-engineer"); engineer.before_human_gates = ["scope-authorization"];
      stages = [engineer, ...reviews()]; break;
    }
  }
  // Single-role advisory templates do not fabricate a candidate, QA turn or
  // handoff to a human role. Their full-risk diagnostics still remain visible.
  const correctionStages = input.correction_enabled ? [stage("correction", "software-engineer"), ...reviews()] : [];
  return { template_id: input.template_id, template_version: 1, root_human_gate: "workflow-approval", stages, correction_stages: correctionStages,
    final_human_gate: writes || input.template_id === "quality-review" ? "candidate-acceptance" : "proposal-acknowledgement",
    max_model_tasks: stages.length + correctionStages.length };
}

export function resolveWorkflowAssignments(selection: TemplateSelection, input: {
  policy: Pick<PolicyService, "authorizeRole">;
  project_id: string;
  selected_agents: Partial<Record<WorkflowRoleId, string>>;
  authorized_engineer_id: string | null;
}): WorkflowRoleAssignment[] {
  const plan = resolveWorkflowTemplate(selection);
  const stages = [...plan.stages, ...plan.correction_stages];
  const roles = [...new Set(stages.map((entry) => entry.role_id))];
  if (!input.selected_agents || Object.keys(input.selected_agents).length !== roles.length
    || Object.keys(input.selected_agents).some((id) => !roles.includes(id as WorkflowRoleId))) throw new WorkflowContractError("Exact template role assignments are required");
  return roles.map((id) => {
    const selected = Object.hasOwn(input.selected_agents, id) ? input.selected_agents[id] : undefined;
    if (!selected) throw new WorkflowContractError("Required workflow role has no selected registered agent");
    const current = stages.find((entry) => entry.role_id === id)!;
    if (id === "software-engineer" && selected !== input.authorized_engineer_id) throw new WorkflowContractError("Workflow cannot replace the issue's authorized engineer");
    const resolved = input.policy.authorizeRole({ project: input.project_id, agent: selected, roleId: id,
      taskKind: current.sandbox === "workspace-write" ? "implementation" : "analysis", sandbox: current.sandbox, selfVerify: current.captures_verification });
    if (resolved.role.id !== id || resolved.agent.id !== selected || !resolved.role.handoff_contract_ids.includes(ROLE_HANDOFF_CONTRACT_ID)) throw new WorkflowContractError("Role lacks the supported workflow handoff contract");
    // Consent is explicit and per-role in the later issued-preview boundary;
    // neither selecting a role nor sharing an adapter inherits any categories.
    return { role_id: id, agent_id: selected, sandbox: current.sandbox, client_context_categories: [] };
  });
}
