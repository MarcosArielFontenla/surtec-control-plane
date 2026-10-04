// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { IssuesView } from "./IssuesView";
import * as api from "../api";
import type { Inbox } from "../../../../lib/state/types";
import type { IssueLineage, WorkIssue } from "../../../../lib/issues/types";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [] });
  vi.spyOn(api, "fetchDispatchOptions").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "getOrganization").mockResolvedValue({ company: {} as never, objectives: [], project_objectives: {} });
  vi.spyOn(api, "getContextRoles").mockResolvedValue({ roles: [] });
  vi.spyOn(api, "getClientContextOptions").mockResolvedValue({ available: false, categories: [] });
  vi.spyOn(api, "getWorkflows").mockResolvedValue({ workflows: [] });
});

const inbox: Inbox = {
  items: [
    { number: 2, title: "beta issue", url: "https://gh/beta/2", updatedAt: "2026-05-20T00:00:00Z", labels: ["bug"], author: "b", projectId: "beta", slug: "owner/beta" },
    { number: 1, title: "alpha issue", url: "https://gh/alpha/1", updatedAt: "2026-05-01T00:00:00Z", labels: [], author: "a", projectId: "alpha", slug: "owner/alpha" },
  ],
  repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: true }],
};

function reviewedFixture(): IssueLineage {
  const issue: WorkIssue = {
    schema_version: 1, id: "I-review", project_id: "alpha", objective_id: null, parent_issue_id: null,
    title: "Review fixture", expected_outcome: "Persist the fixture", acceptance_criteria: ["The fixture persists"],
    status: "ready-for-review", work_scale: "trivial", classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false }, classification_rationale: ["narrow"], plan: [],
    authorized_scope: { expected_outcome: "Persist the fixture", acceptance_criteria: ["The fixture persists"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] },
    scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null,
    priority: 50, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null,
    task_ids: ["T-review"], evidence_ids: [], candidate_ids: ["C-review"], created_at: "2026-09-29T12:00:00Z", updated_at: "2026-09-29T12:00:00Z", revision: 4,
  };
  return {
    issue, tasks: [], sessions: [], evidence: [], evidence_gaps: ["Human acceptance evidence is missing for the current candidate."],
    candidates: [{ schema_version: 1, id: "C-review", issue_id: issue.id, task_id: "T-review", execution_id: "run-review", repository_id: "alpha", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64), changed_paths: ["src/fixture.ts"], scope_revision: 1, created_at: issue.created_at, invalidated_at: null }],
  };
}

function authorizedFixture() {
  const issue = { ...reviewedFixture().issue, status: "authorized" as const, revision: 3, assigned_role_id: "backend-engineer", task_ids: [], candidate_ids: [] };
  vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
  vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [issue] });
  vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [{ project: "alpha", allowed_agents: ["backend-engineer", "tech-lead"], project_sandbox_ceiling: "workspace-write", has_local_checkout: true, has_verification_commands: true,
    agents: ["backend-engineer", "tech-lead"].map((agent) => ({ agent, agent_sandbox_ceiling: "workspace-write", allowed_modes: ["workspace-write"], default_mode: "workspace-write", modes: [] })) }] });
  vi.mocked(api.getContextRoles).mockResolvedValue({ roles: [
    { id: "reviewer", display_name: "Reviewer (Codex profile)", responsibility: "Read-only", sandbox_ceiling: "read-only", agents: ["backend-engineer"] },
    { id: "software-engineer", display_name: "Software Engineer (Codex profile)", responsibility: "Scoped implementation", sandbox_ceiling: "workspace-write", agents: ["backend-engineer", "tech-lead"] },
  ] });
  vi.mocked(api.getClientContextOptions).mockResolvedValue({ available: true, categories: ["confidential-notes"] });
  const preview: api.ContextPreview = { schema_version: 1, fingerprint: "a".repeat(64), allowed: true, blocked_reasons: [], runtime_read_limitation: "Runtime reads remain bounded by existing sandbox, not project-only.", manifest: {
    schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "software-engineer", agent_id: "backend-engineer", task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope", "verify-configured"], approval_rules: ["publication"],
    budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "focused", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: [], requires_red_evidence: false },
  } };
  const requestPreview = vi.spyOn(api, "previewContext").mockResolvedValue(preview);
  const dispatch = vi.spyOn(api, "dispatchWorkIssue").mockResolvedValue({ issue: { ...issue, status: "working", revision: 4 }, task_id: "T-1" });
  return { issue, preview, requestPreview, dispatch };
}

describe("IssuesView", () => {
  it("ignores an older ownership refresh that finishes after the latest snapshot", async () => {
    const fixture = authorizedFixture(); let finish!: (value: { workflows: never[] }) => void;
    vi.mocked(api.getWorkflows).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<IssuesView />); await waitFor(() => expect(api.getWorkflows).toHaveBeenCalledTimes(1));
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-1", issue_id: fixture.issue.id, project_id: "alpha", status: "waiting-human" } as never] });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" })); await screen.findByText(/Workflow activo W-1/);
    await act(async () => finish({ workflows: [] }));
    expect(screen.getByText(/Workflow activo W-1/)).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("hides generic dispatch and acceptance while a workflow owns the issue", async () => {
    const fixture = authorizedFixture();
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-1", issue_id: fixture.issue.id, project_id: "alpha", status: "waiting-human" } as never] });
    render(<IssuesView />);
    await screen.findByText(/Workflow activo W-1/);
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aceptar este candidato local" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ver workflow" })).toBeInTheDocument();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed for manual actions when workflow ownership cannot be read", async () => {
    const fixture = authorizedFixture(); vi.mocked(api.getWorkflows).mockRejectedValue(new Error("Synthetic unavailable ownership"));
    render(<IssuesView />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("requires explicit preview, retains the assigned agent and dispatches its exact role/revision/fingerprint", async () => {
    const fixture = authorizedFixture();
    render(<IssuesView />);
    const previewButton = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    expect(fixture.requestPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    const assigned = screen.getByLabelText("Agente autorizado de Review fixture");
    expect(assigned).toBeDisabled(); expect(assigned).toHaveValue("backend-engineer");
    expect(within(screen.getByLabelText("Perfil Codex de Review fixture")).queryByText("Reviewer (Codex profile)")).toBeNull();
    fireEvent.click(previewButton);
    await screen.findByText("Contexto habilitado para este pedido.");
    expect(fixture.requestPreview).toHaveBeenCalledWith({ kind: "issue", project: "alpha", agent: "backend-engineer", role_id: "software-engineer", issue_id: fixture.issue.id, expected_revision: 3, client_context_categories: [] });
    fireEvent.click(screen.getByRole("button", { name: "Despachar tarea aprobada" }));
    await waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith(fixture.issue.id, 3, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: "a".repeat(64), client_context_categories: [] }));
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
  });

  it("resets preview and confidential consent on explicit refresh and issue revision changes", async () => {
    const fixture = authorizedFixture();
    render(<IssuesView />);
    const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ });
    expect(notes).not.toBeChecked();
    fireEvent.click(notes);
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar contexto del issue" }));
    await screen.findByText("Contexto habilitado para este pedido.");
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [{ ...fixture.issue, revision: 4, scope_revision: 2 }] });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    await screen.findByText(/Preview sobre revisión 4/);
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(await screen.findByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("shows blocked admission without dispatch or implicit downgrade", async () => {
    const fixture = authorizedFixture();
    fixture.requestPreview.mockResolvedValue({ ...fixture.preview, allowed: false, blocked_reasons: ["Testing evidence configuration is unavailable"] });
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByText("Testing evidence configuration is unavailable");
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("discards a stale server dispatch and requires a new preview", async () => {
    const fixture = authorizedFixture();
    fixture.dispatch.mockRejectedValue(new Error("Context preview changed; regenerate before dispatch"));
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button); await screen.findByText("Contexto habilitado para este pedido.");
    fireEvent.click(screen.getByRole("button", { name: "Despachar tarea aprobada" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("ignores a late preview after the issue has refreshed", async () => {
    const fixture = authorizedFixture();
    let finish!: (value: api.ContextPreview) => void;
    fixture.requestPreview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar contexto del issue" })).not.toBeDisabled());
    finish(fixture.preview);
    await waitFor(() => expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled());
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("does not silently replace a historical assignment outside the available profile", async () => {
    const fixture = authorizedFixture();
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [{ ...fixture.issue, assigned_role_id: "unavailable-engineer" }] });
    render(<IssuesView />);
    await screen.findByText(/Sin perfil compatible disponible/);
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(fixture.requestPreview).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it.each([false, true])("invalidates accepted lineage and does not retain stale gaps when refetch fails=%s", async (fails) => {
    const ready = reviewedFixture();
    const done: IssueLineage = { ...ready, issue: { ...ready.issue, status: "done", revision: 5 }, evidence_gaps: [] };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValueOnce({ issues: [ready.issue] }).mockResolvedValue({ issues: [done.issue] });
    const getDetail = vi.spyOn(api, "getWorkIssue").mockResolvedValueOnce(ready);
    if (fails) getDetail.mockRejectedValueOnce(new Error("Synthetic detail refresh failed"));
    else getDetail.mockResolvedValueOnce(done);
    vi.spyOn(api, "acceptWorkIssueCandidate").mockResolvedValue({ issue: done.issue });
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findByText(/Human acceptance evidence is missing/);
    fireEvent.click(screen.getByRole("checkbox", { name: "The fixture persists" }));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar este candidato local" }));
    await screen.findByText("done");
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Human acceptance evidence is missing/)).toBeNull());
    if (fails) await screen.findByRole("alert");
    else await screen.findByText(/sin brechas conocidas/);
  });

  it("loads and lists issues newest-first with title links", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    const link = screen.getByRole("link", { name: /beta issue/i });
    expect(link.getAttribute("href")).toBe("https://gh/beta/2");
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("filters by repo", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/repositorio externo/i), { target: { value: "alpha" } });
    expect(screen.queryByText("beta issue")).toBeNull();
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("shows the empty state when there are no issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "alpha", slug: "owner/alpha", ok: true }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/sin issues externos abiertos/i)).toBeTruthy());
  });

  it("shows a degraded note for repos whose gh failed (some ok, some not)", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({
      items: [],
      repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: false, error: "no access" }],
    });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/no se pudo leer/i)).toBeTruthy());
  });

  it("shows 'GitHub no disponible' when every repo failed", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "beta", slug: "owner/beta", ok: false, error: "no gh" }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/github no disponible/i)).toBeTruthy());
  });

  it("keeps local work proposals separate from provider inbox issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [{
      id: "I-1", schema_version: 1, project_id: "alpha", objective_id: null, parent_issue_id: null,
      title: "Local outcome", expected_outcome: "Make the flow work", acceptance_criteria: ["It persists"], status: "proposed", work_scale: "trivial",
      classification_inputs: { affected_domains: [], requires_migration: false, security_impact: false }, classification_rationale: ["narrow"], plan: [],
      authorized_scope: { expected_outcome: "Make the flow work", acceptance_criteria: ["It persists"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] },
      scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 50, criticality: "low",
      blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null, task_ids: [], evidence_ids: [], candidate_ids: [],
      created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z", revision: 2,
    }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("Local outcome")).toBeTruthy());
    expect(screen.getByText("Trabajo aprobado")).toBeTruthy();
    expect(screen.getByText("Issues externos")).toBeTruthy();
    expect(screen.queryByText("Local outcome")?.closest("a")).toBeNull();
  });
});
