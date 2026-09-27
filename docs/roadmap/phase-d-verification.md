# Phase D — Deterministic signal engine verification

## Summary

Phase D adds a deterministic, explainable portfolio signal feed and protected human actions. Signals are derived from bounded local Git, aggregate integration, GitHub inbox, task, profile, and note evidence. Ranking is explicit and returned with every signal. Human state is stored separately from computed evidence.

The implementation stops before the Phase E Today cockpit. The engine accepts paused-session evidence for its contract/tests, but the production evidence reader supplies no sessions until Phase G adds the session model.

The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` was preserved and not staged. No sibling project repository was modified. No remote write, push, merge, deployment, or paid Codex call was performed.

## Files modified

- `dashboard/src/server/github-read.ts` and `.test.ts`
- `dashboard/src/server/index.ts`
- `dashboard/src/server/project-integrations.ts` and `.test.ts`
- `dashboard/src/server/signal-api.test.ts`
- `dashboard/src/server/signal-evidence.ts` and `.test.ts`
- `dashboard/src/server/signal-service.ts`
- `docs/operations/signals.md`
- `docs/roadmap/control-plane-evolution.md`
- `docs/roadmap/phase-d-plan.md`
- `docs/roadmap/phase-d-verification.md`
- `docs/security/threat-model.md`
- `lib/integrations/types.ts`
- `lib/integrations/validation.test.ts`
- `lib/signals/engine.ts` and `.test.ts`
- `lib/signals/types.ts`
- `lib/state/paths.ts` and `.test.ts`
- `lib/state/signals.ts` and `.test.ts`
- `lib/state/validation.ts`
- `package.json`
- `schemas/project-integrations.schema.json`
- `schemas/signal-action.schema.json`
- `schemas/signal-feed.schema.json`
- `schemas/signal-human-state.schema.json`
- `schemas/signal.schema.json`
- `scripts/api-smoke.ts`
- `scripts/playwright-signals-smoke.ts`

## Implementation details

- Added `GET /api/signals` and `POST /api/signals/:id/action` behind the existing loopback, same-origin, and in-memory session-token protections.
- Added deterministic rules for unhealthy deployments, failing or long-running CI, blocked/failed/review/approval tasks, dirty/ahead/behind Git, PR review state, recent high-priority issues, deadlines, stale activity/reviews, missing goals/actions, and aging unresolved notes.
- Added visible ranking tiers from production failure through hygiene; IDs are stable across refreshes and distinguish new CI runs, task attempts, issue updates, deadlines, and PR updates where the source provides an occurrence key.
- Added bounded project integration concurrency and isolated warnings. Existing integration/inbox/Git caches are reused; the consumer obtains a single feed rather than per-project requests.
- Added bounded, privacy-limited integration fields for PR review decisions and CI run identity/start/update times. Signal evidence excludes raw provider output, issue title/author/URL, note text, task instructions/results, deployment URLs, and absolute repository paths.
- Stored acknowledge/snooze/pin/dismiss/resolve state separately in ignored `state/signals/human-state.json`, with a strict schema, cross-process lock, unique temporary file, atomic replacement, and fail-closed future-version handling.
- Added a reusable `pnpm smoke:signals:playwright` command. It starts a local HTTP server with synthetic evidence and temporary state, drives same-origin requests from Chromium, checks session protection and action handling, restarts the service, and verifies persistence. It makes no provider or paid model calls.

## Commands and exact results

- Baseline `pnpm ci:check` before implementation: passed; 13 schemas, 69 test files / 493 tests, 36/36 EVAL coverage, 42/42 expectations, typecheck, and production build (1,912 modules).
- Final `pnpm ci:check`: passed. Repository consistency passed; 17 JSON Schemas validated; secret scanner passed (922 repository files); EVAL coverage 36/36 and expectations 42/42 passed; 73 test files / 516 tests passed; `tsc --noEmit` passed; Vite production build transformed 1,912 modules.
- `pnpm smoke:api`: passed. Overview, Today, dispatch options, portfolio profiles, integrations, and signals all returned HTTP 200. It discovered 21 projects, 12 configured projects, zero existing portfolio profiles, and three synthetic signals.
- `pnpm smoke:signals:playwright`: passed. Browser reads, session-token-protected acknowledge/snooze/pin/resolve actions, rejection without the token, and persisted state after service restart were verified. The machine's installed Edge browser was used as Chromium fallback because the Playwright-managed headless executable was unavailable.
- Focused signal/store/API/integration tests: passed (7 files / 45 tests before the final bounded-feed regression test); included within the final 73-file / 516-test suite.
- `git diff --check`: passed.
- `git check-ignore -v --no-index state/signals/human-state.json`: passed; the repository-wide `/state/` rule ignores the human-state file.
- `pnpm install --frozen-lockfile`: not run; no dependency or lockfile changes were made.
- `pnpm audit:check`: not run because dependencies did not change. The Phase C verification records the prior audit request as blocked by registry `EACCES`; this phase does not claim a new advisory result.

## Manual local validation

No new dashboard UI was introduced in this phase, so no manual browser walk-through is required for the implemented flows. The API and interaction path were exercised automatically by Playwright using `pnpm smoke:signals:playwright`; the broader API smoke is `pnpm smoke:api`. The existing dashboard UI will consume the feed as part of Phase E.

## Security impact

- The API reuses existing loopback/origin/session protections; mutations require the local session token.
- Computed evidence is bounded and schema-validated. Human state stores only signal IDs and user actions, not signal payloads or client notes.
- Local state remains plaintext and relies on operating-system account/disk protection. This is still a single-user local application, not a boundary against another process running as the same user.
- The Playwright smoke uses temporary synthetic state and removes only its uniquely named temporary directory.

## Known risks and deferred work

- Paused-session signals remain dormant in production until Phase G provides persisted sessions.
- The Today decision cockpit and visible signal actions remain Phase E scope.
- Integration and inbox observations can be stale within their existing cache TTL; evidence timestamps show source observation time separately from feed generation time.
- A deployment health check without a deployment timestamp has no source transition ID, so a later recurrence may reuse the same signal ID.
- The app does not encrypt local state. The dependency audit was not rerun because this phase changed no dependencies; current advisory status remains unverified here.

## Local commits

The Phase D plan and implementation are committed on `codex/phase-d-deterministic-signals`. No push, merge, or deployment was performed.

## Recommended next phase

Phase E — Today as a decision cockpit. Stop here for local phase validation before starting it.
