import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import type { AgentExecutor, AgentRunResult } from "./agent-executor";
import type { Tracer } from "../lib/observability/tracing";

vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
vi.mock("./verify", () => ({ runVerification: vi.fn() }));
import { createWorktree, commitAndDiff } from "./worktree";
import { runVerification } from "./verify";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";
import { updateTask } from "../lib/state/store";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { readTaskEvents } from "../lib/state/events";

let root: string;
let repo: string;
let run: ReturnType<typeof vi.fn<AgentExecutor["run"]>>;
let executor: AgentExecutor;

function structuredReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "ok",
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [],
    next_steps: [],
    artifacts: [],
    ...overrides,
  };
}

function agentRun(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  const structuredOutput = structuredReport();
  return {
    finalText: JSON.stringify(structuredOutput),
    structuredOutput,
    threadId: "thread-1",
    turnId: "turn-1",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 },
    ...overrides,
  };
}

function queuedRecord(): TaskRecord {
  return {
    envelope: {
      id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
      agent: "backend-engineer", title: "Analyze", instructions: "Review auth.",
      repo_path: repo, branch: "agent/T-1", sandbox: "read-only",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

function writeRecord(): TaskRecord {
  const record = queuedRecord();
  record.envelope.sandbox = "workspace-write";
  record.envelope.task_type = "implementation";
  return record;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-runtask-"));
  repo = join(root, "stock-control");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements backend.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: pnpm test\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.SURTEC_PROJECTS_ROOT = root;
  run = vi.fn<AgentExecutor["run"]>();
  run.mockResolvedValue(agentRun());
  executor = { run };
  vi.mocked(createWorktree).mockReset();
  vi.mocked(commitAndDiff).mockReset();
  vi.mocked(runVerification).mockReset();
  vi.mocked(runVerification).mockReturnValue({ status: "passed", checks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("runTask", () => {
  it("transitions queued to finished and passes root instructions plus the output schema", async () => {
    writeTask(queuedRecord());

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.lifecycle).toBe("finished");
    expect(record.outcome).toBe("completed");
    expect(record.result?.summary).toBe("ok");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].developerInstructions).toContain("ROOT RULE: do not deploy.");
    expect(run.mock.calls[0][0].outputSchema).toMatchObject({ title: "AgentReport", additionalProperties: false });
  });

  it("marks a runtime failure with a blocker", async () => {
    writeTask(queuedRecord());
    run.mockRejectedValue(new Error("runtime exploded"));

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers).toEqual(["runtime exploded"]);
  });

  it("routes invalid structured output to needs-review", async () => {
    writeTask(queuedRecord());
    run.mockResolvedValue(agentRun({ structuredOutput: { status: "completed" }, finalText: "raw report" }));

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.outcome).toBe("needs-review");
    expect(record.result?.risks[0]).toContain("Invalid agent report");
  });

  it("fails before execution when the repository path does not exist", async () => {
    const record = queuedRecord();
    record.envelope.repo_path = join(root, "does-not-exist");
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("repository path does not match");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before execution when the agent id is unknown", async () => {
    const record = queuedRecord();
    record.envelope.agent = "ghost-agent";
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("unknown agent");
    expect(run).not.toHaveBeenCalled();
  });

  it("creates a worktree, executes there, commits, verifies, and records protocol metadata", async () => {
    const record = writeRecord();
    record.envelope.self_verify = true;
    writeTask(record);
    const worktreePath = join(root, "worktree");
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath });
    vi.mocked(commitAndDiff).mockReturnValue({
      filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true,
      patch: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n", patchTruncated: false,
    });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0]).toMatchObject({ cwd: worktreePath, mode: "workspace-write-verify", verifyCommands: ["pnpm test"] });
    expect(commitAndDiff).toHaveBeenCalledWith(worktreePath, expect.any(String));
    expect(runVerification).toHaveBeenCalledWith(worktreePath, ["pnpm test"]);
    const finished = readTask("T-1")!;
    expect(finished.result?.files_changed).toEqual(["src/x.ts"]);
    expect(finished.envelope.metadata.run).toMatchObject({
      thread_id: "thread-1", turn_id: "turn-1", diff_path: expect.stringMatching(/\.diff$/), diff_truncated: false,
    });
    expect(readFileSync(join(root, (finished.envelope.metadata.run as { diff_path: string }).diff_path), "utf8")).toContain("+export const x");
  });

  it("uses plain write mode when self verification is not requested", async () => {
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "branch", worktreePath: join(root, "worktree") });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0].mode).toBe("workspace-write");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("fails cleanly when a write target is not a git repository", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeTask(writeRecord());

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("contained local git checkout");
    expect(run).not.toHaveBeenCalled();
  });

  it("turns the five-minute runtime budget into a terminal failed task", async () => {
    vi.useFakeTimers();
    writeTask(queuedRecord());
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await pending;

    const finished = readTask("T-1")!;
    expect(finished.result?.blockers).toEqual(["runtime budget exhausted (300000ms)"]);
    expect(finished.orchestration?.last_failure?.kind).toBe("budget");
  });

  it("persists thread, turn, usage, and append-only lifecycle events", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "thread-started", at: "2026-09-21T10:00:00Z", threadId: "thread-durable" });
      await events({ type: "turn-started", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable" });
      await events({
        type: "approval", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable",
        approval: "command", allowed: true, command: "printenv PRIVATE_TOKEN",
      });
      await events({ type: "warning", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable", message: "runtime warning" });
      await events({
        type: "usage",
        at: "2026-09-21T10:00:02Z",
        threadId: "thread-durable",
        turnId: "turn-durable",
        usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 13 },
      });
      return agentRun({ threadId: "thread-durable", turnId: "turn-durable" });
    });

    await runTask("T-1", root, executor);

    const finished = readTask("T-1")!;
    expect(finished.envelope.metadata.run).toMatchObject({ thread_id: "thread-durable", turn_id: "turn-durable" });
    expect(finished.orchestration?.cumulative_tokens).toBe(15);
    const events = readTaskEvents("T-1");
    expect(events.map((event) => event.type)).toEqual([
      "claimed", "started", "policy-evaluated", "thread-started", "turn-started", "approval-recorded", "warning", "usage", "usage", "completed",
    ]);
    expect(events.find((event) => event.type === "approval-recorded")?.payload).toEqual({
      approval: "command", allowed: true, thread_id: "thread-durable", turn_id: "turn-durable",
    });
  });

  it("resumes the persisted Codex thread on a retry", async () => {
    const record = queuedRecord();
    record.envelope.metadata.run = { thread_id: "thread-existing" };
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0].threadId).toBe("thread-existing");
  });

  it("delivers durable cancellation through the external abort signal", async () => {
    writeTask(queuedRecord());
    const controller = new AbortController();
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor, { signal: controller.signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.cancel_requested_at = new Date().toISOString();
    });
    controller.abort();
    const completion = await pending;

    expect(completion).toMatchObject({ outcome: "cancelled", retryable: false, stale: false });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "cancelled", result: { status: "cancelled" } });
  });

  it("aborts when cumulative token usage exceeds the task budget", async () => {
    const record = queuedRecord();
    record.orchestration = { ...defaultTaskOrchestration(), max_total_tokens: 10 };
    record.revision = 1;
    writeTask(record);
    run.mockImplementation(async (_input, events, signal) => {
      await events({
        type: "usage",
        at: new Date().toISOString(),
        threadId: "thread-1",
        turnId: "turn-1",
        usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 },
      });
      expect(signal.aborted).toBe(true);
      const error = new Error("interrupted");
      error.name = "AbortError";
      throw error;
    });

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.orchestration).toMatchObject({ cumulative_tokens: 11, last_failure: { kind: "budget" } });
    expect(readTask("T-1")?.result?.blockers).toEqual(["token budget exhausted (10)"]);
  });

  it("does not let a stale attempt overwrite a replacement lease", async () => {
    writeTask(queuedRecord());
    let resolveRun!: (value: AgentRunResult) => void;
    run.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));

    const pending = runTask("T-1", root, executor);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.lease!.run_id = "replacement-run";
      record.orchestration!.lease!.worker_id = "replacement-worker";
    });
    resolveRun(agentRun());
    const completion = await pending;

    expect(completion).toMatchObject({ stale: true });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "running", orchestration: { lease: { run_id: "replacement-run" } } });
  });

  it("redacts credentials from streamed logs", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "warning", at: new Date().toISOString(), message: "api_key=top-secret-value" });
      return agentRun();
    });

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    const log = readFileSync(join(root, record.logs_path!), "utf8");
    expect(log).not.toContain("top-secret-value");
    expect(log).toContain("[REDACTED]");
  });

  it("records injected trace identifiers without requiring a tracing package", async () => {
    writeTask(queuedRecord());
    const addEvent = vi.fn();
    const end = vi.fn();
    const tracer: Tracer = {
      startSpan: vi.fn(() => ({ context: { traceId: "trace-1", spanId: "span-1" }, addEvent, end })),
    };

    await runTask("T-1", root, executor, { tracer });

    expect(readTask("T-1")?.envelope.metadata.run).toMatchObject({ trace_id: "trace-1", span_id: "span-1" });
    expect(addEvent).toHaveBeenCalledWith("task.finished", { outcome: "completed", retryable: false });
    expect(end).toHaveBeenCalledWith("ok");
  });
});
