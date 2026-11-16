// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OrganizationSnapshot } from "../../../../lib/organization";
import type { ProjectView } from "../../../../lib/state/types";
import { projectOperatingView, type OperatingFact, type OperatingSourceInput, type OperatingView } from "../../../../lib/operating-views";
import * as api from "../api";
import { OrganizationView } from "./OrganizationView";

const observedAt = "2026-10-16T11:00:00.000Z";
const asOf = "2026-10-16T12:00:00.000Z";
const expiresAt = "2026-10-16T13:00:00.000Z";
const project: ProjectView = { id: "alpha", status: "active", health: null, note: null, repo: null, path: null,
  configured: false, git: null, last_activity: null, task_counts: { inProgress: 0, finished: 0 } };

function organization(): OrganizationSnapshot {
  return {
    company: { schema_version: 1, id: "surtec", display_name: "SURTEC", mission: "Original editor mission",
      operating_principles: ["Keep authority explicit"], active_objective_ids: ["OBJ-1"], last_reviewed_at: "2026-10-16" },
    objectives: [{ schema_version: 1, id: "OBJ-1", company_id: "surtec", title: "Editor objective",
      desired_outcome: "Retain the existing protected editor", success_criteria: ["Existing saves remain explicit"],
      status: "active", horizon: "quarter", priority: 3, target_date: null, parent_objective_id: null,
      project_ids: ["alpha"], owner: "marcos", last_reviewed_at: "2026-10-16" }],
    project_objectives: { alpha: { objective_ids: ["OBJ-1"], primary_objective_id: "OBJ-1" } },
  };
}

function fact(id: string, state: string | null, extra: Partial<OperatingFact> = {}): OperatingFact {
  return { id, label: `Public ${id}`, state, ...extra };
}
function source(items: OperatingFact[] = [], extra: Partial<OperatingSourceInput> = {}): OperatingSourceInput {
  return { availability: "available", reason: "observed", origin: "saved", observed_at: observedAt,
    fresh_until: expiresAt, complete: true, items, ...extra };
}
function sources(): Record<string, OperatingSourceInput> {
  return {
    company: source([fact("surtec", null, { label: "SURTEC public overview", summary: "Public company mission", principles: ["Public principle"] })]),
    objectives: source([fact("OBJ-1", "active", { label: "Public objective", summary: "Public desired outcome", criteria: ["Public success criterion"] })]),
    projects: source([fact("alpha", "active", { label: "Public alpha", project_kind: "personal", objective_ids: ["OBJ-1"], primary_objective_id: "OBJ-1" })]),
    issues: source([fact("ISS-1", "needs-decision", { label: "Public decision", project_id: "alpha", objective_id: "OBJ-1", decision_reason: "scope-changed" })]),
    executions: source([fact("T-1", "finished", { label: "Public execution", project_id: "alpha", issue_id: "ISS-1", result_status: "completed" })]),
    workflows: source([fact("WF-1", "needs-decision", { label: "Public workflow", project_id: "alpha", issue_id: "ISS-1", workflow_template_id: "analysis" })]),
    signals: source([fact("SIG-1", "open", { label: "Public signal", project_id: "alpha" })]),
    commitments: source([fact("COM-1", "blocked", { label: "Public commitment", project_id: "alpha", target_date: "2026-10-17" })]),
    harness: source([fact("alpha", "healthy", { label: "Public Harness", project_id: "alpha", validation_status: "unknown" })]),
    sessions: source([fact("SESSION-1", "active", { label: "Public current session", project_id: "alpha" })]),
    budgets: source([fact("BUDGET-1", "unknown", { label: "Public budget preview" })]),
  };
}
function model(overrides: Record<string, unknown> = {}, query: api.OperatingPageQuery = {}): OperatingView {
  return projectOperatingView({ schema_version: 1, as_of: asOf, sources: { ...sources(), ...overrides } },
    { kind: "overview", page_size: 6, ...query });
}
function objectiveModel(id: string, overrides: Record<string, unknown> = {}, query: api.OperatingPageQuery = {}): OperatingView {
  return projectOperatingView({ schema_version: 1, as_of: asOf, sources: { ...sources(), ...overrides } },
    { kind: "objective", id, page_size: 8, ...query });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function section(name: string) { return within(screen.getByRole("region", { name })); }
async function ready() {
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Overview operativo SURTEC" })).getByText("Public alpha")).toBeInTheDocument());
}
function hasTimestamp(element: HTMLElement, value: string): boolean {
  return element.textContent?.includes(value) === true || [...element.querySelectorAll("time")].some((time) => time.dateTime === value);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected external request")));
  vi.spyOn(api, "getOrganization").mockImplementation(async () => organization());
  vi.spyOn(api, "getOperatingOverview").mockImplementation(async (query) => model({}, query));
  vi.spyOn(api, "getOperatingObjective").mockImplementation(async (id, query) => objectiveModel(id, {}, query));
  vi.spyOn(api, "getSignals").mockRejectedValue(new Error("Live signal reads are forbidden"));
  vi.spyOn(api, "saveCompanyProfile").mockImplementation(async (company) => ({ company }));
  vi.spyOn(api, "createObjective").mockImplementation(async (input) => ({ objective: { ...organization().objectives[0]!, ...input, id: "OBJ-2" } }));
  vi.spyOn(api, "saveObjective").mockImplementation(async (objective) => ({ objective }));
  vi.spyOn(api, "saveProjectObjectiveLinks").mockImplementation(async (_id, links) => ({ links, organization: organization() }));
  vi.spyOn(api, "openProject").mockResolvedValue(undefined);
  vi.spyOn(api, "postSignalAction").mockResolvedValue({} as Awaited<ReturnType<typeof api.postSignalAction>>);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("OrganizationView operating overview", () => {
  it("renders the eleven independent operating sections alongside the existing company and objective editors", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    const overview = screen.getByRole("region", { name: "Overview operativo SURTEC" });
    for (const name of ["Empresa", "Objetivos activos y estrategia", "Proyectos", "Issues y decisiones", "Ejecuciones", "Workflows",
      "Señales", "Compromisos", "Harness", "Sesiones de trabajo", "Presupuestos"]) {
      expect(within(overview).getByRole("region", { name })).toBeInTheDocument();
    }
    expect(within(overview).getByText("Public company mission")).toBeInTheDocument();
    expect(within(overview).getByText("Public principle")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Original editor mission");
    expect(screen.getByRole("button", { name: "Guardar perfil" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Crear objetivo" })).toBeEnabled();
    expect(api.getOperatingOverview).toHaveBeenCalledExactlyOnceWith({ page_size: 6 });
  });

  it("shows source observation timestamps separately from overview generation time", async () => {
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    expect(hasTimestamp(screen.getByRole("region", { name: "Proyectos" }), observedAt)).toBe(true);
    expect(hasTimestamp(screen.getByRole("region", { name: "Overview operativo SURTEC" }), asOf)).toBe(true);
    expect(section("Proyectos").queryByText("Total desconocido", { exact: false })).not.toBeInTheDocument();
  });

  it("retains independent useful sections when saved signals are unavailable instead of claiming healthy or zero alerts", async () => {
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ signals: undefined }));
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    expect(section("Señales").getByText("No disponible", { exact: false })).toBeInTheDocument();
    expect(section("Señales").getByText("Total desconocido", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Saludable|sin alertas abiertas/)).not.toBeInTheDocument();
    expect(section("Ejecuciones").getByText("Public execution")).toBeInTheDocument();
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("distinguishes missing optional records from a validated empty collection", async () => {
    const absent = source([], { availability: "absent", reason: "optional-absent", origin: null,
      observed_at: null, fresh_until: null, complete: false });
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ harness: absent, commitments: source([]) }));
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    expect(section("Harness").getByText("Sin registro opcional", { exact: false })).toBeInTheDocument();
    expect(section("Harness").getByText("Total desconocido", { exact: false })).toBeInTheDocument();
    expect(section("Compromisos").queryByText("Total desconocido", { exact: false })).not.toBeInTheDocument();
  });

  it("labels partial project coverage and its distribution as the visible page rather than an exact portfolio total", async () => {
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ projects: source(sources().projects!.items.slice(), { complete: false, reason: "coverage-incomplete" }) }));
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    expect(section("Proyectos").getByText("Total desconocido", { exact: false })).toBeInTheDocument();
    expect(section("Proyectos").getByText(/página visible/i)).toBeInTheDocument();
  });

  it("renders the overview when the independent protected editor source fails without surfacing private error details", async () => {
    vi.mocked(api.getOrganization).mockRejectedValue(new Error("PRIVATE-EDITOR-FAILURE C:\\operator\\secret.json token=private-value"));
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.queryByText(/PRIVATE-EDITOR-FAILURE|secret\.json|private-value/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar perfil" })).not.toBeInTheDocument();
  });

  it("retains the existing editors when the independent overview fails and only displays a fixed public error", async () => {
    vi.mocked(api.getOperatingOverview).mockRejectedValue(new Error("PRIVATE-OVERVIEW-FAILURE /operator/private/state.json"));
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await screen.findByRole("textbox", { name: "Misión" });
    expect(screen.getByRole("button", { name: "Guardar perfil" })).toBeEnabled();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.queryByText(/PRIVATE-OVERVIEW-FAILURE|state\.json/)).not.toBeInTheDocument();
  });

  it("does not invent production budget, continuity, recorded Harness validation, or accepted issue authority", async () => {
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    const budget = screen.getByRole("region", { name: "Presupuestos" });
    expect(budget.textContent).toMatch(/no habilitad|no activad|preview|previsualizaci[oó]n/i);
    expect(section("Presupuestos").getByText("Total desconocido", { exact: false })).toBeInTheDocument();
    expect(section("Harness").queryByText(/validación (?:aprobada|exitosa)/i)).not.toBeInTheDocument();
    expect(section("Ejecuciones").queryByText("Aceptada", { exact: true })).not.toBeInTheDocument();
    expect(section("Ejecuciones").getByText(/Tarea finalizada no equivale a issue aceptado/)).toBeInTheDocument();
    for (const name of [/autorizar/i, /despachar/i, /ejecutar/i, /reintentar/i, /activar presupuesto/i, /restaurar/i, /publicar/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(api.openProject).not.toHaveBeenCalled();
    expect(api.postSignalAction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves unsaved company and objective drafts when refreshing only operating reads", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Unsaved company draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Unsaved objective draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lectura" }));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Unsaved company draft");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Unsaved objective draft");
    expect(api.getOrganization).toHaveBeenCalledOnce();
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("preserves protected company saves and queues a fresh read when saving during an already pending projection read", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    const pendingRead = deferred<OperatingView>();
    vi.mocked(api.getOperatingOverview).mockImplementationOnce(() => pendingRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lectura" }));
    expect(api.getOperatingOverview).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre visible" }), { target: { value: "SURTEC changed" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Updated explicit mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar perfil" }));
    await waitFor(() => expect(api.saveCompanyProfile).toHaveBeenCalledOnce());
    expect(api.saveCompanyProfile).toHaveBeenCalledWith({ ...organization().company,
      display_name: "SURTEC changed", mission: "Updated explicit mission" });
    await screen.findByText("Perfil SURTEC guardado localmente.");
    expect(api.getOperatingOverview).toHaveBeenCalledTimes(2);
    await act(async () => pendingRead.resolve(model()));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(3));
    expect(api.getOperatingOverview).toHaveBeenLastCalledWith({ page_size: 6 });
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("does not present a failed explicit company save as success or expose raw mutation errors", async () => {
    vi.mocked(api.saveCompanyProfile).mockRejectedValue(new Error("PRIVATE-SAVE-FAILURE api_key=private-value C:\\secret\\state.json"));
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Retained after failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar perfil" }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.queryByText(/PRIVATE-SAVE-FAILURE|private-value|state\.json/)).not.toBeInTheDocument();
    expect(screen.queryByText("Perfil SURTEC guardado localmente.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Retained after failure");
    expect(api.getOperatingOverview).toHaveBeenCalledOnce();
  });

  it("keeps objective creation explicit and uses the existing protected helper before refreshing the read model", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "New explicit objective" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Resultado deseado" }), { target: { value: "New bounded outcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear objetivo" }));
    await waitFor(() => expect(api.createObjective).toHaveBeenCalledOnce());
    expect(api.createObjective).toHaveBeenCalledWith(expect.objectContaining({ title: "New explicit objective", desired_outcome: "New bounded outcome", status: "draft" }));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue(""));
  });

  it("navigates to exact public entity IDs without opening an editor or carrying model instructions", async () => {
    const onNavigate = vi.fn();
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={onNavigate} />);
    await ready();
    const links: Array<[string, unknown]> = [
      ["Ver proyecto Public alpha", { kind: "project", id: "alpha" }],
      ["Ver objetivo Public objective", { kind: "objective", id: "OBJ-1" }],
      ["Ver issues: Public decision", { kind: "issue", id: "ISS-1", projectId: "alpha" }],
      ["Ver tarea Public execution", { kind: "task", id: "T-1" }],
      ["Ver workflow Public workflow", { kind: "workflow", id: "WF-1", issueId: "ISS-1", projectId: "alpha" }],
      ["Ver compromisos", { kind: "section", section: "commitments" }],
      ["Ver sesiones", { kind: "section", section: "sessions" }],
    ];
    for (const [name, target] of links) {
      fireEvent.click(within(screen.getByRole("region", { name: "Overview operativo SURTEC" })).getByRole("button", { name }));
      expect(onNavigate).toHaveBeenLastCalledWith(target);
    }
    expect(onNavigate).toHaveBeenCalledTimes(links.length);
    expect(api.openProject).not.toHaveBeenCalled();
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.postSignalAction).not.toHaveBeenCalled();
  });

  it("does not offer workflow navigation when its exact issue link is unavailable", async () => {
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ workflows: source([fact("WF-2", "needs-decision", {
      label: "Unlinked workflow", project_id: "alpha", workflow_template_id: "analysis" })]) }));
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={vi.fn()} />);
    await ready();
    expect(section("Workflows").getByText("Unlinked workflow")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver workflow Unlinked workflow" })).not.toBeInTheDocument();
  });

  it("keeps personal projects useful without a required objective or client", async () => {
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ projects: source([fact("alpha", "active", {
      label: "Public alpha", project_kind: "personal" })]) }));
    const onNavigate = vi.fn();
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={onNavigate} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Ver proyecto Public alpha" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "project", id: "alpha" });
    expect(section("Proyectos").queryByText(/requiere cliente|objetivo obligatorio|ejecución denegada/i)).not.toBeInTheDocument();
  });

  it("replaces only the requested section page using its bound cursor and supports returning to the first page", async () => {
    const projects = source(Array.from({ length: 8 }, (_, index) => fact(`P-${String(index + 1).padStart(2, "0")}`, "active", {
      label: `Page project ${index + 1}`, project_kind: "personal" })));
    vi.mocked(api.getOperatingOverview).mockImplementation(async (query) => model({ projects }, query));
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={vi.fn()} />);
    await screen.findByRole("button", { name: "Ver proyecto Page project 1" });
    expect(section("Proyectos").getAllByRole("button", { name: /^Ver proyecto / })).toHaveLength(6);
    const first = model({ projects });
    const cursor = first.sections.find((item) => item.kind === "projects")!.next_cursor!;
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página de Proyectos" }));
    await screen.findByRole("button", { name: "Ver proyecto Page project 7" });
    expect(api.getOperatingOverview).toHaveBeenLastCalledWith({ page_size: 6, cursors: { projects: cursor } });
    expect(screen.queryByRole("button", { name: "Ver proyecto Page project 1" })).not.toBeInTheDocument();
    expect(section("Proyectos").getAllByRole("button", { name: /^Ver proyecto / })).toHaveLength(2);
    expect(section("Issues y decisiones").getByText("Public decision")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Primera página de Proyectos" }));
    await screen.findByRole("button", { name: "Ver proyecto Page project 1" });
    expect(screen.queryByRole("button", { name: "Ver proyecto Page project 7" })).not.toBeInTheDocument();
    expect(section("Proyectos").getAllByRole("button", { name: /^Ver proyecto / })).toHaveLength(6);
    const last = vi.mocked(api.getOperatingOverview).mock.calls.at(-1)?.[0];
    expect(last?.cursors?.projects).toBeUndefined();
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("does not dispatch a second refresh while the first read is pending", async () => {
    const pending = deferred<OperatingView>();
    vi.mocked(api.getOperatingOverview).mockResolvedValueOnce(model()).mockImplementationOnce(() => pending.promise);
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    const refresh = screen.getByRole("button", { name: "Actualizar lectura" });
    fireEvent.click(refresh); fireEvent.click(refresh);
    expect(api.getOperatingOverview).toHaveBeenCalledTimes(2);
    expect(refresh).toBeDisabled();
    await act(async () => pending.resolve(model()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Actualizar lectura" })).toBeEnabled());
  });

  it("discards a read from an unmounted overview instead of replacing a newly mounted view", async () => {
    const pending = deferred<OperatingView>();
    vi.mocked(api.getOperatingOverview).mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(model());
    const first = render(<OrganizationView projects={[]} profiles={{}} />);
    first.unmount();
    render(<OrganizationView projects={[]} profiles={{}} />);
    await ready();
    await act(async () => pending.resolve(model({ projects: source([fact("beta", "active", { label: "Superseded private view", project_kind: "personal" })]) })));
    expect(section("Proyectos").getByText("Public alpha")).toBeInTheDocument();
    expect(screen.queryByText("Superseded private view")).not.toBeInTheDocument();
  });

  it("does not import private raw fields into overview rows or navigation targets", async () => {
    const malformed = { ...fact("ISS-private", "needs-decision", { project_id: "alpha" }), confidential_notes: "PRIVATE-RAW-NOTE" };
    vi.mocked(api.getOperatingOverview).mockResolvedValue(model({ issues: source([malformed]) }));
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={vi.fn()} />);
    await ready();
    expect(screen.queryByText(/PRIVATE-RAW-NOTE|ISS-private/)).not.toBeInTheDocument();
    expect(section("Issues y decisiones").getByText("No disponible", { exact: false })).toBeInTheDocument();
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("retains the last valid page on cursor failure, reports only a public error, and retries the first page without that cursor", async () => {
    const projects = source(Array.from({ length: 8 }, (_, index) => fact(`P-${String(index + 1).padStart(2, "0")}`, "active", {
      label: `Cursor project ${index + 1}`, project_kind: "personal" })));
    vi.mocked(api.getOperatingOverview).mockImplementation(async (query) => {
      if (query?.cursors?.projects) throw new Error("PRIVATE-CURSOR-FAILURE C:\\secret\\record.json");
      return model({ projects }, query);
    });
    render(<OrganizationView projects={[]} profiles={{}} onNavigate={vi.fn()} />);
    await screen.findByRole("button", { name: "Ver proyecto Cursor project 1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página de Proyectos" }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/Se conserva la última lectura/);
    expect(warning).not.toHaveTextContent(/PRIVATE-CURSOR-FAILURE|record\.json/);
    expect(section("Proyectos").getAllByRole("button", { name: /^Ver proyecto / })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Ver proyecto Cursor project 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Primera página de Proyectos" }));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(3));
    expect(api.getOperatingOverview).toHaveBeenLastCalledWith({ page_size: 6 });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Ver proyecto Cursor project 1" })).toBeInTheDocument();
  });

  it("saves exact project links through the protected helper and queues a read without losing company or objective drafts", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Unsaved company alongside links" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Unsaved objective alongside links" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Editor objective · Activa" }));
    const pendingRead = deferred<OperatingView>();
    vi.mocked(api.getOperatingOverview).mockImplementationOnce(() => pendingRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lectura" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar vínculos" }));
    await waitFor(() => expect(api.saveProjectObjectiveLinks).toHaveBeenCalledExactlyOnceWith("alpha", {
      objective_ids: [], primary_objective_id: null,
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar vínculos" })).toBeEnabled());
    expect(api.getOperatingOverview).toHaveBeenCalledTimes(2);
    await act(async () => pendingRead.resolve(model()));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Unsaved company alongside links");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Unsaved objective alongside links");
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
  });

  it("edits an objective through saveObjective rather than creation, rereads its editor, and preserves an unrelated company draft", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Company draft stays private to editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar objetivo" }));
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Editor objective");
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Explicitly revised objective" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(api.saveObjective).toHaveBeenCalledExactlyOnceWith({
      ...organization().objectives[0]!, title: "Explicitly revised objective",
    }));
    await waitFor(() => expect(api.getOrganization).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(2));
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Company draft stays private to editor");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue(""));
  });

  it("retains successful objective-save evidence when rereading the editor fails instead of inviting a duplicate write", async () => {
    vi.mocked(api.getOrganization).mockResolvedValueOnce(organization()).mockRejectedValueOnce(new Error("PRIVATE-EDITOR-RELOAD /secret/record.json"));
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Persist exactly once" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Resultado deseado" }), { target: { value: "Keep the saved result separate from the read error" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear objetivo" }));
    await screen.findByText("Objetivo guardado en el estado local.");
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    for (const warning of screen.getAllByRole("alert")) {
      expect(warning).toHaveTextContent(/El objetivo se guardó, pero no se pudo releer el editor/);
      expect(warning).toHaveTextContent(/No repitas el guardado/);
      expect(warning).not.toHaveTextContent(/PRIVATE-EDITOR-RELOAD|record\.json/);
    }
    expect(api.createObjective).toHaveBeenCalledOnce();
    expect(api.saveObjective).not.toHaveBeenCalled();
    expect(screen.getByText("Objetivo guardado en el estado local.")).toBeInTheDocument();
    await waitFor(() => expect(api.getOperatingOverview).toHaveBeenCalledTimes(2));
  });

  it("focuses the exact requested objective detail while retaining its selected card and never substitutes another unavailable objective", async () => {
    const view = render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" />);
    await ready();
    await waitFor(() => expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Public desired outcome"));
    const card = document.getElementById("organization-objective-OBJ-1")!;
    expect(card).toHaveClass("organization-objective-card--selected");
    expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveFocus();
    expect(within(screen.getByRole("region", { name: "Detalle de objetivo" })).getByText(/Objetivo seleccionado: OBJ-1\./)).toBeInTheDocument();
    view.rerender(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-missing" />);
    expect(card).not.toHaveClass("organization-objective-card--selected");
    await waitFor(() => expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("El objetivo no está en la fuente validada."));
    expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Objetivo seleccionado: OBJ-missing.");
    expect(screen.getByRole("region", { name: "Detalle de objetivo" })).not.toHaveTextContent("Public desired outcome");
    expect(document.querySelectorAll(".organization-objective-card--selected")).toHaveLength(0);
    expect(api.getOperatingOverview).toHaveBeenCalledOnce();
    expect(api.getOperatingObjective).toHaveBeenNthCalledWith(1, "OBJ-1", { page_size: 8 });
    expect(api.getOperatingObjective).toHaveBeenNthCalledWith(2, "OBJ-missing", { page_size: 8 });
  });

  it("opens and closes local objective detail without resetting company, objective or link-editor drafts", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Unsaved company while inspecting objective" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Unsaved objective while inspecting evidence" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Editor objective · Activa" }));
    const primary = screen.getByRole("combobox", { name: "Objetivo principal" });
    expect(primary).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Editor objective · Activa" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de objetivo Editor objective" }));
    const panel = await screen.findByRole("region", { name: "Detalle de objetivo" });
    await waitFor(() => expect(panel).toHaveTextContent("Public desired outcome"));
    expect(panel).toHaveFocus();
    expect(api.getOperatingObjective).toHaveBeenCalledExactlyOnceWith("OBJ-1", { page_size: 8 });
    fireEvent.click(within(panel).getByRole("button", { name: "Cerrar detalle de objetivo" }));
    expect(screen.queryByRole("region", { name: "Detalle de objetivo" })).not.toBeInTheDocument();
    expect(document.getElementById("organization-objective-OBJ-1")).toHaveFocus();
    expect(document.querySelectorAll(".organization-objective-card--selected")).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Unsaved company while inspecting objective");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Unsaved objective while inspecting evidence");
    expect(screen.getByRole("checkbox", { name: "Editor objective · Activa" })).not.toBeChecked();
    expect(primary).toHaveValue("");
    expect(api.getOrganization).toHaveBeenCalledOnce();
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.saveObjective).not.toHaveBeenCalled();
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.saveProjectObjectiveLinks).not.toHaveBeenCalled();
    expect(api.openProject).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests controlled detail closure through its callback without silently selecting another objective", async () => {
    const close = vi.fn(), navigate = vi.fn();
    const view = render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" onCloseObjective={close} onNavigate={navigate} />);
    await ready();
    const panel = screen.getByRole("region", { name: "Detalle de objetivo" });
    await waitFor(() => expect(panel).toHaveTextContent("Public desired outcome"));
    fireEvent.click(within(panel).getByRole("button", { name: "Cerrar detalle de objetivo" }));
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(api.getOperatingObjective).toHaveBeenCalledExactlyOnceWith("OBJ-1", { page_size: 8 });
    expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Objetivo seleccionado: OBJ-1.");
    view.rerender(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId={null} onCloseObjective={close} onNavigate={navigate} />);
    expect(screen.queryByRole("region", { name: "Detalle de objetivo" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".organization-objective-card--selected")).toHaveLength(0);
    expect(api.getOperatingOverview).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps exact objective detail available independently when the organization editor source fails", async () => {
    vi.mocked(api.getOrganization).mockRejectedValue(new Error("PRIVATE-EDITOR-SOURCE C:\\secret\\organization.json api_key=private-value"));
    render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" />);
    await ready();
    const panel = screen.getByRole("region", { name: "Detalle de objetivo" });
    await waitFor(() => expect(panel).toHaveTextContent("Public desired outcome"));
    expect(panel).toHaveTextContent("OBJ-1");
    expect(api.getOperatingObjective).toHaveBeenCalledExactlyOnceWith("OBJ-1", { page_size: 8 });
    expect(screen.queryByRole("button", { name: "Guardar perfil" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/PRIVATE-EDITOR-SOURCE|organization\.json|private-value/);
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps objective detail independent from an unavailable overview without replacing unsaved editors", async () => {
    vi.mocked(api.getOperatingOverview).mockRejectedValue(new Error("PRIVATE-OVERVIEW-SOURCE /secret/overview.json"));
    render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" />);
    const mission = await screen.findByRole("textbox", { name: "Misión" });
    fireEvent.change(mission, { target: { value: "Independent editor draft" } });
    const panel = screen.getByRole("region", { name: "Detalle de objetivo" });
    await waitFor(() => expect(panel).toHaveTextContent("Public desired outcome"));
    expect(mission).toHaveValue("Independent editor draft");
    expect(panel).toHaveTextContent("OBJ-1");
    expect(api.getOperatingObjective).toHaveBeenCalledExactlyOnceWith("OBJ-1", { page_size: 8 });
    expect(document.body).not.toHaveTextContent(/PRIVATE-OVERVIEW-SOURCE|overview\.json/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates detail after a successful explicit objective save while retaining unrelated drafts and normalized reread errors", async () => {
    vi.mocked(api.getOrganization).mockResolvedValueOnce(organization()).mockRejectedValueOnce(new Error("PRIVATE-SAVED-EDITOR-READ C:\\secret\\saved.json"));
    render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" />);
    await ready();
    await waitFor(() => expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Public desired outcome"));
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Company draft survives objective invalidation" } });
    fireEvent.click(screen.getByRole("button", { name: "Editar objetivo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Explicit revised objective with detail" } });
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => objectiveModel(id, { objectives: source([
      fact("OBJ-1", "active", { label: "Revised public objective", summary: "Reread after explicit save", criteria: ["New public criterion"] }),
    ]) }, query));
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(api.saveObjective).toHaveBeenCalledExactlyOnceWith({ ...organization().objectives[0]!, title: "Explicit revised objective with detail" }));
    await waitFor(() => expect(api.getOperatingObjective).toHaveBeenCalledTimes(2));
    expect(api.getOperatingObjective).toHaveBeenLastCalledWith("OBJ-1", { page_size: 8 });
    await waitFor(() => expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Reread after explicit save"));
    await screen.findByText("Objetivo guardado en el estado local.");
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Company draft survives objective invalidation");
    expect(document.body).not.toHaveTextContent(/PRIVATE-SAVED-EDITOR-READ|saved\.json/);
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.saveProjectObjectiveLinks).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates detail after saving exact project links without an extra mutation or loss of unrelated drafts", async () => {
    render(<OrganizationView projects={[project]} profiles={{}} focusedObjectiveId="OBJ-1" />);
    await ready();
    await waitFor(() => expect(screen.getByRole("region", { name: "Detalle de objetivo" })).toHaveTextContent("Public desired outcome"));
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Company draft survives link invalidation" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Objective draft survives link invalidation" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Editor objective · Activa" }));
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => objectiveModel(id, { projects: source([]) }, query));
    fireEvent.click(screen.getByRole("button", { name: "Guardar vínculos" }));
    await waitFor(() => expect(api.saveProjectObjectiveLinks).toHaveBeenCalledExactlyOnceWith("alpha", { objective_ids: [], primary_objective_id: null }));
    await waitFor(() => expect(api.getOperatingObjective).toHaveBeenCalledTimes(2));
    expect(api.getOperatingObjective).toHaveBeenLastCalledWith("OBJ-1", { page_size: 8 });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Detalle de objetivo" })).getByRole("region", { name: "Proyectos vinculados" })).not.toHaveTextContent("Public alpha"));
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Company draft survives link invalidation");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Objective draft survives link invalidation");
    expect(api.saveCompanyProfile).not.toHaveBeenCalled();
    expect(api.saveObjective).not.toHaveBeenCalled();
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards an older objective editor reread after a later explicit company save instead of replacing the newer snapshot or drafts", async () => {
    const olderEditorRead = deferred<OrganizationSnapshot>();
    vi.mocked(api.getOrganization).mockResolvedValueOnce(organization()).mockImplementationOnce(() => olderEditorRead.promise);
    render(<OrganizationView projects={[project]} profiles={{}} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Editar objetivo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Objective saved before company" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByText("Objetivo guardado en el estado local.");
    await waitFor(() => expect(api.getOrganization).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre visible" }), { target: { value: "Newer SURTEC snapshot" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Saved mission while older editor read is pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar perfil" }));
    await screen.findByText("Perfil SURTEC guardado localmente.");
    expect(api.saveCompanyProfile).toHaveBeenCalledExactlyOnceWith({ ...organization().company,
      display_name: "Newer SURTEC snapshot", mission: "Saved mission while older editor read is pending" });
    expect(screen.getByRole("heading", { name: "Newer SURTEC snapshot" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Misión" }), { target: { value: "Even newer unsaved company draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Título" }), { target: { value: "Even newer unsaved objective draft" } });
    await act(async () => olderEditorRead.resolve(organization()));
    expect(screen.getByRole("heading", { name: "Newer SURTEC snapshot" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Nombre visible" })).toHaveValue("Newer SURTEC snapshot");
    expect(screen.getByRole("textbox", { name: "Misión" })).toHaveValue("Even newer unsaved company draft");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Even newer unsaved objective draft");
    expect(api.saveObjective).toHaveBeenCalledExactlyOnceWith({ ...organization().objectives[0]!, title: "Objective saved before company" });
    expect(api.createObjective).not.toHaveBeenCalled();
    expect(api.getOrganization).toHaveBeenCalledTimes(2);
  });
});
