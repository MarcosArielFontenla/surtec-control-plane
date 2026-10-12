// @vitest-environment jsdom
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { serve } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import type { ViteDevServer } from "vite";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../../lib/budgets/types";
import { readBudgetPolicy } from "../../../../lib/budgets/policy";
import type { OrganizationSnapshot } from "../../../../lib/organization";
import { ROUTINE_ACTIONS, type RoutineRecord } from "../../../../lib/routines/types";
import { routineRevisionKey, routineSlotKey } from "../../../../lib/routines/schedule";
import { readRoutineDocument } from "../../../../lib/state/routines";
import { readBudgetLedger } from "../../../../lib/state/budgets";
import { budgetStatePath, routineStatePath } from "../../../../lib/state/paths";
import type { ProjectView } from "../../../../lib/state/types";
import type { ProcessManager } from "../../../../runner/process-manager";
import { RoutineRunner } from "../../../../runner/routine-runner";
import { createApp, type AppDependencies } from "../../server/index";
import { createHttpSecurity } from "../../server/http-security";
import { createRoutineService, type RoutineDetail, type RoutineList, type RoutineOccurrenceSummary } from "../../server/routine-service";
import * as api from "../api";
import { RoutinePanel } from "./RoutinePanel";

const at = new Date(Date.now() - 60000).toISOString(), fingerprint = "a".repeat(64);
const projects = [{ id: "alpha", configured: true }, { id: "beta", configured: true }] as ProjectView[];
const companyScope = { kind: "company", id: "surtec" } as const;
function organization(): OrganizationSnapshot {
  return { company: { schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: null,
    operating_principles: [], active_objective_ids: ["synthetic-objective"], last_reviewed_at: null },
  objectives: [{ schema_version: 1, id: "synthetic-objective", company_id: "surtec", title: "Synthetic objective",
    desired_outcome: "Inspect bounded evidence", success_criteria: [], status: "active", horizon: "ongoing", priority: 1,
    target_date: null, parent_objective_id: null, project_ids: ["alpha"], owner: "marcos", last_reviewed_at: null }],
  project_objectives: { alpha: { objective_ids: ["synthetic-objective"], primary_objective_id: "synthetic-objective" } } };
}
function record(id = "routine-alpha", revision = 2, enabled = true): RoutineRecord {
  return { schema_version: 1, id, revision, action: "refresh-evidence", scope: companyScope, enabled, schedule: null,
    schedule_anchor_at: null, concurrency: "skip", catch_up: "skip-missed", policy: { revision: 1, fingerprint, policy_ids: ["company-policy"] },
    limits: { max_projects: 25, max_attempts: 1, max_runtime_ms: 60000, max_concurrent_occurrences: 1 }, created_at: at, updated_at: at };
}
function detail(id = "routine-alpha", revision = 2, execution: RoutineDetail["execution"]["state"] = "inactive"): RoutineDetail {
  return { routine: record(id, revision), occurrences: [], last_occurrence: null, next_slot: null, occurrences_total: 0,
    execution: { state: execution, executable: false } };
}
function listing(values: RoutineDetail[] = [detail()]): RoutineList {
  return { schema_version: 1, state: values.length ? "available" : "absent", observed_at: at,
    revision: values.length ? 1 : null, routines: values.map(({ routine, last_occurrence, next_slot, occurrences_total }) =>
      ({ routine, last_occurrence, next_slot, occurrences_total })) };
}
function occurrence(value = detail(), status: RoutineOccurrenceSummary["status"] = "completed"): RoutineOccurrenceSummary {
  return { id: "synthetic-occurrence", routine_id: value.routine.id, routine_revision: value.routine.revision, slot: at,
    trigger: "manual", status, started_at: at, finished_at: ["reserved", "running"].includes(status) ? null : at,
    cancel_requested_at: null, receipt: null };
}
function completedOccurrence(value = detail()): RoutineOccurrenceSummary {
  const item = occurrence(value);
  item.receipt = { schema_version: 1, occurrence_id: item.id, occurrence_key: routineSlotKey(value.routine.id, value.routine.revision, at),
    routine_id: value.routine.id, routine_revision: value.routine.revision, slot: at, action: value.routine.action, scope: value.routine.scope,
    policy_fingerprint: fingerprint, cap_fingerprint: fingerprint, project_ids: ["alpha"], started_at: at, finished_at: at, captured_at: at,
    freshness: "fresh", sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: at, fingerprint }],
    counts: { projects_selected: 1, facts_total: 1, facts_fresh: 1, facts_unavailable: 0, signals_evaluated: 0, proposals_created: 0, reports_written: 0 },
    consumption: { attempts: 1, runtime_ms: 0, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: "within-limit", proposals: [], failure_code: null, next_action: "none" };
  return item;
}
function deferred<T>() {
  let finish!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { finish = done; reject = fail; }); return { promise, finish, reject };
}
let fixtureList: RoutineList;
function reflect(value: RoutineDetail): RoutineDetail {
  const summary = listing([value]).routines[0]!, previous = fixtureList.routines.filter((entry) => entry.routine.id !== value.routine.id);
  fixtureList = { ...listing([value]), routines: [...previous, summary], revision: (fixtureList.revision ?? 0) + 1 }; return value;
}
beforeEach(() => {
  fixtureList = listing(); vi.spyOn(api, "fetchRoutines").mockImplementation(async () => structuredClone(fixtureList));
  vi.spyOn(api, "fetchRoutine").mockResolvedValue(detail());
  vi.spyOn(api, "getOrganization").mockResolvedValue(organization());
  vi.spyOn(api, "createRoutine").mockImplementation(async (input) => reflect({ ...detail("routine-created", 1), routine: { ...record("routine-created", 1, false), ...input } }));
  vi.spyOn(api, "configureRoutine").mockImplementation(async (id, input) => reflect({ ...detail(id, input.expected_revision + 1),
    routine: { ...record(id, input.expected_revision + 1, input.enabled), action: input.action, scope: input.scope,
      schedule: input.schedule, schedule_anchor_at: input.schedule ? at : null, concurrency: input.concurrency, catch_up: input.catch_up } }));
  vi.spyOn(api, "disableRoutine").mockImplementation(async (id, revision) => reflect({ ...detail(id, revision + 1), routine: record(id, revision + 1, false) }));
  vi.spyOn(api, "runRoutine").mockResolvedValue({ status: "admitted", occurrence: occurrence(), execution: { state: "fixture-enabled", executable: false } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function ready(value = detail()) {
  fixtureList = listing([value]); vi.mocked(api.fetchRoutine).mockResolvedValue(value); render(<RoutinePanel projects={projects} />);
  const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" });
  fireEvent.change(select, { target: { value: value.routine.id } });
  await waitFor(() => expect(api.fetchRoutine).toHaveBeenCalledWith(value.routine.id));
  await screen.findByRole("checkbox", { name: "Rutina habilitada" });
  return screen.getByRole("region", { name: "Rutinas locales" });
}
const mutations = () => [api.createRoutine, api.configureRoutine, api.disableRoutine, api.runRoutine].forEach((operation) => expect(operation).not.toHaveBeenCalled());

describe("T014 explicit bounded routine controls", () => {
  it("reads optional absence without creating definitions or requesting execution", async () => {
    vi.mocked(api.fetchRoutines).mockResolvedValue(listing([])); render(<RoutinePanel projects={projects} />);
    await screen.findByText("Sin documento de rutinas; crear requiere confirmación explícita.");
    expect(api.fetchRoutines).toHaveBeenCalledOnce(); expect(api.fetchRoutine).not.toHaveBeenCalled(); mutations();
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "Rutinas locales" })).toHaveTextContent("no salud del API/worker ni permiso de ejecución");
  });
  it.each(ROUTINE_ACTIONS)("creates %s only after reviewing and separately confirming the closed disabled definition", async (action) => {
    render(<RoutinePanel projects={projects} />); await waitFor(() => expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Acción de rutina" }), { target: { value: action } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar creación" })); mutations();
    expect(screen.getByRole("region", { name: "Confirmación de rutina" })).toHaveTextContent("definición manual deshabilitada");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar creación" }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalledExactlyOnceWith({ action, scope: companyScope }));
    expect(api.configureRoutine).not.toHaveBeenCalled(); expect(api.runRoutine).not.toHaveBeenCalled();
    expect(await screen.findByRole("checkbox", { name: "Rutina habilitada" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Revisar ejecución" })).toBeDisabled();
  });
  it.each(["project", "objective"] as const)("uses only selected existing %s IDs, not free text or commands", async (kind) => {
    render(<RoutinePanel projects={projects} />); await waitFor(() => expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Alcance de rutina" }), { target: { value: kind } });
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeDisabled();
    const id = kind === "project" ? "alpha" : "synthetic-objective";
    fireEvent.change(screen.getByRole("combobox", { name: kind === "project" ? "Proyecto de rutina" : "Objetivo de rutina" }), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar creación" })); fireEvent.click(screen.getByRole("button", { name: "Confirmar creación" }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalledExactlyOnceWith({ action: "refresh-evidence", scope: { kind, id } }));
    expect(screen.queryByRole("textbox")).toBeNull(); expect(api.runRoutine).not.toHaveBeenCalled();
  });
  it("isolates unavailable objectives while company and existing-project configuration stay usable", async () => {
    vi.mocked(api.getOrganization).mockRejectedValue(new Error("Synthetic confidential source path"));
    render(<><p>Existing Today remains visible</p><RoutinePanel projects={projects} /></>);
    await screen.findByText(/Objetivos no disponibles/); expect(screen.getByText("Existing Today remains visible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Alcance de rutina" }), { target: { value: "objective" } });
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("Synthetic confidential source path"); mutations();
  });
  it("confirms a current revision with the exact bounded interval, concurrency and catch-up payload", async () => {
    const region = await ready();
    fireEvent.change(within(region).getByRole("combobox", { name: "Programación de rutina" }), { target: { value: "interval" } });
    fireEvent.change(within(region).getByRole("spinbutton", { name: "Intervalo en minutos" }), { target: { value: "10080" } });
    fireEvent.change(within(region).getByRole("combobox", { name: "Concurrencia de rutina" }), { target: { value: "coalesce" } });
    fireEvent.change(within(region).getByRole("combobox", { name: "Recuperación de rutina" }), { target: { value: "run-once" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" })); mutations();
    expect(screen.getByRole("region", { name: "Confirmación de rutina" })).toHaveTextContent("revisión esperada 2");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar configuración" }));
    await waitFor(() => expect(api.configureRoutine).toHaveBeenCalledExactlyOnceWith("routine-alpha", { expected_revision: 2,
      action: "refresh-evidence", scope: companyScope, enabled: true, schedule: "every:10080m", concurrency: "coalesce", catch_up: "run-once" }));
    expect(api.runRoutine).not.toHaveBeenCalled(); expect(screen.getByText(/nueva revisión; no concede ejecución/)).toBeInTheDocument();
  });
  it.each(["", "0", "14", "10081", "15.5", "-15", "015"])("refuses interval %s without a confirmation or mutation", async (minutes) => {
    await ready(); fireEvent.change(screen.getByRole("combobox", { name: "Programación de rutina" }), { target: { value: "interval" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Intervalo en minutos" }), { target: { value: minutes } });
    expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("entero entre 15 y 10080"); mutations();
  });
  it("invalidates a confirmation on any edit, including changing a value back, and cancellation has no effect", async () => {
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Rutina habilitada" })); fireEvent.click(screen.getByRole("checkbox", { name: "Rutina habilitada" }));
    expect(screen.queryByRole("button", { name: "Confirmar configuración" })).toBeNull(); mutations();
    fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" })); fireEvent.click(screen.getByRole("button", { name: "Cancelar confirmación" }));
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull(); mutations();
  });
  it.each(["reserved", "running", "needs-review"] as const)("does not request another run while last occurrence ownership is %s", async (status) => {
    const value = detail("routine-alpha", 2, "fixture-enabled"), item = occurrence(value, status);
    value.last_occurrence = item; value.occurrences = [item]; value.occurrences_total = 1; await ready(value);
    expect(screen.getByRole("button", { name: "Revisar ejecución" })).toBeDisabled(); mutations();
  });
  it.each(["inactive", "fixture-disabled", "dirty"])("keeps %s execution denied despite a valid stored definition", async (kind) => {
    const value = detail("routine-alpha", 2, kind === "inactive" ? "inactive" : "fixture-enabled");
    if (kind === "fixture-disabled") value.routine.enabled = false; await ready(value);
    if (kind === "dirty") fireEvent.change(screen.getByRole("combobox", { name: "Concurrencia de rutina" }), { target: { value: "coalesce" } });
    expect(screen.getByRole("button", { name: "Revisar ejecución" })).toBeDisabled();
    if (kind === "inactive") expect(screen.getByText(/pendiente T015–T017/)).toBeInTheDocument(); mutations();
  });
  it("sends one explicit exact-revision fixture request and never treats admission as completion", async () => {
    const value = detail("routine-alpha", 2, "fixture-enabled"); await ready(value);
    fireEvent.click(screen.getByRole("button", { name: "Revisar ejecución" })); mutations();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar ejecución" }));
    await waitFor(() => expect(api.runRoutine).toHaveBeenCalledExactlyOnceWith("routine-alpha", 2));
    expect(await screen.findByText(/No implica finalización ni evidencia fresca/)).toBeInTheDocument();
    expect(api.configureRoutine).not.toHaveBeenCalled(); expect(api.disableRoutine).not.toHaveBeenCalled();
  });
  it("disables only the reviewed current revision without deleting stored evidence", async () => {
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Revisar deshabilitación" })); mutations();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar deshabilitación" }));
    await waitFor(() => expect(api.disableRoutine).toHaveBeenCalledExactlyOnceWith("routine-alpha", 2));
    expect(await screen.findByText(/historial y contabilidad preservados/)).toBeInTheDocument(); expect(screen.getByRole("checkbox", { name: "Rutina habilitada" })).not.toBeChecked();
    expect(api.runRoutine).not.toHaveBeenCalled();
  });
  it.each(["configuration", "disable", "run"])("clears failed %s confirmations and sensitive errors without replay", async (kind) => {
    const value = detail("routine-alpha", 2, "fixture-enabled"); await ready(value);
    const failure = new Error("Synthetic confidential payload C:\\private\\record");
    const operation = kind === "configuration" ? api.configureRoutine : kind === "disable" ? api.disableRoutine : api.runRoutine;
    vi.mocked(operation).mockRejectedValueOnce(failure);
    const label = kind === "configuration" ? "configuración" : kind === "disable" ? "deshabilitación" : "ejecución";
    fireEvent.click(screen.getByRole("button", { name: `Revisar ${label}` })); fireEvent.click(screen.getByRole("button", { name: `Confirmar ${label}` }));
    await screen.findByRole("alert"); expect(operation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull();
    expect(document.body.textContent).not.toContain("Synthetic confidential payload"); expect(document.body.textContent).not.toContain("C:\\private");
    fireEvent.click(screen.getByRole("button", { name: `Revisar ${label}` })); expect(operation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" })); await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    expect(operation).toHaveBeenCalledOnce();
  });
  it("keeps failed creation fenced through passive polling and new-mode selection until a fresh explicit read and review", async () => {
    fixtureList = listing([]); vi.mocked(api.createRoutine).mockRejectedValueOnce(new Error("Synthetic confidential creation failure"));
    const view = render(<RoutinePanel projects={projects} refreshKey={1} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revisar creación" })); fireEvent.click(screen.getByRole("button", { name: "Confirmar creación" }));
    await screen.findByRole("alert"); expect(api.createRoutine).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull();
    view.rerender(<RoutinePanel projects={projects} refreshKey={2} />); fireEvent.click(screen.getByRole("button", { name: "Nueva rutina" }));
    await waitFor(() => expect(api.fetchRoutines).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar creación" })); expect(api.createRoutine).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Synthetic confidential creation failure");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled());
    expect(api.createRoutine).toHaveBeenCalledOnce(); expect(screen.queryByRole("button", { name: "Confirmar creación" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revisar creación" })); fireEvent.click(screen.getByRole("button", { name: "Confirmar creación" }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalledTimes(2));
  });
  it("retains receipt timestamps and exact partial/failure facts rather than laundering list read time into freshness", async () => {
    const value = detail(), item = completedOccurrence(value), receipt = item.receipt!;
    item.status = "partial"; receipt.freshness = "partial"; receipt.failure_code = "source-unavailable"; receipt.next_action = "inspect-evidence";
    value.last_occurrence = item; value.occurrences = [item]; value.occurrences_total = 1; const region = await ready(value);
    expect(region).toHaveTextContent("source-unavailable"); expect(region).toHaveTextContent("Inspeccionar evidencia");
    expect(region).toHaveTextContent("Frescura registradaParcial"); expect(region).toHaveTextContent(`${at} (UTC)`);
    expect(region).toHaveTextContent("no a la hora de lectura del listado"); mutations();
  });
  it.each(["stale", "unavailable"] as const)("preserves %s source evidence across reads without turning absence into fresh success", async (freshness) => {
    const value = detail(), item = completedOccurrence(value), receipt = item.receipt!;
    item.status = "partial"; receipt.freshness = freshness; receipt.failure_code = "source-unavailable"; receipt.next_action = "inspect-evidence";
    receipt.sources[0]!.state = freshness; receipt.counts.facts_fresh = 0;
    if (freshness === "unavailable") { receipt.sources[0]!.observed_at = null; receipt.sources[0]!.fingerprint = null; receipt.counts.facts_unavailable = 1; }
    value.last_occurrence = item; value.occurrences = [item]; value.occurrences_total = 1; await ready(value);
    expect(screen.getByRole("region", { name: "Resumen de rutinas" })).toHaveTextContent(freshness === "stale" ? "Obsoleta" : "No disponible");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" })); await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    const region = screen.getByRole("region", { name: "Rutinas locales" }); expect(region).toHaveTextContent("source-unavailable");
    expect(region).not.toHaveTextContent("Frescura registradaFresca al capturar"); mutations();
  });
});

describe("T014 routine read and draft reset fences", () => {
  it.each(["HTTP failure", "unavailable state"])("isolates %s without presenting empty or fresh success", async (kind) => {
    if (kind === "HTTP failure") vi.mocked(api.fetchRoutines).mockRejectedValue(new Error("Synthetic confidential diagnostic"));
    else vi.mocked(api.fetchRoutines).mockResolvedValue({ schema_version: 1, state: "unavailable", observed_at: null, revision: null, routines: [] });
    render(<><p>Existing Today remains available</p><RoutinePanel projects={projects} /></>); await screen.findByRole("alert");
    expect(screen.getByText("Existing Today remains available")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Revisar creación" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("Synthetic confidential diagnostic"); mutations();
  });
  it("ignores late A -> B -> A detail reads and unmount completions", async () => {
    const a = detail(), b = detail("routine-beta"), first = deferred<RoutineDetail>(), second = deferred<RoutineDetail>(), third = deferred<RoutineDetail>();
    vi.mocked(api.fetchRoutines).mockResolvedValue(listing([a, b]));
    vi.mocked(api.fetchRoutine).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const view = render(<RoutinePanel projects={projects} />); const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" });
    await waitFor(() => expect(within(select).getByRole("option", { name: "routine-alpha · r2" })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "routine-alpha" } }); fireEvent.change(select, { target: { value: "routine-beta" } });
    fireEvent.change(select, { target: { value: "routine-alpha" } });
    await act(async () => { first.finish(detail("routine-alpha", 99)); second.finish(detail("routine-beta", 99)); });
    expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull();
    await act(async () => third.finish(a)); expect(screen.getByRole("checkbox", { name: "Rutina habilitada" })).toBeChecked();
    expect(document.body.textContent).not.toContain("r99"); mutations();
    const fourth = deferred<RoutineDetail>(); vi.mocked(api.fetchRoutine).mockReturnValueOnce(fourth.promise);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" })); view.unmount();
    await act(async () => fourth.finish(detail("routine-alpha", 99))); expect(screen.queryByRole("region", { name: "Rutinas locales" })).toBeNull();
  });
  it("preserves an edited draft on same-binding refresh but requires a new review for a changed revision", async () => {
    vi.mocked(api.fetchRoutine).mockResolvedValue(detail()); const view = render(<RoutinePanel projects={projects} refreshKey={1} />);
    const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" });
    fireEvent.change(select, { target: { value: "routine-alpha" } }); await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    fireEvent.change(screen.getByRole("combobox", { name: "Concurrencia de rutina" }), { target: { value: "coalesce" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" }));
    view.rerender(<RoutinePanel projects={projects} refreshKey={2} />);
    await waitFor(() => expect(api.fetchRoutine).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("combobox", { name: "Concurrencia de rutina" })).toHaveValue("coalesce");
    expect(screen.getByRole("button", { name: "Confirmar configuración" })).toBeInTheDocument();
    fixtureList = listing([detail("routine-alpha", 3)]); vi.mocked(api.fetchRoutine).mockResolvedValue(detail("routine-alpha", 3));
    view.rerender(<RoutinePanel projects={projects} refreshKey={3} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Concurrencia de rutina" })).toHaveValue("skip"));
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull(); mutations();
  });
  it("clears stale detail and confirmation on failed refresh, and never restores it from late callbacks", async () => {
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" }));
    vi.mocked(api.fetchRoutine).mockRejectedValue(new Error("Synthetic confidential read error")); fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" }));
    await screen.findByRole("alert"); expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull(); mutations();
    expect(document.body.textContent).not.toContain("Synthetic confidential read error");
  });
  it("does not erase a failed detail read alert when the independent list read succeeds later", async () => {
    await ready(); const pendingList = deferred<RoutineList>(); vi.mocked(api.fetchRoutines).mockReturnValueOnce(pendingList.promise);
    vi.mocked(api.fetchRoutine).mockRejectedValueOnce(new Error("Synthetic confidential read error"));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" })); await screen.findByRole("alert");
    await act(async () => pendingList.finish(listing()));
    expect(screen.getByRole("alert")).toHaveTextContent(/Detalle de rutina no disponible/);
    expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeDisabled(); mutations();
    expect(document.body.textContent).not.toContain("Synthetic confidential read error");
  });
  it("resets selected detail and confirmations when switching to a new definition without creating it", async () => {
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" }));
    fireEvent.click(screen.getByRole("button", { name: "Nueva rutina" }));
    expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull(); expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revisar creación" })).toBeEnabled(); mutations();
  });
  it("invalidates a passive confirmation if the private execution descriptor changes without a definition revision change", async () => {
    const value = detail("routine-alpha", 2, "fixture-enabled"); fixtureList = listing([value]); vi.mocked(api.fetchRoutine).mockResolvedValue(value);
    const view = render(<RoutinePanel projects={projects} refreshKey={1} />);
    const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" }); fireEvent.change(select, { target: { value: value.routine.id } });
    await screen.findByRole("checkbox", { name: "Rutina habilitada" }); fireEvent.click(screen.getByRole("button", { name: "Revisar ejecución" }));
    expect(screen.getByRole("button", { name: "Confirmar ejecución" })).toBeInTheDocument();
    vi.mocked(api.fetchRoutine).mockResolvedValue(detail()); view.rerender(<RoutinePanel projects={projects} refreshKey={2} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirmar ejecución" })).toBeNull());
    expect(screen.getByRole("button", { name: "Revisar ejecución" })).toBeDisabled(); mutations();
  });
  it.each(["selection", "explicit refresh"])("fences a late mutation after %s and cannot submit another while it is in flight", async (kind) => {
    const a = detail(), b = detail("routine-beta"), pending = deferred<RoutineDetail>(); fixtureList = listing([a, b]);
    vi.mocked(api.fetchRoutine).mockImplementation(async (id) => id === b.routine.id ? b : a);
    const view = render(<RoutinePanel projects={projects} />); const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" });
    fireEvent.change(select, { target: { value: a.routine.id } }); await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    vi.mocked(api.configureRoutine).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" })); fireEvent.click(screen.getByRole("button", { name: "Confirmar configuración" }));
    expect(api.configureRoutine).toHaveBeenCalledOnce();
    if (kind === "selection") fireEvent.change(select, { target: { value: b.routine.id } });
    else fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" }));
    await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" })); expect(api.configureRoutine).toHaveBeenCalledOnce();
    await act(async () => pending.finish(detail(a.routine.id, 99)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeEnabled());
    expect(document.body.textContent).not.toContain("r99"); expect(screen.queryByText(/nueva revisión; no concede ejecución/)).toBeNull();
    expect(api.configureRoutine).toHaveBeenCalledOnce(); view.unmount();
  });
  it.each(["absent", "missing selected", "same-revision conflicting binding"])("discards %s list/detail gaps and late stale reads before any mutation", async (kind) => {
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Revisar configuración" }));
    const pending = deferred<RoutineDetail>(); vi.mocked(api.fetchRoutine).mockReturnValueOnce(pending.promise);
    const value = kind === "absent" ? listing([]) : kind === "missing selected" ? listing([detail("routine-beta")]) : listing();
    if (kind === "same-revision conflicting binding") value.routines[0]!.routine.scope = { kind: "project", id: "beta" };
    vi.mocked(api.fetchRoutines).mockResolvedValue(value); fireEvent.click(screen.getByRole("button", { name: "Actualizar rutinas" }));
    await waitFor(() => expect(api.fetchRoutines).toHaveBeenCalledTimes(2));
    await act(async () => pending.finish(detail()));
    expect(screen.queryByRole("checkbox", { name: "Rutina habilitada" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Confirmación de rutina" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeDisabled(); mutations();
  });
  it("pages the known full inventory so a 26th routine remains explicitly selectable without inventing IDs", async () => {
    const values = Array.from({ length: 26 }, (_, index) => detail(`routine-${String(index + 1).padStart(2, "0")}`));
    fixtureList = listing(values); vi.mocked(api.fetchRoutine).mockImplementation(async (id) => values.find((entry) => entry.routine.id === id)!);
    render(<RoutinePanel projects={projects} />); const select = await screen.findByRole("combobox", { name: "Seleccionar rutina" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(26));
    expect(within(select).queryByRole("option", { name: "routine-26 · r2" })).toBeNull();
    expect(screen.getByRole("region", { name: "Resumen de rutinas" })).toHaveTextContent("routine-25");
    expect(screen.getByRole("region", { name: "Resumen de rutinas" })).not.toHaveTextContent("routine-26");
    fireEvent.click(screen.getByRole("button", { name: "Rutinas siguientes" }));
    expect(within(select).getByRole("option", { name: "routine-26 · r2" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "routine-26" } }); await screen.findByRole("checkbox", { name: "Rutina habilitada" });
    expect(api.fetchRoutine).toHaveBeenCalledExactlyOnceWith("routine-26"); expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Rutinas anteriores" }));
    expect(select).toHaveValue("routine-26"); expect(screen.getByRole("button", { name: "Revisar configuración" })).toBeEnabled(); mutations();
  });
});

describe("T014 closed routine client read contracts", () => {
  it("accepts supported empty and bound revisioned read models using no-store GET only", async () => {
    vi.restoreAllMocks(); const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(listing([]))))
      .mockResolvedValueOnce(new Response(JSON.stringify(listing())))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail()))); vi.stubGlobal("fetch", fetch);
    expect(await api.fetchRoutines()).toEqual(listing([])); expect(await api.fetchRoutines()).toEqual(listing());
    expect(await api.fetchRoutine("routine-alpha")).toEqual(detail());
    expect(fetch.mock.calls).toEqual([["/api/routines", { cache: "no-store" }], ["/api/routines", { cache: "no-store" }],
      ["/api/routines/routine-alpha", { cache: "no-store" }]]);
  });
  it.each(["version", "absent with entries", "invalid timestamp", "duplicate", "bad record", "negative count", "invalid action", "invalid schedule"])(
    "rejects %s lists without inventing an empty safe result", async (kind) => {
      vi.restoreAllMocks(); const value = listing();
      if (kind === "version") value.schema_version = 999 as 1;
      if (kind === "absent with entries") { value.state = "absent"; value.revision = null; }
      if (kind === "invalid timestamp") value.observed_at = "2026-02-31T00:00:00Z";
      if (kind === "duplicate") value.routines.push(structuredClone(value.routines[0]!));
      if (kind === "bad record") value.routines[0]!.routine.policy.fingerprint = "not-a-hash";
      if (kind === "negative count") value.routines[0]!.occurrences_total = -1;
      if (kind === "invalid action") value.routines[0]!.routine.action = "arbitrary-command" as never;
      if (kind === "invalid schedule") { value.routines[0]!.routine.schedule = "every:14m"; value.routines[0]!.routine.schedule_anchor_at = at; }
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
      await expect(api.fetchRoutines()).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
    });
  it.each(["executable", "unknown composition", "wrong identity", "history mismatch", "future occurrence", "oversized history", "malformed receipt"])(
    "rejects %s detail binding without granting execution", async (kind) => {
      vi.restoreAllMocks(); const value = detail(), item = occurrence(value);
      if (kind === "executable") value.execution.executable = true as false;
      if (kind === "unknown composition") value.execution.state = "production-enabled" as never;
      if (kind === "wrong identity") value.routine.id = "routine-beta";
      if (kind === "history mismatch") { value.occurrences = [item]; value.occurrences_total = 1; }
      if (kind === "future occurrence") { item.routine_revision = 99; value.occurrences = [item]; value.last_occurrence = item; value.occurrences_total = 1; }
      if (kind === "oversized history") { value.occurrences = Array.from({ length: 21 }, (_, index) => ({ ...item, id: `occurrence-${index}` }));
        value.last_occurrence = value.occurrences[0]!; value.occurrences_total = 21; }
      if (kind === "malformed receipt") { item.receipt = { private_payload: "Synthetic confidential field" } as never;
        value.occurrences = [item]; value.last_occurrence = item; value.occurrences_total = 1; }
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
      await expect(api.fetchRoutine("routine-alpha")).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
    });
  it("does not replay a protected mutation after 403 and rotates only for the next explicit action", async () => {
    vi.restoreAllMocks(); const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "synthetic-session-one" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Session unavailable" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "synthetic-session-two" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...detail("routine-alpha", 3), routine: record("routine-alpha", 3, false) })));
    vi.stubGlobal("fetch", fetch); await expect(api.disableRoutine("routine-alpha", 2)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(await api.disableRoutine("routine-alpha", 2)).toMatchObject({ routine: { revision: 3, enabled: false } });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/session", "/api/routines/routine-alpha/disable", "/api/session", "/api/routines/routine-alpha/disable"]);
    expect(fetch.mock.calls.filter(([path]) => path.includes("/disable")).every(([, init]) => init.body === JSON.stringify({ expected_revision: 2 }))).toBe(true);
  });
  it("accepts a complete closed deterministic receipt without deriving execution authority", async () => {
    vi.restoreAllMocks(); const value = detail(), item = completedOccurrence(value);
    value.occurrences = [item]; value.last_occurrence = item; value.occurrences_total = 1;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
    expect(await api.fetchRoutine(value.routine.id)).toEqual(value); expect(fetch).toHaveBeenCalledOnce();
  });
  it("accepts equivalent canonical UTC precision for anchor/update and aligned next slot", async () => {
    vi.restoreAllMocks(); const value = detail(); value.routine.updated_at = "2026-10-07T12:00:00.000Z";
    value.routine.created_at = "2026-10-07T12:00:00Z"; value.routine.schedule = "every:15m";
    value.routine.schedule_anchor_at = "2026-10-07T12:00:00Z"; value.next_slot = "2026-10-07T12:15:00.000Z";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
    expect(await api.fetchRoutine(value.routine.id)).toEqual(value); expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a theoretical next slot that is not aligned to the reviewed interval", async () => {
    vi.restoreAllMocks(); const value = detail(); value.routine.schedule = "every:15m"; value.routine.schedule_anchor_at = at;
    value.next_slot = new Date(Date.parse(at) + 899999).toISOString();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
    await expect(api.fetchRoutine(value.routine.id)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["counts", "freshness", "status", "failure", "source future", "model calls", "tokens", "workspace writes", "runtime", "receipt identity"])(
    "rejects contradictory %s receipt evidence instead of rendering fresh success", async (kind) => {
      vi.restoreAllMocks(); const value = detail(), item = completedOccurrence(value), receipt = item.receipt!;
      if (kind === "counts") receipt.counts.facts_total = 2;
      if (kind === "freshness") { receipt.sources[0]!.state = "unavailable"; receipt.sources[0]!.observed_at = null;
        receipt.sources[0]!.fingerprint = null; receipt.counts.facts_fresh = 0; receipt.counts.facts_unavailable = 1; }
      if (kind === "status") item.status = "running";
      if (kind === "failure") receipt.failure_code = "action-failed";
      if (kind === "source future") receipt.sources[0]!.observed_at = "2999-01-01T00:00:00.000Z";
      if (kind === "model calls") receipt.consumption.model_calls = 1 as 0;
      if (kind === "tokens") receipt.consumption.total_tokens = 1 as 0;
      if (kind === "workspace writes") receipt.consumption.workspace_writes = 1 as 0;
      if (kind === "runtime") receipt.consumption.runtime_ms = -1;
      if (kind === "receipt identity") receipt.occurrence_id = "different-occurrence";
      value.occurrences = [item]; value.last_occurrence = item; value.occurrences_total = 1;
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
      await expect(api.fetchRoutine(value.routine.id)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
    });
  it.each(["source identity", "proposal key", "created issue identity"])("rejects duplicate %s with internally matching counts", async (kind) => {
    vi.restoreAllMocks(); const value = detail(), item = completedOccurrence(value), receipt = item.receipt!;
    if (kind === "source identity") { receipt.sources.push(structuredClone(receipt.sources[0]!)); receipt.counts.facts_total = 2; receipt.counts.facts_fresh = 2; }
    else { receipt.action = "propose-issues"; receipt.next_action = "review-proposals";
      receipt.proposals = [{ key: "b".repeat(64), fingerprint, issue_id: "synthetic-issue-one" },
        { key: kind === "proposal key" ? "b".repeat(64) : "c".repeat(64), fingerprint,
          issue_id: kind === "created issue identity" ? "synthetic-issue-one" : "synthetic-issue-two" }];
      receipt.counts.proposals_created = 2;
    }
    value.occurrences = [item]; value.last_occurrence = item; value.occurrences_total = 1;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
    await expect(api.fetchRoutine(value.routine.id)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["creation enabled", "creation wrong action", "creation wrong scope", "configuration revision", "configuration schedule", "disable enabled", "disable revision"])(
    "rejects a contradictory %s mutation result without replay or follow-up effects", async (kind) => {
      vi.restoreAllMocks(); const input: api.RoutineConfigureInput = { expected_revision: 2, action: "refresh-evidence", scope: companyScope,
        enabled: true, schedule: null, concurrency: "skip", catch_up: "skip-missed" };
      const value = detail("routine-alpha", kind.startsWith("creation") ? 1 : 3);
      if (kind.startsWith("creation") || kind.startsWith("disable")) value.routine.enabled = false;
      if (kind === "creation enabled" || kind === "disable enabled") value.routine.enabled = true;
      if (kind === "creation wrong action") value.routine.action = "evaluate-signals";
      if (kind === "creation wrong scope") value.routine.scope = { kind: "project", id: "alpha" };
      if (kind === "configuration revision" || kind === "disable revision") value.routine.revision = 4;
      if (kind === "configuration schedule") { value.routine.schedule = "every:15m"; value.routine.schedule_anchor_at = at; }
      const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "synthetic-mutation-session" })))
        .mockResolvedValueOnce(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
      await expect(kind.startsWith("creation") ? api.createRoutine({ action: "refresh-evidence", scope: companyScope })
        : kind.startsWith("configuration") ? api.configureRoutine(value.routine.id, input) : api.disableRoutine(value.routine.id, 2)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  it.each(["wrong routine", "wrong revision", "nonmanual trigger", "admitted completed", "inactive", "executable", "unknown result"])(
    "rejects %s run results without claiming completed execution or repeating the request", async (kind) => {
      vi.restoreAllMocks(); const value: api.RoutineRunResult = { status: "admitted", occurrence: occurrence(detail(), "running"),
        execution: { state: "fixture-enabled", executable: false } };
      if (kind === "wrong routine") value.occurrence.routine_id = "routine-beta";
      if (kind === "wrong revision") value.occurrence.routine_revision = 1;
      if (kind === "nonmanual trigger") value.occurrence.trigger = "scheduled";
      if (kind === "admitted completed") value.occurrence = completedOccurrence();
      if (kind === "inactive") value.execution.state = "inactive" as never;
      if (kind === "executable") value.execution.executable = true as false;
      if (kind === "unknown result") value.status = "completed" as never;
      const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "synthetic-run-session" })))
        .mockResolvedValueOnce(new Response(JSON.stringify(value))); vi.stubGlobal("fetch", fetch);
      await expect(api.runRoutine("routine-alpha", 2)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(2);
    });
});

it.runIf(process.env.SURTEC_ROUTINE_PANEL_BROWSER_SMOKE === "1")("T014 validates actual routine controls, durable fake-only execution, session fences and responsive persistence", async () => {
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new NodeTextEncoder().encode("")).constructor);
  const { createServer: createViteServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react");
  const root = mkdtempSync(join(tmpdir(), "surtec-routine-panel-browser-")), state = join(root, "state"), projectRoot = join(root, "projects");
  let server: ReturnType<typeof serve> | undefined, vite: ViteDevServer | undefined, browser: Browser | undefined, runner: RoutineRunner | undefined;
  let browserClosed = false, viteClosed = false, apiClosed = false, runnerStopped = false, fixtureEnabled = false;
  let now = Date.parse(at);
  const dispatch = vi.fn(), effect = vi.fn(() => { throw new Error("Routine acceptance forbids agent and project execution"); });
  const processes = { start: effect, stop: effect, get: vi.fn(() => null), list: vi.fn(() => []), subscribe: vi.fn(() => () => {}) };
  const read = vi.fn(async () => ({ sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: at, fingerprint }], signals: [] }));
  const path = routineStatePath(state), ledgerPath = budgetStatePath(state);
  const snapshot = () => ({ bytes: readFileSync(path), modified: lstatSync(path).mtimeMs });
  const unchanged = (before: ReturnType<typeof snapshot>) => { expect(readFileSync(path)).toEqual(before.bytes); expect(lstatSync(path).mtimeMs).toBe(before.modified); };
  const closeApi = async () => { if (!server?.listening) return;
    await new Promise<void>((done, fail) => { server!.close((error) => error ? fail(error) : done());
      if ("closeAllConnections" in server! && typeof server!.closeAllConnections === "function") server!.closeAllConnections(); });
    apiClosed = !server.listening; };
  try {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(lstatSync(root).isSymbolicLink()).toBe(false);
    mkdirSync(projectRoot); const project = join(projectRoot, "alpha"); mkdirSync(project);
    execFileSync("git", ["-c", "core.hooksPath=", "init", "--initial-branch=main", project], { stdio: "ignore" });
    cpSync(resolve("registry"), join(root, "registry"), { recursive: true }); cpSync(resolve("schemas"), join(root, "schemas"), { recursive: true });
    writeFileSync(join(root, "registry", "projects.yml"), JSON.stringify({ projects: { alpha: { local_path: project,
      default_branch: "main", status: "active", allowed_agents: ["tech-lead"], sandbox: { default: "read-only" },
      commands: {}, approval: { before_merge: true, before_deploy: true } } } }));
    writeFileSync(join(root, "registry", "budget-policy.yml"), JSON.stringify({ schema_version: 1, revision: 1,
      pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "company-policy", revision: 1,
        scope: companyScope, period: "none", warning_percent: 80,
        limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] }));
    vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", projectRoot); vi.stubEnv("SURTEC_TIME_ZONE", "UTC");
    const source = readBudgetPolicy(root);
    runner = new RoutineRunner({ stateRoot: state, now: () => new Date(now), execution: { resolve: (_definition, id) => ({ source,
      attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: null, execution_id: id } }),
      assert_current: () => undefined, read_evidence: read, monotonic: () => 0 } });
    const dependencies = (): AppDependencies => ({ routines: createRoutineService(root, { stateRoot: state, clock: () => new Date(now),
      readBudgetPolicy: () => source, readOrganization: organization, listProjects: () => [{ id: "alpha" }],
      ...(fixtureEnabled ? { execution: { runner: runner!, worker_id: "synthetic-browser-worker", available_reads: () => 1 } } : {}) }),
      signals: { read: async () => ({ schema_version: 1, observed_at: at, pinned_signal_ids: [], warnings: [], signals: [] }),
        decide: effect } as unknown as AppDependencies["signals"], inbox: async () => ({ items: [], repos: [] }),
      organization: { read: organization } as unknown as AppDependencies["organization"],
      integrations: { read: async () => ({ schema_version: 2, project_id: "alpha", observed_at: at, trace_id: null,
        source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
          remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
        ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null, run_id: null },
        dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: at }, deployments: [] }),
        invalidate: vi.fn() } as unknown as AppDependencies["integrations"] });
    const app = () => createApp(root, dispatch, processes as unknown as ProcessManager, createHttpSecurity(), dependencies());
    server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: 0 }); if (!server.listening) await once(server, "listening");
    const apiPort = (server.address() as AddressInfo).port, apiUrl = `http://127.0.0.1:${apiPort}`;
    vite = await createViteServer({ configFile: false, root: resolve("dashboard"), plugins: [react()], cacheDir: join(root, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/api": { target: apiUrl } } } });
    await vite.listen(); const dashboardUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
      browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors: string[] = [], externalRequests: string[] = [];
    const consoleErrors: Array<{ text: string; path: string }> = [], httpErrors: Array<{ status: number; method: string; path: string }> = [];
    const controls: Array<{ method: string; path: string; body: unknown }> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") { const location = message.location().url;
      consoleErrors.push({ text: message.text(), path: location ? new URL(location).pathname : "" }); } });
    page.on("response", (response) => { if (response.status() >= 400) httpErrors.push({ status: response.status(),
      method: response.request().method(), path: new URL(response.url()).pathname }); });
    page.on("request", (request) => { const url = new URL(request.url());
      if (url.pathname.startsWith("/api/routines") && ["POST", "PUT"].includes(request.method()))
        controls.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() }); });
    await page.route("**/*", async (route) => { const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
      else if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2" && route.request().resourceType() === "stylesheet")
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      else { externalRequests.push(url.hostname); await route.abort(); } });
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }); await page.getByText("Cockpit diario", { exact: true }).waitFor();
    await page.getByText("En vivo", { exact: true }).waitFor(); const panel = page.getByRole("region", { name: "Rutinas locales", exact: true });
    await panel.getByRole("button", { name: "Revisar creación", exact: true }).waitFor();
    expect(controls).toEqual([]); expect(existsSync(path)).toBe(false);
    await panel.getByRole("button", { name: "Revisar creación", exact: true }).click(); expect(controls).toEqual([]);
    await panel.getByRole("button", { name: "Confirmar creación", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    const id = Object.keys(readRoutineDocument(path)!.routines)[0]!;
    expect(readRoutineDocument(path)!.routines[id]).toMatchObject({ revision: 1, enabled: false, schedule: null });
    await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).check();
    await panel.getByRole("combobox", { name: "Programación de rutina", exact: true }).selectOption("interval");
    await panel.getByRole("spinbutton", { name: "Intervalo en minutos", exact: true }).fill("15");
    await panel.getByRole("combobox", { name: "Concurrencia de rutina", exact: true }).selectOption("coalesce");
    await panel.getByRole("combobox", { name: "Recuperación de rutina", exact: true }).selectOption("run-once");
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click();
    await expect.poll(() => readRoutineDocument(path)!.routines[id]!.revision).toBe(2);
    expect(readRoutineDocument(path)!.routines[id]).toMatchObject({ enabled: true, schedule: "every:15m", concurrency: "coalesce", catch_up: "run-once" });
    expect(await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).isDisabled()).toBe(true);
    expect(await panel.textContent()).toContain("T015");
    await page.addScriptTag({ type: "module", content: "import * as api from '/src/ui/api.ts'; globalThis.__routinePanelSmoke = api;" });
    const beforeInactive = snapshot();
    expect(await page.evaluate(async ({ id }) => { const client = (globalThis as typeof globalThis & { __routinePanelSmoke: typeof import("../api") }).__routinePanelSmoke;
      try { await client.runRoutine(id, 2); return false; } catch { return true; } }, { id })).toBe(true);
    unchanged(beforeInactive); expect(existsSync(ledgerPath)).toBe(false); expect(read).not.toHaveBeenCalled();
    const previousToken = await page.evaluate(async () => (await (await fetch("/api/session", { cache: "no-store" })).json()).token as string);
    await page.waitForLoadState("networkidle"); await closeApi(); fixtureEnabled = true;
    server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: apiPort }); if (!server.listening) await once(server, "listening"); apiClosed = false;
    await panel.getByRole("button", { name: "Revisar deshabilitación", exact: true }).click();
    const beforeStale = snapshot(), beforeControls = controls.length;
    await panel.getByRole("button", { name: "Confirmar deshabilitación", exact: true }).click();
    await panel.getByRole("alert").waitFor(); unchanged(beforeStale); expect(controls).toHaveLength(beforeControls + 1);
    expect(await panel.getByRole("button", { name: "Confirmar deshabilitación", exact: true }).count()).toBe(0);
    await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    await panel.getByRole("combobox", { name: "Programación de rutina", exact: true }).selectOption("manual");
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click();
    await expect.poll(() => readRoutineDocument(path)!.routines[id]!.revision).toBe(3);
    expect(await page.evaluate(async (previous) => (await (await fetch("/api/session", { cache: "no-store" })).json()).token !== previous, previousToken)).toBe(true);
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).click(); expect(read).not.toHaveBeenCalled();
    await panel.getByRole("button", { name: "Confirmar ejecución", exact: true }).click();
    await runner.idle(); await expect.poll(() => read.mock.calls.length).toBe(1);
    await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).click();
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).waitFor();
    await expect.poll(() => Object.values(readRoutineDocument(path)!.occurrences)[0]?.status).toBe("completed");
    const completed = Object.values(readRoutineDocument(path)!.occurrences)[0]!;
    expect(completed.receipt).toMatchObject({ freshness: "fresh", consumption: { attempts: 1, model_calls: 0, total_tokens: 0, workspace_writes: 0 } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]?.status).toBe("settled");
    const beforeDuplicate = snapshot(), ledger = readFileSync(ledgerPath);
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar ejecución", exact: true }).click();
    await expect.poll(() => controls.filter((entry) => entry.path.endsWith("/run")).length).toBe(3);
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).waitFor();
    unchanged(beforeDuplicate); expect(readFileSync(ledgerPath)).toEqual(ledger); expect(read).toHaveBeenCalledOnce();
    // A new reviewed configuration revision is a new explicit manual intent.
    // The fake provider returns one unavailable fact so Today must show partial
    // evidence rather than replacing it with the current list observation time.
    read.mockResolvedValueOnce({ sources: [
      { kind: "organization", project_id: null, state: "fresh", observed_at: at, fingerprint },
      { kind: "ci", project_id: "alpha", state: "unavailable", observed_at: null, fingerprint: null },
    ], signals: [] } as never);
    now += 1000;
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click();
    await expect.poll(() => readRoutineDocument(path)!.routines[id]!.revision).toBe(4);
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar ejecución", exact: true }).click();
    await runner.idle(); await expect.poll(() => read.mock.calls.length).toBe(2);
    await expect.poll(() => Object.values(readRoutineDocument(path)!.occurrences).find((entry) => entry.routine_revision === 4)?.status).toBe("partial");
    await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).click();
    const overview = panel.getByRole("region", { name: "Resumen de rutinas", exact: true });
    await overview.getByText("source-unavailable", { exact: true }).waitFor();
    expect(await overview.textContent()).toContain("Parcial"); expect(await overview.textContent()).toContain("source-unavailable");
    expect(await panel.textContent()).toContain("Inspeccionar evidencia");
    expect(await page.getByText("En vivo", { exact: true }).count()).toBe(1);
    const partial = Object.values(readRoutineDocument(path)!.occurrences).find((entry) => entry.routine_revision === 4)!;
    expect(partial.receipt).toMatchObject({ freshness: "partial", failure_code: "source-unavailable", captured_at: new Date(now).toISOString(),
      counts: { facts_total: 2, facts_fresh: 1, facts_unavailable: 1 }, consumption: { model_calls: 0, total_tokens: 0, workspace_writes: 0 } });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await panel.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth, width: node.getBoundingClientRect().width }));
      expect(layout.width).toBeGreaterThan(100); expect(layout.scroll).toBeLessThanOrEqual(layout.client + 2);
      const button = await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).evaluate((node) => ({ width: node.getBoundingClientRect().width,
        font: Number.parseFloat(getComputedStyle(node).fontSize), foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
      expect(button.width).toBeGreaterThan(100); expect(button.width).toBeLessThan(280); expect(button.font).toBeGreaterThanOrEqual(10);
      expect(button.foreground).not.toBe(button.background);
      const select = panel.getByRole("combobox", { name: "Concurrencia de rutina", exact: true });
      const readable = await select.locator("option").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).color !== getComputedStyle(node).backgroundColor));
      expect(readable).toBe(true);
    }
    await panel.getByRole("button", { name: "Revisar deshabilitación", exact: true }).click();
    await panel.getByRole("button", { name: "Confirmar deshabilitación", exact: true }).click();
    await expect.poll(() => readRoutineDocument(path)!.routines[id]!.revision).toBe(5);
    expect(readRoutineDocument(path)!.routines[id]!.enabled).toBe(false); expect(Object.keys(readRoutineDocument(path)!.definitions)).toHaveLength(5);
    expect(readRoutineDocument(path)!.definitions[routineRevisionKey(id, 2)]).toMatchObject({ enabled: true, schedule: "every:15m" });
    await page.waitForLoadState("networkidle"); await closeApi(); fixtureEnabled = false;
    server = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: apiPort }); if (!server.listening) await once(server, "listening"); apiClosed = false;
    await page.reload(); await page.getByText("Cockpit diario", { exact: true }).waitFor();
    await panel.getByRole("combobox", { name: "Seleccionar rutina", exact: true }).selectOption(id);
    await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    expect(await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).isChecked()).toBe(false);
    expect(await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).isDisabled()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2); expect(Object.values(readRoutineDocument(path)!.occurrences)).toHaveLength(2);
    expect(await panel.getByRole("region", { name: "Resumen de rutinas", exact: true }).textContent()).toContain("source-unavailable");
    expect(dispatch).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled();
    for (const name of ["tasks", "reports", "issues"]) expect(existsSync(join(state, name))).toBe(false);
    expect(controls).toEqual([
      { method: "POST", path: "/api/routines", body: { action: "refresh-evidence", scope: companyScope } },
      { method: "PUT", path: `/api/routines/${id}`, body: { expected_revision: 1, action: "refresh-evidence", scope: companyScope,
        enabled: true, schedule: "every:15m", concurrency: "coalesce", catch_up: "run-once" } },
      { method: "POST", path: `/api/routines/${id}/run`, body: { expected_revision: 2 } },
      { method: "POST", path: `/api/routines/${id}/disable`, body: { expected_revision: 2 } },
      { method: "PUT", path: `/api/routines/${id}`, body: { expected_revision: 2, action: "refresh-evidence", scope: companyScope,
        enabled: true, schedule: null, concurrency: "coalesce", catch_up: "run-once" } },
      { method: "POST", path: `/api/routines/${id}/run`, body: { expected_revision: 3 } },
      { method: "POST", path: `/api/routines/${id}/run`, body: { expected_revision: 3 } },
      { method: "PUT", path: `/api/routines/${id}`, body: { expected_revision: 3, action: "refresh-evidence", scope: companyScope,
        enabled: true, schedule: null, concurrency: "coalesce", catch_up: "run-once" } },
      { method: "POST", path: `/api/routines/${id}/run`, body: { expected_revision: 4 } },
      { method: "POST", path: `/api/routines/${id}/disable`, body: { expected_revision: 4 } },
    ]);
    expect(pageErrors).toEqual([]); expect(externalRequests).toEqual([]);
    expect(httpErrors).toEqual([{ status: 409, method: "POST", path: `/api/routines/${id}/run` },
      { status: 403, method: "POST", path: `/api/routines/${id}/disable` }]);
    expect(consoleErrors.filter((error) => !error.text.startsWith("Failed to load resource:")
      || !httpErrors.some((expected) => expected.path === error.path))).toEqual([]);
  } finally {
    try { if (runner) await runner.stop(); runnerStopped = true;
      if (browser) await browser.close(); browserClosed = !browser?.isConnected(); }
    finally { try { if (vite) await vite.close(); viteClosed = !vite?.httpServer?.listening; }
      finally { await closeApi(); apiClosed = !server?.listening;
        if (runnerStopped && browserClosed && viteClosed && apiClosed) { expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
          expect(basename(root).startsWith("surtec-routine-panel-browser-")).toBe(true); expect(lstatSync(root).isSymbolicLink()).toBe(false);
          rmSync(root, { recursive: true, force: true }); }
        const result = { fixture_id: basename(root), runner_stopped: runnerStopped, browser_closed: browserClosed,
          vite_closed: viteClosed, api_stopped: apiClosed, workspace_removed: !existsSync(root), failures: [] as string[] };
        console.log("ROUTINE_PANEL_BROWSER_CLEANUP", JSON.stringify(result));
        expect(result).toMatchObject({ runner_stopped: true, browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true });
      }
    }
  }
}, 90000);
