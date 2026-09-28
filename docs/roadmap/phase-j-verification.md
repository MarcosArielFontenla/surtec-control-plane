# Phase J — Continuation acceptance and organization boundary verification

Date: 2026-09-28

## Summary

Phase J closes the A–I acceptance audit and records a successful real disposable-write Codex smoke supplied by Marcos. It defines the single-company organization vocabulary and modular-monolith direction, inventories current persisted contracts and migration requirements, and adds an isolated v1 issue-transition catalog with pure envelope checks and focused tests.

No organization state, migration, API, UI, existing task workflow, external repository, GitHub setting, runtime, or provider was changed. The reference transition catalog is not wired to application flows and is not yet a production authorization boundary. Phase K was not started.

## Files modified

- [Phase J plan](phase-j-plan.md) and [Phase J.1 baseline audit](phase-j-baseline-audit.md), including the traceability matrix, updated write-smoke gate, and remaining A–I review gaps.
- [ADR-0003](../decisions/ADR-0003-organization-domain-boundary.md), the organization vocabulary, authority rules, non-goals, and intended dependency direction.
- [Current architecture](../architecture/current-architecture.md), with an explicit link and warning that the organization design is not implemented in current app flows.
- [Organization state migration contract](../architecture/organization-state-migration.md), with current persisted contract inventory and future versioning, backup, atomicity, rollback, defaults, quarantine, and fixture requirements.
- [Issue lifecycle v1](../architecture/issue-lifecycle-v1.md), with work scale, status vocabulary, all allowed edges, actor/evidence/policy/approval requirements, and scope/candidate boundaries.
- `lib/organization/issue-lifecycle.ts` and its tests, implementing only an immutable reference catalog and a pure check for invalid ids, stale revisions, duplicate events, out-of-order sources, unknown statuses, and forbidden edges.

The user-owned prompts `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md` and `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` remain untracked and are not included in either Phase J commit.

## Commands and exact results

- `pnpm test -- lib/organization/issue-lifecycle.test.ts` — passed: 1 test file, 14 tests. The first iteration exposed two incorrect test expectations about the initial state; the assertions were corrected to compare against each test case's actual pre-state, and the rerun passed.
- `pnpm ci:check` — passed: repository consistency; 29 JSON Schemas; secret-scanner self-test and 1,001-file scan; EVAL v1 coverage 36/36 and expectations 42/42; outcome suite expectations 8/8; 85 test files / 567 tests; TypeScript typecheck; Vite build with 1,916 modules (4.70 seconds).
- `pnpm smoke:api` — passed. Overview, Today, dispatch options, profiles, clients, commitments, client-context options, integrations, signals, and feedback metrics returned HTTP 200. The response reported 21 discovered projects and 12 configured projects; 0 profiles, 0 clients, 0 commitments; integration schema v2; 3 signals; feedback schema v1.
- `git diff --check` / staged diff checks — passed for the Phase J changes. Git also printed the existing warning that the global ignore file under the user profile is inaccessible; this did not affect repository checks or commits.
- `pnpm install --frozen-lockfile` and `pnpm audit:check` — not rerun: Phase J changed no dependencies or lockfile. The baseline audit records their prior results.
- Browser/Playwright smokes — not rerun for J because no UI, API, or existing product behavior changed. The Phase J.1 baseline records the sequential A–I Playwright passes; those are fixture-based, not a normal-account visual review.
- Real Codex write smoke — no second call was made by this phase. Marcos supplied the successful normal-Windows run: model ID `gpt-6-luna`, completed turn, only `smoke-fixture.txt` changed in a smoke-owned temporary repository, commit and diff captured, `node verify-smoke.mjs` passed with `disposable fixture state verified`, cleanup complete, and reported usage 17,719 tokens. No project path or push was involved. This resolves the prior J.1 gate; the blocked earlier attempts remain in the audit as historical results.
- Live EVAL canary — not run; it remains an explicit opt-in operation and was not needed for this documentation/reference-contract phase.

## Manual local validation

From PowerShell at the repository root:

```powershell
pnpm test -- lib/organization/issue-lifecycle.test.ts
pnpm ci:check
```

Review these artifacts together:

1. `docs/decisions/ADR-0003-organization-domain-boundary.md` for vocabulary, non-goals, dependency direction, and authority boundaries.
2. `docs/architecture/organization-state-migration.md` against the state files you expect future organization work to extend. It intentionally prescribes no migration command or data changes now.
3. `docs/architecture/issue-lifecycle-v1.md` and `lib/organization/issue-lifecycle.ts` for the 24 allowed transitions and their actor/evidence/policy/approval rules. Confirm the lightweight path and the explicit `needs-decision`/review semantics match how you want to operate SURTEC.
4. Run `git status --short --branch` and confirm the two roadmap prompts are still untracked and absent from the commits.

No `pnpm dev`, real Codex dispatch, client data entry, or UI walkthrough is necessary to validate J because no product flow or persisted state changed.

## Security impact

- The only code addition is a pure catalog/guard with no filesystem, network, runtime, application, or publication side effect. Tests prove it rejects stale, duplicate, out-of-order, unknown, and forbidden transition envelopes without mutation.
- The catalog is not wired into routes or state and must not be treated as an authorization boundary until a later phase implements actor authentication, evidence and policy validation, approval binding, durable event/state atomicity, and migration behavior.
- Migration guidance requires private local backups, exact fingerprints, staged target validation, explicit recovery, and fail-closed handling. No local state was backed up, changed, copied, or committed in this phase.
- The user-provided real smoke changed only a disposable temporary fixture; it reported successful verification and cleanup.

## Known risks and deferred work

- Current persisted contracts mix explicit `schema_version` stores with legacy unversioned task records, task-event lines, project overrides, and notes. `lib/state/notes.ts` currently maps read/parse errors to an empty list; future migrations must add preservation/quarantine before treating that store as safe to extend.
- Snapshot and JSONL event writes are not one transaction. Future issue state must define an explicit event/revision recovery contract rather than assume atomicity across files.
- Issue lifecycle v1 is a reference contract only. It does not yet store issue scope revisions, candidate fingerprints, approvals, decisions, or evidence.
- The consolidated normal-account visual/local-state review recorded in Phase I remains outstanding; automated browser fixtures cannot prove real-account preferences or local data behavior. The optional live canary also remains unrun.
- The prior read-only GitHub review's description and branch-protection observations were not changed. Marcos has said public visibility is intentional until further notice; no GitHub settings are in scope here.
- No external runtime, Paperclip dependency, multi-tenant behavior, or generic plugin framework was introduced.

## Local commits

- `c6dd957` — `docs: update Phase J acceptance audit`.
- `51b6cb5` — `feat: define organization lifecycle contracts`.

The verification record is delivered in a separate final documentation commit.

## Recommended next step

Stop for Marcos's local validation of Phase J. Continue to Phase K only after explicit instruction; do not begin it as part of this delivery.
