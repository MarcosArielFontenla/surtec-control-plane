// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { ContextManifest } from "../../../../lib/context/types";
import type { WorkflowRoleId, WorkflowRoleOutput } from "../../../../lib/workflows/types";
import type { ClientContextCategory } from "../../../../lib/client-portfolio";
import { BUDGET_DIMENSIONS, type BudgetAmounts } from "../../../../lib/budgets/types";
import type { BudgetPreview } from "../../server/budget-service";
import * as api from "../api";
import { WorkflowPanel } from "./WorkflowPanel";

const hash = "a".repeat(64), at = "2026-10-04T12:00:00Z";
const budget = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
const issue: WorkIssue = {
  schema_version: 1, id: "I-1", project_id: "alpha", objective_id: null, parent_issue_id: null, title: "Synthetic bounded work", expected_outcome: "Inspect evidence", acceptance_criteria: ["Evidence retained"], status: "authorized", work_scale: "trivial",
  classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false }, classification_rationale: ["Narrow synthetic work"], plan: [],
  authorized_scope: { expected_outcome: "Inspect evidence", acceptance_criteria: ["Evidence retained"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] },
  scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 50, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: "backend-engineer", related_commitment_ids: [], external_references: [], next_action: null,
  task_ids: [], evidence_ids: [], candidate_ids: [], created_at: at, updated_at: at, revision: 3,
};
const lineage = (): IssueLineage => ({ issue: structuredClone(issue), tasks: [], sessions: [], candidates: [], evidence: [], evidence_gaps: [] });
const reviewPolicy = { intrinsic_depth: "passive" as const, minimum_depth: "focused" as const, effective_depth: "focused" as const, qa_required: false, reasons: ["Trusted focused floor"], fingerprint: hash };
function manifest(role: WorkflowRoleId, agent: string): ContextManifest {
  return { schema_version: 1, fingerprint: hash, project_id: "alpha", role_id: role, agent_id: agent, task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: [], budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "focused", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } }, testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: [], requires_red_evidence: false } };
}
function preview(request: api.WorkflowPreviewRequest): api.WorkflowPreview {
  const role = Object.keys(request.selected_agents)[0] as WorkflowRoleId;
  const assignments = Object.entries(request.selected_agents).map(([role, agent]) => ({ role_id: role as WorkflowRoleId, agent_id: agent!, sandbox: "read-only" as const, client_context_categories: (request.client_context_categories[role as WorkflowRoleId] ?? []) as ClientContextCategory[] }));
  return { schema_version: 1, request, fingerprint: hash, issue_revision: request.expected_revision, issue_status: "authorized", scope_revision: 1, scope_fingerprint: hash,
    plan: { template_id: request.template_id, template_version: 1, root_human_gate: "workflow-approval", stages: [{ kind: "analysis", role_id: role, sandbox: "read-only", before_human_gates: [], requires_candidate: false, requires_passed_verification: false, captures_verification: false }], correction_stages: [], final_human_gate: "proposal-acknowledgement", max_model_tasks: 1 },
    role_assignments: assignments, review_policy: reviewPolicy, budget: request.budget!, correction: { enabled: false, max_corrections: 0, budget: null }, candidate: null, source_fingerprints: [], policy_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional",
    roles: assignments.map((entry) => ({ role_id: entry.role_id, manifest: { ...manifest(entry.role_id, entry.agent_id), selected_categories: entry.client_context_categories } })), allowed: true, blocked_reasons: [], runtime_read_limitation: "Runtime reads are not guaranteed project-only.", candidate_reference_limitation: "Live tree inspection is separate." };
}

function roleBudget(status: "available" | "exhausted" | "unavailable", sourceId: string): BudgetPreview {
  const caps: BudgetAmounts = { attempts: 1, runtime_ms: 60000, total_tokens: 10000, concurrent_reads: 1, concurrent_writes: 0,
    review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0 };
  const remaining = (dimension: typeof BUDGET_DIMENSIONS[number]) => status === "unavailable" ? null : status === "exhausted" && dimension === "total_tokens" ? 0 : caps[dimension];
  const denials: NonNullable<BudgetPreview["resolution"]>["denials"] = status === "available" ? [] : [{ code: status === "exhausted" ? "budget-exhausted" : "budget-accounting-unavailable", dimension: "total_tokens", source_ids: [sourceId] }];
  return { schema_version: 1, observed_at: at, status, can_admit: status === "available", executable: false, reserves_capacity: false,
    ledger: { status: "available", revision: 2, updated_at: at }, binding: { attribution: { company_id: "surtec", project_ids: ["alpha"], objective_ids: [], issue_id: "I-1", role_id: "portfolio-analyst", execution_id: "preview-only" }, cap_fingerprint: hash, policy_bindings: [], ceilings: caps },
    resolution: { cap_fingerprint: hash, policy_bindings: [], ceilings: caps, can_admit: status === "available", pricing: { status: "unavailable", reason: "no-versioned-source" }, denials,
      dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { ceiling: caps[dimension], remaining: remaining(dimension), status: status === "unavailable" ? "unavailable" : status === "exhausted" && dimension === "total_tokens" ? "exhausted" : "available", warning: false, limiting_sources: [sourceId] }])) as NonNullable<BudgetPreview["resolution"]>["dimensions"],
      sources: [{ id: sourceId, kind: "existing", period: "none", bucket: "none", revision: 1, fingerprint: hash,
        dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "configured", cap: caps[dimension], proven_consumed: status === "exhausted" && dimension === "total_tokens" ? caps[dimension] : 0,
          consumed: status === "unavailable" ? null : status === "exhausted" && dimension === "total_tokens" ? caps[dimension] : 0, reserved: 0, remaining: remaining(dimension), warning: false }])) as NonNullable<BudgetPreview["resolution"]>["sources"][number]["dimensions"] }] },
    prospective_hold: { ...caps }, denials, limitation: "Informational preview only; no capacity is reserved and no execution authority is granted." };
}

function unavailableProjectBudget(): api.BudgetReadView {
  return { schema_version: 1, observed_at: at, status: "unavailable", executable: false, reserves_capacity: false,
    ledger: { status: "unavailable", revision: null, updated_at: null }, policy: null, sources: [],
    pricing: { status: "unavailable", reason: "no-versioned-source" }, denials: [{ code: "budget-accounting-unavailable", source_ids: ["ledger:unavailable"] }] };
}
function detail(kind: "plan-approval" | "proposal-acknowledgement" | "candidate-acceptance" | "risk-acknowledgement" | "recovery" = "plan-approval"): api.WorkflowDetail {
  const output: WorkflowRoleOutput = { schema_version: 1, kind: "plan", status: "completed", summary: "Synthetic plan ready", evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Review exact plan", requested_decision: null, plan: ["Inspect bounded source", "Verify candidate"], scope_change_required: false };
  return { schema_version: 1, workflow: { schema_version: 1, id: "W-1", revision: 4, project_id: "alpha", issue_id: "I-1", scope_revision: 1, template_id: "implementation", template_version: 1, status: "waiting-human", work_scale: "trivial", current_grant_id: "G-1", authority_revision: 1, stage_ids: ["S-1"], current_stage_id: "S-1", pending_decision_id: "D-1", lineage_id: null, candidate: null, approved_plan: null, review_policy: reviewPolicy, budget, counters: { tasks: 1, attempts: 1, runtime_ms: 1200, total_tokens: 20, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Review the exact current decision", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null },
    grant: { schema_version: 1, id: "G-1", workflow_id: "W-1", project_id: "alpha", issue_id: "I-1", issue_revision: 3, scope_revision: 1, authority_revision: 1, template_id: "implementation", template_version: 1, role_assignments: [{ role_id: "planner", agent_id: "tech-lead", sandbox: "read-only", client_context_categories: [] }], permitted_stage_kinds: ["planning"], source_fingerprints: [], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional", budget, correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: "synthetic-only", approved_at: at },
    stages: [{ schema_version: 1, id: "S-1", workflow_id: "W-1", grant_id: "G-1", authority_revision: 1, generation: 1, ordinal: 1, kind: "planning", role_id: "planner", agent_id: "tech-lead", sandbox: "read-only", status: "completed", phase: "execution", task_id: "T-1", execution_id: "R-1", predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output, output_fingerprint: hash, candidate: null, context_fingerprint: hash, created_at: at, updated_at: at }],
    decisions: [{ schema_version: 1, id: "D-1", workflow_id: "W-1", kind, status: "pending", expected_workflow_revision: 4, expected_issue_revision: 3, resource_fingerprint: hash, candidate_id: null, review_receipt_ids: [], summary: "Review synthetic evidence", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null }],
    handoffs: [], review_receipts: [], admission_intents: [], accounting: [], lineage: null, events: [], execution_enabled: true, execution_boundary: "Human gates remain required.", runtime_read_limitation: "Runtime reads are not guaranteed project-only." };
}
function retain(value = detail(), facts = lineage()) {
  vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [value.workflow] }); vi.spyOn(api, "getWorkflow").mockResolvedValue(value); vi.mocked(api.getWorkIssue).mockResolvedValue(facts);
}
async function openPreview() { const button = await screen.findByRole("button", { name: "Previsualizar workflow" }); await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button); await screen.findByRole("region", { name: "Preview de workflow" }); }
async function acknowledge() { fireEvent.change(await screen.findByLabelText("Motivo de la decisión"), { target: { value: "Reviewed this exact synthetic evidence" } }); fireEvent.click(screen.getByRole("checkbox", { name: "Revisé esta decisión y sus bindings actuales" })); }

beforeEach(() => {
  vi.spyOn(api, "getWorkflows").mockResolvedValue({ workflows: [] }); vi.spyOn(api, "getWorkIssue").mockResolvedValue(lineage());
  vi.spyOn(api, "getContextRoles").mockResolvedValue({ roles: (["portfolio-analyst", "planner", "software-engineer", "reviewer", "qa-evaluator", "operations-observer"] as WorkflowRoleId[]).map((id) => ({ id, display_name: id, responsibility: "Synthetic registered role", sandbox_ceiling: id === "software-engineer" ? "workspace-write" : "read-only", agents: id === "software-engineer" ? ["backend-engineer", "tech-lead"] : ["tech-lead", "product-manager"] })) });
  vi.spyOn(api, "getClientContextOptions").mockResolvedValue({ available: true, categories: ["confidential-notes", "client-identity"] });
  vi.spyOn(api, "previewWorkflow").mockImplementation(async (request) => preview(request)); vi.spyOn(api, "startWorkflow").mockResolvedValue(detail());
  vi.spyOn(api, "decideWorkflow").mockResolvedValue(detail()); vi.spyOn(api, "controlWorkflow").mockResolvedValue(detail());
  vi.spyOn(api, "fetchBudgets").mockResolvedValue(unavailableProjectBudget());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WorkflowPanel", () => {
  it("separates recorded operating state, scope requirements and exact candidate evidence without invoking actions", async () => {
    retain(); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText("Necesita decisión")).toBeInTheDocument();
    expect(within(state).getByText("Sin etiqueta operativa · authorized")).toBeInTheDocument();
    expect(within(state).getByText(at)).toHaveAttribute("dateTime", at);
    const scope = screen.getByRole("region", { name: "Alcance, clasificación y requisitos del workflow" });
    expect(within(scope).getByText("trivial · low · ui")).toBeInTheDocument();
    expect(within(scope).getByText("backend-engineer")).toBeInTheDocument();
    expect(within(scope).getByText("Trusted focused floor")).toBeInTheDocument();
    expect(within(scope).getByText("functional · mínimo focused")).toBeInTheDocument();
    const candidate = screen.getByRole("region", { name: "Candidato exacto y corrección acotada del workflow" });
    expect(within(candidate).getByText("Sin candidato; no se infiere validez")).toBeInTheDocument();
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it.each([
    ["running", "planning", "Trabajando"], ["running", "review", "Verificando"], ["running", "qa", "Verificando"],
    ["waiting-human", "planning", "Necesita decisión"], ["needs-decision", "planning", "Necesita decisión"],
    ["completed", "planning", "Sin estado operativo activo"], ["cancelled", "planning", "Sin estado operativo activo"],
  ] as const)("presents %s/%s as %s without making the linked issue Done", async (status, kind, label) => {
    const value = detail(); value.workflow.status = status; value.stages[0]!.kind = kind;
    if (status !== "waiting-human") { value.workflow.pending_decision_id = null; value.decisions = []; }
    if (status === "completed" || status === "cancelled") value.workflow.current_stage_id = null;
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText(label)).toBeInTheDocument();
    expect(within(state).getByText(status)).toBeInTheDocument();
    expect(within(state).getByText("Sin etiqueta operativa · authorized")).toBeInTheDocument();
    expect(within(state).queryByText("Hecho · done")).toBeNull(); expect(api.decideWorkflow).not.toHaveBeenCalled();
    if (status === "completed") expect(within(state).getByText(/Workflow finalizado. No implica issue Hecho/)).toBeInTheDocument();
    if (status === "cancelled") expect(within(state).getByText(/Workflow cancelado; no se convierte en Hecho/)).toBeInTheDocument();
  });
  it.each(["implementation", "correction"] as const)("presents a running %s writer in verification phase as Checking, not Working", async (kind) => {
    const value = detail(); value.workflow.status = "running"; value.workflow.pending_decision_id = null; value.decisions = [];
    value.stages[0]!.kind = kind; value.stages[0]!.phase = "verification";
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText("Verificando")).toBeInTheDocument(); expect(within(state).queryByText("Trabajando")).toBeNull();
    expect(within(state).getByText("Sin etiqueta operativa · authorized")).toBeInTheDocument();
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it.each([
    ["working", "Trabajando"], ["checking", "Verificando"], ["needs-decision", "Necesita decisión"],
    ["ready-for-review", "Listo para revisión"], ["done", "Hecho"], ["blocked", "Bloqueado"],
    ["proposed", "Sin etiqueta operativa"], ["authorized", "Sin etiqueta operativa"], ["cancelled", "Sin etiqueta operativa"],
  ] as const)("keeps authoritative issue %s separate from workflow completion", async (status, label) => {
    const facts = lineage(); facts.issue.status = status;
    const value = detail(); value.workflow.status = "completed"; value.workflow.current_stage_id = null; value.workflow.pending_decision_id = null;
    retain(value, facts); render(<WorkflowPanel issue={facts.issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText(`${label} · ${status}`)).toBeInTheDocument();
    expect(within(state).getByText("Sin estado operativo activo")).toBeInTheDocument();
    expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it.each([
    ["plan-approval", "Aprobación del plan exacto"], ["scope-authorization", "Autorización de una revisión de alcance"],
    ["candidate-acceptance", "Aceptación humana del candidato exacto"], ["risk-acknowledgement", "Reconocimiento humano de riesgos registrados"],
    ["proposal-acknowledgement", "Revisión humana de la propuesta registrada"], ["recovery", "Revisión humana de recuperación"],
    ["replacement", "Revisión humana de reemplazo"],
  ] as const)("attributes the exact %s trigger without deriving authority from its label", async (kind, trigger) => {
    const value = detail(); value.decisions[0]!.kind = kind;
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText(`${trigger} · ${kind} · D-1`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled();
    expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("retains an exact recorded blocker without guessing a category from free text", async () => {
    const value = detail(); value.workflow.status = "needs-decision"; value.workflow.pending_decision_id = null;
    value.workflow.blocked_reason = "A mention of budget and policy is not a structured denial code";
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText(value.workflow.blocked_reason)).toBeInTheDocument();
    expect(within(state).getByText("Bloqueo registrado; sin categoría inferida a partir de su texto.")).toBeInTheDocument();
    expect(within(state).queryByText("budget-exhausted")).toBeNull(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it("reports an unsupported decision kind as an evidence gap while preserving the existing denied action", async () => {
    const value = detail(); value.decisions[0]!.kind = "future-decision" as never;
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText("Brecha de evidencia: tipo de decisión no reconocido; no se infiere un disparador.")).toBeInTheDocument();
    expect(within(state).queryByText(/undefined/)).toBeNull();
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled(); expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("reports unavailable pending decision evidence instead of inventing a trigger or acknowledgement", async () => {
    const value = detail(); value.decisions = [];
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText("Brecha de evidencia: falta la decisión pendiente o el motivo registrado.")).toBeInTheDocument();
    expect(within(state).getByText(/la referencia de decisión pendiente no tiene un registro/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar decisión exacta" })).toBeNull(); expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("does not resolve conflicting decision and blocker records into permission", async () => {
    const value = detail(); value.workflow.blocked_reason = "Retained independent blocker";
    value.decisions[0]!.expected_workflow_revision = 3;
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const state = await screen.findByRole("region", { name: "Estado operativo y disparador del workflow" });
    expect(within(state).getByText("Retained independent blocker")).toBeInTheDocument();
    expect(within(state).getByText(/La decisión y el bloqueo son hechos independientes/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Revisé esta decisión y sus bindings actuales" })).toBeDisabled();
    expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("exposes an unassigned role and changed scope without inventing a current grant", async () => {
    const facts = lineage(); facts.issue.scope_revision = 2; facts.issue.assigned_role_id = null;
    retain(detail(), facts); render(<WorkflowPanel issue={facts.issue} onChanged={async () => {}} />);
    const scope = await screen.findByRole("region", { name: "Alcance, clasificación y requisitos del workflow" });
    expect(within(scope).getByText("Sin asignación registrada; no se infiere un permiso")).toBeInTheDocument();
    expect(within(scope).getByText("r2 · Revisiones diferentes; no se infiere autorización actual")).toBeInTheDocument();
    expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it.each(["missing lineage", "missing consumed stage", "incomplete counters", "incomplete run", "missing run"])("leaves correction consumption unknown with %s", async (gap) => {
    const value = detail(); value.grant.correction = { enabled: true, max_corrections: 1, budget: { max_tasks: 3, max_attempts: 4, max_runtime_ms: 300000, max_total_tokens: 40000 } };
    value.lineage = { schema_version: 1, id: "L-1", project_id: "alpha", issue_id: "I-1", scope_revision: 1, origin_task_id: "T-1", workflow_ids: ["W-1"], candidate_ids: [], correction_limit: 1, corrections_consumed: 1, consumed_stage_id: "S-1", consumed_at: at };
    value.stages[0]!.kind = "correction";
    value.accounting = [{ schema_version: 1, id: "A-1", workflow_id: "W-1", stage_id: "S-1", task_id: "T-1", execution_id: "R-1", attempt: 1, attempt_charged: true, active_runtime_ms: 1200, observed_tokens: 20, usage_complete: true, captured_at: at }];
    if (gap === "missing lineage") value.lineage = null;
    if (gap === "missing consumed stage") value.stages[0]!.kind = "planning";
    if (gap === "incomplete counters") value.workflow.counters.accounting_complete = false;
    if (gap === "incomplete run") value.accounting[0]!.usage_complete = false;
    if (gap === "missing run") value.accounting = [];
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const candidate = await screen.findByRole("region", { name: "Candidato exacto y corrección acotada del workflow" });
    expect(within(candidate).getByText(/Consumo no confirmado; límites 3 tareas · 4 intentos/)).toBeInTheDocument();
    expect(within(candidate).queryByText(/0\/300000 ms/)).toBeNull();
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("shows recorded correction attempts and observed consumption without allocating another root budget", async () => {
    const value = detail(); value.grant.correction = { enabled: true, max_corrections: 1, budget: { max_tasks: 3, max_attempts: 4, max_runtime_ms: 300000, max_total_tokens: 40000 } };
    value.lineage = { schema_version: 1, id: "L-1", project_id: "alpha", issue_id: "I-1", scope_revision: 1, origin_task_id: "T-1", workflow_ids: ["W-1"], candidate_ids: [], correction_limit: 1, corrections_consumed: 1, consumed_stage_id: "S-1", consumed_at: at };
    value.stages[0]!.kind = "correction";
    value.accounting = [{ schema_version: 1, id: "A-1", workflow_id: "W-1", stage_id: "S-1", task_id: "T-1", execution_id: "R-1", attempt: 1, attempt_charged: true, active_runtime_ms: 1200, observed_tokens: 20, usage_complete: true, captured_at: at }];
    const open = vi.fn(); retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} onOpenTask={open} />);
    const candidate = await screen.findByRole("region", { name: "Candidato exacto y corrección acotada del workflow" });
    expect(within(candidate).getByText(/1\/3 tareas · 1\/4 intentos · 1200\/300000 ms · 20\/40000 tokens; dentro de la raíz, no capacidad adicional/)).toBeInTheDocument();
    expect(screen.getByText(/T-1 · ejecución R-1 · intento 1 · etapa S-1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver tarea T-1" })); expect(open).toHaveBeenCalledWith("T-1");
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it.each(["roles", "consent", "detail", "preview", "action"])("does not display private raw %s errors", async (source) => {
    const privateFailure = new Error("CONFIDENTIAL_PROVIDER_FAILURE C:\\private\\workflow.txt");
    if (source === "roles") vi.mocked(api.getContextRoles).mockRejectedValue(privateFailure);
    if (source === "consent") vi.mocked(api.getClientContextOptions).mockRejectedValue(privateFailure);
    if (source === "detail") { retain(); vi.mocked(api.getWorkflow).mockRejectedValue(privateFailure); }
    if (source === "preview") vi.mocked(api.previewWorkflow).mockRejectedValue(privateFailure);
    if (source === "action") { retain(); vi.mocked(api.decideWorkflow).mockRejectedValue(privateFailure); }
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    if (source === "preview") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar workflow" })).not.toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Previsualizar workflow" }));
    }
    if (source === "action") { await acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Aprobar decisión exacta" })); }
    if (source === "consent") await screen.findByRole("note"); else await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("CONFIDENTIAL_PROVIDER_FAILURE");
    expect(document.body.textContent).not.toContain("C:\\private\\workflow.txt");
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
    expect(api.decideWorkflow).toHaveBeenCalledTimes(source === "action" ? 1 : 0);
  });
  it("offers only five finite templates and starts only after exact preview plus explicit confirmation", async () => {
    const changed = vi.fn(async () => {}); render(<WorkflowPanel issue={issue} onChanged={changed} />);
    await screen.findByLabelText("Template de workflow"); expect(screen.getByLabelText("Template de workflow").querySelectorAll("option")).toHaveLength(5);
    expect(api.previewWorkflow).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled();
    await openPreview(); expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Apruebo este template/ })); fireEvent.click(screen.getByRole("button", { name: "Iniciar workflow aprobado" }));
    await waitFor(() => expect(api.startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ template_id: "analysis", expected_revision: 3, correction_enabled: false, selected_agents: { "portfolio-analyst": "tech-lead" }, client_context_categories: { "portfolio-analyst": [] }, budget }), hash));
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("keeps each role's consent empty and independent even with a shared adapter, and pins the authorized engineer", async () => {
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); fireEvent.change(await screen.findByLabelText("Template de workflow"), { target: { value: "implementation" } });
    const planner = within(screen.getByRole("group", { name: "planner" })), reviewer = within(screen.getByRole("group", { name: "reviewer" }));
    expect(screen.getByLabelText("Agente de software-engineer")).toBeDisabled(); expect(screen.getByLabelText("Agente de software-engineer")).toHaveValue("backend-engineer");
    fireEvent.click(planner.getByRole("checkbox", { name: /Notas confidenciales/ })); expect(reviewer.getByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked();
    await openPreview(); expect(api.previewWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({ client_context_categories: { planner: ["confidential-notes"], "software-engineer": [], reviewer: [] } }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Incluir el perfil QA/ })); expect(planner.getByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked(); expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull();
  });
  it.each(["budget", "agent", "consent", "template", "role"])("invalidates preview and acknowledgement when changing %s", async (change) => {
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await openPreview(); fireEvent.click(screen.getByRole("checkbox", { name: /Apruebo este template/ }));
    expect(screen.getByRole("region", { name: "Presupuesto informativo del workflow · portfolio-analyst" })).toBeInTheDocument();
    if (change === "budget") fireEvent.change(screen.getByLabelText("Tokens máximos"), { target: { value: 50000 } });
    if (change === "agent") fireEvent.change(screen.getByLabelText("Agente de portfolio-analyst"), { target: { value: "product-manager" } });
    if (change === "consent") fireEvent.click(screen.getByRole("checkbox", { name: /Notas confidenciales/ }));
    if (change === "template") fireEvent.change(screen.getByLabelText("Template de workflow"), { target: { value: "operations-investigation" } });
    if (change === "role") fireEvent.change(screen.getByLabelText("Rol de análisis"), { target: { value: "planner" } });
    expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull(); expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled(); expect(api.startWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Presupuesto informativo del workflow · portfolio-analyst" })).toBeNull();
  });
  it.each(["refresh", "revision"])("clears confidential consent and late previews after %s", async (change) => {
    let finish!: (value: api.WorkflowPreview) => void, request!: api.WorkflowPreviewRequest;
    vi.mocked(api.previewWorkflow).mockImplementation((value) => { request = value; return new Promise((resolve) => { finish = resolve; }); });
    const view = render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ }); fireEvent.click(notes);
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar workflow" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Previsualizar workflow" }));
    if (change === "refresh") fireEvent.click(screen.getByRole("button", { name: "Actualizar workflow" }));
    else { vi.mocked(api.getWorkIssue).mockResolvedValue({ ...lineage(), issue: { ...issue, revision: 4 } }); view.rerender(<WorkflowPanel issue={{ ...issue, revision: 4 }} onChanged={async () => {}} />); }
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked());
    await act(async () => finish(preview(request))); expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull(); expect(api.startWorkflow).not.toHaveBeenCalled();
  });
  it("ignores a late A preview after A -> B -> A and after unmount", async () => {
    let finish!: (value: api.WorkflowPreview) => void, request!: api.WorkflowPreviewRequest;
    vi.mocked(api.previewWorkflow).mockImplementation((value) => { request = value; return new Promise((resolve) => { finish = resolve; }); });
    const view = render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar workflow" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Previsualizar workflow" }));
    fireEvent.change(screen.getByLabelText("Rol de análisis"), { target: { value: "planner" } }); fireEvent.change(screen.getByLabelText("Rol de análisis"), { target: { value: "portfolio-analyst" } }); await act(async () => finish(preview(request)));
    expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull(); view.unmount(); expect(api.startWorkflow).not.toHaveBeenCalled();
  });
  it.each(["blocked", "version", "binding", "request consent", "manifest consent"])("does not start from a %s preview", async (reason) => {
    vi.mocked(api.previewWorkflow).mockImplementation(async (request) => {
      const value = preview(request);
      if (reason === "blocked") { value.allowed = false; value.blocked_reasons = ["Trusted QA and review requirements are unavailable"]; }
      if (reason === "version") value.schema_version = 2 as never;
      if (reason === "binding") value.request = { ...request, issue_id: "I-other" };
      if (reason === "request consent") value.request = { ...request, client_context_categories: { "portfolio-analyst": ["confidential-notes"] } };
      if (reason === "manifest consent") value.roles[0]!.manifest.selected_categories = ["confidential-notes"];
      return value;
    });
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar workflow" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Previsualizar workflow" }));
    if (reason === "blocked") await screen.findByText("Workflow bloqueado; no se puede iniciar."); else await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled(); expect(api.startWorkflow).not.toHaveBeenCalled();
  });
  it("requires a new preview after a failed stale start, without replay or retained consent", async () => {
    vi.mocked(api.startWorkflow).mockRejectedValue(new Error("Synthetic stale preview")); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await openPreview(); fireEvent.click(screen.getByRole("checkbox", { name: /Apruebo este template/ })); fireEvent.click(screen.getByRole("button", { name: "Iniciar workflow aprobado" }));
    await screen.findByRole("alert"); expect(api.startWorkflow).toHaveBeenCalledTimes(1); expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull(); expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled();
  });
  it.each(["plan-approval", "proposal-acknowledgement", "risk-acknowledgement"] as const)("submits only explicit current %s decisions with their exact bindings", async (kind) => {
    retain(detail(kind)); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await screen.findByLabelText("Motivo de la decisión"); expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled();
    await acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Aprobar decisión exacta" })); await waitFor(() => expect(api.decideWorkflow).toHaveBeenCalledWith("W-1", { expected_revision: 4, expected_issue_revision: 3, decision_id: "D-1", resource_fingerprint: hash, decision: "approve", rationale: "Reviewed this exact synthetic evidence" }));
  });
  it("keeps rejected decisions separate from approval and clears the acknowledgement", async () => {
    retain(); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Rechazar decisión exacta" })); await waitFor(() => expect(api.decideWorkflow).toHaveBeenCalledWith("W-1", expect.objectContaining({ decision: "reject", decision_id: "D-1" })));
  });
  it.each(["revision", "unsupported", "stopped", "unavailable"])("denies decision confirmation when authority is %s", async (reason) => {
    const value = detail(reason === "unsupported" ? "recovery" : "plan-approval"); if (reason === "revision") value.decisions[0]!.expected_workflow_revision = 3; if (reason === "stopped") value.workflow.stop_requested_at = at;
    retain(value); if (reason === "unavailable") vi.mocked(api.getWorkflow).mockRejectedValue(new Error("Synthetic unavailable workflow"));
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    if (reason === "unavailable") await screen.findByRole("alert"); else { const checkbox = await screen.findByRole("checkbox", { name: "Revisé esta decisión y sus bindings actuales" }); expect(checkbox).toBeDisabled(); }
    expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("shows O.6 fields, immutable handoffs, receipts and opt-in consumption without private bodies", async () => {
    const value = detail(); value.workflow.blocked_reason = "Synthetic review blocker"; value.workflow.recovery_state = "awaiting-human";
    value.grant.correction = { enabled: true, max_corrections: 1, budget: { max_tasks: 3, max_attempts: 4, max_runtime_ms: 300000, max_total_tokens: 40000 } };
    value.lineage = { schema_version: 1, id: "L-1", project_id: "alpha", issue_id: "I-1", scope_revision: 1, origin_task_id: "T-1", workflow_ids: ["W-1"], candidate_ids: [], correction_limit: 1, corrections_consumed: 1, consumed_stage_id: "S-1", consumed_at: at };
    value.handoffs = [{ schema_version: 1, id: "H-1", issue_id: "I-1", from_role_id: "planner", to_role_id: "software-engineer", execution_id: "R-1", outcome_summary: "Sealed synthetic handoff", evidence_ids: [], unresolved_questions: ["Human question"], risks: [], recommended_next_action: "Inspect exact evidence", requested_decision: "A human choice remains", created_at: at }];
    (value as unknown as { private_body: string }).private_body = "Never render this confidential body";
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await screen.findByText("Synthetic review blocker");
    for (const label of ["Etapa actual", "Rol activo", "Recovery", "Próxima acción permitida", "Revisión", "Testing", "Presupuesto raíz", "Subpresupuesto de corrección", "Candidato"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(/1\/1 consumida/)).toBeInTheDocument(); expect(screen.getByText("Trusted focused floor")).toBeInTheDocument(); expect(screen.getByText("Sealed synthetic handoff")).toBeInTheDocument(); expect(document.body.textContent).not.toContain("Never render this confidential body");
  });
  it.each(["cancel", "recover"] as const)("performs %s only after a distinct current acknowledgement", async (action) => {
    const value = detail(); if (action === "recover") { value.workflow.status = "needs-decision"; value.workflow.recovery_state = "awaiting-human"; }
    retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const button = await screen.findByRole("button", { name: action === "cancel" ? "Detener workflow" : "Reconciliar workflow" }); expect(button).toBeDisabled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: action === "cancel" ? /Confirmo detener/ : /Revisé los facts/ })); fireEvent.click(button);
    await waitFor(() => expect(api.controlWorkflow).toHaveBeenCalledWith("W-1", action, 4, 3));
  });
  it("keeps stop visible but denied without its controller and does not create recovery attempts", async () => {
    const value = detail(); value.execution_enabled = false; retain(value); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Detener workflow" })).toBeDisabled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it.each([false, true])("accepts only the current candidate with every criterion confirmed; invalidated=%s", async (invalidated) => {
    const value = detail("candidate-acceptance"), facts = lineage();
    facts.issue = { ...issue, status: "ready-for-review", candidate_ids: ["C-1"] };
    facts.candidates = [{ schema_version: 1, id: "C-1", issue_id: "I-1", task_id: "T-write", execution_id: "R-write", repository_id: "alpha", base_revision: "b".repeat(40), candidate_revision: "c".repeat(40), diff_fingerprint: hash, changed_paths: ["src/change.ts"], scope_revision: 1, created_at: at, invalidated_at: invalidated ? at : null }];
    value.workflow.candidate = { candidate_id: "C-1", issue_id: "I-1", task_id: "T-write", execution_id: "R-write", repository_id: "alpha", base_revision: "b".repeat(40), candidate_revision: "c".repeat(40), diff_fingerprint: hash, changed_paths: ["src/change.ts"], scope_revision: 1, content_fingerprint: hash, testing_evidence_fingerprint: hash };
    value.decisions[0]!.candidate_id = "C-1"; retain(value, facts); render(<WorkflowPanel issue={facts.issue} onChanged={async () => {}} />);
    await acknowledge(); const approve = screen.getByRole("button", { name: "Aprobar decisión exacta" }); expect(approve).toBeDisabled();
    const criterion = screen.getByRole("checkbox", { name: "Evidence retained" });
    if (invalidated) { expect(criterion).toBeDisabled(); expect(screen.getByText(/Invalidado, reemplazado/)).toBeInTheDocument(); }
    else { fireEvent.click(criterion); expect(approve).not.toBeDisabled(); fireEvent.click(approve); await waitFor(() => expect(api.decideWorkflow).toHaveBeenCalledWith("W-1", expect.objectContaining({ confirmed_criteria: ["Evidence retained"], decision_id: "D-1", resource_fingerprint: hash }))); }
    if (invalidated) expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("resets current decision and stop acknowledgements after a refresh even at the same revision", async () => {
    retain(); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await acknowledge(); fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo detener/ }));
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).not.toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Actualizar workflow" }));
    const confirm = await screen.findByRole("checkbox", { name: "Revisé esta decisión y sus bindings actuales" }); expect(confirm).not.toBeChecked(); expect(screen.getByLabelText("Motivo de la decisión")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Detener workflow" })).toBeDisabled();
  });
  it("preserves the chosen historical workflow when refreshing it", async () => {
    const old = detail(); old.workflow = { ...old.workflow, id: "W-old", status: "completed", pending_decision_id: null, current_stage_id: null };
    const current = detail(); vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [old.workflow, current.workflow] }); vi.spyOn(api, "getWorkflow").mockImplementation(async (id) => id === "W-old" ? old : current);
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); const selection = await screen.findByLabelText("Workflow registrado"); expect(selection).toHaveValue("W-1");
    fireEvent.change(selection, { target: { value: "W-old" } }); await waitFor(() => expect(screen.getByLabelText("Workflow registrado")).toHaveValue("W-old"));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar workflow" })); await waitFor(() => expect(screen.getByLabelText("Workflow registrado")).toHaveValue("W-old"));
    expect(screen.queryByRole("button", { name: "Detener workflow" })).toBeNull();
  });
  it.each([0, -1, 1.5, 300001])("does not preview an invalid or unbounded token budget %s", async (tokens) => {
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar workflow" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Tokens máximos"), { target: { value: tokens } });
    expect(screen.getByRole("button", { name: "Previsualizar workflow" })).toBeDisabled(); expect(api.previewWorkflow).not.toHaveBeenCalled();
  });
  it("does not let a late previous issue detail enable a decision after navigation", async () => {
    let finish!: (value: api.WorkflowDetail) => void;
    retain(); vi.mocked(api.getWorkflow).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    await waitFor(() => expect(api.getWorkflow).toHaveBeenCalledWith("W-1"));
    const otherIssue = { ...issue, id: "I-other", title: "Different synthetic issue" };
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [] }); vi.mocked(api.getWorkIssue).mockResolvedValue({ ...lineage(), issue: otherIssue });
    view.rerender(<WorkflowPanel issue={otherIssue} onChanged={async () => {}} />);
    await screen.findByLabelText("Template de workflow"); await act(async () => finish(detail()));
    expect(screen.queryByLabelText("Motivo de la decisión")).toBeNull(); expect(api.decideWorkflow).not.toHaveBeenCalled();
  });

  it("shows only the effective workflow projection per role without summing or substituting the raw role budget", async () => {
    vi.mocked(api.previewWorkflow).mockImplementation(async (request) => ({ ...preview(request), budget_previews: [{ role_id: "portfolio-analyst", preview: roleBudget("available", "role-only-source"), workflow_preview: roleBudget("available", "workflow-effective-source") }] }));
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await openPreview();
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del workflow · portfolio-analyst" });
    expect(within(summary).getAllByText("workflow-effective-source", { exact: false }).length).toBeGreaterThan(0);
    expect(within(summary).getByText("Disponibilidad informativa: disponible.")).toBeInTheDocument();
    expect(within(summary).queryByText("role-only-source", { exact: false })).toBeNull();
    expect(screen.getByText(/vistas superpuestas; no se suman/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled();
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.fetchBudgets).not.toHaveBeenCalled();
  });

  it.each(["missing", "unavailable", "exhausted", "duplicate", "wrong role", "missing combined", "wrong project attribution", "wrong role attribution", "wrong issue attribution", "multiple project attribution", "missing attribution"])("keeps %s budget evidence informational and cannot enable a blocked workflow", async (state) => {
    vi.mocked(api.previewWorkflow).mockImplementation(async (request) => {
      const value = preview(request); value.allowed = false; value.blocked_reasons = ["Explicit synthetic workflow authority denial"];
      if (state !== "missing") {
        const entry = { role_id: "portfolio-analyst" as WorkflowRoleId, preview: roleBudget("available", "less-restrictive-role-only"), workflow_preview: roleBudget(state === "exhausted" ? "exhausted" : "unavailable", "effective-workflow-budget") };
        value.budget_previews = state === "duplicate" ? [entry, entry] : [state === "wrong role" ? { ...entry, role_id: "planner" } : entry];
        if (state === "missing combined") delete (value.budget_previews![0] as { workflow_preview?: BudgetPreview }).workflow_preview;
        if (state === "wrong project attribution") entry.workflow_preview.binding!.attribution.project_ids = ["beta"];
        if (state === "wrong role attribution") entry.workflow_preview.binding!.attribution.role_id = "planner";
        if (state === "wrong issue attribution") entry.workflow_preview.binding!.attribution.issue_id = "I-other";
        if (state === "multiple project attribution") entry.workflow_preview.binding!.attribution.project_ids = ["alpha", "beta"];
        if (state === "missing attribution") entry.workflow_preview.binding!.attribution = null as never;
      }
      return value;
    });
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await openPreview();
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del workflow · portfolio-analyst" });
    expect(summary).toBeInTheDocument();
    expect(within(summary).queryByText("less-restrictive-role-only", { exact: false })).toBeNull();
    if (state === "exhausted") expect(within(summary).getByText("budget-exhausted", { exact: false })).toBeInTheDocument();
    if (state === "unavailable") expect(within(summary).getByText("budget-accounting-unavailable", { exact: false })).toBeInTheDocument();
    if (state === "exhausted" || state === "unavailable") expect(within(summary).getByText(`Disponibilidad informativa: ${state === "exhausted" ? "agotada" : "no disponible"}.`)).toBeInTheDocument();
    else expect(within(summary).getByText("Presupuesto no disponible.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Apruebo este template/ })).toBeDisabled();
    expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });

  it("labels current availability as project-scoped, refreshes it explicitly and preserves exact decision gates", async () => {
    retain(); render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const summary = await screen.findByRole("region", { name: "Presupuesto actual del proyecto vinculado al workflow" });
    await waitFor(() => expect(api.fetchBudgets).toHaveBeenCalledWith({ project_id: "alpha" }));
    expect(summary).toBeInTheDocument();
    expect(screen.getByText(/no demuestra capacidad disponible para este workflow/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled();
    expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
    const priorReads = vi.mocked(api.fetchBudgets).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar workflow" }));
    await screen.findByRole("region", { name: "Presupuesto actual del proyecto vinculado al workflow" });
    await waitFor(() => expect(vi.mocked(api.fetchBudgets).mock.calls.length).toBeGreaterThan(priorReads));
    expect(screen.getByRole("button", { name: "Aprobar decisión exacta" })).toBeDisabled();
    expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflow API projections", () => {
  // Exercise real wrappers independently of component spies, without a live service.
  beforeEach(() => vi.restoreAllMocks());
  it.each([null, {}, { workflows: null }, { workflows: [null] }, { workflows: [{ ...detail().workflow, schema_version: 2 }] }, { workflows: [{ ...detail().workflow, status: "future-state" }] }, { workflows: [detail().workflow, detail().workflow] }])("fails closed for unsupported ownership %j", async (value) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => value })));
    await expect(api.getWorkflows("I-1")).rejects.toThrow("Unsupported workflow list");
  });
  it.each(["version", "grant", "handoffs", "receipts", "events", "controller"])("rejects a %s mismatch rather than enabling controls", async (field) => {
    const value = detail();
    if (field === "version") value.schema_version = 2 as never;
    if (field === "grant") value.grant.issue_id = "I-other";
    if (field === "handoffs") value.handoffs = null as never;
    if (field === "receipts") value.review_receipts = [{ schema_version: 2 }] as never;
    if (field === "events") value.events = [null] as never;
    if (field === "controller") value.execution_enabled = "true" as never;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => value })));
    await expect(api.getWorkflow("W-1")).rejects.toThrow("Unsupported workflow detail");
  });
  it("does not replay a rejected session mutation and refreshes the token only on the next explicit action", async () => {
    let mutationCount = 0, sessionCount = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/session") return { ok: true, status: 200, json: async () => ({ token: `synthetic-session-${++sessionCount}` }) };
      mutationCount++;
      expect(init?.method).toBe("POST"); expect(JSON.parse(init?.body as string)).toEqual({ expected_revision: 4, expected_issue_revision: 3 });
      return mutationCount === 1 ? { ok: false, status: 403, json: async () => ({ error: "Synthetic expired session" }) } : { ok: true, status: 200, json: async () => detail() };
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(api.controlWorkflow("W-1", "cancel", 4, 3)).rejects.toThrow("Synthetic expired session");
    expect(mutationCount).toBe(1); expect(sessionCount).toBe(1);
    await expect(api.controlWorkflow("W-1", "cancel", 4, 3)).resolves.toHaveProperty("workflow.id", "W-1");
    expect(mutationCount).toBe(2); expect(sessionCount).toBe(2);
  });
});

describe("planner-recovery explicit UI gates", () => {
  function retainedDetail() {
    const value = detail(); value.workflow.status = "needs-decision"; value.workflow.pending_decision_id = null; value.workflow.recovery_state = "awaiting-human"; value.workflow.blocked_reason = "Incomplete role result";
    value.decisions = []; value.stages[0]!.status = "running"; value.stages[0]!.output!.status = "needs-review";
    value.planner_recovery_offer = { eligible: true, reasons: [], source_fingerprint: hash, workflow_revision: value.workflow.revision, issue_revision: issue.revision,
      questions: [{ index: 0, text: "Approve this exact plan?", fingerprint: hash }], risks: [{ index: 0, text: "Unmeasured verification cost", fingerprint: hash }] };
    return value;
  }
  async function fillRecovery() {
    const button = await screen.findByRole("button", { name: "Ofrecer plan para aprobación" }); expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Resolución de pregunta 1"), { target: { value: "plan-approval-gate" } });
    fireEvent.change(screen.getByLabelText("Respuesta a pregunta 1"), { target: { value: "Defer approval to the next exact gate" } });
    fireEvent.change(screen.getByLabelText("Motivo de recuperación"), { target: { value: "Offer unchanged retained proposal" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reconozco el riesgo:/ }));
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirmo ofrecer este plan sin cambiar alcance, límites ni verificaciones" }));
    expect(button).not.toBeDisabled(); return button;
  }
  it("requires deliberate question/risk confirmation and never approves the plan automatically", async () => {
    const value = retainedDetail(); retain(value); const recover = vi.spyOn(api, "offerPlannerRecovery").mockResolvedValue(detail());
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />);
    const button = await fillRecovery(); expect(recover).not.toHaveBeenCalled(); fireEvent.click(button);
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(recover.mock.calls[0]![1]).toMatchObject({ expected_revision: value.workflow.revision, expected_issue_revision: issue.revision, source_fingerprint: hash,
      questions: [{ index: 0, fingerprint: hash, kind: "plan-approval-gate", answer: "Defer approval to the next exact gate" }], risks: [{ index: 0, fingerprint: hash }] });
    expect(api.decideWorkflow).not.toHaveBeenCalled(); expect(api.startWorkflow).not.toHaveBeenCalled(); expect(api.controlWorkflow).not.toHaveBeenCalled();
  });
  it("requires a fresh read after a lost response without replaying the POST", async () => {
    retain(retainedDetail()); const recover = vi.spyOn(api, "offerPlannerRecovery").mockRejectedValue(new Error("synthetic lost response"));
    render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); fireEvent.click(await fillRecovery());
    await screen.findByText(/Resultado de recuperación desconocido/); expect(recover).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Ofrecer plan para aprobación" })).not.toBeInTheDocument(); expect(api.decideWorkflow).not.toHaveBeenCalled();
  });
  it("clears the recovery confirmations when refreshed bindings change", async () => {
    const value = retainedDetail(); retain(value); const recover = vi.spyOn(api, "offerPlannerRecovery").mockResolvedValue(detail());
    const view = render(<WorkflowPanel issue={issue} onChanged={async () => {}} />); await fillRecovery();
    const changed = retainedDetail(); changed.workflow.revision++; changed.planner_recovery_offer = { ...changed.planner_recovery_offer!, eligible: true, workflow_revision: changed.workflow.revision, source_fingerprint: "b".repeat(64) } as NonNullable<api.WorkflowDetail["planner_recovery_offer"]>;
    retain(changed); view.rerender(<WorkflowPanel issue={issue} refreshKey={1} onChanged={async () => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Ofrecer plan para aprobación" })).toBeDisabled());
    expect(screen.getByLabelText("Motivo de recuperación")).toHaveValue(""); expect(recover).not.toHaveBeenCalled();
  });
});
