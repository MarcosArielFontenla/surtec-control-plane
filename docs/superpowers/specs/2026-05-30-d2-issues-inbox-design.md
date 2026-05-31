# D.2 — Unified GitHub-Issue Inbox (Design Spec)

**Date:** 2026-05-30
**Status:** Approved (design)
**Branch:** `feat/d2-issues-inbox`
**Theme:** D (cross-project work)

## Goal

One dashboard route that aggregates **open GitHub issues across every configured portfolio repo**
into a single flat, activity-sorted inbox — "what's open across all my projects" in one place. Built
on the A.2 GitHub model (read-only `gh`, registry-derived slugs), but aggregated cross-repo.

## Scope (v1)

- **Issues only.** Open issues across all GitHub repos. PRs are out of scope (already surfaced
  per-card by A.2; a PR tab is a noted follow-up).
- **New dedicated view** reachable from a new sidebar nav item **"Issues"**.
- **Flat list sorted by most-recently-updated**, with a **repo filter**. Each row: repo · #number ·
  title · labels · author · "hace X" · link to the issue on GitHub.

## Constraints / security (identical posture to A.2)

- Read-only `gh` only: `gh issue list --state open`. No client input ever reaches `gh`/argv/cwd.
- Slugs come from the **trusted registry** (`loadRegistryProjects` → `githubRepoSlug`), passed via
  `-R <owner/repo>` so `gh` never infers a fork's upstream. Fixed argv, **no shell**.
- **Never throws.** A repo whose `gh` call fails (missing/unauth/no-access/disabled-issues/bad JSON)
  becomes a per-repo error surfaced in the UI; the rest of the inbox still renders. Missing `gh`
  degrades the whole view to "GitHub no disponible".
- No new persisted state. No new product capability beyond reading issues.

## Architecture

### Async + bounded-parallel (the one notable departure from A.2)

A.2 reads one repo per card on demand with **synchronous** `spawnSync`. The inbox reads ~11 repos at
once; doing that with `spawnSync` would **block the event loop ~15s** (freezing the overview poll).
So the inbox uses **async** `execFile` and reads repos **in parallel with bounded concurrency (4)**,
cutting cold-load to ~5s and keeping the server responsive. Security is unchanged (argv array, no
shell). This realizes the async-aggregate follow-up noted in B.5.

### Server — `dashboard/src/server/github-inbox.ts` (new)

Types:
- `IssueItem = { number: number; title: string; url: string; updatedAt: string; labels: string[]; author: string | null }`
- `InboxItem = IssueItem & { projectId: string; slug: string }`
- `RepoStatus = { id: string; slug: string; ok: boolean; error?: string }`
- `Inbox = { items: InboxItem[]; repos: RepoStatus[] }`

Injectable runner for testability:
- `RunGh = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>` — default
  wraps `execFile("gh", args, {timeout})`, resolving (never rejecting) with a non-zero status + stderr
  on failure.

Functions:
- `readRepoIssues(slug, runGh): Promise<{ ok: boolean; issues: IssueItem[]; error?: string }>` —
  runs `gh issue list --state open --limit 100 --json number,title,url,updatedAt,labels,author -R <slug>`,
  parses (labels → `label.name[]`, author → `author.login ?? null`), never throws.
- `readInbox(repoRoot, deps?): Promise<Inbox>` — `loadRegistryProjects(repoRoot)` filtered to those
  with a `githubRepoSlug`; reads each repo via `readRepoIssues` with **bounded concurrency 4**;
  flattens ok repos' issues into `InboxItem[]` (stamping `projectId` + `slug`); **sorts by
  `updatedAt` desc**; collects per-repo `RepoStatus`. Never throws.
- `createInboxCache({ ttlMs?, now? }): { get(key, computeAsync): Promise<Inbox>; invalidate(key) }` —
  caches the **in-flight promise** keyed `"inbox"` (so concurrent opens share one fetch); TTL ~180s.
  On a settled fresh entry returns it; otherwise computes and stores. (`readInbox` never rejects, so
  no rejection-poisoning handling is needed beyond returning the cached promise.)

A small `mapWithConcurrency(items, limit, fn)` helper lives in this module (or a tiny shared util).

### Route — `dashboard/src/server/index.ts`

- `createApp` builds `const inboxCache = createInboxCache();` next to the other caches.
- `app.get("/api/inbox", async (c) => c.json(await inboxCache.get("inbox", () => readInbox(repoRoot))))`.
  Wrapped in try/catch → `{ error }` 500 only on an unexpected throw (readInbox itself never throws).

### Client — `dashboard/src/ui/api.ts`

- `getInbox(): Promise<Inbox>` — `GET /api/inbox` (same fetch+throw-on-!ok helper as the others).

### UI

- **Sidebar:** add `"Issues"` to `NAV_ITEMS` with a lucide `Inbox` icon. (Nav becomes Overview,
  Procesos, Issues, Proyectos, Tareas, Atención — or Issues placed after Procesos.)
- **App:** `Issues` is a real view (like Procesos). `view = nav === "Procesos" ? ... : nav === "Issues" ? "Issues" : "Overview"`; `onSelect` switches view for Overview/Procesos/**Issues**, scroll-anchors for Proyectos/Tareas/Atención. Topbar title "Issues". Renders `<IssuesView />`.
- **`dashboard/src/ui/views/IssuesView.tsx` (new):** on mount calls `getInbox()`. Shows a
  `section-head` ("Issues", total count), a **repo filter** `<select>` (All + each repo id present),
  then a `.panel` with a flat list of rows. Row: `repo` (mono) · `#number` · `title` (link to
  `url`, target _blank) · label chips · author · `relativeTime(updatedAt)`. States: **loading**
  ("cargando issues…"), **empty** ("sin issues abiertos"), and a **degraded note** listing repos
  whose fetch failed (from `inbox.repos.filter(!ok)`), plus a hard "GitHub no disponible" if every
  repo failed. Styled in the redesign vocabulary (`.panel`, mono data, label chips reuse `.badge-mini`/`.pill`).

## Data flow

`IssuesView` → `getInbox()` → `GET /api/inbox` → `inboxCache.get("inbox", () => readInbox(repoRoot))`
→ async parallel `gh` per repo → aggregated, sorted `Inbox`. No new persisted state; no change to the
overview/runs flows. `IssuesView` re-fetches each time it mounts (the view is opened); the 3-min
server cache makes reopening instant. No manual refresh button in v1 (a `?fresh=1` cache bypass is a
noted follow-up).

## Error handling

- Per-repo `gh` failure → `RepoStatus{ ok:false, error }`; that repo contributes no issues; the UI
  shows a degraded note. Other repos unaffected.
- `gh` entirely missing → every repo fails → UI shows "GitHub no disponible" with the detail.
- Unexpected server throw → 500 `{ error }`; the client surfaces it as a view-level error banner.
- Non-GitHub repos are silently skipped (not errors).

## Testing

- `dashboard/src/server/github-inbox.test.ts`: `readRepoIssues` (parses labels/author; never-throws on
  non-zero status / bad JSON → `{ok:false,error}`); `readInbox` (aggregates + sorts by `updatedAt`
  desc, skips non-GitHub repos, collects per-repo errors, uses registry slug via `-R`, respects
  concurrency) — injecting a fake `RunGh`. `createInboxCache` (TTL hit/miss; concurrent calls share
  one compute).
- `dashboard/src/server/index.test.ts`: `GET /api/inbox` returns the `Inbox` shape; degrades (no 500)
  when repos fail.
- `dashboard/src/ui/views/IssuesView.test.tsx`: renders the list, the repo filter narrows rows, and
  the loading/empty/degraded states.
- Gate: full suite (327 + new) green, `tsc --noEmit` clean, `vite build` clean, Playwright visual smoke
  of the Issues view.

## Slice / delivery

- Branch `feat/d2-issues-inbox`; TDD; merge `--no-ff` to master + push to origin.
- New dep: none (lucide-react already present).

## Out of scope (noted follow-ups)

- PRs tab; issue search/label/assignee filters; opening/commenting on issues from the dashboard;
  a `?fresh=1` cache bypass + a manual server-side refresh; surfacing the inbox count as a sidebar
  Resumen row or a KPI; pagination beyond 100/repo.
