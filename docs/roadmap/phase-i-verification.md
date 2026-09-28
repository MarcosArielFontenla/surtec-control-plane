# Phase I — Outcome-oriented EVALs and operating feedback verification

## Summary

Phase I keeps the mandatory offline policy/security evaluation gate, promotes missing required evidence to a hard failure, and adds eight synthetic versioned golden cases. It also adds a fixed, explicitly opted-in read-only live-canary suite and aggregate-only local operational metrics for recommendation actions, task outcomes, verification, work sessions, and signal freshness.

The Feedback page reads metrics only when opened or manually refreshed. Signal state records the first observed action only for interactions whose first action is recorded after Phase I; old records remain valid and are not backfilled. No real Codex call, external project write, push, merge, deployment, or client data was used.

## Consolidated product review — Phases A–I

- A–C establish operational acceptance checks, policy-aware dispatch and credential boundaries, and versioned local project profiles with a privacy boundary.
- D–E add explainable deterministic portfolio signals and the Today decision cockpit while retaining the original task activity.
- F adds on-demand project operating detail over bounded integration snapshots.
- G adds persisted resumable work sessions; H connects local delivery commitments without silently sharing client context.
- I measures observable task usefulness offline and presents aggregate local feedback without introducing default telemetry.

The product now connects recommendations to evidence and next actions, projects to operational detail, and human work to explicit session context. The new automated review found no regression in the combined offline gates or existing browser workflows. One product-level pass in Marcos's normal Windows session remains appropriate because the browser smokes use synthetic fixtures and cannot validate the user's actual local state, account permissions, or visual preferences.

## Files modified

- EVALs and canaries: `lib/evals/evaluator.ts` and tests; new `lib/evals/outcome-*` and `lib/evals/canary.ts` modules/tests; `evals/v1/cases/quality-missing-evidence.json`; new synthetic `evals/v2/`; new `fixtures/evals-canary/`; `schemas/outcome-*.schema.json`; `scripts/run-outcome-evals.ts`; `scripts/run-live-canaries.ts`; `evals/README.md`; and EVAL scripts in `package.json`.
- Feedback domain and persistence: new `lib/feedback-metrics.ts` and tests; `lib/signals/types.ts`; `lib/state/signals.ts` and tests; `schemas/signal-human-state.schema.json`; new `schemas/feedback-metrics.schema.json`; and `dashboard/src/server/signal-service.ts`.
- API and dashboard: `dashboard/src/server/index.ts` and new API tests; `dashboard/src/ui/api.ts`, `App.tsx`, `components/Sidebar.tsx` and tests, new `views/FeedbackMetricsView.tsx` and tests, and `styles/dashboard.css`.
- Browser/API smokes: new `scripts/playwright-feedback-metrics-smoke.ts`, `scripts/api-smoke.ts`, and the smoke script in `package.json`.
- Documentation: this verification, `docs/roadmap/phase-i-plan.md`, `docs/roadmap/control-plane-evolution.md`, `docs/operations/feedback-metrics.md`, `docs/operations/signals.md`, `docs/runbooks/local-development.md`, and `docs/security/threat-model.md`.

The user-owned files `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` and `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md` remain untracked and are excluded from all commits.

## Commands and exact results

- Baseline `pnpm ci:check` before edits: passed with 26 schemas, 79 test files / 536 tests, EVAL coverage 36/36 and expectations 42/42, typecheck, and production build.
- `pnpm evals:check`: passed; v1 coverage 36/36 and expectations 42/42, including hard-fail expectations for secret exposure, read-only mutation, prohibited commands, missing approval, denied task type, and missing evidence; v2 golden expectations 8/8.
- `pnpm schemas:check`: passed; 29 JSON Schemas validated.
- Focused test command for EVAL, metrics, signal state, API, and UI: passed; 8 files / 30 tests.
- `pnpm smoke:feedback:playwright`: passed; on-demand aggregate read, rendered metrics, manual refresh, and no mutations.
- `pnpm smoke:signals:playwright`: passed; same-origin reads, protected actions, and restart persistence.
- `pnpm smoke:today:playwright`: passed; healthy, degraded, overloaded, and empty fixtures plus protected actions.
- `pnpm smoke:project-detail:playwright`: passed; configured/unconfigured/degraded states, refresh, project data, and safe task prefill. One concurrent attempt hit the repository's fixed Vite port; the sequential rerun passed.
- `pnpm smoke:work-sessions:playwright`: passed; start, notes, associations, pause/reload/resume/completion, protected writes, and process safety.
- `pnpm smoke:client-commitments:playwright`: passed; synthetic client/commitment flow, masked names, explicit-only context, and protected writes.
- Final `pnpm smoke:api`: passed; API routes including `/api/feedback/metrics` returned HTTP 200, feedback schema version 1, 21 projects discovered, and 12 configured. No client records were printed.
- Final `pnpm ci:check`: passed; repository consistency, 29 schemas, secret scan self-test and scan of 994 repository files, EVAL v1 coverage 36/36 and expectations 42/42, v2 expectations 8/8, 84 test files / 553 tests, `tsc --noEmit`, and Vite build (1,916 modules).
- `pnpm evals:canary`: skipped as designed because explicit opt-in was absent. No real Codex model calls were made.
- `git diff --check`: passed. No dependencies or lockfile entries changed; `pnpm install --frozen-lockfile` and `pnpm audit:check` were not needed for this phase.

## Manual local validation

From PowerShell in the repository:

```powershell
pnpm dev
```

Open `http://localhost:5173/` and review this consolidated A–I path:

1. Confirm Overview, Hoy, project detail, and the existing task activity render against your normal local account and sibling repositories. Preparing a task is safe; do not dispatch it unless you intentionally want to invoke Codex and spend the associated quota.
2. In Hoy, inspect a recommendation's evidence, ranking, and next step. If you use a clearly synthetic local signal, exercise acknowledge, snooze, pin, dismiss, and resolve; confirm the first action is retained and later actions do not double-count it.
3. Open a project detail and inspect provider freshness and failure labels. Start a synthetic work session, add a note, pause, reload, resume, and complete it with an explicit next action.
4. In Clientes, use only fictional data if you want to validate the commitment flow. Confirm names stay masked in compact views and task context remains unchecked unless explicitly selected.
5. Open Feedback. Confirm action/task/session/signal aggregates render, manual refresh works, and no individual names, prompts, or paths appear. New action-latency samples accumulate only after a first action and its evidence timestamp are available.
6. Optionally run `pnpm evals:check` locally; this is offline. Do not set `SURTEC_LIVE_CANARIES` or pass `--confirm-live-canaries` unless you separately choose to spend model quota.

Stop `pnpm dev` with Ctrl+C. Do not commit fictional or real client data from local state.

## Security impact

- Missing required EVAL evidence now produces `evidence.required-missing`, a non-compensable hard failure. The original security and policy hard failures remain active.
- Golden fixtures are schema-validated, path-contained, synthetic, and never executed. They cover the requested eight representative task types.
- Live canaries require both an environment opt-in and a confirmation flag, are denied in CI, are fixed to two suite-pinned cases, use only the repository-owned synthetic fixture with the existing read-only/no-network App Server sandbox, and verify a before/after hash snapshot. Their output omits raw model responses and runtime errors.
- Runtime limits are two minutes per turn and five minutes total. Token usage notifications trigger an abort above 3,000 tokens per request and completed usage is checked again; App Server does not expose a per-turn hard token-cap input through the current stable adapter, so a usage notification may arrive after tokens have accrued. Monetary cost is not estimated because billing data is not read.
- Feedback metrics aggregate local state on demand and return no project/task/session/signal identifiers or source text. The API is no-store/read-only. State remains local plaintext and relies on host account/disk protections; no analytics or external telemetry was added.

## Known risks and deferred work

- Historical signal actions do not contain first-action/evidence timestamps and are intentionally excluded instead of inferred. The latency measures evidence-to-action, not first display.
- Freshness windows are deterministic starting assumptions (CI 1d; Git/notes 14d; profiles/commitments 30d; other listed sources 7d) and may need adjustment after real use.
- The live canary was not run. It remains an explicit manual operation and is not required by CI.
- Phase A's external GitHub metadata review remains a separate manual checklist; this phase made no GitHub setting changes.
- Existing local state, integrations, and visual behavior still need Marcos's product-level acceptance in the normal local account.

## Local commits

The implementation and documentation/verification are delivered in separate local commits; their exact identifiers are included with Phase I delivery. No push, merge, or deploy is part of Phase I.

## Recommended next step

Stop for Marcos's local review of Phases A–I and wait for his next direction. The portfolio prompt defines no Phase J. The separate collaborative-workspace Phase 6 remains optional and requires explicit authorization.
