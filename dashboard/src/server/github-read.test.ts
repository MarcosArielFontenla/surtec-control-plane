import { describe, it, expect, vi } from "vitest";
import { readGithubCounts, resolveRepoRef, createGithubCache, GithubError, readCiStatus } from "./github-read";

function routeGh(routes: { pr?: object; issue?: object }) {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("pr")) return routes.pr ?? { status: 0, stdout: "[]" };
    if (args.includes("issue")) return routes.issue ?? { status: 0, stdout: "[]" };
    return { status: 0, stdout: "[]" };
  });
}

describe("readGithubCounts", () => {
  it("returns counts and queries gh with -R <slug> (no cwd inference)", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: '[{"number":1},{"number":2}]' }, issue: { status: 0, stdout: '[{"number":5}]' } });
    expect(readGithubCounts("owner/repo", { spawnSync: spawnSync as never })).toEqual({ ok: true, prs: 2, issues: 1 });
    expect(spawnSync.mock.calls[0]).toEqual(["gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number", "-R", "owner/repo"], expect.objectContaining({ encoding: "utf8", timeout: 20000, env: expect.any(Object) })]);
    expect((spawnSync.mock.calls[1][1] as string[])).toEqual(["issue", "list", "--state", "open", "--limit", "100", "--json", "number", "-R", "owner/repo"]);
  });

  it("ok:false when pr-list fails and does NOT call issue list", () => {
    const spawnSync = routeGh({ pr: { status: 1, stdout: "", stderr: "gh: auth required" } });
    const r = readGithubCounts("owner/repo", { spawnSync: spawnSync as never });
    expect(r).toMatchObject({ ok: false, prs: 0, issues: 0 });
    expect(r.error).toMatch(/auth/);
    expect((spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("issue"))).toBeUndefined();
  });

  it("ok:false when issue-list fails after pr succeeds", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: "[]" }, issue: { status: 1, stderr: "issues disabled" } });
    const r = readGithubCounts("owner/repo", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
  });

  it("ok:false on spawn error (gh missing / timeout)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("spawnSync gh ENOENT") });
    const r = readGithubCounts("owner/repo", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });

  it("ok:false on malformed gh JSON (no throw)", () => {
    const spawnSync = routeGh({ pr: { status: 0, stdout: "not json" }, issue: { status: 0, stdout: "[]" } });
    const r = readGithubCounts("owner/repo", { spawnSync: spawnSync as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad gh output/);
  });
});

describe("resolveRepoRef", () => {
  it("resolves a github project to { slug, branch } from the registry", () => {
    const ref = resolveRepoRef("/repo", "alpha", {
      loadRegistry: () => [{ id: "alpha", repo: "https://github.com/MarcosArielFontenla/surtec-cli.git", default_branch: "dev" }],
    });
    expect(ref).toEqual({ slug: "MarcosArielFontenla/surtec-cli", branch: "dev" });
  });

  it("defaults branch to main when default_branch is null", () => {
    const ref = resolveRepoRef("/repo", "alpha", {
      loadRegistry: () => [{ id: "alpha", repo: "git@github.com:owner/repo.git", default_branch: null }],
    });
    expect(ref).toEqual({ slug: "owner/repo", branch: "main" });
  });

  it("returns null for a non-github project", () => {
    expect(resolveRepoRef("/repo", "alpha", { loadRegistry: () => [{ id: "alpha", repo: null, default_branch: null }] })).toBeNull();
  });

  it("throws GithubError(404) for an unknown project", () => {
    expect(() => resolveRepoRef("/repo", "ghost", { loadRegistry: () => [] })).toThrow(GithubError);
  });
});

describe("createGithubCache", () => {
  it("computes on a miss, caches within TTL, re-computes after TTL, and invalidate forces a re-compute", () => {
    let calls = 0;
    let t = 0;
    const overview = { ok: true, prs: 1, issues: 1, ci: "passing" as const };
    const cache = createGithubCache({ ttlMs: 100, now: () => t });
    const compute = () => { calls += 1; return overview; };
    cache.get("owner/repo", compute); // calls = 1 (fresh)
    cache.get("owner/repo", compute); // calls = 1 (cached, within TTL)
    t = 200;
    cache.get("owner/repo", compute); // calls = 2 (TTL expired)
    cache.invalidate("owner/repo");
    cache.get("owner/repo", compute); // calls = 3 (re-compute after invalidate)
    expect(calls).toBe(3);
  });
});

describe("readCiStatus", () => {
  it("queries gh run list with the exact argv and maps success → passing", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: '[{"status":"completed","conclusion":"success"}]' });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never })).toEqual({ state: "passing" });
    expect(spawnSync.mock.calls[0]).toEqual(["gh", ["run", "list", "--branch", "main", "--limit", "1", "--json", "status,conclusion", "-R", "owner/repo"], expect.objectContaining({ encoding: "utf8", timeout: 20000, env: expect.any(Object) })]);
  });

  it("maps completed+failure → failing", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: '[{"status":"completed","conclusion":"failure"}]' });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("failing");
  });

  it("maps an in-progress run → running", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: '[{"status":"in_progress","conclusion":null}]' });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("running");
  });

  it("maps an empty run list → none", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "[]" });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("none");
  });

  it("maps a gh error → unknown", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stderr: "gh: no workflows" });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("unknown");
  });

  it("maps a spawn error → unknown", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("ENOENT") });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("unknown");
  });

  it("maps malformed JSON → unknown (no throw)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "not json" });
    expect(readCiStatus("owner/repo", "main", { spawnSync: spawnSync as never }).state).toBe("unknown");
  });
});
