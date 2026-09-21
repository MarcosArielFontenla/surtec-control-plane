import type { ReviewDecision, TaskRecord } from "../../../lib/state/types";
import { readTask, updateTask } from "../../../lib/state/store";
import { appendTaskEvent } from "../../../lib/state/events";
import { expandHome } from "../../../lib/expand-home";
import { pushBranch, removeWorktree } from "../../../runner/worktree";
import { ensurePullRequest, buildPrBody } from "../../../runner/github";
import { PolicyService } from "../../../lib/policy/service";

export class ReviewError extends Error {}
export class TaskNotFoundError extends ReviewError {}

interface RunInfo {
  branch?: string;
  worktreePath?: string;
  committed?: boolean;
}

function runInfo(rec: TaskRecord): RunInfo {
  const run = (rec.envelope.metadata?.run ?? {}) as { branch?: string; worktree_path?: string; committed?: boolean };
  return { branch: run.branch, worktreePath: run.worktree_path, committed: run.committed };
}

type ReviewAction = "approve" | "reject";

function persistDecision(rec: TaskRecord, decision: ReviewDecision): ReviewDecision {
  const updated = updateTask(rec.envelope.id, (current) => {
    current.decision = { ...decision };
    current.updated_at = decision.at;
  });
  if (!updated?.decision) throw new TaskNotFoundError(`task not found: ${rec.envelope.id}`);
  Object.assign(rec, updated);
  appendTaskEvent({
    task_id: rec.envelope.id,
    type: "review-decision",
    revision: updated.revision!,
    attempt: updated.orchestration?.attempts || null,
    payload: {
      status: decision.status,
      attempts: decision.attempts ?? 1,
      pushed: decision.pushed ?? null,
      pull_request_created: Boolean(decision.pr_url),
      cleanup_completed: decision.cleanup_completed ?? null,
      has_error: Boolean(decision.error),
    },
    at: decision.at,
  });
  return updated.decision;
}

function appendReviewEvent(rec: TaskRecord, type: "policy-evaluated" | "cleanup", payload: Record<string, unknown>): void {
  appendTaskEvent({
    task_id: rec.envelope.id,
    type,
    revision: rec.revision ?? 1,
    attempt: rec.orchestration?.attempts || null,
    payload,
  });
}

function beginDecision(taskId: string, action: ReviewAction, repoRoot: string): { rec: TaskRecord; done: boolean; defaultBranch: string } {
  const rec = readTask(taskId);
  if (!rec) throw new TaskNotFoundError(`task not found: ${taskId}`);
  if (rec.lifecycle !== "finished") throw new ReviewError(`task ${taskId} is not finished`);
  const pending = action === "approve" ? "approving" : "rejecting";
  const complete = action === "approve" ? "approved" : "rejected";
  if (rec.decision?.status === complete) return { rec, done: true, defaultBranch: "main" };
  if (rec.decision && rec.decision.status !== pending) {
    throw new ReviewError(`task ${taskId} is already ${rec.decision.status}`);
  }

  let defaultBranch: string;
  try {
    defaultBranch = new PolicyService(repoRoot).authorizeTask(rec.envelope).project.default_branch ?? "main";
    appendReviewEvent(rec, "policy-evaluated", { boundary: "review", action, allowed: true });
  } catch (error) {
    appendReviewEvent(rec, "policy-evaluated", { boundary: "review", action, allowed: false, reason: (error as Error).message });
    throw new ReviewError(`review denied by current policy: ${(error as Error).message}`);
  }

  const now = new Date().toISOString();
  const previous = rec.decision;
  const decision: ReviewDecision = previous
    ? { ...previous, at: now, attempts: (previous.attempts ?? 1) + 1 }
    : { status: pending, at: now, attempts: 1 };
  delete decision.error;
  persistDecision(rec, decision);
  return { rec, done: false, defaultBranch };
}

export function approveTask(taskId: string, repoRoot: string = process.cwd()): ReviewDecision {
  const { rec, done, defaultBranch } = beginDecision(taskId, "approve", repoRoot);
  if (done) return rec.decision!;
  const decision = rec.decision!;
  const { branch, committed } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && committed) {
    const repoPath = expandHome(rec.envelope.repo_path);
    decision.branch = branch;
    persistDecision(rec, decision);

    if (decision.pushed !== true) {
      const pushed = pushBranch(repoPath, branch);
      decision.pushed = pushed.pushed;
      if (!pushed.pushed) {
        decision.error = pushed.error;
        decision.at = new Date().toISOString();
        return persistDecision(rec, decision);
      }
      delete decision.error;
      decision.at = new Date().toISOString();
      persistDecision(rec, decision);
    }

    if (!decision.pr_url) {
      const pr = ensurePullRequest(repoPath, branch, defaultBranch, rec.envelope.title, buildPrBody(rec.envelope, rec.result));
      if (!pr.url) {
        decision.error = pr.error;
        decision.at = new Date().toISOString();
        return persistDecision(rec, decision);
      }
      decision.pr_url = pr.url;
      delete decision.error;
      decision.at = new Date().toISOString();
      persistDecision(rec, decision);
    }
  }

  decision.status = "approved";
  decision.at = new Date().toISOString();
  delete decision.error;
  return persistDecision(rec, decision);
}

export function rejectTask(taskId: string, repoRoot: string = process.cwd()): ReviewDecision {
  const { rec, done } = beginDecision(taskId, "reject", repoRoot);
  if (done) return rec.decision!;
  const decision = rec.decision!;
  const { branch, worktreePath } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && worktreePath && decision.cleanup_completed !== true) {
    decision.branch = branch;
    persistDecision(rec, decision);
    try {
      removeWorktree(expandHome(rec.envelope.repo_path), worktreePath, branch);
    } catch (e) {
      decision.error = (e as Error).message;
      decision.at = new Date().toISOString();
      const persisted = persistDecision(rec, decision);
      appendReviewEvent(rec, "cleanup", { status: "failed", reason: decision.error });
      return persisted;
    }
    decision.cleanup_completed = true;
    delete decision.error;
    decision.at = new Date().toISOString();
    persistDecision(rec, decision);
    appendReviewEvent(rec, "cleanup", { status: "completed", branch });
  } else {
    appendReviewEvent(rec, "cleanup", { status: "not-applicable" });
  }
  decision.status = "rejected";
  decision.at = new Date().toISOString();
  delete decision.error;
  return persistDecision(rec, decision);
}
