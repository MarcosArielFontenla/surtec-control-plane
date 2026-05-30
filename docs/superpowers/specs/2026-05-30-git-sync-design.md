# Surtec Control Plane — Git Sync (Fetch / Pull / Push) (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Git sync actions from the project card (theme B "actions from one place", slice B.3)
- **Builds on:** project open actions (`2026-05-30-project-open-actions-design.md`), portfolio discovery
  (`2026-05-29-portfolio-discovery-design.md`), run-commands/Procesos (`2026-05-30-run-commands-procesos-design.md`)

## 1. Context & Goal

The dashboard already shows each project's live local git status — branch, dirty count, and **ahead/behind**
vs origin. This slice lets Marcos **act on that status from the card**: **Fetch** (refresh remote refs),
**Pull** (catch up when behind), and **Push** (publish when ahead) the project's MAIN checkout, without
opening a terminal. It directly closes the loop on the ahead/behind indicator from slice A.1. Branch
switching, open-terminal, and bulk (all-repos) actions are explicit later slices.

## 2. Key Decisions

- **Trusted, fixed git commands only** (same posture as B.1 open-actions and B.2 Procesos). The client sends
  the project `id` + an **action from a 3-value allowlist** (`fetch` / `pull` / `push`). The server resolves
  the project's REAL path via discovery (never a client path) and runs a FIXED git command — no client value
  is interpolated into the argv.
  - `fetch` → `git -C <path> fetch`
  - `pull`  → `git -C <path> pull --ff-only` (never creates a merge/conflict; non-fast-forward fails cleanly)
  - `push`  → `git -C <path> push` (never `--force`)
- **Push requires UI confirmation** (it is the only outward-facing action). Fetch and Pull run directly
  (local/safe). The confirmation is an inline two-step in the card showing the ahead count + branch.
- **A failed git is a RESULT, not an HTTP error.** A non-fast-forward pull, a rejected push, a missing
  remote, or a network timeout returns `200 { ok: false, output }`. HTTP errors are reserved for an invalid
  action (`400`) or an unknown project (`404`).
- **Network timeout** of 60 s per command via `spawnSync` (git network ops can hang).
- **Cache invalidation:** after a successful git action, the server invalidates the git-status cache entry
  for that path so the next `/api/overview` poll (~3 s) reflects new ahead/behind, instead of waiting out the
  15 s TTL. This is what makes Fetch immediately useful.
- **No streaming** — these are short one-shot commands (unlike Procesos `dev`); the full output is returned
  on completion.

## 3. Scope

**In scope (v1):**

- `dashboard/src/server/git-sync.ts` — `GitAction`, `GitSyncError`, `runGitSync(repoRoot, id, action, deps?)`
  (validate action → resolve path via discovery → run fixed git command → `{ ok, action, output }`; never
  throws out except the typed `GitSyncError` for 400/404).
- `lib/git-status-cache.ts` — add `invalidate(repoPath)` to `GitStatusCache`.
- `dashboard/src/server/index.ts` — `POST /api/projects/:id/git`; invalidate the cache entry on a successful
  action.
- `dashboard/src/ui/api.ts` — `gitSync(id, action)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a git-sync actions row (Fetch · Pull · Push) with a
  two-step Push confirm, per-action busy state, and a result banner.
- `dashboard/src/ui/styles/dashboard.css` — minor styles if needed (reuse existing `.es-banner`, `.es-btn`).

**Out of scope (later B slices):** branch ops (list/switch/create); open terminal; bulk fetch/pull across
repos; `push -u` for branches without an upstream; pull with rebase/merge strategies; conflict resolution
UI; per-remote selection; stash.

## 4. Architecture

```
Fetch / Pull (direct):
  Button → api.gitSync(id, action) → POST /api/projects/:id/git { action }
    runGitSync(repoRoot, id, action):
      if action ∉ {fetch,pull,push} → GitSyncError(400)
      proj = discover(root, ignore).find(p => p.id === id)   // same root/ignore as /api/overview & open
      if !proj → GitSyncError("unknown project", 404)
      args = ARGV[action] with proj.path                      // fixed argv, no client interpolation
      r = spawnSync("git", args, { encoding:"utf8", timeout:60_000 })
      return { ok: r.status === 0 && !r.error, action, output: tail(stdout + stderr + err) }
    on ok → gitStatusCache.invalidate(proj.path)              // in the route handler
    → 200 { ok, action, output }

Push (confirmed):
  Push button → inline confirm ("Publicar N commits a origin/<branch>") → Confirmar → same POST as above
```

`spawnSync` and `discover` are injectable (`deps`) so `runGitSync` is unit-testable without running git or
touching the filesystem. The argv table is the single source of the (fixed) commands.

## 5. Components

### `dashboard/src/server/git-sync.ts`

```ts
export class GitSyncError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GitSyncError"; }
}

export type GitAction = "fetch" | "pull" | "push";

export interface GitSyncResult { ok: boolean; action: GitAction; output: string }

interface GitSyncDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function runGitSync(repoRoot: string, id: string, action: string, deps?: GitSyncDeps): GitSyncResult;
```

- Action allowlist + argv table:
  ```ts
  const ARGV: Record<GitAction, (path: string) => string[]> = {
    fetch: (p) => ["-C", p, "fetch"],
    pull:  (p) => ["-C", p, "pull", "--ff-only"],
    push:  (p) => ["-C", p, "push"],
  };
  ```
- `runGitSync`:
  - `if (!(action in ARGV)) throw new GitSyncError("invalid action: " + action, 400)`.
  - resolve `root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, discover with
    `DEFAULT_IGNORE + SURTEC_PROJECTS_IGNORE` (identical to `open-project.ts` / `/api/overview`).
  - `proj = discover(root, ignore).find(p => p.id === id)`; if none → `GitSyncError("unknown project: " + id, 404)`.
  - `r = spawnSync("git", ARGV[action as GitAction](proj.path), { encoding:"utf8", timeout:60_000 })`.
  - `ok = r.status === 0 && !r.error`; `output = ((r.stdout ?? "") + (r.stderr ?? "") + (r.error ? r.error.message : "")).trim()` (capped to a tail, e.g. last 4000 chars, like `verify.ts`).
  - return `{ ok, action: action as GitAction, output }`. The ONLY throws are the typed `GitSyncError`s.
  - Defaults: `spawnSync = child_process.spawnSync`, `discover = discoverProjects`.

### `lib/git-status-cache.ts`

```ts
export interface GitStatusCache {
  get(repoPath: string): GitStatus;
  invalidate(repoPath: string): void;   // NEW
}
```
- `invalidate(repoPath)` deletes that key from the internal `Map`, forcing a fresh read on the next `get`.

### `dashboard/src/server/index.ts`

```ts
app.post("/api/projects/:id/git", async (c) => {
  let body: { action?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  try {
    const result = runGitSync(repoRoot, c.req.param("id"), String(body?.action ?? ""));
    if (result.ok) {
      // refresh ahead/behind promptly on the next overview poll
      const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
      const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
      const proj = discoverProjects(root, ignore).find((p) => p.id === c.req.param("id"));
      if (proj) gitStatusCache.invalidate(proj.path);
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof GitSyncError) return c.json({ error: err.message }, err.status as 400 | 404);
    return c.json({ error: (err as Error).message }, 500);
  }
});
```
- `gitStatusCache` is the existing per-app cache already created in `createApp`. `dirname`,
  `discoverProjects`, `DEFAULT_IGNORE` are already imported in `index.ts`.
- (Minor duplication: discovery runs inside `runGitSync` AND again here for the cache key. Acceptable for
  v1 — both are cheap depth-1 scans; a later refactor could have `runGitSync` return the resolved path.)

### `dashboard/src/ui/api.ts`

```ts
export async function gitSync(
  id: string, action: "fetch" | "pull" | "push",
): Promise<{ ok: boolean; action: string; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/git`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `git ${action} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; action: string; output: string };
}
```

### `dashboard/src/ui/components/ProjectCard.tsx`

- Render a git-sync row ONLY when `p.git?.ok`. Buttons: **Fetch**, **Pull**, **Push**.
- State: `const [busy, setBusy] = useState<string | null>(null)` (the action in flight),
  `const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)`,
  `const [confirmPush, setConfirmPush] = useState(false)`.
- Fetch / Pull: `onClick` → `setBusy(action); gitSync(p.id, action).then(r => setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") })).catch(e => setResult({ ok:false, text:(e as Error).message })).finally(() => setBusy(null))`.
- Push: disabled when `(p.git?.ahead ?? 0) === 0`. First click sets `confirmPush=true`, which swaps the row
  for a confirm: text `Publicar {p.git.ahead} commit(s) a origin/{p.git.branch}?` + **Confirmar** (runs the
  same handler with `"push"`, then `setConfirmPush(false)`) + **Cancelar** (`setConfirmPush(false)`).
- Buttons are `.es-btn--ghost`; disabled while `busy`. Result banner: `.es-banner es-banner--ok` when
  `result.ok`, else `.es-banner es-banner--warn`, showing `result.text` (mono, pre-wrap, small — reuse
  `.es-banner`). The git-line refreshes via the existing 3 s overview poll (cache was invalidated server-side).

## 6. Data Flow & State Transitions

No persisted state. Each action is a one-shot request returning `{ ok, action, output }`. On success the
server invalidates the cache entry so the next `/api/overview` poll re-reads ahead/behind. The push confirm
is transient local UI state. No change to dispatch/Procesos/review.

## 7. Safety & Governance

- **Client never supplies a path or a command** — only an `id` (matched to a discovered project) and an
  action from a fixed 3-value allowlist. The git argv is built server-side from the trusted table; no shell,
  no string interpolation of client input (`spawnSync("git", argv)` with no `shell`).
- **Push is the only outward-facing action and is gated by an explicit UI confirmation** (consistent with the
  approve/push gating elsewhere). Never `--force`.
- **Pull is `--ff-only`** — it can never silently create a merge or leave the tree in a conflicted state; a
  non-fast-forward simply fails and the output is shown.
- **Fetch** only updates remote-tracking refs; it does not touch the working tree.
- Local developer tooling on the user's own repos; no agent, no secrets handling beyond what git itself uses
  (the user's configured credentials). 60 s timeout bounds hangs.

## 8. Error Handling

- Invalid action → `GitSyncError` 400. Unknown project → `GitSyncError` 404. The endpoint maps these.
- Any git failure (non-ff pull, rejected push, no remote, timeout, git missing) → `200 { ok:false, output }`;
  the UI shows the output in a warning banner. `runGitSync` never throws for these.
- A branch with no upstream → `git push` fails with git's own message (shown); `push -u` is out of scope.
- The UI `gitSync` throws only on a non-2xx HTTP (400/404/500), caught and shown inline on the card.

## 9. Testing (TDD)

- `dashboard/src/server/git-sync.test.ts`:
  - invalid action (`"merge"`/`""`) → throws `GitSyncError` status 400; `spawnSync` NOT called.
  - unknown id (injected `discover` returns `[]`) → throws `GitSyncError` 404; `spawnSync` NOT called.
  - each action maps to the exact argv (injected `spawnSync` spy + `discover` returning
    `[{id:"alpha",path:"/p/alpha"}]`): `fetch` → `["-C","/p/alpha","fetch"]`,
    `pull` → `["-C","/p/alpha","pull","--ff-only"]`, `push` → `["-C","/p/alpha","push"]`, each with
    `{ encoding:"utf8", timeout:60000 }` and command `"git"`.
  - git exit 0 → `{ ok:true, output:<stdout+stderr> }`; git exit ≠ 0 → `{ ok:false }` with output captured;
    `spawnSync` returning an `error` (e.g. ETIMEDOUT) → `{ ok:false }` with the error message in output.
  - never throws for a non-zero/`error` result (only the two `GitSyncError` paths throw).
- `lib/git-status-cache.test.ts`: after `get(path)` caches a value, `invalidate(path)` forces the next
  `get(path)` to call `readStatus` again (assert the injected `readStatus` call count increments).
- `dashboard/src/server/index.test.ts`: `POST /api/projects/:id/git` → `400` for an invalid action and
  `404` for an unknown id (pin `SURTEC_PROJECTS_ROOT` to an empty temp dir so discovery finds nothing). The
  success/spawn path is covered in `git-sync.test.ts` with an injected `spawnSync`, not here (no real git).
- `dashboard/src/ui/components/ProjectCard.test.tsx`: a git-ok project renders Fetch/Pull/Push; clicking
  **Fetch** POSTs via `gitSync(id,"fetch")` (stub the api) and shows the output banner; **Push** with
  `ahead>0` first shows a confirm and only calls `gitSync(id,"push")` after **Confirmar**; Push is disabled
  when `ahead===0`. A non-git project (`p.git` null / `ok:false`) renders no git-sync row.

## 10. Evolution Path

- Branch ops (list/switch/create) on the main checkout, with a dirty-state guard.
- `push -u` when no upstream; choose remote; pull `--rebase` option.
- Bulk fetch/pull across selected repos (reuse the Procesos feedback model for progress).
- Open terminal at the project path. Surface a conflict/diff view when `--ff-only` pull is rejected.
- Have `runGitSync` return the resolved path so the route need not re-discover for the cache key.

## 11. Open Questions

None blocking. `git` must be on PATH (it already is — used by status/worktree). The first push of a branch
without an upstream fails with a clear git message; adding `-u` is a deliberate later slice.
