import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertOperatingView, OPERATING_SECTIONS, type OperatingSourceInput } from "../../../lib/operating-views";
import { readOrganizationDocument } from "../../../lib/state/organization";
import { emptyProjectProfile } from "../../../lib/portfolio-profile";
import * as profiles from "../../../lib/state/portfolio-profiles";
import type { WorkIssue } from "../../../lib/issues/types";
import { createOperatingViewService, OperatingRequestError, type OperatingViewDependencies } from "./operating-view-service";

const NOW = "2026-10-16T12:00:00.000Z", OBSERVED = "2026-10-15T12:00:00.000Z";
const ISSUE = "I-00000000-0000-4000-8000-000000000001";
let root: string, state: string, projects: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-q-read-service-")); state = join(root, "state"); projects = join(root, "projects"); });
afterEach(() => {
  vi.restoreAllMocks();
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^surtec-q-read-service-/);
  expect(lstatSync(root).isSymbolicLink()).toBe(false); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
});
function write(path: string, value: unknown) { const file = join(state, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }
function service(options: OperatingViewDependencies = {}) { return createOperatingViewService(root, { stateRoot: state, projectsRoot: projects, clock: () => new Date(NOW), ...options }); }
function capture(directory = root): Record<string, string> {
  if (!existsSync(directory)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) { out[path] = "link"; continue; }
    if (entry.isDirectory()) { out[path] = "directory"; Object.assign(out, capture(path)); }
    else out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}
const source = (items: OperatingSourceInput["items"] = []): OperatingSourceInput => ({ availability: "available", reason: "observed", origin: "saved", observed_at: OBSERVED, fresh_until: null, complete: true, items });
function issue(): WorkIssue {
  return { schema_version: 1, id: ISSUE, project_id: "alpha", objective_id: "objective-a", parent_issue_id: null,
    title: "Public issue", expected_outcome: "Private detailed context is not copied", acceptance_criteria: ["Observable result"], status: "working", work_scale: "bounded",
    classification_inputs: { affected_domains: ["api"], requires_migration: false, security_impact: false }, classification_rationale: [], plan: [],
    authorized_scope: { expected_outcome: "An outcome", acceptance_criteria: ["A result"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] },
    scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 3, criticality: "low", blocked_by_issue_ids: [],
    assigned_role_id: "backend-engineer", related_commitment_ids: [], external_references: [], next_action: "private-next-action", task_ids: ["TASK-1"], evidence_ids: [], candidate_ids: [], created_at: OBSERVED, updated_at: OBSERVED, revision: 1 };
}
function healthy() {
  mkdirSync(join(projects, "alpha", ".git"), { recursive: true });
  const organization = readOrganizationDocument(join(root, "absent-organization.json"));
  organization.company.mission = "Build useful tools"; organization.company.last_reviewed_at = "2026-10-15";
  organization.company.active_objective_ids = ["objective-a"];
  organization.objectives["objective-a"] = { schema_version: 1, id: "objective-a", company_id: "surtec", title: "Public objective", desired_outcome: "Useful outcome",
    success_criteria: ["Observable result"], status: "active", horizon: "quarter", priority: 3, target_date: null, parent_objective_id: null, owner: "marcos", last_reviewed_at: "2026-10-15" };
  organization.project_objectives.alpha = { objective_ids: ["objective-a"], primary_objective_id: "objective-a" };
  write("organization/organization.json", organization);
  write("portfolio/projects.json", { schema_version: 2, projects: { alpha: { ...emptyProjectProfile("alpha"), last_reviewed_at: "2026-10-15" } } });
  const record = issue(); write("issues/issues.json", { schema_version: 1, issues: { [record.id]: record }, candidates: {}, evidence: {}, events: [] });
  write("tasks/TASK-1.json", { envelope: { id: "TASK-1", source: "cli", project: "alpha", task_type: "bugfix", agent: "backend-engineer", title: "Public task",
    instructions: "fixture-private-instructions", repo_path: "C:\\fixture-private-repository", branch: "agent/TASK-1", sandbox: "read-only", expected_outputs: [], requires_human_approval: true,
    metadata: { issue_id: ISSUE, issue_scope_revision: 1, private_feedback: "fixture-private-feedback" } },
    lifecycle: "finished", outcome: "completed", created_at: OBSERVED, started_at: OBSERVED, updated_at: OBSERVED, finished_at: OBSERVED, result: null, logs_path: "C:\\fixture-private-log" });
  return record;
}

describe("operating read service", () => {
  it("constructs lazily and distinguishes missing optional stores without creating any state", async () => {
    const before = capture(), subject = service();
    expect(capture()).toEqual(before);
    const view = await subject.read({ kind: "overview" });
    expect(view.sections).toHaveLength(11); expect(view.execution_authority).toBe("none");
    expect(view.sections.find((item) => item.kind === "company")).toMatchObject({ source: { availability: "absent" }, total: null });
    expect(view.sections.find((item) => item.kind === "projects")).toMatchObject({ source: { availability: "unavailable", reason: "missing-source" } });
    expect(view.sections.find((item) => item.kind === "signals")).toMatchObject({ source: { reason: "missing-source" } });
    expect(view.sections.find((item) => item.kind === "budgets")).toMatchObject({ source: { availability: "not-enabled", reason: "phase-p-deferred" } });
    expect(capture()).toEqual(before); expect(existsSync(state)).toBe(false);
  });

  it("reuses real validated no-migration snapshots and exact issue/task IDs without leaking private bodies", async () => {
    healthy(); const before = capture();
    const migrate = vi.spyOn(profiles, "listProjectProfilesWithMigration"), legacyRead = vi.spyOn(profiles, "listProjectProfiles");
    const view = await service().read({ kind: "issue", id: ISSUE }); assertOperatingView(view);
    expect(view.focus_status).toBe("available");
    expect(view.sections.find((item) => item.kind === "projects")).toMatchObject({ total: 1, rows: [{ id: "alpha", project_kind: "personal", objective_ids: ["objective-a"] }] });
    expect(view.sections.find((item) => item.kind === "executions")?.rows[0]).toMatchObject({ id: "TASK-1", issue_id: ISSUE, operating_state: null,
      result_status: "completed", lineage: { project_id: "alpha", objective_ids: ["objective-a"], issue_id: ISSUE, requires_authorization: true } });
    const text = JSON.stringify(view);
    for (const privateValue of ["fixture-private", "Private detailed context", "private-next-action", "backend-engineer", "instructions", "repo_path", "logs_path"]) expect(text).not.toContain(privateValue);
    expect(migrate).not.toHaveBeenCalled(); expect(legacyRead).not.toHaveBeenCalled(); expect(capture()).toEqual(before);
  });

  it("retains saved observation time rather than substituting request or filesystem time", async () => {
    healthy(); const subject = service(); const first = await subject.read({ kind: "overview" });
    expect(first.generated_at).toBe(NOW);
    expect(first.sections.find((item) => item.kind === "executions")?.source).toMatchObject({ observed_at: OBSERVED, fresh_until: null, freshness: "unknown" });
    expect(first.sections.find((item) => item.kind === "objectives")?.source.observed_at).toBeNull();
    expect(first.sections.find((item) => item.kind === "objectives")?.rows[0].reviewed_on).toBe("2026-10-15");
    expect(first.sections.find((item) => item.kind === "company")?.rows[0].reviewed_on).toBe("2026-10-15");
    expect(await subject.read({ kind: "overview" })).toEqual(first);
  });

  it("reads saved commitments, sessions and Harness validation without exposing notes or running inspection", async () => {
    healthy();
    write("portfolio/clients.json", { schema_version: 1, clients: { "client-a": { id: "client-a", display_name: "fixture-private-client-name", status: "active",
      criticality: "low", sla_note: "fixture-private-sla", next_review_date: null, confidential_notes: "fixture-private-notes", created_at: OBSERVED, updated_at: OBSERVED } },
      commitments: { "commitment-a": { id: "commitment-a", project_id: "alpha", client_id: "client-a", title: "Public commitment", expected_outcome: "fixture-private-outcome",
        due_date: "2026-12-31", priority: 3, criticality: "low", state: "completed", issue_numbers: [], pull_request_numbers: [], task_ids: [], session_ids: [],
        next_action: "fixture-private-follow-up", created_at: OBSERVED, updated_at: OBSERVED } } });
    write("sessions/work-sessions.json", { schema_version: 1, sessions: [{ schema_version: 1, id: "session-a", project_id: "alpha", objective: "Public session objective", status: "paused",
      branch: "fixture-private-branch", started_at: OBSERVED, paused_at: OBSERVED, completed_at: null, related_task_ids: [], related_run_ids: [], notes: ["fixture-private-session-notes"],
      result_summary: "fixture-private-session-result", next_action: "fixture-private-session-next", focused_ms: 0, active_since: null }] });
    write("harness/profiles.json", { schema_version: 1, profiles: { alpha: { schema_version: 1, project_id: "alpha", status: "healthy", detected_version: null, canonical_version: null,
      comparison: "unknown", capability_results: [], drift_summary: ["fixture-private-drift"], observed_at: OBSERVED, source_fingerprint: null, project_fingerprint: "a".repeat(64),
      doctor_status: "healthy", findings: [], entries: [], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] },
      runner_command: "fixture-private-command", review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: { status: "failed", observed_at: OBSERVED } } } });
    const before = capture(), view = await service().read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "commitments")).toMatchObject({ total: 1, rows: [{ id: "commitment-a", state: "completed", operating_state: null, target_date: "2026-12-31" }] });
    expect(view.sections.find((item) => item.kind === "sessions")).toMatchObject({ total: 1, rows: [{ id: "session-a", state: "paused" }] });
    expect(view.sections.find((item) => item.kind === "harness")).toMatchObject({ total: 1, rows: [{ id: "alpha", state: "healthy", validation_status: "failed", operating_state: null }] });
    expect(JSON.stringify(view)).not.toContain("fixture-private"); expect(capture()).toEqual(before);
  });

  it("does not reuse a stale aggregate across requests or trigger repair after a source changes", async () => {
    healthy(); const subject = service(); expect((await subject.read({ kind: "overview" })).sections.find((item) => item.kind === "issues")?.rows).toHaveLength(1);
    write("issues/issues.json", "{"); const before = capture();
    const view = await subject.read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "issues")).toMatchObject({ rows: [], total: null, source: { availability: "unavailable" } });
    expect(view.sections.find((item) => item.kind === "company")?.rows).toHaveLength(1); expect(capture()).toEqual(before);
  });

  it.each(["organization/organization.json", "portfolio/projects.json", "issues/issues.json", "sessions/work-sessions.json", "workflows/workflows.json", "harness/profiles.json", "portfolio/clients.json"])("preserves malformed/future %s while isolating unaffected sections", async (path) => {
    healthy(); write(path, { schema_version: 999, private_message: "fixture-private-exception" }); const before = capture();
    const view = await service().read({ kind: "overview" });
    expect(view.sections.some((item) => item.source.availability === "unavailable")).toBe(true);
    expect(JSON.stringify(view)).not.toContain("fixture-private-exception"); expect(capture()).toEqual(before);
    expect(view.phase_p).toEqual({ budget_cutover: "not-enabled", continuity: "deferred" });
  });

  it("refuses v1 profile migration and preserves exact legacy bytes without backups or locks", async () => {
    healthy(); const profile = { ...emptyProjectProfile("alpha"), schema_version: 1 };
    const file = write("portfolio/projects.json", { schema_version: 1, projects: { alpha: profile } });
    const before = capture(), bytes = readFileSync(file);
    const view = await service().read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "projects")).toMatchObject({ rows: [], total: null, source: { reason: "invalid-source" } });
    expect(readFileSync(file)).toEqual(bytes); expect(capture()).toEqual(before);
    expect(existsSync(join(state, "backups"))).toBe(false); expect(existsSync(join(state, "locks"))).toBe(false);
  });

  it("does not treat filtered unreadable task files as a complete inventory or log private errors", async () => {
    healthy(); write("tasks/BROKEN.json", "{fixture-private-error"); const before = capture(), warn = vi.spyOn(console, "warn");
    const view = await service().read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "executions")).toMatchObject({ rows: [], total: null, source: { availability: "unavailable" } });
    expect(view.sections.find((item) => item.kind === "issues")?.total).toBe(1); expect(warn).not.toHaveBeenCalled(); expect(capture()).toEqual(before);
  });

  it("rejects unsafe task file identity without repairing or silently omitting it", async () => {
    healthy(); write("tasks/wrong.json", readFileSync(join(state, "tasks/TASK-1.json"), "utf8")); const before = capture();
    const view = await service().read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "executions")?.source.reason).toBe("invalid-source"); expect(capture()).toEqual(before);
  });

  it("marks unprofiled personal repositories partial instead of requiring configuration or claiming readiness", async () => {
    mkdirSync(join(projects, "experiment", ".git"), { recursive: true }); const before = capture();
    const view = await service().read({ kind: "project", id: "experiment" });
    expect(view.sections.find((item) => item.kind === "projects")).toMatchObject({ coverage: "partial", total: null,
      rows: [{ id: "experiment", project_kind: "personal", execution_authority: "none", lineage: { alignment: "unavailable", gaps: ["incomplete-source"] } }] });
    expect(capture()).toEqual(before);
  });

  it("does not drop project inventory when the optional organization source is invalid", async () => {
    healthy(); write("organization/organization.json", "{");
    const view = await service().read({ kind: "project", id: "alpha" });
    expect(view.sections.find((item) => item.kind === "projects")).toMatchObject({ coverage: "partial", rows: [{ id: "alpha" }], total: null });
    expect(view.sections.find((item) => item.kind === "objectives")?.source.availability).toBe("unavailable");
  });

  it("refuses redirected state directories without reading or changing their target", async () => {
    healthy(); const outside = join(root, "redirect-target"); mkdirSync(outside);
    writeFileSync(join(outside, "clients.json"), "fixture-private-target");
    const redirectedState = join(root, "redirect-state"); mkdirSync(redirectedState);
    symlinkSync(outside, join(redirectedState, "portfolio"), process.platform === "win32" ? "junction" : "dir");
    const before = capture(); const view = await service({ stateRoot: redirectedState }).read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "commitments")?.source.reason).toBe("invalid-source");
    expect(JSON.stringify(view)).not.toContain("fixture-private-target"); expect(capture()).toEqual(before);
  });

  it("isolates asynchronous reader failures and malformed observations with normalized reasons", async () => {
    const read = vi.fn(async () => source([{ id: "surtec", label: "SURTEC", state: null }]));
    const view = await service({ readers: { company: read, signals: async () => { throw new Error("fixture-private-token"); },
      issues: () => ({ ...source(), private_notes: "fixture-private-notes" }) } }).read({ kind: "overview" });
    expect(view.sections.find((item) => item.kind === "company")?.total).toBe(1);
    expect(view.sections.find((item) => item.kind === "signals")?.source.reason).toBe("read-failed");
    expect(view.sections.find((item) => item.kind === "issues")?.source.reason).toBe("invalid-source");
    expect(read).toHaveBeenCalledOnce(); expect(JSON.stringify(view)).not.toContain("fixture-private");
  });

  it.each([null, {}, { kind: "overview", refresh: true }, { kind: "project", id: "../secret" }, { kind: "project" }, { kind: "overview", id: "alpha" },
    { kind: "overview", page_size: 51 }, { kind: "overview", cursors: { unknown: "cursor" } },
  ])("validates request shape before clock or reader invocation (%#)", async (request) => {
    const clock = vi.fn(() => new Date(NOW)), read = vi.fn(() => source());
    const subject = service({ clock, readers: Object.fromEntries(OPERATING_SECTIONS.map((kind) => [kind, read])) });
    await expect(subject.read(request)).rejects.toBeInstanceOf(OperatingRequestError);
    expect(clock).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });

  it("paginates safe normalized observations and refuses cursors bound to another scope", async () => {
    const subject = service({ readers: { projects: () => source([{ id: "alpha", label: "Alpha", state: "active" }]),
      issues: () => source(Array.from({ length: 3 }, (_, index) => ({ id: `issue-${index}`, label: "Public issue", state: "proposed", project_id: "alpha" }))) } });
    const first = await subject.read({ kind: "overview", page_size: 2 }); const cursor = first.sections.find((item) => item.kind === "issues")!.next_cursor;
    const last = await subject.read({ kind: "overview", page_size: 2, cursors: { issues: cursor } });
    expect(last.sections.find((item) => item.kind === "issues")).toMatchObject({ rows: [{ id: "issue-2" }], has_more: false, total: 3 });
    await expect(subject.read({ kind: "project", id: "alpha", cursors: { issues: cursor } })).rejects.toBeInstanceOf(OperatingRequestError);
  });
});
