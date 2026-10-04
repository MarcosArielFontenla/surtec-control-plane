---
spec: .agents/specs/project-harness-profile.spec.yaml
feature: phase-m-harness-intelligence
status: done
createdAt: "2026-09-29"
reviewedBy: repository-owner
approvedAt: "2026-09-30T02:22:07Z"
---

# Phase M - proposed implementation tasks

The user approved this exact design and selected the reviewed H1-H4 scaffold in the task conversation. Approval was acknowledged on 2026-09-30 UTC (2026-09-29 local date). Inspection remains read-only for external projects. Target paths below include prospective files.

## Phase 1 - trusted contracts and source

<!-- maps to: ac-behavior,ac-schemas,ac-types -->
- [x] T001 Define versioned manifest, ownership, testing-policy, findings and profile contracts with invalid fixtures -> lib/harness/types.ts, lib/harness/validation.ts, lib/harness/validation.test.ts, schemas/harness-manifest.schema.json, schemas/harness-source-registry.schema.json, schemas/project-harness-profile.schema.json, schemas/harness-profiles.schema.json
- [x] T002 (depends: T001) Implement explicit trusted local source loading and pinned baseline checks with missing, changed and escaped source tests; add only the human-selected baseline -> lib/harness/source.ts, lib/harness/source.test.ts, registry/harness-sources.yml, registry/harness-manifests/surtec-h1-h4.json

## Phase 2 - read-only inventory and Doctor

<!-- maps to: ac-behavior,ac-types -->
- [x] T003 (depends: T002) Implement bounded filesystem inspection and format recognition with immutable-byte fixtures and absent, partial, legacy, invalid and unknown cases -> lib/harness/inspect.ts, lib/harness/inspect.test.ts
- [x] T004 (depends: T003) Implement evidence-based Doctor findings, explicit ownership and testing/review policy observations; report unknown validation and backup evidence without executing scripts -> lib/harness/doctor.ts, lib/harness/doctor.test.ts

## Phase 3 - observations, API and signals

<!-- maps to: ac-behavior,ac-schemas,ac-types -->
- [x] T005 (depends: T004) Add versioned control-plane profile storage with locking, atomic replacement, safe error handling and no normal-state test writes -> lib/state/harness-profiles.ts, lib/state/harness-profiles.test.ts, lib/state/paths.ts, lib/state/validation.ts
- [x] T006 (depends: T005) Add dependency-injected observations and read-only Doctor endpoints plus protected explicit refresh; test project authorization, bounded responses and unchanged external bytes -> dashboard/src/server/harness-service.ts, dashboard/src/server/harness-service.test.ts, dashboard/src/server/harness-api.test.ts, dashboard/src/server/index.ts
- [x] T007 (depends: T006) Integrate deterministic lifecycle-aware Harness signals and bounded evidence without changing dispatch permissions -> lib/signals/types.ts, lib/signals/engine.ts, lib/signals/engine.test.ts, schemas/signal.schema.json, dashboard/src/server/signal-evidence.ts, dashboard/src/server/signal-evidence.test.ts, lib/feedback-metrics.ts

## Phase 4 - dashboard and automated acceptance

<!-- maps to: ac-behavior,ac-build,ac-types -->
- [x] T008 (depends: T007) Add project Harness status, capabilities, drift, findings, refresh and evidence navigation; test loading, failure, stale observations and responsive controls -> dashboard/src/ui/api.ts, dashboard/src/ui/components/ProjectHarnessPanel.tsx, dashboard/src/ui/components/ProjectHarnessPanel.test.tsx, dashboard/src/ui/views/ProjectDetailView.tsx, dashboard/src/ui/views/ProjectDetailView.test.tsx, dashboard/src/ui/views/TodayView.tsx, dashboard/src/ui/views/TodayView.test.tsx, dashboard/src/ui/App.tsx
- [x] T009 (depends: T008) Extend isolated real API/browser acceptance with synthetic Harness fixtures, source drift, ownership protection, refresh/reload/restart, negative paths and project-byte invariance -> scripts/playwright-local-app-smoke.ts, scripts/fixtures/local-issue-api.ts
- [x] T010 (depends: T009) Update architecture and Phase M acceptance runbook with observed evidence, safe remediation boundaries and remaining risks -> docs/architecture/current-architecture.md, docs/runbooks/phase-m-acceptance.md

## Done gate

Reviewed delta: the user approved adding App.tsx on 2026-09-29 local date to open Harness evidence in the dashboard without changing other signal navigation.
Reviewed delta: the user approved adding lib/feedback-metrics.ts on 2026-09-30 local date for the Harness source's thirty-day freshness window, without cost or permission changes.

After exact human approval and clarification, record actual review metadata before implementation. Run the existing full `pnpm ci:check` and `pnpm smoke:local:playwright` gates after final edits, plus focused tests during each slice. The approved acceptance command catalog remains unchanged; the separate browser smoke is required even though it is not a catalog command. A passing structural validator is not human approval or completed Phase M evidence.

Preserve every completed task and report actual test, schema, typecheck, build and browser results. Stop after Phase M for user review; no subsequent phase or commit is authorized here.

Completion evidence (2026-09-30): final post-code-edit `pnpm ci:check` exited 0 (703 tests / 100 files, 42 product schemas, typecheck, production build and offline gates passed). Final `pnpm smoke:local:playwright` exited 0 using the real local API/browser and isolated synthetic repositories, with unchanged project bytes and confirmed cleanup. See `docs/runbooks/phase-m-acceptance.md` for historical failures, exact results and remaining boundaries. No paid call, commit, push or subsequent phase was performed.
