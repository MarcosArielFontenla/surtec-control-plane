# Phase G — Work Sessions verification

## Summary

Phase G adds local, resumable human work sessions. A session can be started, annotated, linked to same-project tasks/processes, paused, resumed, and completed from Today or project detail. The deterministic resume card uses stored session context and bounded task/process evidence; it does not ask an LLM to reconstruct work. Pausing or completing a session does not stop processes or change task state.

The implementation is ready for Marcos's local validation. Phase H has not started.

## Baseline

- Branch before Phase G: `codex/phase-f-project-operating-detail`.
- Baseline HEAD: `2e3f9eb0521764307b849d093fa39bea47464bcb`.
- The only pre-existing working-tree items were the user-owned prompts `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` and `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md`. Both remain untracked and are excluded from all commits.
- Baseline `pnpm ci:check` passed: 17 schemas, secret scan across 934 repository files, EVAL coverage 36/36 and expectations 42/42, 74 test files / 506 tests, typecheck, and production build (1,913 modules).
- Baseline `pnpm smoke:api` passed.
- `pnpm audit:check` could not reach the npm audit endpoint (`EACCES`). No dependencies or lockfiles changed in Phase G.

## Files modified

- Persistence and contracts: `lib/state/work-sessions.ts`, `lib/state/work-sessions.test.ts`, `lib/state/types.ts`, `lib/state/paths.ts`, `lib/state/validation.ts`, `lib/state/observability.ts`, `lib/state/observability.test.ts`, `schemas/work-session.schema.json`, `schemas/work-sessions.schema.json`, `schemas/work-session-start.schema.json`, `schemas/work-session-action.schema.json`, `scripts/check-schemas.mjs`.
- API and service: `dashboard/src/server/work-session-service.ts`, `dashboard/src/server/work-session-service.test.ts`, `dashboard/src/server/work-session-api.test.ts`, `dashboard/src/server/index.ts`, `dashboard/src/server/index.test.ts`.
- UI and browser automation: `dashboard/src/ui/components/WorkSessionsPanel.tsx`, `dashboard/src/ui/views/TodayView.tsx`, `dashboard/src/ui/views/TodayView.test.tsx`, `dashboard/src/ui/views/ProjectDetailView.tsx`, `dashboard/src/ui/views/ProjectDetailView.test.tsx`, `dashboard/src/ui/App.tsx`, `dashboard/src/ui/App.test.tsx`, `dashboard/src/ui/api.ts`, `dashboard/src/ui/styles/dashboard.css`, `scripts/playwright-work-sessions-smoke.ts`, `scripts/playwright-today-smoke.ts`, `scripts/playwright-project-detail-smoke.ts`, `package.json`.
- Documentation: `docs/operations/work-sessions.md`, `docs/operations/today-cockpit.md`, `docs/operations/project-operating-detail.md`, `docs/operations/signals.md`, `docs/architecture/current-architecture.md`, `docs/roadmap/control-plane-evolution.md`, `docs/roadmap/phase-g-plan.md`, and this verification record.

## Commands and exact results

- `pnpm schemas:check`: passed; 21 schemas validated.
- `pnpm secrets:check`: passed after adding this verification record; the secret scanner self-test passed and the scan covered 948 repository files.
- `pnpm evals:check`: passed; coverage 36/36 and expectations 42/42.
- `pnpm test -- lib/state/work-sessions.test.ts dashboard/src/server/work-session-service.test.ts dashboard/src/server/work-session-api.test.ts dashboard/src/ui/views/TodayView.test.tsx dashboard/src/ui/views/ProjectDetailView.test.tsx`: passed; 5 files / 23 tests.
- `pnpm test -- --maxWorkers=2`: passed; 77 test files / 521 tests.
- `pnpm typecheck`: passed (`tsc --noEmit`).
- `pnpm build`: passed; Vite transformed 1,914 modules.
- `pnpm smoke:api`: passed; overview, Today, dispatch options, profiles, integrations, and signals returned HTTP 200; 21 projects discovered, 12 configured, integration schema v2, and three synthetic signals.
- `pnpm smoke:today:playwright`: passed; healthy, degraded, overloaded, and empty fixtures plus protected actions.
- `pnpm smoke:project-detail:playwright`: passed; configured, unconfigured, and degraded project states, integration refresh, task prefill, and session panel availability.
- `pnpm smoke:work-sessions:playwright`: passed; Today start, notes, task/process links, pause, reload, project-detail resume, explicit completion, protected writes, and process safety.
- `git diff --check`: passed; Git emitted only configured LF-to-CRLF normalization warnings on four UI files.
- `pnpm ci:check`: the default parallel Vitest invocation was not clean in this environment: it intermittently timed out two pre-existing 5-second dependency-check tests in `dashboard/src/server/project-integrations.test.ts` while the complete suite ran with default worker fan-out. That integration suite passed in isolation (7 tests / 0.993 seconds); the specific test that timed out in the aggregate run passed in isolation (0.608 seconds); and all 521 tests passed with `--maxWorkers=2`. Schema, secret, EVAL, typecheck, and build checks passed independently. This is recorded as runner contention/timeout behavior, not a confirmed product regression.
- `pnpm audit:check`: blocked by registry network permissions (`EACCES`).
- `pnpm install --frozen-lockfile`: pnpm stopped with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` because it wanted to replace the existing `node_modules` directory in a non-interactive shell. It was not forced; no dependency or lockfile changes were made.
- No real Codex runtime smoke was run: Phase G does not change task execution and paid runtime calls were not opted into.

## Manual local validation

Run `pnpm dev` and open `http://localhost:5173/`.

1. In Today, start a session for a discovered project with an objective. Confirm the current branch is captured when available.
2. Add a note and associate an existing task and process from the same project. Confirm unrelated or unknown IDs are rejected.
3. Pause the session with an explicit next action. Confirm the session is shown as paused and its task/process remain unchanged.
4. Reload the app or restart the API. Confirm the paused session and resume evidence remain visible.
5. Open that project's detail page and resume the session. Confirm a second active session cannot be started or resumed while it is active.
6. Complete the session with a result and a next action (or the literal `none`). Confirm it moves to recent completed sessions.
7. Optionally leave a session active briefly and pause it to observe focused time; time accrues only across active intervals and is not based on device activity.

The Playwright smoke covers the primary browser flow with fictional fixtures. Service and API tests cover restart persistence and locking in temporary local state.

## Security impact

- The versioned session document is local plaintext under `state/sessions/` and inherits host filesystem protections. Objectives and notes warn against storing credentials or secrets.
- Runtime validation, a 10 MiB document bound, shared state locking, and atomic replacement prevent malformed/oversized writes and concurrent lost updates. Corrupt or future-version state is not silently overwritten.
- The API reuses loopback, same-origin, and in-memory session-token protections. Writes are bounded and association IDs are validated against the same project.
- Resume evidence is deterministic and allowlisted. It omits task instructions, agent-result text, event payloads, raw process commands, absolute repository paths, and credentials. A PR link is rendered only from an already validated GitHub URL.
- Session pause/completion mutates only session state; it does not stop processes or cancel/modify tasks. No telemetry or LLM summarization is introduced.

## Known risks and deferred work

- A session left active continues accruing focused time until explicitly paused; no idle detection is used by design.
- Process status is in-memory today. After an API restart, the linked process ID remains visible but its status is unavailable.
- Completed sessions are retained; cleanup and retention controls are deferred.
- The default parallel Vitest worker count can exceed the environment's reliable capacity for a pre-existing 5-second integration test. The bounded-worker full suite is green; the standard aggregate run should be made deterministic separately if this recurs.
- Registry audit and frozen install could not be verified due environment permissions/non-interactive pnpm behavior; no dependencies changed.

## Local commits

- `500c2eb` — `feat: add resumable work sessions`.
- The verification record is committed separately after the implementation.
- No push, merge, deploy, external repository modification, or prompt staging is part of this phase.

## Recommended next phase

Phase G was ready for local validation. The user later accepted that stop by authorizing Phase H — Client commitments, which is tracked separately in [the current roadmap](control-plane-evolution.md). The unrelated collaborative-workspace item remains the legacy Phase 6 and is not part of Phase H.
