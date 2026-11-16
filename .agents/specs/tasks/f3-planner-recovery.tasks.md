---
spec: .agents/specs/planner-recovery.spec.yaml
feature: f3-planner-recovery
status: done
createdAt: "2026-11-03"
reviewedBy: repository-owner
approvedAt: "2026-11-03T15:04:07Z"
---

# F3 retained Planner recovery — technical tasks

The owner explicitly approved this exact design/specification and T001–T005 technical implementation and synthetic acceptance in the conversation. The acknowledgement time is recorded above, not an inferred earlier human timestamp. All five tasks below are checked only after their observed technical acceptance. Real recovery and paid calls are not authorized. Follow [the exact proposed design](../../../docs/proposals/factory-local-f3-planner-recovery-design.md), including its 32-file set and mandatory C01-C07. Original outcomes, usage and prior approvals remain historical facts.

## Phase 1 — typed recovery basis and immutable state

<!-- maps to: ac-schemas,ac-types,ac-secrets -->
- [x] T001 Define the closed optional recovery facet, pure eligibility/binding guards, one-time mutation fences and focused synthetic state contracts -> lib/workflows/types.ts, schemas/workflow-record.schema.json, lib/workflows/planner-recovery.ts, lib/workflows/planner-recovery.test.ts, lib/workflows/validation.ts, lib/workflows/validation.test.ts, lib/state/workflows.test.ts.

Prove default denial without the facet, immutable output/task/accounting bindings, permitted running-to-needs-review terminalization only, complete/unknown distinction, absent/null/malformed/future facet behavior and final completion provenance. No endpoint or real-state change in this task. Use the new literal planner-recovery test group; C01 becomes complete only after the handoff additions in T002. Do not relax other terminal-stage mutation rules.

## Phase 2 — service, handoff, context and controller

<!-- maps to: ac-schemas,ac-types,ac-secrets -->
- [x] T002 (depends: T001) Integrate explicit offer preparation and atomic receipt/decision creation with narrowly guarded planning continuation, independent approval and restart-safe single successor admission -> lib/workflows/review-evidence.ts, lib/workflows/review-evidence.test.ts, dashboard/src/server/workflow-service.ts, dashboard/src/server/workflow-service.test.ts, dashboard/src/server/workflow-context-service.ts, dashboard/src/server/workflow-context-service.test.ts, runner/workflow-orchestrator.ts, runner/workflow-orchestrator.test.ts.

Reuse the existing receipt validator at effect boundaries; preserve the strict ordinary terminal guard. Keep every original task/event/output/accounting byte and current grant/caps. Do not start a role while merely offering recovery. Bind questions/risks and the composite decision fingerprint; propagate explicit human provenance without erasing original questions. Deny material/source/consent drift, cancellation, unknown usage and P scaffold activation. Run completed C01, C02 and existing recovery compatibility C04 once their targets are ready. Keep the full heavy workflow suite unselected and report filtered counts; this does not waive its debt.

## Phase 3 — protected HTTP and explicit local UI

<!-- maps to: ac-types,ac-build,ac-secrets -->
- [x] T003 (depends: T002) Expose the bounded current recovery offer and protected confirmed recovery action, with distinct UI offering and exact plan approval controls -> dashboard/src/server/index.ts, dashboard/src/server/workflow-api.test.ts, dashboard/src/ui/api.ts, dashboard/src/ui/components/WorkflowPanel.tsx, dashboard/src/ui/components/WorkflowPanel.test.tsx.

Preserve loopback/origin/fetch-site/session/no-store controls and 4-KiB input. Forbid plan/grant/cap/consent inputs and caller-owned receipts. Require complete question/risk acknowledgement, current fingerprint/revisions and deliberate confirmation. Refuse stale/duplicate requests without another mutation; lost results trigger explicit reads, not replay. Reset acknowledgements on changed facts/reload. Keep unstarted admission reconciliation separate. Keep private clarification bodies out of list/operating summaries. Run the HTTP/UI portion of C03; no real-instance or model operation is included.

## Phase 4 — isolated actual API and Chromium acceptance

<!-- maps to: ac-types,ac-build,ac-secrets -->
- [x] T004 (depends: T003) Add the exact planner-recovery fake scenario, focused browser selection and tooling regressions through the existing owned fixture -> scripts/fixtures/local-issue-api.ts, scripts/playwright-local-app-smoke.ts, scripts/harness-validators.test.ts.

The new fake must construct an actual synthetic terminal receipt with live task/run/context/thread/turn bindings. It never enables the paid runtime or changes other scenario trust. Automate the separate recovery and plan gates, rejection/stale/unknown refusals, reload/restart, one Engineer plus independent Reviewer/QA, exact candidate acceptance, original byte/counter preservation and cleanup. Add --planner-recovery-only using the existing bootstrap/cleanup and existing deadlines; extend default acceptance without removing assertions. Complete C03 and prepare C06-C07. Focused acceptance expects four fake turns; complete compatibility expects 35.

## Phase 5 — bounded technical gate and honest re-entry boundary

<!-- maps to: ac-schemas,ac-types,ac-build,ac-secrets -->
- [x] T005 (depends: T004) Execute the mandatory bounded technical acceptance, reconcile compatibility/security documentation and record real-pilot re-entry requirements without applying recovery -> docs/architecture/current-architecture.md, docs/architecture/execution-runtime.md, docs/architecture/organization-state-migration.md, docs/security/threat-model.md, docs/proposals/factory-local-f3-design.md, docs/roadmap/factory-local-poc.md, docs/proposals/factory-local-f3-planner-recovery-design.md, .agents/specs/planner-recovery.spec.yaml, .agents/specs/tasks/f3-planner-recovery.tasks.md.

All C01-C04 behavior results must be observed; repeat only checks affected by later changes or unresolved failures. Run C05 catalog gate, then C06 and C07 with 900 seconds per command, foreground native capture and owned external TEMP/TMP. Preserve every failure and stop dependent steps on failure/unknown. Report tests/filtered counts, schema/type/build/secrets exits, browser turns, source/task/event/accounting preservation and exact cleanup separately. No full suite, CI, eval or audit campaign, install/download, paid turn, normal-state mutation, sibling change, commit, push or merge is included. Keep historical global debt explicit.

## Done gate

After actual human approval and execution authority, structurally validate these artifacts, then use:

`pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/planner-recovery.spec.yaml -TimeoutSeconds 900`.

This executes only the four catalog checks. C01-C04 and actual API/browser C06-C07 from the design remain separately mandatory; a catalog PASS alone is insufficient. No task becomes done on skipped/unknown evidence or metadata alone. Implementation may diagnose routine scoped failures under standing authority, but material contract/scope/limit changes return to review.

Technical completion does not recover the private workflow or approve its plan. A later operational package must renew current baseline/source/runtime identities and expired writer/instance coverage, preserve original and additional consumption, explicitly offer this exact retained plan and stop for actual human approval before Engineer. Final real candidate acceptance remains human; F3/F5 are not closed by this synthetic increment.

## Technical completion — 2026-11-03

T001-T005 are DONE under the owner's approval recorded above. The [observed acceptance record](../../../docs/proposals/factory-local-f3-planner-recovery-design.md#technical-acceptance--2026-11-03) contains the exact C01-C07 commands, passed/filtered inventory, all retained failures and the subsequent scoped corrections.

There are 56 unique passing focused cases: C01 29, C02 14, C03 7, C04 4 and two existing atomic-store failure cases. The separately strengthened scope case is already included in C02. The catalog's four checks exited 0. Focused actual API/Chromium passed with four fake roles in 107031 ms; complete compatibility passed with exactly 35 fake turns in 842287 ms. Both final browser runs had native exit 0, both EOFs, no timeout/truncation, zero read cancellations and complete browser/Vite/API/workspace cleanup. Final source hashes, native receipts and historical failures remain in owned private evidence.

The real workflow remains untouched and its model result remains needs-review. No real recovery request, model call, sibling modification or commit/push/merge of project changes occurred. Global full-suite/CI debt remains open. Renew operational identities and expired writer/instance coverage before a separate explicit recovery offer; actual exact-plan approval precedes Engineer, and real criterion acceptance still precedes F3/F5 closure.
