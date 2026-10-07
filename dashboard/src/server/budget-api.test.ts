import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLedger, type BudgetLimits, type BudgetPolicy, type BudgetPolicyBinding, type BudgetPolicyRule, type BudgetTaskSubject } from "../../../lib/budgets/types";
import { readBudgetPolicy } from "../../../lib/budgets/policy";
import { assertBudgetLedger } from "../../../lib/budgets/validation";
import type { Objective, OrganizationSnapshot } from "../../../lib/organization";
import { budgetStatePath } from "../../../lib/state/paths";
import type { ProcessManager } from "../../../runner/process-manager";
import { createHttpSecurity } from "./http-security";
import { createApp } from "./index";
import { createRoutineService } from "./routine-service";

// Real local HTTP middleware and validated synthetic data only. These fixtures
// contain no task/controller authority, normal state, providers or paid turns.
const roots: string[] = [], links: string[] = [];
const createdAt = "2026-10-07T12:00:00.000Z";
const token = "synthetic-budget-api-session-value";
const providerRead = vi.fn<typeof fetch>(async () => { throw new Error("Synthetic budget GET must never contact a provider"); });
type ServiceDependencies = NonNullable<Parameters<typeof createRoutineService>[1]>;
type BudgetView = ReturnType<ReturnType<typeof createRoutineService>["budgets"]>;

beforeEach(() => { providerRead.mockClear(); vi.stubGlobal("fetch", providerRead); });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const path of links.splice(0)) if (existsSync(path)) unlinkSync(path);
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root).startsWith("surtec-budget-api-")).toBe(true);
    expect(lstatSync(root).isSymbolicLink()).toBe(false);
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
  expect(providerRead).not.toHaveBeenCalled();
});

function limits(values: Partial<BudgetAmounts> = {}): BudgetLimits {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, values[dimension] === undefined
    ? { status: "unconfigured" } : { status: "configured", hard_cap: values[dimension] }])) as BudgetLimits;
}
const amounts = (values: Partial<BudgetAmounts> = {}): BudgetAmounts => ({ attempts: 0, runtime_ms: 0, total_tokens: 0,
  concurrent_reads: 0, concurrent_writes: 0, review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0, ...values });
function rule(id = "company-rule", scope: BudgetPolicyRule["scope"] = { kind: "company", id: "surtec" },
  values: Partial<BudgetAmounts> = { attempts: 2, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 },
  period: BudgetPolicyRule["period"] = "none"): BudgetPolicyRule {
  return { id, revision: 3, scope, period, warning_percent: 80, limits: limits(values) };
}
const policy = (rules = [rule()]): BudgetPolicy => ({ schema_version: 1, revision: 7, rules,
  pricing: { status: "unavailable", reason: "no-versioned-source" } });
function objective(id: string, parent: string | null, projectIds: string[] = []): Objective {
  return { schema_version: 1, id, company_id: "surtec", title: "Synthetic private objective title", desired_outcome: "Synthetic private outcome",
    success_criteria: ["Synthetic private criterion"], status: "draft", horizon: "now", priority: 1, target_date: null,
    parent_objective_id: parent, project_ids: projectIds, owner: "marcos", last_reviewed_at: null };
}
function organization(): OrganizationSnapshot {
  return { company: { schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: "Synthetic private mission",
    operating_principles: [], active_objective_ids: [], last_reviewed_at: null },
  objectives: [objective("root", null), objective("child", "root", ["synthetic-project"]), objective("secondary", null, ["synthetic-project"])],
  project_objectives: { "synthetic-project": { objective_ids: ["child", "secondary"], primary_objective_id: "child" } } };
}
function fixture(config = policy()) {
  const root = mkdtempSync(join(tmpdir(), "surtec-budget-api-")); roots.push(root);
  const state = join(root, "state"), policyPath = join(root, "registry", "budget-policy.yml");
  mkdirSync(dirname(policyPath)); const policyBytes = JSON.stringify(config); writeFileSync(policyPath, policyBytes);
  return { root, state, path: budgetStatePath(state), policyPath, config, fingerprint: createHash("sha256").update(policyBytes).digest("hex") };
}
function appFor(f: ReturnType<typeof fixture>, overrides: ServiceDependencies = {}, session = token) {
  const calls = { clock: vi.fn(() => new Date(createdAt)), policy: vi.fn(() => readBudgetPolicy(f.root)),
    organization: vi.fn(organization), projects: vi.fn(() => [{ id: "synthetic-project" }, { id: "personal-project" }]) };
  const service = createRoutineService(f.root, { stateRoot: f.state, clock: calls.clock, readBudgetPolicy: calls.policy,
    readOrganization: calls.organization, listProjects: calls.projects, ...overrides });
  const processes = { start: vi.fn(), stop: vi.fn(), get: vi.fn(), list: vi.fn(() => []), subscribe: vi.fn() };
  const app = createApp(f.root, vi.fn<() => void>(), processes as unknown as ProcessManager, createHttpSecurity(session), { routines: service });
  return { app, calls, service, processes };
}
async function view(app: ReturnType<typeof createApp>, query = ""): Promise<BudgetView> {
  const response = await app.request(`/api/budgets${query}`);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  return await response.json() as BudgetView;
}
function raw(path: string, content: string | Buffer): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function ledger(f: ReturnType<typeof fixture>, state: "settled" | "held" | "unknown" = "settled"): BudgetLedger {
  const selected = f.config.rules.find((entry) => entry.scope.kind === "company")!;
  const binding: BudgetPolicyBinding = { policy_id: selected.id, policy_revision: selected.revision, policy_fingerprint: f.fingerprint,
    scope: selected.scope, period: selected.period, bucket: selected.period === "none" ? "none" : createdAt.slice(0, selected.period === "utc-day" ? 10 : 7), limits: selected.limits };
  const subject: BudgetTaskSubject = { id: "private-subject", kind: "task", task_id: "private-task", project_id: "synthetic-project",
    role_id: "private-role", agent_id: "private-agent", issue_id: null, workflow: null,
    attribution: { company_id: "surtec", objective_ids: ["child", "root"], project_ids: ["synthetic-project"], issue_id: null,
      role_id: "private-role", execution_id: "private-task" } };
  const value: BudgetLedger = { schema_version: 1, revision: 5, created_at: createdAt, updated_at: createdAt,
    subjects: { [subject.id]: subject },
    reservations: { "private-reservation": { id: "private-reservation", revision: 2, subject_id: subject.id, intent_id: "private-intent",
      status: "settled", policy_bindings: [binding], held: amounts(), uncertain_dimensions: [], run_ids: ["private-run"], created_at: createdAt, updated_at: createdAt } },
    admission_intents: { "private-intent": { id: "private-intent", subject_id: subject.id, reservation_id: "private-reservation",
      admission_id: "private-admission", status: "committed", created_at: createdAt, updated_at: createdAt } },
    charges: { "private-charge": { id: "private-charge", subject_id: subject.id, reservation_id: "private-reservation", run_id: "private-run",
      attempts: 1, runtime_ms: 100, observed_total_tokens: 20, runtime_state: "complete", usage_state: "complete", status: "terminal",
      review: false, correction: false, created_at: createdAt, updated_at: createdAt } } };
  if (state !== "settled") {
    const reservation = value.reservations["private-reservation"]!;
    reservation.status = state === "held" ? "committed" : "unknown";
    reservation.held = amounts({ attempts: state === "held" ? 1 : 0, runtime_ms: 500, total_tokens: 50, concurrent_reads: 1 });
    if (state === "held") { reservation.run_ids = []; value.charges = {}; }
    else {
      reservation.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"];
      value.admission_intents["private-intent"]!.status = "unknown";
      value.charges["private-charge"]!.runtime_state = "unknown";
      value.charges["private-charge"]!.usage_state = "unknown";
    }
  }
  assertBudgetLedger(value); return value;
}
function seed(f: ReturnType<typeof fixture>, value: BudgetLedger): { bytes: Buffer; modified: number } {
  assertBudgetLedger(value); raw(f.path, JSON.stringify(value, null, 2));
  return { bytes: readFileSync(f.path), modified: lstatSync(f.path).mtimeMs };
}
function unchanged(path: string, before: { bytes: Buffer; modified: number }): void {
  expect(readFileSync(path)).toEqual(before.bytes); expect(lstatSync(path).mtimeMs).toBe(before.modified);
}
function emptyLedger(): BudgetLedger {
  return { schema_version: 1, revision: 1, created_at: createdAt, updated_at: createdAt,
    subjects: {}, reservations: {}, admission_intents: {}, charges: {} };
}

describe("T012 read-only budget HTTP boundary", () => {
  it("exposes policy provenance without fabricating an absent ledger or execution permission", async () => {
    const f = fixture(), { app, processes } = appFor(f);
    const result = await view(app);
    expect(result).toMatchObject({ schema_version: 1, observed_at: createdAt, status: "unavailable", executable: false,
      reserves_capacity: false, ledger: { status: "absent", revision: null, updated_at: null },
      policy: { revision: 7, fingerprint: f.fingerprint }, pricing: { status: "unavailable", reason: "no-versioned-source" } });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: "policy:company-rule", kind: "policy", scope: { kind: "company", id: "surtec" },
      period: "none", bucket: "none", revision: 3, fingerprint: f.fingerprint });
    for (const dimension of BUDGET_DIMENSIONS) expect(result.sources[0]!.dimensions[dimension]).toMatchObject({
      proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null });
    expect(result.sources[0]!.dimensions.attempts).toMatchObject({ status: "configured", cap: 2 });
    expect(existsSync(f.state)).toBe(false);
    expect(processes.start).not.toHaveBeenCalled(); expect(processes.stop).not.toHaveBeenCalled();
    for (const key of ["can_admit", "binding", "ceilings", "base_caps", "prospective_hold", "subjects", "reservations", "charges", "admission_intents"]) {
      expect(Object.hasOwn(result, key)).toBe(false);
    }
  });

  it("distinguishes a validated known empty ledger from unavailable accounting", async () => {
    const f = fixture(), before = seed(f, emptyLedger()), { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("available"); expect(result.ledger).toEqual({ status: "available", revision: 1, updated_at: createdAt });
    expect(result.sources[0]!.dimensions.attempts).toEqual({ status: "configured", cap: 2, proven_consumed: 0,
      consumed: 0, reserved: 0, remaining: 2, warning: false });
    unchanged(f.path, before); expect(existsSync(join(f.state, "locks"))).toBe(false);
  });

  it.each([
    ["hostile URL host", "http://hostile.example/api/budgets", {}],
    ["hostile Host header", "http://127.0.0.1:4317/api/budgets", { Host: "hostile.example" }],
    ["foreign Origin", "http://127.0.0.1:4317/api/budgets", { Origin: "https://hostile.example" }],
    ["wrong loopback port Origin", "http://127.0.0.1:4317/api/budgets", { Origin: "http://127.0.0.1:4318" }],
    ["cross-site fetch metadata", "http://127.0.0.1:4317/api/budgets", { "Sec-Fetch-Site": "cross-site" }],
    ["same-site fetch metadata", "http://127.0.0.1:4317/api/budgets", { "Sec-Fetch-Site": "same-site" }],
  ] as const)("rejects %s before budget or domain reads", async (_label, url, headers) => {
    const f = fixture(), { app, calls } = appFor(f);
    expect((await app.request(url, { headers })).status).toBe(403);
    for (const reader of Object.values(calls)) expect(reader).not.toHaveBeenCalled();
    expect(existsSync(f.state)).toBe(false);
  });

  it("permits same-origin read-only GET without issuing or requiring a session", async () => {
    const f = fixture(), { app } = appFor(f);
    const response = await app.request("http://127.0.0.1:4317/api/budgets", {
      headers: { Origin: "http://127.0.0.1:4317", "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.text()).includes(token)).toBe(false); expect(existsSync(f.state)).toBe(false);
  });

  it.each([
    "?project_id=synthetic-project&project_id=synthetic-project", "?objective_id=child&objective_id=child",
    "?project_id=synthetic-project&objective_id=child", "?project_id=", "?objective_id=", "?project_id=..",
    "?objective_id=constructor", "?project_id=__proto__", "?project_id=synthetic-project%0A",
    "?objective_id=prototype", "?project_id[]=synthetic-project", "?project_id=%FF", `?project_id=${"x".repeat(161)}`,
    "?objective_id=..%2Fchild", "?project_id=%2Fsynthetic-project", "?project_id=synthetic%5Cproject",
    "?scope=company", "?company_id=surtec", "?role_id=engineer", "?issue_id=private-issue", "?execution_id=private-task",
    "?exclude_reservation=private-reservation", "?ledger=%7B%7D", "?base_caps=%7B%7D", "?hard_cap=999999",
    "?path=C%3A%5Csynthetic", "?url=https%3A%2F%2Fhostile.example", "?command=synthetic-command",
    "?__proto__=synthetic", "?constructor=synthetic", "?preview_fingerprint=synthetic", "?refresh=1",
  ])("rejects closed-query injection %s before all readers and without effects", async (query) => {
    const f = fixture(), ledgerReader = vi.fn(() => null), { app, calls } = appFor(f, { readBudgetLedger: ledgerReader });
    const response = await app.request(`/api/budgets${query}`);
    expect(response.status).toBe(400); expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const reader of [...Object.values(calls), ledgerReader]) expect(reader).not.toHaveBeenCalled();
    expect(existsSync(f.state)).toBe(false);
  });

  it.each(["?project_id=missing-project", "?objective_id=missing-objective"])("rejects unknown scope %s without ledger reads", async (query) => {
    const f = fixture(), ledgerReader = vi.fn(() => null), { app } = appFor(f, { readBudgetLedger: ledgerReader });
    expect((await app.request(`/api/budgets${query}`)).status).toBe(404);
    expect(ledgerReader).not.toHaveBeenCalled(); expect(existsSync(f.state)).toBe(false);
  });

  it("selects primary ancestry for a project without multiplying secondary objective consumption", async () => {
    const f = fixture(policy([rule(), rule("root-rule", { kind: "objective", id: "root" }), rule("child-rule", { kind: "objective", id: "child" }),
      rule("secondary-rule", { kind: "objective", id: "secondary" }), rule("project-rule", { kind: "project", id: "synthetic-project" })]));
    const before = seed(f, ledger(f)), { app } = appFor(f), result = await view(app, "?project_id=synthetic-project");
    expect(result.sources.map((entry) => entry.id).sort()).toEqual(["policy:child-rule", "policy:company-rule", "policy:project-rule", "policy:root-rule"]);
    for (const source of result.sources) expect(source.dimensions.runtime_ms.consumed).toBe(100);
    expect(result.sources.every((entry) => entry.kind === "policy")).toBe(true);
    const text = JSON.stringify(result);
    for (const forbidden of ["private-subject", "private-task", "private-run", "private-reservation", "private-intent", "private-agent", "private mission", "private outcome", "private criterion", f.root]) expect(text).not.toContain(forbidden);
    unchanged(f.path, before);
  });

  it("projects a selected objective and its ancestors, not unrelated project or role authority", async () => {
    const f = fixture(policy([rule(), rule("root-rule", { kind: "objective", id: "root" }), rule("child-rule", { kind: "objective", id: "child" }),
      rule("project-rule", { kind: "project", id: "synthetic-project" }), rule("role-rule", { kind: "role", id: "private-role" })]));
    const before = seed(f, ledger(f)), { app } = appFor(f), result = await view(app, "?objective_id=child");
    expect(result.sources.map((entry) => entry.id).sort()).toEqual(["policy:child-rule", "policy:company-rule", "policy:root-rule"]);
    expect(result.sources.find((entry) => entry.id === "policy:child-rule")!.dimensions.attempts.consumed).toBe(1);
    unchanged(f.path, before);
  });

  it("supports personal projects without inventing an objective", async () => {
    const f = fixture(policy([rule(), rule("child-rule", { kind: "objective", id: "child" }), rule("personal-rule", { kind: "project", id: "personal-project" })]));
    seed(f, emptyLedger()); const { app } = appFor(f), result = await view(app, "?project_id=personal-project");
    expect(result.sources.map((entry) => entry.id).sort()).toEqual(["policy:company-rule", "policy:personal-rule"]);
    expect(result.executable).toBe(false);
  });

  it("retains proven consumption and reserved holds without returning private ledger records", async () => {
    const f = fixture(), before = seed(f, ledger(f, "held")), { app } = appFor(f), result = await view(app);
    expect(result.sources[0]!.dimensions.total_tokens).toMatchObject({ cap: 100, proven_consumed: 0, consumed: 0, reserved: 50, remaining: 50, warning: false });
    expect(result.sources[0]!.dimensions.concurrent_reads).toMatchObject({ consumed: 0, reserved: 1, remaining: 0, warning: true });
    expect(result.status).toBe("exhausted"); unchanged(f.path, before);
  });

  it("keeps unknown usage visibly unavailable, including proven nonzero high-water and retained holds", async () => {
    const f = fixture(), before = seed(f, ledger(f, "unknown")), { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("unavailable"); expect(result.ledger.status).toBe("available");
    expect(result.sources[0]!.dimensions.total_tokens).toMatchObject({ proven_consumed: 20, consumed: null, reserved: 50, remaining: null, warning: true });
    expect(result.sources[0]!.dimensions.runtime_ms).toMatchObject({ proven_consumed: 100, consumed: null, reserved: 500, remaining: null });
    expect(result.denials.some((entry) => entry.code === "budget-accounting-unavailable")).toBe(true);
    unchanged(f.path, before);
  });

  it("retains valid policy provenance when canonical consumption projection exceeds safe integer precision", async () => {
    const f = fixture(), value = ledger(f), first = value.subjects["private-subject"]! as BudgetTaskSubject;
    value.charges["private-charge"]!.runtime_ms = Number.MAX_SAFE_INTEGER;
    const second: BudgetTaskSubject = { ...structuredClone(first), id: "second-private-subject", task_id: "second-private-task",
      attribution: { ...structuredClone(first.attribution), execution_id: "second-private-task" } };
    value.subjects[second.id] = second;
    value.reservations["second-private-reservation"] = { ...structuredClone(value.reservations["private-reservation"]!),
      id: "second-private-reservation", subject_id: second.id, intent_id: "second-private-intent", run_ids: ["second-private-run"] };
    value.admission_intents["second-private-intent"] = { ...structuredClone(value.admission_intents["private-intent"]!),
      id: "second-private-intent", subject_id: second.id, reservation_id: "second-private-reservation", admission_id: "second-private-admission" };
    value.charges["second-private-charge"] = { ...structuredClone(value.charges["private-charge"]!),
      id: "second-private-charge", subject_id: second.id, reservation_id: "second-private-reservation", run_id: "second-private-run", runtime_ms: 1 };
    const before = seed(f, value), { app } = appFor(f), result = await view(app);
    expect(result).toMatchObject({ status: "unavailable", executable: false, reserves_capacity: false,
      ledger: { status: "available", revision: 5, updated_at: createdAt }, policy: { revision: 7, fingerprint: f.fingerprint } });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: "policy:company-rule", kind: "policy", revision: 3, fingerprint: f.fingerprint });
    expect(result.sources[0]!.dimensions.runtime_ms).toMatchObject({ status: "configured", cap: 1000 });
    for (const dimension of BUDGET_DIMENSIONS) expect(result.sources[0]!.dimensions[dimension]).toMatchObject({
      proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null });
    expect(result.denials.some((entry) => entry.code === "budget-accounting-unavailable")).toBe(true);
    expect(result.denials.some((entry) => entry.code === "budget-policy-unavailable")).toBe(false);
    unchanged(f.path, before); expect(existsSync(join(f.state, "locks"))).toBe(false);
  });

  it.each(["utc-day", "utc-month"] as const)("retains unresolved holds across %s rollover without replay or refund", async (period) => {
    const f = fixture(policy([rule("company-rule", { kind: "company", id: "surtec" }, undefined, period)]));
    const before = seed(f, ledger(f, "held")); let now = new Date(createdAt);
    const { app } = appFor(f, { clock: () => now });
    const first = await view(app);
    expect(first.sources[0]!.bucket).toBe(createdAt.slice(0, period === "utc-day" ? 10 : 7));
    now = new Date("2026-11-01T00:00:00.000Z"); const next = await view(app);
    expect(next.observed_at).toBe(now.toISOString()); expect(next.ledger.updated_at).toBe(createdAt);
    expect(next.sources[0]!.bucket).toBe(period === "utc-day" ? "2026-11-01" : "2026-11");
    expect(next.sources[0]!.fingerprint).toBe(f.fingerprint);
    expect(next.sources[0]!.dimensions.total_tokens.reserved).toBe(50);
    expect(next.sources[0]!.dimensions.concurrent_reads.remaining).toBe(0);
    unchanged(f.path, before);
  });

  it("does not label a configured zero as an unconfigured or unlimited balance", async () => {
    const f = fixture(policy([rule("company-rule", { kind: "company", id: "surtec" }, { attempts: 0 })]));
    seed(f, emptyLedger()); const { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("exhausted"); expect(result.sources[0]!.dimensions.attempts).toMatchObject({ status: "configured", cap: 0, consumed: 0, reserved: 0, remaining: 0, warning: true });
    expect(result.sources[0]!.dimensions.total_tokens).toMatchObject({ status: "unconfigured", cap: null, consumed: 0, reserved: 0, remaining: null });
  });

  it.each(["malformed", "future", "contradictory"] as const)("preserves %s ledger bytes and exposes bounded unavailable metadata", async (kind) => {
    const f = fixture(); const value = ledger(f);
    const bytes = kind === "malformed" ? "{ SYNTHETIC PRIVATE INVALID SOURCE" : kind === "future" ? JSON.stringify({ ...value, schema_version: 999 })
      : JSON.stringify({ ...value, subjects: {} });
    raw(f.path, bytes); const before = { bytes: readFileSync(f.path), modified: lstatSync(f.path).mtimeMs }, { app } = appFor(f);
    const result = await view(app); expect(result.status).toBe("unavailable");
    expect(result.ledger).toEqual({ status: "unavailable", revision: null, updated_at: null });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC PRIVATE INVALID SOURCE");
    expect(JSON.stringify(result)).not.toContain(f.root); unchanged(f.path, before);
    expect(readdirSync(dirname(f.path))).toEqual(["budgets.json"]); expect(existsSync(join(f.state, "locks"))).toBe(false);
  });

  it("refuses a hard-linked ledger without changing either named copy", async () => {
    const f = fixture(), before = seed(f, ledger(f)), alias = join(f.root, "ledger-alias.json"); linkSync(f.path, alias);
    const { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("unavailable"); expect(result.ledger.status).toBe("unavailable");
    unchanged(f.path, before); expect(readFileSync(alias)).toEqual(before.bytes);
    expect(existsSync(join(f.state, "locks"))).toBe(false);
  });

  it("refuses a linked ledger directory without following it into mutation", async () => {
    const f = fixture(), destination = join(f.root, "owned-linked-target"), alias = join(f.state, "budgets");
    mkdirSync(destination); mkdirSync(f.state); const path = join(destination, "budgets.json"); raw(path, JSON.stringify(ledger(f)));
    const before = { bytes: readFileSync(path), modified: lstatSync(path).mtimeMs };
    symlinkSync(destination, alias, process.platform === "win32" ? "junction" : "dir"); links.push(alias);
    const { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("unavailable"); expect(result.ledger.status).toBe("unavailable");
    unchanged(path, before); expect(readdirSync(destination)).toEqual(["budgets.json"]);
    expect(existsSync(join(f.state, "locks"))).toBe(false);
  });

  it.each(["missing", "malformed", "future", "hard-linked"] as const)("preserves %s policy state and never exposes source errors", async (kind) => {
    const f = fixture();
    if (kind === "missing") unlinkSync(f.policyPath);
    else if (kind === "malformed") writeFileSync(f.policyPath, "SYNTHETIC PRIVATE POLICY: [");
    else if (kind === "future") writeFileSync(f.policyPath, JSON.stringify({ ...f.config, schema_version: 999 }));
    else linkSync(f.policyPath, join(f.root, "policy-alias.yml"));
    const before = existsSync(f.policyPath) ? { bytes: readFileSync(f.policyPath), modified: lstatSync(f.policyPath).mtimeMs } : null;
    const { app } = appFor(f), result = await view(app);
    expect(result.status).toBe("unavailable"); expect(result.policy).toBeNull();
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC PRIVATE POLICY"); expect(JSON.stringify(result)).not.toContain(f.root);
    if (before) unchanged(f.policyPath, before); else expect(existsSync(f.policyPath)).toBe(false);
    expect(existsSync(f.state)).toBe(false);
  });

  it("reloads and reconstructs the API with the same immutable state and no automatic execution", async () => {
    const f = fixture(), before = seed(f, ledger(f, "unknown")), first = appFor(f), firstResult = await view(first.app);
    expect(await view(first.app)).toEqual(firstResult);
    const restarted = appFor(f, {}, "synthetic-budget-api-restarted-session"); expect(await view(restarted.app)).toEqual(firstResult);
    unchanged(f.path, before); expect(existsSync(join(f.state, "locks"))).toBe(false);
    for (const processCalls of [first.processes, restarted.processes]) {
      expect(processCalls.start).not.toHaveBeenCalled(); expect(processCalls.stop).not.toHaveBeenCalled();
    }
  });

  it("honors explicit fixture state rather than reading or creating ambient state", async () => {
    const f = fixture(), ambient = join(f.root, "unrelated-ambient-state");
    vi.stubEnv("SURTEC_STATE_DIR", ambient); const { app } = appFor(f);
    expect((await view(app)).ledger.status).toBe("absent");
    expect(existsSync(f.state)).toBe(false); expect(existsSync(ambient)).toBe(false);
  });

  it.runIf(process.env.SURTEC_BUDGET_API_BROWSER_SMOKE === "1")("reads real loopback API provenance in a browser without changing state or calling providers", async () => {
    const f = fixture(), before = seed(f, ledger(f, "unknown")), { app, processes } = appFor(f);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) {
        if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
        browser = await chromium.launch({ headless: true, channel: "msedge" });
      }
      const page = await browser.newPage();
      const pageErrors: string[] = []; page.on("pageerror", (error) => pageErrors.push(error.message));
      const opened = await page.goto(`${base}/api/budgets`); expect(opened?.status()).toBe(200);
      const response = await page.evaluate(async () => {
        const response = await fetch("/api/budgets", { cache: "no-store" });
        return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
      });
      expect(response.status).toBe(200); expect(response.cache).toBe("no-store");
      expect(response.body).toMatchObject({ status: "unavailable", executable: false, reserves_capacity: false,
        policy: { revision: 7, fingerprint: f.fingerprint }, ledger: { status: "available", revision: 5, updated_at: createdAt } });
      expect(response.body.sources[0].dimensions.total_tokens).toMatchObject({ proven_consumed: 20, consumed: null, reserved: 50, remaining: null });
      const invalid = await page.evaluate(async () => {
        const response = await fetch("/api/budgets?project_id=synthetic-project&project_id=synthetic-project", { cache: "no-store" });
        return { status: response.status, body: await response.json() };
      });
      expect(invalid.status).toBe(400);
      await page.reload(); expect(pageErrors).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain("private-task");
      unchanged(f.path, before); expect(existsSync(join(f.state, "locks"))).toBe(false);
      expect(processes.start).not.toHaveBeenCalled(); expect(processes.stop).not.toHaveBeenCalled();
    } finally {
      try {
        if (browser) { await browser.close(); expect(browser.isConnected()).toBe(false); }
      } finally {
        await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
        expect(server.listening).toBe(false);
      }
    }
  }, 60000);
});
