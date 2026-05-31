# C.1 — Deploy Health-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-card deploy health indicator — a read-only HTTP ping of each project's registry `deploy_url`, shown as up/degraded/down + HTTP status + latency, auto-loaded on card mount.

**Architecture:** A new server module pings the deploy URL (HEAD with GET fallback, ~6s timeout, never-throws) behind a 60s cache. The URL is resolved server-side from `registry/projects.yml` by project id (anti-SSRF). `GET /api/projects/:id/deploy` returns the health; a `DeployStatus` sub-component in `ProjectCard` fetches it on mount and renders the dot + label + "abrir sitio" link (nothing when unconfigured).

**Tech Stack:** TS ESM, Hono, Node global `fetch` + `AbortController`, React 18, Vitest + Testing Library/jsdom, pnpm.

**Grounding (read for patterns):** `dashboard/src/server/deps-read.ts` (the `DepsError` class, `resolveDepsPath` registry-resolve, `createDepsCache` shape) and `dashboard/src/server/github-inbox.ts` (async promise-cache, injectable runner), `dashboard/src/server/registry.ts` (`loadRegistryProjects` + `RegistryDoc`), `lib/state/derive.ts:6-13` (`RegistryProject` type), `dashboard/src/server/index.ts:199-207` (the `/api/projects/:id/deps` route shape + cache wiring), `dashboard/src/ui/components/ProjectCard.tsx` (the `GithubCounts`/`DepsStatus` sub-component pattern + `.pdot`/`.card-link-btn` classes), `dashboard/src/ui/api.ts` (fetch helpers).

**Naming contract (keep identical across tasks):**
- Types in `lib/state/types.ts`: `DeployState = "up" | "degraded" | "down"`, `DeployHealth = { configured: boolean; url: string | null; state: DeployState | null; status: number | null; ms: number | null; error?: string }`.
- `deploy-read.ts` exports: `DoFetch`, `DeployPing` (`{ state: DeployState; status: number | null; ms: number; error?: string }`), `readDeployHealth(url, deps?)`, `resolveDeployUrl(repoRoot, id, deps?)`, `DeployError`, `createDeployCache(opts?)`, `DeployCache`.
- `api.ts`: `getDeploy(id): Promise<DeployHealth>`.

---

## File Structure

**Create:**
- `dashboard/src/server/deploy-read.ts` — ping + resolve + error + cache.
- `dashboard/src/server/deploy-read.test.ts` — unit tests.

**Modify:**
- `lib/state/types.ts` — `DeployState` / `DeployHealth`.
- `lib/state/derive.ts` — add `deploy_url?: string | null` to `RegistryProject`.
- `dashboard/src/server/registry.ts` — read `deploy_url` in `RegistryDoc` + the loader map.
- `dashboard/src/server/index.ts` — `createDeployCache()` + `GET /api/projects/:id/deploy`.
- `dashboard/src/server/index.test.ts` — test the route.
- `dashboard/src/ui/api.ts` — `getDeploy(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — `DeployStatus` sub-component.
- `dashboard/src/ui/components/ProjectCard.test.tsx` — deploy tests.
- `dashboard/src/ui/styles/dashboard.css` — `.deploy-row`.
- `registry/projects.yml` — document the optional `deploy_url` field.

---

## Task 1: Shared types + registry deploy_url

**Files:**
- Modify: `lib/state/types.ts`, `lib/state/derive.ts`, `dashboard/src/server/registry.ts`, `registry/projects.yml`

- [ ] **Step 1: Add the shared types**

Append to `lib/state/types.ts`:

```ts
// --- C.1 deploy health-check ---
export type DeployState = "up" | "degraded" | "down";
export interface DeployHealth {
  configured: boolean;
  url: string | null;
  state: DeployState | null;
  status: number | null;
  ms: number | null;
  error?: string;
}
```

- [ ] **Step 2: Add `deploy_url` to RegistryProject**

In `lib/state/derive.ts`, the `RegistryProject` interface (lines ~6-13) gains a field:

```ts
export interface RegistryProject {
  id: string;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  repo_path?: string | null;
  default_branch?: string | null;
  deploy_url?: string | null;
}
```

- [ ] **Step 3: Read `deploy_url` in the registry loader**

In `dashboard/src/server/registry.ts`, add `deploy_url` to the `RegistryDoc` project shape and the mapped output:

```ts
interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    local_path?: string;
    allowed_agents?: string[];
    default_branch?: string;
    deploy_url?: string;
  }>;
}
```
and in the `.map(...)` return object add:
```ts
    deploy_url: v?.deploy_url ?? null,
```

- [ ] **Step 4: Document the field in projects.yml**

In `registry/projects.yml`, add a line to the header comment block (after the `# default_branch, allowed_agents, sandbox, commands.` line):

```yaml
# `deploy_url` (optional): the project's public deployed URL (e.g. its Railway URL). When set, the
#   dashboard shows a read-only health-check (up/degraded/down) on the card. Leave unset to hide it.
```
(No per-project URLs are added here — Marcos fills `deploy_url:` into the projects he has deployed.)

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

```
git add lib/state/types.ts lib/state/derive.ts dashboard/src/server/registry.ts registry/projects.yml
git commit -m "feat(deploy): DeployHealth types + registry deploy_url field"
```

---

## Task 2: deploy-read.ts (ping + resolve + cache)

**Files:**
- Create: `dashboard/src/server/deploy-read.ts`
- Test: `dashboard/src/server/deploy-read.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/server/deploy-read.test.ts
import { describe, it, expect } from "vitest";
import { readDeployHealth, resolveDeployUrl, DeployError, createDeployCache, type DoFetch, type DeployPing } from "./deploy-read";

// A clock that advances 50ms per call, so elapsed ms is deterministic (= 50 between start and end).
function clock() { let t = 0; return () => (t += 50); }

describe("readDeployHealth", () => {
  it("200 → up with measured ms", async () => {
    const doFetch: DoFetch = async () => ({ status: 200 });
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r).toEqual<DeployPing>({ state: "up", status: 200, ms: 50 });
  });

  it("5xx/4xx → degraded carrying the status", async () => {
    const doFetch: DoFetch = async () => ({ status: 503 });
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r).toMatchObject({ state: "degraded", status: 503 });
  });

  it("a thrown fetch (timeout/DNS/refused) → down, never throws", async () => {
    const doFetch: DoFetch = async () => { throw new Error("ECONNREFUSED"); };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(r.state).toBe("down");
    expect(r.status).toBeNull();
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("HEAD returning 405 falls back to GET", async () => {
    const calls: string[] = [];
    const doFetch: DoFetch = async (_url, init) => { calls.push(init.method); return { status: init.method === "HEAD" ? 405 : 200 }; };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(r.state).toBe("up");
  });

  it("HEAD throwing falls back to GET", async () => {
    const calls: string[] = [];
    const doFetch: DoFetch = async (_url, init) => { calls.push(init.method); if (init.method === "HEAD") throw new Error("no HEAD"); return { status: 200 }; };
    const r = await readDeployHealth("https://x", { doFetch, now: clock() });
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(r.state).toBe("up");
  });
});

describe("resolveDeployUrl", () => {
  const reg = (rows: { id: string; deploy_url?: string | null }[]) => () => rows.map((r) => ({ id: r.id, deploy_url: r.deploy_url ?? null }));
  it("returns the configured url", () => {
    expect(resolveDeployUrl("/root", "a", { loadRegistry: reg([{ id: "a", deploy_url: "https://a.up.railway.app" }]) })).toBe("https://a.up.railway.app");
  });
  it("returns null when the project has no deploy_url", () => {
    expect(resolveDeployUrl("/root", "a", { loadRegistry: reg([{ id: "a" }]) })).toBeNull();
  });
  it("throws DeployError(404) for an unknown project", () => {
    expect(() => resolveDeployUrl("/root", "nope", { loadRegistry: reg([{ id: "a" }]) })).toThrow(DeployError);
  });
});

describe("createDeployCache", () => {
  it("serves cached within TTL and recomputes after", async () => {
    let t = 0; let calls = 0;
    const cache = createDeployCache({ ttlMs: 100, now: () => t });
    const compute = async (): Promise<DeployPing> => { calls++; return { state: "up", status: 200, ms: 1 }; };
    await cache.get("https://x", compute);
    await cache.get("https://x", compute);
    expect(calls).toBe(1);
    t = 200;
    await cache.get("https://x", compute);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/deploy-read.test.ts`
Expected: FAIL — cannot find module `./deploy-read`.

- [ ] **Step 3: Implement**

```ts
// dashboard/src/server/deploy-read.ts
import { loadRegistryProjects } from "./registry";
import type { DeployState } from "../../../lib/state/types";

export class DeployError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "DeployError"; }
}

export type DoFetch = (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;
export interface DeployPing { state: DeployState; status: number | null; ms: number; error?: string }

const TIMEOUT_MS = 6000;
const defaultFetch: DoFetch = (url, init) => fetch(url, init);

// Read-only HTTP health-check of a deploy URL. HEAD with a GET fallback, ~6s timeout. Never throws.
export async function readDeployHealth(url: string, deps: { doFetch?: DoFetch; now?: () => number } = {}): Promise<DeployPing> {
  const doFetch = deps.doFetch ?? defaultFetch;
  const now = deps.now ?? Date.now;
  const start = now();

  const ping = async (method: string): Promise<number> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(url, { method, signal: ac.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let status: number;
    try {
      status = await ping("HEAD");
      if (status === 405) status = await ping("GET");
    } catch {
      status = await ping("GET");
    }
    const ms = now() - start;
    return status < 400 ? { state: "up", status, ms } : { state: "degraded", status, ms };
  } catch (e) {
    return { state: "down", status: null, ms: now() - start, error: (e as Error).message };
  }
}

interface ResolveDeps { loadRegistry?: (repoRoot: string) => { id: string; deploy_url?: string | null }[]; }

// Resolves the deploy URL for a project id FROM THE TRUSTED REGISTRY (anti-SSRF). Throws DeployError(404)
// for an unknown id; returns null when the project exists but has no deploy_url.
export function resolveDeployUrl(repoRoot: string, id: string, deps: ResolveDeps = {}): string | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new DeployError(`unknown project: ${id}`, 404);
  return proj.deploy_url ?? null;
}

export interface DeployCache { get(key: string, compute: () => Promise<DeployPing>): Promise<DeployPing>; invalidate(key: string): void }

export function createDeployCache(opts: { ttlMs?: number; now?: () => number } = {}): DeployCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<DeployPing>; at: number }>();
  return {
    get(key, compute) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: now() });
      return value;
    },
    invalidate(key) { cache.delete(key); },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/deploy-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/server/deploy-read.ts dashboard/src/server/deploy-read.test.ts
git commit -m "feat(deploy): readDeployHealth + resolveDeployUrl (anti-SSRF) + 60s cache"
```

---

## Task 3: Route GET /api/projects/:id/deploy + api.getDeploy

**Files:**
- Modify: `dashboard/src/server/index.ts`, `dashboard/src/server/index.test.ts`, `dashboard/src/ui/api.ts`

- [ ] **Step 1: Add the failing route test**

Append to `dashboard/src/server/index.test.ts`:

```ts
describe("GET /api/projects/:id/deploy", () => {
  it("returns { configured:false } when the project has no deploy_url", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/stock-control/deploy");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });
  it("404s for an unknown project", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/nope/deploy");
    expect(res.status).toBe(404);
  });
});
```
(The test registry's `stock-control` has no `deploy_url`, so the route returns `configured:false` without any network call.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — `/api/projects/stock-control/deploy` 404 (route not defined).

- [ ] **Step 3: Implement the route**

In `dashboard/src/server/index.ts`:
- Add to imports: `import { createDeployCache, readDeployHealth, resolveDeployUrl, DeployError } from "./deploy-read";`
- Next to the other caches: `const deployCache = createDeployCache();`
- Add the route near `/api/projects/:id/deps`:

```ts
  app.get("/api/projects/:id/deploy", async (c) => {
    try {
      const url = resolveDeployUrl(repoRoot, c.req.param("id"));
      if (!url) return c.json({ configured: false, url: null, state: null, status: null, ms: null });
      const h = await deployCache.get(url, () => readDeployHealth(url));
      return c.json({ configured: true, url, ...h });
    } catch (err) {
      if (err instanceof DeployError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Add api.getDeploy**

In `dashboard/src/ui/api.ts`:
- Add `DeployHealth` to the type import from `../../../lib/state/types`.
- Add:

```ts
export async function getDeploy(id: string): Promise<DeployHealth> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deploy`);
  if (!res.ok) throw new Error(`deploy failed: ${res.status}`);
  return (await res.json()) as DeployHealth;
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → exit 0.

```
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts dashboard/src/ui/api.ts
git commit -m "feat(deploy): GET /api/projects/:id/deploy route + api.getDeploy client"
```

---

## Task 4: ProjectCard DeployStatus

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`, `dashboard/src/ui/components/ProjectCard.test.tsx`, `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Add the failing test**

Append a new `describe` to `dashboard/src/ui/components/ProjectCard.test.tsx`:

```ts
describe("ProjectCard deploy health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the deploy dot, label and 'abrir sitio' link when configured + up", async () => {
    vi.spyOn(api, "getDeploy").mockResolvedValue({ configured: true, url: "https://alpha.up.railway.app", state: "up", status: 200, ms: 120 });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(screen.getByText(/up/)).toBeTruthy());
    const link = screen.getByRole("link", { name: /abrir sitio/i });
    expect(link.getAttribute("href")).toBe("https://alpha.up.railway.app");
  });

  it("renders no deploy control when the project is not configured for deploy", async () => {
    vi.spyOn(api, "getDeploy").mockResolvedValue({ configured: false, url: null, state: null, status: null, ms: null });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(api.getDeploy).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /abrir sitio/i })).toBeNull();
  });
});
```
Note: `ProjectCard.test.tsx` already imports `* as api from "../api"` and `{ render, screen, waitFor }` — reuse them. (If `api` is not yet imported as a namespace in that file, add `import * as api from "../api";`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — `api.getDeploy` is not a function / no deploy control rendered.

- [ ] **Step 3: Implement DeployStatus + render it**

In `dashboard/src/ui/components/ProjectCard.tsx`:
- Add `getDeploy` to the api import and `useEffect` to the react import (it already imports `useState`/`useEffect` for `BranchPanel`).
- Add `DeployHealth` to the type import line from `../../../../lib/state/types`.
- Add the sub-component:

```tsx
function DeployStatus({ projectId }: { projectId: string }) {
  const [data, setData] = useState<DeployHealth | null>(null);
  useEffect(() => {
    let active = true;
    getDeploy(projectId).then((d) => { if (active) setData(d); }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);
  if (!data || !data.configured) return null;
  const dot = data.state === "up" ? "ok" : data.state === "degraded" ? "warn" : "danger";
  const label = data.state === "up" ? "up" : data.state === "degraded" ? `HTTP ${data.status}` : "down";
  return (
    <div className="deploy-row">
      <span className={`pdot pdot--${dot}`} />
      <span>Deploy: {label}{data.ms != null ? ` · ${data.ms}ms` : ""}</span>
      {data.url && <a className="card-link-btn" href={data.url} target="_blank" rel="noreferrer">abrir sitio</a>}
    </div>
  );
}
```
- Render it inside the card, right after the `<GitLine .../>` + commit block (before `.counts`) so deploy status sits near the top:
```tsx
      <DeployStatus projectId={p.id} />
```

- [ ] **Step 4: Add the CSS**

Append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* deploy health */
.deploy-row { display:flex; align-items:center; gap:8px; font-family: var(--font-mono); font-size:11px; color: var(--fg2); flex-wrap:wrap; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (the existing 28 + the 2 new). If any existing test now makes an unexpected `getDeploy` call, note that `DeployStatus` renders nothing unless the response has `configured:true`, so unstubbed/`{ok:true}`-stubbed tests render no deploy control — they should stay green.

- [ ] **Step 6: Commit**

```
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(deploy): ProjectCard DeployStatus (auto-loaded health dot + link)"
```

---

## Task 5: Verify + visual smoke + finish

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all green (358 + the new deploy-read / route / ProjectCard tests).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit` → exit 0.
Run: `pnpm build` → `✓ built`.

- [ ] **Step 3: Live visual smoke**

Ask Marcos for one real Railway `deploy_url` (or set one on a deployed project in `registry/projects.yml`).
If the user's dev server is up on :5173, screenshot the Overview and confirm that project's card shows
the deploy dot (up/down) + "abrir sitio"; otherwise note the smoke is deferred (don't start a `pnpm dev`).

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch**: verify tests, then merge `--no-ff` to master + push to
origin (established flow), delete the branch. Update memory: start a Phase C entry in
`live-status-dashboard-slice.md` (C.1 deploy health-check done; C.2/C.3 noted); bump slice count + HEAD;
refresh `MEMORY.md`.

---

## Self-Review

**1. Spec coverage:**
- Read-only HTTP ping (HEAD+GET fallback, timeout, never-throws) → Task 2 `readDeployHealth`. ✓
- up/degraded/down + status + ms → Task 2 mapping + tests. ✓
- Anti-SSRF (registry-resolved URL by id) → Task 2 `resolveDeployUrl`. ✓
- 60s cache → Task 2 `createDeployCache`. ✓
- `deploy_url` registry field → Task 1 (types/loader/derive/projects.yml). ✓
- Route `GET /api/projects/:id/deploy` (configured/unconfigured/404) → Task 3. ✓
- `getDeploy` client → Task 3. ✓
- Per-card auto-loaded DeployStatus (dot/label/ms/link, nothing when unconfigured) → Task 4. ✓
- Shared types without node deps in client → Task 1 (types in `lib/state/types.ts`). ✓
- Tests (deploy-read, route, ProjectCard) + gate → Tasks 2,3,4,5. ✓

**2. Placeholder scan:** No "TBD"/"add validation" placeholders. Task 4 Step 1 has a conditional note about the `api` namespace import being a verification, not a placeholder — the test code is complete.

**3. Type consistency:** `DeployState`/`DeployHealth` defined in Task 1 (lib/state/types.ts), consumed in Task 2 (`deploy-read` imports `DeployState`; returns `DeployPing`), Task 3 (`getDeploy(): Promise<DeployHealth>`; the route returns the `DeployHealth` shape `{configured,url,...DeployPing}`), Task 4 (`DeployStatus` consumes `DeployHealth`). `DeployPing` (`{state,status,ms,error?}`) is consistent across `readDeployHealth`, the cache, and the route spread (`{ configured:true, url, ...h }` where `h: DeployPing`). `resolveDeployUrl(repoRoot, id, deps)` + `DeployError` consistent with the deps-read pattern. `RegistryProject.deploy_url` (Task 1) is read by `resolveDeployUrl` via `loadRegistryProjects` (Task 2). ✓
