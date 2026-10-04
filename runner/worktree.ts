import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { gitNetworkEnvironment, localGitEnvironment } from "../lib/security/environment";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { assertPathWithin, canonicalPath } from "../lib/security/paths";
import { redactText } from "../lib/security/redaction";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import type { TaskRecord } from "../lib/state/types";
import type { WorkflowCandidateBinding } from "../lib/workflows/types";
import { assertTestingEvidenceBinding, testingEvidenceStatus } from "../lib/context/testing-evidence";
import { readContained } from "../lib/harness/source";

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
  baseRevision?: string;
  candidateRevision?: string;
}

export interface CommitAndDiffOptions {
  validateChangedPaths?: (paths: string[]) => void;
}

export interface ManagedWorktree {
  branch: string;
  worktreePath: string;
}

export interface CandidateTreeView extends WorktreeInfo {
  candidateRevision: string;
  treeRevision: string;
  contentFingerprint: string;
  workingContentFingerprint: string;
}

export function managedWorktreeIdentity(sourceRepo: string, taskId: string, agentId: string): WorktreeInfo {
  const branch = `agent/${sanitizeId(taskId)}-${sanitizeId(agentId)}`;
  assertManagedBranch(branch);
  const worktreePath = join(managedRoot(sourceRepo), `${basename(sourceRepo)}-${sanitizeId(taskId)}-${sanitizeId(agentId)}`);
  assertPathWithin(managedRoot(sourceRepo), worktreePath, "worktree path");
  return { branch, worktreePath };
}

/** Resolve only the authoritative implementer's managed tree. No request path. */
export function inspectCandidateTree(sourceRepo: string, owner: TaskRecord, candidate: WorkflowCandidateBinding, controlPlaneRoot: string): CandidateTreeView {
  const requireTree = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const run = owner.envelope.metadata.run as Record<string, unknown> | undefined;
  requireTree(owner.envelope.id === candidate.task_id && owner.envelope.project === candidate.repository_id && owner.envelope.sandbox === "workspace-write"
    && owner.lifecycle === "finished" && owner.outcome === "completed" && owner.orchestration?.lease === null
    && !owner.orchestration.cancel_requested_at && !owner.orchestration.last_failure, "Candidate implementation owner is not terminal and inactive");
  requireTree(!!owner.testing_evidence && owner.testing_evidence.execution_id === candidate.execution_id
    && owner.testing_evidence.fingerprint === candidate.testing_evidence_fingerprint, "Candidate has no exact owned testing receipt");
  assertTestingEvidenceBinding(owner.testing_evidence!, owner, {
    schema_version: 1, id: candidate.candidate_id, issue_id: candidate.issue_id, task_id: candidate.task_id,
    execution_id: candidate.execution_id, repository_id: candidate.repository_id, scope_revision: candidate.scope_revision,
    base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint,
    changed_paths: candidate.changed_paths, created_at: owner.created_at, invalidated_at: null,
  });
  requireTree(testingEvidenceStatus(owner.testing_evidence!) === "passed", "Candidate testing receipt is not passing");
  const expectedBranch = `agent/${sanitizeId(owner.envelope.id)}-${sanitizeId(owner.envelope.agent)}`;
  const expectedPath = join(managedRoot(sourceRepo), `${basename(sourceRepo)}-${sanitizeId(owner.envelope.id)}-${sanitizeId(owner.envelope.agent)}`);
  requireTree(!!run && run.committed === true && run.branch === expectedBranch && typeof run.worktree_path === "string"
    && canonicalPath(run.worktree_path) === canonicalPath(expectedPath), "Candidate managed ownership metadata differs");
  requireTree(canonicalPath(owner.envelope.repo_path) === canonicalPath(sourceRepo), "Candidate source repository differs");
  const worktreePath = assertPathWithin(managedRoot(sourceRepo), expectedPath, "candidate tree");
  requireTree(existsSync(worktreePath) && !lstatSync(worktreePath).isSymbolicLink()
    && !lstatSync(managedRoot(sourceRepo)).isSymbolicLink(), "Candidate managed tree is missing or redirected");
  function inspect(args: string[], input?: string): string {
    const result = spawnSync("git", managedGitArgs(["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", worktreePath, ...args], controlPlaneRoot),
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: localGitEnvironment(), windowsHide: true, cwd: worktreePath, input });
    if (result.status !== 0 || result.error) throw new Error("Candidate Git inspection failed or exceeded bounds");
    return result.stdout;
  }
  const sourceCommon = spawnSync("git", managedGitArgs(["--no-replace-objects", "-C", sourceRepo, "rev-parse", "--path-format=absolute", "--git-common-dir"], controlPlaneRoot),
    { encoding: "utf8", timeout: 30_000, env: localGitEnvironment(), windowsHide: true });
  requireTree(sourceCommon.status === 0 && canonicalPath(sourceCommon.stdout.trim()) === canonicalPath(inspect(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()), "Candidate belongs to another Git repository");
  const listing = spawnSync("git", managedGitArgs(["--no-replace-objects", "-C", sourceRepo, "worktree", "list", "--porcelain", "-z"], controlPlaneRoot),
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: localGitEnvironment(), windowsHide: true });
  requireTree(listing.status === 0 && listing.stdout.split("\0\0").some((block) => {
    const fields = block.split("\0"), path = fields.find((entry) => entry.startsWith("worktree "))?.slice(9);
    return !!path && canonicalPath(path) === worktreePath && fields.includes(`branch refs/heads/${expectedBranch}`) && fields.includes(`HEAD ${candidate.candidate_revision}`);
  }), "Candidate worktree registration differs");
  requireTree(inspect(["symbolic-ref", "--short", "HEAD"]).trim() === expectedBranch, "Candidate branch differs");
  requireTree(inspect(["rev-parse", "HEAD"]).trim() === candidate.candidate_revision, "Candidate commit changed");
  requireTree(inspect(["rev-list", "--parents", "-n", "1", "HEAD"]).trim() === `${candidate.candidate_revision} ${candidate.base_revision}`, "Candidate base or parent changed");
  requireTree(inspect(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]) === "", "Candidate tree contains unsealed ignored files");
  const flags = inspect(["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
  requireTree(flags.every((entry) => entry.startsWith("H ")), "Candidate index hides modified or sparse paths");
  const entries = inspect(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  requireTree(entries.length > 0 && entries.length <= 10000 && entries.every((entry) => /^100(?:644|755) [a-f0-9]{40,64} 0\t/.test(entry)), "Candidate contains unsupported links, submodules or index entries");
  const tracked = entries.map((entry) => ({ path: entry.slice(entry.indexOf("\t") + 1), blob: entry.split(" ")[1]! }));
  requireTree(tracked.every((entry) => !/[\x00-\x1f\x7f]/.test(entry.path)), "Candidate tracked path cannot be inspected safely");
  let totalBytes = 0;
  const physical = tracked.map(({ path }) => {
    const bytes = readContained(worktreePath, path, 8 * 1024 * 1024);
    requireTree(!!bytes && lstatSync(join(worktreePath, path)).nlink === 1, "Candidate contains a missing, redirected or hard-linked file");
    totalBytes += bytes!.length;
    requireTree(totalBytes <= 64 * 1024 * 1024, "Candidate physical inspection exceeds bounds");
    return [path, bytes!.length, createHash("sha256").update(bytes!).digest("hex")];
  });
  // Do not run repository-defined clean filters or encoding converters merely
  // to inspect a candidate. Built-in Git text/eol normalization stays supported.
  const attributes = inspect(["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], tracked.map((entry) => entry.path).join("\0") + "\0").split("\0");
  requireTree(attributes.filter((_, index) => index % 3 === 2).every((value) => value === "unspecified" || value === "unset"), "Candidate requires unsupported external content conversion");
  requireTree(inspect(["status", "--porcelain=v1", "--untracked-files=all"]).trim() === "", "Candidate tree or index is dirty");
  const blobs = inspect(["hash-object", "--stdin-paths"], tracked.map((entry) => JSON.stringify(entry.path)).join("\n") + "\n").trim().split(/\r?\n/);
  requireTree(blobs.length === tracked.length && blobs.every((blob, index) => blob === tracked[index]!.blob), "Candidate physical content differs from the sealed index");
  const paths = inspect(["diff", "--name-only", "--no-renames", "-z", candidate.base_revision, candidate.candidate_revision]).split("\0").filter(Boolean);
  requireTree(JSON.stringify([...paths].sort()) === JSON.stringify([...candidate.changed_paths].sort()), "Candidate changed paths differ");
  const diffFingerprint = createHash("sha256").update(`${candidate.repository_id}\0${candidate.base_revision}\0${candidate.candidate_revision}\0${candidate.changed_paths.join("\0")}`).digest("hex");
  requireTree(diffFingerprint === candidate.diff_fingerprint, "Candidate diff identity differs");
  const patch = redactText(inspect(["show", "--format=", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"]));
  const contentFingerprint = createHash("sha256").update(patch).digest("hex");
  requireTree(contentFingerprint === candidate.content_fingerprint, "Candidate captured content differs");
  return { branch: expectedBranch, worktreePath, candidateRevision: candidate.candidate_revision, treeRevision: inspect(["rev-parse", "HEAD^{tree}"]).trim(), contentFingerprint,
    workingContentFingerprint: createHash("sha256").update(JSON.stringify(physical)).digest("hex") };
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

function git(args: string[], env: NodeJS.ProcessEnv = localGitEnvironment()): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", managedGitArgs(args), { encoding: "utf8", timeout: 30_000, env });
  const stderr = redactText(r.stderr ?? "");
  // r.error is set when the process couldn't be spawned (e.g. git missing) or timed out.
  return { ok: r.status === 0, stdout: redactText(r.stdout ?? ""), stderr: stderr || (r.error ? redactText(r.error.message) : "") };
}

const MAX_DIFF_CHARS = 200_000;

function committedPatch(worktreePath: string): { patch: string; patchTruncated: boolean } {
  const result = spawnSync(
    "git",
    managedGitArgs(["-C", worktreePath, "show", "--format=", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"]),
    { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_DIFF_CHARS + 64_000, env: localGitEnvironment() },
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

export function createWorktree(sourceRepo: string, taskId: string, agentId: string, baseRevision?: string): WorktreeInfo {
  const { branch, worktreePath } = managedWorktreeIdentity(sourceRepo, taskId, agentId);
  const worktreeRoot = managedRoot(sourceRepo);
  const expectedPath = canonicalPath(worktreePath);
  let exactBase: string | undefined;
  if (baseRevision !== undefined) {
    if (!/^[a-f0-9]{40,64}$/i.test(baseRevision)) throw new Error("managed worktree base revision is invalid");
    const resolved = git(["-C", sourceRepo, "rev-parse", "--verify", `${baseRevision}^{commit}`]);
    exactBase = resolved.ok ? resolved.stdout.trim() : "";
    if (exactBase.toLowerCase() !== baseRevision.toLowerCase()) throw new Error("managed worktree base revision is unavailable or differs");
  }
  const registered = parsedWorktrees(sourceRepo);
  const byBranch = registered.find((item) => item.branch === branch);
  const byPath = registered.find((item) => canonicalPath(item.worktreePath) === expectedPath);
  if (byBranch && byPath && canonicalPath(byBranch.worktreePath) === expectedPath && byPath.branch === branch) {
    if (exactBase) {
      const head = git(["-C", byPath.worktreePath, "rev-parse", "HEAD"]);
      if (!head.ok || head.stdout.trim().toLowerCase() !== exactBase.toLowerCase()) throw new Error("managed correction worktree no longer starts at its exact candidate base");
    }
    return { branch, worktreePath: assertPathWithin(worktreeRoot, byBranch.worktreePath, "worktree path") };
  }
  if (byBranch || byPath) throw new Error("managed worktree identity conflicts with the task branch or path");

  const existingBranch = git(["-C", sourceRepo, "branch", "--list", branch]);
  if (!existingBranch.ok) throw new Error(`git branch --list failed: ${(existingBranch.stderr || existingBranch.stdout).trim()}`);
  if (exactBase && existingBranch.stdout.trim()) {
    const head = git(["-C", sourceRepo, "rev-parse", "--verify", `${branch}^{commit}`]);
    if (!head.ok || head.stdout.trim().toLowerCase() !== exactBase.toLowerCase()) throw new Error("managed correction branch differs from its exact candidate base");
  }
  const args = existingBranch.stdout.trim()
    ? ["-C", sourceRepo, "worktree", "add", worktreePath, branch]
    : ["-C", sourceRepo, "worktree", "add", "-b", branch, worktreePath, ...(exactBase ? [exactBase] : [])];
  const r = git(args);
  if (!r.ok) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim()}`);
  return { branch, worktreePath };
}

export function commitAndDiff(worktreePath: string, message: string, options: CommitAndDiffOptions = {}): CommitResult {
  const add = git(["-C", worktreePath, "add", "-A"]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const names = git(["-C", worktreePath, "diff", "--cached", "--name-only"]);
  if (!names.ok) throw new Error(`git diff failed: ${names.stderr.trim()}`);
  const filesChanged = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (filesChanged.length === 0) return { filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false };
  options.validateChangedPaths?.(filesChanged);
  const baseRevision = git(["-C", worktreePath, "rev-parse", "HEAD"]);
  if (!baseRevision.ok || !/^[a-f0-9]{40,64}$/i.test(baseRevision.stdout.trim())) throw new Error("git could not identify the candidate base revision");
  const stat = git(["-C", worktreePath, "diff", "--cached", "--stat"]);
  const commit = git(["-C", worktreePath, "commit", "-m", message]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  const candidateRevision = git(["-C", worktreePath, "rev-parse", "HEAD"]);
  if (!candidateRevision.ok || !/^[a-f0-9]{40,64}$/i.test(candidateRevision.stdout.trim())) throw new Error("git could not identify the committed candidate revision");
  const captured = committedPatch(worktreePath);
  return { filesChanged, diffstat: stat.stdout.trim(), committed: true, baseRevision: baseRevision.stdout.trim(), candidateRevision: candidateRevision.stdout.trim(), ...captured };
}

export function pushBranch(sourceRepo: string, branch: string): { pushed: boolean; error?: string } {
  assertManagedBranch(branch);
  const r = git(["-C", sourceRepo, "push", "origin", branch], gitNetworkEnvironment());
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
