import type { ReviewDecision, TaskRecord } from "../../../lib/state/types";
import { readTask, writeTask } from "../../../lib/state/store";
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
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
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
  } catch (error) {
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
      return persistDecision(rec, decision);
    }
    decision.cleanup_completed = true;
    delete decision.error;
    decision.at = new Date().toISOString();
    persistDecision(rec, decision);
  }
  decision.status = "rejected";
  decision.at = new Date().toISOString();
  delete decision.error;
  return persistDecision(rec, decision);
}
