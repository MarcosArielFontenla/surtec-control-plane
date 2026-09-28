# Phase F — Project operating detail verification

## Summary

The portfolio now opens an on-demand operational detail page per project. It combines local profile context, Git state, bounded GitHub PR/issue evidence, CI, HTTP/Railway deployments, dependency health, notes, active/recent Codex tasks, signal states, and recent activity. Each provider block identifies its provider, configured/health state, observation time, bounded failure reason, and safe link when available.

The UI uses `GET /api/projects/:id/integrations` as its only provider read. The validated snapshot is now schema version 2 and includes npm dependency health. `ProjectCard` no longer reads `/github`, `/deps`, `/deploy`, or `/railway`, and notes/profile reads moved to the selected detail page. Legacy routes remain available. Concurrent detail requests are deduplicated in the browser. An explicit refresh invalidates both aggregate and shared dependency caches and uses `Cache-Control: no-store`.

The potentially slow `npm outdated` check runs only for an explicit project-detail integration read, not for Today or portfolio signal aggregation. Work sessions remain explicitly unavailable until Phase G. Preparing a task fills the existing form and never dispatches it.

## Baseline

- Branch before Phase F: `codex/phase-e-today-cockpit`.
- Baseline HEAD: `a901149c7ad18d3a03e1bf8b8bf2c2e38d41852b`.
- Baseline tree contained only the user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md`; it remains untracked and excluded from commits.
- Baseline `pnpm ci:check`: passed; 17 schemas, EVAL coverage 36/36 and expectations 42/42, 73 test files / 524 tests, typecheck, and build (1,912 modules).

## Files modified

- Server and integration contract: `dashboard/src/server/deps-read.ts`, `deps-read.test.ts`, `index.ts`, `index.test.ts`, `project-integrations.ts`, `project-integrations.test.ts`, `signal-evidence.test.ts`, `lib/integrations/types.ts`, `lib/integrations/validation.test.ts`, `lib/signals/engine.test.ts`, `schemas/project-integrations.schema.json`.
- UI: `dashboard/src/ui/App.tsx`, `App.test.tsx`, `api.ts`, `components/ProjectCard.tsx`, `components/ProjectCard.test.tsx`, `components/ProjectNotes.tsx`, `styles/dashboard.css`, `views/ProjectDetailView.tsx`, `views/ProjectDetailView.test.tsx`.
- Automation and smoke: `package.json`, `scripts/api-smoke.ts`, `scripts/playwright-project-detail-smoke.ts`.
- Documentation: `docs/operations/project-operating-detail.md`, `docs/roadmap/control-plane-evolution.md`, `docs/roadmap/phase-f-plan.md`, `docs/roadmap/phase-f-verification.md`.

## Commands and exact results

- `pnpm ci:check`: passed. Repository consistency passed; 17 JSON Schemas validated; secret scanner passed across 933 repository files; EVAL coverage 36/36 and expectations 42/42; 74 test files / 506 tests passed; `tsc --noEmit` passed; Vite production build transformed 1,913 modules and completed successfully.
- `pnpm smoke:api`: passed. Overview, Today, dispatch options, profiles, integrations, and signals returned HTTP 200; 21 projects discovered, 12 configured, zero local profiles, integration schema version 2, and 3 synthetic signals.
- `pnpm smoke:signals:playwright`: passed; same-origin reads, session-protected mutations, and persistence across service restart verified.
- `pnpm smoke:today:playwright`: passed; healthy, degraded, overloaded, and empty portfolio fixtures plus protected signal actions and task prefill verified.
- `pnpm smoke:project-detail:playwright`: passed; configured, unconfigured, and degraded projects; provider failure isolation; freshness refresh; project task/signal/activity/notes sections; one aggregate read; no legacy provider reads; and safe task prefill without dispatch verified in Chromium.
- One initial concurrent browser-smoke invocation conflicted with the repository's fixed Vite port `5173`; the detail smoke passed when rerun sequentially.
- `git diff --check`: passed. Git reported only its configured LF-to-CRLF normalization warnings for the rewritten ProjectCard files.
- No dependency installation was needed; no dependencies or lockfile changed. No Codex runtime smoke was run; this phase does not change task execution.
- No push, merge, deploy, external project modification, real provider call, paid model call, or prompt staging occurred.

## Manual local validation

Run `pnpm dev`, open `http://localhost:5173/`, select `Overview`, and choose `Detalle` on a configured, unconfigured, or degraded project. Confirm:

1. Provider blocks show identity, configured/health state, freshness, and concise errors independently. Use `Actualizar` and confirm the observed time changes.
2. GitHub PR/issue evidence and deployments open only their safe external destinations. A provider failure leaves profile, tasks, notes, signals, and activity visible.
3. Active/recent tasks open their task detail. Open, snoozed, and resolved signals are grouped separately. Notes and profile edits remain local.
4. `Preparar tarea` opens Overview with project and next action prefilled; it does not dispatch until the existing form's submit action is deliberately used.
5. The session section states that persisted work sessions are deferred to Phase G.

The Playwright browser smoke uses fictional fixtures and already automates these main states; no real GitHub/Railway account or portfolio project was queried.

## Security impact

- The schema is allowlisted and versioned; dependency errors use the existing redaction helper. Provider response payloads and absolute checkout paths are not shown.
- GitHub links are built from recognized repository identities and bounded numeric PR/run identifiers. Deployment links continue through server-side HTTP(S) validation.
- Profile and note writes retain their existing loopback/same-origin/session-token protections. Refresh invalidates only in-memory caches. Opening code/folders and preparing tasks require explicit user clicks; task preparation does not dispatch.
- The local profile editor retains its existing explicit editing path for an opaque client reference; read-only evidence/activity blocks do not render it.

## Known risks and deferred work

- `npm outdated --json` is still a synchronous legacy reader with a 60-second timeout. It runs only on project-detail reads or an explicit refresh, but a slow first check can temporarily block the local API event loop. Moving this subprocess behind an async, bounded process adapter is a follow-up.
- Dependency health currently uses the existing npm-specific reader; other package managers are not inferred.
- Snapshot schema v2 is a contract change for any out-of-repository consumers. The in-repository UI migrates in this phase and old endpoint routes remain, but no external consumer inventory exists.
- Persisted resumable work sessions remain Phase G scope. Activity is sourced from the existing bounded portfolio feed, so older project activity may fall outside its recent window.
- Local profile/note state remains plaintext under host filesystem protections.

## Local commits

- `f3a9c56` — `feat: add project operating detail`.
- Verification and documentation are recorded in the following local commit on `codex/phase-f-project-operating-detail`.
- Neither commit includes either user-owned, untracked prompt. Nothing is pushed.

## Recommended next phase

Stop for local validation. After acceptance, continue with Phase G — Work Sessions and resumable human context.
