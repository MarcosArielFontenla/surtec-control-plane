import { describe, it, expect, vi } from "vitest";
import { readGithubCountsAtPath, resolveRepoPath, GithubError, createGithubCache } from "./github-read";

function routeGh(routes: { pr?: object; issue?: object }) {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("pr")) return routes.pr ?? { status: 0, stdout: "[]" };
    if (args.includes("issue")) return routes.issue ?? { status: 0, stdout: "[]" };
    return { status: 0, stdout: "[]" };
  });
}

describe("readGithubCountsAtPath", () => {
  it("returns counts and uses the exact gh argv + cwd", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: '[{"number":1},{"number":2}]' }, issue: { status: 0, stdout: '[{"number":5}]' } });
    expect(readGithubCountsAtPath("/p", { spawnSync: spawnSync as never })).toEqual({ ok: true, prs: 2, issues: 1 });
    expect(spawnSync.mock.calls[0]).toEqual(["gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: "/p", encoding: "utf8", timeout: 20000 }]);
    expect((spawnSync.mock.calls[1][1] as string[])).toEqual(["issue", "list", "--state", "open", "--limit", "100", "--json", "number"]);
  });

  it("ok:false when pr-list fails and does NOT call issue list", () => {
    const spawnSync = routeGh({ pr: { status: 1, stdout: "", stderr: "gh: auth required" } });
    const r = readGithubCountsAtPath("/p", { spawnSync: spawnSync as never });
    expect(r).toMatchObject({ ok: false, prs: 0, issues: 0 });
    expect(r.error).toMatch(/auth/);
    expect((spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("issue"))).toBeUndefined();
  });

  it("ok:false when issue-list fails after pr succeeds", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: "[]" }, issue: { status: 1, stderr: "issues disabled" } });
    const r = readGithubCountsAtPath("/p", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
  });

  it("ok:false on spawn error (gh missing / timeout)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("spawnSync gh ENOENT") });
    const r = readGithubCountsAtPath("/p", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });

  it("ok:false on malformed gh JSON (no throw)", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: "not json" }, issue: { status: 0, stdout: "[]" } });
    const r = readGithubCountsAtPath("/p", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad gh output/);
  });
});

describe("resolveRepoPath", () => {
  it("resolves a discovered project path", () => {
    expect(resolveRepoPath("/repo", "alpha", { discover: () => [{ id: "alpha", path: "/p/alpha" }], root: "/root" })).toBe("/p/alpha");
  });
  it("throws GithubError(404) for an unknown project", () => {
    expect(() => resolveRepoPath("/repo", "ghost", { discover: () => [], root: "/root" })).toThrow(GithubError);
  });
});

describe("createGithubCache", () => {
  it("caches within TTL, re-reads after TTL, and invalidate forces a re-read", () => {
    let calls = 0;
    let t = 0;
    const value = { ok: true, prs: 1, issues: 1 };
    const cache = createGithubCache({ read: () => { calls += 1; return value; }, ttlMs: 100, now: () => t });
    cache.get("/p"); // calls = 1 (fresh)
    cache.get("/p"); // calls = 1 (cached, within TTL)
    t = 200;
    cache.get("/p"); // calls = 2 (TTL expired)
    cache.invalidate("/p");
    cache.get("/p"); // calls = 3 (re-read after invalidate)
    expect(calls).toBe(3);
  });
});
