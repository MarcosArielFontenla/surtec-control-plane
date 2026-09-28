# Phase E — Today decision cockpit verification

## Summary

Today now composes the existing orchestration activity with the deterministic Phase D signal feed. It leads with at most three ranked recommendations, then groups critical attention, unfinished work, client deadlines, personal opportunities, and stale/incomplete project profiles. Existing task counters, task decisions, outcomes, retries, cancellations, and recovery events remain visible.

Signal cards explain severity/impact, project category, reason, next action, ranking tier/order, evidence timestamp, and aggregation observation time. They support acknowledge, snooze for one hour, pin for today, dismiss, and resolve. Users can open the local project or prefill the existing Codex task form; preparing a task never dispatches it. Client profile names/ids and private notes are not included.

If the complete signal service fails, `/api/today` still returns task activity with a generic warning. Provider warnings mark intelligence partial and do not mark the app disconnected. The work-session contract is explicitly unavailable with empty active/paused lists until Phase G supplies persisted sessions; no sessions are fabricated.

## Baseline

- Branch before Phase E: `codex/phase-d-deterministic-signals`.
- Baseline HEAD: `30f77c53262a156b36a4eee83882ff269c9f4744`.
- Baseline `pnpm ci:check`: passed; 17 schemas, 36/36 EVAL coverage and 42/42 expectations, 73 test files / 516 tests, typecheck, and production build (1,912 modules).
- The user-owned untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` was preserved and never staged.

## Files changed

- `dashboard/src/server/index.ts`, `index.test.ts`, `signal-api.test.ts`
- `dashboard/src/ui/App.tsx`, `App.test.tsx`, `api.ts`
- `dashboard/src/ui/components/NewTaskForm.tsx`, `NewTaskForm.test.tsx`
- `dashboard/src/ui/views/TodayView.tsx`, `TodayView.test.tsx`
- `dashboard/src/ui/styles/dashboard.css`
- `lib/signals/engine.ts`, `engine.test.ts`, `types.ts`
- `lib/state/observability.ts`, `observability.test.ts`, `signals.test.ts`, `types.ts`
- `schemas/signal.schema.json`
- `scripts/api-smoke.ts`, `scripts/playwright-today-smoke.ts`
- `package.json`
- `docs/operations/signals.md`, `docs/operations/today-cockpit.md`
- `docs/roadmap/phase-e-plan.md`, `docs/roadmap/control-plane-evolution.md`, `docs/roadmap/phase-e-verification.md`

## Architecture and security decisions

- The server remains the source of deterministic order; React renders the returned ranking and does not duplicate priority rules.
- `/api/today` composes the already-aggregated signal feed once, returns `Cache-Control: no-store`, and fails open only for optional portfolio intelligence while preserving task activity.
- A signal exposes only `project_kind` (`personal`, `client`, or `null`) alongside the necessary project id; it never copies `client_id` or the client name.
- Mutations continue through the existing loopback, same-origin, and in-memory session-token protections. The browser smoke checks that the session token accompanies actions; API authorization and persistence are also covered by the real Hono/API and Phase D Playwright tests.
- The Playwright cockpit smoke serves the real Vite React app in a headless browser and supplies route-intercepted fictional API fixtures. It never reads or changes local portfolio files, starts a real task, calls a provider, or makes a paid Codex request.
- No dependency, lockfile, or sibling-project source changes were made.

## Commands and exact results

- Baseline `pnpm ci:check`: passed before edits (details above).
- `pnpm install --frozen-lockfile`: the non-interactive shell initially rejected pnpm's node_modules purge because it had no TTY. `$env:CI = 'true'; pnpm install --frozen-lockfile` then completed successfully with the lockfile unchanged and all 215 packages linked.
- Final `pnpm ci:check`: passed. Repository consistency passed; 17 JSON Schemas validated; secret scan passed (926 repository files); EVAL coverage 36/36 and expectations 42/42; 73 test files / 524 tests passed; `tsc --noEmit` passed; Vite production build transformed 1,912 modules.
- `pnpm audit:check`: passed, no known vulnerabilities found.
- `pnpm smoke:api`: passed. Overview, Today, dispatch options, profiles, integrations, and signals returned HTTP 200; 21 projects discovered, 12 configured, 0 local profiles, and 3 synthetic signals.
- `pnpm smoke:signals:playwright`: passed; protected actions and human-state persistence across server restart verified.
- `pnpm smoke:today:playwright`: passed; real Vite browser smoke covered healthy, degraded, overloaded, and empty portfolios, session-token-backed acknowledge/pin actions, post-action refresh, and project/instructions prefill without dispatch.
- Focused Phase E suite: passed, 7 test files / 89 tests. Included model ranking/grouping, client-identifier privacy, source failure isolation, visible task prefill, signal actions, and all task activity sections.
- `git diff --check`: passed. Git emitted only the repository's configured LF-to-CRLF normalization warnings for the new Today view files.
- Codex runtime smoke: not run; Phase E does not change the runtime, and no paid/networked runtime action was authorized.
- Nothing was pushed, merged, or deployed; no external project repository was modified.

## Manual local validation

In PowerShell:

```powershell
pnpm dev
```

Open `http://localhost:5173/` and check:

1. `Ahora` shows no more than three recommendations and each gives a project/category, impact, reason, suggested action, ranking, and evidence time.
2. Acknowledge, pin, snooze, resolve, or dismiss one signal; confirm the updated state after refresh. These actions change only local signal-human state.
3. Use `Preparar tarea`; verify it opens Overview with the project and suggested evidence-based instructions filled in. Do not press `Despachar` unless you intend to create a task.
4. Confirm active tasks, pending decisions, completed/failed/cancelled outcomes, retries, cancellations, and recoveries are still available.
5. If an integration source warns, confirm Today remains usable and the app still reports online. The browser smoke supplies this degraded case with fictional data.
6. Note the explicit work-session deferral. Active Codex tasks are not mislabeled as work sessions.

## Known risks and deferred work

- Persisted active/paused work sessions and resume actions remain Phase G scope.
- The feed observation timestamp describes aggregation time; each card separately exposes its evidence timestamp. Existing provider caches retain their bounded TTL behavior.
- Recommendation actions are local only. PR/issue/deployment URLs and remote mutations remain out of scope; the control plane does not dispatch without the user's explicit submit.
- The local state is plaintext and continues to rely on host account/disk protections.
- No manual validation against real portfolio metadata was performed; automated UI fixtures are fictional.

## Local commits

Implementation and verification/documentation are grouped into separate local commits on the Phase E branch. No commit is pushed.

## Recommended next phase

Stop for local validation. Phase F is the next roadmap phase only after the user accepts this cockpit.
