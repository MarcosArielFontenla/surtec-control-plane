// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BUDGET_DIMENSIONS } from "../../../../lib/budgets/types";
import type { ProjectIntegrationsSnapshot } from "../../../../lib/integrations/types";
import type { ProjectProfile } from "../../../../lib/portfolio-profile";
import type { OverviewModel, TodayModel } from "../../../../lib/state/types";
import type { SignalFeed } from "../../../../lib/signals/types";
import { projectOperatingView, type OperatingFact } from "../../../../lib/operating-views";
import * as api from "../api";
import { ProjectDetailView } from "./ProjectDetailView";

const observedAt = "2026-09-27T12:00:00.000Z";
function budgetView(sourceId = "project-policy", projectId = "alpha"): api.BudgetReadView {
  return { schema_version: 1, observed_at: observedAt, status: "unavailable", executable: false, reserves_capacity: false,
    ledger: { status: "unavailable", revision: null, updated_at: null }, policy: { revision: 2, fingerprint: "d".repeat(64) },
    sources: [{ id: sourceId, kind: "policy", scope: { kind: "project", id: projectId }, revision: 2, fingerprint: "d".repeat(64), period: "none", bucket: "none",
      dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: dimension === "attempts" ? "configured" : "unconfigured",
        cap: dimension === "attempts" ? 10 : null, proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null }])) as api.BudgetReadView["sources"][number]["dimensions"] }],
    pricing: { status: "unavailable", reason: "no-versioned-source" },
    denials: [{ code: "budget-accounting-unavailable", dimension: "attempts", source_ids: [sourceId] }] };
}

beforeEach(() => {
  vi.spyOn(api, "fetchBudgets").mockResolvedValue(budgetView());
  vi.spyOn(api, "getOperatingProject").mockRejectedValue(new Error("Synthetic optional operating source unavailable"));
  vi.spyOn(api, "fetchDispatchOptions").mockResolvedValue({ projects: [] });
});
const project = {
  id: "alpha", status: "active", health: null, note: null, repo: "https://github.com/owner/alpha.git",
  path: "/private/alpha", configured: true, git: null, last_activity: null,
  task_counts: { inProgress: 1, finished: 1 },
};
const overview: OverviewModel = {
  projects: [project],
  inProgress: [{ id: "task-active", project: "alpha", agent: "backend-engineer", title: "Active fictional task", lifecycle: "running", outcome: null,
    updated_at: observedAt, finished_at: null, requires_human_approval: false, attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  history: [{ id: "task-recent", project: "alpha", agent: "qa-reviewer", title: "Recent fictional task", lifecycle: "finished", outcome: "completed",
    updated_at: observedAt, finished_at: observedAt, requires_human_approval: false, attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  attention: [],
};
const today: TodayModel = {
  date: "2026-09-27", time_zone: "America/Buenos_Aires", generated_at: observedAt,
  active: overview.inProgress, attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
  counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 }, warnings: [],
  portfolio: { signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [], work_to_continue: [],
    client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [],
    sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] } },
};
const profile: ProjectProfile = {
  schema_version: 2, project_id: "alpha", kind: "client-product", lifecycle: "active", priority: 1, criticality: "high",
  current_goal: "Deliver the fictional release", next_action: "Review synthetic rollout", deadline: null,
  client_id: "private-client-reference", last_reviewed_at: null, tags: [],
};
function integrations(overrides: Partial<ProjectIntegrationsSnapshot> = {}): ProjectIntegrationsSnapshot {
  return {
    schema_version: 2, project_id: "alpha", observed_at: observedAt, trace_id: null,
    source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
      remote: { provider: "github", configured: true, health: "ok", pull_requests: 2, issues: 3,
        waiting_pull_requests: [{ number: 7, updated_at: observedAt, review_decision: "REVIEW_REQUIRED" }] } },
    ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main", run_id: "123" },
    dependencies: { provider: "npm", configured: true, health: "ok", outdated: 0, observed_at: observedAt },
    deployments: [{ provider: "railway", configured: true, health: "ok", status: "success", observed_at: observedAt,
      url: "https://alpha.example.test", http_status: null, latency_ms: null, deployed_at: observedAt }],
    ...overrides,
  };
}

function readinessOperating(projectId = "alpha") {
  const source = (items: OperatingFact[]) => ({ availability: "available", reason: "observed", origin: "saved", observed_at: observedAt, fresh_until: "2026-09-27T13:00:00.000Z", complete: true, items });
  return projectOperatingView({ schema_version: 1, as_of: observedAt, sources: {
    projects: source([{ id: projectId, label: "Fictional project", state: "active", project_kind: "personal", objective_ids: [], primary_objective_id: null }]),
    objectives: source([]),
    issues: source([{ id: "I-exact", label: "Exact fictional issue", state: "checking", project_id: projectId, objective_id: null }]),
    executions: source([{ id: "T-exact", label: "Exact fictional task", state: "finished", result_status: "completed", project_id: projectId, issue_id: "I-exact", role_id: "software-engineer" }]),
    workflows: source([{ id: "W-exact", label: "Exact fictional workflow", state: "waiting-human", project_id: projectId, issue_id: "I-exact", workflow_template_id: "implementation", role_id: "reviewer" }]),
  } }, { kind: "project", id: projectId, page_size: 6 });
}

function renderDetail(snapshot = integrations(), overrides: Partial<ComponentProps<typeof ProjectDetailView>> = {}) {
  vi.spyOn(api, "getProjectHarness").mockRejectedValue(new Error("Synthetic optional Harness unavailable: /private/fictional-notes.txt PRIVATE-HARNESS-CONTEXT"));
  vi.spyOn(api, "getProjectIntegrations").mockResolvedValue(snapshot);
  vi.spyOn(api, "getSignals").mockResolvedValue({ schema_version: 1, observed_at: observedAt, pinned_signal_ids: [], warnings: [], signals: [] } satisfies SignalFeed);
  vi.spyOn(api, "getActivity").mockResolvedValue({ items: [
    { kind: "commit", at: observedAt, project: "alpha", hash: "abc123", subject: "Synthetic commit", author: "Fictional Author" },
  ] });
  vi.spyOn(api, "getNotes").mockResolvedValue({ notes: [] });
  const onPrepareTask = vi.fn();
  const onBack = vi.fn();
  const onOpenTask = vi.fn();
  const onNavigateReadiness = vi.fn();
  const props = { project, overview, today, profile, profileReady: true, profileLoading: false,
    onProfileSaved: vi.fn(), onBack, onOpenTask, onPrepareTask, onNavigateReadiness, ...overrides };
  const view = render(<ProjectDetailView {...props} />);
  return { ...view, props, onPrepareTask, onBack, onOpenTask, onNavigateReadiness };
}

describe("ProjectDetailView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the aggregate evidence, tasks, notes, signals state section and keeps client references private", async () => {
    renderDetail();
    await screen.findByText("Control de código");
    expect(screen.getByText("2 PR abiertas · 3 issues abiertas")).toBeTruthy();
    expect(screen.getByRole("link", { name: /PR #7/ }).getAttribute("href")).toBe("https://github.com/owner/alpha/pull/7");
    expect(screen.getByText("Al día")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Abrir proveedor" }).some((link) => link.getAttribute("href") === "https://github.com/owner/alpha/issues")).toBe(true);
    expect(screen.getByText("Deliver the fictional release")).toBeTruthy();
    expect(screen.getByText("Active fictional task")).toBeTruthy();
    expect(screen.getByText("Recent fictional task")).toBeTruthy();
    expect(screen.getByText("Synthetic commit")).toBeTruthy();
    expect(screen.getByText("Notas locales")).toBeTruthy();
    expect(screen.getByText("No hay sesiones activas o pausadas para este proyecto.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private-client-reference");
    expect(screen.getAllByTitle(observedAt).length).toBeGreaterThan(0);
  });

  it("keeps the project detail usable when optional providers are degraded and refreshes the aggregate", async () => {
    const degraded = integrations({
      source_control: { ...integrations().source_control, remote: { ...integrations().source_control.remote, health: "unknown", error: "GitHub unavailable", pull_requests: null, issues: null } },
      ci: { ...integrations().ci, health: "unknown", status: "unknown", error: "CI unavailable" },
      deployments: [{ ...integrations().deployments[0]!, health: "unknown", status: null, url: null, error: "health check unavailable" }],
      dependencies: { ...integrations().dependencies, health: "unknown", error: "n/a (npm install)" },
    });
    const spy = vi.spyOn(api, "getProjectIntegrations").mockResolvedValueOnce(degraded).mockResolvedValueOnce(integrations({ observed_at: "2026-09-27T12:01:00.000Z" }));
    vi.spyOn(api, "getSignals").mockResolvedValue({ schema_version: 1, observed_at: observedAt, pinned_signal_ids: [], warnings: [], signals: [] });
    vi.spyOn(api, "getActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "getNotes").mockResolvedValue({ notes: [] });
    render(<ProjectDetailView project={project} overview={overview} today={today} profile={profile} profileReady profileLoading={false}
      onProfileSaved={() => {}} onBack={() => {}} onOpenTask={() => {}} onPrepareTask={() => {}} />);

    await screen.findByText("GitHub unavailable");
    expect(screen.getByText("Active fictional task")).toBeTruthy();
    expect(screen.getByText("Recent fictional task")).toBeTruthy();
    expect(screen.getByText("CI unavailable")).toBeTruthy();
    expect(screen.getByText("health check unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("alpha", true));
    await waitFor(() => expect(screen.getAllByTitle("2026-09-27T12:01:00.000Z").length).toBeGreaterThan(0));
  });

  it("omits client profile details from task prefill and does not dispatch", async () => {
    const createTask = vi.spyOn(api, "createTask");
    const { onPrepareTask } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    expect(onPrepareTask).toHaveBeenCalledWith("alpha", "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("links to the mounted Harness evidence without another inspection, refresh, dispatch or editor launch", async () => {
    const createTask = vi.spyOn(api, "createTask");
    const openProject = vi.spyOn(api, "openProject");
    const { onBack, onOpenTask, onPrepareTask } = renderDetail();
    await screen.findByText("No pude leer el Harness. No se modificó el proyecto.");
    const link = screen.getByRole("link", { name: "Ver Harness y evidencia" });
    expect(link).toHaveAttribute("href", "#project-harness-alpha");
    expect(screen.getByRole("region", { name: "Harness del proyecto" })).toHaveAttribute("id", "project-harness-alpha");
    expect(document.body.textContent).toContain("Su ausencia por sí sola no bloquea un proyecto personal");
    fireEvent.click(link);
    await act(async () => {});
    expect(api.getProjectHarness).toHaveBeenCalledTimes(1);
    expect(api.getProjectHarness).toHaveBeenCalledWith("alpha");
    expect(vi.mocked(api.getProjectHarness).mock.calls.every((call) => call[1] !== true)).toBe(true);
    expect(api.getProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getSignals).toHaveBeenCalledTimes(1);
    expect(api.getActivity).toHaveBeenCalledTimes(1);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(onPrepareTask).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
  });

  it("keeps the Harness evidence anchor bound to the selected project across alpha to beta to alpha navigation", async () => {
    const { rerender, props } = renderDetail();
    await waitFor(() => expect(api.getProjectHarness).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Ver Harness y evidencia" })).toHaveAttribute("href", "#project-harness-alpha");
    rerender(<ProjectDetailView {...props} project={{ ...project, id: "beta" }} profile={undefined} />);
    await waitFor(() => expect(api.getProjectHarness).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("link", { name: "Ver Harness y evidencia" })).toHaveAttribute("href", "#project-harness-beta");
    expect(screen.getByRole("region", { name: "Harness del proyecto" })).toHaveAttribute("id", "project-harness-beta");
    expect(document.getElementById("project-harness-alpha")).toBeNull();
    rerender(<ProjectDetailView {...props} />);
    await waitFor(() => expect(api.getProjectHarness).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("link", { name: "Ver Harness y evidencia" })).toHaveAttribute("href", "#project-harness-alpha");
    expect(screen.getByRole("region", { name: "Harness del proyecto" })).toHaveAttribute("id", "project-harness-alpha");
    expect(document.getElementById("project-harness-beta")).toBeNull();
    expect(vi.mocked(api.getProjectHarness).mock.calls).toEqual([["alpha"], ["beta"], ["alpha"]]);
  });

  it("keeps task navigation and private-context-safe preparation usable after an optional Harness failure", async () => {
    const createTask = vi.spyOn(api, "createTask");
    const openProject = vi.spyOn(api, "openProject");
    const { onBack, onOpenTask, onPrepareTask } = renderDetail();
    await screen.findByText("No pude leer el Harness. No se modificó el proyecto.");
    fireEvent.click(screen.getByRole("link", { name: "Ver Harness y evidencia" }));
    fireEvent.click(screen.getByRole("button", { name: /Active fictional task/ }));
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    fireEvent.click(screen.getByRole("button", { name: /Volver al portfolio/ }));
    expect(onOpenTask).toHaveBeenCalledWith("task-active");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onPrepareTask).toHaveBeenCalledWith("alpha", "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.");
    expect(document.body.textContent).not.toContain("Synthetic optional Harness unavailable");
    expect(document.body.textContent).not.toContain("/private/fictional-notes.txt");
    expect(document.body.textContent).not.toContain("PRIVATE-HARNESS-CONTEXT");
    expect(document.body.textContent).not.toContain("private-client-reference");
    expect(createTask).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(api.getProjectHarness).toHaveBeenCalledTimes(1);
  });

  it("keeps navigation and task preparation available when the project budget query fails", async () => {
    vi.mocked(api.fetchBudgets).mockRejectedValue(new Error("Synthetic optional budget outage"));
    const createTask = vi.spyOn(api, "createTask");
    const { onBack, onOpenTask, onPrepareTask } = renderDetail();
    await waitFor(() => expect(api.fetchBudgets).toHaveBeenCalledWith({ project_id: "alpha" }));
    await screen.findByText("No pude consultar el presupuesto; el resto de la vista sigue disponible.");
    fireEvent.click(screen.getByRole("button", { name: /Volver al portfolio/ }));
    fireEvent.click(screen.getByRole("button", { name: /Active fictional task/ }));
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith("task-active");
    expect(onPrepareTask).toHaveBeenCalledWith("alpha", expect.any(String));
    expect(createTask).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Synthetic optional budget outage");
  });

  it("refreshes only the project budget on explicit refresh and a new current observation", async () => {
    const { rerender, props } = renderDetail();
    await screen.findAllByText(/project-policy/);
    const budget = within(screen.getByRole("region", { name: "Presupuesto del proyecto" }));
    expect(budget.getByText("Disponibilidad informativa: no disponible.")).toBeInTheDocument();
    expect(budget.getAllByText(/límite 10 · consumido desconocido · probado desconocido · reservado desconocido · restante desconocido/)).toHaveLength(1);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(1);
    expect(api.fetchBudgets).toHaveBeenLastCalledWith({ project_id: "alpha" });
    vi.mocked(api.fetchBudgets).mockResolvedValue(budgetView("refreshed-project-policy"));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findAllByText(/refreshed-project-policy/);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(2);
    vi.mocked(api.fetchBudgets).mockResolvedValue(budgetView("observed-project-policy"));
    rerender(<ProjectDetailView {...props} today={{ ...today, generated_at: "2026-09-27T12:01:00.000Z" }} />);
    await screen.findAllByText(/observed-project-policy/);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(3);
    expect(api.fetchBudgets).toHaveBeenLastCalledWith({ project_id: "alpha" });
    expect(document.body.textContent).not.toContain("refreshed-project-policy");
    expect(document.body.textContent).toContain("budget-accounting-unavailable");
  });

  it("fences an older project budget response across alpha to beta to alpha navigation", async () => {
    let finishOld!: (value: api.BudgetReadView) => void;
    vi.mocked(api.fetchBudgets).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(budgetView("beta-policy", "beta"))
      .mockResolvedValueOnce(budgetView("current-alpha-policy"));
    const { rerender, props } = renderDetail();
    await waitFor(() => expect(api.fetchBudgets).toHaveBeenCalledTimes(1));
    rerender(<ProjectDetailView {...props} project={{ ...project, id: "beta" }} />);
    await screen.findAllByText(/beta-policy/);
    expect(api.fetchBudgets).toHaveBeenLastCalledWith({ project_id: "beta" });
    rerender(<ProjectDetailView {...props} />);
    await screen.findAllByText(/current-alpha-policy/);
    await act(async () => finishOld(budgetView("stale-alpha-policy")));
    expect(document.body.textContent).not.toContain("stale-alpha-policy");
    expect(document.body.textContent).not.toContain("beta-policy");
    expect(document.body.textContent).toContain("current-alpha-policy");
    expect(api.fetchBudgets).toHaveBeenCalledTimes(3);
  });

  it("reuses the selected project's integration snapshot without requesting readiness or dispatch options on mount", async () => {
    renderDetail();
    const readiness = within(screen.getByRole("region", { name: "Preparación del proyecto" }));
    await waitFor(() => expect(readiness.getByText(/Git ok · CI ok \/ passing/)).toBeInTheDocument());
    expect(readiness.getByText("Preparado para inspeccionar no significa autorizado para ejecutar.")).toBeInTheDocument();
    expect(readiness.getByText(/Se reutiliza la lectura del detalle/)).toBeInTheDocument();
    expect(readiness.getByRole("button", { name: "Consultar preparación" })).toBeEnabled();
    expect(api.getProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getProjectIntegrations).toHaveBeenCalledWith("alpha");
    expect(api.getProjectHarness).toHaveBeenCalledTimes(1);
    expect(api.getOperatingProject).not.toHaveBeenCalled();
    expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
    expect(readiness.queryByText("/private/alpha")).not.toBeInTheDocument();
  });

  it("links the daily loop to mounted session and Harness sections without reads, previews or mutations", async () => {
    const mutations = ["createTask", "previewContext", "startWorkSession", "actOnWorkSession", "openProject"] as const;
    const spies = mutations.map(name => vi.spyOn(api, name));
    const { onNavigateReadiness, onPrepareTask, onOpenTask } = renderDetail();
    await screen.findByText("No pude leer el Harness. No se modificó el proyecto.");
    const readiness = within(screen.getByRole("region", { name: "Preparación del proyecto" }));
    const sessionLink = readiness.getByRole("link", { name: "Ir a la sesión del proyecto" });
    const harnessLink = readiness.getByRole("link", { name: "Inspeccionar detalle Harness existente" });
    expect(sessionLink).toHaveAttribute("href", "#project-sessions-alpha");
    expect(harnessLink).toHaveAttribute("href", "#project-harness-alpha");
    expect(document.getElementById("project-sessions-alpha")).toContainElement(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(document.getElementById("project-harness-alpha")).toBe(screen.getByRole("region", { name: "Harness del proyecto" }));
    fireEvent.click(sessionLink);
    fireEvent.click(harnessLink);
    await act(async () => {});
    expect(api.getProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getProjectHarness).toHaveBeenCalledTimes(1);
    expect(api.getOperatingProject).not.toHaveBeenCalled();
    expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
    expect(onPrepareTask).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(onNavigateReadiness).not.toHaveBeenCalled();
    fireEvent.click(readiness.getByRole("button", { name: "Revisar o proponer issue" }));
    expect(onNavigateReadiness).toHaveBeenCalledExactlyOnceWith({ kind: "issues", projectId: "alpha" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("consults preparation explicitly and forwards exact issue, workflow and task references without executing them", async () => {
    vi.mocked(api.getOperatingProject).mockResolvedValue(readinessOperating());
    vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [{ project: "alpha", allowed_agents: [], project_sandbox_ceiling: "read-only",
      has_local_checkout: true, has_verification_commands: false, agents: [] }] });
    const createTask = vi.spyOn(api, "createTask");
    const preview = vi.spyOn(api, "previewContext");
    const { onNavigateReadiness, onOpenTask, onPrepareTask } = renderDetail();
    const readiness = within(screen.getByRole("region", { name: "Preparación del proyecto" }));
    fireEvent.click(readiness.getByRole("button", { name: "Consultar preparación" }));
    await readiness.findByText(/Sin comandos registrados; esto no impide por sí solo el análisis read-only/);
    expect(api.getOperatingProject).toHaveBeenCalledExactlyOnceWith("alpha", { page_size: 6 });
    expect(api.fetchDispatchOptions).toHaveBeenCalledTimes(1);
    fireEvent.click(readiness.getByText("Evidencia local consultada y decisiones"));
    fireEvent.click(readiness.getByRole("button", { name: "Revisar issue I-exact" }));
    fireEvent.click(readiness.getByRole("button", { name: "Revisar workflow W-exact" }));
    fireEvent.click(readiness.getByRole("button", { name: "Inspeccionar tarea T-exact" }));
    expect(onNavigateReadiness.mock.calls).toEqual([
      [{ kind: "issue", id: "I-exact", projectId: "alpha" }],
      [{ kind: "workflow", id: "W-exact", issueId: "I-exact", projectId: "alpha" }],
    ]);
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith("T-exact");
    expect(onPrepareTask).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(api.getProjectIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getProjectHarness).toHaveBeenCalledTimes(1);
  });

  it("keeps personal task preparation and the existing session form usable with optional sources absent", async () => {
    const startSession = vi.spyOn(api, "startWorkSession");
    const createTask = vi.spyOn(api, "createTask");
    const { onPrepareTask, onNavigateReadiness } = renderDetail(integrations(), { profile: undefined });
    await screen.findByText("No pude leer el Harness. No se modificó el proyecto.");
    const readiness = within(screen.getByRole("region", { name: "Preparación del proyecto" }));
    expect(readiness.getByText(/Objetivo, cliente y Harness son opcionales/)).toBeInTheDocument();
    expect(readiness.getByText(/not-enabled/)).toBeInTheDocument();
    expect(readiness.getByText(/deferred/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Objetivo de la sesión" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    expect(onPrepareTask).toHaveBeenCalledWith("alpha", "Review the current operating state of alpha and propose a safe next step.");
    fireEvent.click(readiness.getByRole("button", { name: "Revisar o proponer issue" }));
    expect(onNavigateReadiness).toHaveBeenCalledExactlyOnceWith({ kind: "issues", projectId: "alpha" });
    expect(createTask).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(api.getOperatingProject).not.toHaveBeenCalled();
    expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
  });

  it("binds readiness and session anchors to the selected project while its new integration snapshot is pending", async () => {
    let finishBeta!: (value: ProjectIntegrationsSnapshot) => void;
    const { rerender, props } = renderDetail();
    const readiness = () => within(screen.getByRole("region", { name: "Preparación del proyecto" }));
    await waitFor(() => expect(readiness().getByText(/Git ok · CI ok \/ passing/)).toBeInTheDocument());
    vi.mocked(api.getProjectIntegrations).mockImplementationOnce(() => new Promise(resolve => { finishBeta = resolve; }));
    fireEvent.change(screen.getByRole("textbox", { name: "Objetivo de la sesión" }), { target: { value: "Private unsaved alpha session context" } });
    rerender(<ProjectDetailView {...props} project={{ ...project, id: "beta" }} profile={undefined} />);
    await waitFor(() => expect(api.getProjectIntegrations).toHaveBeenLastCalledWith("beta"));
    expect(readiness().getByText(/Lectura existente pendiente/)).toBeInTheDocument();
    expect(readiness().queryByText(/Git ok · CI ok \/ passing/)).not.toBeInTheDocument();
    expect(readiness().getByRole("link", { name: "Ir a la sesión del proyecto" })).toHaveAttribute("href", "#project-sessions-beta");
    expect(document.getElementById("project-sessions-alpha")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Objetivo de la sesión" })).toHaveValue("");
    expect(document.body.textContent).not.toContain("Private unsaved alpha session context");
    await act(async () => finishBeta(integrations({ project_id: "beta", observed_at: "2026-09-27T12:01:00.000Z" })));
    expect(readiness().getByText(/Git ok · CI ok \/ passing/)).toBeInTheDocument();
    expect(api.getOperatingProject).not.toHaveBeenCalled();
    expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
  });

  it("does not let a late integration refresh replace current readiness after alpha to beta to alpha navigation", async () => {
    let finishOld!: (value: ProjectIntegrationsSnapshot) => void;
    const { rerender, props } = renderDetail();
    const readiness = () => screen.getByRole("region", { name: "Preparación del proyecto" });
    await waitFor(() => expect(readiness()).toHaveTextContent(observedAt));
    vi.mocked(api.getProjectIntegrations).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(integrations({ project_id: "beta", observed_at: "2026-09-27T12:01:00.000Z" }))
      .mockResolvedValueOnce(integrations({ observed_at: "2026-09-27T12:02:00.000Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(api.getProjectIntegrations).toHaveBeenLastCalledWith("alpha", true));
    rerender(<ProjectDetailView {...props} project={{ ...project, id: "beta" }} profile={undefined} />);
    await waitFor(() => expect(readiness()).toHaveTextContent("2026-09-27T12:01:00.000Z"));
    rerender(<ProjectDetailView {...props} />);
    await waitFor(() => expect(readiness()).toHaveTextContent("2026-09-27T12:02:00.000Z"));
    await act(async () => finishOld(integrations({ observed_at: "2026-09-27T12:00:30.000Z" })));
    expect(readiness()).toHaveTextContent("2026-09-27T12:02:00.000Z");
    expect(readiness()).not.toHaveTextContent("2026-09-27T12:00:30.000Z");
    expect(api.getProjectIntegrations).toHaveBeenCalledTimes(4);
    expect(api.getOperatingProject).not.toHaveBeenCalled();
    expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
  });

  it("mounts delivery in project context without implicit issue reads or mutations", async () => {
    const issues = vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [] });
    const lineage = vi.spyOn(api, "getWorkIssue");
    const record = vi.spyOn(api, "recordDeliveryObservation");
    const saveCommitment = vi.spyOn(api, "saveCommitment");
    const createTask = vi.spyOn(api, "createTask");
    const { onPrepareTask } = renderDetail();
    const delivery = within(screen.getByRole("region", { name: "Entrega y seguimiento" }));
    await screen.findByText("Control de código");
    expect(issues).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    fireEvent.click(delivery.getByRole("button", { name: "Consultar entrega y seguimiento" }));
    await delivery.findByText(/Sin issues locales vinculados en esta consulta/);
    expect(issues).toHaveBeenCalledExactlyOnceWith();
    expect(lineage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Preparar tarea/ }));
    expect(onPrepareTask).toHaveBeenCalledExactlyOnceWith("alpha", "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.");
    expect(record).not.toHaveBeenCalled();
    expect(saveCommitment).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("resets the delivery lookup on project changes and fences the previous project's pending read", async () => {
    let finishAlpha!: (value: Awaited<ReturnType<typeof api.getWorkIssues>>) => void;
    const issues = vi.spyOn(api, "getWorkIssues").mockImplementationOnce(() => new Promise(resolve => { finishAlpha = resolve; })).mockResolvedValue({ issues: [] });
    const read = vi.spyOn(api, "getWorkIssue");
    const record = vi.spyOn(api, "recordDeliveryObservation");
    const { rerender, props } = renderDetail();
    const delivery = () => within(screen.getByRole("region", { name: "Entrega y seguimiento" }));
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    await waitFor(() => expect(issues).toHaveBeenCalledTimes(1));
    rerender(<ProjectDetailView {...props} project={{ ...project, id: "beta" }} profile={undefined} />);
    expect(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" })).toBeEnabled();
    expect(issues).toHaveBeenCalledTimes(1);
    fireEvent.click(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" }));
    await delivery().findByText(/Sin issues locales vinculados en esta consulta/);
    await act(async () => finishAlpha({ issues: [] }));
    expect(delivery().getByText(/Sin issues locales vinculados en esta consulta/)).toBeInTheDocument();
    rerender(<ProjectDetailView {...props} />);
    expect(delivery().getByRole("button", { name: "Consultar entrega y seguimiento" })).toBeEnabled();
    expect(delivery().queryByText(/Sin issues locales vinculados en esta consulta/)).not.toBeInTheDocument();
    expect(issues).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
