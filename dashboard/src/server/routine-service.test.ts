import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLimits } from "../../../lib/budgets/types";
import { resolveOccurrenceBudgetAttribution, type BudgetPolicySource } from "../../../lib/budgets/policy";
import { budgetOccurrenceIntentId } from "../../../lib/budgets/reservations";
import type { Objective, OrganizationSnapshot } from "../../../lib/organization";
import type { RoutineActionEvidence, RoutineEvidenceReadOptions } from "../../../lib/routines/actions";
import { routineRevisionKey, routineSlotKey } from "../../../lib/routines/schedule";
import { ROUTINE_ACTIONS, type RoutineOccurrence, type RoutineRecord, type RoutineScope } from "../../../lib/routines/types";
import { assertRoutineOccurrence } from "../../../lib/routines/validation";
import { readBudgetLedger } from "../../../lib/state/budgets";
import { budgetStatePath, routineStatePath } from "../../../lib/state/paths";
import { mutateRoutineDocument, readRoutineDocument, updateRoutineTransaction } from "../../../lib/state/routines";
import { RoutineRunner } from "../../../runner/routine-runner";
import { createRoutineService, RoutineServiceError } from "./routine-service";

const digest = "a".repeat(64), start = Date.parse("2026-10-07T12:00:00.000Z");
const limits = (caps: Partial<BudgetAmounts> = {}): BudgetLimits => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key,
  caps[key] === undefined ? { status: "unconfigured" } : { status: "configured", hard_cap: caps[key] }])) as BudgetLimits;
const source = (caps: Partial<BudgetAmounts> = {}): BudgetPolicySource => ({ fingerprint: digest,
  policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [
    { id: "company-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: limits(caps) },
  ] } });
const objective = (id: string, parent: string | null = null): Objective => ({ schema_version: 1, id, company_id: "surtec", title: "Synthetic objective",
  desired_outcome: "A deterministic local observation", success_criteria: [], status: "active", horizon: "ongoing", priority: 1,
  target_date: null, parent_objective_id: parent, project_ids: ["alpha"], owner: "marcos", last_reviewed_at: null });
function organization(): OrganizationSnapshot {
  return { company: { schema_version: 1, id: "surtec", display_name: "Synthetic", mission: null, operating_principles: [],
    active_objective_ids: ["objective-1"], last_reviewed_at: null }, objectives: [objective("objective-1")],
    project_objectives: { alpha: { objective_ids: ["objective-1"], primary_objective_id: "objective-1" } } };
}

describe("T012 protected application routine service", () => {
  let root: string, state: string, path: string, ledgerPath: string, now: number;
  let policy: BudgetPolicySource, domain: OrganizationSnapshot, projects: Array<{ id: string }>;
  const runners: RoutineRunner[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(resolve(tmpdir()), "surtec-routine-service-")); state = join(root, "state"); path = routineStatePath(state);
    ledgerPath = budgetStatePath(state); now = start; policy = source(); domain = organization(); projects = [{ id: "alpha" }];
  });
  afterEach(async () => {
    vi.restoreAllMocks(); for (const runner of runners.splice(0)) await runner.stop(); vi.unstubAllEnvs();
    expect(dirname(root)).toBe(resolve(tmpdir())); expect(root.startsWith(join(resolve(tmpdir()), "surtec-routine-service-"))).toBe(true);
    expect(lstatSync(root).isSymbolicLink()).toBe(false); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
  });
  const clock = () => new Date(now);
  const dependencies = () => ({ stateRoot: state, clock, readBudgetPolicy: () => policy, readBudgetLedger: () => readBudgetLedger(ledgerPath),
    readOrganization: () => domain, listProjects: () => projects });
  const service = () => createRoutineService(root, dependencies());
  const create = (scope: RoutineScope = { kind: "company", id: "surtec" }) => service().create({ action: "refresh-evidence", scope }).routine;
  type ConfigurationChange = Partial<Pick<RoutineRecord, "action" | "scope" | "enabled" | "schedule" | "concurrency" | "catch_up">>;
  const configuration = (record: RoutineRecord, changes: ConfigurationChange = {}) => ({ expected_revision: record.revision,
    action: record.action, scope: record.scope, enabled: true, schedule: "every:15m", concurrency: "skip" as const,
    catch_up: "skip-missed" as const, ...changes });
  const bytes = () => readFileSync(path), inventory = () => Object.values(readRoutineDocument(path)?.occurrences ?? {});
  const advance = (ms = 1000) => { now += ms; };
  function enabled(scope: RoutineScope = { kind: "company", id: "surtec" }, changes: ConfigurationChange = {}) {
    const first = create(scope); advance(); return service().configure(first.id, configuration(first, changes)).routine;
  }
  function evidence(): RoutineActionEvidence {
    return { sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: clock().toISOString(), fingerprint: digest }], signals: [] };
  }
  function wired(read: (entry: Readonly<RoutineOccurrence>, options: RoutineEvidenceReadOptions) => Promise<RoutineActionEvidence> = vi.fn(async () => evidence()), clockOffset = 0) {
    const runner = new RoutineRunner({ stateRoot: state, now: () => new Date(now + clockOffset), execution: {
      resolve: (definition, id) => ({ source: policy, attribution: resolveOccurrenceBudgetAttribution({ organization: domain, project_ids: ["alpha"],
        objective_id: definition.scope.kind === "objective" ? definition.scope.id : definition.scope.kind === "project"
          ? domain.project_objectives[definition.scope.id]?.primary_objective_id ?? null : null, execution_id: id }) }), assert_current: () => undefined,
      read_evidence: read, monotonic: () => 0,
    } }); runners.push(runner);
    return { runner, read, api: createRoutineService(root, { ...dependencies(), execution: { runner, worker_id: "fixture-worker", available_reads: () => 1 } }) };
  }

  it("reports optional absence without creating state, locks, accounting or invented definitions", () => {
    const result = service().list(); expect(result).toMatchObject({ state: "absent", revision: null, routines: [], observed_at: clock().toISOString() });
    expect(service().warnings()).toEqual([]); expect(existsSync(state)).toBe(false);
  });
  it("distinguishes invalid input, missing identity and unavailable/stale authority with sanitized status codes", () => {
    function rejected(status: number, action: () => unknown): void {
      let failure: unknown; try { action(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(RoutineServiceError); expect(failure).toMatchObject({ status });
      expect(String(failure)).not.toContain(root);
    }
    rejected(400, () => service().detail("../escape")); rejected(404, () => service().detail("missing"));
    const record = enabled(); rejected(409, () => service().disable(record.id, { expected_revision: 1 }));
    rejected(409, () => service().run(record.id, { expected_revision: record.revision })); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each(ROUTINE_ACTIONS)("creates only a disabled fixed-action first revision for %s", (action) => {
    const result = service().create({ action, scope: { kind: "company", id: "surtec" } });
    expect(result.routine).toMatchObject({ schema_version: 1, revision: 1, action, enabled: false, schedule: null, schedule_anchor_at: null,
      concurrency: "skip", catch_up: "skip-missed", policy: { revision: 1, fingerprint: digest, policy_ids: ["company-policy"] },
      limits: { max_attempts: 1, max_runtime_ms: 60000, max_projects: 25, max_concurrent_occurrences: 1 }, created_at: clock().toISOString() });
    expect(result.routine.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/); expect(result.execution.executable).toBe(false);
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(result.routine.id, 1)]).toEqual(result.routine);
    expect(inventory()).toHaveLength(0); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("configures exact revision and anchor, preserves all history, and survives service restart", () => {
    const original = create({ kind: "project", id: "alpha" }), first = structuredClone(original); advance();
    const changed = service().configure(original.id, configuration(original, { concurrency: "coalesce", catch_up: "run-once" }));
    expect(changed.routine).toMatchObject({ revision: 2, enabled: true, schedule_anchor_at: clock().toISOString(), updated_at: clock().toISOString(),
      created_at: first.created_at, concurrency: "coalesce", catch_up: "run-once" });
    expect(changed.routine.limits).toEqual(first.limits); expect(readRoutineDocument(path)?.definitions[routineRevisionKey(first.id, 1)]).toEqual(first);
    const before = bytes(), restarted = service(); expect(restarted.detail(first.id).routine).toEqual(changed.routine);
    expect(restarted.list().routines).toHaveLength(1); expect(bytes().equals(before)).toBe(true); expect(inventory()).toHaveLength(0);
  });
  it("creates each new interval revision anchor at its own transaction time, not the original slot", () => {
    const first = enabled(); advance(900000); const second = service().configure(first.id, configuration(first, { schedule: "every:30m" })).routine;
    expect(second.revision).toBe(3); expect(second.schedule_anchor_at).toBe(clock().toISOString()); expect(second.schedule_anchor_at).not.toBe(first.schedule_anchor_at);
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(first.id, 2)]).toEqual(first);
  });
  it("supports explicit manual-only configuration without causing automatic admission", () => {
    const current = enabled({ kind: "company", id: "surtec" }, { schedule: null });
    expect(current).toMatchObject({ enabled: true, schedule: null, schedule_anchor_at: null }); expect(inventory()).toHaveLength(0); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("disables through a new exact revision without deleting definitions, receipts or accounting", () => {
    const current = enabled(); advance(); const disabled = service().disable(current.id, { expected_revision: current.revision });
    expect(disabled.routine).toMatchObject({ revision: 3, enabled: false, created_at: current.created_at, updated_at: clock().toISOString() });
    expect(readRoutineDocument(path)?.definitions[routineRevisionKey(current.id, 2)]).toEqual(current); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each(["configure", "disable", "run"] as const)("refuses stale %s without changing bytes or modification time", (operation) => {
    const current = enabled(), before = bytes(), mtime = statSync(path).mtimeMs; advance();
    expect(() => operation === "configure" ? service().configure(current.id, { ...configuration(current), expected_revision: 1 })
      : service()[operation](current.id, { expected_revision: 1 })).toThrow();
    expect(bytes().equals(before)).toBe(true); expect(statSync(path).mtimeMs).toBe(mtime); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each(["detail", "configure", "disable", "run"] as const)("does not invent an unknown routine during %s", (operation) => {
    expect(() => operation === "detail" ? service().detail("missing") : operation === "configure"
      ? service().configure("missing", { expected_revision: 1, action: "refresh-evidence", scope: { kind: "company", id: "surtec" }, enabled: true,
        schedule: null, concurrency: "skip", catch_up: "skip-missed" }) : service()[operation]("missing", { expected_revision: 1 })).toThrow();
    expect(existsSync(state)).toBe(false);
  });
  it.each(["../escape", "constructor", "__proto__", "id\n", "a".repeat(161)])("refuses unsafe route identity %j without writes", (id) => {
    expect(() => service().detail(id)).toThrow(); expect(() => service().disable(id, { expected_revision: 1 })).toThrow(); expect(existsSync(state)).toBe(false);
  });
  it.each(["id", "revision", "policy", "limits", "command", "url", "path", "model", "execution", "owner"])("refuses request-owned %s before reading sources or invoking effects", (key) => {
    const read = vi.fn(() => policy), list = vi.fn(() => projects), api = createRoutineService(root, { ...dependencies(), readBudgetPolicy: read, listProjects: list });
    expect(() => api.create({ action: "refresh-evidence", scope: { kind: "company", id: "surtec" }, [key]: "injected" } as never)).toThrow();
    expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });
  it.each(["getter", "nested-getter", "proxy", "toJSON", "prototype", "symbol", "cycle"] as const)("refuses %s input without running hooks", (kind) => {
    const hook = vi.fn(), request: Record<string | symbol, unknown> = { action: "refresh-evidence", scope: { kind: "company", id: "surtec" } };
    if (kind === "getter") Object.defineProperty(request, "action", { enumerable: true, get: hook });
    if (kind === "nested-getter") Object.defineProperty(request.scope, "id", { enumerable: true, get: hook });
    if (kind === "toJSON") (request.scope as Record<string, unknown>).toJSON = hook;
    if (kind === "prototype") Object.setPrototypeOf(request, { scope: hook });
    if (kind === "symbol") request[Symbol("hidden")] = hook;
    if (kind === "cycle") request.scope = request;
    expect(() => service().create((kind === "proxy" ? new Proxy(request, { get: hook }) : request) as never)).toThrow();
    expect(hook).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });
  it.each(["enabled", "schedule", "concurrency", "catch_up", "action", "scope"] as const)("requires the explicit configure field %s", (key) => {
    const record = create(), request: Record<string, unknown> = configuration(record), before = bytes(); delete request[key];
    expect(() => service().configure(record.id, request as never)).toThrow(); expect(bytes().equals(before)).toBe(true);
  });
  it.each(["every:14m", "every:10081m", "every:015m", "* * * * *", "every:15m\n"])("refuses unsafe or unbounded schedule %j", (schedule) => {
    const record = create(), before = bytes(); expect(() => service().configure(record.id, configuration(record, { schedule }))).toThrow();
    expect(bytes().equals(before)).toBe(true); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each([{ kind: "company", id: "other" }, { kind: "objective", id: "missing" }, { kind: "project", id: "missing" },
    { kind: "issue", id: "issue-1" }, { kind: "project", id: "alpha", path: "/caller" }])("refuses unknown or expanded scope %# without writing", (scope) => {
    expect(() => service().create({ action: "refresh-evidence", scope: scope as RoutineScope })).toThrow(); expect(existsSync(state)).toBe(false);
  });
  it("binds only relevant trusted objective ancestry and project policy IDs", () => {
    domain.objectives.push({ ...objective("objective-parent"), project_ids: [] }); domain.objectives[0]!.parent_objective_id = "objective-parent";
    domain.company.active_objective_ids.push("objective-parent");
    policy.policy.rules.push({ ...policy.policy.rules[0]!, id: "parent-policy", scope: { kind: "objective", id: "objective-parent" } },
      { ...policy.policy.rules[0]!, id: "alpha-policy", scope: { kind: "project", id: "alpha" } },
      { ...policy.policy.rules[0]!, id: "foreign-policy", scope: { kind: "project", id: "other" } });
    const record = create({ kind: "objective", id: "objective-1" });
    expect(record.policy.policy_ids).toEqual(["alpha-policy", "company-policy", "parent-policy"]); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each(["unknown-parent", "cycle", "too-deep", "duplicate-objective"] as const)("refuses invalid domain ancestry %s before persistence", (kind) => {
    if (kind === "unknown-parent") domain.objectives[0]!.parent_objective_id = "missing";
    if (kind === "cycle") domain.objectives[0]!.parent_objective_id = "objective-1";
    if (kind === "duplicate-objective") domain.objectives.push(structuredClone(domain.objectives[0]!));
    if (kind === "too-deep") {
      domain.objectives = Array.from({ length: 9 }, (_, i) => objective(`objective-${i + 1}`, i === 8 ? null : `objective-${i + 2}`));
      domain.company.active_objective_ids = domain.objectives.map((item) => item.id);
    }
    expect(() => create({ kind: "objective", id: "objective-1" })).toThrow(); expect(existsSync(state)).toBe(false);
  });
  it("refuses a company scope exceeding 25 discovered projects instead of trimming silently", () => {
    projects = Array.from({ length: 26 }, (_, i) => ({ id: `project-${i}` })); expect(() => create()).toThrow(); expect(existsSync(state)).toBe(false);
  });
  it.each(["policy", "organization", "projects"] as const)("sanitizes unavailable %s sources and does not create configuration", (kind) => {
    const failed = () => { throw new Error(`PRIVATE SYNTHETIC ${root}`); }, options = dependencies();
    const api = createRoutineService(root, { ...options, ...(kind === "policy" ? { readBudgetPolicy: failed } : kind === "organization" ? { readOrganization: failed } : { listProjects: failed }) });
    let message = ""; try { api.create({ action: "refresh-evidence", scope: { kind: "company", id: "surtec" } }); } catch (error) { message = String(error); }
    expect(message).not.toBe(""); expect(message).not.toContain("PRIVATE"); expect(message).not.toContain(root); expect(existsSync(state)).toBe(false);
  });
  it.each(["malformed", "future", "null", "empty"] as const)("preserves %s optional state and reports unavailable without repair", (kind) => {
    const content = kind === "malformed" ? "{PRIVATE SYNTHETIC INVALID" : kind === "future" ? '{"schema_version":2,"private":"synthetic"}' : kind === "null" ? "null" : "{}";
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); const mtime = statSync(path).mtimeMs;
    expect(service().list()).toMatchObject({ state: "unavailable", revision: null, routines: [] });
    expect(() => create()).toThrow(); expect(() => service().run("routine-1", { expected_revision: 1 })).toThrow();
    expect(JSON.stringify(service().warnings())).not.toContain("PRIVATE"); expect(JSON.stringify(service().warnings())).not.toContain(root);
    expect(readFileSync(path, "utf8")).toBe(content); expect(statSync(path).mtimeMs).toBe(mtime); expect(existsSync(join(state, "locks"))).toBe(false);
  });
  it("refuses a hard-linked optional store and leaves both exact file names untouched", () => {
    const record = create(), second = join(root, "routine-copy.json"), before = bytes(); linkSync(path, second);
    expect(service().list().state).toBe("unavailable"); expect(() => service().disable(record.id, { expected_revision: 1 })).toThrow();
    expect(bytes().equals(before)).toBe(true); expect(readFileSync(second).equals(before)).toBe(true); expect(lstatSync(path).nlink).toBe(2);
  });
  it("refuses a busy unknown lock without stealing it or changing configuration", () => {
    const record = create(), before = bytes(), lock = join(state, "locks/routines.lock"); writeFileSync(lock, "unknown synthetic owner"); advance();
    expect(() => service().disable(record.id, { expected_revision: 1 })).toThrow(); expect(bytes().equals(before)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("unknown synthetic owner"); expect(readdirSync(join(state, "locks"))).toEqual(["routines.lock"]);
  });
  it("does not activate definitions through environment flags or report a production run no-op as success", () => {
    const record = enabled(), before = bytes(); vi.stubEnv("SURTEC_ROUTINES_ENABLED", "1"); vi.stubEnv("SURTEC_BUDGET_CUTOVER", "1");
    expect(() => service().run(record.id, { expected_revision: record.revision })).toThrow();
    expect(bytes().equals(before)).toBe(true); expect(inventory()).toHaveLength(0); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("rejects a registered but inactive internal runner that produced no durable occurrence", () => {
    const record = enabled(), before = bytes(), runner = new RoutineRunner({ stateRoot: state, now: clock }); runners.push(runner);
    const api = createRoutineService(root, { ...dependencies(), execution: { runner, worker_id: "fixture-worker", available_reads: () => 1 } });
    expect(() => api.run(record.id, { expected_revision: record.revision })).toThrow(); expect(bytes().equals(before)).toBe(true);
    expect(inventory()).toHaveLength(0); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each([undefined, false, 0, ""])("does not relabel invalid falsey accounting as optional absence %#", (ledger) => {
    const api = createRoutineService(root, { ...dependencies(), readBudgetLedger: () => ledger as never });
    expect(api.budgets()).toMatchObject({ status: "unavailable", executable: false, reserves_capacity: false,
      ledger: { status: "unavailable", revision: null, updated_at: null } }); expect(existsSync(state)).toBe(false);
  });
  it("refuses disabled fixture runs before any provider or budget effect", () => {
    const record = create(), before = bytes(), fixture = wired(); expect(() => fixture.api.run(record.id, { expected_revision: record.revision })).toThrow();
    expect(fixture.read).not.toHaveBeenCalled(); expect(bytes().equals(before)).toBe(true); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("requires refreshed trusted policy references before a configured fixture occurrence can start", () => {
    const record = enabled(), before = bytes(), fixture = wired(); policy = { ...source(), fingerprint: "b".repeat(64) };
    expect(() => fixture.api.run(record.id, { expected_revision: record.revision })).toThrow(); expect(fixture.read).not.toHaveBeenCalled();
    expect(bytes().equals(before)).toBe(true); expect(existsSync(ledgerPath)).toBe(false); advance();
    const refreshed = fixture.api.configure(record.id, configuration(record)).routine; expect(refreshed.policy.fingerprint).toBe("b".repeat(64));
  });
  it("keeps the safe disable control available during a trusted policy outage without reading or repairing accounting", () => {
    const record = enabled(), before = readRoutineDocument(path)!, ledger = vi.fn(() => { throw new Error("Synthetic accounting outage"); });
    advance(); const api = createRoutineService(root, { ...dependencies(), readBudgetPolicy: () => { throw new Error("Synthetic source outage"); }, readBudgetLedger: ledger });
    const disabled = api.disable(record.id, { expected_revision: record.revision }); expect(disabled.routine.enabled).toBe(false);
    expect(disabled.routine.revision).toBe(record.revision + 1); expect(disabled.routine.policy).toEqual(record.policy);
    expect(ledger).not.toHaveBeenCalled(); expect(readRoutineDocument(path)?.definitions[routineRevisionKey(record.id, record.revision)])
      .toEqual(before.definitions[routineRevisionKey(record.id, record.revision)]); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("detaches the configured scope from request objects before persistence", () => {
    const request = { action: "refresh-evidence" as const, scope: { kind: "project" as const, id: "alpha" } };
    const record = service().create(request).routine; request.scope.id = "other";
    expect(service().detail(record.id).routine.scope).toEqual({ kind: "project", id: "alpha" });
  });
  it("admits one real fake-provider occurrence, returns its durable identity, and deduplicates the exact manual slot", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), fixture = wired(); advance();
    const admitted = fixture.api.run(record.id, { expected_revision: record.revision });
    expect(admitted).toMatchObject({ status: "admitted", execution: { state: "fixture-enabled", executable: false } });
    expect(admitted.occurrence.id).toBe(inventory()[0]?.id); expect(inventory()).toHaveLength(1); await fixture.runner.idle();
    const before = bytes(), ledger = readFileSync(ledgerPath), duplicate = fixture.api.run(record.id, { expected_revision: record.revision });
    expect(duplicate).toMatchObject({ status: "existing", occurrence: { id: admitted.occurrence.id } }); expect(fixture.read).toHaveBeenCalledOnce();
    expect(bytes().equals(before)).toBe(true); expect(readFileSync(ledgerPath).equals(ledger)).toBe(true);
    expect(inventory()[0]).toMatchObject({ status: "completed", receipt: { consumption: { attempts: 1, model_calls: 0, total_tokens: 0, workspace_writes: 0 } } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]?.status).toBe("settled");
    const restarted = service(), history = restarted.detail(record.id); expect(history.routine).toEqual(record);
    expect(history.occurrences).toHaveLength(1); expect(history.execution.executable).toBe(false);
  });
  it("keeps default production execution denied even when a fixture-owned manual slot already exists", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), fixture = wired(); advance();
    fixture.api.run(record.id, { expected_revision: record.revision }); await fixture.runner.idle(); const before = bytes(), ledger = readFileSync(ledgerPath);
    expect(() => service().run(record.id, { expected_revision: record.revision })).toThrow();
    expect(bytes().equals(before)).toBe(true); expect(readFileSync(ledgerPath).equals(ledger)).toBe(true); expect(fixture.read).toHaveBeenCalledOnce();
  });
  it("confirms the exact newly admitted runner slot when its clock advances beyond the service preflight", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), fixture = wired(undefined, 1); advance(); const at = now;
    const result = fixture.api.run(record.id, { expected_revision: record.revision });
    expect(result.status).toBe("admitted"); expect(result.occurrence.slot).toBe(new Date(at + 1).toISOString());
    expect(result.occurrence.id).toBe(inventory()[0]?.id); expect(result.execution.executable).toBe(false);
    await fixture.runner.idle(); expect(fixture.read).toHaveBeenCalledOnce(); expect(inventory()[0]?.status).toBe("completed");
  });
  it("does not announce foreign durable inventory as an admission owned by its private runner", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), local = wired(), foreign = wired(); advance();
    const original = local.runner.runManual.bind(local.runner);
    vi.spyOn(local.runner, "runManual").mockImplementation((id, revision, worker, capacity) => {
      // A cooperating controller takes the slot between the API snapshot and
      // our real controller's admission attempt, using the same inventory id.
      foreign.runner.runManual(id, revision, worker, capacity); original(id, revision, worker, capacity);
    });
    expect(() => local.api.run(record.id, { expected_revision: record.revision })).toThrow(); expect(local.runner.activeCount).toBe(0);
    expect(local.runner.lastFailure).toBe("ownership-unavailable"); expect(local.read).not.toHaveBeenCalled();
    await foreign.runner.idle(); expect(foreign.read).toHaveBeenCalledOnce(); expect(inventory()).toHaveLength(1);
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1);
  });
  it("cancels privately admitted mismatched attribution before its provider can observe or propose effects", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), read = vi.fn(async () => evidence());
    const runner = new RoutineRunner({ stateRoot: state, now: clock, execution: {
      resolve: (_definition, id) => ({ source: policy, attribution: { company_id: "surtec", project_ids: ["alpha"], objective_ids: [],
        issue_id: null, role_id: null, execution_id: id } }), assert_current: () => undefined, read_evidence: read, monotonic: () => 0,
    } }); runners.push(runner);
    const api = createRoutineService(root, { ...dependencies(), execution: { runner, worker_id: "fixture-worker", available_reads: () => 1 } }); advance();
    expect(() => api.run(record.id, { expected_revision: record.revision })).toThrow(); expect(read).not.toHaveBeenCalled();
    expect(inventory()[0]?.cancel_requested_at).toBe(clock().toISOString()); await runner.idle();
    expect(read).not.toHaveBeenCalled(); expect(inventory()[0]).toMatchObject({ status: "cancelled",
      receipt: { consumption: { attempts: 1, model_calls: 0, workspace_writes: 0 }, failure_code: "cancelled" } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1); expect(readRoutineDocument(path)?.routines[record.id]).toEqual(record);
  });
  it("does not claim success or create accounting when the existing worker has no read capacity", () => {
    const record = enabled(), fixture = wired(), before = bytes();
    const api = createRoutineService(root, { ...dependencies(), execution: { runner: fixture.runner, worker_id: "fixture-worker", available_reads: () => 0 } });
    expect(() => api.run(record.id, { expected_revision: record.revision })).toThrow(); expect(fixture.read).not.toHaveBeenCalled();
    expect(inventory()).toHaveLength(0); expect(existsSync(ledgerPath)).toBe(false);
    // A considered manual slot is not an execution receipt or successful run.
    expect(readRoutineDocument(path)?.routines[record.id]).toEqual(record); expect(bytes().length).toBeGreaterThanOrEqual(before.length);
  });
  it("bounds detail to the latest 20 durable occurrences and keeps older accounting/history intact", async () => {
    policy = source({ attempts: 1 });
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }), fixture = wired();
    advance(); fixture.api.run(record.id, { expected_revision: record.revision }); await fixture.runner.idle();
    const completed = inventory()[0]!, ledgerBytes = readFileSync(ledgerPath);
    // Read-model history uses strictly validated synthetic unstarted denials;
    // only the first completed observation above invokes the real fake runner.
    for (let i = 0; i < 20; i++) {
      advance(); const at = clock().toISOString(), key = routineSlotKey(record.id, record.revision, at), entry = structuredClone(completed);
      entry.id = `occurrence-${key}`; entry.revision = 1; entry.occurrence_key = key; entry.slot = at;
      entry.attribution.execution_id = entry.id; entry.status = "failed"; entry.owner = null; entry.started_at = null;
      entry.finished_at = at; entry.created_at = at; entry.updated_at = at; entry.cancel_requested_at = null;
      entry.budget.subject_id = `subject-${key}`; entry.budget.reservation_id = `reservation-${key}`;
      entry.budget.intent_id = budgetOccurrenceIntentId({ subject: { id: entry.budget.subject_id, kind: "occurrence", occurrence_id: entry.id,
        routine_id: record.id, routine_revision: record.revision, slot: at, project_ids: entry.project_ids, attribution: entry.attribution },
      reservation_id: entry.budget.reservation_id, policy_bindings: entry.budget.policy_bindings, cap_fingerprint: entry.budget.cap_fingerprint,
      runtime_ms: entry.budget.admitted_runtime_ms, created_at: at });
      entry.receipt = { ...entry.receipt!, occurrence_id: entry.id, occurrence_key: key, slot: at, started_at: null, finished_at: at, captured_at: at,
        freshness: "unavailable", sources: [], proposals: [], failure_code: "budget-denied", next_action: "inspect-budget", budget_outcome: "denied",
        counts: { projects_selected: entry.project_ids.length, facts_total: 0, facts_fresh: 0, facts_unavailable: 0,
          signals_evaluated: 0, proposals_created: 0, reports_written: 0 },
        consumption: { attempts: 0, runtime_ms: 0, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 } };
      assertRoutineOccurrence(entry);
      mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (doc) => { doc.occurrences[entry.id] = entry; }), path, at);
    }
    const before = bytes(), history = fixture.api.detail(record.id), chronological = inventory().sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    expect(history.occurrences).toHaveLength(20); expect(history.occurrences.map((entry) => entry.id)).not.toContain(chronological[0]?.id);
    expect(history.occurrences[0]?.id).toBe(chronological.at(-1)?.id); expect(inventory()).toHaveLength(21);
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1); expect(readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true);
    expect(readRoutineDocument(path)?.occurrences[completed.id]).toEqual(completed); expect(fixture.read).toHaveBeenCalledOnce(); expect(bytes().equals(before)).toBe(true);
  });
  it("disables an owned pending provider through configuration and cancellation without refunding its active hold", async () => {
    const record = enabled({ kind: "project", id: "alpha" }, { schedule: null }); let options!: RoutineEvidenceReadOptions;
    const read = vi.fn(async (_entry: Readonly<RoutineOccurrence>, supplied: RoutineEvidenceReadOptions) => { options = supplied; await new Promise<void>(() => undefined); return evidence(); });
    const fixture = wired(read); advance(); fixture.api.run(record.id, { expected_revision: record.revision });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); const before = readFileSync(ledgerPath); advance();
    const disabled = fixture.api.disable(record.id, { expected_revision: record.revision });
    expect(disabled.routine).toMatchObject({ revision: 3, enabled: false }); expect(options.signal.aborted).toBe(true);
    expect(readFileSync(ledgerPath).equals(before)).toBe(true); expect(inventory()[0]?.cancel_requested_at).toBe(clock().toISOString());
    await fixture.runner.idle(); expect(inventory()[0]).toMatchObject({ status: "cancelled", receipt: { failure_code: "cancelled", consumption: { attempts: 1 } } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1); expect(readRoutineDocument(path)?.definitions[routineRevisionKey(record.id, 2)]).toEqual(record);
  });
});
