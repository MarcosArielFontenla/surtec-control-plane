# C.2 — Railway Deploy Status (Design Spec)

**Date:** 2026-05-31
**Status:** Approved (design)
**Branch:** `feat/c2-railway-status`
**Theme:** C (deploy / ops) — second slice (builds on C.1 health-check)

## Goal

Per project, surface the **latest Railway deployment state** (success / building / deploying / failed /
crashed / sleeping / …) + when, via the Railway GraphQL API authenticated with a single
`RAILWAY_TOKEN`. Complements C.1 (HTTP health: "is the URL responding") with "did the last deploy
succeed / is it building".

## Railway API (verified)

- **Endpoint:** `POST https://backboard.railway.com/graphql/v2`.
- **Auth:** `Authorization: Bearer <account/workspace token>` (Marcos uses one account/workspace token).
- **Query (latest deployment):**
  ```graphql
  query latestDeployment($input: DeploymentListInput!) {
    deployments(input: $input, first: 1) { edges { node { id status url createdAt } } }
  }
  ```
  with `variables = { input: { projectId, serviceId, environmentId } }`.
- **`DeploymentStatus` enum:** `SUCCESS`, `BUILDING`, `DEPLOYING`, `FAILED`, `CRASHED`, `REMOVED`,
  `SLEEPING`, `SKIPPED`, `WAITING`, `QUEUED`. The 3 IDs come from a service's "Railway provided
  variables".

## Scope (v1)

- A per-card **Railway** line (sibling of the C.1 Deploy line), **auto-loaded on mount**: a colored dot
  by state + the normalized state + relative time of the deploy, and a link to the deploy URL.
- Projects without a `railway` config block — or when `RAILWAY_TOKEN` is unset — show no Railway line
  (graceful; C.1 health is unaffected).

## Constraints / security

- **Read-only** (only the `deployments` query; no mutations).
- **Token only server-side:** `process.env.RAILWAY_TOKEN`, never committed, never sent to the client,
  never logged. Documented in `.env.example`.
- **Registry-derived config (anti-injection):** the client sends only the project `id`; the server
  resolves the Railway IDs from `registry/projects.yml`. The Railway IDs (project/service/environment)
  are not secrets — they live in the committed registry; only the token is secret.
- **Never throws:** HTTP error, GraphQL `errors`, empty `edges`, bad JSON → `{ ok: false, error }`.
  Cache ~60s.

## Architecture

### Registry

- `registry/projects.yml`: an optional **`railway`** block per project:
  ```yaml
  railway:
    project_id: <uuid>
    service_id: <uuid>
    environment_id: <uuid>
  ```
- `dashboard/src/server/registry.ts` (`loadRegistryProjects` + `RegistryDoc`) and `RegistryProject`
  (`lib/state/derive.ts`) gain `railway?: { project_id: string; service_id: string; environment_id: string } | null`.

### Shared types — `lib/state/types.ts`

- `RailwayState = "success" | "building" | "deploying" | "failed" | "crashed" | "removed" | "sleeping" | "skipped" | "waiting" | "queued" | "unknown"`
- `RailwayStatus = { configured: boolean; ok: boolean; state: RailwayState | null; at: string | null; url: string | null; error?: string }`

### Server — `dashboard/src/server/railway-read.ts` (new)

- `RailwayIds = { project_id: string; service_id: string; environment_id: string }`.
- `DoFetch = (url: string, init: { method: string; headers: Record<string,string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>` — default wraps global `fetch`.
- `RailwayPing = { ok: boolean; state: RailwayState | null; at: string | null; url: string | null; error?: string }`.
- `readRailwayDeploy(ids, token, deps?): Promise<RailwayPing>` — POSTs the query (with a ~10s
  AbortController timeout) and `Authorization: Bearer ${token}`; parses
  `json.data.deployments.edges[0].node`; maps the raw `status` to lowercase `RailwayState`
  (unrecognized → "unknown"); `at = node.createdAt`, `url = node.url`. Any HTTP non-2xx, a top-level
  GraphQL `errors` array, no edges, or a thrown/timeout → `{ ok: false, state: null, ... , error }`.
  Never throws. Injectable `now` clock is not needed (no latency measured here).
- `resolveRailway(repoRoot, id, deps?): RailwayIds | null` — looks the project up in
  `loadRegistryProjects`; throws `RailwayError(404)` for an unknown id; returns the `railway` block (or
  null if the project has none).
- `createRailwayCache({ ttlMs?, now? })` — async promise-cache keyed by `service_id`, TTL ~60s (mirrors
  `createDeployCache`).

### Route — `dashboard/src/server/index.ts`

- `const railwayCache = createRailwayCache();` next to the other caches.
- `app.get("/api/projects/:id/railway", async (c) => { try { const ids = resolveRailway(repoRoot, id); const token = process.env.RAILWAY_TOKEN; if (!ids || !token) return c.json({ configured: false, ok: false, state: null, at: null, url: null }); const r = await railwayCache.get(ids.service_id, () => readRailwayDeploy(ids, token)); return c.json({ configured: true, ...r }); } catch (err) { if (err instanceof RailwayError) return c.json({ error }, 404); return c.json({ error }, 500); } })`.

### Client — `dashboard/src/ui/api.ts`

- `getRailway(id): Promise<RailwayStatus>` — `GET /api/projects/:id/railway`.

### UI — `dashboard/src/ui/components/ProjectCard.tsx`

- A new `RailwayStatus` sub-component (sibling of `DeployStatus`; C.1 untouched), rendered right after
  `<DeployStatus />`. On mount calls `getRailway(p.id)`; if `!configured` (or error) → renders nothing;
  else a `.deploy-row` line: a `.pdot pdot--{dot}` + `Railway: {state}` + ` · {relativeTime(at)}` +
  optional "ver deploy" link to `url`. Dot mapping: `success` → ok (green); `building`/`deploying`/
  `queued`/`waiting` → info (glacier); `failed`/`crashed` → danger (red); `sleeping`/`removed`/
  `skipped`/`unknown` → muted.

## Data flow

`ProjectCard` mounts → `getRailway(id)` → `GET /api/projects/:id/railway` → `resolveRailway` (registry)
+ `process.env.RAILWAY_TOKEN` → `railwayCache.get(service_id, () => readRailwayDeploy(ids, token))` →
Railway GraphQL POST → `RailwayStatus`. The 60s cache absorbs re-mounts/poll re-renders. No change to
the overview/runs flows or to C.1.

## Error handling

- No `railway` block in the registry, or `RAILWAY_TOKEN` unset → `{ configured: false }` → card shows no
  Railway line (C.1 health still shows).
- Unknown project id → 404.
- Railway API down / unauthorized / GraphQL error / no deployments → `{ ok: false, error }` (card shows
  a muted "Railway: n/a" or nothing — see UI). Never a 500 from the query itself.

## Testing

- `dashboard/src/server/railway-read.test.ts`: `readRailwayDeploy` (parses `edges[0].node`; maps each
  status enum → state; empty edges → `{ ok:false }`; HTTP 401/500 → `{ ok:false, error }`; GraphQL
  `errors` → `{ ok:false }`; bad JSON → `{ ok:false }`; sends the Bearer header + the query body —
  asserted via an injected `DoFetch`; never-throws), `resolveRailway` (returns ids / null when no block
  / throws 404), `createRailwayCache` (TTL hit/miss).
- `dashboard/src/server/index.test.ts`: `GET /api/projects/:id/railway` → `{ configured:false }` when no
  token/ids (the test registry has none + no env token); 404 for an unknown id; never 500.
- `dashboard/src/ui/components/ProjectCard.test.tsx`: with a mocked `getRailway`, a configured project
  shows the Railway state + relative time; an unconfigured one shows no Railway line.
- **Live verification deferred to Marcos:** with `RAILWAY_TOKEN` set and a `railway` block configured,
  confirm a card shows the real deploy state. (Tests inject `DoFetch`; the live Railway path needs his
  token.)
- Gate: full suite (371 + new) green, `tsc --noEmit` clean, `vite build` clean.

## Slice / delivery

- Branch `feat/c2-railway-status`; TDD; merge `--no-ff` to master + push to origin.
- New dep: none (global `fetch`).
- `.env.example` gains a documented `RAILWAY_TOKEN=` line. Marcos sets the token in `.env` and fills the
  `railway:` blocks for his deployed projects.

## Out of scope (noted follow-ups → C.3 / later)

- Deploy actions (redeploy / view build logs) — C.3 (write, mutations). Project-token support
  (`Project-Access-Token` header). Discover-by-name mapping. Build/deploy logs streaming. An aggregate
  "N failed deploys" KPI/Resumen row. Combining the C.1 health + C.2 deploy state into one line.
