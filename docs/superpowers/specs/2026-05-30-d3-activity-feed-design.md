# D.3 — Cross-Project Activity Feed (Design Spec)

**Date:** 2026-05-30
**Status:** Approved (design)
**Branch:** `feat/d3-activity-feed`
**Theme:** D (cross-project work)

## Goal

One dashboard "Actividad" view: a single chronological timeline merging **recent git commits across all
portfolio repos** with **dispatched agent tasks** — "what moved across all my projects, newest first."

## Scope (v1)

- **Two event kinds, merged:** git commits (recent N per repo) + agent tasks (**one row per task**, at
  its current state). Sorted by timestamp descending, capped at 60 entries.
- **New dedicated view** reachable from a new sidebar nav item **"Actividad"**.
- A simple **kind filter** (Todo / Commits / Tareas).

## Constraints / security

- **Read-only local git** only (`git log -n …`, no fetch/network). Paths come from **discovery**
  (never client input). Never throws — a repo whose `git log` fails contributes zero commits.
- Tasks come from the local task store (`listTasks()`); no new persisted state.
- No `gh`/network. `spawnSync` is fine here (local `git log` is fast: ~12 repos × ~50ms ≈ ~1s),
  unlike the D.2 gh inbox — no async/parallel needed.

## Architecture

### Shared types — `lib/state/types.ts` (no node deps; importable by client)

```ts
export interface CommitActivity { kind: "commit"; at: string; project: string; hash: string; subject: string; author: string }
export interface TaskActivity   { kind: "task"; at: string; project: string; taskId: string; agent: string; title: string; state: string }
export type ActivityItem = CommitActivity | TaskActivity;
export interface ActivityFeed { items: ActivityItem[] }
```
`at` is an ISO timestamp used for sorting. `state` ∈ "despachada" | "en curso" | "hecha" | "aprobada" | "rechazada".

### Server — `dashboard/src/server/activity-read.ts` (new)

- `readRecentCommits(repoPath, limit = 8, deps?): CommitRow[]` — runs
  `git -C <repoPath> log -n <limit> --format=%H%x00%h%x00%s%x00%cI%x00%an` (read-only, local). Parses
  NUL-separated rows into `{ hash, shortHash, subject, at, author }`. Never throws → `[]` on any error.
  Injectable `spawnSync` for tests (same pattern as `git-status.ts`).
- `taskActivity(task): TaskActivity` — derives one row per `TaskRecord`:
  - `decision.status === "approved"` → state "aprobada", `at = decision.at`;
    `decision.status === "rejected"` → "rechazada", `at = decision.at`.
  - else `lifecycle === "finished"` → "hecha", `at = finished_at`.
  - else `lifecycle === "running"` → "en curso", `at = started_at ?? created_at`.
  - else (queued) → "despachada", `at = created_at`.
  - `project = envelope.project`, `agent = envelope.agent`, `title = envelope.title`, `taskId = envelope.id`.
- `buildActivityFeed(repoRoot, deps?): ActivityFeed` — discovers projects (paths), reads ~8 commits per
  git repo (stamping `project = discovered.id`), maps `listTasks()` via `taskActivity`, concatenates,
  **sorts by `at` desc**, **caps at 60**. Never throws. Injectable deps: `discover(root,ignore)`,
  `readCommits(path,limit)`, `listTasks()`, `perRepo`, `cap`.
- `createActivityCache({ ttlMs?, now? })` — single-key in-memory TTL cache (~15s) returning
  `ActivityFeed` (mirrors `createGitStatusCache`'s shape; sync `get(key, compute)`).

The route replicates the overview's discovery root logic
(`root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, the same ignore list).

### Route — `dashboard/src/server/index.ts`

- `const activityCache = createActivityCache();` next to the other caches.
- `app.get("/api/activity", (c) => { try { return c.json(activityCache.get("activity", () => buildActivityFeed(repoRoot))); } catch (err) { return c.json({ error }, 500); } });`
  (buildActivityFeed never throws; the try/catch is a backstop.)

### Client — `dashboard/src/ui/api.ts`

- `getActivity(): Promise<ActivityFeed>` — `GET /api/activity` (same fetch+throw-on-!ok helper).

### UI

- **Sidebar:** add `"Actividad"` to `NAV_ITEMS` with a lucide `Activity` icon (placed after Issues).
- **App:** `Actividad` is a real view (Overview/Procesos/Issues/**Actividad** switch; the scroll-anchor
  items unchanged). Topbar title "Actividad".
- **`dashboard/src/ui/views/ActivityView.tsx` (new):** on mount calls `getActivity()`. A `section-head`
  ("Actividad", count) + a segmented **kind filter** (Todo / Commits / Tareas) + a `.panel` timeline.
  Each row: a kind icon (commit → `GitCommitHorizontal`, task → `Bot`/`Zap`), the `project` (mono), the
  `subject`/`title`, meta (commit → `#shortHash · author`; task → `agent · state` badge), and
  `relativeTime(at)`. States: loading ("cargando actividad…"), empty ("sin actividad reciente").
  Redesign vocabulary (`.panel`, mono data, `.badge-mini` for the task state).

## Data flow

`ActivityView` → `getActivity()` → `GET /api/activity` → `activityCache.get(...)` → `buildActivityFeed`
(discovery → local `git log` per repo + `listTasks`) → merged, sorted, capped `ActivityFeed`. No new
persisted state. The view fetches once on mount; the 15s cache absorbs rapid view toggles.

## Error handling

- A repo whose `git log` fails (or isn't git) contributes no commits — never breaks the feed.
- An unexpected server throw → 500 `{ error }`; the client surfaces a view-level banner.
- Empty feed (no commits, no tasks) → "sin actividad reciente".

## Testing

- `dashboard/src/server/activity-read.test.ts`: `readRecentCommits` (parses NUL rows; never-throws on
  non-zero status → `[]`), `taskActivity` (each state derivation + `at` selection), `buildActivityFeed`
  (merges commits + tasks, sorts by `at` desc, caps at 60, skips non-git repos, one row per task) —
  injecting fake `discover`/`readCommits`/`listTasks`/`spawnSync`. `createActivityCache` (TTL hit/miss).
- `dashboard/src/server/index.test.ts`: `GET /api/activity` returns the `ActivityFeed` shape; never 500.
- `dashboard/src/ui/views/ActivityView.test.tsx`: renders the timeline, the kind filter narrows rows,
  loading/empty states.
- Gate: full suite (342 + new) green, `tsc --noEmit` clean, `vite build` clean, Playwright visual smoke
  of the Actividad view.

## Slice / delivery

- Branch `feat/d3-activity-feed`; TDD; merge `--no-ff` to master + push to origin.
- New dep: none (lucide-react already present).

## Out of scope (noted follow-ups)

- Per-project / per-author filters; pagination/"load more"; live auto-refresh (poll); PR/issue events in
  the feed; clickable rows (open commit on GitHub / jump to the task); date-grouped headers
  ("Hoy"/"Ayer"); the commit author's avatar.
