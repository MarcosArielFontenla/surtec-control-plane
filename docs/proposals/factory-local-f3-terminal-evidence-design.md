# Factory Local F3 — terminal usage evidence

Status: scoped technical acceptance COMPLETE on 2026-11-02; T001-T004 are done. Evidence comprises 258 protocol cases, 184 complete consumer cases, 33 focused browser-read regressions, all four catalog checks and the full isolated API/Chromium smoke with 31 synthetic turns and complete owned cleanup. The owner authorized necessary acceptance corrections and status reconciliation. The real F3 pilot, its historical attempt, live producer qualification and exact human gates remain separate and incomplete. No new model invocation is authorized. Earlier checkpoints below are historical. See the [specification](../../.agents/specs/terminal-usage-evidence.spec.yaml) and [ordered tasks](../../.agents/specs/tasks/f3-terminal-usage-evidence.tasks.md).

## Problem and evidence

The [accounting correction](factory-local-f3-accounting-recovery.md) now attributes cumulative observations instead of the last response. Its adapter/executor checks passed 195 cases, four selected controller guards passed, and typecheck passed. These are retained baseline results, not fresh results for this proposal.

The stable generated [usage notification](../../runner/generated/codex-app-server/v2/ThreadTokenUsageUpdatedNotification.ts) binds separate `last` and `total` vectors to a thread/turn. The [terminal notification](../../runner/generated/codex-app-server/v2/TurnCompletedNotification.ts) has no final-usage field. The [message phase](../../runner/generated/codex-app-server/MessagePhase.ts) is `final_answer`, `commentary`, or unknown when absent; its generated comment explicitly warns that providers do not consistently emit it. No provider final-billing marker has been discovered.

The [client](../../runner/codex-app-server.ts) consequently returns `usageComplete: false` for every real turn. It also closes its line reader and kills App Server immediately in `finally`; it cannot currently attest to an unforced, completely drained transport. The [runner](../../runner/run-task.ts) correctly prevents a governed successor when accounting is unknown. A normal `turn/completed` alone cannot resolve this boundary.

The historical failed attempt remains stopped. Its separately diagnosed cumulative observation was 143738 tokens, above both its 40000-token Planner cap and 100000-token root cap; the stored historical charge is an identified undercount, not an admitted repair. A later evidence implementation cannot make that attempt successful or refund its consumption.

## Proposed decision

Introduce a narrowly defined **operational terminal usage receipt** from the trusted adapter. It attests that the exact fresh turn's coherent reported cumulative usage was observed before its terminal event, and the dedicated App Server then ended normally with its complete transport drained. It does not attest to provider billing finality, hidden provider activity, or a zero-cost interruption.

This explicitly changes the evidence basis for a positive `usage_complete` decision. It is a prospective contract amendment requiring human review, rather than an implementation detail or a claim that the protocol already provides a final-usage marker. If the owner requires provider-final accounting instead of this operational basis, the current stable protocol is insufficient and this proposal must not be implemented as a substitute.

Only a fresh `thread/start` and its first turn can qualify. Resumed threads retain their existing lower-bound accounting and unknown completeness. There is no rollout-file parser, session-log import, experimental protocol option, second execution runtime, quiet-period heuristic or new public request flag.

## Positive proof: every condition is necessary

1. Before the model call, the runner provides its internal current task/run identity and existing exact context-contract fingerprint. These values are never accepted from role output or a public request, and are not sent as new protocol fields.
2. The adapter creates a fresh thread with the known zero baseline, then binds every qualifying notification to the exact returned thread and turn. There is one adapter/process instance per invocation.
3. Relevant `last` and `total` snapshots contain all six finite, safe, non-negative integer counters. Preserve the implemented field-wise `last <= total`, baseline subtraction, cumulative monotonicity and high-water rules. Do not invent additional provider counter arithmetic or subtract cached input from charged total tokens. A relevant invalid/regressing snapshot irreversibly taints the attempt.
4. Observe a completed assistant item with the explicit producer phase `final_answer`. Every observed started item must have a matching completion, and every server-request handler must have settled. Track item identities/types/status only; never copy reasoning text. Unknown/missing phase does not qualify, even if the final text parses as JSON.
5. Observe a valid cumulative usage snapshot after that final assistant item and after all other observed item activity, then an exact `turn/completed` with status `completed` and no error. Local parsed sequence numbers establish this ordering. A duplicate unchanged usage sample before the terminal event is harmless; new item activity needs a new qualifying final item/usage sequence. Unsupported ordering stays unknown; the adapter does not reorder producer events.
6. After processing that terminal notification, finish stdin normally, retain the stdout parser and stderr reader, and observe native root exit code 0 with no signal plus actual stdout and stderr EOF. Stream `close`, a quiet interval, stdin completion or root exit alone is insufficient. The final readline frame, serialized notification queue and in-flight server-request handlers must all finish before adjudication.
7. No relevant item, usage, approval request, contradictory terminal event, protocol error or unexpected thread/turn activity occurs after the terminal fence. A late usage sample still charges its proven high-water before completeness is rejected. Identical duplicate terminal notifications are idempotent; contradictory duplicates taint.
8. The existing AbortSignal, live task/run/lease and context remain current through producer drainage. No cancellation, cap exhaustion, forced termination, stream error or lost ownership occurred while the producer was active. Under the owner-approved 2026-11-01 correction, independent budget exhaustion first recognized by the consumer while charging an already returned closed receipt may retain proven accounting only; it must still produce the budget failure and deny every further execution effect. Prior/external interruption, durable cancellation and unknown accounting do not qualify.

Success is the conjunction of these facts, not the presence of one terminal flag. The strict ordering and explicit phase are qualification conditions, not asserted guarantees of the installed producer. Native fake tests can prove the implementation; only a separately authorized live invocation can establish whether the installed producer emits a qualifying successful transcript. If it does not, stop with unknown evidence and do not weaken the conditions or retry automatically.

## Lifecycle and negative behavior

Use a small in-memory progression: observing -> terminal candidate -> draining -> attested or unknown. Taint is irreversible. Do not emit the current unconditional `final-usage-unproven` at a valid terminal candidate and later erase it; defer that particular adjudication until drain succeeds or fails. Invalid-usage events still taint immediately. Emit unknown exactly when proof fails, retaining existing observations and stop behavior.

Keep cancellation registered until the final decision. Drain consumes the existing task's active runtime and remaining deadline; it receives no new timeout or budget. Preserve the existing 1000 ms interruption-to-force-kill fallback. If the producer fails to exit or exhaust streams within the current parent deadline, stop as unknown; a forced shutdown never produces a positive receipt. Do not clear parent cancellation while awaiting EOF.

Fatal errors and unsuccessful turns retain bounded owned-process shutdown. A native exit can precede stdout/stderr EOF, so event handling must not finalize on exit alone. Likewise, a stream `close` without `end`, truncated JSONL or a failed event sink is not a successful drain. No broad process enumeration, process-name kill or unrelated cleanup is part of implementation or tests.

## Receipt and consumer boundary

Add a closed immutable internal v1 value object, not a primary stored entity. Its fields are:

| Field group | Required content |
| --- | --- |
| Basis | Version 1; source `codex-app-server-stdio`; basis `fresh-thread-cumulative-drained` |
| Binding | Current task ID, execution/run ID, context-contract SHA-256, exact thread ID and turn ID |
| Usage | Final six-field protocol cumulative vector, normalized five-field `AgentUsage`, and zero fresh baseline |
| Terminal observations | Final item ID/phase, ordered final-item/usage/terminal sequence numbers, status `completed`, native exit 0, null signal, both EOF flags |
| Integrity | SHA-256 over the canonical closed receipt payload excluding the digest itself |

The digest detects a changed binding; it is not a signature or evidence against a malicious same-user writer. The receipt originates outside model output in the trusted process adapter. The validator rejects unknown versions/fields, accessors, inherited data, unsafe numbers, missing facts, inconsistent usage/projection/order or changed binding/digest.

Extend `AgentRunInput` with an optional internal execution identity and `AgentRunResult` with optional terminal evidence. Governed production calls provide the identity. A production result explicitly claiming `usageComplete: true` must carry the valid exact-bound receipt; a flag or model-authored lookalike is insufficient. Preserve the existing injected historical-fake convention where the property is omitted, without adding a production bypass or configurable trust flag. Tests must separately demonstrate that the real `CodexExecutor` never uses that omission path.

In `run-task`, charge valid observations/high-water first, even if receipt acceptance fails. Validate the receipt against the current result, task/run, contract fingerprint, thread/turn and usage, and recheck ownership before consuming it. Store only the accepted normalized receipt as optional `metadata.run.terminal_usage_evidence` through existing owned mutation, alongside the current usage fields. Cover both read-only and writer paths before output admission, commit or verification effects. Existing `workflowUsageComplete` and settlement guards consume the decision; do not change controller budget policy or issue transitions.

Metadata evidence is not admission authority on restart. Existing durable settled accounting remains the recovery fact; missing receipts are not backfilled and stale receipts cannot settle a different run. No aggregate, public schema, version dispatch or migration changes. Retain support for unrelated existing task metadata.

## Target scope: 15 original files plus two acceptance and two status files

| Targets | Intended delta |
| --- | --- |
| `runner/terminal-usage-evidence.ts` (new), `runner/terminal-usage-evidence.test.ts` (new) | Closed receipt types, construction and strict binding/integrity validation; pure positive and adversarial tests |
| `runner/agent-executor.ts` | Additive internal identity/evidence types and operational meaning of completeness |
| `runner/codex-app-server.ts`, `runner/codex-app-server.test.ts` | Fresh-turn proof tracking, irreversible uncertainty, ordered drain and process/stream/abort matrix; preserve existing cumulative tests |
| `fixtures/codex-app-server-terminal.mjs` (new), `runner/codex-executor.test.ts` | Installed Node runs a fixed synthetic stdio producer through the real executor; test native exit/EOF ordering without Codex/model calls |
| `runner/run-task.ts`, `runner/run-task.test.ts` | Bind, charge, validate, persist and settle under current ownership in read-only/writer branches; reject forged/incomplete evidence before downstream effects |
| `runner/workflow-orchestrator.test.ts` | Integration using the actual executor over the synthetic producer: exact Planner gate, retained accounting, restart and denied successor/replay cases |
| `docs/architecture/execution-runtime.md`, `docs/proposals/factory-local-f3-accounting-recovery.md` | Document accepted operational meaning, limitations and observed acceptance results after implementation |
| This document, `.agents/specs/terminal-usage-evidence.spec.yaml`, `.agents/specs/tasks/f3-terminal-usage-evidence.tasks.md` | Prospective design, requirements, ordered scope and honest execution evidence |
| `scripts/playwright-local-app-smoke.ts`, `scripts/harness-validators.test.ts` | Owner-authorized 2026-11-02 continuation: error-bound, private-safe browser-read diagnostics and necessary acceptance corrections/regressions |
| `docs/proposals/factory-local-f3-design.md`, `docs/roadmap/factory-local-poc.md` | Status-only reconciliation of accepted technical evidence versus the still-incomplete real pilot |

No changes to historical Phase O approvals/spec/tasks, Harness validators/catalog/pins, package scripts/dependencies, generated protocol files, API/UI code, normal state, private historical evidence, frozen pilot runtime, verifier or sibling project. The new fixture uses fixed scenarios and Node's executable directly with shell disabled; it cannot delegate to the real runtime, install packages or receive executable scenario text.

## Proposed checks and order after approval

The Harness has an exact command catalog; do not expand it for this delta. The scoped behavioral commands below are mandatory complementary checks, invoked directly with fixed arguments after authorization. Passing catalog checks alone cannot close the delta. This is a proposed bounded functional acceptance, not a claim that the whole-repository regression debt is closed or that historical gates were rerun.

| Order / ID | Command | Expected evidence |
| --- | --- | --- |
| 1 / terminal-protocol | `pnpm exec vitest run runner/terminal-usage-evidence.test.ts runner/codex-app-server.test.ts runner/codex-executor.test.ts` | Complete selected files pass; exact success/failure proof matrix; native fixture exit and both EOFs; no paid calls or leftover owned child |
| 2 / terminal-consumer | `pnpm exec vitest run runner/run-task.test.ts runner/workflow-orchestrator.test.ts --silent=passed-only` | Complete selected files pass, including real-executor/synthetic-producer integration, writer pre-effect rejection, budget/lease/restart/unknown guards and exact human-plan stop; omit console traces from passing tests while retaining reporters and failed-test logs |
| 3 / catalog checks | Guarded spec command below | Schema compatibility, typecheck, build and secret scanner all exit 0; no assertion that these prove behavioral requirements alone |
| 4 / terminal-dashboard-regression | `pnpm smoke:local:playwright` | Existing real API/Vite/browser campaign uses synthetic state and fake turns only; human gates, reload/restart and all owned cleanup pass. It does not qualify native producer usage |

Guarded catalog invocation, only after approval and implementation:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/terminal-usage-evidence.spec.yaml -TimeoutSeconds 900
```

Keep every existing test, poll, task and capture limit. Run in the foreground, with owned TEMP/TMP and 900 seconds per command; use the already reviewed Node/executable resolution and output capture rather than inventing another supervisor. Observe native exit plus both stream EOFs. A failed or unknown result stops dependent checks and is retained as evidence. The owner's 2026-11-02 standing authorization permits necessary diagnosis, correction and revalidation without another permission cycle; passing checks are repeated when affected. Do not alter guards or limits. No whole-suite, CI or eval campaign is proposed here; DEBT-F2-GLOBAL-900 and historical P/Q/CI outcomes remain open and scoped acceptance must say so.

Minimum adversarial matrix: missing/invalid vectors; six-field regressions; duplicated samples; absent/null/commentary phase; missing final item; final usage too early; pending item/server request; missing/failed/contradictory terminal; late usage/item; malformed final frame; exit before terminal; nonzero/signal/forced kill; each missing EOF; stream/event-sink error; aborted drain; missing/changed task/run/context/thread/turn; altered receipt/digest/vector; resumed history; stale lease; role/root exhaustion; duplicate settlement; fresh controller reconstruction and zero successor before exact human plan approval. Preserve the existing second-sample 44954-token interruption under the unchanged 40000-token role cap.

## Ordered implementation and stop boundary

- T001: receipt contract and pure validation tests.
- T002 after T001: client proof/drain behavior and real-executor native fake tests.
- T003 after T002: fenced consumer/persistence and workflow integration tests.
- T004 after T003: the complete scoped acceptance sequence and documentation of actual results.

Each slice gets focused checks before continuing; no claimed result for an unrun check. This proposal changes no code. Implementation approval must explicitly cover the operational evidence basis, 15 paths, four tasks and bounded acceptance above; the [Spec-First Contract](../../.agents/specs/CONTRACT.md) requires actual review before implementation. All new review metadata remains null until then.

After scoped technical acceptance, stop before any real model invocation. A future Planner-only attempt needs separately renewed execution authority, a current source-pinned runtime, baseline/sole-writer window, compact context preview and unchanged explicit model/budget consent. Disclose the failed attempt and its observed consumption; a new workflow cannot silently refund/reset it. The private compact brief is still proposed, and complete Engineer context and remaining-budget feasibility must be reviewed before an implementation stage.

The historical workflow stays `needs-decision`, the private runtime copy is not silently refreshed, and no plan approval or Engineer permission is inferred. Technical acceptance prepares a possible new live qualification; it does not complete F3 or guarantee that the producer emits the strict positive transcript.

## Proposal-only validation — 2026-10-31

Both native Harness structural validators exited 0 for the new spec/tasks, without `-Run` or `-ConfirmExecution`; zero acceptance commands executed. Documentary inspection found 11 resolving local links, four ordered tasks and exactly 15 distinct planned targets. The three new artifacts passed the bounded private-identity/path and trailing-whitespace checks. All four retained historical state/event hashes match the correction checkpoint.

This delivery adds only these three proposal artifacts. No product implementation, test campaign, typecheck/build/schema acceptance, browser smoke, real runtime/model call, process cleanup, dependency operation, historical-state change, sibling write, commit, push or merge was performed. No security capability changes. The semantic amendment, producer qualification limitation and global regression debt above remain pending review.

## Implementation checkpoint — stopped on first failure

The owner subsequently approved implementation and the proposed checks, expressly requiring a stop on first failure or unknown. T001 implemented the receipt and pure validator: 33 tests passed. T002 implemented the adapter's fresh-turn proof/drain and synthetic native producer. Its complete three-file protocol check finished with 255 tests passed and one failed (native exit 1, both EOFs, 2193 ms, no timeout/truncation/stream error). All seven native-executor/environment tests passed; no real producer was invoked.

The failed new negative case at `runner/codex-app-server.test.ts:117` expects unknown completeness but supplies `last.totalTokens=1` and unchanged cumulative `total.totalTokens=18`. It satisfies the approved field-wise inequality and is a duplicate cumulative observation, so it does not construct the intended invalid evidence. Proposed next step: change only that fixture counter to exceed the cumulative counter, preserving its assertions and every guard/limit, then reauthorize the stopped sequence. No corrective edit or rerun has been performed.

T003 consumer binding/persistence and T004 final acceptance are unstarted; the current runner does not yet supply the new internal execution identity, so the positive adapter path is not enabled for its production calls. Typecheck, schema/build/secret checks and browser smoke are NOT RUN for this delta. Historical state, frozen private runtime and siblings remain unchanged. No model call, install/download, commit or publication occurred. This checkpoint is not technical acceptance or F3 closure.

## Subsequent approved continuation — consumer acceptance stopped

The owner authorized the suggested fixture correction. Its repeat passed 256 protocol tests. After T003 implementation and additional late-identity coverage, fresh protocol acceptance passed 258 cases with native exit 0, both EOFs and no capture/timeout error. T003 now supplies trusted task/run identities, validates explicit positive receipts after charging observations, preserves ownership and optional metadata, and tests writer/read-only effects, invalid evidence, lease replacement and native-fake controller integration. No real producer or historical workflow was invoked or repaired.

The complete consumer command exited 1 after 761270 ms without timeout, with native exit and both EOFs observed. The retained run-task file reports one failure among 96 cases: `fences a tightened current runtime before any post-model effect`, at line 532, expected `failed` but received `needs-review`. Its old fake declares positive completeness without evidence and therefore now stops at the receipt guard before exercising its intended runtime boundary. Proposed test-only correction: return the exact-bound synthetic receipt helper while preserving all assertions and limits. It has not been applied.

Existing passing correction-progress traces also exceeded the unchanged stdout capture bound of 65536 bytes; the whole workflow-file summary is not retained, so no total consumer PASS count or complete workflow acceptance is claimed. The complete short stderr retains the concrete failure. Proposed command-only amendment: add Vitest's installed `--silent=passed-only` to the consumer command, preserving complete file selection, failing-test logs and every assertion/limit. No command amendment, correction or rerun has been applied after the stop.

T001/T002 are accepted synthetic slices. T003/T004 remain incomplete; typecheck, guarded schema/build/secret acceptance and browser smoke are NOT RUN. No global suite, CI, eval, paid call, sibling change, commit, push or merge followed. The historical failure, frozen runtime and global debt remain unchanged. Next review concerns the single fake's missing receipt and bounded console-output amendment, not weaker runtime or evidence guards.

The owner subsequently approved that exact test-only fake correction and consumer-command console amendment. The active command table above reflects only `--silent=passed-only`; complete files, failed-test logs/reporters, native evidence and all capture/time limits remain intact. Earlier proposal/stop statements remain historical. The affected regression is checked first before resuming acceptance; neither review nor an edited command is a passing result.

## Approved accounting-order correction — 2026-11-01

The owner approved separating accounting certainty from continuation permission after the read-only diagnosis. The runner now validates an already returned closed receipt when its final debit first reveals known independent budget exhaustion, retains exact current lease/context checks, and then throws the unchanged budget abort before all further effects. A result already interrupted on entry, external/durable cancellation, invalid evidence or uncertain accounting remains unknown. Producer-drain conditions and all ledger/cap/time invariants stay unchanged; this is not permission to resume an exhausted task or repair old unknown state.

The original runtime regression passed with its assertions unchanged (one selected, 102 unselected; native exit 0, both EOFs, 10018 ms). Seven additional focused accounting regressions then produced six passes and one failure (96 unselected; native exit 1, both EOFs, 16685 ms; complete capture, no timeout). The new token variant failed on a message expectation: it expected the tightened limit 5, while the existing formatter reports the initial ceiling 100000. Its failed outcome and budget kind were observed; later assertions in that variant were not reached. The runtime variant and five negative evidence/interruption variants passed.

Stopped on that failure. Proposed next change is only the new test's message expectation plus a separate assertion retaining effective limit 5; production formatting, guards and limits would remain unchanged. No such follow-up or further checks ran. Typecheck, full consumer/gate/browser acceptance and F3 remain incomplete. No real model, sibling mutation, commit, push or merge occurred. Earlier stop/review statements in this document remain historical rather than erased evidence.

## Approved focused recheck — same failure, complete capture

The fake now returns `attestedRun(input)`, preserving all existing runtime/ledger/no-effect assertions, and the active consumer command includes only the approved console flag. Before another complete consumer run, the exact failing case was selected once with that flag. It exited 1 in 7184 ms with both EOFs and no truncation, timeout or process/stream error: one failed case, 95 unselected cases. The assertion still expects `failed` but receives `needs-review` even with a valid synthetic receipt. The previous diagnosis was incomplete; the omitted reason/last_failure fields have not yet established the remaining terminal path.

Stop applies at this focused failure. No complete consumer repetition or subsequent catalog/typecheck/build/schema/browser/CI/eval/model command ran. The next proposed diagnostic is limited to exposing this case's normalized completion reason and last_failure, retaining all assertions and limits; it is not yet implemented or executed. Do not change the expected status or relax evidence/runtime guards to obtain acceptance. T003/T004 and F3 remain incomplete, and full-consumer capture behavior under the new flag remains unqualified.

## Approved test expectation correction — 2026-11-02

The owner approved the test-only follow-up after the accounting-order correction. The new tokens variant now compares its message with the initial recorded ceiling and separately asserts that the effective current ceiling remains 5; the runtime variant also asserts its current 1000-ms ceiling. All outcome, charge, receipt, ledger, reservation and no-effect assertions remain. No production formatting, limits, guards or timers changed.

Eight selected run-task regressions passed, including the unchanged original runtime case; 95 cases were deliberately unselected. The command used `-t "terminal receipt accounting|fences a tightened current runtime before any post-model effect" --silent=passed-only`. Native exit 0 and both EOFs were observed in 20840 ms. The subsequent `tsc --noEmit` typecheck passed in 16541 ms with native exit 0 and both EOFs. Foreground execution used installed Node, owned TEMP/TMP, 900000 ms and existing capture bounds; neither command timed out, truncated capture, failed its streams or required termination.

These results establish the focused correction and type compatibility, not complete acceptance. The full consumer command, guarded schema/build/secret checks and isolated browser smoke remain pending; T003/T004 and F3 are incomplete. No whole-suite/CI/eval campaign, model call, historical-state mutation, sibling write, commit, push or merge followed. Prior stop records above are retained as historical evidence.

## Authorized consumer continuation — capture unknown, 2026-11-02

The owner authorized consumer, catalog gate and browser smoke in that order, retaining the first-failure/unknown stop. The complete approved two-file consumer command ran once, with `--silent=passed-only`, installed Node, owned TEMP/TMP, 900000 ms and the existing 65536-byte stream bounds. Native exit 0 and both EOFs were observed in 707128 ms, without timeout, process/stream error or forced termination.

All 103 run-task tests are explicitly reported passed in retained stdout. Direct correction-progress writes nevertheless exceeded the stdout bound: the retained 65391 bytes include 213 trace lines but no final workflow-file or combined summary. Stderr contains 306 bytes of synthetic Git line-ending warnings. The command therefore remains unknown under the approved capture criterion; native exit 0 alone does not establish complete scoped acceptance or an exact whole-command passing count.

Read-only inspection located the correction case's sink in `runner/workflow-orchestrator.test.ts`: `process.stdout.write` bypasses Vitest's console interception and the passing-console flag. The last retained marker is qa-true sequence 33, planning/executor return; qa-false is retained through seal sequence 180. Neither the last retained marker nor the root exit attests the omitted per-case/cleanup details.

Stopped before the catalog gate and browser smoke; no correction or repeat followed. Proposed next review: a test-output-only sink change so diagnostic traces respect Vitest's passing-console suppression and failed-test visibility, preserving diagnostic semantics, file selection, assertions and all limits. T003/T004 and F3 remain incomplete. No global suite/CI/eval, model call, historical-state repair, sibling mutation, commit, push or merge occurred.

## Approved diagnostic sink correction — 2026-11-02

The owner approved changing the correction case's output sink. A single test-source line now uses `console.log(line)` instead of direct stdout writes, allowing the already approved `--silent=passed-only` to govern those diagnostics. The progress emitter, JSON fields/order/binding, workflow assertions and every runtime/capture limit remain unchanged. No production source changed.

Three short isolated Vitest checks consumed the actual extracted sink and a byte-identical public emitter snapshot. Normal passing output retained both begin/seal frames; passing output under `--silent=passed-only` hid them; an intentionally failing test under that flag retained both frames and its explicit failure marker. All three checks passed with expected native exits 0/0/1, both EOFs and complete captures, in 2521/911/948 ms. The negative fixture's exit 1 is expected evidence of failure visibility, not a failed acceptance check. Version, variant, exact synthetic case identity and frame order were checked.

The subsequent `tsc --noEmit` passed in 19843 ms, with native exit 0 and both EOFs. All foreground commands kept installed Node, owned TEMP/TMP, 900000 ms and the existing stream bounds; no timeout, truncation, process/stream error or forced termination occurred. Owned verification artifacts were retained.

This qualifies the sink's console behavior, not the complete consumer block. That block has not been repeated after the change; catalog and browser acceptance are pending, so T003/T004 and F3 remain incomplete. Resume with the complete two-file consumer command, then gate and smoke only after passing predecessors. No full suite, CI, eval, real model, historical-state change, sibling write, commit, push or merge occurred.

## Authorized acceptance continuation — stopped at browser failure, 2026-11-02

Ran the owner's explicitly authorized consumer, gate and browser sequence once, retaining installed executables, foreground owned TEMP/TMP, 900000 ms per command and all assertion/guard/capture limits. Native root exit and both EOFs were observed for every command, without timeout, capture truncation, process/stream error or forced termination.

- Complete consumer command: PASS, native exit 0, 762515 ms; 103 run-task plus 81 workflow tests, 184 total across both complete files. Retained stdout is 23830 bytes and stderr 306 bytes. Both synthetic native Planner variants passed their human-gate/restart accounting assertions. The diagnostic sink correction resolved the capture overflow. T003 is complete.
- Guarded catalog command: PASS, native exit 0, 31119 ms. Schemas, typecheck, build and secrets each exited 0; exactly four checks executed.
- Real isolated API/Vite/Chromium smoke: FAIL, native exit 1, 87459 ms. It stopped at `T013 operations-investigation: real dashboard preview/root gate` with `Browser API read failed before effect capture`, emitted by the request-failure handler at `scripts/playwright-local-app-smoke.ts:148`. No endpoint or underlying transport cause appears in that error, so neither is established. Retained synthetic workflow facts show analysis completed and operations waiting-human, both with complete accounting; this is partial evidence only.

The smoke reported zero browser-read cancellations. Browser, Vite and API closure and temporary workspace removal all succeeded, with no cleanup failures. Four retained historical state/event hashes match their checkpoint. No user cleanup is needed.

Stopped at the browser failure: no correction, repetition or later executable check. T004, the terminal-evidence delta's complete acceptance and F3 remain incomplete. Prior protocol acceptance is retained separately as 258 passing cases and was not repeated here. Next review should identify the failed browser read without rerunning the passing consumer/gate or inferring a timeout/cause from the generic error. No global suite, CI, eval, paid model call, historical-state repair, sibling mutation, install/download, commit, push or merge occurred; global debt remains open.

## Scoped technical acceptance complete — 2026-11-02

The owner authorized autonomous necessary corrections/tests after the read-only diagnostic exposed the missing transport observation. Added only error-bound, immutable, normalized browser-read failure metadata and five negative/privacy/binding regressions. The original generic error, strict failure/cancellation behavior, assertions, 900-second ceilings and capture bounds remain unchanged. Raw IDs/query/URLs and arbitrary transport text are omitted; diagnostic getters cannot replace the original failure. Two existing status documents now reconcile this technical closure with the separate incomplete real pilot.

The read-helper selection passed 33 cases (91 unselected) in 2601 ms, then typecheck passed in 22681 ms. The complete actual API/Vite/Chromium smoke passed in 737494 ms, with all five templates, exactly 31 fake turns, exact human gates, candidate reviews, bounded correction and second-correction denial, cancellation, reload/restart/no replay and session rotation. Prior K-N flows remained covered. Browser-read cancellations were zero, and browser/Vite/API/workspace cleanup all succeeded with no failures.

Closure also refreshed the complete terminal-protocol files: 258 PASS in 2117 ms. The final guarded spec gate passed all four checks in 32257 ms: schemas, typecheck, build and secrets. The complete consumer acceptance remains the 184-case PASS (103 run-task + 81 workflow cases, 762515 ms); no consumer/runtime implementation changed afterward, so it was not repeated unnecessarily. Every command has native exit 0, root exit and both EOFs, complete capture and no timeout/process error/forced termination under owned foreground TEMP/TMP and unchanged bounds. All four historical state/event file hashes match their checkpoint.

The prior unclassified browser transport failure did not recur. Its endpoint/cause are still unknown; this acceptance does not invent a diagnosis or retrospectively relabel that run. The new capture is ready for any recurrence. No manual technical repetition remains for this delta, and T001-T004 are done.

This is synthetic technical acceptance only. The historical actual attempt, its undercount/needs-decision state, frozen runtime and expired writer window remain unchanged. The real F3 pilot still needs separately bound fresh execution/context/budget authority plus actual human plan/candidate decisions. No model call, sibling write, installation/download, global suite/CI/eval, commit, push or merge occurred. DEBT-F2-GLOBAL-900 and historical P/Q/CI outcomes remain open.
