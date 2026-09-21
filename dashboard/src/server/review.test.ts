import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../../lib/state/types";

vi.mock("../../../runner/worktree", () => ({ pushBranch: vi.fn(), removeWorktree: vi.fn() }));
import { pushBranch, removeWorktree } from "../../../runner/worktree";
vi.mock("../../../runner/github", () => ({ ensurePullRequest: vi.fn(), buildPrBody: vi.fn(() => "PR_BODY") }));
import { ensurePullRequest } from "../../../runner/github";
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
import { writeTask, readTask } from "../../../lib/state/store";
import { readTaskEvents } from "../../../lib/state/events";

let root: string;
let projectRepo: string;

function record(id: string, over: Partial<TaskRecord> & { sandbox?: "read-only" | "workspace-write" } = {}): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "stock-control", task_type: "implementation",
      agent: "backend-engineer", title: "t", instructions: "i", repo_path: projectRepo,
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
  process.env.SURTEC_PROJECTS_ROOT = join(root, "projects");
  projectRepo = join(root, "projects", "stock-control");
  mkdirSync(join(projectRepo, ".git"), { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements changes.\n    default_sandbox: workspace-write\n    allowed_task_types: [implementation]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    default_branch: main\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: workspace-write\n",
    "utf8",
  );
  vi.mocked(pushBranch).mockReset();
  vi.mocked(removeWorktree).mockReset();
  vi.mocked(pushBranch).mockReturnValue({ pushed: true });
  vi.mocked(ensurePullRequest).mockReset();
  vi.mocked(ensurePullRequest).mockReturnValue({ url: "https://github.com/x/pull/1" });
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("approveTask", () => {
  it("approves a workspace-write task: pushes the branch and opens a PR", () => {
    writeTask(record("RV-1"));
    const d = approveTask("RV-1", root);
    expect(d.status).toBe("approved");
    expect(pushBranch).toHaveBeenCalledWith(projectRepo, "agent/RV-1-backend-engineer");
    expect(d.pushed).toBe(true);
    expect(ensurePullRequest).toHaveBeenCalledWith(projectRepo, "agent/RV-1-backend-engineer", "main", "t", "PR_BODY");
    expect(d.pr_url).toBe("https://github.com/x/pull/1");
    expect(readTask("RV-1")!.decision?.pr_url).toBe("https://github.com/x/pull/1");
    expect(readTaskEvents("RV-1").map((event) => event.type)).toContain("policy-evaluated");
    expect(readTaskEvents("RV-1").map((event) => event.type)).toContain("review-decision");
  });

  it("approves a read-only task without pushing", () => {
    const r = record("RV-2", { sandbox: "read-only" });
    r.envelope.metadata = {};
    writeTask(r);
    const d = approveTask("RV-2", root);
    expect(d.status).toBe("approved");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(ensurePullRequest).not.toHaveBeenCalled();
  });

  it("returns an existing approval without repeating effects", () => {
    writeTask(record("RV-3", { decision: { status: "approved", at: "2026-05-29T11:00:00Z" } }));
    expect(approveTask("RV-3").status).toBe("approved");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(ensurePullRequest).not.toHaveBeenCalled();
  });

  it("throws ReviewError when not finished", () => {
    writeTask(record("RV-4", { lifecycle: "running" }));
    expect(() => approveTask("RV-4")).toThrow(ReviewError);
  });

  it("throws TaskNotFoundError for a missing task", () => {
    expect(() => approveTask("NOPE")).toThrow(TaskNotFoundError);
  });

  it("persists a failed push and resumes it on the next approval", () => {
    vi.mocked(pushBranch)
      .mockReturnValueOnce({ pushed: false, error: "no upstream" })
      .mockReturnValueOnce({ pushed: true });
    writeTask(record("RV-7"));
    const pending = approveTask("RV-7", root);
    expect(pending.status).toBe("approving");
    expect(pending.pushed).toBe(false);
    expect(pending.error).toBe("no upstream");
    expect(ensurePullRequest).not.toHaveBeenCalled();

    const completed = approveTask("RV-7", root);
    expect(completed.status).toBe("approved");
    expect(completed.attempts).toBe(2);
    expect(pushBranch).toHaveBeenCalledTimes(2);
    expect(ensurePullRequest).toHaveBeenCalledTimes(1);
  });

  it("persists a failed PR creation and resumes without pushing twice", () => {
    vi.mocked(ensurePullRequest)
      .mockReturnValueOnce({ error: "gh: command not found" })
      .mockReturnValueOnce({ url: "https://github.com/x/pull/8" });
    writeTask(record("RV-8"));
    const pending = approveTask("RV-8", root);
    expect(pending.status).toBe("approving");
    expect(pending.pushed).toBe(true);
    expect(pending.pr_url).toBeUndefined();
    expect(pending.error).toContain("gh: command not found");

    const completed = approveTask("RV-8", root);
    expect(completed.status).toBe("approved");
    expect(completed.pr_url).toBe("https://github.com/x/pull/8");
    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(ensurePullRequest).toHaveBeenCalledTimes(2);
  });

  it("rejects the opposite action while approval is pending", () => {
    writeTask(record("RV-9", { decision: { status: "approving", at: "2026-05-29T11:00:00Z" } }));
    expect(() => rejectTask("RV-9", root)).toThrow(ReviewError);
  });

  it("denies a persisted repository path that no longer matches policy", () => {
    const tampered = record("RV-10");
    tampered.envelope.repo_path = join(root, "other-repo");
    writeTask(tampered);

    expect(() => approveTask("RV-10", root)).toThrow("review denied by current policy");
    expect(pushBranch).not.toHaveBeenCalled();
    expect(readTask("RV-10")!.decision).toBeNull();
  });
});

describe("rejectTask", () => {
  it("rejects a workspace-write task and removes its worktree", () => {
    writeTask(record("RV-5"));
    const d = rejectTask("RV-5", root);
    expect(d.status).toBe("rejected");
    expect(d.cleanup_completed).toBe(true);
    expect(removeWorktree).toHaveBeenCalledWith(projectRepo, "/tmp/wt", "agent/RV-5-backend-engineer");
    expect(readTask("RV-5")!.decision?.status).toBe("rejected");
    expect(readTaskEvents("RV-5").map((event) => event.type)).toContain("cleanup");

    expect(rejectTask("RV-5", root).status).toBe("rejected");
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("persists a failed cleanup and resumes it on the next rejection", () => {
    writeTask(record("RV-6"));
    vi.mocked(removeWorktree)
      .mockImplementationOnce(() => { throw new Error("git worktree remove failed: boom"); })
      .mockImplementationOnce(() => undefined);
    const pending = rejectTask("RV-6", root);
    expect(pending.status).toBe("rejecting");
    expect(pending.error).toContain("git worktree remove failed");

    const completed = rejectTask("RV-6", root);
    expect(completed.status).toBe("rejected");
    expect(completed.cleanup_completed).toBe(true);
    expect(completed.attempts).toBe(2);
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });
});
