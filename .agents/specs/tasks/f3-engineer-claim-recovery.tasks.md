---
spec: .agents/specs/uncharged-claim-recovery.spec.yaml
feature: f3-engineer-claim-recovery
status: done
createdAt: "2026-11-03"
reviewedBy: repository-owner
approvedAt: "2026-11-03T22:14:51Z"
---

# F3 uncharged Engineer claim — technical tasks and results

The owner explicitly approved this exact 24-path design/specification and T001–T005 for technical implementation and synthetic acceptance. The timestamp is the session acknowledgement, not an inferred earlier human timestamp. Follow the [approved design](../../../docs/proposals/factory-local-f3-engineer-claim-recovery-design.md), including mandatory C01-C07 and the separate real re-entry gate. The completed retained-Planner recovery and real evidence remain unchanged.

## Phase 1 — typed positive proof and recoverable journal

<!-- maps to: ac-schemas,ac-types,ac-secrets -->
- [x] T001 Define the closed uncharged claim proof, immutable provenance and monotonic journal, plus missing/malformed/future/state mutation denials -> lib/workflows/types.ts, schemas/workflow-record.schema.json, lib/workflows/uncharged-claim-recovery.ts, lib/workflows/uncharged-claim-recovery.test.ts, lib/workflows/validation.ts, lib/workflows/validation.test.ts, lib/state/workflows.test.ts.

Test positive exact producer/claim/intent/history/accounting bindings and absence-only denial; preserve every existing numeric counter and final charge. Recognize only the pinned finalizer's specific known event gap. Prevent arbitrary task/output/status overrides, phase skipping, repeated recovery and other-role/P eligibility. C01 uses the literal uncharged-claim test group. No live state or task requeue is included.

## Phase 2 — stopped-owner explicit recovery

<!-- maps to: ac-schemas,ac-types,ac-secrets -->
- [x] T002 (depends: T001) Integrate owning-worker-only recovery, projected exact context validation, fenced task/event updates and stopped restart handling -> runner/workflow-orchestrator.ts, runner/workflow-orchestrator.test.ts, runner/task-orchestrator.ts, runner/task-orchestrator.test.ts.

Require the owning worker stopped with no active attempt, poller or tick; no serialized proof or foreign owner. Recovery itself starts no worker. Persist a blocked prepared receipt, requeue the same task by existing task lock without decreasing attempts/caps/usage, retain old failure in the private archive and append recovery evidence, then verify before running readiness. No nested store locks or generic v2 retry. Fault-inject every boundary, continue only the same recognized journal explicitly, and retain unknown/conflicts. The next ordinary claim increments task attempts and charges one workflow run through the unchanged execution path. Run completed C01, C02 and C04 as affected, reporting filtered cases.

## Phase 3 — bounded native error and synchronous operator observation

<!-- maps to: ac-types,ac-secrets -->
- [x] T003 (depends: T002) Classify atomic-write failures without leaking native bodies or changing replacement semantics; qualify the external operator observer -> lib/state/workflows.ts, lib/state/workflows.test.ts.

Preserve generic public errors, locks/ownership, unique staging/flush, cleanup and all timeouts; expose bounded internal phase/allowlisted code/syscall only. Cover injected failures and preservation through uncharged-claim tests in C01. Prepare exactly two new private external observer files, observer.mjs and observer.test.mjs, outside Git; retain the old monitor/runtime untouched. Their synthetic checks prove bounded synchronous state reads close before mutation, no asynchronous handle overlap and fail-closed reads/capture. No real state monitoring, model call or private runtime refresh occurs yet.

## Phase 4 — real API/browser with a fake producer

<!-- maps to: ac-types,ac-build,ac-secrets -->
- [x] T004 (depends: T003) Add an isolated pre-charge failure/recovery fixture, closed test-only child IPC and a focused actual API/Chromium selection -> scripts/fixtures/local-issue-api.ts, scripts/playwright-local-app-smoke.ts, scripts/harness-validators.test.ts.

Add --uncharged-claim-recovery-only through existing owned bootstrap/cleanup and existing deadlines. Inject one pre-charge failure only in the test bootstrap; keep runtime forbidden. Closed child IPC selects only the current exact synthetic workflow/task/revision action, never paths/commands/user state or a product endpoint. Assert no failed-claim executor effect, same Engineer identity, archived failure/event prefix, unchanged Planner/charges/caps, attempts 1 then 2, one writer and independent exact candidate reviews, four fake role executions/charges, synthetic human acceptance and reload/restart/no replay. Retain every existing smoke assertion. Run C03 and prepare C06-C07; do not add a full default campaign.

## Phase 5 — bounded technical acceptance and separate real handoff

<!-- maps to: ac-schemas,ac-types,ac-build,ac-secrets -->
- [x] T005 (depends: T004) Complete C01-C07 and synthetic observer checks, document actual boundaries and prepare the current real recovery package without applying it -> docs/architecture/current-architecture.md, docs/architecture/execution-runtime.md, docs/architecture/organization-state-migration.md, docs/security/threat-model.md, docs/proposals/factory-local-f3-design.md, docs/roadmap/factory-local-poc.md, docs/proposals/factory-local-f3-engineer-claim-recovery-design.md, .agents/specs/uncharged-claim-recovery.spec.yaml, .agents/specs/tasks/f3-engineer-claim-recovery.tasks.md.

Use exactly the design commands: focal contracts/worker/tooling and existing recovery compatibility, four catalog checks, new focused API/Chromium and existing retained-Planner focused compatibility. Run in foreground with owned external TEMP/TMP, both EOFs and 900 s per command; report counts/native exits/cleanup and all failures. Repeat affected checks only after routine scoped remediation. No full suite, CI, eval, audit, installs/downloads, process cleanup, model, live recovery, sibling write, commit, push or merge.

Technical completion does not authorize applying the receipt to real state or starting Engineer. Prepare a private source/baseline/verifier/native/Docker identity qualification and archival package, show exact recovery binding/eligibility and obtain a fresh owner declaration of exclusive writing/known instances plus the exact operational recovery action. Reuse the existing human plan approval only if every bound fact is unchanged. Stop on missing proof, drift or unknown. Do not claim a spendable balance until the approved recovery proves its pre-charge boundary.

## Done gate

Only after actual approval of the exact design/spec/tasks and execution authority:

pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/uncharged-claim-recovery.spec.yaml -TimeoutSeconds 900

This executes the four catalog commands only. C01-C04, the private synthetic observer qualification, and real API/browser C06-C07 remain mandatory. Filtered or unrun cases are not PASS. Preserve current global debt and all historical real attempts. A technical done gate is not F3/F5 completion or actual human candidate acceptance.

## Historical draft-time work

At the original proposal boundary, only the three prospective artifacts and the two already observed public F3 status summaries were authored. Structure/references/targets/privacy/whitespace checks were documentary, without -Run/-ConfirmExecution. All five implementation tasks were unchecked and review metadata was null. No model, workflow mutation, candidate, application test, smoke or code implementation was included in drafting. Subsequent actual approval and acceptance are recorded separately above and in the design; the historical observations are not executable acceptance.

## Technical completion — 2026-11-03

T001–T005 are complete at their approved technical boundary. C01–C04 passed 94 distinct selected cases, the private observer passed nine synthetic cases, C05 passed all four catalog checks, and C06/C07 each passed the actual isolated API/Chromium flow with four fake charged roles and complete owned cleanup. Filtered cases are excluded. The [design acceptance record](../../../docs/proposals/factory-local-f3-engineer-claim-recovery-design.md#technical-acceptance--2026-11-03) retains timings, initial failures, remediation and interpretation limits.

The read-only private package qualified the original claim, unchanged Planner/plan, projected current context, exact source/verifier/native/package identities, clean pilot baseline and existing Docker/image identity. It archived bounded original snapshots and proposes the exact workflow/task/revision binding with confirmation false and no operational approval id. It started no worker, refreshed no private runtime and changed no real state. Actual recovery and Engineer remain blocked on fresh writer/known-instance coverage, explicit operational action and immediate current fences. This does not complete real F3 or F5.
