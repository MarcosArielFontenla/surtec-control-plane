import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../lib/budgets/types";
import type { BudgetPolicySource } from "../../../lib/budgets/policy";
import type { OrganizationSnapshot } from "../../../lib/organization";
import { ROUTINE_ACTIONS, type RoutineRecord, type RoutineScope } from "../../../lib/routines/types";
import { routineRevisionKey } from "../../../lib/routines/schedule";
import { readBudgetLedger } from "../../../lib/state/budgets";
import { budgetStatePath, routineStatePath } from "../../../lib/state/paths";
import { readRoutineDocument } from "../../../lib/state/routines";
import type { ProcessManager } from "../../../runner/process-manager";
import { RoutineRunner } from "../../../runner/routine-runner";
import { createHttpSecurity, type HttpSecurity } from "./http-security";
import { createApp } from "./index";
import { createRoutineService, type RoutineConfigureInput, type RoutineDetail, type RoutineServiceDependencies } from "./routine-service";

const fingerprint = "a".repeat(64), startedAt = Date.parse("2026-10-07T12:00:00.000Z");
const originalFetch = globalThis.fetch;
const providerFetch = vi.fn<typeof fetch>(async () => { throw new Error("Synthetic routine API must not contact a provider"); });
const companyScope = { kind: "company", id: "surtec" } as const;
let root: string, state: string, path: string, now: number, policy: BudgetPolicySource;
const runners: RoutineRunner[] = [];

function cleanRoot(): void {
  if (!existsSync(root)) return;
  expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
  expect(basename(root).startsWith("surtec-routine-api-")).toBe(true);
  expect(lstatSync(root).isSymbolicLink()).toBe(false);
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
}
beforeEach(() => {
  root = mkdtempSync(join(resolve(tmpdir()), "surtec-routine-api-")); state = join(root, "state"); path = routineStatePath(state);
  now = startedAt; policy = { fingerprint, policy: { schema_version: 1, revision: 1,
    pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "company-policy", revision: 1,
      scope: companyScope, period: "none", warning_percent: 80,
      limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
  mkdirSync(join(root, "projects")); mkdirSync(join(root, "registry"));
  writeFileSync(join(root, "registry/projects.yml"), "projects: {}\n");
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects")); vi.stubEnv("SURTEC_TIME_ZONE", "UTC");
  providerFetch.mockClear(); vi.stubGlobal("fetch", providerFetch);
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  expect(providerFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  cleanRoot(); expect(existsSync(root)).toBe(false);
});

function organization(): OrganizationSnapshot {
  return { company: { schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: null,
    operating_principles: [], active_objective_ids: ["synthetic-objective"], last_reviewed_at: null },
  objectives: [{ schema_version: 1, id: "synthetic-objective", company_id: "surtec", title: "Synthetic private title",
    desired_outcome: "Synthetic private outcome", success_criteria: [], status: "active", horizon: "ongoing", priority: 1,
    target_date: null, parent_objective_id: null, project_ids: ["alpha"], owner: "marcos", last_reviewed_at: null }],
  project_objectives: { alpha: { objective_ids: ["synthetic-objective"], primary_objective_id: "synthetic-objective" } } };
}
function fixture(overrides: RoutineServiceDependencies = {}, security: HttpSecurity = createHttpSecurity()) {
  const calls = { clock: vi.fn(() => new Date(now)), policy: vi.fn(() => policy), organization: vi.fn(organization),
    projects: vi.fn(() => [{ id: "alpha" }]) };
  const service = createRoutineService(root, { stateRoot: state, clock: calls.clock, readBudgetPolicy: calls.policy,
    readOrganization: calls.organization, listProjects: calls.projects, ...overrides });
  const processes = { start: vi.fn(), stop: vi.fn(), get: vi.fn(() => null), list: vi.fn(() => []), subscribe: vi.fn(() => () => {}) };
  const dispatch = vi.fn<() => void>(), signals = { read: vi.fn(async () => ({ schema_version: 1 as const, observed_at: new Date(now).toISOString(),
    signals: [], pinned_signal_ids: [], warnings: [] })), act: vi.fn() };
  const app = createApp(root, dispatch, processes as unknown as ProcessManager, security, { routines: service, signals });
  return { app, service, calls, processes, dispatch, signals, security };
}
type Fixture = ReturnType<typeof fixture>;
async function mutation(app: Fixture["app"], route: string, value: unknown, method = "POST"): Promise<Response> {
  const session = await app.request("/api/session"), body = await session.json() as { token: string };
  expect(session.headers.get("Cache-Control")).toBe("no-store");
  return app.request(route, { method, headers: { "Content-Type": "application/json", "X-Surtec-Session": body.token }, body: JSON.stringify(value) });
}
async function created(f: Fixture, scope: RoutineScope = companyScope): Promise<RoutineRecord> {
  const response = await mutation(f.app, "/api/routines", { action: "refresh-evidence", scope });
  expect(response.status).toBe(201); return (await response.json() as RoutineDetail).routine;
}
function configuration(record: RoutineRecord, changes: Partial<RoutineConfigureInput> = {}): RoutineConfigureInput {
  return { expected_revision: record.revision, action: record.action, scope: record.scope, enabled: true,
    schedule: "every:15m", concurrency: "skip", catch_up: "skip-missed", ...changes };
}
async function enabled(f: Fixture, changes: Partial<RoutineConfigureInput> = {}): Promise<RoutineRecord> {
  const first = await created(f); now += 1000;
  const response = await mutation(f.app, `/api/routines/${first.id}`, configuration(first, changes), "PUT");
  expect(response.status).toBe(200); return (await response.json() as RoutineDetail).routine;
}
function snapshot(): { bytes: Buffer; modified: number } { return { bytes: readFileSync(path), modified: lstatSync(path).mtimeMs }; }
function unchanged(before: ReturnType<typeof snapshot>): void {
  expect(readFileSync(path)).toEqual(before.bytes); expect(lstatSync(path).mtimeMs).toBe(before.modified);
}
function noExecution(f: Fixture): void {
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.processes.start).not.toHaveBeenCalled(); expect(f.processes.stop).not.toHaveBeenCalled();
  expect(existsSync(budgetStatePath(state))).toBe(false); expect(existsSync(join(state, "tasks"))).toBe(false);
  expect(existsSync(join(state, "reports"))).toBe(false); expect(existsSync(join(state, "issues"))).toBe(false);
  expect(Object.values(readRoutineDocument(path)?.occurrences ?? {})).toEqual([]);
}
async function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done());
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") server.closeAllConnections(); });
  expect(server.listening).toBe(false);
}
async function listening(server: ReturnType<typeof serve>): Promise<string> {
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("T012 protected revisioned routine HTTP API", () => {
  it("returns explicit optional absence through a no-store GET without creating state", async () => {
    const f = fixture(), response = await f.app.request("/api/routines");
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ schema_version: 1, state: "absent", observed_at: new Date(now).toISOString(), revision: null, routines: [] });
    expect(existsSync(state)).toBe(false); noExecution(f);
  });

  it.each(ROUTINE_ACTIONS)("creates only a disabled fixed-action first revision for %s", async (action) => {
    const f = fixture(), response = await mutation(f.app, "/api/routines", { action, scope: companyScope });
    expect(response.status).toBe(201); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const detail = await response.json() as RoutineDetail;
    expect(detail).toMatchObject({ routine: { schema_version: 1, revision: 1, action, enabled: false, schedule: null,
      schedule_anchor_at: null, policy: { revision: 1, fingerprint, policy_ids: ["company-policy"] }, limits: { max_projects: 25,
        max_attempts: 1, max_runtime_ms: 60000, max_concurrent_occurrences: 1 } }, occurrences: [], last_occurrence: null,
      next_slot: null, occurrences_total: 0, execution: { state: "inactive", executable: false } });
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(detail.routine.id, 1)]).toEqual(detail.routine);
    expect(JSON.stringify(detail)).not.toContain(root); expect(JSON.stringify(detail)).not.toContain("Synthetic private"); noExecution(f);
  });

  it.each([{ kind: "project", id: "alpha" }, { kind: "objective", id: "synthetic-objective" }] as const)("resolves existing %s scope without caller paths", async (scope) => {
    const f = fixture(), record = await created(f, scope); expect(record.scope).toEqual(scope); noExecution(f);
  });

  it("configures an exact revision, preserves original history and reconstructs identical reads after restart", async () => {
    const f = fixture(), original = await created(f); now += 1000;
    const response = await mutation(f.app, `/api/routines/${original.id}`, configuration(original, { concurrency: "coalesce", catch_up: "run-once" }), "PUT");
    expect(response.status).toBe(200); const detail = await response.json() as RoutineDetail;
    expect(detail.routine).toMatchObject({ revision: 2, enabled: true, schedule: "every:15m", schedule_anchor_at: new Date(now).toISOString(),
      created_at: original.created_at, updated_at: new Date(now).toISOString(), concurrency: "coalesce", catch_up: "run-once" });
    expect(detail.next_slot).toBe(new Date(now + 900000).toISOString()); expect(detail.routine.limits).toEqual(original.limits);
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(original.id, 1)]).toEqual(original);
    const before = snapshot(), restarted = fixture();
    for (const current of [f, restarted]) {
      const read = await current.app.request(`/api/routines/${original.id}`); expect(read.headers.get("Cache-Control")).toBe("no-store");
      expect(await read.json()).toEqual(detail); noExecution(current);
    }
    unchanged(before);
  });

  it("disables via a fresh revision without deleting history or manufacturing accounting", async () => {
    const f = fixture(), record = await enabled(f); now += 1000;
    const response = await mutation(f.app, `/api/routines/${record.id}/disable`, { expected_revision: record.revision });
    expect(response.status).toBe(200); const detail = await response.json() as RoutineDetail;
    expect(detail.routine).toMatchObject({ revision: 3, enabled: false, created_at: record.created_at, updated_at: new Date(now).toISOString() });
    expect(detail.next_slot).toBeNull(); expect(detail.routine.policy).toEqual(record.policy);
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(record.id, record.revision)]).toEqual(record); noExecution(f);
  });

  it.each([false, true])("refuses a production run when enabled=%s rather than reporting a successful no-op", async (isEnabled) => {
    const f = fixture(), record = isEnabled ? await enabled(f) : await created(f), before = snapshot();
    vi.stubEnv("SURTEC_ROUTINES_ENABLED", "1"); vi.stubEnv("SURTEC_BUDGET_CUTOVER", "1");
    const response = await mutation(f.app, `/api/routines/${record.id}/run`, { expected_revision: record.revision });
    expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("no run was confirmed") }); unchanged(before); noExecution(f);
  });

  it.each(["configure", "run", "disable"] as const)("rejects stale %s without bytes, timestamps or execution effects", async (operation) => {
    const f = fixture(), record = await enabled(f), before = snapshot(); now += 1000;
    const response = await mutation(f.app, `/api/routines/${record.id}${operation === "configure" ? "" : `/${operation}`}`,
      operation === "configure" ? configuration(record, { expected_revision: 1 }) : { expected_revision: 1 }, operation === "configure" ? "PUT" : "POST");
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: expect.stringContaining("revision changed") }); unchanged(before); noExecution(f);
  });

  it.each(["create", "configure", "run", "disable"] as const)("protects %s before all service/domain reads for hostile origins, hosts, sites or sessions", async (operation) => {
    const f = fixture(), spy = vi.spyOn(f.service, operation), route = operation === "create" ? "/api/routines"
      : `/api/routines/synthetic${operation === "configure" ? "" : `/${operation}`}`, method = operation === "configure" ? "PUT" : "POST";
    const cases = [{ headers: {} }, { headers: { "X-Surtec-Session": "synthetic-stale" } },
      { headers: { "X-Surtec-Session": f.security.token, Origin: "https://hostile.invalid" } },
      { headers: { "X-Surtec-Session": f.security.token, Host: "hostile.invalid" } },
      { headers: { "X-Surtec-Session": f.security.token, "Sec-Fetch-Site": "cross-site" } },
      { headers: { "X-Surtec-Session": f.security.token, "Sec-Fetch-Site": "same-site" } }];
    for (const entry of cases) {
      const response = await f.app.request(route, { method, headers: entry.headers as Record<string, string>, body: "{}" });
      expect(response.status).toBe(403); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(spy).not.toHaveBeenCalled(); for (const reader of Object.values(f.calls)) expect(reader).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });

  it("rejects a prior API session after restart and requires a new explicit configuration action", async () => {
    const f = fixture(), record = await created(f), before = snapshot(), restarted = fixture();
    const route = `/api/routines/${record.id}`, body = configuration(record);
    const stale = await restarted.app.request(route, { method: "PUT", headers: { "X-Surtec-Session": f.security.token }, body: JSON.stringify(body) });
    expect(stale.status).toBe(403); unchanged(before); expect(restarted.calls.clock).not.toHaveBeenCalled();
    now += 1000; expect((await mutation(restarted.app, route, body, "PUT")).status).toBe(200);
    expect(readRoutineDocument(path)?.routines[record.id]?.revision).toBe(2); noExecution(restarted);
  });

  it.each(["create", "configure", "run", "disable"] as const)("bounds and parses %s JSON before invoking the service", async (operation) => {
    const f = fixture(), spy = vi.spyOn(f.service, operation), route = operation === "create" ? "/api/routines"
      : `/api/routines/synthetic${operation === "configure" ? "" : `/${operation}`}`, method = operation === "configure" ? "PUT" : "POST";
    for (const [body, status] of [["{", 400], [JSON.stringify({ private: "x".repeat(4097) }), 413]] as const) {
      const response = await f.app.request(route, { method, headers: { "X-Surtec-Session": f.security.token }, body });
      expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(spy).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });

  it.each(["id", "revision", "schema_version", "enabled", "schedule", "command", "url", "path", "destination", "instructions", "model",
    "adapter", "execution", "runner", "ownership", "policy", "limits", "budget", "grant", "__proto__", "constructor"])("rejects caller create field %s without effects", async (key) => {
    const f = fixture(), response = await mutation(f.app, "/api/routines", { action: "refresh-evidence", scope: companyScope, [key]: "synthetic" });
    expect(response.status).toBe(400); for (const reader of Object.values(f.calls)) expect(reader).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });

  it.each([null, [], 1, "synthetic", {}, { action: "run-command", scope: companyScope },
    { action: "refresh-evidence", scope: { kind: "company", id: "other" } }, { action: "refresh-evidence", scope: { ...companyScope, path: "synthetic" } }])(
    "rejects malformed create body %# before persistence", async (input) => {
      const f = fixture(); expect((await mutation(f.app, "/api/routines", input)).status).toBe(400); expect(existsSync(state)).toBe(false);
    });

  it.each(["limits", "policy", "id", "command", "path", "url", "execution", "ownership"])("rejects configuration %s injection without altering the current revision", async (key) => {
    const f = fixture(), record = await enabled(f), before = snapshot();
    expect((await mutation(f.app, `/api/routines/${record.id}`, { ...configuration(record), [key]: {} }, "PUT")).status).toBe(400);
    unchanged(before); noExecution(f);
  });

  it.each([null, 0, -1, 1.5, "1"])("rejects invalid expected_revision %s for run and disable", async (revision) => {
    const f = fixture(), record = await enabled(f), before = snapshot();
    for (const operation of ["run", "disable"]) expect((await mutation(f.app, `/api/routines/${record.id}/${operation}`, { expected_revision: revision })).status).toBe(400);
    unchanged(before); noExecution(f);
  });

  it.each(["every:14m", "every:10081m", "* * * * *", "node synthetic.mjs"])("refuses unsupported schedule %s with no config mutation", async (schedule) => {
    const f = fixture(), record = await enabled(f), before = snapshot();
    expect((await mutation(f.app, `/api/routines/${record.id}`, configuration(record, { schedule }), "PUT")).status).toBe(400); unchanged(before); noExecution(f);
  });

  it.each(["command", "path", "execution", "ownership", "reservation_id", "force"])("refuses caller %s at both revision-only controls", async (key) => {
    const f = fixture(), record = await enabled(f), before = snapshot();
    for (const action of ["run", "disable"]) expect((await mutation(f.app, `/api/routines/${record.id}/${action}`, { expected_revision: record.revision, [key]: true })).status).toBe(400);
    unchanged(before); noExecution(f);
  });

  it.each(["?path=synthetic", "?refresh=1", "?expected_revision=1", "?id=a&id=b"])("refuses all routine query metadata %s before service invocation", async (query) => {
    const f = fixture(), methods = ["list", "detail", "create", "configure", "run", "disable"] as const;
    const spies = methods.map((method) => vi.spyOn(f.service, method));
    for (const [route, method] of [["/api/routines", "GET"], ["/api/routines/synthetic", "GET"], ["/api/routines", "POST"],
      ["/api/routines/synthetic", "PUT"], ["/api/routines/synthetic/run", "POST"], ["/api/routines/synthetic/disable", "POST"]]) {
      const response = await f.app.request(`${route}${query}`, { method, headers: { "X-Surtec-Session": f.security.token }, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(response.status).toBe(400); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });

  it.each(["../escape", "constructor", "prototype", "__proto__", "a\\b", "a\n", "a\0", "x".repeat(161)])("refuses unsafe route identifier %# before creating paths", async (id) => {
    const f = fixture(), response = await f.app.request(`/api/routines/${encodeURIComponent(id)}`);
    expect(response.status).toBe(400); expect(existsSync(state)).toBe(false); expect(f.calls.clock).not.toHaveBeenCalled();
  });

  it("refuses unknown routine/scope identities rather than inventing definitions or empty ownership", async () => {
    const f = fixture(); expect((await f.app.request("/api/routines/missing")).status).toBe(404);
    for (const operation of ["run", "disable"]) expect((await mutation(f.app, `/api/routines/missing/${operation}`, { expected_revision: 1 })).status).toBe(404);
    expect((await mutation(f.app, "/api/routines/missing", { ...configuration({ id: "missing", revision: 1, action: "refresh-evidence", scope: companyScope } as RoutineRecord) }, "PUT")).status).toBe(404);
    for (const scope of [{ kind: "project", id: "missing" }, { kind: "objective", id: "missing" }]) {
      expect((await mutation(f.app, "/api/routines", { action: "refresh-evidence", scope })).status).toBe(404);
    }
    expect(existsSync(state)).toBe(false);
  });

  it.each(["malformed", "future", "null", "contradictory"] as const)("preserves %s routine bytes and isolates unavailable state from other routes", async (kind) => {
    const f = fixture(), content = kind === "malformed" ? "{ SYNTHETIC PRIVATE INVALID" : kind === "future"
      ? '{"schema_version":999,"private":"SYNTHETIC PRIVATE INVALID"}' : kind === "null" ? "null" : "{}";
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); const before = snapshot();
    const list = await f.app.request("/api/routines"); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ state: "unavailable", observed_at: null, revision: null, routines: [] });
    for (const response of [await f.app.request("/api/routines/synthetic"), await mutation(f.app, "/api/routines", { action: "refresh-evidence", scope: companyScope }),
      await mutation(f.app, "/api/routines/synthetic/run", { expected_revision: 1 }), await mutation(f.app, "/api/routines/synthetic/disable", { expected_revision: 1 })]) {
      expect(response.status).toBe(409); expect(await response.text()).not.toContain("SYNTHETIC PRIVATE");
    }
    expect((await f.app.request("/api/runs")).status).toBe(200); expect((await f.app.request("/api/budgets")).status).toBe(200);
    unchanged(before); expect(readdirSync(dirname(path))).toEqual(["routines.json"]); expect(existsSync(join(state, "locks"))).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(existsSync(budgetStatePath(state))).toBe(false);
  });

  it("retains a hardlinked store and a foreign lock without repair, release or stealing", async () => {
    const f = fixture(), record = await created(f), before = snapshot(), alias = join(root, "routine-alias.json"); linkSync(path, alias);
    expect((await mutation(f.app, `/api/routines/${record.id}/disable`, { expected_revision: record.revision })).status).toBe(409);
    unchanged(before); expect(readFileSync(alias)).toEqual(before.bytes);
    // The independently owned test alias is removed only to test a separate lock refusal.
    rmSync(alias); const lock = join(state, "locks/routines.lock"); writeFileSync(lock, "synthetic unknown owner"); now += 1000;
    expect((await mutation(f.app, `/api/routines/${record.id}/disable`, { expected_revision: record.revision })).status).toBe(409);
    unchanged(before); expect(readFileSync(lock, "utf8")).toBe("synthetic unknown owner"); noExecution(f);
  });

  it("sanitizes unknown service exceptions and preserves disabled configuration under policy failure", async () => {
    const f = fixture(), spy = vi.spyOn(f.service, "create").mockImplementation(() => { throw new Error(`SYNTHETIC PRIVATE ${root}`); });
    const failed = await mutation(f.app, "/api/routines", { action: "refresh-evidence", scope: companyScope });
    expect(failed.status).toBe(409); const text = await failed.text(); expect(text).not.toContain("SYNTHETIC PRIVATE"); expect(text).not.toContain(root);
    spy.mockRestore(); const record = await enabled(f); now += 1000;
    const degraded = fixture({ readBudgetPolicy: () => { throw new Error("SYNTHETIC PRIVATE POLICY"); } });
    expect((await mutation(degraded.app, `/api/routines/${record.id}/disable`, { expected_revision: record.revision })).status).toBe(200);
    expect(readRoutineDocument(path)?.routines[record.id]?.enabled).toBe(false); noExecution(degraded);
  });

  it("returns one durable fixture-owned occurrence and never replays the exact manual slot", async () => {
    const read = vi.fn(async () => ({ sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: new Date(now).toISOString(), fingerprint }], signals: [] }));
    const runner = new RoutineRunner({ stateRoot: state, now: () => new Date(now), execution: { resolve: (_definition, id) => ({ source: policy,
      attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: null, execution_id: id } }),
      assert_current: () => undefined, read_evidence: read, monotonic: () => 0 } }); runners.push(runner);
    const f = fixture({ execution: { runner, worker_id: "synthetic-worker", available_reads: () => 1 } }), record = await enabled(f, { schedule: null }); now += 1000;
    const response = await mutation(f.app, `/api/routines/${record.id}/run`, { expected_revision: record.revision }); expect(response.status).toBe(200);
    const admitted = await response.json(); expect(admitted).toMatchObject({ status: "admitted", execution: { state: "fixture-enabled", executable: false } });
    expect(admitted.occurrence.id).toBe(Object.values(readRoutineDocument(path)!.occurrences)[0]?.id); await runner.idle();
    const before = snapshot(), ledger = readFileSync(budgetStatePath(state));
    const duplicate = await mutation(f.app, `/api/routines/${record.id}/run`, { expected_revision: record.revision });
    expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({ status: "existing", occurrence: { id: admitted.occurrence.id } });
    unchanged(before); expect(readFileSync(budgetStatePath(state))).toEqual(ledger); expect(read).toHaveBeenCalledOnce();
    const detail = await (await fixture().app.request(`/api/routines/${record.id}`)).json() as RoutineDetail;
    expect(detail).toMatchObject({ occurrences_total: 1, execution: { state: "inactive", executable: false }, last_occurrence: { status: "completed",
      receipt: { consumption: { attempts: 1, model_calls: 0, total_tokens: 0, workspace_writes: 0 } } } });
    expect(Object.values(readBudgetLedger(budgetStatePath(state))!.reservations)[0]?.status).toBe("settled");
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.processes.start).not.toHaveBeenCalled();
  });

  it("uses actual loopback HTTP with same-origin guards and rotated sessions without starting execution", async () => {
    const f = fixture(), server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      const base = await listening(server), session = await originalFetch(`${base}/api/session`), { token } = await session.json() as { token: string };
      const headers = { "Content-Type": "application/json", "X-Surtec-Session": token, Origin: base, "Sec-Fetch-Site": "same-origin" };
      const response = await originalFetch(`${base}/api/routines`, { method: "POST", headers, body: JSON.stringify({ action: "refresh-evidence", scope: companyScope }) });
      expect(response.status).toBe(201); const detail = await response.json() as RoutineDetail;
      const before = snapshot();
      const denied = await originalFetch(`${base}/api/routines/${detail.routine.id}/run`, { method: "POST", headers, body: JSON.stringify({ expected_revision: 1 }) });
      expect(denied.status).toBe(409);
      const hostile = await originalFetch(`${base}/api/routines`, { headers: { Origin: "https://hostile.invalid" } }); expect(hostile.status).toBe(403);
      const read = await originalFetch(`${base}/api/routines/${detail.routine.id}`, { headers: { Origin: base } }); expect(await read.json()).toEqual(detail);
      const stale = await fixture().app.request(`/api/routines/${detail.routine.id}/disable`, { method: "POST", headers, body: JSON.stringify({ expected_revision: 1 }) });
      expect(stale.status).toBe(403); unchanged(before); noExecution(f);
    } finally { await closeServer(server); }
  }, 90000);

  it.runIf(process.env.SURTEC_ROUTINE_API_BROWSER_SMOKE === "1")("validates seven client wrappers in the actual dashboard across reload and API restart without execution", async () => {
    const f = fixture(); let server: ReturnType<typeof serve> | undefined, vite: ViteDevServer | undefined, browser: Browser | undefined;
    let closedApi = false, closedVite = false, closedBrowser = false;
    try {
      server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 }); const apiUrl = await listening(server);
      const apiPort = (server.address() as AddressInfo).port;
      vite = await createViteServer({ configFile: false, root: resolve("dashboard"), plugins: [react()], cacheDir: join(root, "vite-cache"),
        server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/api": { target: apiUrl } } } });
      await vite.listen(); const dashboardUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
        browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors: string[] = [], externalRequests: string[] = [];
      const consoleErrors: Array<{ text: string; path: string }> = [], httpErrors: Array<{ status: number; method: string; path: string }> = [];
      const controlRequests: Array<{ method: string; path: string }> = [];
      let interceptedFontStylesheets = 0;
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") { const location = message.location().url;
        consoleErrors.push({ text: message.text(), path: location ? new URL(location).pathname : "" }); } });
      page.on("response", (response) => { if (response.status() >= 400) httpErrors.push({ status: response.status(),
        method: response.request().method(), path: new URL(response.url()).pathname }); });
      page.on("request", (request) => { const url = new URL(request.url());
        if (url.pathname.startsWith("/api/routines") && ["POST", "PUT"].includes(request.method())) controlRequests.push({ method: request.method(), path: url.pathname }); });
      await page.route("**/*", async (route) => { const url = new URL(route.request().url());
        if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
        else if (url.protocol === "https:" && url.hostname === "fonts.googleapis.com" && url.pathname === "/css2"
          && route.request().resourceType() === "stylesheet") {
          // The existing dashboard imports this font sheet. Fulfill only that
          // static asset locally; no network access or provider read is allowed.
          interceptedFontStylesheets++; await route.fulfill({ status: 200, contentType: "text/css", body: "" });
        } else { externalRequests.push(url.hostname); await route.abort(); } });
      await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }); await page.getByText("Cockpit diario", { exact: true }).waitFor();
      await page.getByText("En vivo", { exact: true }).waitFor();
      // Load the actual client module in Chromium rather than letting Vitest's
      // SSR transform rewrite an import inside the serialized browser callback.
      const clientModule = { type: "module", content: "import * as api from '/src/ui/api.ts'; globalThis.__routineApiSmoke = api;" };
      await page.addScriptTag(clientModule);
      const flow = await page.evaluate(async () => {
        const api = (globalThis as typeof globalThis & { __routineApiSmoke: typeof import("../ui/api") }).__routineApiSmoke;
        const initial = await api.fetchRoutines(), budget = await api.fetchBudgets();
        const created = await api.createRoutine({ action: "refresh-evidence", scope: { kind: "company", id: "surtec" } });
        const configured = await api.configureRoutine(created.routine.id, { expected_revision: created.routine.revision,
          action: created.routine.action, scope: created.routine.scope, enabled: true, schedule: "every:15m", concurrency: "skip", catch_up: "skip-missed" });
        let denial = ""; try { await api.runRoutine(created.routine.id, configured.routine.revision); } catch (error) { denial = (error as Error).message; }
        const disabled = await api.disableRoutine(created.routine.id, configured.routine.revision), read = await api.fetchRoutine(created.routine.id);
        return { initial, budget, created, configured, denial, disabled, read };
      });
      expect(flow.initial.state).toBe("absent"); expect(flow.budget).toMatchObject({ executable: false, reserves_capacity: false, ledger: { status: "absent" } });
      expect(flow.created.routine).toMatchObject({ revision: 1, enabled: false }); expect(flow.configured.routine).toMatchObject({ revision: 2, enabled: true });
      expect(flow.denial).toContain("no run was confirmed"); expect(flow.disabled.routine).toMatchObject({ revision: 3, enabled: false }); expect(flow.read).toEqual(flow.disabled);
      expect(controlRequests.filter((request) => request.path.endsWith("/run"))).toHaveLength(1);
      const before = snapshot();
      // Keep the actual module's cached session alive across API restart. A reload
      // first would erase it and fail to exercise the client's no-replay guard.
      const previousToken = await page.evaluate(async () => (await (await fetch("/api/session", { cache: "no-store" })).json()).token as string);
      await page.waitForLoadState("networkidle"); await closeServer(server); closedApi = true;
      const restarted = fixture(); server = serve({ fetch: restarted.app.fetch, hostname: "127.0.0.1", port: apiPort }); await listening(server); closedApi = false;
      const beforeStaleAction = controlRequests.length;
      const stale = await page.evaluate(async ({ id, revision }) => {
        const api = (globalThis as typeof globalThis & { __routineApiSmoke: typeof import("../ui/api") }).__routineApiSmoke;
        try { await api.disableRoutine(id, revision); return { rejected: false, error: "" }; }
        catch (error) { return { rejected: true, error: (error as Error).message }; }
      }, { id: flow.created.routine.id, revision: flow.disabled.routine.revision });
      expect(stale).toMatchObject({ rejected: true, error: expect.stringContaining("valid session token required") });
      expect(controlRequests).toHaveLength(beforeStaleAction + 1); unchanged(before);
      const rotated = await page.evaluate(async ({ id, revision, previousToken }) => {
        const api = (globalThis as typeof globalThis & { __routineApiSmoke: typeof import("../ui/api") }).__routineApiSmoke;
        const read = await api.fetchRoutine(id), disabled = await api.disableRoutine(id, revision);
        const newToken = (await (await fetch("/api/session", { cache: "no-store" })).json()).token;
        return { changed: newToken !== previousToken, read, disabled };
      }, { id: flow.created.routine.id, revision: flow.disabled.routine.revision, previousToken });
      expect(rotated.changed).toBe(true); expect(rotated.read).toEqual(flow.disabled);
      expect(rotated.disabled.routine).toMatchObject({ revision: 4, enabled: false });
      expect(controlRequests.filter((request) => request.path.endsWith("/disable"))).toHaveLength(3);
      await page.reload(); await page.getByText("Cockpit diario", { exact: true }).waitFor();
      await page.addScriptTag(clientModule);
      expect(await page.evaluate(async (id) => { const api = (globalThis as typeof globalThis & { __routineApiSmoke: typeof import("../ui/api") }).__routineApiSmoke;
        return api.fetchRoutine(id); }, flow.created.routine.id)).toEqual(rotated.disabled);
      expect(readRoutineDocument(path)?.routines[flow.created.routine.id]?.revision).toBe(4);
      expect(Object.keys(readRoutineDocument(path)!.definitions)).toHaveLength(4); expect(pageErrors).toEqual([]); expect(externalRequests).toEqual([]);
      expect(interceptedFontStylesheets).toBeGreaterThan(0);
      expect(httpErrors).toEqual([{ status: 409, method: "POST", path: `/api/routines/${flow.created.routine.id}/run` },
        { status: 403, method: "POST", path: `/api/routines/${flow.created.routine.id}/disable` }]);
      expect(consoleErrors.filter((error) => !error.text.startsWith("Failed to load resource:")
        || !httpErrors.some((expected) => expected.path === error.path))).toEqual([]);
      noExecution(f); noExecution(restarted);
    } finally {
      try { if (browser) { await browser.close(); closedBrowser = !browser.isConnected(); } else closedBrowser = true; }
      finally { try { if (vite) { await vite.close(); closedVite = !vite.httpServer?.listening; } else closedVite = true; }
        finally { if (server) await closeServer(server); closedApi = !server?.listening;
          if (closedBrowser && closedVite && closedApi) cleanRoot();
          const cleanup = { fixture_id: basename(root), browser_closed: closedBrowser, vite_closed: closedVite, api_stopped: closedApi,
            workspace_removed: !existsSync(root), failures: [] as string[] };
          expect(cleanup).toMatchObject({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true });
          console.log("ROUTINE_API_BROWSER_CLEANUP", JSON.stringify(cleanup)); }
      }
    }
  }, 90000);
});
