import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";

vi.mock("./claude", () => ({ runAgent: vi.fn() }));
vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
import { runAgent } from "./claude";
import { createWorktree, commitAndDiff } from "./worktree";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";

let root: string;
let repo: string;

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
  const r = queuedRecord();
  r.envelope.sandbox = "workspace-write";
  r.envelope.task_type = "implementation";
  return r;
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
  writeFileSync(join(root, "AGENTS.md"), "RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  vi.mocked(runAgent).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.mocked(commitAndDiff).mockReset();
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

describe("runTask", () => {
  it("transitions queued -> finished with the parsed AgentResult", async () => {
    writeTask(queuedRecord());
    vi.mocked(runAgent).mockResolvedValue({
      text: '```json\n{ "summary": "ok", "risks": ["r"], "blockers": [], "next_steps": [], "status": "completed" }\n```',
      costUsd: 0.01,
      tokens: 42,
    });

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("completed");
    expect(rec.result?.summary).toBe("ok");
    expect(rec.result?.risks).toEqual(["r"]);
    expect(rec.started_at).not.toBeNull();
    expect(rec.finished_at).not.toBeNull();
  });

  it("marks failed with a blocker when the agent throws", async () => {
    writeTask(queuedRecord());
    vi.mocked(runAgent).mockRejectedValue(new Error("api exploded"));

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers).toEqual(["api exploded"]);
  });

  it("fails cleanly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    writeTask(queuedRecord());

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("ANTHROPIC_API_KEY");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("fails when the repo path does not exist", async () => {
    const rec = queuedRecord();
    rec.envelope.repo_path = join(root, "does-not-exist");
    writeTask(rec);

    await runTask("T-1", root);

    const out = readTask("T-1")!;
    expect(out.outcome).toBe("failed");
    expect(out.result?.blockers[0]).toContain("repo not found");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("fails when the agent id is not in the registry", async () => {
    const rec = queuedRecord();
    rec.envelope.agent = "ghost-agent";
    writeTask(rec);

    await runTask("T-1", root);

    const out = readTask("T-1")!;
    expect(out.outcome).toBe("failed");
    expect(out.result?.blockers[0]).toContain("unknown agent");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("workspace-write: creates a worktree, runs the agent in write mode, commits, records files_changed", async () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath: join(repo, "..", "wt") });
    vi.mocked(runAgent).mockResolvedValue({
      text: '```json\n{ "summary": "did it", "status": "completed" }\n```',
      costUsd: 0.02,
      tokens: 10,
    });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true });

    await runTask("T-1", root);

    expect(createWorktree).toHaveBeenCalledWith(repo, "T-1", "backend-engineer");
    expect(vi.mocked(runAgent).mock.calls[0][0].mode).toBe("workspace-write");
    expect(commitAndDiff).toHaveBeenCalled();
    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("completed");
    expect(rec.result?.files_changed).toEqual(["src/x.ts"]);
    expect((rec.envelope.metadata.run as { branch?: string }).branch).toBe("agent/T-1-backend-engineer");
  });

  it("workspace-write: fails cleanly when the source is not a git repo", async () => {
    writeTask(writeRecord());

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("not a git repository");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("workspace-write: fails cleanly when worktree creation throws", async () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockImplementation(() => { throw new Error("git worktree add failed: boom"); });

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("git worktree add failed");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
