import { describe, it, expect } from "vitest";
import { readRepoIssues, mapWithConcurrency, readInbox, createInboxCache, type RunGh } from "./github-inbox";
import type { Inbox } from "../../../lib/state/types";

const okGh = (issues: unknown[]): RunGh => async () => ({ status: 0, stdout: JSON.stringify(issues), stderr: "" });

describe("mapWithConcurrency", () => {
  it("maps all items preserving order, bounded by the limit", async () => {
    const seen: number[] = [];
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(seen).toHaveLength(5);
  });
});

describe("readRepoIssues", () => {
  it("parses issues (labels → names, author → login) on a clean gh call", async () => {
    const gh = okGh([
      { number: 7, title: "bug", url: "https://x/7", updatedAt: "2026-05-20T00:00:00Z", labels: [{ name: "bug" }, { name: "p1" }], author: { login: "marcos" } },
    ]);
    const r = await readRepoIssues("owner/repo", gh);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([
      { number: 7, title: "bug", url: "https://x/7", updatedAt: "2026-05-20T00:00:00Z", labels: ["bug", "p1"], author: "marcos" },
    ]);
  });

  it("never throws on a non-zero gh status → { ok:false, error }", async () => {
    const gh: RunGh = async () => ({ status: 1, stdout: "", stderr: "gh: not authenticated" });
    const r = await readRepoIssues("owner/repo", gh);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not authenticated");
    expect(r.issues).toEqual([]);
  });

  it("never throws on bad JSON → { ok:false, error:'bad gh output' }", async () => {
    const gh: RunGh = async () => ({ status: 0, stdout: "not json", stderr: "" });
    const r = await readRepoIssues("owner/repo", gh);
    expect(r).toEqual({ ok: false, issues: [], error: "bad gh output" });
  });

  it("passes the registry slug via -R and queries open issues", async () => {
    let argv: string[] = [];
    const gh: RunGh = async (args) => { argv = args; return { status: 0, stdout: "[]", stderr: "" }; };
    await readRepoIssues("owner/repo", gh);
    expect(argv).toEqual(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,updatedAt,labels,author", "-R", "owner/repo"]);
  });
});

const registry = (rows: { id: string; repo: string | null }[]) =>
  () => rows.map((r) => ({ id: r.id, repo: r.repo, default_branch: "main" }));

describe("readInbox", () => {
  it("aggregates GitHub repos' issues, stamps projectId/slug, sorts by updatedAt desc, and skips non-github", async () => {
    const issuesBySlug: Record<string, unknown[]> = {
      "owner/alpha": [{ number: 1, title: "old", url: "u1", updatedAt: "2026-05-01T00:00:00Z", labels: [], author: { login: "a" } }],
      "owner/beta": [{ number: 2, title: "new", url: "u2", updatedAt: "2026-05-20T00:00:00Z", labels: [{ name: "bug" }], author: { login: "b" } }],
    };
    const runGh: RunGh = async (args) => {
      const slug = args[args.indexOf("-R") + 1];
      return { status: 0, stdout: JSON.stringify(issuesBySlug[slug] ?? []), stderr: "" };
    };
    const inbox = await readInbox("/root", {
      loadRegistry: registry([
        { id: "alpha", repo: "git@github.com:owner/alpha.git" },
        { id: "beta", repo: "git@github.com:owner/beta.git" },
        { id: "local", repo: null },
      ]),
      runGh,
    });
    expect(inbox.items.map((i) => i.number)).toEqual([2, 1]);
    expect(inbox.items[0]).toMatchObject({ projectId: "beta", slug: "owner/beta", labels: ["bug"] });
    expect(inbox.repos).toHaveLength(2);
    expect(inbox.repos.every((r) => r.ok)).toBe(true);
  });

  it("records a per-repo error without dropping the other repos", async () => {
    const runGh: RunGh = async (args) => {
      const slug = args[args.indexOf("-R") + 1];
      if (slug === "owner/beta") return { status: 1, stdout: "", stderr: "no access" };
      return { status: 0, stdout: JSON.stringify([{ number: 1, title: "x", url: "u", updatedAt: "t", labels: [], author: null }]), stderr: "" };
    };
    const inbox = await readInbox("/root", {
      loadRegistry: registry([
        { id: "alpha", repo: "git@github.com:owner/alpha.git" },
        { id: "beta", repo: "git@github.com:owner/beta.git" },
      ]),
      runGh,
    });
    expect(inbox.items).toHaveLength(1);
    const beta = inbox.repos.find((r) => r.id === "beta")!;
    expect(beta.ok).toBe(false);
    expect(beta.error).toContain("no access");
  });
});

const emptyInbox: Inbox = { items: [], repos: [] };

describe("createInboxCache", () => {
  it("serves a cached value within the TTL and recomputes after it", async () => {
    let t = 0; let calls = 0;
    const cache = createInboxCache({ ttlMs: 100, now: () => t });
    const compute = async () => { calls++; return emptyInbox; };
    await cache.get("inbox", compute);
    await cache.get("inbox", compute);
    expect(calls).toBe(1);
    t = 200;
    await cache.get("inbox", compute);
    expect(calls).toBe(2);
  });

  it("dedupes concurrent computes (both callers share one in-flight promise)", async () => {
    let calls = 0;
    const cache = createInboxCache({ ttlMs: 1000, now: () => 0 });
    const compute = async () => { calls++; return emptyInbox; };
    const [a, b] = await Promise.all([cache.get("inbox", compute), cache.get("inbox", compute)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});
