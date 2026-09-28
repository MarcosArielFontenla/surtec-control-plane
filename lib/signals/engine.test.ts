import { describe, expect, it } from "vitest";
import type { ProjectProfile } from "../portfolio-profile";
import type { ProjectIntegrationsSnapshot } from "../integrations/types";
import type { TaskRecord } from "../state/types";
import type { Note } from "../state/notes";
import type { SignalProjectEvidence, SignalEvidenceSnapshot } from "./engine";
import { generateSignals } from "./engine";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const observedAt = "2026-09-27T11:59:00.000Z";

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schema_version: 1,
    project_id: "alpha",
    kind: "client",
    lifecycle: "active",
    priority: 1,
    criticality: "high",
    current_goal: "Ship the release.",
    next_action: "Review the checklist.",
    deadline: null,
    client_id: "client-local",
    last_reviewed_at: "2026-08-01T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

function integrations(overrides: Partial<ProjectIntegrationsSnapshot> = {}): ProjectIntegrationsSnapshot {
  return {
    schema_version: 1,
    project_id: "alpha",
    observed_at: observedAt,
    trace_id: null,
    source_control: {
      provider: "git", configured: true, health: "ok", branch: "main", dirty: false,
      uncommitted: 0, ahead: 0, behind: 0,
      remote: {
        provider: "github", configured: true, health: "ok", pull_requests: 0, issues: 0,
        waiting_pull_requests: [],
      },
    },
    ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main" },
    deployments: [],
    ...overrides,
  };
}

function project(overrides: Partial<SignalProjectEvidence> = {}): SignalProjectEvidence {
  return {
    id: "alpha", status: "active", git: null, profile: profile(), integrations: integrations(),
    last_activity_at: observedAt, notes: [], ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}): TaskRecord {
  return {
    envelope: {
      id: "task-1", source: "test", project: "alpha", task_type: "implementation", agent: "codex",
      title: "Update the release workflow", instructions: "", repo_path: "D:/private/client", branch: "main",
      sandbox: "read-only", expected_outputs: [], requires_human_approval: false, metadata: {},
    },
    lifecycle: "finished", outcome: "failed", created_at: observedAt, started_at: observedAt,
    updated_at: observedAt, finished_at: observedAt, result: null, logs_path: null,
    ...overrides,
  } as TaskRecord;
}

const note: Note = { id: "note-1", text: "private commercial note", done: false, created_at: "2026-08-01T00:00:00.000Z" };

describe("deterministic signal engine", () => {
  it("creates explainable signals from deployments, CI, Git, PRs, tasks, issues, deadlines, stale profiles, and notes", () => {
    const snapshot: SignalEvidenceSnapshot = {
      projects: [project({
        git: { branch: "release", dirty: true, uncommitted: 2, ahead: 3, behind: 1, last_commit: null, ok: true },
        profile: profile({ deadline: "2026-09-25", last_reviewed_at: "2026-08-01T00:00:00.000Z" }),
        integrations: integrations({
          ci: { provider: "github-actions", configured: true, health: "down", status: "failing", branch: "main" },
          deployments: [{
            provider: "railway", configured: true, health: "down", status: "crashed", observed_at: observedAt,
            url: "https://private.example.invalid", http_status: null, latency_ms: null, deployed_at: null,
          }],
          source_control: {
            provider: "git", configured: true, health: "ok", branch: "release", dirty: true,
            uncommitted: 2, ahead: 3, behind: 1,
            remote: { provider: "github", configured: true, health: "ok", pull_requests: 1, issues: 0, waiting_pull_requests: [
              { number: 17, updated_at: observedAt, review_decision: "CHANGES_REQUESTED" },
            ] },
          },
        }),
        last_activity_at: "2026-09-01T00:00:00.000Z", notes: [note],
      })],
      tasks: [task()],
      issues: [{ projectId: "alpha", slug: "owner/repo", number: 42, title: "private issue", url: "https://github.com/owner/repo/issues/42", updatedAt: "2026-09-26T00:00:00.000Z", labels: ["priority: high"], author: "private-author" }],
    };

    const signals = generateSignals(snapshot, NOW);
    const types = new Set(signals.map((signal) => signal.type));
    expect(types).toEqual(new Set([
      "deployment-down", "ci-failing", "working-tree-dirty", "branch-ahead", "branch-behind",
      "pull-request-changes-requested", "deadline-overdue", "active-project-stale",
      "project-review-stale", "unresolved-project-note", "task-failed", "high-priority-issue-recent",
    ]));
    for (const signal of signals) {
      expect(signal.reason.length).toBeGreaterThan(0);
      expect(signal.evidence_at).toBeTruthy();
      expect(signal.ranking.order).toBeGreaterThanOrEqual(1);
      expect(signal.ranking.order).toBeLessThanOrEqual(7);
    }
    expect(signals.find((signal) => signal.type === "deployment-down")).toMatchObject({ evidence_at: observedAt, observed_at: NOW.toISOString() });
    expect(signals.find((signal) => signal.type === "deadline-overdue")?.ranking).toEqual({ tier: "client-commitment", order: 2 });
    expect(signals.find((signal) => signal.type === "deployment-down")?.ranking).toEqual({ tier: "production-failure", order: 1 });
    expect(signals.find((signal) => signal.type === "deadline-overdue")?.project_kind).toBe("client");
    expect(JSON.stringify(signals)).not.toContain("client-local");
  });

  it("covers blocked, failed, review, and approval task states while suppressing decisions already recorded", () => {
    const approved = task({
      envelope: { ...task().envelope, id: "task-approved", requires_human_approval: true },
      outcome: "completed", decision: { status: "approved", at: observedAt },
    });
    const approval = task({
      envelope: { ...task().envelope, id: "task-approval", requires_human_approval: true },
      outcome: "completed", result: null,
    });
    const review = task({ envelope: { ...task().envelope, id: "task-review" }, outcome: "needs-review" });
    const blocked = task({ envelope: { ...task().envelope, id: "task-blocked" }, lifecycle: "running", outcome: "blocked" });
    expect(generateSignals({ projects: [], tasks: [approved, approval, review, blocked], issues: [] }, NOW).map((item) => item.type).sort()).toEqual([
      "task-awaiting-approval", "task-blocked", "task-needs-review",
    ]);
  });

  it("uses run start time to distinguish long CI from a recent in-progress run", () => {
    const base = project({ integrations: integrations({
      ci: { provider: "github-actions", configured: true, health: "degraded", status: "running", branch: "main", run_started_at: "2026-09-27T11:00:01.000Z" },
    }) });
    expect(generateSignals({ projects: [base], tasks: [], issues: [] }, NOW).some((signal) => signal.type === "ci-running-long")).toBe(false);
    const long = project({ integrations: integrations({
      ci: { provider: "github-actions", configured: true, health: "degraded", status: "running", branch: "main", run_started_at: "2026-09-27T10:00:00.000Z" },
    }) });
    expect(generateSignals({ projects: [long], tasks: [], issues: [] }, NOW).find((signal) => signal.type === "ci-running-long")?.evidence.duration_minutes).toBe(120);
  });

  it("creates stable IDs across refreshes and distinct IDs for material occurrences", () => {
    const first = generateSignals({ projects: [project({ profile: profile({ deadline: "2026-09-28" }) })], tasks: [], issues: [] }, NOW);
    const later = generateSignals({ projects: [project({ profile: profile({ deadline: "2026-09-28" }) })], tasks: [], issues: [] }, new Date("2026-09-27T13:00:00.000Z"));
    const changed = generateSignals({ projects: [project({ profile: profile({ deadline: "2026-09-29" }) })], tasks: [], issues: [] }, NOW);
    expect(first.find((item) => item.type === "deadline-approaching")?.id).toBe(later.find((item) => item.type === "deadline-approaching")?.id);
    expect(first.find((item) => item.type === "deadline-approaching")?.id).not.toBe(changed.find((item) => item.type === "deadline-approaching")?.id);
  });

  it("does not rotate deployment IDs on a health observation refresh and distinguishes CI runs", () => {
    const down = (at: string, runId: string) => project({ integrations: integrations({
      observed_at: at,
      ci: { provider: "github-actions", configured: true, health: "down", status: "failing", branch: "main", run_id: runId, run_updated_at: at },
      deployments: [{ provider: "http-health", configured: true, health: "down", status: null, observed_at: at, url: null, http_status: 503, latency_ms: null, deployed_at: null }],
    }) });
    const first = generateSignals({ projects: [down(observedAt, "run-1")], tasks: [], issues: [] }, NOW);
    const refreshed = generateSignals({ projects: [down("2026-09-27T12:01:00.000Z", "run-1")], tasks: [], issues: [] }, new Date("2026-09-27T12:01:00.000Z"));
    const nextRun = generateSignals({ projects: [down("2026-09-27T12:02:00.000Z", "run-2")], tasks: [], issues: [] }, new Date("2026-09-27T12:02:00.000Z"));
    expect(first.find((item) => item.type === "deployment-down")?.id).toBe(refreshed.find((item) => item.type === "deployment-down")?.id);
    expect(first.find((item) => item.type === "ci-failing")?.id).toBe(refreshed.find((item) => item.type === "ci-failing")?.id);
    expect(first.find((item) => item.type === "ci-failing")?.id).not.toBe(nextRun.find((item) => item.type === "ci-failing")?.id);
  });

  it("orders by transparent ranking tier and does not leak note text, author data, URLs, paths, or secrets", () => {
    const privateTask = task();
    privateTask.envelope.title = "D:/private/client private-customer-name";
    const signals = generateSignals({
      projects: [project({
        integrations: integrations({ deployments: [{
          provider: "http-health", configured: true, health: "down", status: "authorization=super-secret", observed_at: observedAt,
          url: "https://private.example.invalid", http_status: 503, latency_ms: null, deployed_at: null,
        }] }),
        notes: [note],
      })],
      tasks: [privateTask],
      issues: [{ projectId: "alpha", slug: "owner/repo", number: 5, title: "private", url: "https://github.com/owner/repo/issues/5", updatedAt: observedAt, labels: ["urgent"], author: "person@example.com" }],
    }, NOW);
    expect(signals[0].type).toBe("deployment-down");
    const serialized = JSON.stringify(signals);
    for (const value of ["private commercial note", "person@example.com", "private.example.invalid", "D:/private/client", "private-customer-name", "super-secret"]) {
      expect(serialized).not.toContain(value);
    }
    expect(signals.find((signal) => signal.type === "deployment-down")?.evidence).not.toHaveProperty("status");
    expect(signals.find((signal) => signal.type === "unresolved-project-note")?.evidence).toEqual({ note_id: "note-1", created_at: "2026-08-01T00:00:00.000Z", age_days: 57 });
  });

  it("generates session signals only from an explicit paused-session evidence input", () => {
    const signals = generateSignals({
      projects: [], tasks: [], issues: [],
      sessions: [{ id: "session-1", project_id: "alpha", status: "paused", next_action: "resume", updated_at: observedAt }],
    }, NOW);
    expect(signals).toMatchObject([{ source: "session", type: "paused-session-next-action", evidence: { session_id: "session-1" } }]);
  });

  it("does not infer missing profile fields when the local profile store is unavailable", () => {
    const signals = generateSignals({
      projects: [project({ profile: null, profile_available: false, status: "active" })], tasks: [], issues: [],
      warnings: ["Portfolio profiles could not be read; other signal sources remain available."],
    }, NOW);
    expect(signals.map((signal) => signal.type)).not.toEqual(expect.arrayContaining(["missing-current-goal", "missing-next-action", "project-review-stale"]));
  });

  it("caps the feed at 5,000 ranked signals", () => {
    const projects = Array.from({ length: 1700 }, (_, index) => project({ id: `project-${index}`, profile: null, status: "discovered" }));
    expect(generateSignals({ projects, tasks: [], issues: [] }, NOW)).toHaveLength(5000);
  });
});
