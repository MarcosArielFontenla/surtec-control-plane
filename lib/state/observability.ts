import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { assertPathWithin } from "../security/paths";
import { buildAttention, toTaskView } from "./derive";
import type {
  TaskCleanupEvidence, TaskDetailModel, TaskDiffEvidence, TaskEvent, TaskRecord, TaskView, TodayActivity, TodayModel,
} from "./types";

const DEFAULT_TIME_ZONE = "America/Buenos_Aires";
const MAX_DIFF_BYTES = 200_000;

function runMetadata(task: TaskRecord): Record<string, unknown> {
  const value = task.envelope.metadata.run;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function localDateKey(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function sortedViews(tasks: TaskRecord[]): TaskView[] {
  return tasks.map(toTaskView).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function activityFor(
  tasksById: Map<string, TaskRecord>,
  events: TaskEvent[],
  types: TaskEvent["type"][],
  date: string,
  timeZone: string,
): TodayActivity[] {
  const allowed = new Set(types);
  return events
    .filter((event) => allowed.has(event.type) && localDateKey(event.at, timeZone) === date)
    .flatMap((event) => {
      const task = tasksById.get(event.task_id);
      return task ? [{ task: toTaskView(task), event }] : [];
    })
    .sort((left, right) => right.event.at.localeCompare(left.event.at));
}

export function buildToday(
  tasks: TaskRecord[],
  events: TaskEvent[],
  options: { now?: Date; date?: string; timeZone?: string; warnings?: string[] } = {},
): TodayModel {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? process.env.SURTEC_TIME_ZONE ?? DEFAULT_TIME_ZONE;
  // Constructing the formatter validates the configured IANA zone before classifying evidence.
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const date = options.date ?? localDateKey(now.toISOString(), timeZone)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");

  const active = sortedViews(tasks.filter((task) => task.lifecycle !== "finished"));
  const finishedToday = tasks.filter((task) => task.finished_at && localDateKey(task.finished_at, timeZone) === date);
  const completed = sortedViews(finishedToday.filter((task) => task.outcome === "completed" || task.outcome === "partial"));
  const failed = sortedViews(finishedToday.filter((task) => task.outcome === "failed" || task.outcome === "blocked" || task.outcome === "needs-review"));
  const cancelled = sortedViews(finishedToday.filter((task) => task.outcome === "cancelled"));
  const attention = buildAttention(tasks);
  const tasksById = new Map(tasks.map((task) => [task.envelope.id, task]));
  const retries = activityFor(tasksById, events, ["retry-scheduled"], date, timeZone);
  const cancellations = activityFor(tasksById, events, ["cancel-requested", "cancelled"], date, timeZone);
  const recoveries = activityFor(tasksById, events, ["lease-recovered"], date, timeZone);

  return {
    date,
    time_zone: timeZone,
    generated_at: now.toISOString(),
    active,
    attention,
    completed,
    failed,
    cancelled,
    retries,
    cancellations,
    recoveries,
    counts: {
      active: active.length,
      attention: attention.length,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      retries: retries.length,
    },
    warnings: options.warnings ?? [],
  };
}

function readDiff(repoRoot: string, run: Record<string, unknown>): TaskDiffEvidence {
  const path = stringValue(run.diff_path);
  if (!path) return { status: "none", path: null, content: null, truncated: false };
  try {
    const reportsRoot = join(repoRoot, "reports");
    const absolute = assertPathWithin(reportsRoot, join(repoRoot, path), "diff artifact path");
    if (extname(absolute).toLowerCase() !== ".diff") throw new Error("invalid diff artifact extension");
    if (!existsSync(absolute)) return { status: "missing", path, content: null, truncated: Boolean(run.diff_truncated) };
    const descriptor = openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(MAX_DIFF_BYTES);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      return {
        status: "available",
        path,
        content: buffer.subarray(0, bytes).toString("utf8"),
        truncated: Boolean(run.diff_truncated) || statSync(absolute).size > bytes,
      };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return { status: "invalid", path, content: null, truncated: false };
  }
}

function cleanupEvidence(task: TaskRecord, events: TaskEvent[]): TaskCleanupEvidence {
  const cleanup = [...events].reverse().find((event) => event.type === "cleanup");
  const eventStatus = cleanup?.payload.status;
  if (eventStatus === "completed") return { status: "completed", at: cleanup!.at };
  if (eventStatus === "failed") return { status: "failed", at: cleanup!.at };
  if (task.envelope.sandbox === "read-only" || eventStatus === "not-applicable") return { status: "not-applicable", at: cleanup?.at ?? null };
  if (task.decision?.cleanup_completed === true) return { status: "completed", at: task.decision.at };
  if (stringValue(runMetadata(task).worktree_path)) return { status: "retained", at: task.updated_at };
  return { status: "unknown", at: null };
}

export function buildTaskDetail(task: TaskRecord, events: TaskEvent[], repoRoot: string, now: Date = new Date()): TaskDetailModel {
  const run = runMetadata(task);
  const start = task.started_at ? Date.parse(task.started_at) : Number.NaN;
  const end = task.finished_at ? Date.parse(task.finished_at) : now.getTime();
  const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  const ordered = [...events].sort((left, right) => left.at.localeCompare(right.at));

  return {
    task,
    events: ordered,
    duration_ms: duration,
    execution: {
      mode: stringValue(run.mode),
      thread_id: stringValue(run.thread_id),
      turn_id: stringValue(run.turn_id),
      trace_id: stringValue(run.trace_id),
      span_id: stringValue(run.span_id),
      branch: stringValue(run.branch),
      worktree_path: stringValue(run.worktree_path),
      committed: booleanValue(run.committed),
      diffstat: stringValue(run.diffstat),
    },
    diff: readDiff(repoRoot, run),
    policy_decisions: ordered.filter((event) => event.type === "policy-evaluated"),
    approvals: ordered.filter((event) => event.type === "approval-recorded"),
    usage: ordered.filter((event) => event.type === "usage"),
    retries: ordered.filter((event) => event.type === "retry-scheduled" || event.type === "lease-recovered"),
    review_history: ordered.filter((event) => event.type === "review-decision"),
    cleanup: cleanupEvidence(task, ordered),
  };
}
