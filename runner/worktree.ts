import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { gitEnvironment } from "../lib/security/environment";
import { redactText } from "../lib/security/redaction";

export interface WorktreeInfo {
  branch: string;
  worktreePath: string;
}

export interface CommitResult {
  filesChanged: string[];
  diffstat: string;
  committed: boolean;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 30_000, env: gitEnvironment() });
  const stderr = redactText(r.stderr ?? "");
  // r.error is set when the process couldn't be spawned (e.g. git missing) or timed out.
  return { ok: r.status === 0, stdout: redactText(r.stdout ?? ""), stderr: stderr || (r.error ? redactText(r.error.message) : "") };
}

export function createWorktree(sourceRepo: string, taskId: string, agentId: string): WorktreeInfo {
  const branch = `agent/${sanitizeId(taskId)}-${sanitizeId(agentId)}`;
  const worktreeRoot = join(dirname(sourceRepo), "surtec-worktrees");
  const worktreePath = join(worktreeRoot, `${basename(sourceRepo)}-${sanitizeId(taskId)}-${sanitizeId(agentId)}`);
  const r = git(["-C", sourceRepo, "worktree", "add", "-b", branch, worktreePath]);
  if (!r.ok) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim()}`);
  return { branch, worktreePath };
}

export function commitAndDiff(worktreePath: string, message: string): CommitResult {
  const add = git(["-C", worktreePath, "add", "-A"]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const names = git(["-C", worktreePath, "diff", "--cached", "--name-only"]);
  if (!names.ok) throw new Error(`git diff failed: ${names.stderr.trim()}`);
  const filesChanged = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (filesChanged.length === 0) return { filesChanged: [], diffstat: "", committed: false };
  const stat = git(["-C", worktreePath, "diff", "--cached", "--stat"]);
  const commit = git(["-C", worktreePath, "commit", "-m", message]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  return { filesChanged, diffstat: stat.stdout.trim(), committed: true };
}

export function pushBranch(sourceRepo: string, branch: string): { pushed: boolean; error?: string } {
  const r = git(["-C", sourceRepo, "push", "origin", branch]);
  return r.ok ? { pushed: true } : { pushed: false, error: (r.stderr || r.stdout).trim() };
}

export function removeWorktree(sourceRepo: string, worktreePath: string, branch: string): void {
  const rm = git(["-C", sourceRepo, "worktree", "remove", "--force", worktreePath]);
  if (!rm.ok) throw new Error(`git worktree remove failed: ${(rm.stderr || rm.stdout).trim()}`);
  const del = git(["-C", sourceRepo, "branch", "-D", branch]);
  if (!del.ok) throw new Error(`git branch -D failed: ${(del.stderr || del.stdout).trim()}`);
}
