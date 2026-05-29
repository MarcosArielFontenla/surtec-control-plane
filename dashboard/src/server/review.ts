import type { ReviewDecision, TaskRecord } from "../../../lib/state/types";
import { readTask, writeTask } from "../../../lib/state/store";
import { expandHome } from "../../../lib/expand-home";
import { pushBranch, removeWorktree } from "../../../runner/worktree";

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

function loadDecidable(taskId: string): TaskRecord {
  const rec = readTask(taskId);
  if (!rec) throw new TaskNotFoundError(`task not found: ${taskId}`);
  if (rec.lifecycle !== "finished") throw new ReviewError(`task ${taskId} is not finished`);
  if (rec.decision != null) throw new ReviewError(`task ${taskId} is already ${rec.decision.status}`);
  return rec;
}

export function approveTask(taskId: string): ReviewDecision {
  const rec = loadDecidable(taskId);
  const decision: ReviewDecision = { status: "approved", at: new Date().toISOString() };
  const { branch, committed } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && committed) {
    const r = pushBranch(expandHome(rec.envelope.repo_path), branch);
    decision.branch = branch;
    decision.pushed = r.pushed;
    if (!r.pushed) decision.error = r.error;
  }
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
}

export function rejectTask(taskId: string): ReviewDecision {
  const rec = loadDecidable(taskId);
  const decision: ReviewDecision = { status: "rejected", at: new Date().toISOString() };
  const { branch, worktreePath } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && worktreePath) {
    decision.branch = branch;
    try {
      removeWorktree(expandHome(rec.envelope.repo_path), worktreePath, branch);
    } catch (e) {
      decision.error = (e as Error).message;
    }
  }
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
}
