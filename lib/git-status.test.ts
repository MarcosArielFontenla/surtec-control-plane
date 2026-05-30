import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitStatus } from "./git-status";

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], { encoding: "utf8" });
function initRepo(): void {
  spawnSync("git", ["init", "-b", "main", dir], { encoding: "utf8" });
  writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "surtec-gitstatus-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readGitStatus", () => {
  it("reports a clean repo with branch + last commit", () => {
    initRepo();
    const s = readGitStatus(dir);
    expect(s.ok).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.dirty).toBe(false);
    expect(s.uncommitted).toBe(0);
    expect(s.last_commit?.subject).toBe("init");
    expect(s.last_commit?.hash).toMatch(/^[0-9a-f]+$/);
  });
  it("counts uncommitted changes", () => {
    initRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "new\n", "utf8");
    const s = readGitStatus(dir);
    expect(s.dirty).toBe(true);
    expect(s.uncommitted).toBe(2);
  });
  it("reports ahead vs an upstream", () => {
    initRepo();
    const bare = mkdtempSync(join(tmpdir(), "surtec-remote-"));
    spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-u", "origin", "main");
    writeFileSync(join(dir, "c.txt"), "more\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "second");
    const s = readGitStatus(dir);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
    rmSync(bare, { recursive: true, force: true });
  });
  it("returns ok:false for a non-repo directory", () => {
    const s = readGitStatus(dir);
    expect(s.ok).toBe(false);
    expect(s.branch).toBeNull();
  });
});
