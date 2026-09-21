import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import type { AgentExecutor, AgentRunResult } from "./agent-executor";

vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
vi.mock("./verify", () => ({ runVerification: vi.fn() }));
vi.mock("./registry-project", () => ({ loadProjectVerifyCommands: vi.fn() }));
import { createWorktree, commitAndDiff } from "./worktree";
import { runVerification } from "./verify";
import { loadProjectVerifyCommands } from "./registry-project";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";

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
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    description: Implements backend.\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  run = vi.fn<AgentExecutor["run"]>();
  run.mockResolvedValue(agentRun());
  executor = { run };
  vi.mocked(createWorktree).mockReset();
  vi.mocked(commitAndDiff).mockReset();
  vi.mocked(loadProjectVerifyCommands).mockReset();
  vi.mocked(loadProjectVerifyCommands).mockReturnValue(["pnpm test"]);
  vi.mocked(runVerification).mockReset();
  vi.mocked(runVerification).mockReturnValue({ status: "passed", checks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SURTEC_STATE_DIR;
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

    expect(readTask("T-1")?.result?.blockers[0]).toContain("repo not found");
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
    mkdirSync(join(repo, ".git"));
    const record = writeRecord();
    record.envelope.self_verify = true;
    writeTask(record);
    const worktreePath = join(root, "worktree");
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0]).toMatchObject({ cwd: worktreePath, mode: "workspace-write-verify", verifyCommands: ["pnpm test"] });
    expect(commitAndDiff).toHaveBeenCalledWith(worktreePath, expect.any(String));
    expect(runVerification).toHaveBeenCalledWith(worktreePath, ["pnpm test"]);
    const finished = readTask("T-1")!;
    expect(finished.result?.files_changed).toEqual(["src/x.ts"]);
    expect(finished.envelope.metadata.run).toMatchObject({ thread_id: "thread-1", turn_id: "turn-1" });
  });

  it("uses plain write mode when self verification is not requested", async () => {
    mkdirSync(join(repo, ".git"));
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "branch", worktreePath: join(root, "worktree") });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0].mode).toBe("workspace-write");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("fails cleanly when a write target is not a git repository", async () => {
    writeTask(writeRecord());

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("not a git repository");
    expect(run).not.toHaveBeenCalled();
  });

  it("turns the five-minute deadline into a failed task", async () => {
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

    expect(readTask("T-1")?.result?.blockers).toEqual(["timeout (5m)"]);
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
});
