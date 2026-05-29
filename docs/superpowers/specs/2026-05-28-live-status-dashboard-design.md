# Surtec Control Plane — Live Status Dashboard (v1) — Design

- **Date:** 2026-05-28
- **Status:** Approved design (pre-implementation)
- **Slice:** Visibility / live status (first of several control-plane slices)

## 1. Context & Goal

The Surtec Control Plane is today a static scaffold: a declarative registry
(companies / projects / agents / routines / permissions / upstreams), a neutral
`TaskEnvelope` contract, JSON schemas, a Codex CLI runner (dry-run by default), a
conceptual Paperclip→TaskEnvelope adapter, skills, and an upstream monitor. It has
no live state and no UI.

**Goal of this iteration:** a local web dashboard that shows, at a glance, the
*live status* across Surtec projects. This is the first concrete step toward a
Paperclip-like control plane that Surtec fully owns and does not depend on the
upstream Paperclip repository.

## 2. Key Decisions

- **Executor pivot: Codex → Claude.** Future execution standardizes on Claude
  tooling (Claude Agent SDK / Claude Code), not Codex. The neutral `TaskEnvelope`
  and the registry/governance layer stay — they were designed executor-agnostic.
  Existing Codex pieces (`adapters/codex-runner`, `agents/codex/*`) are marked
  *deprecated*; `registry/companies.yml` `default_executor` becomes `claude`.
  Building the actual Claude runner belongs to the later "dispatch" slice, not this one.
- **First slice = Visibility / live status** (chosen over dispatch, review-gate,
  and portfolio planning, which are later slices).
- **Form factor = local web app** (vs TUI or static-site generator).
- **Approach A — lightweight, file-first** (vs Next.js + SQLite, vs realtime
  streaming). JSON-on-disk store, polling refresh, minimal dependencies. Designed
  so that moving to SQLite or adding SSE later is localized to the store interface.
- **v1 depth = Minimal:** store + state-writer + dashboard. Data is seeded via a
  small CLI and/or committed fixtures. No execution runner in v1.
- **`state/` is local (gitignored);** only `fixtures/` is versioned.
- **Main screen layout = A (classic panel):** sidebar navigation + grid (project
  cards on top; in-progress and pending-approval below).

## 3. Scope

**In scope (v1):**

- `lib/state` — the store interface: TS types, atomic JSON I/O, derived overview.
- `cli/surtec-state` — `record`, `set-status`, `seed` commands over `lib/state`.
- `dashboard` — local web app (Hono API + Vite/React UI, layout A) showing project
  cards, in-progress/history tasks, and an attention panel (risks + pending approvals).
- Mark Codex pieces deprecated and set `default_executor: claude` in the registry.

**Out of scope (future slices):**

- Dispatching tasks from the UI ("dispatch" slice).
- The Claude execution runner (Agent SDK headless) that performs real work.
- GitHub / CI integration, realtime streaming, authentication / multi-user.

## 4. Architecture

```
Task source (CLI / dashboard / GitHub …)
        │  emits
        ▼
   TaskEnvelope            ◄── neutral contract (kept as-is)
        │
        ▼
   Runner (Claude, future) ── writes state ──►  STATE STORE  ◄── reads ──  DASHBOARD (local web)
                                                (JSON on disk)             (Vite + React + Hono API)
```

In v1 there is no runner: the store is populated by the CLI / fixtures, and the
dashboard reads it. When the dispatch slice adds the Claude runner, it writes to the
same store and real data flows in with no dashboard change.

## 5. Data Model

On-disk layout:

```
state/                         # live store (local; gitignored)
  tasks/<task-id>.json         # canonical record per task
  projects/<project-id>.json   # manual status override (health, note)
fixtures/                      # versioned examples for dev/demo
  tasks/*.json   projects/*.json
```

Task record (`state/tasks/STK-001.json`):

```json
{
  "envelope":   { "...": "TaskEnvelope as-is: project, agent, title, sandbox, …" },
  "lifecycle":  "queued | running | finished",
  "outcome":    null,
  "created_at": "2026-05-28T12:00:00Z",
  "started_at": "…",
  "updated_at": "…",
  "finished_at": "…",
  "result":     null,
  "logs_path":  "reports/STK-001-….jsonl"
}
```

- `lifecycle` answers *where the task is in execution*; `outcome` (null until
  finished, then one of `completed | partial | blocked | failed | needs-review`,
  taken from `AgentResult.status`) answers *how it ended*. They are kept separate so
  the three dashboard views are unambiguous.
- `result` embeds the full `AgentResult` once the task finishes.

Derived views (computed on read, not stored):

- **Projects** = `registry/projects.yml` merged with the `state/projects/<id>.json`
  override; `last_activity` = max `updated_at` across the project's tasks.
- **In progress / history** = `lifecycle ∈ {queued, running}` vs `finished`
  (history sorted by `finished_at` descending).
- **Needs attention** = tasks with `outcome = needs-review`, or finished tasks with
  `envelope.requires_human_approval = true`, **plus** every `result.risks` and
  `result.blockers` flattened with a link back to its task. Note: v1 has no
  "approve" action (that is the review-gate slice); until then, any finished task
  that requires approval is shown as pending.

## 6. Components & API

Three units, each with a single responsibility and a clear boundary:

```
lib/state/                 # store interface (pure TS, no UI deps). The decoupling point.
  types.ts                 # TaskRecord, ProjectStatus, OverviewModel (TS mirror of the schemas)
  store.ts                 # atomic JSON read/write (tmp + rename); listTasks, readTask, upsertProject
  derive.ts                # buildOverview(registry, tasks, overrides) -> the three views
  paths.ts                 # resolves state/ and fixtures/ (override via env SURTEC_STATE_DIR)

cli/surtec-state.ts        # record | set-status | seed (thin wrapper over lib/state)

dashboard/                 # the web app (own package.json; repo root stays clean)
  src/server/index.ts      # Hono: API + serves the built UI
  src/ui/                  # React (layout A): Sidebar, ProjectCard, TaskList, AttentionPanel
  src/ui/api.ts            # fetch wrappers + polling hook
  index.html
```

Contracts between units:

- **`lib/state`** does not know a dashboard or a runner exists. It exposes pure
  functions plus file I/O. Migrating to SQLite/SSE later changes only this unit. It
  is imported by the CLI, the server, and (later) the Claude runner.
- **Server API** (minimal — two endpoints):
  - `GET /api/overview` → `{ projects[], inProgress[], history[], attention[] }`.
    One call powers the whole screen; the UI polls it every ~3s.
  - `GET /api/tasks/:id` → full `TaskRecord` (detail view).
- **UI** knows only those endpoints (`src/ui/api.ts`); it never touches disk.

New dependencies (minimal): `hono` (API), `vite` + `react` (UI), `yaml` (parse
`registry/*.yml`), `vitest` (tests). Package manager: **pnpm**. `lib/state` adds no
dependencies beyond `node:fs`.

Reuse / cleanup: `TaskEnvelope` / `AgentResult` are currently duplicated as TS types
in `adapters/paperclip-codex-adapter/src/types.ts` and in
`adapters/codex-runner/run-task.ts`. `lib/state/types.ts` becomes the canonical TS
mirror of the JSON schemas; the adapter is noted to later import from there (no
unrelated rewrite).

## 7. Error Handling

Resilience principle: one bad record must not break the screen.

- **Corrupt/partial task JSON** → `store.listTasks` skips it with a logged warning;
  the overview never crashes. Atomic `tmp` + `rename` writes prevent torn reads
  during polling.
- **Missing `state/` or `fixtures/`** → treated as empty; the dashboard still
  renders from `registry` data.
- **Unreadable `registry/*.yml`** → fail fast at server start (it is configuration,
  not runtime data — explicit beats silent).
- **Error in `/api/overview`** → 500 with a message; the UI keeps the last good
  snapshot and shows a non-blocking "could not refresh" banner, so a transient error
  does not blank the screen.
- **CLI** → validates input, refuses to write an invalid record, writes atomically.

## 8. Testing (TDD)

- **`lib/state`** (the core; highest coverage): write→read roundtrip; atomicity;
  `listTasks` ignores a corrupt file; `paths` honors `SURTEC_STATE_DIR`.
- **`derive.buildOverview`** against fixtures → asserts the three views, with edge
  cases: no tasks; `needs-review` detection; "awaiting approval"
  (`requires_human_approval`) detection; flattening of `risks`/`blockers` with task
  link; `last_activity` = max `updated_at`.
- **API** (Hono test client): shape of `/api/overview`; `/api/tasks/:id` found and 404.
- **UI** (light): one render of `App` with a mock overview → renders the three panels
  plus project cards. No exhaustive UI coverage.
- Test runner: **vitest** (fits Vite).

## 9. Evolution Path

- **Dispatch slice:** add the Claude runner (Agent SDK headless) that writes to the
  same store → real, live data with no dashboard change.
- **Store interface:** `lib/state` → SQLite when volume warrants; polling → SSE for
  realtime, both localized to the store/API layer.
- **Later slices:** GitHub/CI status, review-gate, portfolio planning.

## 10. Open Questions

None blocking. The exact CLI command surface (`record` / `set-status` / `seed` flags)
is left to the implementation plan.
