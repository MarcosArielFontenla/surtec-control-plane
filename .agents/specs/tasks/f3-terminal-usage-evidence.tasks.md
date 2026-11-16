---
spec: .agents/specs/terminal-usage-evidence.spec.yaml
feature: f3-terminal-usage-evidence
status: done
createdAt: "2026-10-31"
reviewedBy: repository-owner
approvedAt: "2026-10-31T19:31:50Z"
---

# F3 terminal usage evidence — prospective ordered delta

Status: scoped technical acceptance complete on 2026-11-02. T001-T004 are done under the owner's approved continuation. The [design](../../../docs/proposals/factory-local-f3-terminal-evidence-design.md) and [specification](../terminal-usage-evidence.spec.yaml) retain the exact evidence boundary; the real F3 pilot and its human gates are separate and incomplete. Earlier failures below remain historical evidence. The historical Phase O specification and completed tasks remain unchanged.

2026-10-31 approval: the owner explicitly approved the original design/spec/T001-T004 and 15 paths. The review timestamp records that acknowledgement. The 2026-11-02 standing authorization subsequently allowed necessary acceptance corrections and status reconciliation without permission per iteration. No changed limits, model call or publication is authorized. Earlier proposal and stop entries below retain their contemporaneous meaning.

Approval must cover the explicit operational completeness basis, 15 target files, ordered tasks and bounded functional acceptance. Provider billing finality is not available from this contract. Keep review fields null until actual review; structural validity grants no runtime authority.

## Phase 1 — closed receipt contract

<!-- maps to: ac-types,ac-secrets -->
- [x] T001 Define the immutable internal receipt, execution identity and strict validator with positive and adversarial fixtures alongside the contract -> runner/terminal-usage-evidence.ts, runner/terminal-usage-evidence.test.ts, runner/agent-executor.ts

T001 has no predecessor. Verify its complete receipt test file before T002. Cover missing/altered fields, prototype/accessors, unsafe counters, projection/order, digest and task/run/context/thread/turn mismatches. No process/model call is part of the pure receipt tests.

## Phase 2 — producer observations and native transport fence

<!-- maps to: ac-types,ac-secrets -->
- [x] T002 (depends: T001) Implement fresh-turn ordered proof and graceful native EOF drainage with irreversible uncertainty; test the real executor through a fixed Node-only producer and preserve every existing cumulative and approval guard on the exact T002 runtime targets listed in the product design -> docs/proposals/factory-local-f3-terminal-evidence-design.md

Run the full design command `terminal-protocol`. Assert that the producer is the synthetic Node fixture and that fixed scenarios cannot execute supplied shell text. Qualify exit-before-EOF and final-frame order; reject missing EOF, unsuccessful exit, pending handlers/items, late activity, abort and forced kill. Missing `final_answer` or unsupported usage ordering remains unknown. Keep the existing 1000 ms abort fallback and all other deadlines. The current unconditional terminal unknown event becomes a deferred decision only when a valid terminal candidate exists; prior invalid-usage uncertainty cannot be cleared.

## Phase 3 — fenced accounting consumption

<!-- maps to: ac-schemas,ac-types -->
- [x] T003 (depends: T002) Charge observations before validating exact terminal evidence, retain current lease/context fencing and optional owned metadata, and prove exact Planner gates plus restart/no-replay behavior through the real executor over the synthetic producer -> runner/run-task.ts, runner/run-task.test.ts, runner/workflow-orchestrator.test.ts

Run the complete `terminal-consumer` command. Both read-only and writer paths require accepted evidence before downstream output/commit/verification effects when production claims completeness. Explicit true without a receipt, a model-output lookalike, wrong/stale binding, invalid usage and exhausted caps cannot start a successor. Preserve trusted historical injected-fake omission compatibility without a new production bypass. No schema, aggregate, controller policy or normal-state migration target is included. No private historical state is modified or refunded.

## Phase 4 — scoped acceptance and documented readiness

<!-- maps to: ac-schemas,ac-types,ac-build,ac-secrets -->
- [x] T004 (depends: T003) Execute the complete bounded acceptance sequence and record actual outcomes and limitations, including owner-authorized safe browser diagnostics/corrections and status reconciliation, preserving the historical pilot and stopping before any real invocation -> docs/architecture/execution-runtime.md, docs/proposals/factory-local-f3-accounting-recovery.md, docs/proposals/factory-local-f3-terminal-evidence-design.md, .agents/specs/terminal-usage-evidence.spec.yaml, .agents/specs/tasks/f3-terminal-usage-evidence.tasks.md, scripts/playwright-local-app-smoke.ts, scripts/harness-validators.test.ts, docs/proposals/factory-local-f3-design.md, docs/roadmap/factory-local-poc.md

## Mandatory scoped done gate

After actual human approval and implementation, execute the following in order, with foreground owned TEMP/TMP, existing output capture and 900 seconds per command. Failed or unknown checks stop dependent steps. Under the owner's 2026-11-02 standing authorization, diagnose/correct/revalidate necessary acceptance defects without requesting permission per iteration, retaining all failure evidence. Preserve existing per-test, poll, task and capture limits and observe native exit plus both stream EOFs; no profiling/supervisor expansion or automatic product/runtime retry.

1. Run the exact `terminal-protocol` command recorded under the [product acceptance plan](../../../docs/proposals/factory-local-f3-terminal-evidence-design.md).
2. `pnpm exec vitest run runner/run-task.test.ts runner/workflow-orchestrator.test.ts --silent=passed-only`
3. `pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/terminal-usage-evidence.spec.yaml -TimeoutSeconds 900`
4. `pnpm smoke:local:playwright`

Steps 1, 2 and 4 are mandatory complementary behavior checks, not added Harness-catalog entries. Step 3 executes exactly the four existing-catalog commands in the prospective spec. Passing step 3 or documentary structure alone cannot complete any behavior criterion. Run complete selected test files, do not replace them with a passing name filter. At the final gate record fresh results; earlier slice results remain historical rather than silently reused as a full final run.

Report counts/native statuses, proof matrix, attempts/effect counters, exact human-plan stop, persisted/reloaded accounting, owned child/stream and isolated-browser cleanup. State clearly that the native Node producer is synthetic, the browser campaign uses fake turns, and no installed producer has been qualified by these checks.

No global test/CI/eval campaign, real product-runtime call, private state mutation, sibling write, install/download, commit or publication is included. DEBT-F2-GLOBAL-900 and historical P/Q/CI outcomes stay open. This bounded acceptance is part of the proposed human review, not an inferred waiver of another phase's checks. Missing or failed scoped checks leave this delta incomplete.

Stop after T004. A new Planner invocation requires separate execution authority and renewed source/baseline/context/budget/writer-window evidence; it cannot silently reset/refund the historical failure. F3 remains incomplete until its real role/verification/human acceptance criteria pass. No manual technical repetition is required for the proposed synthetic checks; the next human action is review of this exact design/spec/tasks.

## Execution checkpoint — 2026-10-31

T001's complete receipt file passed 33 tests, native exit 0 and both EOFs, in 1768 ms. After T002 implementation, the complete terminal-protocol command finished with 255 passed and one failed across three files; native exit 1 and both EOFs were observed in 2193 ms, without timeout, capture truncation or stream/spawn error. All seven executor/environment tests passed, including the real executor over the native Node-only producer. This is synthetic evidence, not a real runtime qualification.

The failure is `fresh operational terminal proof > rejects incomplete or contradictory pre-terminal activity 2`, at line 117 of the protocol client test identified in the [product checkpoint](../../../docs/proposals/factory-local-f3-terminal-evidence-design.md#execution-checkpoint---2026-10-31): expected false but received true for `usageComplete`. That newly written negative fixture changes only `last.totalTokens` to 1 while `total.totalTokens` remains 18. It does not violate the approved field-wise `last <= total` rule or cumulative monotonicity; the cumulative vector duplicates the prior valid observation. The test therefore does not represent the invalid snapshot it intended to construct. No additional provider counter arithmetic may be invented to make it invalid.

The minimal proposed correction is test-only: make that last-response counter exceed its cumulative counterpart while retaining the false-completeness and retained-high-water assertions. It has not been applied. Under the owner's first-failure stop instruction, no correction, rerun, T003 implementation, typecheck, schema/build acceptance, browser smoke, global suite, CI, eval or paid runtime call followed. T002 is not accepted; T003/T004 remain unstarted. All limits and historical records are retained. No commit, push or merge occurred.

## Approved fixture correction and T003 checkpoint — 2026-10-31

The owner approved the suggested correction and continuation. Only the invalid negative fixture's last-response counter changed to exceed its cumulative counterpart, retaining the same assertions. The complete protocol block passed 256 tests with native exit 0 and both EOFs. After implementation of T003 and two additional approved-scope late-identity regressions, the fresh acceptance protocol block passed 258 tests (218 client, seven executor/environment, 33 receipt cases), in 1891 ms with native exit 0, both EOFs and no truncation/timeout/stream error. T001/T002 are accepted synthetic slices, not live producer qualification.

T003 implemented exact runner-supplied task/run identity, charge-before-validation, strict explicit-positive receipt validation, current ownership, optional normalized metadata, writer/read-only gates, stale evidence removal and consumer/controller regressions. Existing positive test executors now construct actual bound synthetic receipts where needed; omission compatibility remains unchanged. All 15 planned paths have implementation or documentation changes, but T003 and T004 are not complete.

The complete consumer command exited 1 after 761270 ms, below 900000 ms. Root exit and both EOFs were observed without forced termination, timeout or spawn/stream error. Its retained file summary identifies 96 run-task tests with one failure. Its stdout exceeded the unchanged 65536-byte capture bound because existing correction-progress traces filled the stream; the full workflow-file summary is not retained and no total whole-command passing count is claimed. Stderr is retained, including the exact single reported failure.

The failure at `runner/run-task.test.ts:532`, `fences a tightened current runtime before any post-model effect`, expected outcome `failed` but received `needs-review`. This old test still returns an explicit positive usage flag without terminal evidence, so the new evidence guard rejects it before the intended later runtime check. Proposed correction: supply the existing exact-bound synthetic receipt helper in that one fake, preserving every runtime, ledger and no-effect assertion. Do not change production guards to accept a flag alone.

Separately proposed acceptance-command amendment: add `--silent=passed-only` only to the consumer command so passing tests' existing console traces do not exhaust the capture; preserve failed-test logs, reporters, complete file selection, assertions, limits and native evidence. The installed Vitest CLI explicitly supports this value. Neither proposal has been applied or executed. Stop at this first failed/unknown command; no typecheck, guarded catalog acceptance, browser smoke, global test/CI/eval campaign, real model invocation or publication followed. The existing failed and truncated capture is retained, not counted as acceptance.

## Approved continuation — runtime fake and bounded console output

The owner subsequently approved both proposed adjustments in this conversation. Update only the runtime fake to return its exact-bound synthetic receipt, preserving every assertion and production guard. The consumer command above now adds only `--silent=passed-only`; failing-test logs, reporters, complete files, 900 seconds and 65536 bytes per stream remain unchanged. Run the affected regression first, then resume the stopped acceptance; stop on the first failed or unknown result. This approval grants no paid call or publication and does not erase either prior failure.

## Focused runtime recheck — stopped

Applied exactly the approved fake correction and consumer console amendment. The one-case command was `pnpm exec vitest run runner/run-task.test.ts -t "fences a tightened current runtime before any post-model effect" --silent=passed-only`, using installed Node, owned TEMP/TMP, the existing native capture helper and 900000 ms. It finished in 7184 ms with native exit 1 and both EOFs; no timeout, truncation, spawn/stream error or forced termination. One test failed; 95 were deliberately unselected, not passed.

The same assertion at line 532 still expected outcome `failed` and received `needs-review`, now with `attestedRun(input)` supplying the exact-bound synthetic receipt. The earlier missing-receipt diagnosis was incomplete. The captured diff omits the completion reason and durable last_failure details, so the exact remaining terminal path is not established by this evidence. Do not infer a passing receipt-to-runtime transition, change the expected outcome or loosen any guard to force a pass.

Stopped immediately after this focused failure. The complete consumer block with the approved console amendment has NOT RUN; its non-truncating full-file behavior therefore remains unproven. No guarded catalog, typecheck/build/schema/secret acceptance, browser smoke, full suite, CI, eval, real model call or publication followed. Proposed next step, not implemented or executed: expose the normalized completion reason and last_failure for this exact test, preserve all assertions/limits, then run only that case to identify the actual stop before choosing a correction. T003/T004 stay incomplete.

## Authorized terminal-reason capture — stopped on the focused failure

The owner explicitly authorized capturing only `completion.reason` and `last_failure` and running this one case with unchanged assertions and limits. Added the bounded `TERMINAL_RUNTIME_DIAGNOSTIC` log in that test; no production code changed. The same focused command finished with one failure and 95 unselected cases in 5604 ms. Native exit 1 and both EOFs were observed without timeout, truncation, spawn/stream error or forced termination.

Captured `completion.reason`: `Budget settlement is unknown; inspect retained task and ledger facts`. Captured `last_failure.kind`: `terminal`; its message is the same. The final recorded needs-review reason is budget settlement uncertainty; the specific cause inside settlement has not been captured or established. The test still expects failed/budget exhaustion, and those assertions remain unchanged.

Stopped after this result. No corrective implementation, further test, long consumer block, gate/typecheck/schema/build/secret check, browser smoke, real model call, commit or push followed. T003/T004 remain incomplete. A follow-up must inspect the settlement path and retained diagnostic evidence before proposing a correction; this capture grants no authority to change guards, accounting or expected results.

## Approved accounting-order correction — 2026-11-01

The owner requested the diagnosed correction after the read-only trace. The runner now distinguishes a result received before interruption from exhaustion first observed while recording its final debit. Only an exact closed receipt under current lease/context, known independent budget exhaustion and no external/durable cancellation or accounting uncertainty can preserve final accounting. The original budget abort is then thrown before output, commit, verification or successor effects. No cap condition, threshold, timer, adapter protocol or ledger invariant changed; unknown historical accounting is never reopened.

The unchanged original runtime regression passed: one selected case, 102 unselected, native exit 0 and both EOFs in 10018 ms, with no timeout/truncation/stream error. Its original failed/budget/runtime-1000ms, retained-runtime and no-commit/verification assertions remain intact.

Added seven focused regressions: known accounting plus budget failure for runtime/tokens, and unknown retained holds for missing/mismatched receipts, pre-result budget interruption, external interruption and invalid usage observations. Their selected run finished in 16685 ms with six passed, one failed and 96 unselected; native exit 1, both EOFs and complete capture. No timeout, forced termination or spawn/stream error occurred.

The failure is the new tokens case's message assertion at line 553. Outcome failed and failure kind budget were observed, but expected `token budget exhausted (5)` differs from existing `token budget exhausted (100000)`. The current formatter uses the initial task ceiling, while this fixture tightens the effective ceiling to 5 during the turn. The assertions after that message check, including this case's terminal ledger assertions, did not execute and are not claimed as passed. The runtime variant and all five negative variants passed.

Stopped at that failure. Proposed test-only follow-up: compare the message with the recorded initial ceiling and assert separately that the effective task limit remains 5, without changing runtime formatting, guards or any limits. Not applied or rerun. No typecheck, long consumer repetition, catalog/build/schema/secret acceptance, browser smoke, global suite/CI/eval, model call, commit or publication followed. T003/T004 remain incomplete.

## Approved test expectation correction — 2026-11-02

The owner approved the suggested follow-up. Only the new positive accounting test changed: capture the initial token ceiling for the existing message, then separately assert the current ceiling remains 5 for tokens or 1000 ms for runtime. Preserve every prior outcome, retained-usage, terminal-ledger, settled-reservation and no-effect assertion. No production formatter, cap, guard or timeout changed.

The focused command selected `terminal receipt accounting|fences a tightened current runtime before any post-model effect` in `runner/run-task.test.ts`, with `--silent=passed-only`: eight passed, 95 deliberately unselected. Native exit 0 and both EOFs were observed in 20840 ms. Then `tsc --noEmit` (the `pnpm typecheck` script body) passed with native exit 0 and both EOFs in 16541 ms. Both foreground commands used installed Node, owned TEMP/TMP, 900000 ms and the unchanged capture bounds, with no timeout, truncation, process/stream error or forced termination.

This closes the focused assertion correction only. The complete consumer command, guarded schema/build/secret acceptance and isolated browser smoke have not been repeated; T003/T004 remain incomplete. No global suite, CI, eval, real model call, historical-state repair, sibling change, commit, push or merge occurred. Earlier failures remain historical evidence.

## Authorized consumer continuation — capture unknown, 2026-11-02

The owner authorized the complete consumer block, then catalog gate and browser smoke, stopping at the first failed or unknown result. Ran exactly `pnpm exec vitest run runner/run-task.test.ts runner/workflow-orchestrator.test.ts --silent=passed-only` through installed Node and the reviewed foreground capture with owned TEMP/TMP, 900000 ms and 65536 bytes per stream.

Vitest exited 0 in 707128 ms, and root exit plus both EOFs were observed. No timeout, spawn/stream error or forced termination occurred. The retained stdout explicitly reports all 103 run-task tests passed. However, stdout exceeded the unchanged capture bound: 65391 bytes were retained, including 213 correction-progress lines; stderr retained 306 bytes of synthetic Git line-ending warnings. The workflow-file and overall final summaries are absent, so no exact total passing count or complete consumer acceptance is claimed. Capture outcome is unknown despite native exit 0.

Read-only inspection located the bypass at the correction case's sink in `runner/workflow-orchestrator.test.ts`: it writes `T008_CORRECTION_PROGRESS` directly with `process.stdout.write`, so the approved Vitest console-suppression flag does not silence it. The last retained marker is qa-true sequence 33, planning/executor return; this is not a terminal case result. The qa-false trace is retained through its seal at sequence 180. No source correction was applied.

Stopped before catalog gate and browser smoke. Proposed follow-up is a test-output-only correction making these diagnostic traces respect Vitest's passing-console suppression while preserving failed-test visibility, diagnostic behavior, complete file selection and every capture/runtime/assertion limit. It requires review before implementation or another run. T003/T004 and F3 stay incomplete; no global suite, CI, eval, real model call, sibling change, commit, push or merge followed.

## Approved diagnostic sink correction — 2026-11-02

The owner approved the proposed adjustment. Changed only the correction case's sink in `runner/workflow-orchestrator.test.ts` from direct `process.stdout.write` to `console.log`. Vitest can now intercept the same JSON progress frames. The emitter, case binding, ordering, assertions, runtime and capture limits remain unchanged; no production source changed.

Three isolated synthetic checks used the actual extracted sink and an identical copy of the public progress emitter, without loading the workflow fixture: normal passing output retains the begin/seal frames (2521 ms); passing output with `--silent=passed-only` hides them (911 ms); an intentionally failing synthetic test with that flag retains both frames and its explicit failure marker (948 ms). All three checks passed with expected native exits 0/0/1, both EOFs and complete captures. The third exit 1 was the required negative-fixture result, not an unexpected failure. Payload version, variant, case identity and frame order were checked.

Then `tsc --noEmit` passed with native exit 0 and both EOFs in 19843 ms. All four foreground captures used installed Node, owned TEMP/TMP, 900000 ms and unchanged stream bounds, without timeout, spawn/stream error, truncation or forced termination. Verification artifacts remain in their owned temporary root; no cleanup of unrelated resources occurred.

The complete consumer command has not been repeated after this sink correction. Catalog gate and browser smoke remain unrun, and T003/T004 and F3 are incomplete. The next acceptance step is the complete two-file consumer command, followed by catalog checks and the browser smoke only if each predecessor passes. No whole-suite, CI, eval, model call, historical-state mutation, sibling write, commit, push or merge occurred.

## Authorized acceptance continuation — stopped at browser failure, 2026-11-02

The owner explicitly authorized one complete consumer repetition, then gate and browser smoke, each with 900000 ms and the first-failure/unknown stop. No assertions, guards or timeouts changed. All three foreground commands used the existing reviewed capture, installed executables and owned TEMP/TMP. Every native root exit and both EOFs were observed; no command timed out, truncated capture, reported process/stream errors or required forced termination.

1. `pnpm exec vitest run runner/run-task.test.ts runner/workflow-orchestrator.test.ts --silent=passed-only`: PASS, native exit 0 in 762515 ms. Both complete files passed: 103 run-task and 81 workflow tests, 184 total. Retained stdout is 23830 bytes, stderr 306 bytes; the sink correction kept the complete final summaries within the unchanged bounds. Both native synthetic Planner success/late-usage cases passed, including exact human gates and retained accounting across restart. T003 is now complete.
2. `pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/terminal-usage-evidence.spec.yaml -TimeoutSeconds 900`: PASS, native exit 0 in 31119 ms. Exactly ac-schemas, ac-types, ac-build and ac-secrets each exited 0.
3. `pnpm smoke:local:playwright`: FAIL, native exit 1 in 87459 ms, with complete captured output. The actual API/Vite/Chromium campaign stopped at `T013 operations-investigation: real dashboard preview/root gate`. Exact error: `Browser API read failed before effect capture`, from the request-failure handler at `scripts/playwright-local-app-smoke.ts:148`. The error omits the failed endpoint/transport cause; neither is inferred. Retained synthetic facts show the analysis workflow completed and the operations workflow waiting-human with accounting complete. These partial observations are not full browser acceptance.

The smoke reported zero browser-read cancellations and complete owned cleanup: browser_closed, vite_closed, api_stopped and workspace_removed all true, failures empty. No manual cleanup is required. All four retained historical state/event file hashes still match their checkpoint. No private historical repair or sibling mutation occurred.

Stopped at this browser failure without correction, repeat or subsequent executable check. T004 and F3 remain incomplete; prior protocol acceptance remains a separately retained 258-case result, not rerun in this continuation. Proposed next diagnostic is limited to identifying the failed browser API read from available evidence before proposing any change or browser repetition. No repeat of the passing consumer/gate is proposed. Whole-suite/CI/eval debt remains open; no model call, install/download, commit, push or merge occurred.

## Autonomous technical closure — 2026-11-02

After the read-only diagnosis established that the transport handler discarded the failed route/code, the owner authorized all necessary corrections and checks without permission per iteration. This superseded the prior per-failure permission stop for technical acceptance only. Scope added the smoke, its existing tests and status-only real-pilot/roadmap reconciliation; runtime policy, paid-call consent, historical state and publication restrictions remain unchanged.

The smoke now keeps an immutable error-bound transport observation separate from the original failure: normalized allowlisted GET path, request sequence/age, active/owned navigation flags and allowlisted transport code. It records neither raw URLs/query/IDs nor arbitrary error text. Getter failures cannot replace the original error, deadline receipts cannot stand in for transport failures, and prior failure/cancellation checks remain. Existing assertions, deadlines and capture bounds are unchanged.

Final observed evidence:

| Check | Result | Native/stream facts |
| --- | --- | --- |
| Browser read synchronization/diagnostics/activity selection in `scripts/harness-validators.test.ts` | 33 PASS, 91 deliberately unselected; 2601 ms | Exit 0, both EOFs, complete capture |
| `pnpm typecheck` script body (`tsc --noEmit`) after diagnostics | PASS, 22681 ms | Exit 0, both EOFs, complete capture |
| Complete local-app API/Chromium smoke | PASS, 737494 ms; all five templates and exactly 31 synthetic turns | Exit 0, both EOFs, complete capture |
| Complete three-file terminal-protocol command, refreshed at closure | 258 PASS, 2117 ms | Exit 0, both EOFs, complete capture |
| Final guarded spec gate | Four PASS: schemas, typecheck, build, secrets; 32257 ms | Exit 0, both EOFs, complete capture |
| Complete two-file terminal-consumer command retained from the same continuation | 184 PASS (103 + 81), 762515 ms | Exit 0, both EOFs, complete capture; no consumer/runtime source changed afterward |

All commands used installed executables, foreground owned TEMP/TMP, 900000 ms and unchanged per-stream capture limits. No timeout, forced termination, truncation or process/stream error occurred. The browser proved exact Planner/risk/criteria gates, scoped candidate review, bounded correction/second-correction refusal, cancellation, reload/restart/no replay and session rotation. All prior organization/Harness/context/issue flows remained covered. Browser-read cancellations were zero. Browser, Vite, API and temporary workspace cleanup all succeeded with no failures; retained parent verification artifacts remain test-owned. The four historical state/event hashes still match their checkpoint.

The earlier transport failure did not recur. Its original endpoint/cause remain unknown, rather than falsely attributed or declared fixed; future occurrences now have a private-safe diagnostic path. Earlier failed/unknown captures are preserved. No manual repetition is required for the completed synthetic technical criteria.

T001-T004 of this terminal-evidence delta are complete. This is not closure of the separate real F3 pilot's T003-T008, a live producer qualification or a global/CI-debt waiver. The old real attempt remains needs-decision, its undercount is not repaired/refunded, the private runtime is frozen and the former writer window expired. No real model call, new pilot workflow, sibling write, install/download, commit, push or merge occurred. Any next real execution must bind fresh authority/context/budget and retain actual human plan and candidate acceptance gates.

Final record checks passed: the unchanged native tasks validator accepted this done document and its referenced spec in 1136 ms, executing zero acceptance commands; the secret scanner/self-test passed in 1056 ms across 1248 repository files. Both had native exit 0, both EOFs and complete capture. Targeted whitespace checks passed. These document checks supplement the executable acceptance above and do not grant live execution authority.
