# Surtec Control Plane — Dependency Staleness (A.3) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Dependency staleness per repo (theme A "live real status", slice A.3 — last theme-A slice)
- **Builds on:** portfolio discovery (`2026-05-29-portfolio-discovery-design.md`), the on-demand + cache
  pattern from the GitHub overlay (`2026-05-30-github-overlay-design.md`)

## 1. Context & Goal

The "live status" theme shows local git (A.1) and GitHub PRs/issues/CI (A.2/A.2b). This last theme-A slice
adds **dependency staleness**: how many of a project's npm dependencies are outdated, surfaced on the card
on demand. It uses read-only `npm outdated --json`, gated on an installed `node_modules` for a meaningful
count, cached server-side (it's a slow network call).

## 2. Key Decisions

- **`npm outdated --json` run with `cwd` = the repo's discovered path**, read-only. Universal: it reads
  `package.json` and queries the npm registry, so it works for any node project (npm/yarn/pnpm/bun alike).
- **Require `node_modules`** for a meaningful "installed vs latest" count. Gating:
  - no `package.json` at the repo root → `{ ok:false, error:"sin package.json" }` (repos whose `package.json`
    lives in a subdir like `frontend/` degrade here; a `pkg_dir` registry field is a noted follow-up).
  - no `node_modules` → `{ ok:false, error:"n/a (npm install)" }`.
  - else → run `npm outdated`, count.
- **Do NOT gate on exit code.** `npm outdated` exits **1 when there ARE outdated packages** (and `0` when
  none), so the parser runs regardless; `--json` yields `{}` (none) or `{ pkg: {...}, ... }`. Only a spawn
  error or unparseable stdout is an error.
- **Count = number of outdated packages** (`Object.keys(parsed).length`). No major/minor breakdown in v1.
- **Windows**: spawn `npm.cmd` (not `npm`) so it resolves without a shell; `shell:false`, fixed argv, no user
  input. 60s timeout (the registry call can be slow).
- **On-demand per card, cached 60s→5min.** A separate **"Deps"** control (not folded into the GitHub control —
  it's npm, applies to every node repo, not just GitHub ones). TTL **5 min** (deps change slowly; the call is
  expensive).
- **Path-based resolution** via discovery (not the registry slug) — we need the filesystem path, not a
  GitHub identity.

## 3. Scope

**In scope (v1):**

- `dashboard/src/server/deps-read.ts` — `DepsStatus`, `DepsError`, `readDepsStatus`, `resolveDepsPath`,
  `createDepsCache`. Read-only npm; never throws except `DepsError`.
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/deps`; a per-app `depsCache`.
- `dashboard/src/ui/api.ts` — `getDeps(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `DepsStatus` sub-component (toggle → load → count /
  "al día" / error).
- `dashboard/src/ui/styles/dashboard.css` — a small `.es-deps*` style.

**Out of scope (later):** major/minor/patch breakdown; the actual outdated package list; `package.json` in a
subdir (`frontend/`); a `pkg_dir` registry field; non-npm-registry resolution; auto-install; auto-load; a
global "check all deps" action.

## 4. Architecture

```
On-demand per card:
  expand "Deps" → api.getDeps(id) → GET /api/projects/:id/deps
    path = resolveDepsPath(repoRoot, id)            // discovery; unknown → DepsError(404)
    return depsCache.get(path, () => readDepsStatus(path))   // TTL 5 min; compute on miss
      readDepsStatus(path):
        if !exists(path/package.json) → { ok:false, outdated:0, error:"sin package.json" }
        if !exists(path/node_modules) → { ok:false, outdated:0, error:"n/a (npm install)" }
        r = spawnSync(npmCmd, ["outdated","--json"], { cwd:path, timeout:60000 })   // exit 1 ⇒ has outdated
        if r.error → { ok:false, outdated:0, error }
        parse r.stdout as a JSON object (try/catch); on parse error → { ok:false, error:"bad npm output" }
        → { ok:true, outdated: Object.keys(obj).length }
    → 200 { ok, outdated, error? }
```

`spawnSync`, `exists`, and `discover` are injectable so the read + resolution are unit-testable without npm
or the filesystem.

## 5. Components

### `dashboard/src/server/deps-read.ts`

```ts
export class DepsError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "DepsError"; }
}

export interface DepsStatus { ok: boolean; outdated: number; error?: string }

interface DepsDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  exists?: (p: string) => boolean;
}
interface ResolveDeps {
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function readDepsStatus(path: string, deps?: DepsDeps): DepsStatus;
export function resolveDepsPath(repoRoot: string, id: string, deps?: ResolveDeps): string;

export interface DepsCache { get(key: string, compute: () => DepsStatus): DepsStatus; invalidate(key: string): void }
export function createDepsCache(opts?: { ttlMs?: number; now?: () => number }): DepsCache;
```

- `readDepsStatus(path, deps?)`:
  - `exists = deps.exists ?? fs.existsSync`; `spawnSync = deps.spawnSync ?? child_process.spawnSync`.
  - `if (!exists(join(path, "package.json"))) return { ok:false, outdated:0, error:"sin package.json" }`.
  - `if (!exists(join(path, "node_modules"))) return { ok:false, outdated:0, error:"n/a (npm install)" }`.
  - `const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";`
  - `r = spawnSync(npmCmd, ["outdated", "--json"], { cwd: path, encoding:"utf8", timeout: 60_000 })`.
  - `if (r.error) return { ok:false, outdated:0, error: r.error.message }`.
  - parse `asStr(r.stdout)` (empty string → treat as `{}`): `try { obj = stdout.trim() ? JSON.parse(stdout) : {} } catch { return { ok:false, outdated:0, error:"bad npm output" } }`.
    `if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok:false, outdated:0, error:"bad npm output" }`.
  - `return { ok:true, outdated: Object.keys(obj).length }`. Never throws.
- `resolveDepsPath`: same discovery resolution as the original A.2 path resolver — `root = deps.root ??
  SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, `ignore = DEFAULT_IGNORE + SURTEC_PROJECTS_IGNORE`;
  `proj = (deps.discover ?? discoverProjects)(root, ignore).find(p => p.id === id)`; if none → throw
  `DepsError("unknown project: " + id, 404)`; else `return proj.path`.
- `createDepsCache(opts?)`: `get(key, compute)` — return cached within `ttlMs` (default `300_000`) else
  `compute()` and store; `invalidate(key)` deletes. (Same shape as the refactored `createGithubCache`.)

### `dashboard/src/server/index.ts`

```ts
import { readDepsStatus, resolveDepsPath, createDepsCache, DepsError } from "./deps-read";
// in createApp, next to githubCache:
const depsCache = createDepsCache();

app.get("/api/projects/:id/deps", (c) => {
  try {
    const path = resolveDepsPath(repoRoot, c.req.param("id"));
    return c.json(depsCache.get(path, () => readDepsStatus(path)));
  } catch (err) {
    if (err instanceof DepsError) return c.json({ error: err.message }, err.status as 404);
    return c.json({ error: (err as Error).message }, 500);
  }
});
```

### `dashboard/src/ui/api.ts`

```ts
export async function getDeps(id: string): Promise<{ ok: boolean; outdated: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deps`);
  if (!res.ok) throw new Error(`deps failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; outdated: number; error?: string };
}
```

### `dashboard/src/ui/components/ProjectCard.tsx` — `DepsStatus` sub-component

- Render for any **git-ok** repo (`project.git?.ok`). A **"Deps"** button toggles `open`. On the first open
  (`!data`), fetch `getDeps(id)`, memoized; a thrown HTTP error goes to a separate `err` (retryable on
  reopen, mirroring the GitHub control).
- When open: `cargando…` while loading; else if `data?.ok` →
  `${data.outdated} desactualizada${data.outdated === 1 ? "" : "s"}` when `outdated > 0`, or `al día` when
  `0`; else (`data` with `ok:false`, or `err`) → the error string (`data.error ?? "Deps: no disponible"`).
- A status dot: `outdated > 0` → `es-dot--warn`; `outdated === 0` (al día) → `es-dot--ok`; degraded/error →
  `es-dot--muted`.
- Placed after `<GithubCounts project={p} />`. Reuses `.es-btn`; small `.es-deps` style.

### `dashboard/src/ui/styles/dashboard.css`

```css
.es-deps { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
.es-deps__val { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--ink-2); }
```

## 6. Data Flow & State Transitions

No persisted state. `getDeps` is read-on-demand (control open), memoized in component state; the server
caches by path for 5 min. No change to the overview poll, dispatch, Procesos, review, git, branch, or the
GitHub overlay.

## 7. Safety & Governance

- **Read-only**: only `npm outdated --json` (no install, no mutation). Fixed argv, no user input, `shell:false`
  (`npm.cmd` on Windows). `cwd` is the server-resolved discovery path, never a client path.
- **Degrades, never throws**: missing package.json / node_modules / npm error / bad output → `{ ok:false,
  error }`. Only `resolveDepsPath` throws (`DepsError` 404).
- 60s spawn timeout; 5 min cache bounds how often npm is invoked. On-demand-per-card keeps the blocking
  `spawnSync` to one repo at a time.

## 8. Error Handling

- Unknown project → `DepsError` 404 (route maps it). Unexpected → 500.
- No package.json → `{ ok:false, error:"sin package.json" }`; no node_modules → `{ ok:false, error:"n/a
  (npm install)" }`; npm spawn error → `{ ok:false, error }`; non-object/unparseable JSON → `{ ok:false,
  error:"bad npm output" }`. All HTTP 200. `readDepsStatus` never throws.
- The UI `getDeps` throws only on a non-2xx HTTP; caught by the control → error line.

## 9. Testing (TDD)

- `dashboard/src/server/deps-read.test.ts` (injected `spawnSync` + `exists` + `discover`):
  - `readDepsStatus`: no package.json (`exists` false for package.json) → `{ ok:false, error:"sin package.json" }`,
    npm NOT spawned; package.json present but no node_modules → `{ ok:false, error matches /npm install/ }`,
    npm NOT spawned; both present + `npm outdated` returns `"{}"` (exit 0) → `{ ok:true, outdated:0 }`;
    returns `'{"a":{},"b":{}}'` with **exit status 1** → `{ ok:true, outdated:2 }` (exit code ignored);
    spawn `error` (ENOENT) → `{ ok:false }`; non-JSON stdout → `{ ok:false, error:"bad npm output" }`; and the
    exact argv `["outdated","--json"]` with `cwd:path` (assert the args + cwd option; the command is `npm` or
    `npm.cmd` — assert `args` and `opts.cwd`, not the platform-specific command name).
  - `resolveDepsPath`: injected `discover` → path; unknown id → throws `DepsError` 404.
  - `createDepsCache`: `get(key, compute)` computes on miss, caches within TTL, re-computes after TTL,
    `invalidate` forces a re-compute.
- `dashboard/src/server/index.test.ts`: `GET /api/projects/:id/deps` for an unknown project (empty
  `SURTEC_PROJECTS_ROOT`) → `404`. (Success via the unit test with injected spawnSync.)
- `dashboard/src/ui/components/ProjectCard.test.tsx`:
  - the **Deps** button renders for a git-ok repo; clicking fetches (stub) and shows `2 desactualizadas`
    (and `.es-dot--warn`); a `{ ok:true, outdated:0 }` shows `al día` (`.es-dot--ok`); a `{ ok:false,
    error:"n/a (npm install)" }` shows that error (`.es-dot--muted`).

## 10. Evolution Path

- Major/minor/patch breakdown ("3 outdated · 1 major"); the actual outdated package list; a `pkg_dir`
  registry field for `frontend/`-style repos; per-PM tooling (`pnpm/yarn/bun outdated`); a global "check all
  deps" with the BulkSync feedback model; security advisories (`npm audit`).

## 11. Open Questions

None blocking. `npm` must be on PATH (it is — Marcos develops with it; `npm.cmd` on Windows). `npm outdated`
is slow on large dep trees but on-demand + the 5 min cache bound it. Repos with `package.json` in a subdir
degrade to "sin package.json" in v1 (documented; `pkg_dir` is the follow-up).
