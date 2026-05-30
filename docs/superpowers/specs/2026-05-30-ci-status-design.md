# Surtec Control Plane — CI Status of the Default Branch (A.2b) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** GitHub overlay — CI status of the default branch (theme A "live real status", slice A.2b)
- **Builds on / extends:** GitHub overlay PRs+issues (`2026-05-30-github-overlay-design.md`)

## 1. Context & Goal

The GitHub overlay (A.2) shows open PR + issue counts per repo on demand. This slice adds the **CI status of
the default branch** — "is `main`/`master` green?" — to the same on-demand control, via read-only `gh`. It's
a focused extension of A.2: same module, same `-R <registry slug>` fork-safe query, same on-demand + cache.

## 2. Key Decisions

- **Signal = the latest workflow run on the default branch**, via
  `gh run list --branch <default> --limit 1 --json status,conclusion -R <slug>`. Mapped to a small state set:
  - `passing` — `status:"completed", conclusion:"success"`.
  - `failing` — `status:"completed"` with any non-success conclusion (failure / cancelled / timed_out /
    startup_failure / action_required / neutral / skipped → all surfaced as failing for v1 simplicity).
  - `running` — `status` not `"completed"` (queued / in_progress / waiting / requested / pending).
  - `none` — empty run list (no Actions, or no runs on that branch).
  - `unknown` — gh error (missing / unauth / etc.).
- **Default branch from the trusted registry** (`default_branch`, fallback `"main"`); the slug from the
  registry repo (`githubRepoSlug`) — same fork-safe `-R` source as A.2.
- **CI is computed independently of the counts** and never blocks them. Even when the counts degrade
  (e.g. surtec-cli has issues disabled → `ok:false`), the CI state is still shown.
- **Folded into the existing on-demand control** — one `/github` fetch returns PRs, issues, AND ci; one
  cache entry per repo. No new endpoint, no auto-load, no new card control.
- **The cache becomes compute-per-get** (`get(key, compute)`) so the per-request `branch` can flow into the
  overview computation (the cache is created once per app and can't capture a per-request branch otherwise).
- **No rename** — `GithubCounts` / `getGithubCounts` keep their names; a `ci` field is added (minimal churn).

## 3. Scope

**In scope (v1):**

- `dashboard/src/server/github-read.ts` — add `CiState`, `readCiStatus(slug, branch, deps?)`; replace
  `resolveRepoSlug` with `resolveRepoRef(repoRoot, id, deps?)` → `{ slug, branch } | null`; refactor
  `createGithubCache` to `get(key, compute)`; add `ci` to `GithubCounts`.
- `dashboard/src/server/index.ts` — the `/github` route composes counts + ci into the response.
- `dashboard/src/ui/api.ts` — `getGithubCounts` return type gains `ci`.
- `dashboard/src/ui/components/ProjectCard.tsx` — the `GithubCounts` control renders a CI dot + label.
- `dashboard/src/ui/styles/dashboard.css` — a small CI line style (reuses `.es-dot*`).

**Out of scope (later):** aggregating ALL checks/check-runs for the head commit (vs the latest run); per-PR
checks; a clickable link to the run; distinguishing cancelled vs failed; CI for non-default branches;
dependency staleness (A.3); auto-load.

## 4. Architecture

```
On-demand (same control as A.2):
  expand "PRs · Issues" → api.getGithubCounts(id) → GET /api/projects/:id/github
    ref = resolveRepoRef(repoRoot, id)            // { slug, branch } | null ; unknown → GithubError(404)
    if !ref → { ok:false, prs:0, issues:0, ci:"unknown", error:"no es un repo de GitHub" }
    return githubCache.get(ref.slug, () => {        // TTL 60s; compute on miss
      const counts = readGithubCounts(ref.slug)     // { ok, prs, issues, error? }  (A.2, unchanged)
      const ci = readCiStatus(ref.slug, ref.branch) // { state }                    (A.2b, independent)
      return { ...counts, ci: ci.state }
    })
    → 200 { ok, prs, issues, ci, error? }
```

`spawnSync` and `loadRegistry` are injectable so the read + resolution are unit-testable without gh.

## 5. Components

### `dashboard/src/server/github-read.ts`

```ts
export type CiState = "passing" | "failing" | "running" | "none" | "unknown";
export interface GithubCounts { ok: boolean; prs: number; issues: number; ci: CiState; error?: string }

export function readCiStatus(slug: string, branch: string, deps?: { spawnSync?: ... }): { state: CiState };
export function resolveRepoRef(repoRoot: string, id: string, deps?: { loadRegistry?: ... }): { slug: string; branch: string } | null;
export interface GithubCache { get(key: string, compute: () => GithubCounts): GithubCounts; invalidate(key: string): void }
export function createGithubCache(opts?: { ttlMs?: number; now?: () => number }): GithubCache;
```

- `readCiStatus(slug, branch, deps?)`:
  - `r = spawnSync("gh", ["run", "list", "--branch", branch, "--limit", "1", "--json", "status,conclusion", "-R", slug], { encoding:"utf8", timeout:20000 })`.
  - if `r.status !== 0 || r.error` → `{ state: "unknown" }`.
  - parse stdout as JSON (`{status,conclusion}[]`), guarded by try/catch → on parse error `{ state:"unknown" }`.
  - empty array → `{ state:"none" }`.
  - `run = arr[0]`: `run.status === "completed"` → `run.conclusion === "success" ? "passing" : "failing"`;
    else → `"running"`. Never throws.
- `resolveRepoRef(repoRoot, id, deps?)`: `proj = (deps.loadRegistry ?? loadRegistryProjects)(repoRoot).find(p => p.id === id)`;
  if `!proj` → `throw new GithubError("unknown project: " + id, 404)`; `slug = githubRepoSlug(proj.repo)`;
  if `!slug` → `return null`; else `return { slug, branch: proj.default_branch ?? "main" }`. (Replaces the
  A.2 `resolveRepoSlug`; the registry loader already exposes `default_branch`.)
- `createGithubCache(opts?)`: `get(key, compute)` — return the cached value within `ttlMs` (60s) else
  `compute()` and store it; `invalidate(key)` deletes. (Was `get(slug)` with a fixed `read`; now the caller
  passes the compute closure so `branch` can be threaded in.)
- `readGithubCounts(slug, deps?)` — **unchanged** (A.2): `{ ok, prs, issues, error? }`. The `ci` field is
  merged onto its result by the route, never inside `readGithubCounts`.

### `dashboard/src/server/index.ts`

```ts
import { readGithubCounts, readCiStatus, resolveRepoRef, createGithubCache, GithubError } from "./github-read";

app.get("/api/projects/:id/github", (c) => {
  try {
    const ref = resolveRepoRef(repoRoot, c.req.param("id"));
    if (!ref) return c.json({ ok: false, prs: 0, issues: 0, ci: "unknown", error: "no es un repo de GitHub" });
    return c.json(githubCache.get(ref.slug, () => {
      const counts = readGithubCounts(ref.slug);
      const ci = readCiStatus(ref.slug, ref.branch);
      return { ...counts, ci: ci.state };
    }));
  } catch (err) {
    if (err instanceof GithubError) return c.json({ error: err.message }, err.status as 404);
    return c.json({ error: (err as Error).message }, 500);
  }
});
```

### `dashboard/src/ui/api.ts`

```ts
export async function getGithubCounts(
  id: string,
): Promise<{ ok: boolean; prs: number; issues: number; ci: "passing"|"failing"|"running"|"none"|"unknown"; error?: string }> { … }
```
(Only the return type gains `ci`; the body is unchanged.)

### `dashboard/src/ui/components/ProjectCard.tsx` — `GithubCounts`

- `data` type gains `ci`. The catch fallback becomes `{ ok:false, prs:0, issues:0, ci:"unknown", error }`.
- When `open` and not loading, render BELOW the counts line a **CI line**: a status dot + label, driven by
  `data.ci`:
  - `passing` → `es-dot--ok` · "CI: ok"
  - `failing` → `es-dot--danger` · "CI: falló"
  - `running` → `es-dot--info` · "CI: corriendo"
  - `none` → `es-dot--muted` · "CI: sin runs"
  - `unknown` (or no `data` yet / errored) → `es-dot--muted` · "CI: —"
- The CI line shows whenever `data` is present (independent of `data.ok`), so a counts-degraded repo still
  shows CI. The counts line keeps its A.2 behavior (`PRs: N · Issues: M` when `ok`, else "no disponible").

### `dashboard/src/ui/styles/dashboard.css`

```css
.es-gh__ci { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--ink-2); }
```

## 6. Data Flow & State Transitions

No persisted state. The `/github` response now carries `ci`; the card renders it. The cache memoizes the
whole `{ok,prs,issues,ci,error?}` per slug for 60s. No change to the overview poll, dispatch, Procesos,
review, git, or branch ops.

## 7. Safety & Governance

- **Read-only** gh: adds only `gh run list` (no mutation). Same posture as A.2 — fixed argv, **no shell**,
  `-R <registry slug>` (no client input, fork-safe).
- **Degrades, never throws**: any gh failure → `ci:"unknown"`; the route still maps `GithubError` 404 / 500.
- No new endpoint, no new attack surface; 20s per-call timeout; 60s cache.

## 8. Error Handling

- Unknown project → `GithubError` 404. Non-github project → `{ ok:false, ci:"unknown" }` (200).
- gh `run list` failure (no Actions API access, auth, etc.) → `ci:"unknown"`; PR/issue counts still computed
  independently. Malformed JSON → `ci:"unknown"`. `readCiStatus` never throws.
- The UI surfaces `ci` directly; a thrown HTTP error in `getGithubCounts` → the card's existing `err` path
  (counts "no disponible", and `ci` shows "—" since `data` is null).

## 9. Testing (TDD)

- `dashboard/src/server/github-read.test.ts`:
  - `readCiStatus` (injected spawnSync): empty `[]` → `none`; `[{status:"completed",conclusion:"success"}]` →
    `passing`; `[{status:"completed",conclusion:"failure"}]` → `failing`; `[{status:"in_progress",conclusion:null}]`
    → `running`; gh `status:1` or spawn `error` → `unknown`; malformed JSON → `unknown`; and the exact argv
    `["run","list","--branch","main","--limit","1","--json","status,conclusion","-R","owner/repo"]`.
  - `resolveRepoRef` (injected `loadRegistry`): a github project with `default_branch:"dev"` → `{slug, branch:"dev"}`;
    `default_branch:null` → branch `"main"`; a non-github project (`repo:null`) → `null`; unknown id → throws
    `GithubError` 404.
  - `createGithubCache`: `get(key, compute)` calls `compute` on a miss, returns the cached value within TTL
    (compute NOT called again), re-computes after TTL, and `invalidate` forces a re-compute.
  - `readGithubCounts` tests stay as-is (still `{ ok, prs, issues, error? }`).
- `dashboard/src/server/index.test.ts`: the existing `/github` 404 test still passes (now via `resolveRepoRef`).
- `dashboard/src/ui/components/ProjectCard.test.tsx`: the existing github tests gain `ci` in their stubbed
  responses; add a case asserting the CI dot/label renders for a `ci:"passing"` response (`es-dot--ok`) and
  for `ci:"failing"` (`es-dot--danger`), and that CI shows even when `ok:false`.

## 10. Evolution Path

- Aggregate all check-runs for the head commit (not just the latest run); a link to the failing run; cancelled
  vs failed distinction; CI for the current local branch (not just default); per-PR checks.
- Dependency staleness (A.3); a compact always-visible CI dot on the card (needs background/staggered loading).

## 11. Open Questions

None blocking. `gh run list` returns `[]` for repos without Actions (→ `none`), and errors only on auth/API
issues (→ `unknown`); both are handled. The "latest run on the default branch" is a deliberate simple proxy
for "is main green" (documented; check-run aggregation is the follow-up).
