// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { projectOperatingView, type OperatingFact, type OperatingSectionKind, type OperatingSourceInput, type OperatingView } from "../../../../lib/operating-views";
import * as api from "../api";
import { ObjectiveDetailPanel } from "./ObjectiveDetailPanel";

const observedAt = "2026-10-16T11:00:00.000Z";
const generatedAt = "2026-10-16T12:00:00.000Z";
const freshUntil = "2026-10-16T13:00:00.000Z";
type Overrides = Partial<Record<OperatingSectionKind, unknown>>;

function fact(id: string, state: string | null, fields: Partial<OperatingFact> = {}): OperatingFact {
  return { id, label: `Public ${id}`, state, ...fields };
}
function source(items: OperatingFact[] = [], fields: Partial<OperatingSourceInput> = {}): OperatingSourceInput {
  return { availability: "available", reason: "observed", origin: "saved", observed_at: observedAt,
    fresh_until: freshUntil, complete: true, items, ...fields };
}
function sources(): Record<OperatingSectionKind, OperatingSourceInput> {
  return {
    company: source([fact("surtec", null, { summary: "Public company context" })]),
    objectives: source([
      fact("root", "active", { label: "Root strategy" }),
      fact("obj-a", "active", { label: "Focused outcome", parent_objective_id: "root", summary: "Useful outcome",
        criteria: ["Observable criterion"], target_date: "2026-12-31", reviewed_on: "2026-10-15" }),
      fact("child", "active", { label: "Child contribution", parent_objective_id: "obj-a" }),
      fact("obj-b", "paused", { label: "Other objective" }),
    ]),
    projects: source([fact("alpha", "active", { label: "Linked alpha", project_kind: "surtec-product",
      objective_ids: ["obj-a", "obj-b"], primary_objective_id: "obj-a" })]),
    issues: source([
      fact("issue-a", "working", { label: "Exact issue", project_id: "alpha", objective_id: "obj-a" }),
      fact("issue-b", "blocked", { label: "Other objective issue", project_id: "alpha", objective_id: "obj-b", decision_reason: "dependency-blocked" }),
    ]),
    executions: source([fact("task-a", "finished", { label: "Related execution", project_id: "alpha", issue_id: "issue-a",
      result_status: "completed", evidence_ids: ["evidence-a"], candidate_validity: "unknown" })]),
    workflows: source([fact("workflow-a", "waiting-human", { label: "Related workflow", project_id: "alpha", issue_id: "issue-a",
      workflow_template_id: "implementation", stage_kind: "planning" })]),
    signals: source([fact("signal-a", "open", { label: "Related signal", project_id: "alpha", issue_id: "issue-a" })]),
    commitments: source([fact("commitment-a", "planned", { label: "Primary commitment", project_id: "alpha", target_date: "2026-11-01" })]),
    harness: source([fact("harness-a", "healthy", { label: "Saved Harness", project_id: "alpha", validation_status: "unknown" })]),
    sessions: source([fact("session-a", "active", { label: "Saved session", project_id: "alpha" })]),
    budgets: source([fact("budget-a", "unknown", { label: "Budget diagnostic", project_id: "alpha" })]),
  };
}
function model(id = "obj-a", overrides: Overrides = {}, query: api.OperatingPageQuery = {}): OperatingView {
  return projectOperatingView({ schema_version: 1, as_of: generatedAt, sources: { ...sources(), ...overrides } },
    { kind: "objective", id, page_size: 8, ...query });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function detail() { return screen.getByRole("region", { name: "Detalle de objetivo" }); }
function section(name: string) { return screen.getByRole("region", { name }); }
async function ready(value = "Useful outcome") {
  await waitFor(() => expect(detail()).toHaveTextContent(value));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected effect request")));
  vi.spyOn(api, "getOperatingObjective").mockImplementation(async (id, query) => model(id, {}, query));
  vi.spyOn(api, "openProject").mockResolvedValue(undefined);
  vi.spyOn(api, "getSignals").mockRejectedValue(new Error("Provider reads are forbidden"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ObjectiveDetailPanel bounded operating evidence", () => {
  it("loads only the exact objective projection and keeps the required detail sections independent", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(api.getOperatingObjective).toHaveBeenCalledExactlyOnceWith("obj-a", { page_size: 8 });
    for (const name of ["Resultado y criterios", "Ancestría canónica", "Salud explicada", "Siguiente paso seguro"]) {
      expect(within(detail()).getByRole("heading", { name })).toBeInTheDocument();
    }
    for (const name of ["Objetivos relacionados", "Proyectos vinculados", "Issues del objetivo", "Ejecuciones y evidencia",
      "Workflows del objetivo", "Compromisos relacionados", "Señales del objetivo", "Harness de proyectos", "Sesiones relacionadas", "Diagnóstico de presupuesto"]) {
      expect(section(name)).toBeInTheDocument();
    }
    expect(detail()).toHaveTextContent("obj-a");
    expect(detail()).toHaveTextContent("Observable criterion");
    expect(detail()).toHaveTextContent("2026-12-31");
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders canonical root-to-focus ancestry without promoting a descendant to the selected outcome", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Objetivos relacionados")).toHaveTextContent("Child contribution");
    expect(section("Objetivos relacionados")).toHaveTextContent("Root strategy");
    const ancestry = within(detail()).getByRole("heading", { name: "Ancestría canónica" }).parentElement!;
    expect(ancestry).toHaveTextContent("root");
    expect(ancestry).toHaveTextContent("obj-a");
    expect(ancestry.textContent!.indexOf("root")).toBeLessThan(ancestry.textContent!.lastIndexOf("obj-a"));
    expect(ancestry).not.toHaveTextContent("Child contribution");
  });

  it("uses exact issue contribution despite a project's secondary objective link", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-b" />);
    await ready("Other objective");
    expect(section("Proyectos vinculados")).toHaveTextContent("Linked alpha");
    expect(section("Issues del objetivo")).toHaveTextContent("Other objective issue");
    expect(section("Issues del objetivo")).not.toHaveTextContent("Exact issue");
    expect(section("Ejecuciones y evidencia")).not.toHaveTextContent("Related execution");
    expect(section("Compromisos relacionados")).not.toHaveTextContent("Primary commitment");
    expect(section("Compromisos relacionados")).toHaveTextContent(/principal|canónic|relaci/i);
  });

  it("deduplicates a project linked to both a parent and its descendant", async () => {
    const projects = source([fact("alpha", "active", { label: "One contribution", project_kind: "surtec-product",
      objective_ids: ["obj-a", "child"], primary_objective_id: "obj-a" })]);
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, { projects }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(within(section("Proyectos vinculados")).getAllByText("One contribution")).toHaveLength(1);
    expect(section("Proyectos vinculados")).not.toHaveTextContent(/\d+\s*%/);
  });

  it.each([
    ["cycle", source([fact("obj-a", "active", { parent_objective_id: "parent" }), fact("parent", "active", { parent_objective_id: "obj-a" })]), /ciclo|cycle/i],
    ["missing parent", source([fact("obj-a", "active", { parent_objective_id: "missing-parent" })]), /no disponible|incomplet|unavailable/i],
    ["depth", source(Array.from({ length: 9 }, (_, index) => fact(`obj-${index}`, "active", { parent_objective_id: index < 8 ? `obj-${index + 1}` : null }))), /profundidad|depth|ocho|8/i],
  ] as const)("preserves the %s ancestry gap without fabricating health", async (_name, objectives, expected) => {
    const id = _name === "depth" ? "obj-0" : "obj-a";
    vi.mocked(api.getOperatingObjective).mockImplementation(async (focus, query) => model(focus, { objectives }, query));
    render(<ObjectiveDetailPanel objectiveId={id} />);
    await ready(id);
    await waitFor(() => expect(detail()).toHaveTextContent(expected));
    expect(detail()).not.toHaveTextContent(/Saludable|100\s*%/i);
  });

  it("keeps a focus outside the first eight rows explicit and replaces pages without substituting a child", async () => {
    const objectives = source([
      ...Array.from({ length: 10 }, (_, index) => fact(`A-${String(index).padStart(2, "0")}`, "active", { parent_objective_id: "Z-focus", summary: "Not the selected outcome" })),
      fact("Z-focus", "active", { label: "Exact last focus", summary: "Exact last outcome", criteria: ["Exact last criterion"] }),
    ]);
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, { objectives }, query));
    render(<ObjectiveDetailPanel objectiveId="Z-focus" />);
    await waitFor(() => expect(section("Objetivos relacionados")).toHaveTextContent("Public A-00"));
    const outcome = within(detail()).getByRole("heading", { name: "Resultado y criterios" }).parentElement!;
    expect(outcome).not.toHaveTextContent("Not the selected outcome");
    expect(detail()).toHaveTextContent(/página|paginad/i);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página de Objetivos relacionados" }));
    await ready("Exact last outcome");
    expect(section("Objetivos relacionados")).not.toHaveTextContent("Public A-00");
    expect(api.getOperatingObjective).toHaveBeenLastCalledWith("Z-focus", { page_size: 8, cursors: { objectives: expect.any(String) } });
    fireEvent.click(screen.getByRole("button", { name: "Primera página de Objetivos relacionados" }));
    await waitFor(() => expect(section("Objetivos relacionados")).toHaveTextContent("Public A-00"));
    expect(section("Objetivos relacionados")).not.toHaveTextContent("Exact last focus");
  });

  it("keeps partial exhausted totals unknown instead of showing an empty or zero inventory", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      issues: source([], { complete: false, reason: "coverage-incomplete" }),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Issues del objetivo")).toHaveTextContent(/Total desconocido/i);
    expect(section("Issues del objetivo")).toHaveTextContent(/parcial|incompleta/i);
    expect(section("Issues del objetivo")).not.toHaveTextContent(/0 en total|sin bloqueos confirmados|inventario vacío/i);
  });

  it("does not relabel an all-state section total as a count of active or blocked issues", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, { issues: source([
      fact("i-active", "working", { project_id: "alpha", objective_id: "obj-a" }),
      fact("i-blocked", "blocked", { project_id: "alpha", objective_id: "obj-a", decision_reason: "dependency-blocked" }),
      fact("i-cancelled", "cancelled", { project_id: "alpha", objective_id: "obj-a" }),
      fact("i-done", "done", { project_id: "alpha", objective_id: "obj-a" }),
    ]) }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Issues del objetivo")).toHaveTextContent("4 en total");
    expect(section("Issues del objetivo")).not.toHaveTextContent(/4\s+(?:activ[oa]s|bloquead[oa]s)/i);
    expect(detail()).not.toHaveTextContent(/\d+\s*%/);
  });

  it("renders unknown candidate validity and bounded evidence IDs without treating task completion as acceptance", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    const executions = section("Ejecuciones y evidencia");
    expect(executions).toHaveTextContent("evidence-a");
    expect(executions).toHaveTextContent(/desconocid|unknown/i);
    expect(executions).toHaveTextContent(/finalizada.*no|completad.*no|no.*aceptad/i);
    expect(executions).not.toHaveTextContent(/más recientes|candidato vigente|issue aceptado: sí/i);
  });

  it.each(["proposed", "authorized", "cancelled"])("retains %s without promoting it to accepted work", async (state) => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, { issues: source([
      fact("issue-state", state, { project_id: "alpha", objective_id: "obj-a" }),
    ]) }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Issues del objetivo")).toHaveTextContent(state);
    expect(section("Issues del objetivo")).not.toHaveTextContent(/Aceptada|\bDone\b/);
  });

  it("retains exact decision reasons and an explicit evidence gap when the source cannot classify one", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, { issues: source([
      fact("issue-budget", "needs-decision", { project_id: "alpha", objective_id: "obj-a", decision_reason: "budget-exhausted" }),
      fact("issue-gap", "blocked", { project_id: "alpha", objective_id: "obj-a" }),
    ]) }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Issues del objetivo")).toHaveTextContent(/Presupuesto agotado/i);
    expect(section("Issues del objetivo")).toHaveTextContent(/evidencia.*motivo|motivo.*evidencia|evidence-gap/i);
    expect(screen.queryByRole("button", { name: /autorizar|reintentar|ejecutar|reanudar/i })).not.toBeInTheDocument();
  });

  it("separates saved review dates, observed source time and generated projection time", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      objectives: source(sources().objectives.items.slice(), { fresh_until: "2026-10-16T11:30:00.000Z" }),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(detail()).toHaveTextContent("2026-10-15");
    expect(detail()).toHaveTextContent(observedAt);
    expect(detail()).toHaveTextContent(generatedAt);
    expect(section("Objetivos relacionados")).toHaveTextContent(/Desactualizada/i);
    expect(detail()).not.toHaveTextContent("2026-10-15T00:00:00");
  });

  it("does not turn unavailable signals and unknown freshness into healthy or zero-alert claims", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      signals: undefined,
      objectives: source(sources().objectives.items.slice(), { observed_at: null, fresh_until: null }),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Señales del objetivo")).toHaveTextContent(/No disponible|no disponible/);
    expect(section("Objetivos relacionados")).toHaveTextContent(/Frescura desconocida/i);
    expect(detail()).not.toHaveTextContent(/Saludable|sin alertas|0 alertas|100\s*%/i);
  });

  it("explains a complete fresh read with no observed gaps without claiming progress or permission", async () => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      workflows: source([fact("workflow-a", "completed", { label: "Completed workflow", project_id: "alpha", issue_id: "issue-a", workflow_template_id: "implementation" })]),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Salud explicada")).toHaveTextContent("Sin brechas observadas en esta lectura");
    expect(section("Salud explicada")).not.toHaveTextContent(/Atención en evidencia visible|Saludable|100\s*%/i);
    expect(section("Issues del objetivo")).toHaveTextContent("En trabajo");
    expect(section("Issues del objetivo")).not.toHaveTextContent(/Aceptad[oa]|\bDone\b/);
    expect(screen.queryByRole("button", { name: /autorizar|ejecutar|aceptar|publicar/i })).not.toBeInTheDocument();
  });

  it.each(["workflow", "execution"] as const)("includes a %s decision in explained health even while its issue is working", async (kind) => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      workflows: source([fact("workflow-a", kind === "workflow" ? "waiting-human" : "completed", {
        label: "Unclassified workflow gate", project_id: "alpha", issue_id: "issue-a", workflow_template_id: "implementation", stage_kind: "planning",
      })]),
      executions: source([fact("task-a", "finished", { label: "Execution needs review", project_id: "alpha", issue_id: "issue-a",
        result_status: kind === "execution" ? "needs-review" : "completed" })]),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" onNavigate={vi.fn()} />);
    await ready();
    expect(section("Issues del objetivo")).toHaveTextContent("En trabajo");
    expect(section("Salud explicada")).toHaveTextContent("Atención en evidencia visible");
    expect(section("Salud explicada")).toHaveTextContent(kind === "workflow" ? "Unclassified workflow gate" : "Execution needs review");
    expect(section("Siguiente paso seguro")).toHaveTextContent("La evidencia no clasifica el motivo");
    expect(section("Issues del objetivo")).not.toHaveTextContent(/Aceptad[oa]|\bDone\b/);
    expect(screen.queryByRole("button", { name: /autorizar|ejecutar|aceptar|publicar/i })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", "Pausado"], ["cancelled", "Cancelado"], ["achieved", "Logrado"],
  ] as const)("keeps objective %s as a recorded state rather than accepted issue work", async (state, label) => {
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      objectives: source(sources().objectives.items.map(row => row.id === "obj-a" ? { ...row, state } : row)),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Resultado y criterios")).toHaveTextContent(`Estado registrado: ${label}`);
    expect(section("Issues del objetivo")).toHaveTextContent("En trabajo");
    expect(section("Issues del objetivo")).not.toHaveTextContent(/Aceptad[oa]|\bDone\b/);
    expect(section("Salud explicada")).not.toHaveTextContent(/Saludable|100\s*%/i);
    expect(screen.queryByRole("button", { name: /aceptar|publicar|autorizar/i })).not.toBeInTheDocument();
  });

  it("keeps recorded Harness validation distinct from healthy presence and Phase P disabled", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    expect(section("Harness de proyectos")).toHaveTextContent(/desconocid|unknown/i);
    expect(section("Diagnóstico de presupuesto")).toHaveTextContent(/no habilitad/i);
    expect(detail()).toHaveTextContent(/diferida|deferred/i);
    expect(screen.queryByRole("button", { name: /aplicar|activar|backup|restore|restaurar/i })).not.toBeInTheDocument();
  });

  it("navigates exact public references without editor launch, provider reads or implicit mutation", async () => {
    const navigate = vi.fn();
    render(<ObjectiveDetailPanel objectiveId="obj-a" onNavigate={navigate} />);
    await ready();
    const cases = [
      ["Ver proyecto Linked alpha", { kind: "project", id: "alpha" }],
      ["Ver issues: Exact issue", { kind: "issue", id: "issue-a", projectId: "alpha" }],
      ["Ver tarea Related execution", { kind: "task", id: "task-a" }],
      ["Ver workflow Related workflow", { kind: "workflow", id: "workflow-a", issueId: "issue-a", projectId: "alpha" }],
      ["Ver compromisos", { kind: "section", section: "commitments" }],
    ] as const;
    for (const [label, target] of cases) {
      fireEvent.click(screen.getAllByRole("button", { name: label })[0]!);
      expect(navigate).toHaveBeenLastCalledWith(target);
    }
    expect(api.openProject).not.toHaveBeenCalled();
    expect(api.getSignals).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(navigate.mock.calls)).not.toMatch(/instruction|permission|grant|token/i);
  });

  it("closes only through the explicit callback", async () => {
    const close = vi.fn();
    render(<ObjectiveDetailPanel objectiveId="obj-a" onClose={close} />);
    await ready();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle de objetivo" }));
    expect(close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains project navigation when a different entity kind shares the objective identifier", async () => {
    const navigate = vi.fn();
    vi.mocked(api.getOperatingObjective).mockImplementation(async (id, query) => model(id, {
      objectives: source([fact("alpha", "active", { label: "Exact alpha objective", summary: "Distinct entity namespaces", criteria: ["Preserve exact navigation"] })]),
      projects: source([fact("alpha", "active", { label: "Same identifier project", objective_ids: ["alpha"], primary_objective_id: "alpha" })]),
      issues: source([]),
    }, query));
    render(<ObjectiveDetailPanel objectiveId="alpha" onNavigate={navigate} />);
    await ready("Distinct entity namespaces");
    fireEvent.click(within(section("Proyectos vinculados")).getByRole("button", { name: "Ver proyecto Same identifier project" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "project", id: "alpha" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a failed initial read without exposing private errors or guessing a missing objective", async () => {
    vi.mocked(api.getOperatingObjective).mockRejectedValue(new Error("PRIVATE-READ-FAILURE D:\\private\\state.json status 404"));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(detail()).toHaveTextContent("obj-a");
    expect(detail()).not.toHaveTextContent(/PRIVATE-READ-FAILURE|private|404|no existe|no encontrado/i);
    expect(detail()).not.toHaveTextContent("Useful outcome");
  });

  it("renders an explicitly unavailable focus without substituting overview or another objective", async () => {
    vi.mocked(api.getOperatingObjective).mockResolvedValue(model("obj-a", { objectives: undefined }));
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await waitFor(() => expect(detail()).toHaveTextContent(/no disponible|no se pudo/i));
    expect(detail()).not.toHaveTextContent("Useful outcome");
    expect(detail()).not.toHaveTextContent("Linked alpha");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a failed refresh's same-focus snapshot explicitly unconfirmed and clears the error after retry", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    vi.mocked(api.getOperatingObjective).mockRejectedValueOnce(new Error("PRIVATE-REREAD-FAILURE"));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar objetivo" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(detail()).toHaveTextContent("Useful outcome");
    expect(detail()).toHaveTextContent(/no confirmada|sin confirmar/i);
    expect(detail()).not.toHaveTextContent("PRIVATE-REREAD-FAILURE");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar objetivo" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.getOperatingObjective).toHaveBeenCalledTimes(3);
  });

  it("coalesces double-click refreshes while the same read is pending", async () => {
    render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    const pending = deferred<OperatingView>();
    vi.mocked(api.getOperatingObjective).mockImplementationOnce(() => pending.promise);
    const refresh = screen.getByRole("button", { name: "Actualizar objetivo" });
    fireEvent.click(refresh); fireEvent.click(refresh);
    expect(api.getOperatingObjective).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(model()));
    expect(api.getOperatingObjective).toHaveBeenCalledTimes(2);
  });

  it("discards reverse A-to-B responses and never renders the former objective's rows in the new focus", async () => {
    const a = deferred<OperatingView>(), b = deferred<OperatingView>();
    vi.mocked(api.getOperatingObjective).mockImplementation((id) => id === "obj-a" ? a.promise : b.promise);
    const mounted = render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    mounted.rerender(<ObjectiveDetailPanel objectiveId="obj-b" />);
    await act(async () => b.resolve(model("obj-b")));
    await ready("Other objective");
    expect(section("Issues del objetivo")).toHaveTextContent("Other objective issue");
    await act(async () => a.resolve(model()));
    expect(detail()).not.toHaveTextContent("Useful outcome");
    expect(section("Issues del objetivo")).not.toHaveTextContent("Exact issue");
    expect(section("Issues del objetivo")).toHaveTextContent("Other objective issue");
  });

  it("clears a previously loaded focus immediately while a new focus is pending or fails", async () => {
    const pending = deferred<OperatingView>();
    const mounted = render(<ObjectiveDetailPanel objectiveId="obj-a" />);
    await ready();
    vi.mocked(api.getOperatingObjective).mockImplementationOnce(() => pending.promise);
    mounted.rerender(<ObjectiveDetailPanel objectiveId="obj-b" />);
    expect(detail()).not.toHaveTextContent("Useful outcome");
    expect(detail()).not.toHaveTextContent("Related execution");
    await act(async () => pending.reject(new Error("PRIVATE-OTHER-FOCUS")));
    expect(detail()).not.toHaveTextContent("Useful outcome");
    expect(detail()).not.toHaveTextContent("PRIVATE-OTHER-FOCUS");
  });

  it("rereads after a protected editor refresh key changes without running another action", async () => {
    const mounted = render(<ObjectiveDetailPanel objectiveId="obj-a" refreshKey={0} />);
    await ready();
    mounted.rerender(<ObjectiveDetailPanel objectiveId="obj-a" refreshKey={1} />);
    await waitFor(() => expect(api.getOperatingObjective).toHaveBeenCalledTimes(2));
    expect(api.getOperatingObjective).toHaveBeenLastCalledWith("obj-a", { page_size: 8 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a pending response after unmount without another read or navigation", async () => {
    const pending = deferred<OperatingView>(), navigate = vi.fn();
    vi.mocked(api.getOperatingObjective).mockImplementationOnce(() => pending.promise);
    const mounted = render(<ObjectiveDetailPanel objectiveId="obj-a" onNavigate={navigate} />);
    mounted.unmount();
    await act(async () => pending.resolve(model()));
    expect(screen.queryByRole("region", { name: "Detalle de objetivo" })).not.toBeInTheDocument();
    expect(api.getOperatingObjective).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
