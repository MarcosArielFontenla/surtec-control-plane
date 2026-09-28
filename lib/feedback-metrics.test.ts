import { describe, expect, it } from "vitest";
import { buildFeedbackMetrics } from "./feedback-metrics";
import type { Signal, SignalHumanRecord } from "./signals/types";
import type { TaskRecord, WorkSession } from "./state/types";

const now = new Date("2026-09-28T12:00:00.000Z");

function signal(source: Signal["source"], evidence_at: string): Signal {
  return {
    schema_version: 1, id: `sig_${"a".repeat(24)}`, project_id: "fictional", project_kind: null,
    source, type: "fixture", severity: "info", title: "synthetic", reason: "synthetic",
    evidence_at, observed_at: now.toISOString(), suggested_action: "synthetic", action_kind: "none",
    ranking: { tier: "hygiene", order: 1 }, state: "open", snoozed_until: null, evidence: {},
  };
}

function task(id: string, outcome: TaskRecord["outcome"], attempts = 1, verification?: "passed" | "failed" | "skipped"): TaskRecord {
  return {
    envelope: { id, source: "fixture", project: "fictional", task_type: "bugfix", agent: "backend-engineer", title: "synthetic", instructions: "synthetic", repo_path: "fixture", branch: "fixture", sandbox: "workspace-write", expected_outputs: [], requires_human_approval: false, metadata: {} },
    lifecycle: outcome === null ? "running" : "finished", outcome, created_at: now.toISOString(), started_at: now.toISOString(), updated_at: now.toISOString(), finished_at: outcome === null ? null : now.toISOString(),
    result: outcome === null ? null : {
      task_id: id, agent: "backend-engineer", status: outcome, summary: "synthetic", files_changed: [], commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [], logs_path: "synthetic",
      ...(verification ? { verification: { status: verification, checks: [] } } : {}),
    },
    logs_path: null, orchestration: { attempts, max_attempts: 3, max_runtime_ms: 1000, max_total_tokens: 1000, cumulative_tokens: 0, retry_at: null, cancel_requested_at: null, lease: null, last_failure: null },
  };
}

function session(status: WorkSession["status"], next_action: string | null): WorkSession {
  return {
    schema_version: 1, id: "fixture-session", project_id: "fictional", objective: "synthetic", status, branch: null,
    started_at: now.toISOString(), paused_at: status === "paused" ? now.toISOString() : null,
    completed_at: status === "completed" ? now.toISOString() : null, related_task_ids: [], related_run_ids: [],
    notes: [], result_summary: null, next_action, focused_ms: 0, active_since: status === "active" ? now.toISOString() : null,
  };
}

describe("local feedback metrics", () => {
  it("aggregates first recommendation actions, evidence latency, task outcomes, verification, sessions, and signal freshness", () => {
    const actions: SignalHumanRecord[] = [
      { state: "acknowledged", snoozed_until: null, pinned_for: null, dismissed: false, updated_at: now.toISOString(), first_action: "acknowledge", first_action_at: "2026-09-28T12:00:00.000Z", signal_evidence_at: "2026-09-28T11:55:00.000Z" },
      { state: "snoozed", snoozed_until: null, pinned_for: null, dismissed: false, updated_at: now.toISOString(), first_action: "snooze", first_action_at: "2026-09-28T12:00:00.000Z", signal_evidence_at: "2026-09-28T11:00:00.000Z" },
      { state: "open", snoozed_until: null, pinned_for: null, dismissed: true, updated_at: now.toISOString(), first_action: "dismiss", first_action_at: "2026-09-28T11:45:00.000Z", signal_evidence_at: "2026-09-28T11:30:00.000Z" },
      { state: "open", snoozed_until: null, pinned_for: "2026-09-28", dismissed: false, updated_at: now.toISOString(), first_action: "pin-for-today" },
    ];
    const metrics = buildFeedbackMetrics({
      signalActions: actions,
      signals: [
        signal("github", "2026-09-20T12:00:00.000Z"),
        signal("ci", "2026-09-28T00:00:00.000Z"),
        signal("git", "invalid"),
      ],
      tasks: [task("complete", "completed", 1, "passed"), task("review", "needs-review", 2), task("failed", "failed", 1, "failed"), task("active", null)],
      workSessions: [session("completed", "Review compatibility"), session("paused", null), session("active", null)],
      now,
    });

    expect(metrics.recommendations).toMatchObject({
      actions_recorded: 4, accepted: 1, snoozed: 1, dismissed: 1, pinned: 1,
      median_evidence_to_action_ms: 900_000, latency_samples: 3,
    });
    expect(metrics.tasks).toMatchObject({ total: 4, terminal: 3, completed: 1, retried: 1, needs_review: 1, success_rate: 1 / 3, retry_rate: 1 / 4, needs_review_rate: 1 / 3 });
    expect(metrics.verification).toMatchObject({ passed: 1, failed: 1, skipped: 0, missing: 1, eligible: 2, pass_rate: 0.5 });
    expect(metrics.work_sessions).toMatchObject({ total: 3, completed: 1, closed: 2, completed_with_next_action: 1, next_action_captured: 1, completion_rate: 1 / 3, next_action_capture_rate: 0.5 });
    expect(metrics.signals).toMatchObject({ freshness_eligible: 2, stale: 1, stale_rate: 0.5 });
    expect(JSON.stringify(metrics)).not.toContain("fictional");
  });

  it("returns null for rates with no eligible observations instead of implying zero success", () => {
    const metrics = buildFeedbackMetrics({ signalActions: [], signals: [], tasks: [], workSessions: [], now });
    expect(metrics.tasks.success_rate).toBeNull();
    expect(metrics.tasks.retry_rate).toBeNull();
    expect(metrics.verification.pass_rate).toBeNull();
    expect(metrics.work_sessions.completion_rate).toBeNull();
    expect(metrics.work_sessions.next_action_capture_rate).toBeNull();
    expect(metrics.signals.stale_rate).toBeNull();
    expect(metrics.recommendations.median_evidence_to_action_ms).toBeNull();
  });

  it("ignores clock-skewed action timestamps and treats future evidence as fresh", () => {
    const metrics = buildFeedbackMetrics({
      signalActions: [{ state: "open", snoozed_until: null, pinned_for: null, dismissed: false, updated_at: now.toISOString(), first_action: "acknowledge", first_action_at: "2026-09-28T11:00:00Z", signal_evidence_at: "2026-09-28T12:00:00Z" }],
      signals: [signal("ci", "2026-09-29T12:00:00Z")], tasks: [], workSessions: [], now,
    });
    expect(metrics.recommendations.accepted).toBe(1);
    expect(metrics.recommendations.latency_samples).toBe(0);
    expect(metrics.signals).toMatchObject({ freshness_eligible: 1, stale: 0, stale_rate: 0 });
  });
});
