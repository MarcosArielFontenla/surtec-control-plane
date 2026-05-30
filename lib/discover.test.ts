import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjects } from "./discover";

let root: string;
function mkRepo(name: string, gitAsFile = false): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (gitAsFile) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n", "utf8");
  else mkdirSync(join(dir, ".git"), { recursive: true });
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-discover-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("discoverProjects", () => {
  it("returns only git dirs, sorted by id", () => {
    mkRepo("beta"); mkRepo("alpha");
    mkdirSync(join(root, "not-a-repo"), { recursive: true });
    expect(discoverProjects(root).map((p) => p.id)).toEqual(["alpha", "beta"]);
  });
  it("treats a .git FILE (worktree) as a repo", () => {
    mkRepo("wt", true);
    expect(discoverProjects(root).map((p) => p.id)).toEqual(["wt"]);
  });
  it("skips dot-folders and ignored names", () => {
    mkRepo(".hidden"); mkRepo("node_modules"); mkRepo("keep");
    expect(discoverProjects(root, ["node_modules"]).map((p) => p.id)).toEqual(["keep"]);
  });
  it("returns the absolute path for each project", () => {
    mkRepo("alpha");
    expect(discoverProjects(root)[0].path).toBe(join(root, "alpha"));
  });
  it("returns [] when the root is missing", () => {
    expect(discoverProjects(join(root, "does-not-exist"))).toEqual([]);
  });
});
