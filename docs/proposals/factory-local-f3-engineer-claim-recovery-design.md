# Factory Local F3 — recovery of an uncharged Engineer claim

Status: APPROVED for technical implementation and synthetic acceptance; session acknowledgement 2026-11-03T22:14:51Z. The owner explicitly approved this exact 24-path design, [specification](../../.agents/specs/uncharged-claim-recovery.spec.yaml) and [T001–T005](../../.agents/specs/tasks/f3-engineer-claim-recovery.tasks.md) in the conversation under the [Spec-First Contract](../../.agents/specs/CONTRACT.md). This acknowledgement is not an inferred earlier human timestamp. Real recovery, paid turns, sibling candidate effects, commit, push and merge remain outside this technical increment.

Current result: T001–T005 technical acceptance is COMPLETE; see the [record below](#technical-acceptance--2026-11-03). Read-only real qualification is prepared. Actual recovery and F3/F5 delivery remain pending their separate operational/human gates.

## Current checkpoint and evidence

The owner approved the exact retained Planner plan and authorized Engineer under the existing scope/caps. That plan decision is retained. The operator's execution package admitted the original implementation stage/task, claimed its first scheduler attempt and then stopped with a terminal needs-review task. Its stage remains queued without execution identity; no workflow run charge, task run metadata, thread, turn, worktree, candidate or verification receipt exists for Engineer. The workflow is needs-decision with accounting_complete=false.

Known recorded consumption is two admitted tasks, one workflow run charge, 21512 tokens and 14232 ms. Planner's output, recovery provenance, decision and final accounting remain unchanged. These numbers are not presently a spendable balance because the workflow accounting flag is unknown. The earlier interrupted workflow and its separate additional-grant history remain untouched.

The retained foreground process exited 2 after 8638 ms with both EOFs and no timeout/truncation. Its scheduler stderr identifies failed workflow replacement while recording reconciliation/blocking; it does not retain the first claim failure's exact native cause. Do not label that lost cause as proven EPERM or ENOSPC. A separate two-case synthetic filesystem probe replaced a closed-reader file successfully and produced Windows EPERM/rename with an open Node reader. This supports a monitor-sharing hypothesis, not reconstruction of the lost error.

The private monitor used asynchronous reads of live workflow/task state during synchronous controller writes. That implementation can leave a Windows read handle open across the writer's rename. Future observation must close all state-read handles synchronously on the controller's event loop before yielding. Reporting may remain asynchronous only for distinct operator-owned output files.

Read-only inspection on this date confirmed the retained blocked workflow, terminal task, committed intent, approved plan, absent Engineer charge and original usage. No worker, model, Git write, workflow recovery or cleanup was started. Docker storage relocation retained engine/resource identities; it did not renew F3 execution ownership or qualify candidate verification.

## Why existing recovery cannot apply

Existing reconcileAdmission requires a reserved stage/intent and an existing queued task with attempts=0. This task has a committed intent, attempts=1 and a terminal failure. Generic v2 retry, lease-expiry requeue, a replacement task/workflow/grant or direct JSON editing would bypass that boundary or exceed the original four-task sequence. They remain denied.

The new case is strictly before durable workflow-run charge, not interrupted or unreported inference. Production launch must first complete claimRun's atomic charge and obtain its process-local proof, and only then call runAttempt. Accounting rows cannot be removed through valid aggregate mutation. Recovery must establish that complete invariant chain against the exact retained runtime and history; absence of metadata, an error-string match, a missing row alone or an operator-supplied no-model-call flag is insufficient. If attribution cannot be proved, retain unknown and stop.

## Bounded behavior

### Eligibility and non-execution proof

Only the first implementation stage of an implementation template may qualify, after its exact current plan approval, with a committed intent, unchanged task/grant/authority/scope/context and no candidate, output, cancellation, stop or pending human decision. Permit exactly one recovery for that stage. Exclude Planner, correction, Reviewer, QA, legacy/v1 tasks and production P budget-admission scaffolds.

Require an exact validated terminal needs-review task at its first scheduler claim, no live lease, and the failure's original run identity matching the unique claimed event. Validate complete bounded event bytes and known revision progression. The existing finalizer's specific terminal-snapshot-without-terminal-event gap may be recognized only when the exact pinned producer and snapshot transition explain it; arbitrary event gaps, missing claimed events or later execution events refuse.

Independently inspect the entire workflow accounting/history for the task/stage/run, committed intent, task run/testing/verification fields and managed Git ownership/artifacts. Any charge, execution identity, started/thread/turn/usage/worktree/verification effect, conflicting run, unsupported source or unavailable observation refuses this recovery, even if a counter is zero. Validate the exact retained source/launcher/native closure package privately. A diagnostic native error code is not required or invented for the historical failure.

Reassemble the original context using in-memory projected queued-task/running-owner facts through the existing context dependency boundary; compare the exact admitted manifest, instructions, issue revision, consent, policy, plan and verification. The projection performs no persistence or source repinning. Refuse drift before preparing a recovery journal.

### Owner, receipt and cross-store ordering

Add one optional closed independently versioned uncharged_claim_recovery v1 facet on the existing workflow v1. Its provenance is immutable: workflow/stage/task/original run and revisions, committed intent/grant/authority, approved-plan binding, task/event/source/issue fingerprints, original failure/outcome/timestamps, original numeric counters, explicit human action and server-created time. Do not duplicate instructions, prompts, source bodies, raw stderr, credentials or reasoning.

A monotonic journal phase records prepared -> task-requeued -> ready, with exact expected pre/post fingerprints and revisions. A hash is a binding, not a signature or independent authority. The receipt does not mint a runtime proof or admit a task by itself.

Expose only an explicit internal operator recovery method through the existing owning TaskOrchestrator and WorkflowOrchestrator. No HTTP route, CLI command, UI button, environment activation switch or automatic startup/tick recovery is added. The owning worker must be stopped, have active.size=0, no poller and no tick in progress, checked in code through its private identity. Reject a running/foreign worker and serialized copies. Recovery itself starts no worker or task.

Before mutation, the private operator verifies byte-for-byte archived workflow/task/event/issue inputs and the original runtime package in a new external owner-controlled root. Preserve all original bytes and fingerprints. An archive is preservation evidence, not proof of no execution.

Persist the prepared workflow receipt first, keeping needs-decision, accounting_complete=false and dispatch blocked. In a separate task critical section, recheck every bound fact and requeue only the exact existing task at a new revision. Preserve envelope, identity, scope, caps, started_at, attempts=1 and cumulative usage. Archive the old result/failure bytes and append a bounded recovery event carrying their fingerprints and original run/failure; do not rewrite prior JSONL lines. No new task, stage, intent, grant or accounting row is created.

After the task snapshot and exact event append are both verified, advance the journal and revalidate all workflow/task/issue/context facts. Only then may the same owner return to running/recovery_state=none. Derive accounting completeness from every immutable charged run plus the separately proven pre-charge non-execution; do not fabricate a zero-token completed run, set unknown usage to zero or mutate historical charges. All numeric root counters stay unchanged. Every phase uses the existing locks separately, without nested task/workflow locks or cross-store atomicity claims.

The resumed task's next normal claim increments its existing task attempt from 1 to 2; it does not decrement or erase the failed scheduler claim. That claim must durably charge one actual workflow run before any effect. Under unchanged caps, the intended final sequence still has four task identities and four charged role executions. No remaining capacity is promised before current policy/context checks pass. Another failure is not eligible for this one-use recovery.

Interrupted journal application stays stopped. An explicit operator continuation may finish only the same exact prepared operation at recognized pre/post hashes, without a new receipt/requeue/charge. Unknown states, missing recovery event, changed backups, source drift or conflicts preserve bytes and require review. Do not restore old snapshots over newer progress. Ordinary readers/ticks never finish the operation automatically.

### File-error evidence and monitor correction

Keep atomic replacement, unique staging, ownership checks, flushing, cleanup and failure behavior unchanged. Add only bounded internal error classification to WorkflowStateError: operation phase and allowlisted native code/syscall, never raw message/path/stack/cause objects. Keep current generic public message and do not add retries, sleeps, relaxed sharing or another timeout. Test injected open/write/flush/ownership/rename failures for unchanged prior bytes and owned staging cleanup.

The next private operator launcher uses synchronous bounded validated workflow/task/event reads, then returns to the event loop; it never holds an asynchronous read of a mutable state file. Build and test that operator-owned observer without overwriting the historical launcher or frozen runtime. Preserve all old private source/configuration/verifier pins; use a new reviewed code capsule after technical acceptance and refuse any changed admitted source/manifest rather than rebinding grants.

### Compatibility and privacy

Absent facets retain existing behavior with no backfill. Present null/malformed/future facets fail closed. Immutable provenance cannot be removed/rewritten; journal phases cannot regress or skip required fingerprints/events. Ready receipts persist after execution, cancellation and completion. Older incompatible readers must use compatible code rather than stripping state.

Keep Planner task/result/events/output/accounting byte-identical and the existing exact plan approval intact. Engineer's current snapshot deliberately advances through audited recovery; its prior bytes/failure are archived and prior event lines retained. These are different preservation guarantees and must be reported separately.

Current write exclusion, context/consent, runtime/network/sandbox, lease, verification/testing, candidate-bound Reviewer/QA, final human criterion acceptance and publication controls remain. A human recovery action does not waive feasibility or authorize a successful delivery claim.

## Exact technical targets

The 24 repository paths below are the entire proposed implementation/acceptance set. The first three are prospective artifacts; the last two also reconcile the already observed real checkpoint now. Two private operator observer files and a future read-only/native preflight/archival package remain outside Git and outside the writer's scope. No sibling source, dependency, lockfile, registry, Harness catalog/pin, schema-version migration or normal user-state write is included.

1. `docs/proposals/factory-local-f3-engineer-claim-recovery-design.md`
2. `.agents/specs/uncharged-claim-recovery.spec.yaml`
3. `.agents/specs/tasks/f3-engineer-claim-recovery.tasks.md`
4. `lib/workflows/types.ts`
5. `schemas/workflow-record.schema.json`
6. `lib/workflows/uncharged-claim-recovery.ts`
7. `lib/workflows/uncharged-claim-recovery.test.ts`
8. `lib/workflows/validation.ts`
9. `lib/workflows/validation.test.ts`
10. `lib/state/workflows.ts`
11. `lib/state/workflows.test.ts`
12. `runner/workflow-orchestrator.ts`
13. `runner/workflow-orchestrator.test.ts`
14. `runner/task-orchestrator.ts`
15. `runner/task-orchestrator.test.ts`
16. `scripts/fixtures/local-issue-api.ts`
17. `scripts/playwright-local-app-smoke.ts`
18. `scripts/harness-validators.test.ts`
19. `docs/architecture/current-architecture.md`
20. `docs/architecture/execution-runtime.md`
21. `docs/architecture/organization-state-migration.md`
22. `docs/security/threat-model.md`
23. `docs/proposals/factory-local-f3-design.md`
24. `docs/roadmap/factory-local-poc.md`

## Ordered tasks and checks

T001 defines the pure proof/closed facet/mutation and compatibility guards; T002 integrates private stopped-worker recovery and recoverable cross-store ordering; T003 adds bounded storage-error evidence and the external synchronous observer; T004 extends isolated real API/Chromium acceptance through test-only child IPC; T005 closes the bounded technical gate and prepares a separately gated real re-entry. Full details are in the draft task plan.

All implementation checks below require actual design/spec/task approval first. Use foreground native capture, both EOFs, owned external TEMP/TMP and 900 s per command. Existing test, HTTP, worker, role, token, runtime and capture bounds are unchanged. Stop dependent execution on failure/unknown; preserve the result and diagnose within the approved scope. Do not repeat unaffected passing checks.

1. C01 contracts/state: pnpm exec vitest run lib/workflows/uncharged-claim-recovery.test.ts lib/workflows/validation.test.ts lib/state/workflows.test.ts --testNamePattern=uncharged-claim --silent=passed-only
2. C02 worker/controller: pnpm exec vitest run runner/workflow-orchestrator.test.ts runner/task-orchestrator.test.ts --testNamePattern=uncharged-claim --silent=passed-only
3. C03 tooling: pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern=uncharged-claim --silent=passed-only
4. C04 unchanged recovery compatibility: pnpm exec vitest run runner/workflow-orchestrator.test.ts --testNamePattern="explicit recovery commits only an existing unstarted task/link gap without redispatch or refund|missing reserved task and source drift stay unrecoverable with retained bytes|changed sources prevent recovery even when the reserved task and link survived|missing final usage is unknown and cannot be recovered as zero or retried|planner-recovery" --silent=passed-only
5. C05 catalog: pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/uncharged-claim-recovery.spec.yaml -TimeoutSeconds 900
6. C06 focused actual API/Chromium: pnpm smoke:local:playwright --uncharged-claim-recovery-only
7. C07 actual API/Chromium compatibility: pnpm smoke:local:playwright --planner-recovery-only

C05 runs exactly schemas, typecheck, build and secrets; it cannot replace C01-C04/C06-C07. New tests use the literal uncharged-claim name so selections/counts are attributable. Include budget preservation, positive proof vs absence-only denial, cancellation/foreign worker/active tick, repeated recovery, charged or unknown inference, source/scope drift, fault injection at every journal boundary, restart, byte preservation and unsafe/null/future data. The diagnostic observer's synthetic checks must demonstrate closed state handles before mutation and refusal of read/capture failure without influencing controller facts.

C06 uses the existing real API/server/worker/Git/verification/browser fixture and forbidden paid runtime. Inject exactly one pre-charge claim failure in the test bootstrap only, then stop its worker. A closed synthetic-only child IPC message invokes the internal explicit recovery, with no product endpoint or environment recovery switch. IPC belongs only to the fixture's owned child/root; it cannot select paths, scripts, commands or user state. Every other existing scenario remains unchanged.

Assert one task identity for Engineer, retained initial failure and attempts=1 before recovery, no fake executor effect from the failed claim, no worker/model start from recovery, no generic retry, a new normal claim with task attempts=2, one writer and separate inactive-candidate Reviewer/QA. Require exactly four fake role executions/charges overall, original Planner bytes/accounting, unchanged caps and trusted verification, pending final human gate, synthetic explicit criterion acceptance, reload/API restart with no replay, exact candidate bindings and confirmed owned cleanup. C07 preserves the existing four-turn Planner scenario and human gate. No browser assertion or deadline is weakened.

No full-suite, CI, eval, audit, installation, image pull or real-model campaign belongs to technical acceptance. Existing global debt remains open.

## Separate real re-entry and delivery boundary

Technical PASS does not apply recovery to the private workflow. Before any real re-entry: renew source/baseline/verifier/native identities, observe Docker at its new configured store without image acquisition, confirm no live known worker/lease, validate archive/journal eligibility and establish a fresh owner-declared exclusive writer/known-instance window. The old 30-minute declaration expired. Do not assume silence renews it.

Present the exact real recovery binding and observed eligibility for human operational approval. The earlier exact plan approval remains valid only if all its bound facts still match; do not ask for the same approval again or silently change its plan. The current user request authorizes resolving the blocker under unchanged limits; it does not prove future ownership, technical eligibility or final acceptance.

After that explicit action and renewed ownership, start only the same bounded workflow. Keep the root 4 tasks / 4 charged attempts / 900000 ms / 100000 tokens, Engineer 300000 ms including commit/verification, full Reviewer+QA, correction OFF and the already selected configurable model/effort. Preserve the separate old grant/history. Remaining feasibility is unmeasured and may still block; do not invent a successful candidate or increase caps.

Stop at a failure/unknown or the final criterion decision. Real Engineer, independent verification including the two actual API/database/browser sessions, candidate-bound Reviewer/QA and actual owner acceptance are still required for F3. F5 remains subsequent; no push or merge follows.

## Historical draft-time boundary

At the original proposal boundary only this proposal/spec/tasks and the two existing public F3 status summaries were authored. Documentary checks validated structure, targets, task/check coverage, links, privacy and whitespace only; no -Run or -ConfirmExecution, product tests, worker, model, API/browser, Git effects or real-state changes occurred. Approval metadata was null at that historical point. Exact private identities/paths/business context and raw stderr stay outside this public repository.

## Documentary observations — 2026-11-03

- Structural specification validation exited 0: one proposed spec, zero acceptance commands executed.
- Structural task validation exited 0: one draft task plan with five unchecked ordered tasks; no human approval inferred.
- The in-memory documentary reader exited 0: 24 unique targets exactly matching task targets, 12 covered requirements, four unchanged catalog checks, seven separately mandatory acceptance groups and four valid local proposal/task links. Only the two explicitly declared future source/test files may be absent.
- The same read-only reader confirmed exact equality with the retained terminal workflow checkpoint and both original Planner task/event hashes. Engineer remains finished needs-review, attempts=1, without lease/execution/charge, and workflow accounting remains unknown. No real recovery or model call occurred.

These were documentary/read-only observations, not C01-C07, technical implementation, positive recovery qualification, current exclusive ownership or real F3 acceptance. All implementation tasks were draft and review metadata was null at that point. The later actual approval and technical results follow separately.

## Technical acceptance — 2026-11-03

The owner approved the exact 24-path design/specification and T001–T005. All five technical tasks are implemented and accepted within that boundary; real application is still pending. Immutable receipt/journal, positive paired producer/operator qualification, stopped-owner identity, existing task/event locks and ordinary charging/verification/review gates are enforced in code. A read-only active-count observation grants no execution authority. The two private observer files and original operator/runtime remain separately preserved.

| Check | Actual final result | Native elapsed ms |
| --- | --- | ---: |
| C01 contracts/state/diagnostics | 53 PASS; 214 filtered | 5207 |
| C02 worker/controller and journal faults | 12 PASS; 173 filtered | 73597 |
| C03 fixture transport/native closure | 13 PASS; 133 filtered | 12396 |
| C04 unchanged recovery compatibility | 16 PASS; 87 filtered | 109108 |
| Private synchronous observer qualification | 9 PASS; zero filtered | 2917 |
| C05 unchanged catalog gate | schemas, typecheck, build, secrets: four checks PASS | 35718 |
| C06 uncharged claim actual API/Chromium | PASS; exactly four fake role executions/charges | 103775 |
| C07 retained Planner actual API/Chromium | PASS; exactly four fake role executions/charges | 103948 |

These are 103 distinct selected test cases including the observer, not full-file or full-suite acceptance. Filtered cases and repeated executions are excluded. Every listed foreground invocation exited native 0 with root exit and both EOFs observed, null signal, no timeout/truncation/spawn/stream error or requested termination, within 900 s per command. C05 reports child check exits but suppresses individual child output; this record does not infer absent child warnings. Browser stderr retains expected Git LF/CRLF warnings from synthetic fixture setup.

C06 proved real closed-producer/native evidence, the original uncharged claim with zero executor effects, separate recovery/start, same Engineer identity with task attempts 1 then 2, unchanged numerical charges/caps and Planner bytes/approval, retained event prefix/failure archive, duplicate refusal, four actual fake-producer charges, infrastructure verification and exact independent candidate Reviewer/QA. Both browser flows required pending human gates, explicit synthetic criterion acceptance, actual API restart, no replay, retained evidence and mobile layout. Both reported zero read cancellations and confirmed browser/Vite/API closure plus owned workspace removal with no cleanup failures. No paid runtime was available.

Initial failures are retained, not relabeled: the first typecheck found unused/missing imports/parameters; a later typecheck found four private-field accesses in tests/fixture, corrected through a read-only counter. The initial C02 had 11 passing cases and one happy-path test timeout under its unchanged 15-second case limit; it was separated from redundant scheduler work, retaining controller/identity/charge assertions while C06 independently proves the normal scheduler/end-to-end path. Final C02 passed all 12 within existing limits. Initial C06 completed the synthetic workflow but failed its exact UI event selector because rendered text includes revision/type; the selector now checks that full exact event binding. Final C06 passed. A receipt-summary PowerShell parse error affected only reading evidence, was corrected, and caused no acceptance execution or state effects. No guard, old assertion or timeout was widened.

T005's new private read-only package also exited native 0 with closed root/both EOFs in 32109 ms. It positively qualified the archived retained claim and projected current context, preserved original Planner bytes/approved plan and historical state, and checked 11 approval inputs, one Codex binary, 24 verifier files, 29 pilot sources, 935 retained runtime sources, 16903 policy/dependency files, four historical-state pins, seven native tools and 252 existing package archives. Read-only Git confirmed the unchanged clean baseline; Docker info/local image inspection confirmed the existing engine/image identity after storage relocation, without start/pull/container creation. Its exact proposed recovery binding keeps confirmation false and approval id null. No real state was mutated, worker started, private runtime refreshed or model called; accounting remains unknown and no spendable balance is claimed.

The package is preparatory evidence, not a current exclusive-owner guarantee or operational approval. Fresh writer/known-instance coverage, exact action approval, qualified next operator/runtime composition and immediate current fences still precede real recovery/Engineer. The earlier exact plan decision is retained and must not be requested again if unchanged. Real candidate verification, Reviewer/QA and owner criterion acceptance remain pending; F3/F5 and historical global suite/CI debt stay open. No full suite, CI, eval, audit, install/download, process cleanup, sibling source write, commit, push or merge was performed.
