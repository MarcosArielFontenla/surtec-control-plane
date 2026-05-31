# D.2 — Unified GitHub-Issue Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard "Issues" view that aggregates open GitHub issues across all configured portfolio repos into one flat, activity-sorted, repo-filterable inbox.

**Architecture:** A new server module reads each GitHub repo's open issues via read-only async `gh` (`execFile`, bounded parallelism 4), aggregates+sorts them, and serves them at `GET /api/inbox` behind a 3-min promise-cache. A new `IssuesView` (reachable from a new "Issues" sidebar item, a real view like Procesos) fetches and renders the list. Security matches A.2 (registry-derived slug via `-R`, fixed argv, no shell, never-throws).

**Tech Stack:** TS ESM, Hono, Node `child_process.execFile`, React 18, Vitest + Testing Library/jsdom, lucide-react (already present), pnpm.

**Grounding (read for patterns):** `dashboard/src/server/github-read.ts` (A.2 gh model + `resolveRepoRef`/slug), `dashboard/src/server/index.ts:23-52,182-207` (`createApp(repoRoot)`, cache wiring, route shape), `dashboard/src/ui/api.ts:1-41` (fetch helpers), `lib/github-url.ts` (`githubRepoSlug`), `dashboard/src/server/registry.ts` (`loadRegistryProjects(repoRoot) → { id, repo, default_branch }[]`), `dashboard/src/ui/relative-time.ts` (`relativeTime`).

---

## File Structure

**Create:**
- `dashboard/src/server/github-inbox.ts` — `RunGh`, `mapWithConcurrency`, `readRepoIssues`, `readInbox`, `createInboxCache`.
- `dashboard/src/server/github-inbox.test.ts` — unit tests for the above.
- `dashboard/src/ui/views/IssuesView.tsx` — the Issues view.
- `dashboard/src/ui/views/IssuesView.test.tsx` — render tests.

**Modify:**
- `lib/state/types.ts` — add the shared `IssueItem`/`InboxItem`/`RepoStatus`/`Inbox` types (no node deps; importable by both server and client).
- `dashboard/src/server/index.ts` — `createInboxCache()` + `GET /api/inbox`.
- `dashboard/src/server/index.test.ts` — test `/api/inbox`.
- `dashboard/src/ui/api.ts` — `getInbox()`.
- `dashboard/src/ui/components/Sidebar.tsx` — add `"Issues"` nav item + icon.
- `dashboard/src/ui/App.tsx` — treat `Issues` as a real view.

**Naming contract (used across tasks — keep identical):**
- Types in `lib/state/types.ts`: `IssueItem { number:number; title:string; url:string; updatedAt:string; labels:string[]; author:string|null }`, `RepoStatus { id:string; slug:string; ok:boolean; error?:string }`, `InboxItem = IssueItem & { projectId:string; slug:string }`, `Inbox { items:InboxItem[]; repos:RepoStatus[] }`.
- `github-inbox.ts` exports: `RunGh` type, `readRepoIssues(slug, runGh?)`, `readInbox(repoRoot, deps?)`, `createInboxCache(opts?)`, `InboxCache` interface.
- `api.ts`: `getInbox(): Promise<Inbox>`.

---

## Task 1: Inbox types + readRepoIssues + concurrency helper

**Files:**
- Modify: `lib/state/types.ts`
- Create: `dashboard/src/server/github-inbox.ts`
- Test: `dashboard/src/server/github-inbox.test.ts`

- [ ] **Step 1: Add the shared types**

Append to `lib/state/types.ts`:

```ts
// --- D.2 cross-project GitHub-issue inbox ---
export interface IssueItem {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  labels: string[];
  author: string | null;
}
export interface RepoStatus { id: string; slug: string; ok: boolean; error?: string }
export type InboxItem = IssueItem & { projectId: string; slug: string };
export interface Inbox { items: InboxItem[]; repos: RepoStatus[] }
```

- [ ] **Step 2: Write the failing test (readRepoIssues + mapWithConcurrency)**

```ts
// dashboard/src/server/github-inbox.test.ts
import { describe, it, expect } from "vitest";
import { readRepoIssues, mapWithConcurrency, type RunGh } from "./github-inbox";

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: FAIL — cannot find module `./github-inbox`.

- [ ] **Step 4: Implement readRepoIssues + helpers**

```ts
// dashboard/src/server/github-inbox.ts
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

// Reads open issues for an EXPLICIT "owner/repo" slug via read-only gh. Never throws.
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add lib/state/types.ts dashboard/src/server/github-inbox.ts dashboard/src/server/github-inbox.test.ts
git commit -m "feat(inbox): Inbox types + readRepoIssues + mapWithConcurrency (read-only gh, never-throws)"
```

---

## Task 2: readInbox (aggregate + sort + per-repo status)

**Files:**
- Modify: `dashboard/src/server/github-inbox.ts`
- Modify: `dashboard/src/server/github-inbox.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `github-inbox.test.ts`:

```ts
import { readInbox } from "./github-inbox";

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
        { id: "local", repo: null }, // skipped — not GitHub
      ]),
      runGh,
    });
    expect(inbox.items.map((i) => i.number)).toEqual([2, 1]); // newest first
    expect(inbox.items[0]).toMatchObject({ projectId: "beta", slug: "owner/beta", labels: ["bug"] });
    expect(inbox.repos).toHaveLength(2); // only the two github repos
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: FAIL — `readInbox` not exported.

- [ ] **Step 3: Implement readInbox**

Append to `github-inbox.ts`:

```ts
interface ReadInboxDeps {
  loadRegistry?: (repoRoot: string) => { id: string; repo: string | null; default_branch?: string | null }[];
  runGh?: RunGh;
  concurrency?: number;
}

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/server/github-inbox.ts dashboard/src/server/github-inbox.test.ts
git commit -m "feat(inbox): readInbox aggregates issues cross-repo (parallel, sorted, per-repo status)"
```

---

## Task 3: createInboxCache (promise cache, TTL, concurrency-dedupe)

**Files:**
- Modify: `dashboard/src/server/github-inbox.ts`
- Modify: `dashboard/src/server/github-inbox.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `github-inbox.test.ts`:

```ts
import { createInboxCache } from "./github-inbox";
import type { Inbox } from "../../../lib/state/types";

const emptyInbox: Inbox = { items: [], repos: [] };

describe("createInboxCache", () => {
  it("serves a cached value within the TTL and recomputes after it", async () => {
    let t = 0; let calls = 0;
    const cache = createInboxCache({ ttlMs: 100, now: () => t });
    const compute = async () => { calls++; return emptyInbox; };
    await cache.get("inbox", compute);
    await cache.get("inbox", compute);
    expect(calls).toBe(1); // cached
    t = 200;
    await cache.get("inbox", compute);
    expect(calls).toBe(2); // recomputed past TTL
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: FAIL — `createInboxCache` not exported.

- [ ] **Step 3: Implement createInboxCache**

Append to `github-inbox.ts`:

```ts
export interface InboxCache { get(key: string, compute: () => Promise<Inbox>): Promise<Inbox>; invalidate(key: string): void }

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/github-inbox.test.ts`
Expected: PASS (all github-inbox tests).

- [ ] **Step 5: Commit**

```
git add dashboard/src/server/github-inbox.ts dashboard/src/server/github-inbox.test.ts
git commit -m "feat(inbox): createInboxCache (3-min promise cache, concurrency-dedupe)"
```

---

## Task 4: Route GET /api/inbox + api.getInbox

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Modify: `dashboard/src/server/index.test.ts`
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Add the failing route test**

Read `dashboard/src/server/index.test.ts` to match its `createApp` harness, then add:

```ts
it("GET /api/inbox returns the aggregated inbox shape", async () => {
  const app = createApp(/* repoRoot per the existing harness */);
  const res = await app.request("/api/inbox");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(Array.isArray(body.repos)).toBe(true);
});
```
(Use the same `createApp(...)` argument shape the other tests in that file use. With no `gh`/configured GitHub repos in the test env, `readInbox` returns `{ items: [], repos: [...] }` and never 500s — the assertion only checks the shape.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — `/api/inbox` 404 (route not defined).

- [ ] **Step 3: Implement the route**

In `dashboard/src/server/index.ts`:
- Add to the imports: `import { createInboxCache, readInbox } from "./github-inbox";`
- Next to the other caches (after `const depsCache = createDepsCache();`): `const inboxCache = createInboxCache();`
- Add the route (place it near the other `/api/projects/.../github` route or with the read routes):

```ts
  app.get("/api/inbox", async (c) => {
    try {
      return c.json(await inboxCache.get("inbox", () => readInbox(repoRoot)));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Add api.getInbox**

In `dashboard/src/ui/api.ts`:
- Add `Inbox` to the type import from `../../../lib/state/types`.
- Add:

```ts
export async function getInbox(): Promise<Inbox> {
  const res = await fetch("/api/inbox");
  if (!res.ok) throw new Error(`inbox failed: ${res.status}`);
  return (await res.json()) as Inbox;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts dashboard/src/ui/api.ts
git commit -m "feat(inbox): GET /api/inbox route + api.getInbox client"
```

---

## Task 5: Sidebar "Issues" nav item + App Issues view

**Files:**
- Modify: `dashboard/src/ui/components/Sidebar.tsx`
- Modify: `dashboard/src/ui/App.tsx`

(`Sidebar.test.tsx` iterates the original 5 items and still finds them; `App.test.tsx` never switches to Issues — both stay green without edits. The new `IssuesView` import is added here but rendered conditionally; it's created in Task 6, so do Task 6's file first OR add a tiny placeholder — see note.)

- [ ] **Step 1: Add "Issues" to the Sidebar nav**

In `dashboard/src/ui/components/Sidebar.tsx`:
- Import `Inbox` from lucide: `import { LayoutDashboard, Cpu, FolderGit2, ListChecks, Bell, Inbox, type LucideIcon } from "lucide-react";`
- Change `NAV_ITEMS` to: `export const NAV_ITEMS = ["Overview", "Procesos", "Issues", "Proyectos", "Tareas", "Atención"] as const;`
- Add to `NAV_ICON`: `Issues: Inbox,`

- [ ] **Step 2: Wire Issues as a real view in App**

In `dashboard/src/ui/App.tsx`:
- Import the view: `import { IssuesView } from "./views/IssuesView";`
- Change the view type + derivation:
```ts
  const view: "Overview" | "Procesos" | "Issues" =
    nav === "Procesos" ? "Procesos" : nav === "Issues" ? "Issues" : "Overview";
```
- In `onSelect`, treat Issues as a switch (not a scroll anchor):
```ts
  const onSelect = (item: NavItem) => {
    if (item === "Overview" || item === "Procesos" || item === "Issues") { setNav(item); return; }
    setNav("Overview");
    const id = ANCHOR[item];
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
```
- Topbar title: `<h1>{view === "Procesos" ? "Procesos" : view === "Issues" ? "Issues" : "Estado vivo"}</h1>`
- In the body, render the Issues view. Replace the `view === "Procesos" ? (...) : (...)` ternary with:
```tsx
          {view === "Procesos" ? (
            <ProcesosView projectIds={activeProjectIds} />
          ) : view === "Issues" ? (
            <IssuesView />
          ) : (
            <> ...the existing Overview body unchanged... </>
          )}
```

- [ ] **Step 3: Typecheck (expect a missing-module error until Task 6)**

Run: `pnpm exec tsc --noEmit`
Expected: FAIL only with "Cannot find module './views/IssuesView'" — resolved by Task 6. (Do Task 6 next; then re-run.) If you prefer green-between-tasks, implement Task 6 before committing Task 5 and commit them together.

- [ ] **Step 4: Commit (after Task 6 compiles)**

```
git add dashboard/src/ui/components/Sidebar.tsx dashboard/src/ui/App.tsx
git commit -m "feat(inbox): Issues sidebar nav item + App Issues view wiring"
```

---

## Task 6: IssuesView (flat list + repo filter + states)

**Files:**
- Create: `dashboard/src/ui/views/IssuesView.tsx`
- Create: `dashboard/src/ui/views/IssuesView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/src/ui/views/IssuesView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IssuesView } from "./IssuesView";
import * as api from "../api";
import type { Inbox } from "../../../../lib/state/types";

afterEach(() => vi.restoreAllMocks());

const inbox: Inbox = {
  items: [
    { number: 2, title: "beta issue", url: "https://gh/beta/2", updatedAt: "2026-05-20T00:00:00Z", labels: ["bug"], author: "b", projectId: "beta", slug: "owner/beta" },
    { number: 1, title: "alpha issue", url: "https://gh/alpha/1", updatedAt: "2026-05-01T00:00:00Z", labels: [], author: "a", projectId: "alpha", slug: "owner/alpha" },
  ],
  repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: true }],
};

describe("IssuesView", () => {
  it("loads and lists issues newest-first with title links", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    const link = screen.getByRole("link", { name: /beta issue/i });
    expect(link.getAttribute("href")).toBe("https://gh/beta/2");
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("filters by repo", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/repositorio/i), { target: { value: "alpha" } });
    expect(screen.queryByText("beta issue")).toBeNull();
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("shows the empty state when there are no issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "alpha", slug: "owner/alpha", ok: true }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/sin issues abiertos/i)).toBeTruthy());
  });

  it("shows a degraded note for repos whose gh failed", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "beta", slug: "owner/beta", ok: false, error: "no access" }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/no se pudo leer/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx`
Expected: FAIL — cannot find module `./IssuesView`.

- [ ] **Step 3: Implement IssuesView**

```tsx
// dashboard/src/ui/views/IssuesView.tsx
import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Inbox } from "../../../../lib/state/types";
import { getInbox } from "../api";
import { relativeTime } from "../relative-time";

export function IssuesView() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<string>("");

  useEffect(() => {
    let active = true;
    getInbox().then((i) => { if (active) { setInbox(i); setError(null); } }).catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const repoIds = useMemo(() => (inbox ? inbox.repos.map((r) => r.id) : []), [inbox]);
  const failed = inbox ? inbox.repos.filter((r) => !r.ok) : [];
  const allFailed = inbox != null && inbox.repos.length > 0 && failed.length === inbox.repos.length;
  const items = inbox ? (repo ? inbox.items.filter((i) => i.projectId === repo) : inbox.items) : [];

  return (
    <>
      <div className="section-head">
        <h2>Issues</h2>
        <span className="meta">{inbox ? `${items.length} abiertos` : "…"}</span>
      </div>

      <div className="field" style={{ maxWidth: 280, marginBottom: 16 }}>
        <label htmlFor="inbox-repo">Repositorio</label>
        <select id="inbox-repo" aria-label="Repositorio" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">Todos los repos</option>
          {repoIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>

      {error && <div className="banner banner--warn">No pude leer los issues ({error}).</div>}
      {allFailed && <div className="banner banner--danger">GitHub no disponible (¿gh instalado y autenticado?).</div>}
      {!allFailed && failed.length > 0 && (
        <div className="banner banner--warn">No se pudo leer: {failed.map((r) => r.id).join(", ")}.</div>
      )}

      {!inbox && !error ? (
        <p className="empty-mini">cargando issues…</p>
      ) : items.length === 0 ? (
        <div className="empty"><p>Sin issues abiertos</p></div>
      ) : (
        <div className="panel" style={{ padding: "6px 18px" }}>
          {items.map((i) => (
            <div key={`${i.slug}#${i.number}`} className="issue-row">
              <span className="issue-repo">{i.projectId}</span>
              <span className="issue-num">#{i.number}</span>
              <a className="issue-title" href={i.url} target="_blank" rel="noreferrer">{i.title} <ExternalLink /></a>
              <span className="issue-labels">{i.labels.map((l) => <span key={l} className="badge-mini">{l}</span>)}</span>
              {i.author && <span className="issue-author">@{i.author}</span>}
              <span className="issue-when">{i.updatedAt ? relativeTime(i.updatedAt) : ""}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Add IssuesView CSS**

Append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* issues inbox */
.issue-row { display:flex; align-items:center; gap:12px; padding:11px 2px; border-bottom:1px solid var(--border-soft); flex-wrap:wrap; }
.issue-row:last-child { border:none; }
.issue-repo { font-family: var(--font-mono); font-size:11px; color: var(--glacier-300); white-space:nowrap; }
.issue-num { font-family: var(--font-mono); font-size:11px; color: var(--fg-muted); }
.issue-title { flex:1; min-width:200px; display:inline-flex; align-items:center; gap:6px; font-size: var(--text-sm); color: var(--fg1); text-decoration:none; }
.issue-title:hover { color: var(--glacier-300); }
.issue-title svg { width:12px; height:12px; opacity:.6; }
.issue-labels { display:inline-flex; gap:5px; flex-wrap:wrap; }
.issue-author { font-family: var(--font-mono); font-size:11px; color: var(--fg-muted); }
.issue-when { font-family: var(--font-mono); font-size:11px; color: var(--fg3); white-space:nowrap; }
```

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx`
Expected: PASS (4 tests).
Run: `pnpm exec tsc --noEmit`
Expected: exit 0 (Task 5's import now resolves).

- [ ] **Step 6: Commit (Task 5 + Task 6 together)**

```
git add dashboard/src/ui/views/IssuesView.tsx dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/styles/dashboard.css dashboard/src/ui/components/Sidebar.tsx dashboard/src/ui/App.tsx
git commit -m "feat(inbox): IssuesView (flat list + repo filter + states) wired into the nav"
```

---

## Task 7: Verify + visual smoke + finish

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all green (327 + the new github-inbox/IssuesView/inbox-route tests).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit` → exit 0.
Run: `pnpm build` → `✓ built`.

- [ ] **Step 3: Live visual smoke**

If the user's dev server is up on :5173, screenshot the Issues view; otherwise spin an ephemeral dev server on a free port, screenshot, kill it (never leave a background dev server running).

Run: `node scripts/shot-page.mjs http://localhost:5173 .shots/issues.png ".sidebar"` then click the Issues nav (or navigate) — simplest: read `.shots/full.png` after switching, OR extend `scripts/shot.mjs` to click the Issues nav button. Confirm the Issues view renders the list (or the empty/degraded state, since the local env may have no `gh`).

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch**: verify tests, then merge `--no-ff` to master + push to origin (established flow), delete the branch. Update memory: add the D.2 slice to `live-status-dashboard-slice.md` (theme D now has D.1 notes + D.2 issues inbox; bump slice count + HEAD), refresh `MEMORY.md`.

---

## Self-Review

**1. Spec coverage:**
- Issues-only aggregation, read-only gh, registry slug via `-R`, never-throws → Task 1 (`readRepoIssues`) + Task 2 (`readInbox`). ✓
- Async + bounded-parallel (no event-loop freeze) → Task 1 (`RunGh` async `execFile`) + Task 2 (`mapWithConcurrency`, limit 4). ✓
- 3-min promise cache, concurrency-dedupe → Task 3 (`createInboxCache`). ✓
- Route `GET /api/inbox`, never-500 → Task 4. ✓
- `getInbox()` client → Task 4. ✓
- New "Issues" sidebar item + real view → Task 5. ✓
- Flat activity-sorted list + repo filter + loading/empty/degraded states → Task 6. ✓
- Types shared without node deps in client → Task 1 (types in `lib/state/types.ts`). ✓
- Tests (github-inbox, route, IssuesView) + gate → Tasks 1–3,4,6,7. ✓

**2. Placeholder scan:** No "TBD"/"add validation" placeholders. Task 4 Step 1 says "per the existing harness" for `createApp(...)` args — that's a deliberate instruction to match the file's existing pattern (the harness differs by repoRoot fixture); the assertion code is complete. Task 6 CSS + component are fully specified.

**3. Type consistency:** `IssueItem`/`InboxItem`/`RepoStatus`/`Inbox` defined in Task 1 (lib/state/types.ts) and consumed identically in Tasks 2 (`readInbox` returns `Inbox`), 3 (`createInboxCache` over `Inbox`), 4 (`getInbox(): Promise<Inbox>`), 6 (`IssuesView` consumes `Inbox`). `RunGh` signature `(args:string[]) => Promise<{status,stdout,stderr}>` consistent across Tasks 1–2 and tests. `readInbox(repoRoot, deps)` deps shape (`loadRegistry`/`runGh`/`concurrency`) consistent with the tests. `NAV_ITEMS` adds "Issues"; `NavItem` union auto-includes it. ✓
