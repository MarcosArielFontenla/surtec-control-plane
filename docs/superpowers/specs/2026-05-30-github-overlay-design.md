# Surtec Control Plane — GitHub Overlay: open PRs + issues (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** GitHub overlay — open PR + issue counts per repo (theme A "live real status", slice A.2)
- **Builds on:** portfolio discovery (`2026-05-29-portfolio-discovery-design.md`), git-sync
  (`2026-05-30-git-sync-design.md`), the existing `gh` usage in `runner/github.ts` (PR creation)

## 1. Context & Goal

The dashboard shows each project's local git status (A.1). This slice adds the **GitHub dimension**: the
number of **open PRs** and **open issues** per repo, surfaced on the card. To keep the overview poll fast and
the server responsive, GitHub data is fetched **on-demand per card** (the user expands a "PRs · Issues"
control for the repo they care about), cached server-side with a short TTL. CI status and dependency
staleness are explicit later slices.

## 2. Key Decisions

- **Read-only `gh`, fixed argv, no shell.** Counts come from `gh pr list --state open --limit 100 --json
  number` and `gh issue list --state open --limit 100 --json number`, run with `cwd` = the repo's discovered
  path (gh infers owner/repo from the git remote). The client sends only the project `id`; no user input
  reaches the command. Same trust posture as `git-sync.ts`/`runner/github.ts`.
- **On-demand per card, not polled.** GitHub calls are network + `spawnSync` (block the event loop), so
  fetching all repos on every overview poll would freeze the server. Instead, each card has a "PRs · Issues"
  control that loads counts for that one repo when expanded (mirrors B.4's on-demand BranchControl), memoized
  in component state so re-opening doesn't refetch.
- **Server-side TTL cache (60s)** keyed by repo path (mirrors `git-status-cache`), so a page reload or a
  second card for the same repo doesn't re-hit `gh`.
- **Graceful degradation.** If `gh` is missing, unauthenticated, the repo isn't a GitHub repo, or issues are
  disabled, the read returns `{ ok:false, error }` and the card shows "GitHub: no disponible" — never throws.
- **`ok` requires BOTH calls to succeed** (v1 simplicity). A repo with issues disabled degrades to "no
  disponible"; counting PRs and issues independently is a noted follow-up.
- **Only open items, capped at 100** (`--limit 100`) — fine for a personal portfolio; the count is the array
  length of the returned JSON.
- **The card control is gated on `githubWebUrl(p.repo)` being non-null** — the same condition as the existing
  "GitHub" link, so it appears only for GitHub-configured repos and never collides with that link.

## 3. Scope

**In scope (v1):**

- `dashboard/src/server/github-read.ts` — `GithubCounts`, `GithubError`, `readGithubCountsAtPath`,
  `resolveRepoPath`, `createGithubCache`. Read-only gh; never throws except `GithubError`.
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/github`; a per-app `githubCache`.
- `dashboard/src/ui/api.ts` — `getGithubCounts(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `GithubCounts` sub-component (toggle → load → show
  counts / "no disponible").
- `dashboard/src/ui/styles/dashboard.css` — `.es-gh*` styles.

**Out of scope (later):** CI/checks status; dependency staleness; PR/issue *lists* (titles, links) vs counts;
counting PRs and issues independently; auto-load / a global "load all GitHub" action; surfacing GitHub data
for unconfigured repos (the control uses the registry `repo`, like the GitHub link).

## 4. Architecture

```
On-demand per card:
  expand "PRs · Issues" → api.getGithubCounts(id) → GET /api/projects/:id/github
    path = resolveRepoPath(repoRoot, id)            // discovery; unknown → GithubError(404)
    return githubCache.get(path)                     // TTL 60s; on miss → readGithubCountsAtPath(path)
      readGithubCountsAtPath(path):
        pr = gh pr list --state open --limit 100 --json number   (cwd: path, no shell, 20s timeout)
        if pr failed → { ok:false, prs:0, issues:0, error }
        iss = gh issue list --state open --limit 100 --json number
        if iss failed → { ok:false, prs:0, issues:0, error }
        → { ok:true, prs: parse(pr).length, issues: parse(iss).length }
    → 200 { ok, prs, issues, error? }
```

`spawnSync` and `discover` are injectable so the read and resolution are unit-testable without running gh.

## 5. Components

### `dashboard/src/server/github-read.ts`

```ts
export class GithubError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GithubError"; }
}

export interface GithubCounts { ok: boolean; prs: number; issues: number; error?: string }

interface GithubDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function readGithubCountsAtPath(path: string, deps?: Pick<GithubDeps, "spawnSync">): GithubCounts;
export function resolveRepoPath(repoRoot: string, id: string, deps?: GithubDeps): string;

export interface GithubCache { get(repoPath: string): GithubCounts; invalidate(repoPath: string): void }
export function createGithubCache(opts?: {
  read?: (path: string) => GithubCounts; ttlMs?: number; now?: () => number;
}): GithubCache;
```

- `readGithubCountsAtPath(path, deps?)`:
  - `pr = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, encoding:"utf8", timeout: 20_000 })`.
  - if `pr.status !== 0 || pr.error` → `{ ok:false, prs:0, issues:0, output→error }` (combined stderr/stdout/
    error message, trimmed/tail-capped 2000). Do NOT run the issue call.
  - else `iss = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, … })`; if it fails → `{ ok:false, …, error }`.
  - else parse each stdout as JSON (a `{ number }[]`); on a parse error → `{ ok:false, error:"bad gh output" }`.
    Return `{ ok:true, prs: prArr.length, issues: issArr.length }`. (Guard the parse with try/catch; an array
    of non-array shape → length 0 / treat as error.) Defensive `asStr` for `string|Buffer` like `git-sync.ts`.
  - Never throws.
- `resolveRepoPath`: `root = deps.root ?? SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, ignore =
  `DEFAULT_IGNORE + SURTEC_PROJECTS_IGNORE`; `proj = (deps.discover ?? discoverProjects)(root, ignore).find(p => p.id === id)`;
  if none → `throw new GithubError("unknown project: " + id, 404)`; else `return proj.path`. (Inline, like the
  other server modules.)
- `createGithubCache`: `read = opts.read ?? readGithubCountsAtPath`, `ttlMs = 60_000`, `now = Date.now`; a
  `Map<string,{value,at}>`; `get(path)` returns the cached value within TTL else `read(path)` and stores it;
  `invalidate(path)` deletes the key. (Same shape as `createGitStatusCache` + `invalidate`.)

### `dashboard/src/server/index.ts`

```ts
import { readGithubCountsAtPath, resolveRepoPath, createGithubCache, GithubError } from "./github-read";
// in createApp, next to gitStatusCache:
const githubCache = createGithubCache();

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

### `dashboard/src/ui/api.ts`

```ts
export async function getGithubCounts(
  id: string,
): Promise<{ ok: boolean; prs: number; issues: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/github`);
  if (!res.ok) throw new Error(`github failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; prs: number; issues: number; error?: string };
}
```

### `dashboard/src/ui/components/ProjectCard.tsx` — `GithubCounts` sub-component

- Render only when `githubWebUrl(project.repo)` is non-null (GitHub-configured repo).
- State: `open`, `loading`, `data: { ok; prs; issues; error? } | null`.
- A button **"PRs · Issues"** toggles `open`. On the first open (`!data`), `setLoading(true)` and
  `getGithubCounts(project.id).then(setData).catch((e) => setData({ ok:false, prs:0, issues:0, error:(e as Error).message })).finally(() => setLoading(false))`.
- When `open`: a line showing `cargando…` while loading; `PRs: {data.prs} · Issues: {data.issues}` when
  `data.ok`; `GitHub: no disponible` otherwise (with `data.error` in the `title`).
- Placed in the card after `<BranchControl project={p} />`. Reuses `.es-btn`; small `.es-gh*` styles.

## 6. Data Flow & State Transitions

No persisted state. GitHub counts are read-on-demand (control open), memoized in component state for the
card's lifetime; the server caches by path for 60s. No change to the overview poll, dispatch, Procesos,
review, git-sync, or branch ops.

## 7. Safety & Governance

- **Read-only**: only `gh pr list` / `gh issue list` (no mutation; PR *creation* stays in `runner/github.ts`).
- **No user input to the command**: the client sends only an `id`; the path is server-resolved via discovery;
  `gh` runs with a fixed argv and no `shell`.
- **Degrades, never throws**: missing/unauth gh, non-GitHub repo, disabled issues → `{ ok:false, error }`.
- 20s per-call timeout; 60s cache bounds how often gh is invoked.

## 8. Error Handling

- Unknown project → `GithubError` 404 (route maps it). Unexpected → 500.
- gh failure of any kind (auth, not found, non-github, parse) → `200 { ok:false, error }`; the card shows "no
  disponible". `readGithubCountsAtPath` never throws.
- The UI `getGithubCounts` throws only on a non-2xx HTTP; caught by the control → "no disponible" line.

## 9. Testing (TDD)

- `dashboard/src/server/github-read.test.ts`:
  - `readGithubCountsAtPath` with an injected spawnSync routing by argv: `pr list` → `[{number:1},{number:2}]`,
    `issue list` → `[{number:5}]` ⇒ `{ ok:true, prs:2, issues:1 }`.
  - pr-list fails (status 1, stderr "gh auth required") ⇒ `{ ok:false, prs:0, issues:0 }`, error contains
    "auth", and the issue call is NOT made.
  - issue-list fails after pr succeeds ⇒ `{ ok:false }` with the issue error.
  - spawn `error` (gh missing / ETIMEDOUT) ⇒ `{ ok:false }` with the message.
  - malformed JSON from gh ⇒ `{ ok:false }` (no throw).
  - `resolveRepoPath` with injected discover `[{id:"alpha",path:"/p/alpha"}]` → "/p/alpha"; unknown id →
    throws `GithubError` 404.
  - `createGithubCache`: with an injected `read` counter + `now`, `get` caches within TTL, re-reads after TTL,
    and `invalidate` forces a re-read.
- `dashboard/src/server/index.test.ts`: `GET /api/projects/:id/github` for an unknown project (pin
  `SURTEC_PROJECTS_ROOT` to an empty temp dir) → `404`. (The success path is covered by the unit test with an
  injected spawnSync — no real gh in the route test.)
- `dashboard/src/ui/components/ProjectCard.test.tsx`:
  - a project with a GitHub `repo` renders the **PRs · Issues** button; a non-GitHub project (`repo: null`)
    does not.
  - clicking the button fetches (stub `fetch` → `{ ok:true, prs:2, issues:5 }`) and shows "PRs: 2 · Issues: 5".
  - a `{ ok:false }` response shows "GitHub: no disponible".

## 10. Evolution Path

- CI/checks status of the default branch (`gh run list` / check-runs) — slice A.2b.
- Dependency staleness (`npm outdated --json`) — slice A.3.
- PR/issue *lists* with titles + links (expand the panel); independent pr/issue success; "my PRs" filter.
- Auto-load (staggered/background) or a global "refresh GitHub" with the BulkSync feedback model.
- Surface GitHub data for unconfigured repos by reading the live remote.

## 11. Open Questions

None blocking. `gh` must be installed and authenticated (it already is — used for PR creation); if not, the
overlay degrades to "no disponible". The 100-item cap is ample for a personal portfolio; counts beyond 100
would read as 100 (a documented, acceptable v1 limit).
