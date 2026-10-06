import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { budgetAmounts, createBudgetService, existingBudgetConstraint, previewBudgetExecutionId, unavailableBudgetPreview, type BudgetPreviewInput } from "./budget-service";
import { readBudgetPolicy, resolveBudgetPolicy, type BudgetPolicySource } from "../../../lib/budgets/policy";
import { budgetTaskIntentId, claimTaskBudget, commitTaskBudget, observeBudgetRun, reserveTaskBudget } from "../../../lib/budgets/reservations";
import { BUDGET_DIMENSIONS, type BudgetAdmission, type BudgetAmounts, type BudgetLedger, type BudgetLimits } from "../../../lib/budgets/types";
import { mutateBudgetLedger, readBudgetLedger } from "../../../lib/state/budgets";
import { budgetStatePath } from "../../../lib/state/paths";

const at = "2026-10-05T12:00:00.000Z";
const leaf = { max_attempts: 3, max_runtime_ms: 1000, max_total_tokens: 100 };
const limits = (overrides: Partial<BudgetAmounts> = {}): BudgetLimits => Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] === undefined ? { status: "unconfigured" } : { status: "configured", hard_cap: overrides[dimension] }])) as BudgetLimits;
const source = (caps: Partial<BudgetAmounts> = {}): BudgetPolicySource => ({ fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "company-budget", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: limits(caps) }] } });
const input = (): BudgetPreviewInput => ({ attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: "planner", execution_id: "task-1" }, base_caps: budgetAmounts(leaf, "read-only") });
let root: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-budget-service-test-")); path = budgetStatePath(join(root, "state"));
  mkdirSync(join(root, "registry")); cpSync("registry/budget-policy.yml", join(root, "registry/budget-policy.yml"));
  vi.stubEnv("SURTEC_STATE_DIR", join(root, "state"));
});
afterEach(() => {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.startsWith(join(tmpdir(), "surtec-budget-service-test-"))).toBe(true);
  expect(lstatSync(root).isSymbolicLink()).toBe(false); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
});
const service = (policy = source()) => createBudgetService(root, { readBudgetPolicy: () => policy, clock: () => new Date(at) });
function hold(policy: BudgetPolicySource = source()) {
  const request = input(), projection = resolveBudgetPolicy({ ...request, source: policy, at });
  const admission: BudgetAdmission = { schema_version: 1, id: "admission-1", subject_id: "subject-1", task_id: "task-1", project_id: "alpha", role_id: "planner", agent_id: "tech-lead", issue_id: null,
    scope_revision: null, scope_fingerprint: null, context_admission_version: 1, workflow: null, attribution: request.attribution, execution_mode: "read", manifest_fingerprint: "b".repeat(64),
    admitted_cap_fingerprint: projection.cap_fingerprint, reservation_id: "reservation-1", intent_id: "placeholder", created_at: at, policy_bindings: structuredClone(projection.policy_bindings), caps: request.base_caps };
  admission.intent_id = budgetTaskIntentId(admission);
  mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission, source: policy }), path, at);
  return admission;
}
function start(policy: BudgetPolicySource) {
  const admission = hold(policy), persisted_admission = structuredClone(admission);
  mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission, persisted_admission }), path, at);
  mutateBudgetLedger((tx) => claimTaskBudget(tx, { admission, persisted_admission, source: policy, run_id: "run-1" }), path, at);
  return admission;
}

describe("T004 no-effect budget read model", () => {
  it("reads neutral registry and distinguishes optional absence without creating a ledger or locks", () => {
    const preview = createBudgetService(root, { clock: () => new Date(at) }).preview(input());
    expect(preview).toMatchObject({ schema_version: 1, observed_at: at, status: "available", can_admit: true, executable: false, reserves_capacity: false, ledger: { status: "absent", revision: null, updated_at: null } });
    expect(preview.binding!.ceilings).toEqual(input().base_caps); expect(preview.resolution!.sources[0]!.dimensions.runtime_ms.status).toBe("unconfigured");
    expect(preview.resolution!.pricing.status).toBe("unavailable"); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("retains every hold including its exact task's own hold without altering the static binding", () => {
    const policy = source({ total_tokens: 100, concurrent_reads: 1 }), before = service(policy).preview(input()); hold(policy);
    const bytes = readFileSync(path), files = readdirSync(join(root, "state/locks"));
    const preview = service(policy).preview(input());
    expect(preview.status).toBe("exhausted"); expect(preview.can_admit).toBe(false); expect(preview.binding).toEqual(before.binding);
    expect(preview.resolution!.sources[0]!.dimensions.total_tokens).toMatchObject({ consumed: 0, proven_consumed: 0, reserved: 100, remaining: 0, warning: true });
    expect(preview.denials).toContainEqual({ code: "budget-exhausted", dimension: "total_tokens", source_ids: ["policy:company-budget"] });
    expect(readFileSync(path).equals(bytes)).toBe(true); expect(readdirSync(join(root, "state/locks"))).toEqual(files);
  });
  it("retains proven subtotals and unknown final usage rather than refunding or declaring zero", () => {
    const policy = source({ total_tokens: 200 }), admission = start(policy);
    mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: admission.reservation_id, run_id: "run-1", runtime_ms: 10, total_tokens: 20, terminal: false }), path, at);
    mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: admission.reservation_id, run_id: "run-1", runtime_ms: 15, terminal: true }), path, at);
    const bytes = readFileSync(path), preview = service(policy).preview(input());
    expect(preview.status).toBe("unavailable"); expect(preview.resolution!.sources[0]!.dimensions.total_tokens).toMatchObject({ proven_consumed: 20, consumed: null, reserved: 80, remaining: null });
    expect(preview.denials).toContainEqual({ code: "budget-accounting-unavailable", dimension: "total_tokens", source_ids: ["policy:company-budget"] });
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
  it.each(["malformed", "future", "null", "wrong-type"])("reports %s stored accounting unavailable and preserves exact bytes", (kind) => {
    mkdirSync(dirname(path), { recursive: true });
    const bytes = kind === "malformed" ? "{PRIVATE SYNTHETIC UNPARSEABLE" : kind === "future" ? '{"schema_version":999,"private":"synthetic"}' : kind === "null" ? "null" : "[]";
    writeFileSync(path, bytes); const preview = service().preview(input());
    expect(preview).toMatchObject({ status: "unavailable", can_admit: false, ledger: { status: "unavailable", revision: null, updated_at: null }, resolution: null });
    expect(preview.binding!.cap_fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(preview.denials[0]!.code).toBe("budget-ledger-unavailable");
    expect(JSON.stringify(preview)).not.toContain("PRIVATE"); expect(JSON.stringify(preview)).not.toContain(root);
    expect(readFileSync(path, "utf8")).toBe(bytes); expect(existsSync(join(root, "state/locks"))).toBe(false);
  });
  it.each(["absent", "malformed", "future"])("never invents neutral policy when trusted configuration is %s", (kind) => {
    if (kind === "absent") rmSync(join(root, "registry/budget-policy.yml"));
    else writeFileSync(join(root, "registry/budget-policy.yml"), kind === "future" ? "schema_version: 2" : "private: [broken");
    const reader = vi.fn(() => null), preview = createBudgetService(root, { readBudgetLedger: reader }).preview(input());
    expect(preview.binding).toBeNull(); expect(preview.resolution).toBeNull(); expect(preview.denials[0]!.code).toBe("budget-policy-unavailable"); expect(reader).not.toHaveBeenCalled();
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("redacts arbitrary reader failures and retains static binding when only accounting is unavailable", () => {
    const preview = createBudgetService(root, { readBudgetPolicy: () => source(), readBudgetLedger: () => { throw new Error(`Synthetic private ${root}`); } }).preview(input());
    expect(preview.binding).not.toBeNull(); expect(preview.resolution).toBeNull(); expect(preview.status).toBe("unavailable"); expect(JSON.stringify(preview)).not.toContain(root);
  });
  it.each([undefined, {}, { schema_version: 2 }] as unknown[])("rejects invalid injected ledgers rather than substituting optional absence %#", (ledger) => {
    const preview = createBudgetService(root, { readBudgetPolicy: () => source(), readBudgetLedger: () => ledger as BudgetLedger }).preview(input());
    expect(preview.status).toBe("unavailable"); expect(preview.resolution).toBeNull(); expect(preview.ledger.status).toBe("unavailable");
  });
  it("binds static sources/ceilings but never external mutable availability, warnings or observation time", () => {
    let remaining = 100, time = new Date(at);
    const request = () => ({ ...input(), constraints: [existingBudgetConstraint({ id: "workflow-1", kind: "workflow", revision: 1, fingerprint: "c".repeat(64), caps: input().base_caps, availability: { total_tokens: remaining } })] });
    const svc = createBudgetService(root, { readBudgetPolicy: () => source(), clock: () => time }), first = svc.preview(request());
    remaining = 0; time = new Date("2026-10-05T12:01:00Z"); const exhausted = svc.preview(request());
    expect(exhausted.binding).toEqual(first.binding); expect(exhausted.status).toBe("exhausted"); expect(exhausted.observed_at).not.toBe(first.observed_at);
    expect(svc.preview({ ...input(), base_caps: { ...input().base_caps, total_tokens: 99 } }).binding!.cap_fingerprint).not.toBe(first.binding!.cap_fingerprint);
    const policy = source(); policy.fingerprint = "d".repeat(64); expect(service(policy).preview(input()).binding!.cap_fingerprint).not.toBe(service().preview(input()).binding!.cap_fingerprint);
  });
  it("reports a mandatory currency denial without a fabricated amount or price", () => {
    const preview = service().preview({ ...input(), require_currency: true });
    expect(preview.can_admit).toBe(false); expect(preview.status).toBe("unavailable"); expect(preview.denials).toContainEqual({ code: "pricing-unavailable", source_ids: ["pricing:no-versioned-source"] });
    expect(preview.resolution!.pricing).toEqual({ status: "unavailable", reason: "no-versioned-source" });
  });
  it("denies positive but insufficient remaining capacity for the exact prospective first hold", () => {
    const constraint = existingBudgetConstraint({ id: "workflow", kind: "workflow", revision: 1, fingerprint: "c".repeat(64), caps: input().base_caps, availability: { runtime_ms: 500 } });
    const preview = service().preview({ ...input(), constraints: [constraint] });
    expect(preview.resolution!.can_admit).toBe(true); expect(preview.can_admit).toBe(false); expect(preview.status).toBe("exhausted");
    expect(preview.prospective_hold).toMatchObject({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 });
    expect(preview.denials).toContainEqual({ code: "budget-reservation-insufficient", dimension: "runtime_ms", source_ids: ["existing:workflow"] });
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("returns detached frozen data and no subject, admission, intent or authority record", () => {
    const request = input(), policy = source(), preview = service(policy).preview(request), bytes = JSON.stringify(preview);
    request.attribution.project_ids.push("other"); policy.policy.rules[0]!.limits = limits({ total_tokens: 0 });
    expect(JSON.stringify(preview)).toBe(bytes); expect(Object.isFrozen(preview.binding!.policy_bindings)).toBe(true); expect(Object.isFrozen(preview.resolution!.dimensions)).toBe(true);
    expect(Object.keys(preview)).not.toContain("reservation_id"); expect(Object.keys(preview)).not.toContain("intent_id"); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it.each(["ledger", "source", "at", "exclude_task_id", "reservation_id", "intent_id"])("rejects caller-injected %s, including arbitrary self-exclusion", (key) => {
    const reader = vi.fn(() => null), preview = createBudgetService(root, { readBudgetPolicy: () => source(), readBudgetLedger: reader }).preview({ ...input(), [key]: "task-1" } as BudgetPreviewInput);
    expect(preview.status).toBe("unavailable"); expect(preview.binding).toBeNull(); expect(reader).not.toHaveBeenCalled();
  });
  it("rejects input getters and nested hooks before invoking them", () => {
    const getter = vi.fn(() => input().attribution), request = { base_caps: input().base_caps };
    Object.defineProperty(request, "attribution", { get: getter, enumerable: true });
    expect(service().preview(request as BudgetPreviewInput).status).toBe("unavailable"); expect(getter).not.toHaveBeenCalled();
    const hook = vi.fn(), nested = { ...input(), attribution: { ...input().attribution, toJSON: hook } };
    expect(service().preview(nested).status).toBe("unavailable"); expect(hook).not.toHaveBeenCalled();
  });
  it.each([
    { attempts: 0 }, { runtime_ms: 0 }, { total_tokens: 0 }, { concurrent_reads: 0 }, { concurrent_reads: 2 }, { concurrent_writes: 1 },
    { review_attempts: 1 }, { review_runtime_ms: 1 }, { review_total_tokens: 1 }, { corrections: 2 },
    { review_attempts: 4, review_runtime_ms: 1000, review_total_tokens: 100 },
  ])("refuses non-reservable task ceilings rather than forecasting authority %#", (override) => {
    const reader = vi.fn(() => null), preview = createBudgetService(root, { readBudgetPolicy: () => source(), readBudgetLedger: reader }).preview({ ...input(), base_caps: { ...input().base_caps, ...override } });
    expect(preview.status).toBe("unavailable"); expect(preview.can_admit).toBe(false); expect(preview.binding).toBeNull(); expect(preview.prospective_hold).toBeNull(); expect(reader).not.toHaveBeenCalled();
  });
  it("keeps unavailable fallback explicitly non-executable and performs no read or write", () => {
    const preview = unavailableBudgetPreview(); expect(preview).toMatchObject({ observed_at: null, status: "unavailable", can_admit: false, executable: false, reserves_capacity: false, binding: null, resolution: null });
    expect(Object.isFrozen(preview)).toBe(true); expect(existsSync(join(root, "state"))).toBe(false);
  });
});

describe("finite existing caps and preview-only identity", () => {
  it.each(["analysis", "planning", "operations", "implementation", "review", "qa", "correction"] as const)("preserves canonical and overlapping dimensions for %s", (kind) => {
    const writer = kind === "implementation" || kind === "correction", caps = budgetAmounts(leaf, writer ? "workspace-write" : "read-only", kind);
    expect(caps.attempts).toBe(3); expect(caps.runtime_ms).toBe(1000); expect(caps.total_tokens).toBe(100);
    expect(caps.concurrent_reads + caps.concurrent_writes).toBe(1); expect(caps.corrections).toBe(kind === "correction" ? 1 : 0);
    expect(caps.review_total_tokens).toBe(kind === "review" || kind === "qa" ? 100 : 0);
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses a non-finite/unsafe leaf ceiling %s", (tokens) => {
    expect(() => budgetAmounts({ ...leaf, max_total_tokens: tokens }, "read-only")).toThrow();
  });
  it("never allocates a future execution identity and keeps identity independent from mutable resources", () => {
    expect(previewBudgetExecutionId("alpha", "planner", null)).toMatch(/^preview-[a-f0-9]{64}$/);
    expect(previewBudgetExecutionId("alpha", "planner", null)).toBe(previewBudgetExecutionId("alpha", "planner", null));
    expect(previewBudgetExecutionId("alpha", "planner", "issue-1")).not.toBe(previewBudgetExecutionId("alpha", "planner", null));
  });
  it("preserves explicit unavailable existing availability without granting a zero balance", () => {
    const constraint = existingBudgetConstraint({ id: "worker", kind: "worker", revision: 1, fingerprint: "e".repeat(64), caps: input().base_caps, availability: { total_tokens: null } });
    const preview = service().preview({ ...input(), constraints: [constraint] });
    expect(preview.status).toBe("unavailable"); expect(preview.resolution!.dimensions.total_tokens.remaining).toBeNull(); expect(preview.binding).not.toBeNull();
    expect(readBudgetLedger(path)).toBeNull(); expect(readBudgetPolicy(root).policy.schema_version).toBe(1);
  });
});
