import { describe, it, expect, vi } from "vitest";
import { validateBranchName, listBranches, BranchError } from "./git-branch";

const discoverAlpha = () => [{ id: "alpha", path: "/p/alpha" }];

describe("validateBranchName", () => {
  it("accepts valid names", () => {
    for (const n of ["feature/x", "fix-1", "release_2.0", "a/b/c", "main"]) {
      expect(validateBranchName(n)).toBe(true);
    }
  });
  it("rejects dangerous/invalid names", () => {
    for (const n of ["", "-foo", "--force", ".hidden", "/abs", "feat..x", "ends/", "wip.lock", "has space", "tab\tname", "a~b", "a:b", "a?b", "a".repeat(201)]) {
      expect(validateBranchName(n)).toBe(false);
    }
  });
});

describe("listBranches", () => {
  it("parses the branch list and detects current", () => {
    const spawnSync = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes("branch")) return { status: 0, stdout: "main\ndev\nfeature/x\n" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "dev\n" };
      return { status: 0, stdout: "" };
    });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r).toEqual({ branches: ["main", "dev", "feature/x"], current: "dev" });
  });

  it("returns current null for a detached HEAD", () => {
    const spawnSync = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes("branch")) return { status: 0, stdout: "main\n" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "HEAD\n" };
      return { status: 0, stdout: "" };
    });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.current).toBeNull();
  });

  it("throws BranchError(404) for an unknown project", () => {
    expect(() => listBranches("/repo", "ghost", { spawnSync: vi.fn() as never, discover: () => [], root: "/root" }))
      .toThrow(BranchError);
  });

  it("returns empty branches (no throw) when git fails", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "not a repo" });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r).toEqual({ branches: [], current: null });
  });
});
