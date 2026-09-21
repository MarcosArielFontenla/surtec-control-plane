import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode, TaskRecord } from "../lib/state/types";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { readTask, updateTask, writeTask } from "../lib/state/store";
import { readTaskEvents } from "../lib/state/events";
import { TaskControlError, TaskOrchestrator } from "./task-orchestrator";
import type { TaskRunCompletion, TaskRunOptions } from "./run-task";
import type { AgentExecutor } from "./agent-executor";

function record(id: string, sandbox: SandboxMode = "read-only", project = "p", order = 0): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project, task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
      agent: "agent", title: id, instructions: "work", repo_path: "C:/repo", branch: `agent/${id}`,
      sandbox, expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: `2026-09-21T10:00:0${order}Z`, started_at: null,
    updated_at: `2026-09-21T10:00:0${order}Z`, finished_at: null,
    result: null, logs_path: null, revision: 1, orchestration: defaultTaskOrchestration(),
  };
}

interface PendingRun {
  id: string;
  options: TaskRunOptions;
  resolve: (completion: TaskRunCompletion) => void;
}

function controlledRunner(): {
  run: ReturnType<typeof vi.fn<(id: string, options: TaskRunOptions) => Promise<TaskRunCompletion>>>;
  pending: PendingRun[];
  finish: (id: string, completion?: TaskRunCompletion) => void;
} {
  const pending: PendingRun[] = [];
  const run = vi.fn((id: string, options: TaskRunOptions) => new Promise<TaskRunCompletion>((resolve) => {
    pending.push({ id, options, resolve });
  }));
  const finish = (id: string, completion: TaskRunCompletion = { outcome: "completed", retryable: false, stale: false }) => {
    const item = pending.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`no pending run: ${id}`);
    updateTask(id, (task) => {
      task.lifecycle = "finished";
      task.outcome = completion.outcome;
      task.finished_at = new Date().toISOString();
      task.orchestration!.lease = null;
    });
    item.resolve(completion);
  };
  return { run, pending, finish };
}

describe("TaskOrchestrator", () => {
  let root: string;
  let nowMs: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-orchestrator-"));
    process.env.SURTEC_STATE_DIR = join(root, "state");
    nowMs = Date.parse("2026-09-21T10:00:00Z");
  });

  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_PROJECTS_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces the global concurrency bound", async () => {
    writeTask(record("T-1", "read-only", "p1", 1));
    writeTask(record("T-2", "read-only", "p2", 2));
    writeTask(record("T-3", "read-only", "p3", 3));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ maxConcurrent: 2, now: () => new Date(nowMs), runAttempt: controlled.run });

    expect(await worker.runOnce()).toBe(2);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["T-1", "T-2"]);
    expect(await worker.runOnce()).toBe(0);

    controlled.finish("T-1");
    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("finished"));
    expect(await worker.runOnce()).toBe(1);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["T-1", "T-2", "T-3"]);
    controlled.finish("T-2");
    controlled.finish("T-3");
  });

  it("serializes writes per project while allowing read-only work", async () => {
    writeTask(record("W-1", "workspace-write", "same", 1));
    writeTask(record("W-2", "workspace-write", "same", 2));
    writeTask(record("R-1", "read-only", "same", 3));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ maxConcurrent: 3, now: () => new Date(nowMs), runAttempt: controlled.run });

    expect(await worker.runOnce()).toBe(2);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["W-1", "R-1"]);
    expect(readTask("W-2")?.lifecycle).toBe("queued");

    controlled.finish("W-1");
    await vi.waitFor(() => expect(readTask("W-1")?.lifecycle).toBe("finished"));
    expect(await worker.runOnce()).toBe(1);
    expect(controlled.run.mock.calls.at(-1)?.[0]).toBe("W-2");
    controlled.finish("R-1");
    controlled.finish("W-2");
  });

  it("cancels queued work durably without launching it", () => {
    writeTask(record("T-1"));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlled.run });

    const cancelled = worker.cancel("T-1");

    expect(cancelled).toMatchObject({ lifecycle: "finished", outcome: "cancelled", result: { status: "cancelled" } });
    expect(controlled.run).not.toHaveBeenCalled();
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["cancel-requested", "cancelled"]);
  });

  it("persists running cancellation before aborting the active signal", async () => {
    writeTask(record("T-1"));
    const signals: AbortSignal[] = [];
    const run = vi.fn((id: string, options: TaskRunOptions) => new Promise<TaskRunCompletion>((resolve) => {
      signals.push(options.signal!);
      options.signal!.addEventListener("abort", () => {
        updateTask(id, (task) => {
          task.lifecycle = "finished";
          task.outcome = "cancelled";
          task.finished_at = new Date(nowMs).toISOString();
          task.orchestration!.lease = null;
        });
        resolve({ outcome: "cancelled", retryable: false, stale: false });
      }, { once: true });
    }));
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    await worker.runOnce();

    const requested = worker.cancel("T-1");

    expect(requested.orchestration?.cancel_requested_at).toBe("2026-09-21T10:00:00.000Z");
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(readTask("T-1")?.outcome).toBe("cancelled"));
  });

  it("schedules a bounded retry for a transient owned failure", async () => {
    writeTask(record("T-1"));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), retryBaseMs: 100, runAttempt: controlled.run });
    await worker.runOnce();
    const pending = controlled.pending[0];
    updateTask("T-1", (task) => {
      task.lifecycle = "finished";
      task.outcome = "failed";
      task.finished_at = new Date(nowMs).toISOString();
      task.orchestration!.lease = null;
      task.orchestration!.last_failure = { kind: "transient", message: "runtime unavailable", at: new Date(nowMs).toISOString(), run_id: pending.options.runId! };
    });
    pending.resolve({ outcome: "failed", retryable: true, reason: "runtime unavailable", stale: false });

    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("queued"));
    expect(readTask("T-1")?.orchestration?.retry_at).toBe("2026-09-21T10:00:00.100Z");
    expect(await worker.runOnce()).toBe(0);
    nowMs += 100;
    expect(await worker.runOnce()).toBe(1);
    expect(readTask("T-1")?.orchestration?.attempts).toBe(2);
    controlled.finish("T-1");
  });

  it("recovers an expired lease without consuming another attempt", () => {
    const expired = record("T-1");
    expired.lifecycle = "running";
    expired.orchestration!.attempts = 1;
    expired.orchestration!.lease = {
      run_id: "run-old", worker_id: "worker-old",
      acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z",
    };
    writeTask(expired);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(worker.recoverExpiredLeases()).toBe(1);

    expect(readTask("T-1")).toMatchObject({ lifecycle: "queued", orchestration: { attempts: 1, lease: null, last_failure: { kind: "transient", run_id: "run-old" } } });
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["lease-recovered", "retry-scheduled"]);
  });

  it("fails an expired attempt when its attempt budget is exhausted", () => {
    const expired = record("T-1");
    expired.lifecycle = "running";
    expired.orchestration!.attempts = expired.orchestration!.max_attempts;
    expired.orchestration!.lease = {
      run_id: "run-old", worker_id: "worker-old",
      acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z",
    };
    writeTask(expired);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(worker.recoverExpiredLeases()).toBe(1);

    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "failed", orchestration: { last_failure: { kind: "budget" } } });
  });

  it("allows a manual retry only while budgets remain", () => {
    const failed = record("T-1");
    failed.lifecycle = "finished";
    failed.outcome = "failed";
    failed.finished_at = "2026-09-21T09:00:00Z";
    failed.orchestration!.attempts = 1;
    writeTask(failed);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(worker.retry("T-1")).toMatchObject({ lifecycle: "queued", outcome: null });

    updateTask("T-1", (task) => {
      task.lifecycle = "finished";
      task.outcome = "failed";
      task.orchestration!.attempts = task.orchestration!.max_attempts;
    });
    expect(() => worker.retry("T-1")).toThrow(TaskControlError);
  });

  it("runs a claimed task through the real runner boundary with a fake executor", async () => {
    const projectsRoot = join(root, "projects");
    const projectPath = join(projectsRoot, "p");
    mkdirSync(join(projectPath, ".git"), { recursive: true });
    mkdirSync(join(root, "registry"), { recursive: true });
    process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
    writeFileSync(join(root, "AGENTS.md"), "Do not deploy.\n", "utf8");
    writeFileSync(join(root, "registry", "agents.yml"), "agents:\n  - id: agent\n    name: Agent\n    type: engineering\n    description: Works.\n    default_sandbox: read-only\n    allowed_task_types: [analysis]\n    requires_human_approval_for: [merge]\n", "utf8");
    writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  p:\n    allowed_agents: [agent]\n    sandbox:\n      default: read-only\n", "utf8");
    const queued = record("T-1");
    queued.envelope.repo_path = projectPath;
    writeTask(queued);
    const executor: AgentExecutor = {
      run: vi.fn().mockResolvedValue({
        finalText: JSON.stringify({ status: "completed", summary: "done", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] }),
        structuredOutput: { status: "completed", summary: "done", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] },
        threadId: "thread-1",
        turnId: "turn-1",
        usage: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 6 },
      }),
    };
    const worker = new TaskOrchestrator({ repoRoot: root, executor, maxConcurrent: 1, now: () => new Date(nowMs) });

    expect(await worker.runOnce()).toBe(1);
    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("finished"));

    expect(readTask("T-1")).toMatchObject({
      outcome: "completed",
      result: { summary: "done" },
      orchestration: { attempts: 1, cumulative_tokens: 6, lease: null },
    });
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["claimed", "started", "usage", "completed"]);
  });
});
