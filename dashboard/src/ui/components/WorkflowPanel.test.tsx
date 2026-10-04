// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import type { ContextManifest } from "../../../../lib/context/types";
import type { WorkflowRoleId, WorkflowRoleOutput } from "../../../../lib/workflows/types";
import type { ClientContextCategory } from "../../../../lib/client-portfolio";
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
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WorkflowPanel", () => {
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
    if (change === "budget") fireEvent.change(screen.getByLabelText("Tokens máximos"), { target: { value: 50000 } });
    if (change === "agent") fireEvent.change(screen.getByLabelText("Agente de portfolio-analyst"), { target: { value: "product-manager" } });
    if (change === "consent") fireEvent.click(screen.getByRole("checkbox", { name: /Notas confidenciales/ }));
    if (change === "template") fireEvent.change(screen.getByLabelText("Template de workflow"), { target: { value: "operations-investigation" } });
    if (change === "role") fireEvent.change(screen.getByLabelText("Rol de análisis"), { target: { value: "planner" } });
    expect(screen.queryByRole("region", { name: "Preview de workflow" })).toBeNull(); expect(screen.getByRole("button", { name: "Iniciar workflow aprobado" })).toBeDisabled(); expect(api.startWorkflow).not.toHaveBeenCalled();
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
