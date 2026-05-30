# GitHub Overlay: open PRs + issues (A.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show open PR + issue counts per repo on its card, fetched on-demand via read-only `gh`, cached server-side 60s, degrading gracefully when gh is unavailable.

**Architecture:** A new `dashboard/src/server/github-read.ts` runs `gh pr list` / `gh issue list` (fixed argv, no shell, cwd = discovered repo path), parses the JSON array lengths, and never throws (degrades to `{ ok:false, error }`). A per-app TTL cache wraps reads by path. A `GET /api/projects/:id/github` route serves it; a per-card `GithubCounts` control loads it on demand. No mutation, no overview-poll changes.

**Tech Stack:** TypeScript ESM, Node `child_process.spawnSync`, GitHub CLI `gh`, Hono, React 18 + Vite, Vitest + Testing Library/jsdom. Windows/PowerShell host.

**Spec:** `docs/superpowers/specs/2026-05-30-github-overlay-design.md`

---

## File Structure

**Create:**
- `dashboard/src/server/github-read.ts` — `GithubCounts`, `GithubError`, `readGithubCountsAtPath`, `resolveRepoPath`, `createGithubCache`. Read-only gh; never throws except `GithubError`.
- `dashboard/src/server/github-read.test.ts`.

**Modify:**
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/github`; a per-app `githubCache`.
- `dashboard/src/server/index.test.ts` — a 404 route test.
- `dashboard/src/ui/api.ts` — `getGithubCounts(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `GithubCounts` sub-component.
- `dashboard/src/ui/components/ProjectCard.test.tsx` — github-counts tests.
- `dashboard/src/ui/styles/dashboard.css` — `.es-gh*` styles.

---

## Task 1: `github-read.ts` — read + resolve

**Files:**
- Create: `dashboard/src/server/github-read.ts`
- Test: `dashboard/src/server/github-read.test.ts`

- [ ] **Step 1: Write the failing tests** — Create `dashboard/src/server/github-read.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { readGithubCountsAtPath, resolveRepoPath, GithubError } from "./github-read";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/github-read.test.ts`
Expected: FAIL — `Cannot find module './github-read'`.

- [ ] **Step 3: Implement** — Create `dashboard/src/server/github-read.ts`:

```ts
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class GithubError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GithubError"; }
}

export interface GithubCounts { ok: boolean; prs: number; issues: number; error?: string }

const TIMEOUT_MS = 20_000;
const TAIL_CHARS = 2000;

interface SpawnDep {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}
interface ResolveDeps {
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

function ghErr(r: { stdout?: string | Buffer; stderr?: string | Buffer; error?: Error }): string {
  return (asStr(r.stderr) + asStr(r.stdout) + (r.error ? r.error.message : "")).trim().slice(-TAIL_CHARS);
}

function countOf(stdout: string | Buffer | undefined): number {
  const arr = JSON.parse(asStr(stdout)); // throws on bad JSON
  return Array.isArray(arr) ? arr.length : 0;
}

// Reads open PR + issue counts for a repo via read-only gh (fixed argv, no shell, cwd = repo path).
// Never throws — gh failures (missing/unauth/non-github/disabled-issues/bad-output) yield { ok:false, error }.
export function readGithubCountsAtPath(path: string, deps: SpawnDep = {}): GithubCounts {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const pr = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (pr.status !== 0 || pr.error) return { ok: false, prs: 0, issues: 0, error: ghErr(pr) };
  const iss = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (iss.status !== 0 || iss.error) return { ok: false, prs: 0, issues: 0, error: ghErr(iss) };
  try {
    return { ok: true, prs: countOf(pr.stdout), issues: countOf(iss.stdout) };
  } catch {
    return { ok: false, prs: 0, issues: 0, error: "bad gh output" };
  }
}

export function resolveRepoPath(repoRoot: string, id: string, deps: ResolveDeps = {}): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new GithubError(`unknown project: ${id}`, 404);
  return proj.path;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/github-read.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/github-read.ts dashboard/src/server/github-read.test.ts
git commit -m "feat(server): github-read readGithubCountsAtPath + resolveRepoPath"
```

---

## Task 2: `github-read.ts` — TTL cache

**Files:**
- Modify: `dashboard/src/server/github-read.ts`
- Test: `dashboard/src/server/github-read.test.ts`

- [ ] **Step 1: Add the failing test** — append to `dashboard/src/server/github-read.test.ts`:

```ts
import { createGithubCache } from "./github-read";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/github-read.test.ts`
Expected: FAIL — `createGithubCache` is not exported.

- [ ] **Step 3: Implement** — append to `dashboard/src/server/github-read.ts`:

```ts
export interface GithubCache { get(repoPath: string): GithubCounts; invalidate(repoPath: string): void }

export function createGithubCache(opts: {
  read?: (path: string) => GithubCounts; ttlMs?: number; now?: () => number;
} = {}): GithubCache {
  const read = opts.read ?? ((path: string) => readGithubCountsAtPath(path));
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: GithubCounts; at: number }>();
  return {
    get(repoPath: string): GithubCounts {
      const hit = cache.get(repoPath);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = read(repoPath);
      cache.set(repoPath, { value, at: t });
      return value;
    },
    invalidate(repoPath: string): void {
      cache.delete(repoPath);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/github-read.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/github-read.ts dashboard/src/server/github-read.test.ts
git commit -m "feat(server): createGithubCache (TTL 60s) for github counts"
```

---

## Task 3: `GET /api/projects/:id/github` route

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Add the failing test** — add this describe block to `dashboard/src/server/index.test.ts` (reuse the already-imported `mkdtempSync`/`rmSync`/`tmpdir`/`join` + the `process.env.SURTEC_PROJECTS_ROOT = … / delete in finally` pattern used by the `/git` and `/branch` 404 tests):

```ts
describe("github route", () => {
  it("GET /api/projects/:id/github for an unknown project → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-gh-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/github");
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
```

> The success path (real gh) is covered by `github-read.test.ts` with an injected spawnSync — not here.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — the `/github` route returns 404-not-found differently / route missing.

- [ ] **Step 3: Implement** — in `dashboard/src/server/index.ts`:

1. Add the import (next to the `git-branch` import):

```ts
import { resolveRepoPath, createGithubCache, GithubError } from "./github-read";
```

2. Inside `createApp`, next to the existing `const gitStatusCache = createGitStatusCache();`, add:

```ts
  const githubCache = createGithubCache();
```

3. After the `POST /api/projects/:id/branch` route (and before `return app;`), add:

```ts
  app.get("/api/projects/:id/github", (c) => {
    try {
      const path = resolveRepoPath(repoRoot, c.req.param("id"));
      return c.json(githubCache.get(path));
    } catch (err) {
      if (err instanceof GithubError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite (no regressions)**

Run: `pnpm exec vitest run dashboard/src/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(server): GET /api/projects/:id/github (cached open PR/issue counts)"
```

---

## Task 4: API client `getGithubCounts`

**Files:**
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Implement** — append to `dashboard/src/ui/api.ts`:

```ts
export async function getGithubCounts(
  id: string,
): Promise<{ ok: boolean; prs: number; issues: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/github`);
  if (!res.ok) throw new Error(`github failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; prs: number; issues: number; error?: string };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/api.ts
git commit -m "feat(ui): getGithubCounts(id) api client"
```

## Context for Task 4
Mirrors the existing `getBranches`/`gitSync` clients. A degraded GitHub read still returns HTTP 200 with `{ ok:false, error }` — so `getGithubCounts` only throws on a real HTTP error (404/500); the caller inspects `r.ok`.

---

## Task 5: ProjectCard `GithubCounts` + styles

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.test.tsx`
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Add failing tests** — add a new describe block to `dashboard/src/ui/components/ProjectCard.test.tsx`:

```tsx
describe("ProjectCard github counts", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ghP = (): ProjectView => ({ ...base, repo: "git@github.com:owner/repo.git" });

  it("renders no PRs·Issues button for a non-github repo", () => {
    render(<ProjectCard p={{ ...base, repo: null }} />);
    expect(screen.queryByRole("button", { name: /prs · issues/i })).toBeNull();
  });

  it("loads and shows counts on click", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, prs: 2, issues: 5 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={ghP()} />);
    fireEvent.click(screen.getByRole("button", { name: /prs · issues/i }));
    await waitFor(() => expect(screen.getByText(/PRs: 2 · Issues: 5/)).toBeTruthy());
    const get = (fetchMock.mock.calls as unknown[][]).find((c) => String(c[0]).endsWith("/api/projects/alpha/github"));
    expect(get).toBeTruthy();
  });

  it("shows 'no disponible' when the read degraded (ok:false)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, prs: 0, issues: 0, error: "gh auth required" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={ghP()} />);
    fireEvent.click(screen.getByRole("button", { name: /prs · issues/i }));
    await waitFor(() => expect(screen.getByText(/no disponible/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — no PRs · Issues button.

- [ ] **Step 3: Implement the `GithubCounts` sub-component** — in `dashboard/src/ui/components/ProjectCard.tsx`:

1. Add `getGithubCounts` to the api import (it currently imports `openProject, gitSync, getBranches, branchOp`):

```tsx
import { openProject, gitSync, getBranches, branchOp, getGithubCounts } from "../api";
```

2. Add a `GithubCounts` sub-component (place it next to the existing `GitLine`/`GitSyncRow`/`BranchControl` sub-components, above `export function ProjectCard`). Note `githubWebUrl` is already imported in this file:

```tsx
function GithubCounts({ project }: { project: ProjectView }) {
  const gh = githubWebUrl(project.repo);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ ok: boolean; prs: number; issues: number; error?: string } | null>(null);
  if (!gh) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      setLoading(true);
      getGithubCounts(project.id)
        .then(setData)
        .catch((e) => setData({ ok: false, prs: 0, issues: 0, error: (e as Error).message }))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className="es-gh">
      <button type="button" className="es-btn es-btn--ghost" onClick={toggle}>PRs · Issues</button>
      {open && (
        <span className="es-gh__counts" title={data?.error}>
          {loading ? "cargando…" : data?.ok ? `PRs: ${data.prs} · Issues: ${data.issues}` : "GitHub: no disponible"}
        </span>
      )}
    </div>
  );
}
```

3. Render it inside the card, right after the `<BranchControl project={p} />` line:

```tsx
      <GithubCounts project={p} />
```

- [ ] **Step 4: Add the CSS** — append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* github counts */
.es-gh { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
.es-gh__counts { font-size: var(--fs-caption); color: var(--ink-2); }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (existing ProjectCard tests + the 3 new github ones).

- [ ] **Step 6: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): ProjectCard GithubCounts (open PRs/issues, on-demand)"
```

## Context for Task 5
`GithubCounts` is a local sub-component (like `GitLine`/`GitSyncRow`/`BranchControl`). It renders only when `githubWebUrl(project.repo)` is non-null (a GitHub-configured repo — same gate as the existing GitHub link). Counts are fetched on the first panel open and memoized in component state (`!data` guard). A degraded read (`ok:false`) or a thrown HTTP error both render "GitHub: no disponible". `useState` is already imported. The CSS tokens (`--sp-*`, `--fs-caption`, `--ink-2`) already exist.

---

## Task 6: Full verification + manual smoke + finish the branch

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (existing 258 + new: github-read (8), github route (1), ProjectCard github (3)).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (REQUIRED — use the verification-before-completion skill)**

Start the API server (`PORT=4319 pnpm exec tsx dashboard/src/server/serve.ts` in the background). Then over HTTP against a REAL discovered GitHub repo:
- `GET /api/projects/<a-real-github-project>/github` → `200 { ok:true, prs:N, issues:M }` if `gh` is authed
  (or `{ ok:false, error }` if not — that is also a valid pass: the route ran and degraded, not 404/500).
- `GET /api/projects/__nope__/github` → `404`.
- (Optional) In the browser: open a project card with a GitHub repo, click **PRs · Issues**, confirm the
  counts (or "no disponible") appear; confirm a non-GitHub card has no such button.
- Confirm `gh auth status` first so you know which outcome to expect. If `gh` is authed, expect real counts.

Capture the actual observed output. If anything fails, switch to systematic-debugging. Kill the test server.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch — the project's established
per-slice flow. Then update the memory file `live-status-dashboard-slice.md` to add the A.2 slice.

---

## Self-Review (completed during planning)

- **Spec coverage:** read (readGithubCountsAtPath, fixed argv, degrade-not-throw, both-must-succeed, parse guard) → Task 1; resolveRepoPath (404) → Task 1; TTL cache → Task 2; route + cache instance → Task 3; api client → Task 4; ProjectCard GithubCounts (gated on githubWebUrl, on-demand load, counts/no-disponible) + CSS → Task 5; verification + finish → Task 6. All spec sections covered.
- **Placeholder scan:** no TODO/TBD; every code step has complete code (read, cache, route, api, component, tests, CSS, the routeGh test helper).
- **Type consistency:** `GithubCounts {ok,prs,issues,error?}` defined once (Task 1) and used identically in the cache (Task 2), route (Task 3), api (Task 4), and component (Task 5). `GithubError`/`readGithubCountsAtPath`/`resolveRepoPath`/`createGithubCache`/`GithubCache` names consistent across Tasks 1-3. `getGithubCounts(id)` signature consistent between Task 4 and Task 5.
