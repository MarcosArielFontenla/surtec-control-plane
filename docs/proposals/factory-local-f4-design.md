# Factory Local F4 — failure, recovery and traceability verification

Status, 2026-11-02: T001-T005 are VERIFIED and F4 synthetic technical acceptance is complete. T005's full actual API/Chromium campaign passed all existing assertions plus N12, exactly 31 fake turns and owned cleanup in 788280 ms under the unchanged 900-second limit. Six new diagnostic regressions, typecheck, 63 schemas, build and secrets also passed. Earlier test receipts remain attributed and source-bound, not summed as unique cases. The [acceptance record](../runbooks/factory-local-f4-acceptance.md#t005-consolidated-technical-acceptance) preserves both historical full-smoke timeouts as failures with unknown causes; no latency fix or guaranteed absence of recurrence is claimed. Production contracts/runtime policy are unchanged. Real F3 delivery, F5 and global suite/CI debt remain open; this completion grants no live execution or publication authority.

## Boundary and dependencies

F4 can test existing dangerous-negative controls independently in synthetic state while real-pilot work is deferred. This neither marks F3 accepted nor proves the global PoC success criterion. F5 pilot acceptance still requires an actual locally accepted delivery and all applicable critical controls.

The real F3 pilot is not merely awaiting human QA: its historical Planner stopped, no exact plan was approved and Engineer/real candidate verification/Reviewer/QA have not run. Preserve that attempt and its accounting. No new paid call, pilot dispatch, writer window, budget reset or sibling write follows from this verification plan.

Keep the modular monolith, sole existing worker/runtime, file-first stores, exact lease/candidate/context bindings and existing human gates. Do not activate deferred P continuity/restore features or add another tracker, store, scheduler or framework.

## Reconciled starting evidence

- [Terminal-evidence acceptance](factory-local-f3-terminal-evidence-design.md): 258 protocol tests, 184 complete consumer tests, 33 browser-read regressions, four catalog checks and a full isolated actual API/Chromium smoke with exactly 31 synthetic turns and complete cleanup.
- [Real pilot status](factory-local-f3-design.md): incomplete delivery, historical needs-decision and separately required live execution/plan/candidate authority.
- [Active roadmap](../roadmap/factory-local-poc.md): global suite/CI debt remains open. F4 verification is not a waiver or a whole-repository passing result.

These are attributed prior receipts, not new F4 executions. The first block now has its own fresh results in the linked record. Reuse of other receipts still requires confirming relevant source/policy bindings are unchanged; test presence alone never counts as execution.

## Mandatory-case map

| ID | Control and observable refusal/recovery | Existing starting evidence | F4 disposition |
| --- | --- | --- | --- |
| N01 | Incomplete scope or missing authority cannot write | [Issue service](../../dashboard/src/server/issue-service.test.ts): explicit scope authorization and duplicate ownership; [runner](../../runner/run-task.test.ts): standalone v2 denial | VERIFIED by source-bound T002/T003 receipts and T005 full browser refusals |
| N02 | Failed, absent or invalid verification cannot be accepted | Issue service authoritative receipts; runner failed/missing functional verification and RED refusals | VERIFIED by source-bound service/runner receipts; T005 exact verified-candidate browser acceptance |
| N03 | Builder success text cannot replace infrastructure evidence | Issue service missing-receipt refusal; exact terminal receipt and writer pre-effect tests | VERIFIED by T002's 33 receipt-contract cases, runner checks and T005 exact infrastructure-receipt assertions |
| N04 | Reviewer finding binds exact criterion/candidate; correction is bounded | [Workflow controller tests](../../runner/workflow-orchestrator.test.ts) and real isolated review/correction flows | VERIFIED by T005 full campaign: fresh candidate verification, Reviewer/QA, one consumed correction and second-correction refusal; not real pilot review |
| N05 | Changed candidate/scope invalidates prior authority | Issue service scope revision/acceptance; workflow source drift, exact candidate checks | VERIFIED by source-bound T002/T003 checks and T005 stale scope/source/tree/candidate browser refusals |
| N06 | Unknown interrupted effect/usage cannot become zero or generic retry | Workflow unknown final usage, lost lease, exact unstarted-gap recovery and restart | VERIFIED in T003 synthetic worker/controller/runner checks; retain known charges and unknown holds |
| N07 | Repeated request cannot duplicate work or approval | Issue service retained proposal/replay tests; F2 intake and browser repeated-request guards | VERIFIED by source-bound service cases and T005 keyed replay/reload/refusal plus exact unchanged turn-count assertions |
| N08 | Cancellation/exhaustion starts no successor | Workflow durable stop, token/runtime caps and exact exhaustion; existing browser held-stop | VERIFIED in T003, including root and separate Reviewer/QA caps, durable stop and exact ownership |
| N09 | Context text cannot grant authority or import another project's data | [Context service tests](../../dashboard/src/server/context-service.test.ts): source/policy/consent binding and private category exclusion | VERIFIED by 31 unchanged context-service cases and T005 explicit preview/privacy/exclusion assertions |
| N10 | A competing project writer cannot run concurrently | [Task worker tests](../../runner/task-orchestrator.test.ts): project write serialization and one scheduler | VERIFIED in T003 with two cooperating workers, one project writer, spare read capacity and no duplicate charge/execution |
| N11 | Integration requires a fresh check of the integrated tree | No integration is authorized or performed | Not applicable to this isolated F4 increment; remains mandatory for any later authorized integration |
| N12 | Restart reconstructs persisted facts and exposes unavailable history | Snapshot survives refused append; absent/partial/damaged/sparse event tests; new API instances and actual API/browser restart/reload with exact byte preservation | VERIFIED by T004 focused receipts and T005's full restart/history flow; no completeness proof, repair or replay |

N12 inspection found an unsupported "Lifecycle completo" label. Task detail now exposes registered history, observed revisions and unknown completeness using its existing response fields. Snapshot persistence and event append remain separate operations; neither tests nor documents may call them one atomic transaction. Revision differences can reflect legitimate snapshot-only updates; equal latest revisions cannot exclude an interior loss. An absent/incomplete event history is never invented, backfilled or promoted into complete evidence.

## Ordered verification tasks

| Task | Scope | Completion evidence | Status |
| --- | --- | --- | --- |
| T001 | Reconcile instructions, current F3 boundary, the twelve cases and existing tests | Static plan/map plus observed Git/source identity and exact first-block commands | VERIFIED for the first block |
| T002 | Existing permission/context/verification/replay refusals | 222 complete service cases, 33 receipt-contract cases and 24 selected runner cases, all PASS with native closure and preserved source pins | VERIFIED |
| T003 | Existing writer exclusion, cancellation, budget/lease/recovery refusals | 80 complete worker cases, 28 selected workflow cases and 103 complete runner cases PASS; typecheck PASS; one test-only adjustment, original limits intact | VERIFIED |
| T004 | Inspect and demonstrate the snapshot/event-gap and restart observation boundary | 279 focused cases, four selected API cases, schemas/types/build and actual API/Chromium history/restart selection PASS; snapshot/event bytes retained and zero turns | VERIFIED for N12; no full-compatibility acceptance implied |
| T005 | Consolidate criterion evidence, relevant API/browser coverage and remaining limits | N01-N12 disposition/source bindings; six diagnostic cases and complete 31-turn API/Chromium campaign PASS, schemas/types/build/secrets PASS, owned cleanup | VERIFIED; historical timeouts retained as unexplained intermittent observations, not relabeled or causally fixed |

The first block recorded HEAD/branch, the 952-file source/policy manifest and exact native results before completing T001-T002, without source changes. T003 recorded a fresh 952-file baseline and preserved 951 files while changing only bounded failure diagnostics and a duplicate task read in `runner/run-task.test.ts`; production code, assertions and limits are intact. Later blocks require their own source bindings/results. If T004 reveals a necessary public/persisted/runtime contract change, define its prospective scope/spec before implementation; investigation grants no capabilities.

## Proposed bounded checks

Start from these existing files, narrowing by stable test names when appropriate rather than running unrelated campaigns:

```text
pnpm exec vitest run dashboard/src/server/context-service.test.ts dashboard/src/server/issue-service.test.ts --silent=passed-only
pnpm exec vitest run runner/task-orchestrator.test.ts --silent=passed-only
pnpm exec vitest run lib/state/store.test.ts lib/state/events.test.ts --silent=passed-only
```

The unchanged complete runner/workflow and protocol results already accepted above must be bound to current source before reuse. Repeat affected cases after new changes, not entire expensive suites without a reason. Extend real API/browser assertions if a new observable flow or gap needs coverage; preserve the existing full local smoke and all its refusal assertions. These commands are proposed, not executed by this plan.

Keep 900 seconds per command, foreground installed executables, owned TEMP/TMP and existing capture bounds. Record native exit and both stream EOFs, exact pass/skip/filter counts, artifacts and cleanup separately. An unknown capture is not a pass. Under the owner's standing autonomy instruction, preserve failures, diagnose, correct and revalidate necessary defects without an approval cycle per iteration; failed prerequisites stop dependent steps. No assertion/guard/timeout weakening, global-suite/CI/eval campaign, process cleanup outside ownership, installation, model call, commit, push or merge is included.

## Delivery and reversal

### T005 bounded compatibility diagnosis and final consolidation

The owner authorized T005 on 2026-11-02 under the standing correction/test autonomy and unchanged guard/timeout/no-publication boundary. Preserve T004's two failed full-smoke receipts; their deleted fixtures do not identify the requests retrospectively. First add error-bound, closed metadata to the smoke's existing Node API observations (method, normalized route, response/body phase and existing timeout), preserving the original thrown value and behavior. Targets initially are `scripts/playwright-local-app-smoke.ts`, its existing `scripts/harness-validators.test.ts`, and the three F4 status/evidence documents. Test privacy, identity, body and response failures and diagnostic failure isolation; then typecheck before one diagnostic full smoke. Do not change assertions, budgets, HTTP/poll/test/command timeouts or execution guards.

Use the actual failing operation to choose the smallest correction and revalidate its affected cases before acceptance; do not repeatedly seek a passing sample without new evidence. Rebind prior case receipts to current source, consolidate N01-N12 with command/coverage/limits, and require the real complete API/Chromium campaign and owned cleanup before complete F4 acceptance. The history-only selection remains scoped N12 evidence. Global suite/CI/eval debt, actual F3 delivery, later F5 and paid runtime remain outside this authorization. Add no capability, runtime, store or sibling mutation. Necessary single-concern test/performance corrections may proceed under the owner's standing authorization; a genuinely new product contract still requires prospective design.

Observed result: the six diagnostic regressions passed before typecheck and one complete diagnostic campaign. That campaign passed without reproducing either timeout, preserving every assertion, guard and deadline; no speculative runtime/fixture performance correction was made. Fresh schemas/build/secrets and source/document checks close this bounded acceptance. The original timed-out requests remain unknown; error-only diagnostics qualify a future recurrence, not the removed historical fixtures. The next product gate is renewed real F3 readiness/authority and actual plan/candidate review before F5; no later phase starts automatically.

### T004 prospective observation scope

The owner authorized T004 and necessary corrections without permission per iteration on 2026-11-02. Inspection found that task detail labels its separately appended history "Lifecycle completo" without evidence of completeness. Limit the correction to that existing presentation: identify the authoritative saved snapshot, expose the greatest observed event revision and explain unknown completeness, absent history, snapshot-ahead, event-ahead and legacy observations. Matching or sparse/repeated revisions never prove completeness; snapshot-only updates and separately appended same-revision events are legitimate. This is one existing observability concern, not a new entity or a public/persisted/runtime contract delta; do not add a spec approval inferred from test success.

Targets are `dashboard/src/ui/views/TaskDetailView.tsx` and its tests, `lib/state/store.test.ts`, `lib/state/events.test.ts`, `dashboard/src/server/index.test.ts`, the existing `scripts/playwright-local-app-smoke.ts`, and the three F4 evidence/status documents. Keep all original assertions, guards and timeouts. Extend the synthetic append-refusal fixture for absent/partial history and fresh reads; test damaged/sparse/repeated JSONL without repair; reinstantiate the API over retained snapshots; add a terminal, read-only synthetic task with partial history to the existing real API/browser restart campaign. The browser must show the retained facts and uncertainty before/after reload, with byte preservation and no extra executor turn.

Run the existing state/event/observability/detail baseline, affected focused tests, selected task-detail API cases, schemas/typecheck/build/secrets and the actual isolated local-app smoke. Use the installed tools, owned TEMP/TMP, foreground native capture and 900 seconds per command. No global suite, CI, evals, paid call or normal-state mutation. A malformed event log continues to refuse detail/event reads; the independently validated task GET stays readable. Do not synthesize a valid prefix, repair/backfill history or claim atomic snapshot/event consistency. At the T004 checkpoint, T005 remained separately pending; its later complete result is recorded above.

Two complete compatibility attempts failed before the new case, at different existing scope/workflow network observations, with owned cleanup. Preserve both; no causal fix is established. The bounded follow-up adds only granular scope-stage labels and `--history-restart-only` to the same smoke harness. This selection reuses the same fixture/assertions and real API/browser lifecycle without dispatching any role; the default full campaign, original assertions and all deadlines remain intact. Its observed PASS qualifies only T004/N12. It cannot close T005/F4, substitute for 31-turn compatibility acceptance or waive global debt. Do not repeat the full campaign merely to seek a passing sample; T005 must first investigate the remaining observations.

The final F4 record must identify each case's mechanism, command, source version, result, evidence and limitations. Distinguish stored facts, current observations and unavailable information. Critical unproved controls block F4 acceptance; an accepted synthetic F4 cannot substitute for the real F3 delivery or human acceptance in F5.

T003 changes only `runner/run-task.test.ts`, this plan, its acceptance record and active-roadmap status. Reversal must undo only the recorded T003 test delta and corresponding documentary edits after confirming ownership; preserve all pre-existing changes, original assertions/timeouts and historical results. No manual technical repetition is requested. Real human plan/candidate acceptance remains a distinct product gate.

T004 reversal is limited to its recorded-history UI section, added/extended tests, history smoke fixture/selection and scope-stage labels, plus the corresponding documentary status. Preserve all earlier changes and historical receipts, including both full-smoke failures. No stored data or format rollback is required because T004 changes neither. Do not remove unrelated user work to reset the large dirty checkout.
