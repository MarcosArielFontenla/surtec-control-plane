import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../context/types";
import { PolicyService } from "../policy/service";
import { resolveWorkflowReviewPolicy } from "./review-policy";
import { resolveWorkflowAssignments, resolveWorkflowTemplate, type TemplateSelection } from "./templates";
import { WORKFLOW_TEMPLATES, type WorkflowRoleId, type WorkflowTemplateId } from "./types";

function selection(template: WorkflowTemplateId = "implementation", qa = false, correction = false): TemplateSelection {
  return { template_id: template, template_version: 1, work_scale: "trivial", correction_enabled: correction,
    review_policy: resolveWorkflowReviewPolicy({ template_id: template, work_scale: "trivial", criticality: "low", classification: { affected_domains: ["api"], requires_migration: false, security_impact: false },
      change_categories: ["code"], behavior_change: true, critical_client_operations: false, trusted_qa_required: qa,
      floors: { roles: [{ role_id: "reviewer", depth: "focused" }], testing: "focused", routing: "focused", project: null, harness: null, workflow: "focused" } }) };
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-workflow-template-")); roots.push(root);
  mkdirSync(join(root, "registry"));
  for (const file of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) copyFileSync(join("registry", file), join(root, "registry", file));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); copyFileSync(path, join(root, path));
  }
  mkdirSync(join(root, "projects", "synthetic", ".git"), { recursive: true });
  writeFileSync(join(root, "registry/projects.yml"), "projects:\n  synthetic:\n    allowed_agents: [tech-lead, backend-engineer, product-manager, reality-checker, qa-reviewer, devops-engineer]\n    sandbox: { default: workspace-write }\n    verify: [node verify.mjs]\n");
  const policy = new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: join(root, "projects") } });
  return { root, policy };
}
const allAgents: Record<WorkflowRoleId, string> = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
function mapping(input: TemplateSelection) {
  const plan = resolveWorkflowTemplate(input);
  return Object.fromEntries([...plan.stages, ...plan.correction_stages].map((stage) => [stage.role_id, allAgents[stage.role_id]]));
}

describe("five code-owned workflow templates", () => {
  it.each([
    ["analysis", ["analysis"], "proposal-acknowledgement"], ["implementation", ["planning", "implementation", "review"], "candidate-acceptance"],
    ["quality-review", ["review", "qa"], "candidate-acceptance"], ["operations-investigation", ["operations"], "proposal-acknowledgement"],
    ["trivial-change", ["implementation", "review"], "candidate-acceptance"],
  ] as const)("constructs only the finite %s sequence with root/final human boundaries", (template, kinds, final) => {
    const plan = resolveWorkflowTemplate(selection(template));
    expect(plan.stages.map((stage) => stage.kind)).toEqual(kinds); expect(plan.root_human_gate).toBe("workflow-approval");
    expect(plan.final_human_gate).toBe(final); expect(plan.correction_stages).toEqual([]); expect(plan.max_model_tasks).toBe(kinds.length);
    expect(plan.stages.filter((stage) => stage.sandbox === "workspace-write").map((stage) => stage.role_id)).toEqual(kinds.includes("implementation" as never) ? ["software-engineer"] : []);
  });
  it("supports only the two analysis roles and never invents a human handoff role", () => {
    expect(resolveWorkflowTemplate({ ...selection("analysis"), analysis_role: "planner" }).stages[0]).toMatchObject({ kind: "analysis", role_id: "planner", sandbox: "read-only", requires_candidate: false });
    const input = { ...selection("analysis"), analysis_role: "software-engineer" as never };
    expect(() => resolveWorkflowTemplate(input)).toThrow(/analysis role/);
    expect(() => resolveWorkflowTemplate({ ...selection(), analysis_role: "planner" })).toThrow(/analysis role/);
  });
  it("omits Planner for trivial changes, not current scope authorization, testing or review gates", () => {
    const full = resolveWorkflowTemplate(selection("trivial-change", true));
    expect(full.stages.map((stage) => stage.kind)).toEqual(["implementation", "review", "qa"]);
    expect(full.stages[0]).toMatchObject({ before_human_gates: ["scope-authorization"], captures_verification: true });
    expect(full.stages.slice(1).every((stage) => stage.requires_candidate && stage.requires_passed_verification && !stage.captures_verification && stage.sandbox === "read-only")).toBe(true);
    expect(resolveWorkflowTemplate(selection()).stages[1]!.before_human_gates).toEqual(["plan-approval", "scope-authorization"]);
    for (const scale of ["bounded", "substantial"] as const) expect(() => resolveWorkflowTemplate({ ...selection("trivial-change"), work_scale: scale })).toThrow(/trivial classification/);
  });
  it.each(["implementation", "trivial-change"] as const)("enumerates one conditional correction branch for %s without adding verification turns", (template) => {
    const plan = resolveWorkflowTemplate(selection(template, true, true));
    expect(plan.correction_stages.map((stage) => stage.kind)).toEqual(["correction", "review", "qa"]);
    expect(plan.correction_stages[0]).toMatchObject({ requires_candidate: true, requires_passed_verification: true, captures_verification: true });
    expect(plan.max_model_tasks).toBe(template === "implementation" ? 7 : 6);
  });
  it.each(["analysis", "quality-review", "operations-investigation"] as const)("never grants correction writes to %s", (template) => {
    expect(() => resolveWorkflowTemplate(selection(template, true, true))).toThrow(/cannot automate correction/);
    expect(resolveWorkflowTemplate(selection(template, true)).stages.every((stage) => stage.sandbox === "read-only")).toBe(true);
  });
  it("does not create candidate QA stages for single-role advisory templates", () => {
    for (const template of ["analysis", "operations-investigation"] as const) expect(resolveWorkflowTemplate(selection(template, true)).stages).toHaveLength(1);
  });
  it.each(["version", "template", "graph", "role-stages", "inherited", "correction-type", "review-tamper"])("rejects unreviewed template data %s", (failure) => {
    const input = selection();
    if (failure === "version") input.template_version = 2 as never;
    if (failure === "template") input.template_id = "constructor" as never;
    if (failure === "graph") Object.assign(input, { transitions: ["push"] });
    if (failure === "role-stages") Object.assign(input, { stages: [{ role_id: "software-engineer" }] });
    if (failure === "correction-type") input.correction_enabled = "false" as never;
    if (failure === "review-tamper") input.review_policy.effective_depth = "full";
    expect(() => resolveWorkflowTemplate(failure === "inherited" ? Object.create(input) : input)).toThrow();
  });
  it("returns isolated plans rather than sharing mutable template stages or gates", () => {
    const first = resolveWorkflowTemplate(selection()); first.stages[1]!.before_human_gates.length = 0; first.stages.length = 0;
    const next = resolveWorkflowTemplate(selection()); expect(next.stages).toHaveLength(3); expect(next.stages[1]!.before_human_gates).toHaveLength(2);
  });
  it.each(WORKFLOW_TEMPLATES)("intersects %s with actual project/role/adapter policy and leaves consent empty", (template) => {
    const { policy } = fixture(), input = selection(template), before = policy.project("synthetic").allowed_agents;
    const assignments = resolveWorkflowAssignments(input, { policy, project_id: "synthetic", selected_agents: mapping(input), authorized_engineer_id: "backend-engineer" });
    expect(assignments.every((role) => role.client_context_categories.length === 0)).toBe(true);
    expect(policy.project("synthetic").allowed_agents).toEqual(before);
    if (assignments.length > 1) { assignments[0]!.client_context_categories.push("client-identity"); expect(assignments[1]!.client_context_categories).toEqual([]); }
  });
  it.each(["missing", "extra", "inherited", "substitute", "unregistered", "project-denied", "role-denied", "write-denied", "verification-denied", "handoff-denied"])("blocks role selection without fallback or effects: %s", (failure) => {
    const { root, policy } = fixture(), input = selection(), agents = mapping(input);
    if (failure === "missing") delete agents.reviewer;
    if (failure === "extra") agents["qa-evaluator"] = "qa-reviewer";
    if (failure === "substitute") agents["software-engineer"] = "tech-lead";
    if (failure === "unregistered") agents.reviewer = "unknown";
    if (failure === "project-denied") agents.reviewer = "security-reviewer";
    if (failure === "role-denied") agents.reviewer = "backend-engineer";
    if (failure === "write-denied") writeFileSync(join(root, "registry/projects.yml"), "projects:\n  synthetic:\n    allowed_agents: [tech-lead, backend-engineer, reality-checker]\n    sandbox: { default: read-only }\n    verify: [node verify.mjs]\n");
    if (failure === "verification-denied") writeFileSync(join(root, "registry/projects.yml"), "projects:\n  synthetic:\n    allowed_agents: [tech-lead, backend-engineer, reality-checker]\n    sandbox: { default: workspace-write }\n");
    if (failure === "handoff-denied") {
      const roles = parse(readFileSync(join(root, "registry/agent-roles.yml"), "utf8")) as AgentRoleRegistry;
      roles.roles.find((role) => role.id === "reviewer")!.handoff_contract_ids = []; writeFileSync(join(root, "registry/agent-roles.yml"), JSON.stringify(roles));
    }
    const authorize = vi.spyOn(policy, "authorizeRole");
    expect(() => resolveWorkflowAssignments(input, { policy, project_id: "synthetic", selected_agents: failure === "inherited" ? Object.create(agents) : agents, authorized_engineer_id: "backend-engineer" })).toThrow();
    if (["missing", "extra", "inherited"].includes(failure)) expect(authorize).not.toHaveBeenCalled();
  });
});
