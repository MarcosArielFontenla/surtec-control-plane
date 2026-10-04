# Phase L Integral Acceptance

## Scope and safety

This acceptance extends validation only; it does not implement Phase M, change runtime permissions, publish branches or create real provider issues. The local-dashboard-validation skill required repeatable real API/browser flows rather than asking the owner to repeat manual steps; agent-execution-safety and file-state-contracts guided admission, scope, lease and evidence checks.

`pnpm smoke:local:playwright` uses the actual Hono application, Vite UI, TaskOrchestrator, runner, Git worktree/commit and registry verification. `scripts/fixtures/local-issue-api.ts` injects a deterministic executor through the existing interface; it is not a second product runtime. No production smoke-mode execution switch was added.

The fixture creates its own minimal registry, synthetic instructions, Git identities/repositories and state under one unique OS-temp root. Public source is copied there so managed Git's module-relative empty-hooks directory is isolated too. Only installed dependencies are linked; private state/auth/logs are never copied. The executor asserts a contained synthetic worktree and writes fixed synthetic files, never arbitrary request-supplied paths. The real runtime executable is forced to an asserted nonexistent fixture path, so accidental fallback fails closed before a paid call. Source checkout remains on its baseline commit. Human review events in the fixture represent automated UI actions on synthetic data, not approval of a real issue.

## Acceptance mapping

| Criterion | Repeatable evidence |
| --- | --- |
| Expected outcomes and acceptance criteria | Create through browser; exact stored criteria; acceptance disabled until checkbox confirmation |
| Objective -> project -> issue -> execution -> evidence | Real organization project link and issue objective selection; task run/events, commit fingerprint, verification, review and associated session queried through API |
| Local source of truth; external references not authoritative | Local-only stores; provider inbox stub; no connector/model/provider call; external-reference shape and credential rejection in service tests |
| Duplicate writes/ownership and read-only coexistence | Browser dispatch plus rejected duplicate API request; orchestrator concurrency, issue ownership, expired lease and analysis coexistence tests |
| Proportional work | Deterministic trivial classification; real API rejects substantial work without plan; service tests require plan/criteria/next action |
| Discovery is not authorization | Fake executor edits out-of-scope path; actual Git commit guard leaves HEAD unchanged and creates no candidate; scope r1 unchanged; browser approves r2 or rejects/cancels |
| Immutable candidate and stale approval | Fingerprint/changed paths and bound evidence; stale fingerprint rejected; rework/recovery invalidation service tests; candidate/evidence unchanged after restart |
| Existing task/history compatibility | Full offline suite; task runtime unchanged by this validation; attempt/event and session lineage remain queryable after restart |
| Completion requires evidence and approval | API rejects absent criteria/stale candidate; browser explicit criteria and acceptance; exact review/verification evidence and zero API evidence gaps |

The final immediate UI consistency assertion also checks that the expanded lineage reflects newly recorded human acceptance without a manual reload. API correctness alone is not sufficient to pass this UI check.

## Baseline and regression

- Original local browser smoke passed proposal/authorization, organization/migration, responsive controls and restart. It did not exercise task dispatch/candidate acceptance.
- Eight focused suites passed 136 tests: issue service/API/dispatch/UI/task form, runner, orchestrator and worktree. These include fake protocol boundaries, scope, stale lease, verification gap and candidate invalidation; no paid model calls.
- The expanded smoke initially needed synthetic root instructions. Another assertion incorrectly expected 409 for empty criteria; the actual contract rejects empty lists with 400. Both fixture issues were corrected without modifying product code.
- Expanded integrated acceptance passed execution/commit/verification, explicit candidate acceptance, objective/session lineage, scope approval/rejection, negative guards, responsive UI and reload/restart. Temporary cleanup completed.
- Adding the final immediate UI evidence assertion exposed a reproducible product regression: after acceptance the issue is `done`, the API has review evidence and no gaps, but the already-expanded lineage still said human acceptance was missing until reload. That diagnostic smoke exited 1; it was not reported as acceptance success.
- Cause: `IssuesView.perform()` refreshes the issue list but retains cached lineage; `showLineage()` only fetches uncached detail. The newly accepted candidate's evidence is not fetched for the already-open panel. This is stale presentation, not an API authorization/evidence bypass.
- The owner explicitly authorized the scoped correction and revalidation. Successful mutations now invalidate cached lineage and criterion/gap confirmations, refetch open detail, and reopening always fetches fresh detail. Failed refetch cannot retain the old missing-review presentation. Two UI regressions cover successful and failed refetch (eight IssuesView tests passed).

## Repeat and share evidence

Run `pnpm ci:check`, then `pnpm smoke:local:playwright`; both should exit 0. No manual repetition or paid smoke is required. Share command, stage and sanitized assertion on failure; never send normal state, credentials, session tokens or unrelated repositories. After successful final revalidation, the next milestone is Phase M (Harness source/inventory/health/drift), which needs separate phase authorization.

## Final revalidation — 2026-09-29

- `pnpm ci:check`: 92 files / 668 tests passed; 38 product schemas valid; Harness gate passed; secrets passed for 1060 files; role/task coverage 36/36, golden expectations 42/42, outcomes 8/8; typecheck passed; build passed with 1917 modules.
- `pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx`: eight tests passed, including both cache/refetch regressions. Earlier eight-file focused acceptance passed 136 tests before these two additions.
- `pnpm smoke:local:playwright`: passed after the authorized UI correction, including immediate evidence consistency, objective/session lineage, real temporary Git execution, scope decisions, restart and token rotation. It passed again with the nonexistent paid-runtime executable guard. API/browser/temporary repositories were stopped/closed/removed; cleanup completed.
- `pnpm typecheck` passed again after the final test-bootstrap guard. No dependency change required an install; no paid Codex smoke or remote CI run was performed. `git diff --check` passed with the pre-existing OrganizationView line-ending warning.
- Automated Phase L acceptance is complete; no repeatable manual step remains. Real-model behavior and human preference/accessibility judgment are not claimed by the injected executor/headless browser. They do not require spending model quota to accept this local workflow. No commits or external effects were created. Stop here; Phase M is the recommended next authorized milestone.

## Files changed in this validation

`scripts/playwright-local-app-smoke.ts`, `scripts/fixtures/local-issue-api.ts`, `docs/runbooks/local-development.md`, `docs/runbooks/local-work-issues.md`, and this record; after explicit owner approval, `dashboard/src/ui/views/IssuesView.tsx` and `dashboard/src/ui/views/IssuesView.test.tsx`. Documentation-only historical/current clarifications: `docs/architecture/current-architecture.md` and `docs/architecture/issue-lifecycle-v1.md` (no lifecycle semantics changed). Existing product/Harness changes remain user-owned and preserved. No dependency/lockfile, production runtime, commit, push or deployment was changed.
