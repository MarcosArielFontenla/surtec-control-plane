# C.2 — Railway Deploy Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-card Railway deploy line — the latest Railway deployment state (success/building/failed/…) + when, via the Railway GraphQL API with a `RAILWAY_TOKEN`, auto-loaded on mount.

**Architecture:** A new server module POSTs the Railway `deployments(first:1)` GraphQL query (Bearer token, ~10s timeout, never-throws) behind a 60s cache; the Railway IDs are resolved server-side from `registry/projects.yml` by project id (the client sends only the id; the token lives only in `process.env.RAILWAY_TOKEN`). `GET /api/projects/:id/railway` returns the status; a `RailwayLine` sub-component in `ProjectCard` fetches it on mount and renders the state dot + relative time + link (nothing when unconfigured). Mirrors the C.1 deploy-read pattern.

**Tech Stack:** TS ESM, Hono, Node global `fetch` + `AbortController`, React 18, Vitest + Testing Library/jsdom, pnpm.

**Grounding (read for patterns):** `dashboard/src/server/deploy-read.ts` (C.1: the `DeployError`/`resolveDeployUrl`/`createDeployCache`/injectable-fetch pattern this mirrors almost exactly), `dashboard/src/server/registry.ts` + `lib/state/derive.ts:6-14` (the `deploy_url` field added in C.1 — add `railway` the same way), `dashboard/src/server/index.ts` (the `/api/projects/:id/deploy` route + cache wiring), `dashboard/src/ui/components/ProjectCard.tsx` (the C.1 `DeployStatus` sub-component + `.deploy-row`/`.pdot` classes + `relativeTime` import), `dashboard/src/ui/api.ts` (`getDeploy` — `getRailway` mirrors it).

**Railway API (verified):** `POST https://backboard.railway.com/graphql/v2`, `Authorization: Bearer <token>`, query `query latestDeployment($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status url createdAt } } } }` with `variables.input = { projectId, serviceId, environmentId }`. `DeploymentStatus` ∈ SUCCESS, BUILDING, DEPLOYING, FAILED, CRASHED, REMOVED, SLEEPING, SKIPPED, WAITING, QUEUED.

**Naming contract (keep identical across tasks):**
- Types in `lib/state/types.ts`: `RailwayState = "success"|"building"|"deploying"|"failed"|"crashed"|"removed"|"sleeping"|"skipped"|"waiting"|"queued"|"unknown"`, `RailwayStatus = { configured: boolean; ok: boolean; state: RailwayState | null; at: string | null; url: string | null; error?: string }`.
- `railway-read.ts` exports: `RailwayIds` (`{ project_id; service_id; environment_id }`), `DoFetch`, `RailwayPing` (`{ ok; state: RailwayState|null; at: string|null; url: string|null; error? }`), `readRailwayDeploy(ids, token, deps?)`, `resolveRailway(repoRoot, id, deps?)`, `RailwayError`, `createRailwayCache(opts?)`, `RailwayCache`.
- Registry block: `railway?: { project_id: string; service_id: string; environment_id: string } | null` (on `RegistryProject` and the loaders).
- `api.ts`: `getRailway(id): Promise<RailwayStatus>`.
- Component: `RailwayLine` (the type is `RailwayStatus`; the component is `RailwayLine` to avoid a name clash).

---

## File Structure

**Create:**
- `dashboard/src/server/railway-read.ts` — query + resolve + error + cache.
- `dashboard/src/server/railway-read.test.ts` — unit tests.

**Modify:**
- `lib/state/types.ts` — `RailwayState` / `RailwayStatus`.
- `lib/state/derive.ts` — add `railway?: {...} | null` to `RegistryProject`.
- `dashboard/src/server/registry.ts` — read the `railway` block in `RegistryDoc` + the loader map.
- `dashboard/src/server/index.ts` — `createRailwayCache()` + `GET /api/projects/:id/railway`.
- `dashboard/src/server/index.test.ts` — test the route.
- `dashboard/src/ui/api.ts` — `getRailway(id)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — `RailwayLine` sub-component.
- `dashboard/src/ui/components/ProjectCard.test.tsx` — railway tests.
- `registry/projects.yml` — document the optional `railway` block.
- `.env.example` — document `RAILWAY_TOKEN`.

---

## Task 1: Shared types + registry railway block + env doc

**Files:** `lib/state/types.ts`, `lib/state/derive.ts`, `dashboard/src/server/registry.ts`, `registry/projects.yml`, `.env.example`

- [ ] **Step 1: Add the shared types**

Append to `lib/state/types.ts`:

```ts
// --- C.2 Railway deploy status ---
export type RailwayState = "success" | "building" | "deploying" | "failed" | "crashed" | "removed" | "sleeping" | "skipped" | "waiting" | "queued" | "unknown";
export interface RailwayStatus {
  configured: boolean;
  ok: boolean;
  state: RailwayState | null;
  at: string | null;
  url: string | null;
  error?: string;
}
```

- [ ] **Step 2: Add `railway` to RegistryProject**

In `lib/state/derive.ts`, the `RegistryProject` interface gains a field (after `deploy_url`):

```ts
  deploy_url?: string | null;
  railway?: { project_id: string; service_id: string; environment_id: string } | null;
}
```

- [ ] **Step 3: Read the `railway` block in the loader**

In `dashboard/src/server/registry.ts`, extend the `RegistryDoc` project shape and the mapped output.
Add to the inner project type (after `deploy_url?: string;`):
```ts
    railway?: { project_id?: string; service_id?: string; environment_id?: string };
```
And in the `.map(...)` return object add:
```ts
    railway: v?.railway?.project_id && v?.railway?.service_id && v?.railway?.environment_id
      ? { project_id: v.railway.project_id, service_id: v.railway.service_id, environment_id: v.railway.environment_id }
      : null,
```
(Only a fully-specified block counts as configured; a partial block → null.)

- [ ] **Step 4: Document the registry block + env token**

In `registry/projects.yml`, extend the header comment (after the `deploy_url` lines):
```yaml
# `railway` (optional): the project's Railway ids (from a service's "Railway provided variables"). When
#   set AND RAILWAY_TOKEN is in the env, the card shows the latest Railway deploy state. Example:
#     railway:
#       project_id: <uuid>
#       service_id: <uuid>
#       environment_id: <uuid>
```

In `.env.example`, append:
```
# Railway deploy status (C.2): an account/workspace token (https://railway.com/account/tokens).
# Read-only; only used to query the latest deployment state. Leave unset to hide the Railway line.
RAILWAY_TOKEN=
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`  → exit 0.

```
git add lib/state/types.ts lib/state/derive.ts dashboard/src/server/registry.ts registry/projects.yml .env.example
git commit -m "feat(railway): RailwayStatus types + registry railway block + RAILWAY_TOKEN env doc"
```

---

## Task 2: railway-read.ts (query + resolve + cache)

**Files:**
- Create: `dashboard/src/server/railway-read.ts`
- Test: `dashboard/src/server/railway-read.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/server/railway-read.test.ts
import { describe, it, expect } from "vitest";
import { readRailwayDeploy, resolveRailway, RailwayError, createRailwayCache, type DoFetch, type RailwayPing, type RailwayIds } from "./railway-read";

const ids: RailwayIds = { project_id: "p1", service_id: "s1", environment_id: "e1" };
const okResp = (node: unknown) => ({ status: 200, json: async () => ({ data: { deployments: { edges: node ? [{ node }] : [] } } }) });

describe("readRailwayDeploy", () => {
  it("parses the latest deployment node and maps the status to a lowercase state", async () => {
    const doFetch: DoFetch = async () => okResp({ id: "d1", status: "SUCCESS", url: "https://x.up.railway.app", createdAt: "2026-05-30T10:00:00Z" });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r).toEqual<RailwayPing>({ ok: true, state: "success", at: "2026-05-30T10:00:00Z", url: "https://x.up.railway.app" });
  });

  it("maps each known status; unknown enum → 'unknown'", async () => {
    for (const [raw, mapped] of [["BUILDING", "building"], ["FAILED", "failed"], ["CRASHED", "crashed"], ["WEIRD", "unknown"]] as const) {
      const doFetch: DoFetch = async () => okResp({ status: raw, url: null, createdAt: "t" });
      expect((await readRailwayDeploy(ids, "tok", { doFetch })).state).toBe(mapped);
    }
  });

  it("sends a Bearer token and the deployments query with the ids", async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const doFetch: DoFetch = async (_url, init) => { captured = init; return okResp({ status: "SUCCESS", url: null, createdAt: "t" }); };
    await readRailwayDeploy(ids, "secret", { doFetch });
    expect(captured!.headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(captured!.body);
    expect(body.query).toContain("deployments");
    expect(body.variables.input).toEqual({ projectId: "p1", serviceId: "s1", environmentId: "e1" });
  });

  it("empty edges → { ok:false }", async () => {
    const doFetch: DoFetch = async () => okResp(null);
    expect((await readRailwayDeploy(ids, "tok", { doFetch })).ok).toBe(false);
  });

  it("HTTP non-2xx → { ok:false, error }", async () => {
    const doFetch: DoFetch = async () => ({ status: 401, json: async () => ({}) });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("401");
  });

  it("a GraphQL errors array → { ok:false }", async () => {
    const doFetch: DoFetch = async () => ({ status: 200, json: async () => ({ errors: [{ message: "Problem processing request" }] }) });
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("Problem");
  });

  it("a thrown fetch (timeout/network) → { ok:false }, never throws", async () => {
    const doFetch: DoFetch = async () => { throw new Error("ECONNRESET"); };
    const r = await readRailwayDeploy(ids, "tok", { doFetch });
    expect(r.ok).toBe(false); expect(r.error).toContain("ECONNRESET");
  });
});

describe("resolveRailway", () => {
  const reg = (rows: { id: string; railway?: RailwayIds | null }[]) => () => rows.map((r) => ({ id: r.id, railway: r.railway ?? null }));
  it("returns the ids block", () => {
    expect(resolveRailway("/root", "a", { loadRegistry: reg([{ id: "a", railway: ids }]) })).toEqual(ids);
  });
  it("returns null when the project has no railway block", () => {
    expect(resolveRailway("/root", "a", { loadRegistry: reg([{ id: "a" }]) })).toBeNull();
  });
  it("throws RailwayError(404) for an unknown project", () => {
    expect(() => resolveRailway("/root", "nope", { loadRegistry: reg([{ id: "a" }]) })).toThrow(RailwayError);
  });
});

describe("createRailwayCache", () => {
  it("serves cached within TTL and recomputes after", async () => {
    let t = 0; let calls = 0;
    const cache = createRailwayCache({ ttlMs: 100, now: () => t });
    const compute = async (): Promise<RailwayPing> => { calls++; return { ok: true, state: "success", at: "t", url: null }; };
    await cache.get("s1", compute);
    await cache.get("s1", compute);
    expect(calls).toBe(1);
    t = 200;
    await cache.get("s1", compute);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/railway-read.test.ts`
Expected: FAIL — cannot find module `./railway-read`.

- [ ] **Step 3: Implement**

```ts
// dashboard/src/server/railway-read.ts
import { loadRegistryProjects } from "./registry";
import type { RailwayState } from "../../../lib/state/types";

export class RailwayError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "RailwayError"; }
}

export interface RailwayIds { project_id: string; service_id: string; environment_id: string }
export type DoFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
export interface RailwayPing { ok: boolean; state: RailwayState | null; at: string | null; url: string | null; error?: string }

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TIMEOUT_MS = 10_000;
const QUERY = `query latestDeployment($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) { edges { node { id status url createdAt } } }
}`;

const STATE_MAP: Record<string, RailwayState> = {
  SUCCESS: "success", BUILDING: "building", DEPLOYING: "deploying", FAILED: "failed",
  CRASHED: "crashed", REMOVED: "removed", SLEEPING: "sleeping", SKIPPED: "skipped",
  WAITING: "waiting", QUEUED: "queued",
};

const defaultFetch: DoFetch = (url, init) => fetch(url, init);

interface GqlResp { errors?: { message?: string }[]; data?: { deployments?: { edges?: { node?: { status?: string; url?: string | null; createdAt?: string } }[] } } }

// Reads the latest Railway deployment via the read-only GraphQL `deployments` query. Never throws.
export async function readRailwayDeploy(ids: RailwayIds, token: string, deps: { doFetch?: DoFetch } = {}): Promise<RailwayPing> {
  const doFetch = deps.doFetch ?? defaultFetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: QUERY, variables: { input: { projectId: ids.project_id, serviceId: ids.service_id, environmentId: ids.environment_id } } }),
      signal: ac.signal,
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, state: null, at: null, url: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as GqlResp;
    if (body.errors && body.errors.length) {
      return { ok: false, state: null, at: null, url: null, error: (body.errors.map((e) => e.message ?? "").join("; ") || "graphql error").slice(0, 500) };
    }
    const node = body.data?.deployments?.edges?.[0]?.node;
    if (!node) return { ok: false, state: null, at: null, url: null, error: "sin deployments" };
    return { ok: true, state: STATE_MAP[node.status ?? ""] ?? "unknown", at: node.createdAt ?? null, url: node.url ?? null };
  } catch (e) {
    return { ok: false, state: null, at: null, url: null, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

interface ResolveDeps { loadRegistry?: (repoRoot: string) => { id: string; railway?: RailwayIds | null }[]; }

// Resolves a project's Railway ids FROM THE TRUSTED REGISTRY (anti-injection). Throws RailwayError(404)
// for an unknown id; returns null when the project has no railway block.
export function resolveRailway(repoRoot: string, id: string, deps: ResolveDeps = {}): RailwayIds | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new RailwayError(`unknown project: ${id}`, 404);
  return proj.railway ?? null;
}

export interface RailwayCache { get(key: string, compute: () => Promise<RailwayPing>): Promise<RailwayPing>; invalidate(key: string): void }

export function createRailwayCache(opts: { ttlMs?: number; now?: () => number } = {}): RailwayCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: Promise<RailwayPing>; at: number }>();
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

Run: `pnpm exec vitest run dashboard/src/server/railway-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/server/railway-read.ts dashboard/src/server/railway-read.test.ts
git commit -m "feat(railway): readRailwayDeploy (GraphQL, never-throws) + resolveRailway + 60s cache"
```

---

## Task 3: Route GET /api/projects/:id/railway + api.getRailway

**Files:** `dashboard/src/server/index.ts`, `dashboard/src/server/index.test.ts`, `dashboard/src/ui/api.ts`

- [ ] **Step 1: Add the failing route test**

Append to `dashboard/src/server/index.test.ts`:

```ts
describe("GET /api/projects/:id/railway", () => {
  it("returns { configured:false } when the project has no railway block", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/stock-control/railway");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });
  it("404s for an unknown project", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/nope/railway");
    expect(res.status).toBe(404);
  });
});
```
(The test registry's `stock-control` has no `railway` block, so the route returns `configured:false` without any network call — regardless of whether `RAILWAY_TOKEN` is set in the env.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — `/api/projects/stock-control/railway` 404 (route not defined).

- [ ] **Step 3: Implement the route**

In `dashboard/src/server/index.ts`:
- Add to imports: `import { createRailwayCache, readRailwayDeploy, resolveRailway, RailwayError } from "./railway-read";`
- Next to the other caches: `const railwayCache = createRailwayCache();`
- Add the route near `/api/projects/:id/deploy`:

```ts
  app.get("/api/projects/:id/railway", async (c) => {
    try {
      const ids = resolveRailway(repoRoot, c.req.param("id"));
      const token = process.env.RAILWAY_TOKEN;
      if (!ids || !token) return c.json({ configured: false, ok: false, state: null, at: null, url: null });
      const r = await railwayCache.get(ids.service_id, () => readRailwayDeploy(ids, token));
      return c.json({ configured: true, ...r });
    } catch (err) {
      if (err instanceof RailwayError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Add api.getRailway**

In `dashboard/src/ui/api.ts`:
- Add `RailwayStatus` to the type import from `../../../lib/state/types`.
- Add:

```ts
export async function getRailway(id: string): Promise<RailwayStatus> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/railway`);
  if (!res.ok) throw new Error(`railway failed: ${res.status}`);
  return (await res.json()) as RailwayStatus;
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → exit 0.

```
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts dashboard/src/ui/api.ts
git commit -m "feat(railway): GET /api/projects/:id/railway route + api.getRailway client"
```

---

## Task 4: ProjectCard RailwayLine

**Files:** `dashboard/src/ui/components/ProjectCard.tsx`, `dashboard/src/ui/components/ProjectCard.test.tsx`

- [ ] **Step 1: Add the failing test**

Append a new `describe` to `dashboard/src/ui/components/ProjectCard.test.tsx` (the file already imports `* as api`, `render/screen/waitFor`, `vi`, `afterEach`, and `base`):

```ts
describe("ProjectCard railway deploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the railway state + relative time + link when configured", async () => {
    vi.spyOn(api, "getRailway").mockResolvedValue({ configured: true, ok: true, state: "success", at: "2026-05-30T10:00:00Z", url: "https://x.up.railway.app" });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(screen.getByText(/Railway: success/)).toBeTruthy());
    expect(screen.getByRole("link", { name: /ver deploy/i }).getAttribute("href")).toBe("https://x.up.railway.app");
  });

  it("renders no railway line when not configured", async () => {
    vi.spyOn(api, "getRailway").mockResolvedValue({ configured: false, ok: false, state: null, at: null, url: null });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(api.getRailway).toHaveBeenCalled());
    expect(screen.queryByText(/Railway:/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — `api.getRailway` is not a function / no railway line.

- [ ] **Step 3: Implement RailwayLine + render it**

In `dashboard/src/ui/components/ProjectCard.tsx`:
- Add `getRailway` to the api import; add `RailwayStatus`, `RailwayState` to the type import line from `../../../../lib/state/types`.
- Add the sub-component (next to `DeployStatus`):

```tsx
const RAILWAY_DOT: Record<RailwayState, string> = {
  success: "ok", building: "info", deploying: "info", queued: "info", waiting: "info",
  failed: "danger", crashed: "danger", removed: "muted", sleeping: "muted", skipped: "muted", unknown: "muted",
};

function RailwayLine({ projectId }: { projectId: string }) {
  const [data, setData] = useState<RailwayStatus | null>(null);
  useEffect(() => {
    let active = true;
    getRailway(projectId).then((d) => { if (active) setData(d); }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);
  if (!data || !data.configured || !data.ok || !data.state) return null;
  return (
    <div className="deploy-row">
      <span className={`pdot pdot--${RAILWAY_DOT[data.state]}`} />
      <span>Railway: {data.state}{data.at ? ` · ${relativeTime(data.at)}` : ""}</span>
      {data.url && <a className="card-link-btn" href={data.url} target="_blank" rel="noreferrer">ver deploy</a>}
    </div>
  );
}
```
- Render it right after `<DeployStatus projectId={p.id} />`:
```tsx
      <DeployStatus projectId={p.id} />
      <RailwayLine projectId={p.id} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (the existing 30 + the 2 new). Existing tests that don't mock `getRailway` get a swallowed/`configured:false` response → `RailwayLine` renders nothing, so they stay green.

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx
git commit -m "feat(railway): ProjectCard RailwayLine (auto-loaded deploy state + link)"
```

---

## Task 5: Verify + finish

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all green (371 + the new railway-read / route / ProjectCard tests).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit` → exit 0.
Run: `pnpm build` → `✓ built`.

- [ ] **Step 3: Real-path note (live verification deferred)**

The Railway live path needs Marcos's `RAILWAY_TOKEN` + a `railway:` block, so it cannot be smoke-tested
here. Note in the finish message that he sets `RAILWAY_TOKEN` in `.env` and fills a `railway:` block to
see the line. (The `readRailwayDeploy` GraphQL parsing/never-throws is covered by the injected-`DoFetch`
unit tests.)

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch**: verify tests, then merge `--no-ff` to master + push to
origin, delete the branch. Update memory: add C.2 to the Phase C entry in
`live-status-dashboard-slice.md` (C.2 Railway deploy status done; C.3 actions noted); bump slice count +
HEAD; refresh `MEMORY.md`.

---

## Self-Review

**1. Spec coverage:**
- Read-only Railway GraphQL `deployments(first:1)` query, Bearer token, never-throws → Task 2 `readDeployHealth`→`readRailwayDeploy`. ✓
- Status enum → lowercase state map (incl. "unknown") → Task 2 `STATE_MAP` + tests. ✓
- Anti-injection (registry-resolved ids by id) + token server-only → Task 2 `resolveRailway`; Task 3 route reads `process.env.RAILWAY_TOKEN`, never returns it. ✓
- 60s cache keyed by service_id → Task 2 `createRailwayCache`; Task 3 `railwayCache.get(ids.service_id, …)`. ✓
- `railway` registry block + `RAILWAY_TOKEN` env doc → Task 1. ✓
- Route `GET /api/projects/:id/railway` (configured:false without token/ids; 404; never 500) → Task 3. ✓
- `getRailway` client → Task 3. ✓
- Per-card auto-loaded `RailwayLine` (state dot/time/link, nothing when unconfigured) → Task 4. ✓
- Shared types without node deps in client → Task 1 (types in `lib/state/types.ts`). ✓
- Tests + gate; live verification deferred → Tasks 2,3,4,5. ✓

**2. Placeholder scan:** No "TBD"/"add validation" placeholders; all code blocks complete. Task 5 Step 3 documents *why* live verification is deferred (needs the user's token) — that is a real constraint, not a TODO.

**3. Type consistency:** `RailwayState`/`RailwayStatus` defined in Task 1 and consumed in Task 2 (`readRailwayDeploy` returns `RailwayPing` using `RailwayState`), Task 3 (`getRailway(): Promise<RailwayStatus>`; route returns `{ configured, ...RailwayPing }` = the `RailwayStatus` shape), Task 4 (`RailwayLine` consumes `RailwayStatus`/`RailwayState`). `RailwayIds` (`{project_id,service_id,environment_id}`) consistent across `readRailwayDeploy`/`resolveRailway`/the registry block/the route's `ids.service_id`. `RailwayPing` (`{ok,state,at,url,error?}`) consistent across `readRailwayDeploy`, the cache, and the route spread. The component is `RailwayLine` (distinct from the `RailwayStatus` type) — no name clash. `RegistryProject.railway` (Task 1) is read by `resolveRailway` via `loadRegistryProjects` (Task 2). ✓
