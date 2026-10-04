import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../../lib/state/types";

vi.mock("../../../runner/worktree", () => ({ pushBranch: vi.fn(), removeWorktree: vi.fn() }));
import { pushBranch, removeWorktree } from "../../../runner/worktree";
vi.mock("../../../runner/github", () => ({ ensurePullRequest: vi.fn(), buildPrBody: vi.fn(() => "PR_BODY") }));
import { ensurePullRequest } from "../../../runner/github";
import { approveTask, rejectTask, ReviewError, ReviewConflictError, TaskNotFoundError } from "./review";
import { writeTask, readTask } from "../../../lib/state/store";
import { readTaskEvents } from "../../../lib/state/events";
import { mutateWorkflowDocument } from "../../../lib/state/workflows";
import type { WorkflowStatus } from "../../../lib/workflows/types";

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

function retainWorkflow(candidateTaskId: string, status: WorkflowStatus = "running", stageTaskId: string | null = null, retainedBy: "root" | "stage" | "lineage" | "none" = "root"): void {
  const at = "2026-10-04T00:00:00Z", hash = "a".repeat(64);
  const budget = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
  mutateWorkflowDocument((d) => {
    d.grants["grant-1"] = { schema_version: 1, id: "grant-1", workflow_id: "workflow-1", project_id: "stock-control", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "analysis", template_version: 1,
      authorized_scope: { expected_outcome: "Inspect synthetic evidence", acceptance_criteria: ["Evidence retained"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] },
      role_assignments: [{ role_id: "planner", agent_id: "backend-engineer", sandbox: "read-only", client_context_categories: [] }], permitted_stage_kinds: ["analysis"], source_fingerprints: [{ id: "safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash,
      minimum_review_depth: "focused", testing_mode: "functional", budget, correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: "synthetic-only", approved_at: at };
    d.workflows["workflow-1"] = { schema_version: 1, id: "workflow-1", revision: 1, project_id: "stock-control", issue_id: "issue-1", scope_revision: 1, template_id: "analysis", template_version: 1, status, work_scale: "bounded", current_grant_id: "grant-1", authority_revision: 1,
      stage_ids: ["stage-1"], current_stage_id: "stage-1", pending_decision_id: status === "waiting-human" ? "decision-1" : null, lineage_id: null,
      candidate: { candidate_id: "candidate-1", issue_id: "issue-1", repository_id: "stock-control", task_id: candidateTaskId, execution_id: "run-1", scope_revision: 1, base_revision: "b".repeat(40), candidate_revision: "c".repeat(40), changed_paths: ["src/change.ts"], diff_fingerprint: hash, content_fingerprint: hash, testing_evidence_fingerprint: hash },
      approved_plan: null, review_policy: null, budget, counters: { tasks: stageTaskId ? 1 : 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: status === "needs-decision" ? "Synthetic review" : null,
      recovery_state: "none", next_action: "Inspect retained evidence", stop_requested_at: status === "cancelled" ? at : null, created_at: at, updated_at: at, completed_at: status === "cancelled" ? at : null };
    d.stages["stage-1"] = { schema_version: 1, id: "stage-1", workflow_id: "workflow-1", grant_id: "grant-1", authority_revision: 1, generation: 1, ordinal: 1, kind: "analysis", role_id: "planner", agent_id: "backend-engineer", sandbox: "read-only", status: stageTaskId ? "reserved" : "pending", phase: "execution", task_id: stageTaskId, execution_id: null,
      predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output: null, output_fingerprint: null, candidate: null, context_fingerprint: stageTaskId ? hash : null, created_at: at, updated_at: at };
    if (stageTaskId) d.admission_intents["intent-1"] = { schema_version: 1, id: "intent-1", workflow_id: "workflow-1", stage_id: "stage-1", grant_id: "grant-1", authority_revision: 1, task_id: stageTaskId, status: "reserved", expected_issue_revision: 1, expected_workflow_revision: 1, context_fingerprint: hash, blocked_reason: null, created_at: at, updated_at: at };
    if (status === "waiting-human") d.decisions["decision-1"] = { schema_version: 1, id: "decision-1", workflow_id: "workflow-1", kind: "proposal-acknowledgement", status: "pending", expected_workflow_revision: 1, expected_issue_revision: 1, resource_fingerprint: hash, candidate_id: null, review_receipt_ids: [], summary: "Inspect synthetic evidence", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
    if (retainedBy !== "root") {
      const owner = d.workflows["workflow-1"]!, candidate = owner.candidate!; owner.candidate = null;
      if (retainedBy === "stage") d.stages["stage-1"]!.candidate = candidate;
      if (retainedBy === "lineage") {
        owner.lineage_id = "lineage-1";
        d.lineages["lineage-1"] = { schema_version: 1, id: "lineage-1", project_id: "stock-control", issue_id: "issue-1", scope_revision: 1, origin_task_id: candidateTaskId, workflow_ids: ["workflow-1"], candidate_ids: [], correction_limit: 0, corrections_consumed: 0, consumed_stage_id: null, consumed_at: null };
      }
    }
  });
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

describe("active workflow review boundary", () => {
  it.each(["running", "waiting-human", "needs-decision"] as const)("denies publication and candidate cleanup while %s without changing snapshots or events", (status) => {
    writeTask(record("TREE-1")); retainWorkflow("TREE-1", status);
    const path = join(root, "state/tasks/TREE-1.json"), workflowPath = join(root, "state/workflows/workflows.json");
    const before = readFileSync(path), workflowBefore = readFileSync(workflowPath);
    expect(() => approveTask("TREE-1", root)).toThrow(ReviewConflictError);
    expect(() => rejectTask("TREE-1", root)).toThrow(ReviewConflictError);
    expect(pushBranch).not.toHaveBeenCalled(); expect(ensurePullRequest).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(workflowPath)).toEqual(workflowBefore); expect(readTaskEvents("TREE-1")).toEqual([]);
  });
  it("checks durable stage ownership even when a task has no workflow metadata", () => {
    writeTask(record("TREE-1")); writeTask(record("ROLE-1", { sandbox: "read-only" })); retainWorkflow("TREE-1", "running", "ROLE-1");
    expect(() => approveTask("ROLE-1", root)).toThrow(/Active workflow/); expect(() => rejectTask("ROLE-1", root)).toThrow(/Active workflow/);
    expect(readTask("ROLE-1")!.decision).toBeNull(); expect(readTaskEvents("ROLE-1")).toEqual([]);
  });
  it.each(["stage", "lineage"] as const)("protects older candidate tasks retained only by the %s, not the current root", (retainedBy) => {
    writeTask(record("TREE-1")); retainWorkflow("TREE-1", "running", null, retainedBy);
    expect(() => approveTask("TREE-1", root)).toThrow(ReviewConflictError); expect(() => rejectTask("TREE-1", root)).toThrow(ReviewConflictError);
    expect(pushBranch).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled(); expect(readTaskEvents("TREE-1")).toEqual([]);
  });
  it.each(["approved", "rejected"] as const)("does not treat a stored %s flag as an ownership bypass", (status) => {
    writeTask(record("TREE-1", { decision: { status, at: "2026-10-01T00:00:00Z" } })); retainWorkflow("TREE-1");
    expect(() => (status === "approved" ? approveTask : rejectTask)("TREE-1", root)).toThrow(ReviewConflictError);
    expect(readTaskEvents("TREE-1")).toEqual([]); expect(pushBranch).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled();
  });
  it("does not block unrelated publication because an unadmitted read-only reservation has no task yet", () => {
    writeTask(record("FREE-1")); retainWorkflow("not-a-candidate", "running", "MISSING-ROLE", "none");
    expect(approveTask("FREE-1", root).status).toBe("approved"); expect(pushBranch).toHaveBeenCalledTimes(1);
  });
  it.each(["branch", "worktree"])("denies an independent task aliasing the retained %s", (alias) => {
    writeTask(record("TREE-1")); const other = record("ALIAS-1");
    if (alias === "branch") other.envelope.metadata.run = { branch: "agent/TREE-1-backend-engineer", worktree_path: "/tmp/unrelated", committed: true };
    else other.envelope.metadata.run = { branch: "agent/ALIAS-1-backend-engineer", worktree_path: "/tmp/wt/../wt", committed: true };
    writeTask(other); retainWorkflow("TREE-1");
    expect(() => approveTask("ALIAS-1", root)).toThrow(/retains this managed tree/); expect(() => rejectTask("ALIAS-1", root)).toThrow(/retains this managed tree/);
    expect(pushBranch).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled(); expect(readTaskEvents("ALIAS-1")).toEqual([]);
  });
  it.each(["approve", "reject"] as const)("does not resume a partial %s while ownership is active", (action) => {
    writeTask(record("TREE-1", { decision: { status: action === "approve" ? "approving" : "rejecting", at: "2026-10-01T00:00:00Z", attempts: 1, pushed: action === "approve" } }));
    retainWorkflow("TREE-1"); const before = readFileSync(join(root, "state/tasks/TREE-1.json"));
    expect(() => (action === "approve" ? approveTask : rejectTask)("TREE-1", root)).toThrow(ReviewConflictError);
    expect(readFileSync(join(root, "state/tasks/TREE-1.json"))).toEqual(before); expect(ensurePullRequest).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled();
  });
  it("retains the tree after stop intent until cancellation is terminal", () => {
    writeTask(record("TREE-1")); retainWorkflow("TREE-1");
    mutateWorkflowDocument((d) => { const owner = d.workflows["workflow-1"]!; owner.revision++; owner.stop_requested_at = "2026-10-04T00:00:00Z"; });
    expect(() => rejectTask("TREE-1", root)).toThrow(ReviewConflictError); expect(removeWorktree).not.toHaveBeenCalled();
  });
  it("permits separately authorized cleanup after terminal workflow cancellation", () => {
    writeTask(record("TREE-1")); retainWorkflow("TREE-1", "cancelled");
    expect(rejectTask("TREE-1", root).status).toBe("rejected"); expect(removeWorktree).toHaveBeenCalledTimes(1);
  });
  it("preserves unrelated publication while another tree is retained", () => {
    writeTask(record("TREE-1")); const other = record("FREE-1"); other.envelope.metadata.run = { branch: "agent/FREE-1-backend-engineer", worktree_path: "/tmp/other", committed: true }; writeTask(other); retainWorkflow("TREE-1");
    expect(approveTask("FREE-1", root).status).toBe("approved"); expect(pushBranch).toHaveBeenCalledTimes(1);
  });
  it.each(["{", '{"schema_version":2}'])("fails closed on unavailable workflow ownership and preserves its bytes: %s", (bytes) => {
    writeTask(record("TREE-1")); const path = join(root, "state/workflows/workflows.json"); mkdirSync(join(root, "state/workflows"), { recursive: true }); writeFileSync(path, bytes);
    expect(() => approveTask("TREE-1", root)).toThrow(/ownership is unavailable/); expect(() => rejectTask("TREE-1", root)).toThrow(/ownership is unavailable/);
    expect(readFileSync(path, "utf8")).toBe(bytes); expect(readTaskEvents("TREE-1")).toEqual([]); expect(pushBranch).not.toHaveBeenCalled(); expect(removeWorktree).not.toHaveBeenCalled();
  });
});
