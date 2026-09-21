import { randomUUID } from "node:crypto";
import type { AgentExecutor } from "./agent-executor";
import type { TaskRecord } from "../lib/state/types";
import { appendTaskEvent } from "../lib/state/events";
import { ensureTaskOrchestration } from "../lib/state/orchestration";
import { listTasks, StateLockConflictError, updateTask, withStateLock } from "../lib/state/store";
import { cancelledResult, failureResult } from "./result";
import { codexExecutor } from "./codex-executor";
import { runTask, type TaskRunCompletion, type TaskRunOptions } from "./run-task";

export interface TaskControl {
  enqueue(taskId: string): void;
  cancel(taskId: string): TaskRecord;
  retry(taskId: string): TaskRecord;
}

export class TaskControlError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

export interface TaskOrchestratorOptions {
  repoRoot?: string;
  executor?: AgentExecutor;
  workerId?: string;
  maxConcurrent?: number;
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  now?: () => Date;
  runAttempt?: (taskId: string, options: TaskRunOptions) => Promise<TaskRunCompletion | null>;
}

interface ActiveAttempt {
  runId: string;
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  promise: Promise<void>;
}

function positiveInteger(value: string | undefined, fallback: number, maximum?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function isLeaseCurrent(record: TaskRecord, nowMs: number): boolean {
  const expiry = record.orchestration?.lease?.expires_at;
  return record.lifecycle === "running" && typeof expiry === "string" && Date.parse(expiry) > nowMs;
}

export class TaskOrchestrator implements TaskControl {
  readonly workerId: string;
  readonly maxConcurrent: number;
  private readonly repoRoot: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly runAttempt: (taskId: string, options: TaskRunOptions) => Promise<TaskRunCompletion | null>;
  private readonly active = new Map<string, ActiveAttempt>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = true;

  constructor(options: TaskOrchestratorOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    const executor = options.executor ?? codexExecutor;
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.maxConcurrent = options.maxConcurrent ?? positiveInteger(process.env.SURTEC_WORKER_CONCURRENCY, 2, 16);
    this.pollMs = options.pollMs ?? positiveInteger(process.env.SURTEC_WORKER_POLL_MS, 250, 60_000);
    this.leaseMs = options.leaseMs ?? positiveInteger(process.env.SURTEC_WORKER_LEASE_MS, 30_000, 3_600_000);
    this.heartbeatMs = options.heartbeatMs ?? positiveInteger(process.env.SURTEC_WORKER_HEARTBEAT_MS, 5_000, this.leaseMs);
    this.retryBaseMs = options.retryBaseMs ?? positiveInteger(process.env.SURTEC_WORKER_RETRY_BASE_MS, 1_000, 60_000);
    this.now = options.now ?? (() => new Date());
    this.runAttempt = options.runAttempt ?? ((taskId, runOptions) => runTask(taskId, this.repoRoot, executor, runOptions));
  }

  start(): void {
    if (this.poller) return;
    this.stopped = false;
    this.recoverExpiredLeases();
    this.requestTick();
    this.poller = setInterval(() => this.requestTick(), this.pollMs);
    this.poller.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    const pending = [...this.active.values()].map((attempt) => attempt.promise);
    for (const attempt of this.active.values()) attempt.controller.abort(new Error("worker stopping"));
    await Promise.allSettled(pending);
  }

  enqueue(_taskId: string): void {
    if (!this.stopped) this.requestTick();
  }

  cancel(taskId: string): TaskRecord {
    let found = false;
    let changed = false;
    let queuedCancellation = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      found = true;
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle === "finished") {
        if (record.outcome === "cancelled") return false;
        throw new TaskControlError(`task is already finished: ${taskId}`, 409);
      }
      if (orchestration.cancel_requested_at) return false;
      orchestration.cancel_requested_at = at;
      if (record.lifecycle === "queued") {
        queuedCancellation = true;
        orchestration.lease = null;
        orchestration.retry_at = null;
        orchestration.last_failure = { kind: "cancelled", message: "cancelled before execution", at, run_id: "not-started" };
        record.lifecycle = "finished";
        record.outcome = "cancelled";
        record.finished_at = at;
        record.result = cancelledResult(record.envelope, "cancelled before execution", record.logs_path ?? "");
      }
      record.updated_at = at;
      changed = true;
    });
    if (!found || !updated) throw new TaskControlError(`task not found: ${taskId}`, 404);
    if (changed) {
      appendTaskEvent({ task_id: taskId, type: "cancel-requested", revision: updated.revision!, run_id: updated.orchestration?.lease?.run_id, attempt: updated.orchestration?.attempts || null, payload: { queued: queuedCancellation }, at });
      if (queuedCancellation) appendTaskEvent({ task_id: taskId, type: "cancelled", revision: updated.revision!, attempt: null, payload: { reason: "cancelled before execution" }, at });
    }
    this.active.get(taskId)?.controller.abort(new Error("task cancellation requested"));
    return updated;
  }

  retry(taskId: string): TaskRecord {
    let found = false;
    let changed = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      found = true;
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "finished") throw new TaskControlError(`task is not finished: ${taskId}`, 409);
      if (record.outcome === "completed" || record.outcome === "partial") throw new TaskControlError(`successful task cannot be retried: ${taskId}`, 409);
      if (orchestration.attempts >= orchestration.max_attempts) throw new TaskControlError(`task attempt budget is exhausted: ${taskId}`, 409);
      if (orchestration.cumulative_tokens >= orchestration.max_total_tokens) throw new TaskControlError(`task token budget is exhausted: ${taskId}`, 409);
      orchestration.cancel_requested_at = null;
      orchestration.retry_at = null;
      orchestration.lease = null;
      orchestration.last_failure = null;
      record.lifecycle = "queued";
      record.outcome = null;
      record.finished_at = null;
      record.result = null;
      record.updated_at = at;
      changed = true;
    });
    if (!found || !updated) throw new TaskControlError(`task not found: ${taskId}`, 404);
    if (changed) appendTaskEvent({ task_id: taskId, type: "queued", revision: updated.revision!, attempt: updated.orchestration?.attempts || null, payload: { manual_retry: true }, at });
    this.enqueue(taskId);
    return updated;
  }

  recoverExpiredLeases(): number {
    const now = this.now();
    let recovered = 0;
    for (const snapshot of listTasks()) {
      if (snapshot.lifecycle !== "running") continue;
      const expiry = snapshot.orchestration?.lease?.expires_at;
      if (expiry && Date.parse(expiry) > now.getTime()) continue;
      let disposition: "retry" | "failed" | "cancelled" | null = null;
      let previousRunId: string | null = null;
      try {
        const updated = updateTask(snapshot.envelope.id, (record) => {
          if (record.lifecycle !== "running") return false;
          const orchestration = ensureTaskOrchestration(record);
          if (orchestration.lease && Date.parse(orchestration.lease.expires_at) > now.getTime()) return false;
          previousRunId = orchestration.lease?.run_id ?? "legacy-run";
          orchestration.lease = null;
          if (orchestration.cancel_requested_at) {
            disposition = "cancelled";
            orchestration.retry_at = null;
            orchestration.last_failure = { kind: "cancelled", message: "cancelled while worker was unavailable", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "finished";
            record.outcome = "cancelled";
            record.finished_at = now.toISOString();
            record.result = cancelledResult(record.envelope, "cancelled while worker was unavailable", record.logs_path ?? "");
          } else if (orchestration.attempts < orchestration.max_attempts && orchestration.cumulative_tokens < orchestration.max_total_tokens) {
            disposition = "retry";
            orchestration.retry_at = now.toISOString();
            orchestration.last_failure = { kind: "transient", message: "worker lease expired", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "queued";
            record.outcome = null;
            record.finished_at = null;
            record.result = null;
          } else {
            disposition = "failed";
            orchestration.retry_at = null;
            orchestration.last_failure = { kind: "budget", message: "worker lease expired and retry budget is exhausted", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "finished";
            record.outcome = "failed";
            record.finished_at = now.toISOString();
            record.result = failureResult(record.envelope, "worker lease expired and retry budget is exhausted", record.logs_path ?? "");
          }
          record.updated_at = now.toISOString();
        });
        if (!updated || !disposition) continue;
        recovered += 1;
        appendTaskEvent({ task_id: snapshot.envelope.id, type: "lease-recovered", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { disposition }, at: now.toISOString() });
        if (disposition === "retry") appendTaskEvent({ task_id: snapshot.envelope.id, type: "retry-scheduled", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { retry_at: now.toISOString(), reason: "worker lease expired" }, at: now.toISOString() });
        if (disposition === "cancelled") appendTaskEvent({ task_id: snapshot.envelope.id, type: "cancelled", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { reason: "cancelled while worker was unavailable" }, at: now.toISOString() });
        if (disposition === "failed") appendTaskEvent({ task_id: snapshot.envelope.id, type: "failed", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { reason: "retry budget exhausted" }, at: now.toISOString() });
      } catch (error) {
        if (!(error instanceof StateLockConflictError)) throw error;
      }
    }
    return recovered;
  }

  async runOnce(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      try {
        return withStateLock("orchestrator-schedule", () => {
          this.recoverExpiredLeases();
          this.schedulePendingRetries();
          const now = this.now();
          const snapshots = listTasks();
          const running = snapshots.filter((record) => isLeaseCurrent(record, now.getTime()));
          let available = Math.max(0, this.maxConcurrent - running.length);
          if (available === 0) return 0;
          const writeProjects = new Set(
            running.filter((record) => record.envelope.sandbox === "workspace-write").map((record) => record.envelope.project),
          );
          let claimed = 0;
          const queued = snapshots
            .filter((record) => record.lifecycle === "queued")
            .sort((left, right) => left.created_at.localeCompare(right.created_at));
          for (const snapshot of queued) {
            if (available === 0) break;
            const orchestration = snapshot.orchestration;
            if (orchestration?.retry_at && Date.parse(orchestration.retry_at) > now.getTime()) continue;
            if (snapshot.envelope.sandbox === "workspace-write" && writeProjects.has(snapshot.envelope.project)) continue;
            try {
              const claim = this.claim(snapshot.envelope.id, now);
              if (!claim) continue;
              claimed += 1;
              available -= 1;
              if (claim.envelope.sandbox === "workspace-write") writeProjects.add(claim.envelope.project);
              this.launch(claim);
            } catch (error) {
              if (!(error instanceof StateLockConflictError)) throw error;
            }
          }
          return claimed;
        });
      } catch (error) {
        if (error instanceof StateLockConflictError) return 0;
        throw error;
      }
    } finally {
      this.ticking = false;
    }
  }

  private claim(taskId: string, now: Date): TaskRecord | null {
    const runId = randomUUID();
    let claimed = false;
    const updated = updateTask(taskId, (record) => {
      if (record.lifecycle !== "queued") return false;
      const orchestration = ensureTaskOrchestration(record);
      if (orchestration.cancel_requested_at) return false;
      if (orchestration.retry_at && Date.parse(orchestration.retry_at) > now.getTime()) return false;
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cumulative_tokens >= orchestration.max_total_tokens) return false;
      orchestration.attempts += 1;
      orchestration.retry_at = null;
      orchestration.lease = {
        run_id: runId,
        worker_id: this.workerId,
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      record.lifecycle = "running";
      record.started_at ??= now.toISOString();
      record.updated_at = now.toISOString();
      claimed = true;
    });
    if (!updated || !claimed) return null;
    appendTaskEvent({ task_id: taskId, type: "claimed", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { worker_id: this.workerId }, at: now.toISOString() });
    return updated;
  }

  private launch(record: TaskRecord): void {
    const taskId = record.envelope.id;
    const runId = record.orchestration!.lease!.run_id;
    const controller = new AbortController();
    const heartbeat = setInterval(() => this.heartbeat(taskId, runId, controller), this.heartbeatMs);
    heartbeat.unref?.();
    const promise = this.runAttempt(taskId, { signal: controller.signal, runId, workerId: this.workerId })
      .then((completion) => {
        if (completion?.retryable && !completion.stale) this.tryScheduleRetry(taskId, runId, completion.reason ?? "transient execution failure");
      })
      .catch((error: unknown) => {
        const reason = (error as Error)?.message ?? "unexpected worker failure";
        try {
          this.finalizeUnexpectedFailure(taskId, runId, reason);
          this.tryScheduleRetry(taskId, runId, reason);
        } catch (finalizeError) {
          console.error(`[orchestrator] failed to finalize ${taskId}:`, finalizeError);
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(taskId);
        if (!this.stopped) this.requestTick();
      });
    this.active.set(taskId, { runId, controller, heartbeat, promise });
  }

  private heartbeat(taskId: string, runId: string, controller: AbortController): void {
    let cancelRequested = false;
    let stillOwned = false;
    const now = this.now();
    try {
      updateTask(taskId, (record) => {
        const orchestration = ensureTaskOrchestration(record);
        if (record.lifecycle !== "running" || orchestration.lease?.run_id !== runId) return false;
        orchestration.lease.heartbeat_at = now.toISOString();
        orchestration.lease.expires_at = new Date(now.getTime() + this.leaseMs).toISOString();
        record.updated_at = now.toISOString();
        cancelRequested = orchestration.cancel_requested_at !== null;
        stillOwned = true;
      });
    } catch (error) {
      if (!(error instanceof StateLockConflictError)) console.error(`[orchestrator] heartbeat failed for ${taskId}:`, error);
      return;
    }
    if ((!stillOwned || cancelRequested) && !controller.signal.aborted) {
      controller.abort(new Error(cancelRequested ? "task cancellation requested" : "attempt lease is no longer current"));
    }
  }

  private finalizeUnexpectedFailure(taskId: string, runId: string, reason: string): void {
    let changed = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "running" || orchestration.lease?.run_id !== runId) return false;
      orchestration.lease = null;
      orchestration.last_failure = { kind: "transient", message: reason, at, run_id: runId };
      record.lifecycle = "finished";
      record.outcome = "failed";
      record.finished_at = at;
      record.updated_at = at;
      record.result = failureResult(record.envelope, reason, record.logs_path ?? "");
      changed = true;
    });
    if (updated && changed) appendTaskEvent({ task_id: taskId, type: "failed", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { reason, retryable: true }, at });
  }

  private scheduleRetry(taskId: string, runId: string, reason: string): void {
    let scheduled = false;
    const now = this.now();
    let retryAt = now.toISOString();
    const updated = updateTask(taskId, (record) => {
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "finished" || record.outcome !== "failed") return false;
      if (orchestration.last_failure?.kind !== "transient" || orchestration.last_failure.run_id !== runId) return false;
      if (orchestration.cancel_requested_at) return false;
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cumulative_tokens >= orchestration.max_total_tokens) return false;
      const delay = Math.min(60_000, this.retryBaseMs * (2 ** Math.max(0, orchestration.attempts - 1)));
      retryAt = new Date(now.getTime() + delay).toISOString();
      orchestration.retry_at = retryAt;
      orchestration.lease = null;
      record.lifecycle = "queued";
      record.outcome = null;
      record.finished_at = null;
      record.result = null;
      record.updated_at = now.toISOString();
      scheduled = true;
    });
    if (updated && scheduled) appendTaskEvent({ task_id: taskId, type: "retry-scheduled", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { retry_at: retryAt, reason }, at: now.toISOString() });
  }

  private tryScheduleRetry(taskId: string, runId: string, reason: string): void {
    try {
      this.scheduleRetry(taskId, runId, reason);
    } catch (error) {
      if (!(error instanceof StateLockConflictError)) console.error(`[orchestrator] failed to schedule retry for ${taskId}:`, error);
    }
  }

  private schedulePendingRetries(): void {
    for (const record of listTasks()) {
      const failure = record.orchestration?.last_failure;
      if (record.lifecycle !== "finished" || record.outcome !== "failed" || failure?.kind !== "transient") continue;
      this.scheduleRetry(record.envelope.id, failure.run_id, failure.message);
    }
  }

  private requestTick(): void {
    void this.runOnce().catch((error: unknown) => {
      console.error("[orchestrator] scheduler tick failed:", error);
    });
  }
}
