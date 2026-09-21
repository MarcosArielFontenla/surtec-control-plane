import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, commitAndDiff, listManagedWorktrees, pushBranch, removeWorktree } from "./worktree";

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "surtec-wt-"));
  repo = join(dir, "myrepo");
  spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t.t"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { encoding: "utf8" });
  writeFileSync(join(repo, "README.md"), "hi\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init"], { encoding: "utf8" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createWorktree", () => {
  it("creates a worktree on a dedicated agent branch", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-1", "backend-engineer");
    expect(branch).toBe("agent/STK-1-backend-engineer");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  });
});

describe("commitAndDiff", () => {
  it("commits edits and reports files + diffstat", () => {
    const { worktreePath } = createWorktree(repo, "STK-2", "a");
    writeFileSync(join(worktreePath, "new.txt"), "content\n", "utf8");
    const r = commitAndDiff(worktreePath, "agent STK-2");
    expect(r.committed).toBe(true);
    expect(r.filesChanged).toContain("new.txt");
    expect(r.diffstat).toContain("new.txt");
  });

  it("reports no commit when there are no changes", () => {
    const { worktreePath } = createWorktree(repo, "STK-3", "a");
    const r = commitAndDiff(worktreePath, "agent STK-3");
    expect(r.committed).toBe(false);
    expect(r.filesChanged).toEqual([]);
    expect(r.diffstat).toBe("");
  });
});

describe("pushBranch", () => {
  it("pushes a branch to a configured origin", () => {
    const bare = join(dir, "remote.git");
    spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "remote", "add", "origin", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "checkout", "-b", "agent/x"], { encoding: "utf8" });
    writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "commit", "-m", "c"], { encoding: "utf8" });

    const r = pushBranch(repo, "agent/x");

    expect(r.pushed).toBe(true);
    const ls = spawnSync("git", ["-C", bare, "branch", "--list", "agent/x"], { encoding: "utf8" });
    expect(ls.stdout).toContain("agent/x");
  });

  it("returns pushed:false with an error when there is no remote", () => {
    const r = pushBranch(repo, "agent/missing");
    expect(r.pushed).toBe(false);
    expect(r.error && r.error.length > 0).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and branch idempotently", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-9", "a");
    expect(existsSync(worktreePath)).toBe(true);
    expect(listManagedWorktrees(repo)).toEqual([{ branch, worktreePath }]);

    removeWorktree(repo, worktreePath, branch);
    removeWorktree(repo, worktreePath, branch);

    expect(existsSync(worktreePath)).toBe(false);
    const ls = spawnSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
    expect(ls.stdout.trim()).toBe("");
  });

  it("refuses to remove a path outside the managed root", () => {
    expect(() => removeWorktree(repo, join(dir, "outside"), "agent/safe"))
      .toThrow("worktree path escapes its allowed root");
  });

  it("refuses unmanaged branch names", () => {
    expect(() => removeWorktree(repo, join(dir, "surtec-worktrees", "x"), "main"))
      .toThrow("valid managed agent branch");
  });
});
