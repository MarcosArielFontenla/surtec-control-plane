import { spawnSync } from "node:child_process";
import type { GitStatus } from "./state/types";

const TIMEOUT_MS = 10_000;

function git(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: TIMEOUT_MS });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "" };
}

const UNKNOWN: GitStatus = {
  branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false,
};

// Reads read-only LOCAL git status (no fetch/network). Never throws.
export function readGitStatus(repoPath: string): GitStatus {
  const head = git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!head.ok || head.stdout.trim() !== "true") return { ...UNKNOWN };

  const branchR = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchRaw = branchR.stdout.trim();
  const branch = branchR.ok && branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

  const porcelain = git(repoPath, ["status", "--porcelain"]);
  const lines = porcelain.stdout.split("\n").filter((l) => l.trim().length > 0);
  const uncommitted = lines.length;

  let ahead = 0;
  let behind = 0;
  const counts = git(repoPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts.ok) {
    const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  let last_commit: GitStatus["last_commit"] = null;
  const log = git(repoPath, ["log", "-1", "--format=%h%x00%s%x00%cI"]);
  if (log.ok && log.stdout.includes("\x00")) {
    const [hash, subject, at] = log.stdout.trim().split("\x00");
    if (hash) last_commit = { hash, subject: subject ?? "", at: at ?? "" };
  }

  return { branch, dirty: uncommitted > 0, uncommitted, ahead, behind, last_commit, ok: true };
}
