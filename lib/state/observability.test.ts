import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskDetail, buildToday, localDateKey } from "./observability";
import type { TaskEvent, TaskRecord } from "./types";

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "alpha", task_type: "implementation", agent: "engineer",
      title: `Task ${id}`, instructions: "Do it", repo_path: "/repo", branch: `agent/${id}`,
      sandbox: "workspace-write", expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null, created_at: "2026-09-20T12:00:00Z", started_at: null,
    updated_at: "2026-09-20T12:00:00Z", finished_at: null, result: null, logs_path: null,
    revision: 1,
    ...over,
  };
}

function event(taskId: string, type: TaskEvent["type"], at: string, payload: Record<string, unknown> = {}): TaskEvent {
  return { event_id: `${taskId}-${type}-${at}`, task_id: taskId, type, at, revision: 1, run_id: null, attempt: null, payload };
}

describe("daily observability", () => {
  it("uses the configured time zone at UTC day boundaries", () => {
    expect(localDateKey("2026-09-22T01:30:00Z", "America/Buenos_Aires")).toBe("2026-09-21");
    expect(localDateKey("2026-09-21T02:30:00Z", "America/Buenos_Aires")).toBe("2026-09-20");
  });

  it("keeps active and attention work visible while limiting outcomes and events to today", () => {
    const active = task("ACTIVE", { lifecycle: "running", started_at: "2026-09-19T10:00:00Z" });
    const attention = task("REVIEW", {
      lifecycle: "finished", outcome: "completed", finished_at: "2026-09-19T11:00:00Z",
    });
    const completed = task("DONE", {
      lifecycle: "finished", outcome: "completed", finished_at: "2026-09-22T01:30:00Z", updated_at: "2026-09-22T01:30:00Z",
      envelope: { ...task("X").envelope, id: "DONE", requires_human_approval: false },
    });
    const failed = task("FAILED", { lifecycle: "finished", outcome: "failed", finished_at: "2026-09-21T15:00:00Z" });
    const cancelled = task("CANCELLED", { lifecycle: "finished", outcome: "cancelled", finished_at: "2026-09-21T16:00:00Z" });
    const events = [
      event("FAILED", "retry-scheduled", "2026-09-22T01:00:00Z"),
      event("CANCELLED", "cancelled", "2026-09-21T16:00:00Z"),
      event("ACTIVE", "lease-recovered", "2026-09-21T13:00:00Z"),
      event("FAILED", "retry-scheduled", "2026-09-21T02:00:00Z"),
    ];

    const today = buildToday([active, attention, completed, failed, cancelled], events, {
      now: new Date("2026-09-22T02:00:00Z"), timeZone: "America/Buenos_Aires",
    });

    expect(today.date).toBe("2026-09-21");
    expect(today.active.map((item) => item.id)).toEqual(["ACTIVE"]);
    expect(today.attention.some((item) => item.task_id === "REVIEW")).toBe(true);
    expect(today.completed.map((item) => item.id)).toEqual(["DONE"]);
    expect(today.failed.map((item) => item.id)).toEqual(["FAILED"]);
    expect(today.cancelled.map((item) => item.id)).toEqual(["CANCELLED"]);
    expect(today.retries).toHaveLength(1);
    expect(today.recoveries).toHaveLength(1);
  });
});

describe("task detail observability", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-detail-"));
    mkdirSync(join(root, "reports"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("assembles lifecycle, execution, diff, policy, approval, usage, retry, and cleanup evidence", () => {
    writeFileSync(join(root, "reports", "T-1.diff"), "diff --git a/x b/x\n+hello\n", "utf8");
    const record = task("T-1", {
      lifecycle: "finished", outcome: "completed", started_at: "2026-09-21T10:00:00Z", finished_at: "2026-09-21T10:00:05Z",
    });
    record.envelope.metadata.run = {
      mode: "workspace-write-verify", thread_id: "thread-1", turn_id: "turn-1", trace_id: "trace-1", span_id: "span-1",
      branch: "agent/T-1", worktree_path: "/managed/worktree", committed: true, diffstat: "1 file changed", diff_path: "reports/T-1.diff",
    };
    const events = [
      event("T-1", "usage", "2026-09-21T10:00:02Z", { cumulative_tokens: 20 }),
      event("T-1", "approval-recorded", "2026-09-21T10:00:01Z", { approval: "command", allowed: true }),
      event("T-1", "policy-evaluated", "2026-09-21T10:00:00Z", { allowed: true }),
      event("T-1", "retry-scheduled", "2026-09-21T09:00:00Z"),
    ];

    const detail = buildTaskDetail(record, events, root);

    expect(detail.duration_ms).toBe(5_000);
    expect(detail.execution).toMatchObject({ mode: "workspace-write-verify", trace_id: "trace-1", committed: true });
    expect(detail.diff).toMatchObject({ status: "available", path: "reports/T-1.diff", truncated: false });
    expect(detail.diff.content).toContain("+hello");
    expect(detail.policy_decisions).toHaveLength(1);
    expect(detail.approvals).toHaveLength(1);
    expect(detail.usage).toHaveLength(1);
    expect(detail.retries).toHaveLength(1);
    expect(detail.cleanup.status).toBe("retained");
    expect(detail.events.map((item) => item.type)).toEqual(["retry-scheduled", "policy-evaluated", "approval-recorded", "usage"]);
  });

  it("refuses a diff path outside reports and marks read-only cleanup as not applicable", () => {
    const record = task("T-2");
    record.envelope.sandbox = "read-only";
    record.envelope.metadata.run = { diff_path: "../outside.diff" };

    const detail = buildTaskDetail(record, [], root);

    expect(detail.diff).toMatchObject({ status: "invalid", content: null });
    expect(detail.cleanup.status).toBe("not-applicable");
  });
});
