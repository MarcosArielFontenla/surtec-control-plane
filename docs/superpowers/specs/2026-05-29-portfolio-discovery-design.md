# Surtec Control Plane — Portfolio Discovery + Live Git Status (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Portfolio discovery + git status (theme A "live status", slice A.1; first slice of the
  portfolio-control-plane direction)
- **Builds on:** the live-status dashboard (`2026-05-29-live-status-dashboard-design.md`)

## 1. Context & Goal

Marcos builds bespoke software products; every project lives as a git repo in one root folder
(`E:\product-projects`) and is deployed on GitHub. Today he opens them one by one (CLI / VS Code) and
the control plane's project list is a **manual, fictional** `registry/projects.yml` (placeholder paths
`~/dev/surtec/...` that don't exist on disk). This slice makes the dashboard show his **real projects**
— present and future — with **live local git status**, with zero manual upkeep.

**This slice is VISIBILITY only.** Dispatch (and dispatch-options) are unchanged; wiring discovery's
real paths into dispatch is the next step (theme B).

## 2. Key Decisions

- **Discovery is the source of truth for "what projects exist."** A scan of the root folder for git
  repos drives the project list. The `registry/projects.yml` becomes a **config overlay** (agents,
  sandbox, commands, default_branch, verify) matched by **folder name**. A discovered project with no
  registry entry is shown with live status but is **not dispatchable** (`configured: false`) until
  config is added. (Chosen over "registry drives the list" because the goal is present-and-future
  projects appearing automatically.)
- **Git status is local-only** (no network/fetch) so it is fast and dependency-free. `ahead/behind` are
  computed against the local `origin/<branch>` ref (may be stale until a manual fetch — a theme-B
  action). Reading never throws; a broken/edge repo yields `ok: false`.
- **Cached with a short TTL** (~15 s) so the dashboard's 3 s poll is cheap; git commands run with a
  timeout.
- **Root + ignore are configurable.** Root defaults to the control plane's parent folder
  (`dirname(repoRoot)`), overridable via `SURTEC_PROJECTS_ROOT`. Depth-1 scan. Default ignore = dot-
  folders + `node_modules`; extendable via `SURTEC_PROJECTS_IGNORE` (comma-separated names).
- **No git is run by the agent** (unchanged invariant) — discovery/status read git via the runner/server
  process only, read-only commands (`rev-parse`, `status --porcelain`, `rev-list`, `log -1`).

## 3. Scope

**In scope (v1):**

- `lib/discover.ts` — `discoverProjects(root, ignore)` → `DiscoveredProject[]`.
- `lib/git-status.ts` — `readGitStatus(repoPath)` → `GitStatus` (local git, timeout, never throws).
- `lib/git-status-cache.ts` — a small TTL cache (injectable `readStatus` + `now` for tests).
- `lib/portfolio.ts` — `assemblePortfolio(discovered, statusByPath, registryConfig)` → `PortfolioProject[]`
  (discovery drives the list; registry overlays config by id).
- `lib/state/types.ts` — `GitStatus`; `ProjectView` gains `path`, `configured`, `git`.
- `lib/state/derive.ts` — `buildOverview` accepts `PortfolioProject[]` and surfaces `path`/`configured`/
  `git` on each `ProjectView`.
- `dashboard/src/server/portfolio-config.ts` — `loadProjectConfig(repoRoot)` (registry entries by id:
  status, repo, allowed_agents, default_branch). (Refactor of the project-list read for the view.)
- `dashboard/src/server/index.ts` — `/api/overview` wires discovery + cached git status + config overlay
  into `buildOverview`.
- `dashboard/src/ui/components/ProjectCard.tsx` — render branch · dirty(N)/clean · ↑ahead ↓behind · last
  commit + a simple risk badge.

**Out of scope (later A slices / B):** GitHub PRs/issues/CI, dependency staleness, manual fetch/refresh,
non-git folders, depth > 1, and wiring discovery's real path into dispatch/dispatch-options (dispatch is
unchanged here).

## 4. Architecture

```
GET /api/overview:
  root      = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)
  ignore    = DEFAULT_IGNORE ∪ env SURTEC_PROJECTS_IGNORE
  discovered = discoverProjects(root, ignore)                    // [{ id, path }] for each depth-1 dir with .git
  statusByPath = Map(path → gitStatusCache.get(path))            // readGitStatus, cached TTL 15s, parallel
  config    = loadProjectConfig(repoRoot)                        // registry overlay by id
  portfolio = assemblePortfolio(discovered, statusByPath, config) // discovery drives; config overlays; configured = has allowed_agents
  overview  = buildOverview(portfolio, listTasks(), listProjectOverrides())
  → ProjectView[] now carries { path, configured, git }, plus existing status/health/note/last_activity/task_counts
```

`lib/*` stays dependency-free (Node built-ins + spawnSync git). git is read-only here.

## 5. Components

### `lib/discover.ts`
- `interface DiscoveredProject { id: string; path: string }` (`id` = folder name).
- `discoverProjects(root: string, ignore: string[] = DEFAULT_IGNORE): DiscoveredProject[]` — read the
  root's immediate entries; for each directory whose name is not ignored and not dot-prefixed, include it
  iff `<dir>/.git` exists (dir or file — worktrees use a `.git` file). Sorted by id. Returns `[]` if the
  root is missing (never throws).
- `const DEFAULT_IGNORE = ["node_modules"]` (dot-folders are skipped by rule, not by list).

### `lib/git-status.ts`
```ts
export interface GitStatus {
  branch: string | null;        // null when detached/unknown
  dirty: boolean;
  uncommitted: number;          // count of porcelain entries (changed + untracked)
  ahead: number;
  behind: number;
  last_commit: { hash: string; subject: string; at: string } | null; // at = committer ISO date
  ok: boolean;                  // false when git reads fail
}
export function readGitStatus(repoPath: string): GitStatus;
```
Implementation: a private `git(args)` helper (`spawnSync("git", ["-C", repoPath, ...args], { timeout })`).
- branch: `rev-parse --abbrev-ref HEAD` (`HEAD` → detached → `null`).
- porcelain: `status --porcelain` → `uncommitted` = non-empty line count; `dirty` = count > 0.
- ahead/behind: `rev-list --left-right --count @{upstream}...HEAD` → `[behind, ahead]`; if no upstream
  (non-zero exit) → both 0.
- last_commit: `log -1 --format=%h%x00%s%x00%cI` split on NUL → `{ hash, subject, at }`; empty repo → null.
- Any spawn failure / non-repo → `{ ok: false, branch: null, dirty: false, uncommitted: 0, ahead: 0,
  behind: 0, last_commit: null }`. Never throws.

### `lib/git-status-cache.ts`
- `createGitStatusCache(opts: { readStatus?: (p) => GitStatus; ttlMs?: number; now?: () => number })` →
  `{ get(repoPath): GitStatus }`. Module keeps a `Map<path, { value, at }>`; `get` returns the cached
  value when `now() - at < ttlMs`, else recomputes via `readStatus`. Defaults: `readStatus = readGitStatus`,
  `ttlMs = 15_000`, `now = Date.now`. (Injectable deps make TTL behavior unit-testable without timers.)

### `lib/portfolio.ts`
```ts
export interface PortfolioProject {
  id: string;
  path: string | null;
  status: string;               // config status, else "discovered"
  repo: string | null;          // config repo remote, else null
  allowed_agents?: string[];
  default_branch?: string | null;
  configured: boolean;          // has a registry config entry with allowed_agents
  git: GitStatus | null;
}
export function assemblePortfolio(
  discovered: DiscoveredProject[],
  statusByPath: Map<string, GitStatus>,
  config: Map<string, ProjectConfig>,            // by id
): PortfolioProject[];
```
- One entry per discovered project. `cfg = config.get(id)`. `configured = !!cfg?.allowed_agents?.length`.
  `status = cfg?.status ?? "discovered"`. `repo = cfg?.repo ?? null`. `git = statusByPath.get(path) ?? null`.
- Registry config entries with **no** matching discovered folder are dropped from the view in v1 (a future
  slice may show them as "missing"). Sorted by id.

### `lib/state/types.ts`
- Add `GitStatus` (mirror of the runner type, or import it).
- `ProjectView` gains: `path: string | null; configured: boolean; git: GitStatus | null;`.

### `lib/state/derive.ts`
- `buildOverview(projects: PortfolioProject[], tasks, overrides)` — for each project, the `ProjectView`
  now includes `path`, `configured`, `git`, alongside the existing `status/health/note/repo/last_activity/
  task_counts`. The attention/history/in-progress logic is unchanged. (`PortfolioProject` is a superset of
  the old project-input shape; the extra fields default through, so existing assertions still hold.)

### `dashboard/src/server/portfolio-config.ts`
- `interface ProjectConfig { id: string; status?: string; repo?: string|null; allowed_agents?: string[];
  default_branch?: string|null }`.
- `loadProjectConfig(repoRoot): Map<string, ProjectConfig>` — read `registry/projects.yml` and index the
  entries by id (reuses the existing yaml read; returns a Map). The existing `loadRegistryProjects`
  (used by dispatch) is **unchanged**.

### `dashboard/src/server/index.ts`
- `/api/overview` builds the portfolio (discovery + cached git status + config overlay) and calls
  `buildOverview(portfolio, listTasks(), listProjectOverrides())`. A module-level git-status cache is
  created once. Errors degrade: discovery/status failures yield an empty/`ok:false` entry, never a 500.

### `dashboard/src/ui/components/ProjectCard.tsx`
- Render the git line when `git` is present: `⎇ <branch>` · `● N sin commitear` (or `✓ limpio`) ·
  `↑<ahead> ↓<behind>` · `<last_commit.subject> · <relative time>`. A small badge: red when
  `dirty || behind > 0`, gray otherwise. Show `configurado`/`sin configurar` chip from `configured`.
  When `git?.ok === false`, show `git: no disponible`.

## 6. Data Flow & State Transitions

No persistence change. Discovery + git status are computed per `/api/overview` request (git status
cached ~15 s). The project list is now disk-driven; the YAML overlays config. Project status overrides
(health/note) still apply by id. Tasks/attention unchanged.

## 7. Safety & Governance

- All git commands are **read-only** (`rev-parse`, `status`, `rev-list`, `log`) run by the server
  process with a timeout. No fetch/push/network. The agent never runs git (unchanged).
- Discovery only reads directory names + checks for `.git`; it does not read file contents.
- No secrets, no outward calls. Failures degrade to `ok:false`, never crash the overview.

## 8. Error Handling

`discoverProjects` returns `[]` on a missing/unreadable root. `readGitStatus` returns `ok:false` on any
git failure. The cache simply recomputes on miss. `/api/overview` keeps its existing try/catch → 500 only
on a truly unexpected error; per-project status failures are contained in the `git` field.

## 9. Testing (TDD)

- `lib/discover.test.ts`: temp root with dirs (some with `.git` dir, one with a `.git` FILE = worktree,
  some without, one dot-folder, one in the ignore list) → returns only the git dirs, sorted, excluding
  ignored/dot; missing root → `[]`.
- `lib/git-status.test.ts` (real temp git repos): clean repo → `dirty:false, uncommitted:0`, branch set,
  `last_commit` populated; a dirty repo (untracked + modified) → `dirty:true` with the right count; a repo
  with a bare-remote upstream and a local commit ahead → `ahead:1`; a non-repo dir → `ok:false`.
- `lib/git-status-cache.test.ts`: injected `readStatus` spy + controllable `now` → second `get` within
  TTL does NOT recompute; after TTL advances, it recomputes.
- `lib/portfolio.test.ts`: discovered + config(by id) → `configured:true` and overlaid status/repo for
  matched ids; discovered without config → `configured:false`, `status:"discovered"`, git attached;
  config without a discovered folder → absent from the result.
- `lib/state/derive.test.ts` (extend): a `PortfolioProject` with `git`/`path`/`configured` surfaces those
  on the `ProjectView`; existing assertions still pass.
- `dashboard/src/server/portfolio-config.test.ts`: `loadProjectConfig` indexes registry entries by id with
  allowed_agents/status/repo.
- `dashboard/src/ui/components/ProjectCard.test.tsx`: renders branch/dirty/ahead-behind/last-commit and the
  configured chip; `git.ok===false` → "no disponible"; no `git` → no git line.

## 10. Evolution Path (next A/B slices)

- Wire discovery's real `path` into dispatch (createTask repo_path + dispatch-options from configured
  discovered projects). Show registry config with no folder as "missing".
- GitHub overlay: open PRs/issues, CI/checks (gh). Dependency staleness. Manual fetch/refresh action (B).
- Quick actions: open in VS Code/terminal/GitHub, run dev/build/test, git pull/push (B).
- Cross-project activity feed + unified GitHub-issue inbox (D).

## 11. Open Questions

None blocking. The clone `paperclip-ref` will appear as a discovered project; add it to
`SURTEC_PROJECTS_IGNORE` or delete the clone. The current fictional registry entries will simply not
overlay onto any real folder until renamed to match real folder names.
