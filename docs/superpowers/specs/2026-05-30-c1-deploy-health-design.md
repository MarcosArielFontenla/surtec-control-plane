# C.1 — Deploy Health-Check (Design Spec)

**Date:** 2026-05-30
**Status:** Approved (design)
**Branch:** `feat/c1-deploy-health`
**Theme:** C (deploy / ops) — first slice

## Goal

Per project, answer **"is the deployed site alive?"** at a glance: a read-only HTTP health-check of the
project's public deploy URL (Railway), showing **up / degraded / down** + HTTP status + response time.
No tokens, platform-agnostic.

## Phase C decomposition (context)

- **C.1 — Deploy health-check (this slice):** HTTP ping of the deploy URL. Read-only, no token.
- **C.2 — Railway deploy status (later):** last deploy success/failed/building + date via the Railway
  GraphQL API (needs `RAILWAY_TOKEN`).
- **C.3 — Deploy actions (later):** trigger redeploy / view build logs (write, token with permissions).

## Scope (v1)

- A per-card **Deploy** status: a colored dot + label (up / degraded / down) + HTTP status + latency,
  plus an "abrir sitio" link to the URL. **Auto-loaded on card mount** (Marcos wants the "is it alive?"
  at a glance, not behind a click), server-cached ~60s.
- Projects without a configured deploy URL show no deploy control (graceful).

## Constraints / security

- **Read-only HTTP** (`fetch`, method HEAD with GET fallback), short timeout (~6s via AbortController).
  **Never throws** — timeout/DNS/connection error → `state: "down"`.
- **Anti-SSRF:** the client sends only the project `id`; the server resolves the deploy URL **from the
  trusted registry** (`registry/projects.yml`) and pings that. The client can never make the server ping
  an arbitrary URL.
- No new persisted state. No write actions.

## Architecture

### Registry

- `registry/projects.yml`: add an optional **`deploy_url`** per project (the public Railway URL). Marcos
  fills these in. `dashboard/src/server/registry.ts` (`loadRegistryProjects`) and its `RegistryProject`
  type (`lib/state/derive.ts`) gain `deploy_url: string | null` (defaults to null).

### Shared types — `lib/state/types.ts` (no node deps; importable by client)

- `DeployState = "up" | "degraded" | "down"`
- `DeployHealth = { configured: boolean; url: string | null; state: DeployState | null; status: number | null; ms: number | null; error?: string }`

### Server — `dashboard/src/server/deploy-read.ts` (new)

Imports `DeployState`/`DeployHealth` from `lib/state/types.ts`.

Injectable runner for testability:
- `DoFetch = (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>`
  — default wraps global `fetch`.

Functions:
- `readDeployHealth(url, deps?): Promise<{ state: DeployState; status: number | null; ms: number; error?: string }>`
  — measures elapsed ms; tries `HEAD`, and if it throws or returns 405, retries `GET`; maps the result:
  status `< 400` → **up**; `>= 400` → **degraded** (carry the status); a thrown error / timeout / no
  response → **down** (with the error message). Never throws. A monotonic-ish clock is injected
  (`now?: () => number`, default `Date.now`) so tests are deterministic.
- `resolveDeployUrl(repoRoot, id, deps?): string | null` — looks the project up in `loadRegistryProjects`;
  throws `DeployError(404)` for an unknown id; returns the `deploy_url` (or `null` if none configured).
- A small `createDeployCache({ ttlMs?, now? })` (mirrors `createDepsCache`) keyed by URL, async
  (`get(key, () => Promise<...>)`), TTL ~60s, caching the in-flight promise.

### Route — `dashboard/src/server/index.ts`

- `const deployCache = createDeployCache();` next to the other caches.
- `app.get("/api/projects/:id/deploy", async (c) => { try { const url = resolveDeployUrl(repoRoot, id); if (!url) return c.json({ configured: false, url: null, state: null, status: null, ms: null }); const h = await deployCache.get(url, () => readDeployHealth(url)); return c.json({ configured: true, url, ...h }); } catch (err) { if (err instanceof DeployError) return c.json({ error }, 404); return c.json({ error }, 500); } })`.

### Client — `dashboard/src/ui/api.ts`

- `getDeploy(id): Promise<DeployHealth>` — `GET /api/projects/:id/deploy` (same fetch+throw helper).

### UI — `dashboard/src/ui/components/ProjectCard.tsx`

- A `DeployStatus` sub-component (sibling of `GithubCounts`/`DepsStatus`): on **mount** (useEffect)
  calls `getDeploy(p.id)`. While loading → nothing (or a muted "deploy…"); on result, if
  `!configured` → render nothing; else a compact row: a `.pdot pdot--{ok|warn|danger}` (up→ok,
  degraded→warn, down→danger) + label (`up` / `HTTP {status}` / `down`) + `· {ms}ms`, and an
  "abrir sitio" link (`<a href={url} target=_blank>`). A thrown fetch error → a muted "deploy: n/a".
- Reuses the existing `.pdot`/`.link-pop`/`.card-link-btn` vocabulary; add a small `.deploy-row` rule
  only if needed.

## Data flow

`ProjectCard` mounts → `getDeploy(id)` → `GET /api/projects/:id/deploy` → `resolveDeployUrl` (registry)
→ `deployCache.get(url, () => readDeployHealth(url))` → HTTP HEAD/GET ping → `DeployHealth`. The 60s
cache means re-mounts/poll re-renders don't re-ping. No change to the overview/runs flows.

## Error handling

- No `deploy_url` in the registry → `{ configured: false }`; the card shows no deploy control.
- Unknown project id → 404.
- Ping timeout / connection refused / DNS fail → `state: "down"` with the error (card shows a red dot
  "down"). 4xx/5xx → `state: "degraded"` (amber, with the status). Never a 500 from the ping itself.

## Testing

- `dashboard/src/server/deploy-read.test.ts`: `readDeployHealth` (200 → up; 503 → degraded with status;
  thrown/timeout → down; HEAD-405 → GET fallback; ms measured via injected clock; never-throws),
  `resolveDeployUrl` (returns url / null when unset / throws 404 for unknown — injecting a fake
  `loadRegistry`), `createDeployCache` (TTL hit/miss).
- `dashboard/src/server/index.test.ts`: `GET /api/projects/:id/deploy` → `{ configured: false }` when no
  URL (the test registry has none); 404 for an unknown id; never 500.
- `dashboard/src/ui/components/ProjectCard.test.tsx`: with a mocked `getDeploy`, a configured project
  shows the dot + label + "abrir sitio" link; an unconfigured one shows no deploy control.
- Gate: full suite (358 + new) green, `tsc --noEmit` clean, `vite build` clean, Playwright visual smoke
  (configure one real `deploy_url` and confirm the card shows up/down).

## Slice / delivery

- Branch `feat/c1-deploy-health`; TDD; merge `--no-ff` to master + push to origin.
- New dep: none (global `fetch` is available on Node 18+).
- Marcos populates `deploy_url` in `registry/projects.yml` for the deployed projects (I'll add the field
  + a couple of examples/comments; he fills the rest).

## Out of scope (noted follow-ups → C.2/C.3)

- Railway deploy status (last deploy state/date) via the Railway API; redeploy / logs actions; an
  aggregate "N up / M down" KPI or sidebar Resumen row; an always-on background poll of health; a
  configurable expected-status or health path per project; history/uptime tracking.
