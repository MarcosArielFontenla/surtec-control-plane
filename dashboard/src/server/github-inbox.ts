import { execFile } from "node:child_process";
import { loadRegistryProjects } from "./registry";
import { githubRepoSlug } from "../../../lib/github-url";
import type { IssueItem, InboxItem, RepoStatus, Inbox } from "../../../lib/state/types";

export type RunGh = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

const TIMEOUT_MS = 20_000;
const TAIL_CHARS = 2000;

const defaultRunGh: RunGh = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const status = typeof code === "number" && code !== 0 ? code : 1;
        resolve({ status, stdout: stdout ?? "", stderr: (stderr ?? "") || err.message });
      } else {
        resolve({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

interface RawIssue { number?: number; title?: string; url?: string; updatedAt?: string; labels?: { name?: string }[]; author?: { login?: string } | null }

function toIssueItem(r: RawIssue): IssueItem {
  return {
    number: r.number ?? 0,
    title: r.title ?? "",
    url: r.url ?? "",
    updatedAt: r.updatedAt ?? "",
    labels: Array.isArray(r.labels) ? r.labels.map((l) => l.name ?? "").filter(Boolean) : [],
    author: r.author?.login ?? null,
  };
}

// Reads open issues for an EXPLICIT "owner/repo" slug via read-only gh (fixed argv, no shell,
// `-R slug` so gh never infers a fork's upstream). Never throws.
export async function readRepoIssues(slug: string, runGh: RunGh = defaultRunGh): Promise<{ ok: boolean; issues: IssueItem[]; error?: string }> {
  const r = await runGh(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,updatedAt,labels,author", "-R", slug]);
  if (r.status !== 0) return { ok: false, issues: [], error: (r.stderr + r.stdout).trim().slice(-TAIL_CHARS) };
  try {
    const arr = JSON.parse(r.stdout) as RawIssue[];
    return { ok: true, issues: (Array.isArray(arr) ? arr : []).map(toIssueItem) };
  } catch {
    return { ok: false, issues: [], error: "bad gh output" };
  }
}

interface ReadInboxDeps {
  loadRegistry?: (repoRoot: string) => { id: string; repo: string | null; default_branch?: string | null }[];
  runGh?: RunGh;
  concurrency?: number;
}

// Aggregates open issues across every configured GitHub repo (from the trusted registry), in parallel
// with bounded concurrency, sorted by updatedAt desc. Never throws — per-repo gh failures become
// RepoStatus{ ok:false } and contribute no issues.
export async function readInbox(repoRoot: string, deps: ReadInboxDeps = {}): Promise<Inbox> {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const runGh = deps.runGh ?? defaultRunGh;
  const limit = deps.concurrency ?? 4;

  const ghRepos = load(repoRoot)
    .map((p) => ({ id: p.id, slug: githubRepoSlug(p.repo) }))
    .filter((r): r is { id: string; slug: string } => r.slug !== null);

  const perRepo = await mapWithConcurrency(ghRepos, limit, async (r) => ({ repo: r, res: await readRepoIssues(r.slug, runGh) }));

  const items: InboxItem[] = [];
  const repos: RepoStatus[] = [];
  for (const { repo, res } of perRepo) {
    repos.push({ id: repo.id, slug: repo.slug, ok: res.ok, error: res.error });
    if (res.ok) for (const iss of res.issues) items.push({ ...iss, projectId: repo.id, slug: repo.slug });
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { items, repos };
}

export interface InboxCache { get(key: string, compute: () => Promise<Inbox>): Promise<Inbox>; invalidate(key: string): void }

// Caches the in-flight promise (keyed "inbox") so concurrent opens share one fetch; TTL ~3 min.
export function createInboxCache(opts: { ttlMs?: number; now?: () => number } = {}): InboxCache {
  const ttlMs = opts.ttlMs ?? 180_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<Inbox>; at: number }>();
  return {
    get(key, compute) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: now() });
      return value;
    },
    invalidate(key) { cache.delete(key); },
  };
}
