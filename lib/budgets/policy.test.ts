import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Objective, OrganizationSnapshot } from "../organization";
import { budgetBucket, readBudgetPolicy, resolveBudgetPolicy, resolveOccurrenceBudgetAttribution, resolveTaskBudgetAttribution } from "./policy";
import type { BudgetCorrectionLineage, BudgetPolicySource, ExistingBudgetConstraint } from "./policy";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS } from "./types";
import type { BudgetAmounts, BudgetAttribution, BudgetLedger, BudgetLimits, BudgetPeriod, BudgetPolicy, BudgetPolicyBinding, BudgetPolicyRule, BudgetTaskSubject } from "./types";
import { assertBudgetLedger, BudgetContractError } from "./validation";

// Entirely synthetic read-only previews: these fixtures carry no issued human
// approval, controller proof, normal state, provider or runtime authority.
const at = "2026-10-05T12:00:00Z";
const digest = "a".repeat(64);
const amounts = (overrides: Partial<BudgetAmounts> = {}): BudgetAmounts => ({
  attempts: 0, runtime_ms: 0, total_tokens: 0, concurrent_reads: 0, concurrent_writes: 0,
  review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0, ...overrides,
});
const baseCaps = (): BudgetAmounts => amounts({ attempts: 3, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 });
function limits(overrides: Partial<BudgetAmounts> = {}): BudgetLimits {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] === undefined
    ? { status: "unconfigured" } : { status: "configured", hard_cap: overrides[dimension] }])) as BudgetLimits;
}
const rule = (id = "company-policy", scope: BudgetPolicyRule["scope"] = { kind: "company", id: "surtec" }, caps: Partial<BudgetAmounts> = {}, period: BudgetPeriod = "none"): BudgetPolicyRule => ({ id, revision: 1, scope, period, warning_percent: 80, limits: limits(caps) });
const policy = (rules = [rule()]): BudgetPolicy => ({ schema_version: 1, revision: 1, rules, pricing: { status: "unavailable", reason: "no-versioned-source" } });
const source = (rules = [rule()]): BudgetPolicySource => ({ policy: policy(rules), fingerprint: digest });
const attribution = (overrides: Partial<BudgetAttribution> = {}): BudgetAttribution => ({ company_id: "surtec", objective_ids: ["child", "root"], project_ids: ["project-1"], issue_id: "issue-1", role_id: "engineer", execution_id: "task-1", ...overrides });
function objective(id: string, parent: string | null, projects: string[] = []): Objective {
  return { schema_version: 1, id, company_id: "surtec", title: `Synthetic ${id}`, desired_outcome: "Synthetic measurable outcome", success_criteria: ["Synthetic criterion"], status: "draft", horizon: "now", priority: 1, target_date: null, parent_objective_id: parent, project_ids: projects, owner: "marcos", last_reviewed_at: null };
}
function organization(): OrganizationSnapshot {
  return { company: { schema_version: 1, id: "surtec", display_name: "Synthetic SURTEC", mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null }, objectives: [objective("root", null), objective("child", "root", ["project-1"]), objective("secondary", null, ["project-1"])], project_objectives: { "project-1": { objective_ids: ["child", "secondary"], primary_objective_id: "child" } } };
}
const taskInput = (snapshot = organization()) => ({ organization: snapshot, project_id: "project-1", issue: null, role_id: "engineer", execution_id: "task-1" });
const occurrenceInput = (snapshot = organization()) => ({ organization: snapshot, project_ids: ["project-1"], objective_id: "child", execution_id: "occurrence-1" });
const previewInput = () => ({ source: source(), attribution: attribution(), at, base_caps: baseCaps() });
function binding(createdAt = at): BudgetPolicyBinding {
  return { policy_id: "company-policy", policy_revision: 1, policy_fingerprint: digest, scope: { kind: "company", id: "surtec" }, period: "none", bucket: budgetBucket("none", createdAt), limits: limits() };
}
function ledger(): BudgetLedger {
  const subject: BudgetTaskSubject = { id: "subject-1", kind: "task", task_id: "task-1", project_id: "project-1", role_id: "engineer", agent_id: "synthetic-agent", issue_id: "issue-1", workflow: null, attribution: attribution() };
  return { schema_version: 1, revision: 1, created_at: at, updated_at: at,
    subjects: { [subject.id]: subject },
    reservations: { "reservation-1": { id: "reservation-1", revision: 1, subject_id: subject.id, intent_id: "intent-1", status: "settled", policy_bindings: [binding()], held: amounts(), uncertain_dimensions: [], run_ids: ["run-1"], created_at: at, updated_at: at } },
    admission_intents: { "intent-1": { id: "intent-1", subject_id: subject.id, reservation_id: "reservation-1", admission_id: "admission-1", status: "committed", created_at: at, updated_at: at } },
    charges: { "charge-1": { id: "charge-1", subject_id: subject.id, reservation_id: "reservation-1", run_id: "run-1", attempts: 1, runtime_ms: 100, observed_total_tokens: 20, runtime_state: "complete", usage_state: "complete", status: "terminal", review: false, correction: false, created_at: at, updated_at: at } },
  };
}
function heldLedger(status: "pending" | "committed" | "active" | "unknown" = "committed"): BudgetLedger {
  const value = ledger(), reserve = value.reservations["reservation-1"]!;
  reserve.status = status; reserve.held = amounts({ attempts: 1, runtime_ms: 500, total_tokens: 50, concurrent_reads: 1 });
  if (status !== "active") { reserve.run_ids = []; value.charges = {}; }
  else { value.charges["charge-1"]!.status = "running"; }
  const intent = value.admission_intents["intent-1"]!;
  if (status === "pending") { intent.status = "pending"; intent.admission_id = null; }
  if (status === "unknown") { intent.status = "unknown"; reserve.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"]; }
  return value;
}
function unknownLedger(tokens: number | null = null): BudgetLedger {
  const value = ledger(), reserve = value.reservations["reservation-1"]!, charge = value.charges["charge-1"]!;
  reserve.status = "unknown"; reserve.held = amounts({ runtime_ms: 500, total_tokens: 50, concurrent_reads: 1 }); reserve.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"];
  value.admission_intents["intent-1"]!.status = "unknown";
  charge.runtime_state = "unknown"; charge.usage_state = "unknown"; charge.observed_total_tokens = tokens;
  return value;
}
function addSecondSubject(value: BudgetLedger, workflowId: string | null = null): void {
  const first = value.subjects["subject-1"]! as BudgetTaskSubject;
  if (workflowId) first.workflow = { workflow_id: workflowId, stage_id: "stage-1", stage_generation: 1, grant_id: "grant-1" };
  const second: BudgetTaskSubject = { ...structuredClone(first), id: "subject-2", task_id: "task-2", attribution: { ...structuredClone(first.attribution), execution_id: "task-2" }, workflow: workflowId ? { workflow_id: workflowId, stage_id: "stage-2", stage_generation: 1, grant_id: "grant-2" } : null };
  value.subjects[second.id] = second;
  value.reservations["reservation-2"] = { ...structuredClone(value.reservations["reservation-1"]!), id: "reservation-2", subject_id: second.id, intent_id: "intent-2", run_ids: ["run-2"] };
  value.admission_intents["intent-2"] = { ...structuredClone(value.admission_intents["intent-1"]!), id: "intent-2", subject_id: second.id, reservation_id: "reservation-2", admission_id: "admission-2" };
  value.charges["charge-2"] = { ...structuredClone(value.charges["charge-1"]!), id: "charge-2", subject_id: second.id, reservation_id: "reservation-2", run_id: "run-2" };
}
const constraint = (caps: Partial<BudgetAmounts> = {}): ExistingBudgetConstraint => ({ id: "worker-policy", kind: "worker", revision: 1, fingerprint: digest, limits: limits(caps) });
const correctionLineage = (workflowIds = ["workflow-1"], id = "lineage-1"): BudgetCorrectionLineage => ({ id, project_id: "project-1", issue_id: "issue-1", workflow_ids: workflowIds });
function availability(overrides: Partial<ExistingBudgetConstraint["availability"]> = {}): NonNullable<ExistingBudgetConstraint["availability"]> {
  return { ...Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "known", remaining: 0 }])), ...overrides } as NonNullable<ExistingBudgetConstraint["availability"]>;
}
function frozenTree(value: unknown): boolean {
  return value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozenTree);
}
function rejectUnchanged(value: unknown, action: (value: never) => unknown): void {
  const before = JSON.stringify(value); expect(() => action(value as never)).toThrow(BudgetContractError); expect(JSON.stringify(value)).toBe(before);
}
const ownedRoots = new Set<string>();
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "surtec-budget-policy-test-")); ownedRoots.add(root); return root;
}
function writePolicyFixture(bytes = JSON.stringify(policy()), root = temporaryRoot()): { root: string; path: string } {
  const registry = join(root, "registry"); mkdirSync(registry); const path = join(registry, "budget-policy.yml"); writeFileSync(path, bytes); return { root, path };
}
afterEach(() => {
  for (const root of ownedRoots) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.startsWith(join(tmpdir(), "surtec-budget-policy-test-"))).toBe(true);
    rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
  }
  ownedRoots.clear(); vi.restoreAllMocks();
});

describe("T002 strict UTC budget buckets", () => {
  it.each(["2024-02-29T23:59:59Z", "2026-10-05T00:00:00.1Z", "2026-10-05T12:00:00.000Z"])("accepts exact real UTC time %s without local conversion", (stamp) => {
    expect(budgetBucket("none", stamp)).toBe("none"); expect(budgetBucket("utc-day", stamp)).toBe(stamp.slice(0, 10)); expect(budgetBucket("utc-month", stamp)).toBe(stamp.slice(0, 7));
  });
  it.each(["2025-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-10-05", "2026-10-05T12:00:00", "2026-10-05T12:00:00+00:00", "2026-10-05T12:00:00-03:00", "2026-10-05T24:00:00Z", "2026-10-05T12:60:00Z", "2026-10-05T12:00:60Z", "2026-10-05T12:00:00.0000Z", "0000-01-01T00:00:00Z", "2026-13-01T00:00:00Z", "", null, 0])("rejects invalid/implicit UTC timestamp %j even with no period", (stamp) => {
    expect(() => budgetBucket("none", stamp as string)).toThrow(BudgetContractError);
  });
  it("rejects unsupported periods and changes buckets at exact UTC boundaries", () => {
    expect(() => budgetBucket("local-day" as BudgetPeriod, at)).toThrow(BudgetContractError);
    expect(budgetBucket("utc-day", "2026-10-31T23:59:59.999Z")).toBe("2026-10-31"); expect(budgetBucket("utc-day", "2026-11-01T00:00:00Z")).toBe("2026-11-01"); expect(budgetBucket("utc-month", "2026-11-01T00:00:00Z")).toBe("2026-11");
  });
});

describe("T002 frozen application-owned attribution", () => {
  it("selects the project primary and ancestors, not every secondary objective", () => {
    const input = taskInput(), before = JSON.stringify(input), result = resolveTaskBudgetAttribution(input);
    expect(result).toEqual(attribution({ issue_id: null })); expect(frozenTree(result)).toBe(true); expect(JSON.stringify(input)).toBe(before); expect(Object.isFrozen(input.organization)).toBe(false);
    input.organization.project_objectives["project-1"]!.primary_objective_id = "secondary"; expect(result.objective_ids).toEqual(["child", "root"]);
  });
  it("gives a valid issue objective precedence and keeps the exact issue identity", () => {
    const result = resolveTaskBudgetAttribution({ ...taskInput(), issue: { id: "issue-1", project_id: "project-1", objective_id: "secondary" } });
    expect(result.objective_ids).toEqual(["secondary"]); expect(result.issue_id).toBe("issue-1");
  });
  it("uses the project primary when the exact issue has no objective", () => {
    expect(resolveTaskBudgetAttribution({ ...taskInput(), issue: { id: "issue-1", project_id: "project-1", objective_id: null } }).objective_ids).toEqual(["child", "root"]);
  });
  it("keeps an existing issue's explicit objective anchor after unlink and primary change", () => {
    const snapshot = organization(); snapshot.project_objectives["project-1"] = { objective_ids: ["secondary"], primary_objective_id: "secondary" }; snapshot.objectives[1]!.project_ids = [];
    const result = resolveTaskBudgetAttribution({ ...taskInput(snapshot), issue: { id: "issue-1", project_id: "project-1", objective_id: "child" } });
    expect(result.objective_ids).toEqual(["child", "root"]); expect(result.issue_id).toBe("issue-1");
  });
  it("preserves personal work without inventing an objective or project for company occurrences", () => {
    const snapshot = organization(); snapshot.project_objectives["project-1"]!.primary_objective_id = null;
    expect(resolveTaskBudgetAttribution(taskInput(snapshot)).objective_ids).toEqual([]);
    expect(resolveTaskBudgetAttribution({ ...taskInput(snapshot), project_id: "personal-project" }).objective_ids).toEqual([]);
    const result = resolveOccurrenceBudgetAttribution({ ...occurrenceInput(snapshot), project_ids: [], objective_id: null });
    expect(result).toEqual(attribution({ project_ids: [], objective_ids: [], issue_id: null, role_id: null, execution_id: "occurrence-1" })); expect(frozenTree(result)).toBe(true);
  });
  it("supports exactly eight ancestor objectives and rejects a ninth without truncating", () => {
    const snapshot = organization(); snapshot.objectives = Array.from({ length: 8 }, (_, index) => objective(`O-${index}`, index === 7 ? null : `O-${index + 1}`, index === 0 ? ["project-1"] : [])); snapshot.project_objectives = { "project-1": { objective_ids: ["O-0"], primary_objective_id: "O-0" } };
    expect(resolveTaskBudgetAttribution(taskInput(snapshot)).objective_ids).toEqual(Array.from({ length: 8 }, (_, index) => `O-${index}`));
    snapshot.objectives[7]!.parent_objective_id = "O-8"; snapshot.objectives.push(objective("O-8", null)); rejectUnchanged(taskInput(snapshot), resolveTaskBudgetAttribution);
  });
  it("sorts a bounded occurrence project set without mutating the caller or adding roles/issues", () => {
    const projects = Array.from({ length: 25 }, (_, index) => `project-${String(index).padStart(2, "0")}`).reverse();
    const result = resolveOccurrenceBudgetAttribution({ ...occurrenceInput(), project_ids: projects, objective_id: null });
    expect(result.project_ids).toEqual([...projects].sort()); expect(result.role_id).toBeNull(); expect(result.issue_id).toBeNull(); expect(frozenTree(result)).toBe(true); expect(projects[0]).toBe("project-24");
    rejectUnchanged({ ...occurrenceInput(), project_ids: [...projects, "project-25"] }, resolveOccurrenceBudgetAttribution);
  });
  it.each(["missing-parent", "cycle", "duplicate-objective", "bad-company", "reverse-index", "active-index", "missing-primary", "duplicate-link"])("rejects inconsistent full organization evidence: %s", (kind) => {
    const snapshot = organization();
    if (kind === "missing-parent") snapshot.objectives[0]!.parent_objective_id = "missing";
    if (kind === "cycle") snapshot.objectives[0]!.parent_objective_id = "child";
    if (kind === "duplicate-objective") snapshot.objectives.push(structuredClone(snapshot.objectives[0]!));
    if (kind === "bad-company") (snapshot.company as unknown as { id: string }).id = "other";
    if (kind === "reverse-index") snapshot.objectives[1]!.project_ids = [];
    if (kind === "active-index") snapshot.company.active_objective_ids = ["child"];
    if (kind === "missing-primary") snapshot.project_objectives["project-1"]!.primary_objective_id = "missing";
    if (kind === "duplicate-link") snapshot.project_objectives["project-1"]!.objective_ids.push("child");
    rejectUnchanged(taskInput(snapshot), resolveTaskBudgetAttribution); rejectUnchanged(occurrenceInput(snapshot), resolveOccurrenceBudgetAttribution);
  });
  it.each(["../outside", "x..y", "constructor", "prototype", "__proto__", "", "a".repeat(161)])("rejects unsafe identity %j", (unsafe) => {
    rejectUnchanged({ ...taskInput(), project_id: unsafe }, resolveTaskBudgetAttribution); rejectUnchanged({ ...taskInput(), role_id: unsafe }, resolveTaskBudgetAttribution); rejectUnchanged({ ...taskInput(), execution_id: unsafe }, resolveTaskBudgetAttribution); rejectUnchanged({ ...occurrenceInput(), project_ids: [unsafe] }, resolveOccurrenceBudgetAttribution);
  });
  it.each([{ id: "issue-1", project_id: "other", objective_id: "child" }, { id: "issue-1", project_id: "project-1", objective_id: "missing" }, { id: "issue-1", project_id: "project-1", objective_id: "child", role_id: "engineer" }])("rejects mismatched, missing or caller-extended issue binding %j", (issue) => {
    rejectUnchanged({ ...taskInput(), issue }, resolveTaskBudgetAttribution);
  });
  it("rejects duplicate occurrence projects and invented task role metadata", () => {
    rejectUnchanged({ ...occurrenceInput(), project_ids: ["project-1", "project-1"] }, resolveOccurrenceBudgetAttribution); rejectUnchanged({ ...occurrenceInput(), role_id: "engineer" }, resolveOccurrenceBudgetAttribution);
  });
});

describe("T002 restrictive deterministic policy previews", () => {
  it("keeps neutral parents explicit while preserving every finite existing cap and unavailable pricing", () => {
    const input = previewInput(), result = resolveBudgetPolicy(input);
    expect(result.ceilings).toEqual(input.base_caps); expect(result.can_admit).toBe(true); expect(result.denials).toEqual([]); expect(result.pricing).toEqual({ status: "unavailable", reason: "no-versioned-source" });
    expect(result.policy_bindings).toHaveLength(1); expect(result.sources[0]!.dimensions.total_tokens).toEqual({ status: "unconfigured", cap: null, proven_consumed: 0, consumed: 0, reserved: 0, remaining: null, warning: false });
    expect(result.dimensions.total_tokens).toEqual({ ceiling: 100, remaining: 100, status: "available", warning: false, limiting_sources: ["existing:base"] }); expect(frozenTree(result)).toBe(true);
  });
  it("intersects exactly the six applicable scopes plus selected ancestors without summing overlapping limits", () => {
    const scopes: BudgetPolicyRule["scope"][] = [{ kind: "company", id: "surtec" }, { kind: "objective", id: "root" }, { kind: "objective", id: "child" }, { kind: "project", id: "project-1" }, { kind: "issue", id: "issue-1" }, { kind: "role", id: "engineer" }, { kind: "execution", id: "task-1" }];
    const rules = scopes.map((scope, index) => rule(`rule-${index}`, scope, { total_tokens: 90 - index * 10 })); rules.push(rule("unselected", { kind: "objective", id: "secondary" }, { total_tokens: 0 }), rule("other-project", { kind: "project", id: "other" }, { total_tokens: 0 }));
    const result = resolveBudgetPolicy({ ...previewInput(), source: source(rules) }); expect(result.policy_bindings).toHaveLength(7); expect(result.ceilings.total_tokens).toBe(30); expect(result.dimensions.total_tokens.remaining).toBe(30); expect(result.dimensions.total_tokens.limiting_sources).toEqual(["policy:rule-6"]); expect(result.can_admit).toBe(true);
  });
  it.each(BUDGET_DIMENSIONS)("restricts %s and denies a configured zero only when it is requested", (dimension) => {
    const input = { ...previewInput(), base_caps: amounts({ [dimension]: 10 }), source: source([rule("company-policy", undefined, { [dimension]: 4 })]) };
    const result = resolveBudgetPolicy(input); expect(result.ceilings[dimension]).toBe(4); expect(result.dimensions[dimension].remaining).toBe(4);
    input.source = source([rule("company-policy", undefined, { [dimension]: 0 })]); const denied = resolveBudgetPolicy(input);
    expect(denied.can_admit).toBe(false); expect(denied.denials).toContainEqual({ code: "budget-exhausted", dimension, source_ids: ["policy:company-policy"] });
    input.base_caps[dimension] = 0; expect(resolveBudgetPolicy(input).can_admit).toBe(true);
  });
  it.each(["worker", "project", "role", "workflow", "correction", "execution", "routine"] as const)("keeps existing %s constraints restrictive with honest availability provenance", (kind) => {
    const existing = { ...constraint({ total_tokens: 60 }), kind, availability: availability({ total_tokens: { status: "known", remaining: 35 } }) };
    const result = resolveBudgetPolicy({ ...previewInput(), constraints: [existing] }); expect(result.ceilings.total_tokens).toBe(60); expect(result.dimensions.total_tokens.remaining).toBe(35); expect(result.sources[1]!.dimensions.total_tokens).toMatchObject({ cap: 60, consumed: null, proven_consumed: 0, reserved: 0, remaining: 35 }); expect(result.can_admit).toBe(true);
  });
  it("keeps overlapping trusted policy IDs as an intersection, not duplicate consumption", () => {
    const result = resolveBudgetPolicy({ ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 80 }), rule("company-secondary", undefined, { total_tokens: 60 })]), ledger: ledger() });
    expect(result.dimensions.total_tokens.remaining).toBe(40); expect(result.sources.map((entry) => entry.dimensions.total_tokens.proven_consumed)).toEqual([20, 20]); expect(result.policy_bindings).toHaveLength(2);
  });
  it.each([79, 80, 81, 100])("warns at the exact configured 80 percent boundary (%i consumed) without overriding hard stops", (tokens) => {
    const usage = ledger(); usage.charges["charge-1"]!.observed_total_tokens = tokens;
    const result = resolveBudgetPolicy({ ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100 })]), ledger: usage });
    expect(result.dimensions.total_tokens.warning).toBe(tokens >= 80); expect(result.can_admit).toBe(tokens < 100); expect(result.dimensions.total_tokens.status).toBe(tokens === 100 ? "exhausted" : "available");
  });
  it("includes reservations in warning/remaining but does not change immutable ceilings", () => {
    const usage = heldLedger(); usage.reservations["reservation-1"]!.held.total_tokens = 80;
    const result = resolveBudgetPolicy({ ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100 })]), ledger: usage });
    expect(result.dimensions.total_tokens).toMatchObject({ ceiling: 100, remaining: 20, warning: true }); expect(result.sources[0]!.dimensions.total_tokens).toMatchObject({ consumed: 0, reserved: 80 });
  });
  it("rejects mandatory currency support visibly instead of inventing a price or silently ignoring it", () => {
    const result = resolveBudgetPolicy({ ...previewInput(), require_currency: true }); expect(result.can_admit).toBe(false); expect(result.denials).toEqual([{ code: "pricing-unavailable", source_ids: ["pricing:no-versioned-source"] }]); expect(result.pricing).not.toHaveProperty("cost");
  });
  it("intersects every selected occurrence project without fabricating issue or role constraints", () => {
    const occurrence = resolveOccurrenceBudgetAttribution({ ...occurrenceInput(), project_ids: ["project-2", "project-1"], objective_id: null });
    const result = resolveBudgetPolicy({ ...previewInput(), attribution: occurrence, base_caps: amounts({ attempts: 1, runtime_ms: 60000, concurrent_reads: 1 }), source: source([rule(), rule("project-one", { kind: "project", id: "project-1" }, { runtime_ms: 50000 }), rule("project-two", { kind: "project", id: "project-2" }, { runtime_ms: 30000 }), rule("role-unrelated", { kind: "role", id: "engineer" }, { runtime_ms: 0 }), rule("issue-unrelated", { kind: "issue", id: "issue-1" }, { runtime_ms: 0 })]) });
    expect(result.ceilings.runtime_ms).toBe(30000); expect(result.policy_bindings.map((entry) => entry.policy_id)).toEqual(["company-policy", "project-one", "project-two"]); expect(result.can_admit).toBe(true);
  });
});

describe("T002 canonical accounting, uncertainty and original periods", () => {
  it("counts retries once each, even when cumulative runtime exceeds the per-attempt base cap", () => {
    const usage = ledger(), first = usage.charges["charge-1"]!; first.runtime_ms = 700; usage.charges["charge-2"] = { ...first, id: "charge-2", run_id: "run-2" }; usage.reservations["reservation-1"]!.run_ids.push("run-2"); assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), source: source([rule("company-policy", undefined, { runtime_ms: 3000, attempts: 5 })]), ledger: usage });
    expect(result.sources[0]!.dimensions.runtime_ms.proven_consumed).toBe(1400); expect(result.sources[0]!.dimensions.attempts.proven_consumed).toBe(2); expect(result.ceilings.runtime_ms).toBe(1000); expect(result.dimensions.runtime_ms.remaining).toBe(1000); expect(result.can_admit).toBe(true);
  });
  it("labels Reviewer/correction charges without duplicating canonical totals or lineage allowance", () => {
    const usage = ledger(); usage.charges["charge-1"]!.review = true; usage.charges["charge-1"]!.correction = true; addSecondSubject(usage, "workflow-1"); assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, correction_lineages: [correctionLineage()] }); const view = result.sources[0]!.dimensions;
    expect(view.attempts.proven_consumed).toBe(2); expect(view.runtime_ms.proven_consumed).toBe(200); expect(view.total_tokens.proven_consumed).toBe(40); expect(view.review_attempts.proven_consumed).toBe(2); expect(view.review_total_tokens.proven_consumed).toBe(40); expect(view.corrections.proven_consumed).toBe(1);
  });
  it("separates distinct trusted correction lineages and independently charged review dimensions", () => {
    const usage = ledger(); usage.charges["charge-1"]!.correction = true; addSecondSubject(usage, "workflow-1"); (usage.subjects["subject-2"]! as BudgetTaskSubject).workflow!.workflow_id = "workflow-2"; usage.charges["charge-2"]!.review = true; assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, correction_lineages: [correctionLineage(), correctionLineage(["workflow-2"], "lineage-2")], base_caps: amounts({ attempts: 3, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1, review_attempts: 2, review_runtime_ms: 500, review_total_tokens: 30, corrections: 1 }), source: source([rule("company-policy", undefined, { review_total_tokens: 20, corrections: 2 })]) });
    expect(result.sources[0]!.dimensions.corrections.proven_consumed).toBe(2); expect(result.sources[0]!.dimensions.review_total_tokens.proven_consumed).toBe(20); expect(result.denials).toContainEqual({ code: "budget-exhausted", dimension: "review_total_tokens", source_ids: ["policy:company-policy"] }); expect(result.denials).toContainEqual({ code: "budget-exhausted", dimension: "corrections", source_ids: ["policy:company-policy"] });
  });
  it("deduplicates a held correction already consumed in the same workflow lineage", () => {
    const usage = ledger(); usage.charges["charge-1"]!.correction = true; addSecondSubject(usage, "workflow-1"); delete usage.charges["charge-2"];
    const reserve = usage.reservations["reservation-2"]!; reserve.status = "committed"; reserve.run_ids = []; reserve.held = amounts({ attempts: 1, runtime_ms: 500, total_tokens: 50, concurrent_reads: 1, corrections: 1 }); assertBudgetLedger(usage);
    const view = resolveBudgetPolicy({ ...previewInput(), ledger: usage, correction_lineages: [correctionLineage()] }).sources[0]!.dimensions.corrections; expect(view.proven_consumed).toBe(1); expect(view.reserved).toBe(0);
  });
  it("counts one correction across replacement workflows in the exact retained candidate lineage", () => {
    const usage = ledger(); usage.charges["charge-1"]!.correction = true; addSecondSubject(usage, "workflow-1"); (usage.subjects["subject-2"]! as BudgetTaskSubject).workflow!.workflow_id = "workflow-2";
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, correction_lineages: [correctionLineage(["workflow-1", "workflow-2"])], base_caps: { ...baseCaps(), corrections: 1 }, source: source([rule("company-policy", undefined, { corrections: 1 })]) });
    expect(result.sources[0]!.dimensions.corrections).toMatchObject({ proven_consumed: 1, consumed: 1, reserved: 0, remaining: 0 }); expect(result.sources[0]!.dimensions.attempts.proven_consumed).toBe(2); expect(result.dimensions.corrections.status).toBe("exhausted");
  });
  it.each(["missing", "no-workflow", "hold"])("marks %s correction ownership unavailable rather than inventing an allowance", (kind) => {
    const usage = kind === "hold" ? heldLedger() : ledger();
    if (kind === "hold") usage.reservations["reservation-1"]!.held.corrections = 1; else usage.charges["charge-1"]!.correction = true;
    if (kind !== "no-workflow") (usage.subjects["subject-1"]! as BudgetTaskSubject).workflow = { workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, grant_id: "grant-1" };
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, base_caps: { ...baseCaps(), corrections: 1 }, source: source([rule("company-policy", undefined, { corrections: 1 })]) });
    expect(result.sources[0]!.dimensions.corrections.consumed).toBeNull(); expect(result.dimensions.corrections.status).toBe("unavailable"); expect(result.denials).toContainEqual({ code: "budget-accounting-unavailable", dimension: "corrections", source_ids: ["policy:company-policy"] }); expect(result.sources[0]!.dimensions.total_tokens.consumed).toBe(kind === "hold" ? 0 : 20);
  });
  it.each(["wrong-project", "wrong-issue", "duplicate-id", "duplicate-workflow", "missing-workflows", "fake-role"])("rejects contradictory correction lineage %s without rewriting accounting", (kind) => {
    const usage = ledger(); usage.charges["charge-1"]!.correction = true; (usage.subjects["subject-1"]! as BudgetTaskSubject).workflow = { workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, grant_id: "grant-1" };
    const lineages: Record<string, unknown>[] = [{ ...correctionLineage() }];
    if (kind === "wrong-project") lineages[0]!.project_id = "other";
    if (kind === "wrong-issue") lineages[0]!.issue_id = "other";
    if (kind === "duplicate-id") lineages.push({ ...correctionLineage(["workflow-2"]) });
    if (kind === "duplicate-workflow") lineages.push({ ...correctionLineage(["workflow-1"], "lineage-2") });
    if (kind === "missing-workflows") lineages[0]!.workflow_ids = [];
    if (kind === "fake-role") lineages[0]!.role_id = "engineer";
    rejectUnchanged({ ...previewInput(), ledger: usage, correction_lineages: lineages }, resolveBudgetPolicy);
  });
  it.each([null, 0, 17])("preserves unknown usage with proven tokens %j rather than substituting zero or refunding holds", (tokens) => {
    const usage = unknownLedger(tokens); assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, source: source([rule("company-policy", undefined, { total_tokens: 1000, runtime_ms: 10000 })]) });
    expect(result.sources[0]!.dimensions.total_tokens).toMatchObject({ consumed: null, proven_consumed: tokens ?? 0, reserved: 50, remaining: null, warning: true }); expect(result.dimensions.total_tokens.status).toBe("unavailable"); expect(result.can_admit).toBe(false); expect(result.denials).toContainEqual({ code: "budget-accounting-unavailable", dimension: "total_tokens", source_ids: ["policy:company-policy"] });
  });
  it("keeps unconfigured parent uncertainty visible without inventing a cumulative parent cap", () => {
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: unknownLedger(17) }); expect(result.sources[0]!.dimensions.total_tokens.consumed).toBeNull(); expect(result.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(17); expect(result.dimensions.total_tokens.remaining).toBe(100); expect(result.can_admit).toBe(true);
  });
  it("propagates unknown Reviewer usage independently without treating its proven chunk as final", () => {
    const usage = unknownLedger(17); usage.charges["charge-1"]!.review = true; usage.reservations["reservation-1"]!.uncertain_dimensions.push("review_runtime_ms", "review_total_tokens"); assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage, base_caps: { ...baseCaps(), review_runtime_ms: 500, review_total_tokens: 50 }, source: source([rule("company-policy", undefined, { review_runtime_ms: 1000, review_total_tokens: 100 })]) });
    expect(result.sources[0]!.dimensions.review_total_tokens).toMatchObject({ consumed: null, proven_consumed: 17, remaining: null }); expect(result.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(17); expect(result.denials.map((denial) => denial.dimension)).toEqual(["review_runtime_ms", "review_total_tokens"]);
  });
  it("distinguishes complete explicit zero from missing usage and unavailable existing counters", () => {
    const usage = ledger(); usage.charges["charge-1"]!.observed_total_tokens = 0;
    const input = { ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100 })]), ledger: usage };
    expect(resolveBudgetPolicy(input).sources[0]!.dimensions.total_tokens.consumed).toBe(0); expect(resolveBudgetPolicy(input).can_admit).toBe(true);
    const result = resolveBudgetPolicy({ ...input, constraints: [{ ...constraint({ total_tokens: 80 }), availability: availability({ total_tokens: { status: "unavailable" } }) }] }); expect(result.can_admit).toBe(false); expect(result.dimensions.total_tokens.limiting_sources).toEqual(["existing:worker-policy"]);
  });
  it("does not transfer historical objective usage when the project's primary changes", () => {
    const usage = ledger(), snapshot = organization(); snapshot.project_objectives["project-1"]!.primary_objective_id = "secondary";
    const selected = resolveTaskBudgetAttribution(taskInput(snapshot));
    const result = resolveBudgetPolicy({ ...previewInput(), attribution: selected, ledger: usage, source: source([rule("company-policy", undefined, { total_tokens: 100 }), rule("new-objective", { kind: "objective", id: "secondary" }, { total_tokens: 100 }), rule("old-objective", { kind: "objective", id: "child" }, { total_tokens: 0 })]) });
    expect(result.sources.find((entry) => entry.id === "policy:new-objective")!.dimensions.total_tokens.proven_consumed).toBe(0); expect(result.sources.find((entry) => entry.id === "policy:company-policy")!.dimensions.total_tokens.proven_consumed).toBe(20); expect(result.policy_bindings.some((entry) => entry.policy_id === "old-objective")).toBe(false); expect(usage.subjects["subject-1"]!.attribution.objective_ids).toEqual(["child", "root"]);
  });
  it.each(["utc-day", "utc-month"] as const)("attributes completed usage to its original %s bucket, not completion time", (period) => {
    const usage = ledger(); usage.updated_at = "2026-11-01T00:00:00Z"; usage.reservations["reservation-1"]!.updated_at = usage.updated_at; usage.charges["charge-1"]!.updated_at = usage.updated_at;
    const configured = source([rule("company-policy", undefined, { total_tokens: 100 }, period)]);
    const original = resolveBudgetPolicy({ ...previewInput(), source: configured, ledger: usage }); const rolled = resolveBudgetPolicy({ ...previewInput(), source: configured, ledger: usage, at: usage.updated_at });
    expect(original.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(20); expect(rolled.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(0); expect(rolled.dimensions.total_tokens.remaining).toBe(100); expect(rolled.policy_bindings[0]!.bucket).toBe(period === "utc-day" ? "2026-11-01" : "2026-11");
  });
  it.each(["pending", "committed", "active", "unknown"] as const)("retains %s holds and concurrency across rollover without settlement or mutation", (status) => {
    const usage = heldLedger(status), before = JSON.stringify(usage); assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100, concurrent_reads: 1 }, "utc-day")]), ledger: usage, at: "2026-11-01T00:00:00Z" });
    expect(result.sources[0]!.dimensions.total_tokens.reserved).toBe(50); expect(result.sources[0]!.dimensions.concurrent_reads.reserved).toBe(1); expect(result.can_admit).toBe(false); expect(JSON.stringify(usage)).toBe(before);
    expect(result.dimensions.concurrent_reads.status).toBe(status === "unknown" ? "unavailable" : "exhausted");
  });
  it("keeps unknown final receipts unavailable even after their original period expired", () => {
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: unknownLedger(17), at: "2026-11-01T00:00:00Z", source: source([rule("company-policy", undefined, { total_tokens: 100 }, "utc-month")]) });
    expect(result.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(0); expect(result.sources[0]!.dimensions.total_tokens.consumed).toBeNull(); expect(result.dimensions.total_tokens.status).toBe("unavailable");
  });
  it("counts measured occurrence resources once and exactly zero model resources", () => {
    const usage = ledger(); usage.subjects["subject-1"] = { id: "subject-1", kind: "occurrence", occurrence_id: "occurrence-1", routine_id: "routine-1", routine_revision: 1, slot: at, project_ids: [], attribution: attribution({ project_ids: [], objective_ids: [], role_id: null, issue_id: null, execution_id: "occurrence-1" }) }; usage.admission_intents["intent-1"]!.admission_id = null; usage.charges["charge-1"]!.observed_total_tokens = 0; usage.charges["charge-1"]!.runtime_ms = 60001; assertBudgetLedger(usage);
    const result = resolveBudgetPolicy({ ...previewInput(), ledger: usage }); expect(result.sources[0]!.dimensions.attempts.proven_consumed).toBe(1); expect(result.sources[0]!.dimensions.runtime_ms.proven_consumed).toBe(60001); expect(result.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(0); expect(result.sources[0]!.dimensions.review_attempts.proven_consumed).toBe(0); expect(result.sources[0]!.dimensions.corrections.proven_consumed).toBe(0);
  });
  it("refuses aggregate overflow instead of wrapping or clipping actual charges", () => {
    const usage = ledger(); usage.charges["charge-1"]!.runtime_ms = Number.MAX_SAFE_INTEGER; addSecondSubject(usage); assertBudgetLedger(usage); rejectUnchanged({ ...previewInput(), ledger: usage }, resolveBudgetPolicy);
  });
});

describe("T002 immutable bindings, strict inputs and absence of effects", () => {
  it("excludes mutable ledger balances and availability from the immutable fingerprint", () => {
    const existing = constraint({ total_tokens: 80 }), input = { ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100 })]), constraints: [existing] }, original = resolveBudgetPolicy(input);
    const reserved = resolveBudgetPolicy({ ...input, ledger: heldLedger() }); const consumed = resolveBudgetPolicy({ ...input, ledger: ledger(), constraints: [{ ...existing, availability: availability({ total_tokens: { status: "known", remaining: 5 } }) }] });
    expect(reserved.cap_fingerprint).toBe(original.cap_fingerprint); expect(consumed.cap_fingerprint).toBe(original.cap_fingerprint); expect(consumed.ceilings).toEqual(original.ceilings); expect(consumed.dimensions.total_tokens.remaining).toBe(5); expect(reserved.dimensions.total_tokens.remaining).toBe(50);
  });
  it("excludes retained correction receipts/lineage resolution from static policy bindings", () => {
    const usage = ledger(); usage.charges["charge-1"]!.correction = true; (usage.subjects["subject-1"]! as BudgetTaskSubject).workflow = { workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, grant_id: "grant-1" };
    const input = { ...previewInput(), ledger: usage, base_caps: { ...baseCaps(), corrections: 1 }, source: source([rule("company-policy", undefined, { corrections: 1 })]) };
    const unavailable = resolveBudgetPolicy(input), known = resolveBudgetPolicy({ ...input, correction_lineages: [correctionLineage()] });
    expect(unavailable.cap_fingerprint).toBe(known.cap_fingerprint); expect(unavailable.dimensions.corrections.status).toBe("unavailable"); expect(known.dimensions.corrections.status).toBe("exhausted");
  });
  it.each(["source", "policy", "rule", "base", "attribution", "constraint", "bucket"])("changes the binding for changed static %s authority", (kind) => {
    const input = { ...previewInput(), source: source([rule("company-policy", undefined, { total_tokens: 100 }, "utc-day")]), constraints: [constraint({ total_tokens: 80 })] }, before = resolveBudgetPolicy(input).cap_fingerprint;
    if (kind === "source") input.source.fingerprint = "b".repeat(64);
    if (kind === "policy") { input.source.policy.revision++; input.source.fingerprint = "b".repeat(64); }
    if (kind === "rule") input.source.policy.rules[0]!.revision++;
    if (kind === "base") input.base_caps.total_tokens--;
    if (kind === "attribution") input.attribution.objective_ids = ["secondary"];
    if (kind === "constraint") input.constraints[0]!.revision++;
    if (kind === "bucket") input.at = "2026-10-06T00:00:00Z";
    expect(resolveBudgetPolicy(input).cap_fingerprint).not.toBe(before);
  });
  it("is deterministic under rule, constraint, map and project-set permutations without editing inputs", () => {
    const usage = ledger(); addSecondSubject(usage); const input = { ...previewInput(), attribution: attribution({ project_ids: ["project-1", "project-2"] }), ledger: usage, source: source([rule(), rule("other-rule", { kind: "project", id: "project-1" }, { total_tokens: 90 })]), constraints: [constraint({ total_tokens: 80 }), { ...constraint({ runtime_ms: 900 }), id: "role-limit", kind: "role" as const }] };
    const before = JSON.stringify(input), result = resolveBudgetPolicy(input); expect(JSON.stringify(input)).toBe(before);
    const permutation = structuredClone(input); permutation.source.policy.rules.reverse(); permutation.constraints.reverse(); permutation.attribution.project_ids.reverse(); for (const key of ["subjects", "charges", "reservations", "admission_intents"] as const) permutation.ledger[key] = Object.fromEntries(Object.entries(permutation.ledger[key]).reverse()) as never;
    expect(resolveBudgetPolicy(permutation)).toEqual(result); expect(frozenTree(result)).toBe(true);
  });
  it.each([undefined, null, {}, "100", Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects missing/malformed/nonfinite base dimension %j without coercion or defaults", (bad) => {
    const input = previewInput() as unknown as { base_caps: Record<string, unknown> }; if (bad === undefined) delete input.base_caps.total_tokens; else input.base_caps.total_tokens = bad;
    rejectUnchanged(input, resolveBudgetPolicy);
  });
  it.each(["extra-field", "missing-base", "malformed-source", "future-policy", "fake-exclusion", "duplicate-constraint", "constraints-null", "lineages-null", "partial-availability", "availability-over-cap", "ledger-null", "currency-string"])("rejects resolution contradiction: %s", (kind) => {
    const input: Record<string, unknown> = previewInput();
    if (kind === "extra-field") input.roles = ["engineer"];
    if (kind === "missing-base") delete input.base_caps;
    if (kind === "malformed-source") input.source = { ...source(), fingerprint: "UPPER" };
    if (kind === "future-policy") input.source = { ...source(), policy: { ...policy(), schema_version: 2 } };
    if (kind === "fake-exclusion") input.exclude_reservation_id = "reservation-1";
    if (kind === "duplicate-constraint") input.constraints = [constraint(), constraint()];
    if (kind === "constraints-null") input.constraints = null;
    if (kind === "lineages-null") input.correction_lineages = null;
    if (kind === "partial-availability") input.constraints = [{ ...constraint(), availability: { total_tokens: { status: "known", remaining: 1 } } }];
    if (kind === "availability-over-cap") input.constraints = [{ ...constraint({ total_tokens: 5 }), availability: availability({ total_tokens: { status: "known", remaining: 6 } }) }];
    if (kind === "ledger-null") input.ledger = null;
    if (kind === "currency-string") input.require_currency = "true";
    rejectUnchanged(input, resolveBudgetPolicy);
  });
  it("rejects applicable binding overflow without dropping constraints", () => {
    const rules = Array.from({ length: 65 }, (_, index) => rule(`company-${index}`)); rejectUnchanged({ ...previewInput(), source: source(rules) }, resolveBudgetPolicy);
  });
  it("rejects an existing source ID that would impersonate baseline cap provenance", () => {
    rejectUnchanged({ ...previewInput(), constraints: [{ ...constraint(), id: "base" }] }, resolveBudgetPolicy);
  });
  it("rejects a sparse member array whose out-of-range key compensates the missing own index", () => {
    const projects = Array(1) as string[]; Object.defineProperty(projects, "4294967295", { enumerable: true, value: "project-1" });
    expect(() => resolveBudgetPolicy({ ...previewInput(), attribution: attribution({ project_ids: projects }) })).toThrow(BudgetContractError);
    expect(() => resolveOccurrenceBudgetAttribution({ ...occurrenceInput(), project_ids: projects })).toThrow(BudgetContractError); expect(Object.hasOwn(projects, "0")).toBe(false); expect(projects.length).toBe(1);
  });
  it.each(["root-getter", "nested-getter", "proxy", "toJSON", "inherited", "symbol", "hidden"])("rejects hooked/non-plain input without executing %s", (kind) => {
    const hook = vi.fn(() => source()), input = previewInput(); let value: unknown = input;
    if (kind === "root-getter") Object.defineProperty(input, "source", { enumerable: true, get: hook });
    if (kind === "nested-getter") Object.defineProperty(input.source, "policy", { enumerable: true, get: hook });
    if (kind === "proxy") value = new Proxy(input, { ownKeys: hook as never });
    if (kind === "toJSON") Object.assign(input, { toJSON: hook });
    if (kind === "inherited") value = Object.create(input);
    if (kind === "symbol") Object.defineProperty(input, Symbol("caller"), { enumerable: true, value: 1 });
    if (kind === "hidden") Object.defineProperty(input, "caller", { enumerable: false, value: 1 });
    expect(() => resolveBudgetPolicy(value as never)).toThrow(BudgetContractError); expect(hook).not.toHaveBeenCalled();
  });
});

describe("T002 fixed neutral policy reader", () => {
  it("reads the tracked neutral registry without introducing aggregate caps, pricing or state writes", () => {
    const bytes = readFileSync(new URL("../../registry/budget-policy.yml", import.meta.url)), fixture = writePolicyFixture(bytes.toString("utf8")), before = readdirSync(fixture.root), result = readBudgetPolicy(fixture.root);
    expect(result.fingerprint).toBe(createHash("sha256").update(bytes).digest("hex")); expect(result.policy.rules).toHaveLength(1); expect(result.policy.rules[0]!.warning_percent).toBe(80); expect(result.policy.rules[0]!.period).toBe("none"); expect(Object.values(result.policy.rules[0]!.limits).every((entry) => entry.status === "unconfigured")).toBe(true); expect(frozenTree(result)).toBe(true); expect(readFileSync(fixture.path)).toEqual(bytes); expect(readdirSync(fixture.root)).toEqual(before); expect(existsSync(join(fixture.root, "state"))).toBe(false);
  });
  it("fingerprints exact source bytes including comments, not an invented normalized policy", () => {
    const first = writePolicyFixture(`${JSON.stringify(policy())}\n`), second = writePolicyFixture(`# Synthetic comment\n${JSON.stringify(policy())}\n`); const left = readBudgetPolicy(first.root), right = readBudgetPolicy(second.root);
    expect(left.policy).toEqual(right.policy); expect(left.fingerprint).not.toBe(right.fingerprint); expect(readBudgetPolicy(first.root)).toEqual(left);
  });
  it("rejects an otherwise valid unknown YAML tag without emitting configuration comments", () => {
    const marker = "SYNTHETIC_PRIVATE_MARKER", neutral = readFileSync(new URL("../../registry/budget-policy.yml", import.meta.url), "utf8");
    expect(neutral).toContain("id: surtec-default");
    const fixture = writePolicyFixture(neutral.replace("id: surtec-default", `id: !custom surtec-default # ${marker}`)), before = readFileSync(fixture.path);
    const emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {}), warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    let error: unknown; try { readBudgetPolicy(fixture.root); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(BudgetContractError); expect((error as Error).message).not.toContain(marker); expect((error as Error).message).not.toContain("!custom"); expect(emitted).not.toHaveBeenCalled(); expect(warned).not.toHaveBeenCalled(); expect(readFileSync(fixture.path).equals(before)).toBe(true);
  });
  it("rejects two complete valid YAML documents instead of accepting a first-document fallback", () => {
    const neutral = readFileSync(new URL("../../registry/budget-policy.yml", import.meta.url), "utf8"), fixture = writePolicyFixture(`${neutral}\n---\n${neutral}`), before = readFileSync(fixture.path);
    expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path).equals(before)).toBe(true);
  });
  it("rejects an otherwise valid scalar alias without repairing or normalizing the source", () => {
    const neutral = readFileSync(new URL("../../registry/budget-policy.yml", import.meta.url), "utf8"), aliased = neutral.replace("schema_version: 1", "schema_version: &version 1").replace("revision: 1", "revision: *version"), fixture = writePolicyFixture(aliased), before = readFileSync(fixture.path);
    expect(aliased).toContain("schema_version: &version 1"); expect(aliased).toContain("revision: *version"); expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path).equals(before)).toBe(true);
  });
  it("refuses absent required registry rather than fabricating or persisting a default", () => {
    const root = temporaryRoot(); expect(() => readBudgetPolicy(root)).toThrow(BudgetContractError); expect(readdirSync(root)).toEqual([]); mkdirSync(join(root, "registry")); expect(() => readBudgetPolicy(root)).toThrow(BudgetContractError); expect(readdirSync(join(root, "registry"))).toEqual([]);
  });
  it.each(["{", "null", "[]", JSON.stringify({ ...policy(), schema_version: 2 }), "schema_version: 1\nschema_version: 1\n", "schema_version: &version 1\nrevision: *version\n"])("preserves rejected malformed/future/duplicate/alias source bytes %j", (bytes) => {
    const fixture = writePolicyFixture(bytes), before = readFileSync(fixture.path); expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path)).toEqual(before); expect(readdirSync(join(fixture.root, "registry"))).toEqual(["budget-policy.yml"]);
  });
  it("rejects invalid UTF-8 and an oversized document while preserving their exact bytes", () => {
    const fixture = writePolicyFixture(); const invalid = Buffer.from([0xff, 0xfe, 0x80]); writeFileSync(fixture.path, invalid); expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path).equals(invalid)).toBe(true);
    const oversized = Buffer.alloc(BUDGET_LIMITS.documentBytes + 1, 32); writeFileSync(fixture.path, oversized); expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path).equals(oversized)).toBe(true);
  });
  it("refuses a directory at the policy filename without creating a file", () => {
    const root = temporaryRoot(); mkdirSync(join(root, "registry", "budget-policy.yml"), { recursive: true }); expect(() => readBudgetPolicy(root)).toThrow(BudgetContractError); expect(readdirSync(join(root, "registry", "budget-policy.yml"))).toEqual([]);
  });
  it("rejects a hard-linked policy using only files in the owned temporary boundary", () => {
    const fixture = writePolicyFixture(); linkSync(fixture.path, join(fixture.root, "duplicate.yml")); const before = readFileSync(fixture.path); expect(() => readBudgetPolicy(fixture.root)).toThrow(BudgetContractError); expect(readFileSync(fixture.path)).toEqual(before);
  });
  it.each(["registry", "ancestor"])("refuses linked %s configuration without reading or writing an external boundary", (kind) => {
    const root = temporaryRoot(), target = writePolicyFixture(JSON.stringify(policy()));
    if (kind === "registry") symlinkSync(join(target.root, "registry"), join(root, "registry"), "junction"); else symlinkSync(target.root, join(root, "alias"), "junction");
    const before = readFileSync(target.path); expect(() => readBudgetPolicy(kind === "registry" ? root : join(root, "alias"))).toThrow(BudgetContractError); expect(readFileSync(target.path)).toEqual(before); expect(existsSync(join(target.root, "state"))).toBe(false);
  });
});
