import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, commitAndDiff } from "./worktree";

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
