import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { gitEnvironment } from "../lib/security/environment";
import { assertPathWithin, canonicalPath } from "../lib/security/paths";
import { redactText } from "../lib/security/redaction";

export interface WorktreeInfo {
  branch: string;
  worktreePath: string;
}

export interface CommitResult {
  filesChanged: string[];
  diffstat: string;
  committed: boolean;
  patch: string;
  patchTruncated: boolean;
}

export interface ManagedWorktree {
  branch: string;
  worktreePath: string;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function managedRoot(sourceRepo: string): string {
  return join(dirname(sourceRepo), "surtec-worktrees");
}

function assertManagedBranch(branch: string): void {
  if (!/^agent\/[A-Za-z0-9][A-Za-z0-9._/-]{0,198}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error("branch is not a valid managed agent branch");
  }
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 30_000, env: gitEnvironment() });
  const stderr = redactText(r.stderr ?? "");
  // r.error is set when the process couldn't be spawned (e.g. git missing) or timed out.
  return { ok: r.status === 0, stdout: redactText(r.stdout ?? ""), stderr: stderr || (r.error ? redactText(r.error.message) : "") };
}

const MAX_DIFF_CHARS = 200_000;

function committedPatch(worktreePath: string): { patch: string; patchTruncated: boolean } {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "show", "--format=", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_DIFF_CHARS + 64_000, env: gitEnvironment() },
  );
  const output = redactText(result.stdout ?? "");
  const bufferExceeded = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  if (result.status !== 0 && !bufferExceeded) {
    const message = redactText(result.stderr ?? "") || redactText(result.error?.message ?? "");
    throw new Error(`git show failed: ${message.trim()}`);
  }
  return {
    patch: output.slice(0, MAX_DIFF_CHARS),
    patchTruncated: bufferExceeded || output.length > MAX_DIFF_CHARS,
  };
}

export function createWorktree(sourceRepo: string, taskId: string, agentId: string): WorktreeInfo {
  const branch = `agent/${sanitizeId(taskId)}-${sanitizeId(agentId)}`;
  assertManagedBranch(branch);
  const worktreeRoot = managedRoot(sourceRepo);
  const worktreePath = join(worktreeRoot, `${basename(sourceRepo)}-${sanitizeId(taskId)}-${sanitizeId(agentId)}`);
  const expectedPath = canonicalPath(worktreePath);
  const registered = parsedWorktrees(sourceRepo);
  const byBranch = registered.find((item) => item.branch === branch);
  const byPath = registered.find((item) => canonicalPath(item.worktreePath) === expectedPath);
  if (byBranch && byPath && canonicalPath(byBranch.worktreePath) === expectedPath && byPath.branch === branch) {
    return { branch, worktreePath: assertPathWithin(worktreeRoot, byBranch.worktreePath, "worktree path") };
  }
  if (byBranch || byPath) throw new Error("managed worktree identity conflicts with the task branch or path");

  const existingBranch = git(["-C", sourceRepo, "branch", "--list", branch]);
  if (!existingBranch.ok) throw new Error(`git branch --list failed: ${(existingBranch.stderr || existingBranch.stdout).trim()}`);
  const args = existingBranch.stdout.trim()
    ? ["-C", sourceRepo, "worktree", "add", worktreePath, branch]
    : ["-C", sourceRepo, "worktree", "add", "-b", branch, worktreePath];
  const r = git(args);
  if (!r.ok) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim()}`);
  return { branch, worktreePath };
}

export function commitAndDiff(worktreePath: string, message: string): CommitResult {
  const add = git(["-C", worktreePath, "add", "-A"]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const names = git(["-C", worktreePath, "diff", "--cached", "--name-only"]);
  if (!names.ok) throw new Error(`git diff failed: ${names.stderr.trim()}`);
  const filesChanged = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (filesChanged.length === 0) return { filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false };
  const stat = git(["-C", worktreePath, "diff", "--cached", "--stat"]);
  const commit = git(["-C", worktreePath, "commit", "-m", message]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  const captured = committedPatch(worktreePath);
  return { filesChanged, diffstat: stat.stdout.trim(), committed: true, ...captured };
}

export function pushBranch(sourceRepo: string, branch: string): { pushed: boolean; error?: string } {
  assertManagedBranch(branch);
  const r = git(["-C", sourceRepo, "push", "origin", branch]);
  return r.ok ? { pushed: true } : { pushed: false, error: (r.stderr || r.stdout).trim() };
}

function parsedWorktrees(sourceRepo: string): ManagedWorktree[] {
  const listed = git(["-C", sourceRepo, "worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(`git worktree list failed: ${(listed.stderr || listed.stdout).trim()}`);
  return listed.stdout
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("worktree "));
      const branchLine = block.split(/\r?\n/).find((line) => line.startsWith("branch refs/heads/"));
      if (!pathLine || !branchLine) return null;
      return {
        worktreePath: pathLine.slice("worktree ".length),
        branch: branchLine.slice("branch refs/heads/".length),
      };
    })
    .filter((item): item is ManagedWorktree => item !== null);
}

export function listManagedWorktrees(sourceRepo: string): ManagedWorktree[] {
  const root = managedRoot(sourceRepo);
  return parsedWorktrees(sourceRepo).flatMap((item) => {
    try {
      assertManagedBranch(item.branch);
      return [{ ...item, worktreePath: assertPathWithin(root, item.worktreePath, "worktree path") }];
    } catch {
      return [];
    }
  });
}

export function removeWorktree(sourceRepo: string, worktreePath: string, branch: string): void {
  assertManagedBranch(branch);
  const safePath = assertPathWithin(managedRoot(sourceRepo), worktreePath, "worktree path");
  const registered = parsedWorktrees(sourceRepo).find((item) => canonicalPath(item.worktreePath) === safePath);
  if (registered && registered.branch !== branch) throw new Error("worktree branch does not match the requested branch");
  if (registered) {
    const rm = git(["-C", sourceRepo, "worktree", "remove", "--force", safePath]);
    if (!rm.ok) throw new Error(`git worktree remove failed: ${(rm.stderr || rm.stdout).trim()}`);
  }

  const exists = git(["-C", sourceRepo, "branch", "--list", branch]);
  if (!exists.ok) throw new Error(`git branch --list failed: ${(exists.stderr || exists.stdout).trim()}`);
  if (exists.stdout.trim()) {
    const del = git(["-C", sourceRepo, "branch", "-D", branch]);
    if (!del.ok) throw new Error(`git branch -D failed: ${(del.stderr || del.stdout).trim()}`);
  }
}
