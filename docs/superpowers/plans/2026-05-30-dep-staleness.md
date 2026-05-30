# Dependency Staleness (A.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the number of outdated npm dependencies per repo on its card, on demand, via read-only `npm outdated --json`, gated on `node_modules`, cached 5 min, degrading gracefully.

**Architecture:** A new `dashboard/src/server/deps-read.ts` runs `npm outdated --json` (cwd = the discovered repo path), counts the JSON object keys, and never throws (degrades to `{ ok:false, error }`). A per-app TTL cache (`get(key, compute)`) wraps reads by path. `GET /api/projects/:id/deps` serves it; a per-card `DepsStatus` control loads it on demand. Mirrors the A.2 GitHub overlay structure.

**Tech Stack:** TypeScript ESM, Node `child_process.spawnSync` + `fs.existsSync`, npm CLI, Hono, React 18 + Vite, Vitest + Testing Library/jsdom. Windows/PowerShell host.

**Spec:** `docs/superpowers/specs/2026-05-30-dep-staleness-design.md`

---

## File Structure

**Create:**
- `dashboard/src/server/deps-read.ts` — `DepsStatus`, `DepsError`, `readDepsStatus`, `resolveDepsPath`, `createDepsCache`. Read-only npm; never throws except `DepsError`.
- `dashboard/src/server/deps-read.test.ts`.

**Modify:**
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/deps`; a per-app `depsCache`.
- `dashboard/src/server/index.test.ts` — a 404 route test.
- `dashboard/src/ui/api.ts` — `getDeps(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `DepsStatus` sub-component.
- `dashboard/src/ui/components/ProjectCard.test.tsx` — deps-control tests.
- `dashboard/src/ui/styles/dashboard.css` — `.es-deps*` styles.

---

## Task 1: `deps-read.ts` — `readDepsStatus` + `resolveDepsPath`

**Files:**
- Create: `dashboard/src/server/deps-read.ts`
- Test: `dashboard/src/server/deps-read.test.ts`

- [ ] **Step 1: Write the failing tests** — Create `dashboard/src/server/deps-read.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { readDepsStatus, resolveDepsPath, DepsError } from "./deps-read";

describe("readDepsStatus", () => {
  it("counts outdated deps and ignores npm's exit-1-when-outdated; uses npm outdated --json at cwd", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: '{"a":{},"b":{}}' });
    const exists = vi.fn().mockReturnValue(true);
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists });
    expect(r).toEqual({ ok: true, outdated: 2 });
    expect(spawnSync.mock.calls[0][1]).toEqual(["outdated", "--json"]);
    expect((spawnSync.mock.calls[0][2] as { cwd: string }).cwd).toBe("/p");
  });

  it("returns outdated:0 for an empty npm result", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "{}" });
    expect(readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true })).toEqual({ ok: true, outdated: 0 });
  });

  it("treats empty stdout as no outdated", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "" });
    expect(readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true })).toEqual({ ok: true, outdated: 0 });
  });

  it("ok:false 'sin package.json' when there is no package.json (npm NOT spawned)", () => {
    const spawnSync = vi.fn();
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sin package.json/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("ok:false 'n/a (npm install)' when node_modules is missing (npm NOT spawned)", () => {
    const spawnSync = vi.fn();
    const exists = vi.fn().mockImplementation((p: string) => p.endsWith("package.json"));
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/npm install/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("ok:false on spawn error", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: null, error: new Error("spawn npm ENOENT") });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });

  it("ok:false on non-JSON npm output", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "not json" });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad npm output/);
  });

  it("ok:false on a non-object JSON (array)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "[]" });
    const r = readDepsStatus("/p", { spawnSync: spawnSync as never, exists: () => true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad npm output/);
  });
});

describe("resolveDepsPath", () => {
  it("resolves a discovered project path", () => {
    expect(resolveDepsPath("/repo", "alpha", { discover: () => [{ id: "alpha", path: "/p/alpha" }], root: "/root" })).toBe("/p/alpha");
  });
  it("throws DepsError(404) for an unknown project", () => {
    expect(() => resolveDepsPath("/repo", "ghost", { discover: () => [], root: "/root" })).toThrow(DepsError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/deps-read.test.ts`
Expected: FAIL — `Cannot find module './deps-read'`.

- [ ] **Step 3: Implement** — Create `dashboard/src/server/deps-read.ts`:

```ts
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class DepsError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "DepsError"; }
}

export interface DepsStatus { ok: boolean; outdated: number; error?: string }

const TIMEOUT_MS = 60_000;

interface DepsDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  exists?: (p: string) => boolean;
}
interface ResolveDeps {
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

// Counts outdated npm deps via read-only `npm outdated --json` (cwd = repo path). Requires node_modules for a
// meaningful count. Never throws — missing pkg / node_modules / npm error / bad output → { ok:false, error }.
export function readDepsStatus(path: string, deps: DepsDeps = {}): DepsStatus {
  const exists = deps.exists ?? existsSync;
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  if (!exists(join(path, "package.json"))) return { ok: false, outdated: 0, error: "sin package.json" };
  if (!exists(join(path, "node_modules"))) return { ok: false, outdated: 0, error: "n/a (npm install)" };
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npmCmd, ["outdated", "--json"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error) return { ok: false, outdated: 0, error: r.error.message };
  // npm outdated exits 1 when there ARE outdated packages — DO NOT gate on the exit code.
  const out = asStr(r.stdout).trim();
  let obj: unknown;
  try {
    obj = out ? JSON.parse(out) : {};
  } catch {
    return { ok: false, outdated: 0, error: "bad npm output" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, outdated: 0, error: "bad npm output" };
  return { ok: true, outdated: Object.keys(obj).length };
}

export function resolveDepsPath(repoRoot: string, id: string, deps: ResolveDeps = {}): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new DepsError(`unknown project: ${id}`, 404);
  return proj.path;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/deps-read.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/deps-read.ts dashboard/src/server/deps-read.test.ts
git commit -m "feat(server): deps-read readDepsStatus + resolveDepsPath"
```

---

## Task 2: `deps-read.ts` — TTL cache

**Files:**
- Modify: `dashboard/src/server/deps-read.ts`
- Test: `dashboard/src/server/deps-read.test.ts`

- [ ] **Step 1: Add the failing test** — append to `dashboard/src/server/deps-read.test.ts`:

```ts
import { createDepsCache } from "./deps-read";

describe("createDepsCache", () => {
  it("computes on a miss, caches within TTL, re-computes after TTL, and invalidate forces a re-compute", () => {
    let calls = 0;
    let t = 0;
    const value = { ok: true, outdated: 3 };
    const cache = createDepsCache({ ttlMs: 100, now: () => t });
    const compute = () => { calls += 1; return value; };
    cache.get("/p", compute); // calls = 1 (fresh)
    cache.get("/p", compute); // calls = 1 (cached, within TTL)
    t = 200;
    cache.get("/p", compute); // calls = 2 (TTL expired)
    cache.invalidate("/p");
    cache.get("/p", compute); // calls = 3 (re-compute after invalidate)
    expect(calls).toBe(3);
  });
});
```

> Merge `createDepsCache` into the existing `import { … } from "./deps-read"` line, or add a separate import — just don't duplicate a symbol.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/deps-read.test.ts`
Expected: FAIL — `createDepsCache` is not exported.

- [ ] **Step 3: Implement** — append to `dashboard/src/server/deps-read.ts`:

```ts
export interface DepsCache { get(key: string, compute: () => DepsStatus): DepsStatus; invalidate(key: string): void }

export function createDepsCache(opts: { ttlMs?: number; now?: () => number } = {}): DepsCache {
  const ttlMs = opts.ttlMs ?? 300_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: DepsStatus; at: number }>();
  return {
    get(key: string, compute: () => DepsStatus): DepsStatus {
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: t });
      return value;
    },
    invalidate(key: string): void {
      cache.delete(key);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/deps-read.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/deps-read.ts dashboard/src/server/deps-read.test.ts
git commit -m "feat(server): createDepsCache (TTL 5min) for dep staleness"
```

---

## Task 3: `GET /api/projects/:id/deps` route + api client

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Add the failing route test** — add this describe block to `dashboard/src/server/index.test.ts` (reuse the already-imported `mkdtempSync`/`rmSync`/`tmpdir`/`join` + the `process.env.SURTEC_PROJECTS_ROOT = … / delete in finally` pattern used by the `/git` and `/github` 404 tests):

```ts
describe("deps route", () => {
  it("GET /api/projects/:id/deps for an unknown project → 404 (our JSON handler)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-deps-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/deps");
      expect(res.status).toBe(404);
      expect((await res.json()) as { error?: string }).toMatchObject({ error: expect.stringMatching(/unknown project/) });
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
```

> The success path (real npm) is covered by `deps-read.test.ts` with an injected spawnSync — not here.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — the `/deps` route is missing (Hono's default 404 has no JSON `error` body, so the `toMatchObject` assertion fails).

- [ ] **Step 3: Implement the route** — in `dashboard/src/server/index.ts`:

1. Add the import (next to the `deps`/`github-read` imports):

```ts
import { readDepsStatus, resolveDepsPath, createDepsCache, DepsError } from "./deps-read";
```

2. Inside `createApp`, next to the existing `const githubCache = createGithubCache();`, add:

```ts
  const depsCache = createDepsCache();
```

3. After the `GET /api/projects/:id/github` route (and before `return app;`), add:

```ts
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

- [ ] **Step 4: Implement the api client** — append to `dashboard/src/ui/api.ts`:

```ts
export async function getDeps(id: string): Promise<{ ok: boolean; outdated: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deps`);
  if (!res.ok) throw new Error(`deps failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; outdated: number; error?: string };
}
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run the full server suite (no regressions)**

Run: `pnpm exec vitest run dashboard/src/server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts dashboard/src/ui/api.ts
git commit -m "feat(server+ui): GET /api/projects/:id/deps route + getDeps client"
```

## Context for Task 3
`deps-read.ts` (Tasks 1+2) exports `resolveDepsPath` (throws `DepsError 404`), `createDepsCache` (`get(key, compute)`), and `readDepsStatus`. The route resolves id→path (404 if unknown) then returns the cached deps status (HTTP 200, possibly `{ok:false}` if degraded). Mirrors the `/github` route's shape. `getDeps` mirrors `getGithubCounts` — only throws on a real HTTP error; the caller inspects `r.ok`.

---

## Task 4: ProjectCard `DepsStatus` + styles

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.test.tsx`
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Add failing tests** — add a new describe block to `dashboard/src/ui/components/ProjectCard.test.tsx`:

```tsx
describe("ProjectCard deps status", () => {
  afterEach(() => vi.unstubAllGlobals());

  const gitOkP = (): ProjectView => ({
    ...base,
    git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
  });

  it("renders no Deps button for a repo without git", () => {
    render(<ProjectCard p={base} />); // git: null
    expect(screen.queryByRole("button", { name: /^deps$/i })).toBeNull();
  });

  it("loads and shows the outdated count on click", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, outdated: 2 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/2 desactualizadas/)).toBeTruthy());
    expect(container.querySelector(".es-deps__val .es-dot--warn")).toBeTruthy();
    const get = (fetchMock.mock.calls as unknown[][]).find((c) => String(c[0]).endsWith("/api/projects/alpha/deps"));
    expect(get).toBeTruthy();
  });

  it("shows 'al día' with an ok dot when nothing is outdated", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, outdated: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/al día/i)).toBeTruthy());
    expect(container.querySelector(".es-deps__val .es-dot--ok")).toBeTruthy();
  });

  it("shows the degraded message when not ok", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, outdated: 0, error: "n/a (npm install)" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/npm install/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — no Deps button.

- [ ] **Step 3: Implement the `DepsStatus` sub-component** — in `dashboard/src/ui/components/ProjectCard.tsx`:

1. Add `getDeps` to the api import (it currently imports `openProject, gitSync, getBranches, branchOp, getGithubCounts`):

```tsx
import { openProject, gitSync, getBranches, branchOp, getGithubCounts, getDeps } from "../api";
```

2. Add a `DepsStatus` sub-component (place it next to the other sub-components, above `export function ProjectCard`):

```tsx
function DepsStatus({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ ok: boolean; outdated: number; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!project.git?.ok) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading) {
      setLoading(true);
      setErr(null);
      getDeps(project.id)
        .then(setData)
        .catch((e) => setErr((e as Error).message))
        .finally(() => setLoading(false));
    }
  };

  const dot = !data?.ok ? "es-dot--muted" : data.outdated > 0 ? "es-dot--warn" : "es-dot--ok";
  const text = loading ? "cargando…"
    : data ? (data.ok ? (data.outdated > 0 ? `${data.outdated} desactualizada${data.outdated === 1 ? "" : "s"}` : "al día") : (data.error ?? "Deps: no disponible"))
    : err ? "Deps: no disponible"
    : null;

  return (
    <div className="es-deps">
      <button type="button" className="es-btn es-btn--ghost" onClick={toggle}>Deps</button>
      {open && (
        <span className="es-deps__val" title={data?.error ?? err ?? undefined}>
          <span className={`es-dot ${dot}`} />{text}
        </span>
      )}
    </div>
  );
}
```

3. Render it inside the card, right after the `<GithubCounts project={p} />` line:

```tsx
      <DepsStatus project={p} />
```

- [ ] **Step 4: Add the CSS** — append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* deps staleness */
.es-deps { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
.es-deps__val { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--ink-2); }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (all ProjectCard tests + the 4 new deps ones).

- [ ] **Step 6: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): ProjectCard DepsStatus (outdated dep count, on-demand)"
```

## Context for Task 4
`DepsStatus` mirrors the `GithubCounts`/`BranchControl` sub-components: renders for any `project.git?.ok` repo, loads on first open (memoized via `!data && !loading`), with a separate `err` state so a thrown HTTP error is retryable on reopen. The dot is warn when `outdated > 0`, ok when `0` (al día), muted when degraded/loading/error. `useState` is already imported. The CSS tokens (`--sp-*`, `--fs-caption`, `--ink-2`) already exist.

---

## Task 5: Full verification + manual smoke + finish the branch

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (existing 282 + new: deps-read (11), deps route (1), ProjectCard deps (4)).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (REQUIRED — use the verification-before-completion skill)**

Start the API server (`PORT=4319 pnpm exec tsx dashboard/src/server/serve.ts` in the background). Then over HTTP:
- `GET /api/projects/<a-real-node-project-with-node_modules>/deps` → `200 { ok:true, outdated:N }` (or
  `{ ok:false, error }` if no package.json/node_modules — also a valid pass: the route ran and degraded).
  Pick a project that has `node_modules` installed to see a real count; pick one that does NOT (or a docs repo)
  to see the `sin package.json` / `n/a (npm install)` degrade.
- `GET /api/projects/__nope__/deps` → `404`.
- (Optional) In the browser: open a git-ok project card, click **Deps**, confirm a count / "al día" / the
  degrade message appears.

Note: `npm outdated` can take several seconds (registry call) — expected. Capture the actual observed result.
If a real count looks wrong, verify with `npm outdated --json` directly in that repo. If anything fails,
switch to systematic-debugging. Kill the test server.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch — the project's established
per-slice flow. Then update the memory file `live-status-dashboard-slice.md` to add the A.3 slice (and note
theme A is complete).

---

## Self-Review (completed during planning)

- **Spec coverage:** readDepsStatus (npm outdated, node_modules gate, exit-code-ignored, count, degrade-not-throw)
  → Task 1; resolveDepsPath (discovery, 404) → Task 1; TTL cache get(key,compute) → Task 2; route + cache
  instance + api → Task 3; ProjectCard DepsStatus (git-ok gate, on-demand, count/al día/degrade, dot colors) +
  CSS → Task 4; verification + finish → Task 5. All spec sections covered.
- **Placeholder scan:** no TODO/TBD; every code step has complete code (read, cache, route, api, component,
  tests, CSS).
- **Type consistency:** `DepsStatus { ok, outdated, error? }` defined once (Task 1) and used in the cache
  (Task 2), route (Task 3), api (Task 3), and component (Task 4). `DepsError`/`readDepsStatus`/`resolveDepsPath`/
  `createDepsCache`/`DepsCache` names consistent across Tasks 1-3. `getDeps(id)` signature consistent between
  Task 3 and Task 4. The cache `get(key, compute)` matches the refactored `createGithubCache` shape.
