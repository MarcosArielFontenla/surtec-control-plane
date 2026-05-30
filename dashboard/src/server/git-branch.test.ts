import { describe, it, expect, vi } from "vitest";
import { validateBranchName, listBranches, BranchError, switchBranch, createBranch } from "./git-branch";

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

// Routes a git spawnSync by subcommand so a single mock can drive switchBranch (which runs
// status --porcelain, branch, rev-parse, then switch).
function routeSpawn(routes: { porcelain?: object; branch?: object; head?: object; switch?: object }) {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("--porcelain")) return routes.porcelain ?? { status: 0, stdout: "" };
    if (args.includes("branch")) return routes.branch ?? { status: 0, stdout: "main\ndev\n" };
    if (args.includes("rev-parse")) return routes.head ?? { status: 0, stdout: "main\n" };
    if (args.includes("switch")) return routes.switch ?? { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  });
}

describe("switchBranch", () => {
  it("refuses (ok:false) and does NOT switch when the tree is dirty", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: " M file.ts\n" } });
    const r = switchBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no está limpio/);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall).toBeUndefined(); // switch never attempted
  });

  it("refuses (ok:false) when the target branch does not exist", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: "" }, branch: { status: 0, stdout: "main\ndev\n" } });
    const r = switchBranch("/repo", "alpha", "nope", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no existe/);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall).toBeUndefined();
  });

  it("switches when clean and the branch exists", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: "" }, branch: { status: 0, stdout: "main\ndev\n" }, switch: { status: 0, stdout: "Switched to branch 'dev'" } });
    const r = switchBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(true);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall![1]).toEqual(["-C", "/p/alpha", "switch", "dev"]);
  });

  it("rejects an invalid name (defense-in-depth) without spawning", () => {
    const spawnSync = vi.fn();
    const r = switchBranch("/repo", "alpha", "-x", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/invalid branch name/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("createBranch", () => {
  it("runs git switch -c with the exact argv and returns ok on exit 0", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "Switched to a new branch 'feature/y'" });
    const r = createBranch("/repo", "alpha", "feature/y", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(true);
    expect(spawnSync.mock.calls[0][1]).toEqual(["-C", "/p/alpha", "switch", "-c", "feature/y"]);
  });

  it("returns ok:false (no throw) when git fails (e.g. name already exists)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 128, stdout: "", stderr: "fatal: a branch named 'dev' already exists" });
    const r = createBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already exists/);
  });

  it("throws BranchError(404) for an unknown project", () => {
    expect(() => createBranch("/repo", "ghost", "x", { spawnSync: vi.fn() as never, discover: () => [], root: "/root" }))
      .toThrow(BranchError);
  });

  it("rejects an invalid name (defense-in-depth) without spawning", () => {
    const spawnSync = vi.fn();
    const r = createBranch("/repo", "alpha", "--force", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/invalid branch name/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
