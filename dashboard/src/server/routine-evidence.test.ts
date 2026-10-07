import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutineEvidenceReader, RoutineEvidenceError } from "./routine-evidence";
import { BUDGET_DIMENSIONS, type BudgetLimits, type BudgetOccurrenceSubject, type BudgetPolicyBinding } from "../../../lib/budgets/types";
import { budgetOccurrenceIntentId } from "../../../lib/budgets/reservations";
import { createRoutineDraft } from "../../../lib/routines/validation";
import { routineSlotKey } from "../../../lib/routines/schedule";
import type { RoutineAction, RoutineOccurrence } from "../../../lib/routines/types";
import { RoutineActionError, routineSignalFingerprint } from "../../../lib/routines/actions";
import type { PolicyProject } from "../../../lib/policy/service";
import type { ProjectIntegrationsSnapshot } from "../../../lib/integrations/types";
import { emptyProjectProfile } from "../../../lib/portfolio-profile";
import { inspectHarness } from "../../../lib/harness/inspect";

const at = "2026-10-07T12:00:00.000Z", old = "2026-08-01T12:00:00.000Z", digest = "a".repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-routine-evidence-")); roots.push(root);
  const state = join(root, "state"); mkdirSync(state); return { root, state };
}
function write(state: string, path: string, value: unknown): string {
  const target = join(state, path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return target;
}
function project(id = "alpha"): PolicyProject {
  return { id, status: "active", repo: null, repo_path: null, default_branch: "main", allowed_agents: [], sandbox: "read-only",
    commands: {}, verify_commands: [], approval: { before_merge: true, before_deploy: true }, deploy_url: null, railway: null };
}
function occurrence(action: RoutineAction = "evaluate-signals"): RoutineOccurrence {
  const definition = { ...createRoutineDraft({ id: "routine-one", action, scope: { kind: "project", id: "alpha" },
    policy: { revision: 1, fingerprint: digest, policy_ids: ["policy-one"] }, at }), enabled: true };
  const binding: BudgetPolicyBinding = { policy_id: "policy-one", policy_revision: 1, policy_fingerprint: digest,
    scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none",
    limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits };
  const value: RoutineOccurrence = { schema_version: 1, id: "occurrence-one", revision: 1, routine_id: definition.id, routine_revision: 1,
    occurrence_key: routineSlotKey(definition.id, 1, at), definition, slot: at, trigger: "manual", project_ids: ["alpha"],
    attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: null, execution_id: "occurrence-one" },
    budget: { subject_id: "subject-one", reservation_id: "reservation-one", intent_id: "temporary", cap_fingerprint: digest,
      admitted_runtime_ms: 60000, policy_bindings: [binding] }, status: "reserved", owner: null, started_at: null, finished_at: null,
    cancel_requested_at: null, receipt: null, created_at: at, updated_at: at };
  rebind(value); return value;
}
function rebind(value: RoutineOccurrence): void {
  const subject: BudgetOccurrenceSubject = { id: value.budget.subject_id, kind: "occurrence", occurrence_id: value.id,
    routine_id: value.routine_id, routine_revision: value.routine_revision, slot: value.slot, project_ids: value.project_ids, attribution: value.attribution };
  value.budget.intent_id = budgetOccurrenceIntentId({ subject, reservation_id: value.budget.reservation_id,
    policy_bindings: value.budget.policy_bindings, cap_fingerprint: digest, runtime_ms: 60000, created_at: at });
}
function organization(review: string | null = at) {
  return { schema_version: 1, company: { schema_version: 1, id: "surtec", display_name: "SURTEC", mission: "private-mission",
    operating_principles: ["private-principle"], active_objective_ids: ["objective-one"], last_reviewed_at: review?.slice(0, 10) ?? null },
    objectives: { "objective-one": { schema_version: 1, id: "objective-one", company_id: "surtec", title: "private-title",
      desired_outcome: "private-outcome", success_criteria: ["private-criterion"], status: "active", horizon: "now", priority: 1,
      target_date: null, parent_objective_id: null, owner: "marcos", last_reviewed_at: review?.slice(0, 10) ?? null } },
    project_objectives: { alpha: { objective_ids: ["objective-one"], primary_objective_id: "objective-one" } } };
}
function integration(): ProjectIntegrationsSnapshot {
  return { schema_version: 2, project_id: "alpha", observed_at: at, trace_id: null,
    source_control: { provider: "git", configured: true, health: "ok", branch: "private-branch", dirty: true, uncommitted: 1, ahead: 0, behind: 0,
      remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
    ci: { provider: "github-actions", configured: true, health: "down", status: "failing", branch: "private-branch" },
    dependencies: { provider: "npm", configured: true, health: "ok", outdated: 0, observed_at: at },
    deployments: ["http-health", "railway"].map((provider) => ({ provider: provider as "http-health" | "railway", configured: true, health: "ok",
      status: "ready", observed_at: at, url: "https://example.com/private", http_status: 200, latency_ms: null, deployed_at: null })) };
}
function harness(root: string, review = at) {
  return { ...inspectHarness(root, "alpha", { status: "unknown", manifest: null, registry: null, fingerprint: null, reason: "fixture" }), observed_at: review };
}
function session(time = at) {
  return { schema_version: 1, id: "session-one", project_id: "alpha", objective: "private-objective", status: "paused", branch: "private-branch",
    started_at: time, paused_at: time, completed_at: null, related_task_ids: [], related_run_ids: [], notes: ["private-note"],
    result_summary: null, next_action: "private-next-action", focused_ms: 0, active_since: null };
}
function issue(time = at) {
  return { schema_version: 1, id: "I-00000000-0000-4000-8000-000000000001", project_id: "alpha", objective_id: null, parent_issue_id: null, title: "private-issue-title",
    expected_outcome: "private-issue-outcome", acceptance_criteria: ["private-criterion"], status: "proposed", work_scale: "bounded",
    classification_inputs: { affected_domains: [], requires_migration: false, security_impact: false }, classification_rationale: [], plan: [],
    authorized_scope: { expected_outcome: "private-scope", acceptance_criteria: ["private-criterion"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [],
      allowed_change_categories: ["test"], explicit_exclusions: [] }, scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null,
    scope_change_proposal: null, priority: 3, criticality: "medium", blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [],
    external_references: [], next_action: "private-next-action", task_ids: [], evidence_ids: [], candidate_ids: [], created_at: time, updated_at: time, revision: 1 };
}
function reader(root: string, state: string, overrides: Parameters<typeof createRoutineEvidenceReader>[1] = {}) {
  return createRoutineEvidenceReader(root, { stateRoot: state, policy: { listProjects: () => [project()], project: () => project() },
    integrations: { read: vi.fn(async () => integration()) }, clock: () => new Date(at), ...overrides });
}
const options = (check: () => void = vi.fn(), signal = new AbortController().signal) => ({ check, signal, deadline_at: "2026-10-07T12:01:00.000Z" });

describe("T010 validated routine facts and pure signal projections", () => {
  it("reads current state without mutation and excludes private text/notes/provider payloads", async () => {
    const { root, state } = fixture();
    write(state, "organization/organization.json", organization());
    write(state, "portfolio/projects.json", { schema_version: 2, projects: { alpha: { ...emptyProjectProfile("alpha"), current_goal: "private-goal",
      next_action: "private-profile-next", last_reviewed_at: at.slice(0, 10) } } });
    write(state, "issues/issues.json", { schema_version: 1, issues: { [issue().id]: issue() }, candidates: {}, evidence: {}, events: [] });
    write(state, "sessions/work-sessions.json", { schema_version: 1, sessions: [session()] });
    write(state, "harness/profiles.json", { schema_version: 1, profiles: { alpha: harness(root) } });
    write(state, "notes/alpha.json", "not-json-and-private-note"); write(state, "tasks/corrupt.json", "not-json-and-private-task");
    const before = readdirSync(state, { recursive: true }).map(String).sort(); const value = await reader(root, state)(occurrence(), options());
    expect(value.sources).toHaveLength(11); expect(value.sources.every((fact) => fact.state === "fresh")).toBe(true);
    expect(value.signals.some((signal) => signal.source === "ci")).toBe(true); expect(value.signals.some((signal) => signal.source === "session")).toBe(true);
    for (const signal of value.signals) { const { fingerprint, ...projection } = signal; expect(fingerprint).toBe(routineSignalFingerprint(projection)); }
    expect(readdirSync(state, { recursive: true }).map(String).sort()).toEqual(before);
    const text = JSON.stringify(value);
    for (const privateValue of ["private-mission", "private-principle", "private-title", "private-outcome", "private-criterion", "private-goal", "private-note", "private-task", "private-branch", "private-next-action", "private-issue-title", "private-scope", "https://"]) expect(text).not.toContain(privateValue);
  });
  it("preserves explicit absent source provenance without creating state or false activity signals", async () => {
    const { root, state } = fixture(); const value = await reader(root, state)(occurrence(), options());
    expect(value.sources.filter((fact) => ["organization", "issues", "sessions", "harness"].includes(fact.kind)).every((fact) => fact.state === "unavailable")).toBe(true);
    expect(value.signals.filter((signal) => signal.source === "profile")).toEqual([]); expect(readdirSync(state)).toEqual([]);
  });
  it("does not claim a signals refresh when only refreshing evidence", async () => {
    const { root, state } = fixture(); const value = await reader(root, state)(occurrence("refresh-evidence"), options());
    expect(value.signals).toEqual([]); expect(value.sources.some((fact) => fact.kind === "signals")).toBe(false);
  });
  it("preserves valid v1 profiles with visible unavailable migration evidence and no backup/lock", async () => {
    const { root, state } = fixture(); const raw = JSON.stringify({ schema_version: 1, projects: { alpha: { ...emptyProjectProfile("alpha"), schema_version: 1 } } });
    const path = write(state, "portfolio/projects.json", raw); const value = await reader(root, state)(occurrence(), options());
    expect(value.sources.find((fact) => fact.kind === "organization" && fact.project_id === "alpha")?.state).toBe("unavailable");
    expect(value.signals.some((signal) => signal.source === "profile")).toBe(false); expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(state)).toEqual(["portfolio"]);
  });
  it("keeps historical review/issue/session/Harness times stale instead of washing them with read time", async () => {
    const { root, state } = fixture(); write(state, "organization/organization.json", organization(old));
    write(state, "portfolio/projects.json", { schema_version: 2, projects: { alpha: { ...emptyProjectProfile("alpha"), last_reviewed_at: old.slice(0, 10) } } });
    write(state, "issues/issues.json", { schema_version: 1, issues: { [issue().id]: issue(old) }, candidates: {}, evidence: {}, events: [] });
    write(state, "sessions/work-sessions.json", { schema_version: 1, sessions: [session(old)] });
    write(state, "harness/profiles.json", { schema_version: 1, profiles: { alpha: harness(root, old) } });
    const value = await reader(root, state)(occurrence(), options());
    for (const kind of ["organization", "issues", "sessions", "harness"]) {
      const facts = value.sources.filter((fact) => fact.kind === kind); expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((fact) => fact.state === "stale" && fact.observed_at === (kind === "organization" ? "2026-08-01T00:00:00.000Z" : old))).toBe(true);
    }
  });
  it.each(["organization/organization.json", "issues/issues.json", "sessions/work-sessions.json", "harness/profiles.json", "portfolio/projects.json"])(
    "preserves malformed required snapshot %s and performs zero provider reads", async (path) => {
      const { root, state } = fixture(); const raw = '{"schema_version":1,"private":"do-not-print"}'; const target = write(state, path, raw);
      const read = vi.fn(async () => integration());
      await expect(reader(root, state, { integrations: { read } })(occurrence(), options())).rejects.toMatchObject({ code: "state-invalid" });
      expect(read).not.toHaveBeenCalled(); expect(readFileSync(target, "utf8")).toBe(raw);
    });
  it.each(["organization/organization.json", "issues/issues.json", "sessions/work-sessions.json", "harness/profiles.json", "portfolio/projects.json"])(
    "preserves unknown future snapshot %s and performs zero provider reads", async (path) => {
      const { root, state } = fixture(); const raw = '{"schema_version":999}'; const target = write(state, path, raw); const read = vi.fn();
      await expect(reader(root, state, { integrations: { read } })(occurrence(), options())).rejects.toThrow();
      expect(read).not.toHaveBeenCalled(); expect(readFileSync(target, "utf8")).toBe(raw);
    });
  it("refuses inherited non-existing objective parent IDs before provider effects", async () => {
    const { root, state } = fixture(); const value = organization(); value.objectives["objective-one"].parent_objective_id = "constructor" as never;
    const path = write(state, "organization/organization.json", value); const before = readFileSync(path); const read = vi.fn();
    await expect(reader(root, state, { integrations: { read } })(occurrence(), options())).rejects.toThrow(RoutineEvidenceError);
    expect(read).not.toHaveBeenCalled(); expect(readFileSync(path).equals(before)).toBe(true);
  });
  it.each(["utf8", "oversize"])("rejects %s snapshots before providers", async (invalid) => {
    const { root, state } = fixture(); const bytes = invalid === "utf8" ? Buffer.from([0xff]) : Buffer.alloc(16 * 1024 * 1024 + 1, 32);
    const path = write(state, "organization/organization.json", bytes); const read = vi.fn();
    await expect(reader(root, state, { integrations: { read } })(occurrence(), options())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(readFileSync(path).equals(bytes)).toBe(true);
  });
  it("rejects hard-linked source bytes and ancestor junctions without mutating their targets", async () => {
    const { root, state } = fixture(); const path = write(state, "organization/organization.json", organization());
    const alias = join(root, "alias.json"); linkSync(path, alias); const read = vi.fn();
    await expect(reader(root, state, { integrations: { read } })(occurrence(), options())).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
    const junction = join(root, "linked-state"); symlinkSync(state, junction, "junction");
    await expect(reader(root, junction, { integrations: { read } })(occurrence(), options())).rejects.toThrow(); expect(existsSync(path)).toBe(true);
  });
  it("checks cancellation, deadline and private current gates before source access", async () => {
    const { root, state } = fixture(); const read = vi.fn(); const load = reader(root, state, { integrations: { read } });
    const controller = new AbortController(); controller.abort();
    await expect(load(occurrence(), options(vi.fn(), controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    await expect(load(occurrence(), { ...options(), deadline_at: at })).rejects.toMatchObject({ code: "deadline-exceeded" });
    await expect(load(occurrence(), options(() => { throw new RoutineActionError("ownership-unavailable"); }))).rejects.toMatchObject({ code: "ownership-unavailable" });
    expect(read).not.toHaveBeenCalled(); expect(readdirSync(state)).toEqual([]);
  });
  it("refuses a changed company selection after an asynchronous provider read", async () => {
    const { root, state } = fixture(); const projects = [project()]; const value = occurrence(); value.definition.scope = { kind: "company", id: "surtec" };
    const read = vi.fn(async () => { projects.push(project("beta")); return integration(); });
    await expect(reader(root, state, { policy: { listProjects: () => projects, project: () => projects[0]! }, integrations: { read } })(value, options()))
      .rejects.toMatchObject({ code: "state-invalid" }); expect(read).toHaveBeenCalledOnce();
  });
  it("refuses an oversized company scope before any provider effects", async () => {
    const { root, state } = fixture(); const value = occurrence(); value.definition.scope = { kind: "company", id: "surtec" };
    const read = vi.fn(); const projects = Array.from({ length: 26 }, (_, index) => project(`project-${index}`));
    await expect(reader(root, state, { policy: { listProjects: () => projects, project: () => projects[0]! }, integrations: { read } })(value, options()))
      .rejects.toMatchObject({ code: "scope-too-large" }); expect(read).not.toHaveBeenCalled();
  });
  it("refuses changed objective links rather than returning foreign/fresh scope evidence", async () => {
    const { root, state } = fixture(); const value = occurrence(); value.definition.scope = { kind: "objective", id: "objective-one" };
    value.attribution.objective_ids = ["objective-one"]; rebind(value); write(state, "organization/organization.json", organization());
    const read = vi.fn(async () => { const changed = organization(); changed.project_objectives = {} as never; write(state, "organization/organization.json", changed); return integration(); });
    await expect(reader(root, state, { integrations: { read } })(value, options())).rejects.toMatchObject({ code: "state-invalid" });
  });
});
