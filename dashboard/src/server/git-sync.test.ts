import { describe, it, expect, vi } from "vitest";
import { runGitSync, GitSyncError } from "./git-sync";

const discoverAlpha = () => [{ id: "alpha", path: "/p/alpha" }];

function okSpawn(stdout = "Already up to date.", stderr = "") {
  return vi.fn().mockReturnValue({ status: 0, stdout, stderr });
}

describe("runGitSync", () => {
  it("throws GitSyncError(400) for an invalid action and does not spawn", () => {
    const spawnSync = vi.fn();
    expect(() => runGitSync("/repo", "alpha", "merge", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" }))
      .toThrow(GitSyncError);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("throws GitSyncError(404) for an unknown project and does not spawn", () => {
    const spawnSync = vi.fn();
    try {
      runGitSync("/repo", "ghost", "fetch", { spawnSync: spawnSync as never, discover: () => [], root: "/root" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GitSyncError);
      expect((e as GitSyncError).status).toBe(404);
    }
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("maps fetch/pull/push to the exact git argv", () => {
    const spawnSync = okSpawn();
    runGitSync("/repo", "alpha", "fetch", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    runGitSync("/repo", "alpha", "pull", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    runGitSync("/repo", "alpha", "push", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(spawnSync.mock.calls[0]).toEqual(["git", ["-C", "/p/alpha", "fetch"], { encoding: "utf8", timeout: 60000 }]);
    expect(spawnSync.mock.calls[1]).toEqual(["git", ["-C", "/p/alpha", "pull", "--ff-only"], { encoding: "utf8", timeout: 60000 }]);
    expect(spawnSync.mock.calls[2]).toEqual(["git", ["-C", "/p/alpha", "push"], { encoding: "utf8", timeout: 60000 }]);
  });

  it("returns ok:true with combined output on exit 0", () => {
    const spawnSync = okSpawn("fetched\n", "");
    const r = runGitSync("/repo", "alpha", "fetch", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r).toEqual({ ok: true, action: "fetch", output: "fetched" });
  });

  it("returns ok:false with output on non-zero exit (does not throw)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting." });
    const r = runGitSync("/repo", "alpha", "pull", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.action).toBe("pull");
    expect(r.output).toContain("fast-forward");
  });

  it("returns ok:false with the error message when spawn errors (timeout/missing git)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("spawnSync git ETIMEDOUT") });
    const r = runGitSync("/repo", "alpha", "push", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("ETIMEDOUT");
  });
});
