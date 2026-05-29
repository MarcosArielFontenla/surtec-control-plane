import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../../lib/state/types";
import { expandHome } from "../../../lib/expand-home";

vi.mock("../../../runner/worktree", () => ({ pushBranch: vi.fn(), removeWorktree: vi.fn() }));
import { pushBranch, removeWorktree } from "../../../runner/worktree";
vi.mock("../../../runner/github", () => ({ openPullRequest: vi.fn(), buildPrBody: vi.fn(() => "PR_BODY") }));
import { openPullRequest } from "../../../runner/github";
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
import { writeTask, readTask } from "../../../lib/state/store";

let root: string;

function record(id: string, over: Partial<TaskRecord> & { sandbox?: "read-only" | "workspace-write" } = {}): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "stock-control", task_type: "implementation",
      agent: "backend-engineer", title: "t", instructions: "i", repo_path: "~/dev/x",
      branch: `agent/${id}`, sandbox: over.sandbox ?? "workspace-write",
      expected_outputs: [], requires_human_approval: true,
      metadata: { run: { branch: `agent/${id}-backend-engineer`, worktree_path: "/tmp/wt", committed: true } },
    },
    lifecycle: over.lifecycle ?? "finished",
    outcome: "completed", created_at: "2026-05-29T10:00:00Z", started_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:00:00Z", finished_at: "2026-05-29T10:30:00Z",
    result: null, logs_path: null, decision: over.decision ?? null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-review-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  stock-control:\n    default_branch: main\n", "utf8");
  vi.mocked(pushBranch).mockReset();
  vi.mocked(removeWorktree).mockReset();
  vi.mocked(pushBranch).mockReturnValue({ pushed: true });
  vi.mocked(openPullRequest).mockReset();
  vi.mocked(openPullRequest).mockReturnValue({ url: "https://github.com/x/pull/1" });
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("approveTask", () => {
  it("approves a workspace-write task: pushes the branch and opens a PR", () => {
    writeTask(record("RV-1"));
    const d = approveTask("RV-1", root);
    expect(d.status).toBe("approved");
    expect(pushBranch).toHaveBeenCalledWith(expandHome("~/dev/x"), "agent/RV-1-backend-engineer");
    expect(d.pushed).toBe(true);
    expect(openPullRequest).toHaveBeenCalledWith(expandHome("~/dev/x"), "agent/RV-1-backend-engineer", "main", "t", "PR_BODY");
    expect(d.pr_url).toBe("https://github.com/x/pull/1");
    expect(readTask("RV-1")!.decision?.pr_url).toBe("https://github.com/x/pull/1");
  });

  it("approves a read-only task without pushing", () => {
    const r = record("RV-2", { sandbox: "read-only" });
    r.envelope.metadata = {};
    writeTask(r);
    const d = approveTask("RV-2", root);
    expect(d.status).toBe("approved");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("throws ReviewError when already decided", () => {
    writeTask(record("RV-3", { decision: { status: "approved", at: "2026-05-29T11:00:00Z" } }));
    expect(() => approveTask("RV-3")).toThrow(ReviewError);
  });

  it("throws ReviewError when not finished", () => {
    writeTask(record("RV-4", { lifecycle: "running" }));
    expect(() => approveTask("RV-4")).toThrow(ReviewError);
  });

  it("throws TaskNotFoundError for a missing task", () => {
    expect(() => approveTask("NOPE")).toThrow(TaskNotFoundError);
  });

  it("records pushed:false with the error when the push fails", () => {
    vi.mocked(pushBranch).mockReturnValue({ pushed: false, error: "no upstream" });
    writeTask(record("RV-7"));
    const d = approveTask("RV-7", root);
    expect(d.status).toBe("approved");
    expect(d.pushed).toBe(false);
    expect(d.error).toBe("no upstream");
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("records the PR error but stays approved when gh fails", () => {
    vi.mocked(openPullRequest).mockReturnValue({ error: "gh: command not found" });
    writeTask(record("RV-8"));
    const d = approveTask("RV-8", root);
    expect(d.status).toBe("approved");
    expect(d.pushed).toBe(true);
    expect(d.pr_url).toBeUndefined();
    expect(d.error).toContain("gh: command not found");
  });
});

describe("rejectTask", () => {
  it("rejects a workspace-write task and removes its worktree", () => {
    writeTask(record("RV-5"));
    const d = rejectTask("RV-5");
    expect(d.status).toBe("rejected");
    expect(removeWorktree).toHaveBeenCalledWith(expandHome("~/dev/x"), "/tmp/wt", "agent/RV-5-backend-engineer");
    expect(readTask("RV-5")!.decision?.status).toBe("rejected");
  });

  it("records rejected with an error note when discard throws", () => {
    writeTask(record("RV-6"));
    vi.mocked(removeWorktree).mockImplementation(() => { throw new Error("git worktree remove failed: boom"); });
    const d = rejectTask("RV-6");
    expect(d.status).toBe("rejected");
    expect(d.error).toContain("git worktree remove failed");
  });
});
