# Surtec Control Plane — Bulk Sync (Fetch-all / Pull-all) (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Bulk fetch/pull across all repos (theme B "actions from one place", slice B.5)
- **Builds on:** git sync (`2026-05-30-git-sync-design.md`), branch ops (`2026-05-30-branch-ops-design.md`),
  portfolio discovery (`2026-05-29-portfolio-discovery-design.md`)

## 1. Context & Goal

The dashboard can already Fetch/Pull/Push a single project (B.3). This slice delivers the **single-pane
payoff**: **Fetch-all** and **Pull-all** across the whole portfolio in one click, with live per-repo
feedback. It directly serves Marcos's core goal — orchestrate every project from one place instead of opening
them one by one. It is intentionally a **pure client-side orchestration** over the existing per-repo `/git`
endpoint; no new server code.

## 2. Key Decisions

- **Zero new server code.** The B.3 endpoint `POST /api/projects/:id/git { action }` already runs fetch/pull
  on one repo AND invalidates that repo's git-status cache on success. Bulk sync is a UI loop over the existing
  `gitSync(id, action)` client. This is the DRYest, lowest-risk path and reuses all of B.3 (validation, fixed
  argv, no-shell, ok:false-not-throw).
- **Sequential execution with live progress.** Repos run one at a time (`for … await`), each flipping
  `running → ok/failed` as it completes. Rationale: `runGitSync` uses `spawnSync` (blocks the Node event
  loop), so the server serializes concurrent requests anyway; sequential gives clean, ordered progress
  without fighting that. Buttons disable while a bulk run is in flight.
  - **v1 limitation (documented):** during a bulk run the server is busy (each `spawnSync` blocks), so the
    `/api/overview` poll pauses until it finishes. Acceptable for a localhost single-user tool; a server-side
    async-spawn bulk endpoint with bounded concurrency is a noted follow-up.
- **Actions:** **Fetch-all** (refs only — fully safe) and **Pull-all** (`git pull --ff-only` per repo from
  B.3 — never creates a merge/conflict; a non-ff repo fails cleanly and is shown). **Push-all is excluded**
  (outward-facing; per-repo push stays in B.3 behind its confirm).
- **Target set:** all **git-ok discovered repos** (`data.projects` where `p.git?.ok`). No per-repo selection
  in v1 (a selection UI is a follow-up).
- **Per-repo results, not aggregate output.** Each repo shows a status dot (ok/failed) + its id; the git
  output is available (e.g. `title`/expandable) but the list stays compact. Each card's git-line refreshes via
  the normal 3s overview poll (the cache was invalidated per repo on success).

## 3. Scope

**In scope (v1):**

- `dashboard/src/ui/components/BulkSync.tsx` — the toolbar (Fetch all / Pull all) + per-repo results list;
  sequential orchestration over `gitSync`.
- `dashboard/src/ui/App.tsx` — render `<BulkSync projectIds={…git-ok ids} />` above the "Proyectos" section
  in the Overview view.
- `dashboard/src/ui/styles/dashboard.css` — `.es-bulk*` styles.

**Out of scope (later):** a server-side async/concurrent bulk endpoint; per-repo selection/checkboxes;
bulk push; bulk branch ops; open terminal; `push -u`; cancel-mid-run; persisting bulk history.

## 4. Architecture

```
Bulk Fetch / Pull (client orchestration, no new server code):
  [Fetch all] / [Pull all] click → BulkSync.run(action):
    setRunning(true); set every id → { status: "running" }
    for (const id of projectIds) {           // sequential
      set id → { status: "running" }
      try { const r = await gitSync(id, action); set id → { status: r.ok ? "ok" : "failed", output: r.output } }
      catch (e) { set id → { status: "failed", output: e.message } }
    }
    setRunning(false)
  // each gitSync hits POST /api/projects/:id/git (B.3): runs git, invalidates that repo's cache on success.
  // ProjectCard git-lines refresh on the next /api/overview poll.
```

`gitSync` is the existing B.3 client; `BulkSync` injects nothing new server-side.

## 5. Components

### `dashboard/src/ui/components/BulkSync.tsx`

```ts
type RepoStatus = "idle" | "running" | "ok" | "failed";
interface RepoResult { status: RepoStatus; output?: string }

export function BulkSync({ projectIds }: { projectIds: string[] }): JSX.Element;
```

- Always renders the bar. When `projectIds` is empty, both buttons are disabled and no result rows render.
- State: `const [running, setRunning] = useState(false)` and
  `const [results, setResults] = useState<Record<string, RepoResult>>({})`.
- `run(action: "fetch" | "pull")`:
  - guard: if `running` return.
  - `setRunning(true)`; seed `results` to `{ [id]: { status: "running" } }` for all ids… actually set each to
    `idle` first, then flip to `running` as the loop reaches it (so the "current" repo is visibly active).
    Concretely: `setResults(Object.fromEntries(projectIds.map((id) => [id, { status: "idle" }])))` then in the
    loop set the current id to `running` before awaiting.
  - sequential loop as in §4, updating one id at a time via a functional `setResults((prev) => ({ ...prev, [id]: … }))`.
  - `finally` → `setRunning(false)`.
- Render:
  - a bar: a label "Sincronizar todo" + **Fetch all** and **Pull all** buttons (`.es-btn`), both
    `disabled={running || projectIds.length === 0}`.
  - a results list (only shown once a run has started / `results` non-empty): per id, a row with a status dot
    (`es-dot--muted` idle, `es-dot--info` running, `es-dot--ok` ok, `es-dot--danger` failed), the id, and the
    `output` as the row's `title` (hover) — kept compact.

### `dashboard/src/ui/App.tsx`

- In the Overview (non-Procesos) branch, inside the `{!data ? … : <>…</>}` block, render `<BulkSync
  projectIds={data.projects.filter((p) => p.git?.ok).map((p) => p.id)} />` immediately **above** the
  `<section><h4>Proyectos</h4>…</section>`.

### `dashboard/src/ui/styles/dashboard.css`

```css
.es-bulk { display: flex; flex-direction: column; gap: var(--sp-2); }
.es-bulk__bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.es-bulk__label { font-size: var(--fs-body-sm); font-weight: 600; }
.es-bulk__results { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); margin: 0; padding: 0; list-style: none; }
.es-bulk__row { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--ink-2); }
```

## 6. Data Flow & State Transitions

No persisted state. A bulk run sets each repo `idle → running → ok|failed`. Each `gitSync` success invalidates
that repo's git-status cache server-side, so the next `/api/overview` poll (~3s after the run finishes — the
poll pauses during the blocking run) reflects fresh ahead/behind on the cards. No change to
dispatch/Procesos/review/git-sync/branch.

## 7. Safety & Governance

- **Reuses B.3's trust model entirely** — every per-repo call goes through `POST /api/projects/:id/git`,
  which resolves the path server-side via discovery, runs a fixed git argv with no shell, and validates the
  action against the 3-value allowlist. Bulk sync sends only `"fetch"`/`"pull"` keys per discovered id.
- **No outward-facing action** — fetch updates refs only; pull is `--ff-only` (never a destructive merge).
  Push is deliberately excluded from bulk.
- **No new attack surface** — there is no new endpoint and no new server input; the client simply calls an
  existing, already-reviewed endpoint once per repo.

## 8. Error Handling

- A per-repo git failure (non-ff pull, no remote, offline) comes back as `gitSync` → `{ ok:false, output }`
  (HTTP 200) → that repo's row shows `failed` with the output in its `title`. The loop continues to the next
  repo (one repo failing never aborts the bulk).
- A thrown `gitSync` (HTTP 400/404/500 for a repo) is caught per-iteration → that repo `failed` with the
  error message; the loop continues.
- Empty `projectIds` → buttons disabled / component renders nothing actionable.

## 9. Testing (TDD)

- `dashboard/src/ui/components/BulkSync.test.tsx` (mock the `gitSync` api via `vi.spyOn(api, "gitSync")`):
  - **Fetch all** calls `gitSync(id, "fetch")` once per id in `projectIds` and renders a result row per id;
    after completion each row reflects the `ok` result.
  - a repo whose `gitSync` resolves `{ ok:false, output:"conflict" }` renders as `failed` (and the others as
    `ok`) — one failure does not abort the run.
  - the **Fetch all**/**Pull all** buttons are disabled while a run is in flight (assert disabled during, then
    re-enabled after `waitFor`), and **Pull all** sends `"pull"`.
  - empty `projectIds` → the buttons are disabled and no rows render.
- (App wiring is covered by the existing App test plus a quick manual check; the App test's fetch stub already
  returns an overview — adding `BulkSync` must not break it. If the existing App test asserts on text that
  `BulkSync` now also renders, adjust to a more specific query, mirroring how the B.4 branch-label collision
  was handled.)

## 10. Evolution Path

- A server-side bulk endpoint using async `spawn` with bounded concurrency (true parallelism; no event-loop
  freeze) + SSE progress.
- Per-repo selection (checkboxes) and a "stale only" / "behind only" filter for the bulk set.
- Bulk push (with an aggregate confirm), bulk branch switch, bulk run-command (Procesos).
- Cancel-mid-run; a summary line ("8 ok · 1 failed · 3 skipped").

## 11. Open Questions

None blocking. Bulk is an explicit user action, so the brief event-loop pause during a serialized run is
acceptable for v1; the async-bulk follow-up removes it. `gitSync` and the `/git` endpoint are already tested
and reviewed (B.3), so this slice adds only UI orchestration + its tests.
