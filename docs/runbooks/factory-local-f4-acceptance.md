# Factory Local F4 — acceptance record

Status, 2026-11-02: T005 and F4 synthetic technical acceptance are complete under the owner's approved [plan](../proposals/factory-local-f4-design.md) and task continuation. The fresh complete actual API/Chromium campaign passed with exactly 31 fake turns and full owned cleanup, under unchanged guards/timeouts. N01-N12 are verified or explicitly not applicable below. Earlier receipts overlap and are not additive; both prior full-smoke timeouts remain historical FAILs with unknown causes, not reclassified or claimed repaired. Real F3 delivery, F5, global suite/CI debt and separate human/live-execution authority remain open.

## T005 consolidated technical acceptance

The owner continued T005 with the standing authority for necessary tests/corrections, unchanged guards/timeouts and no commit/push. Only test infrastructure and the three F4 documents changed in this block. No product runtime, storage, public API, policy, capability, dependency or sibling repository changed.

### Diagnostic change and actual result

The removed T004 fixtures cannot identify their failed requests retrospectively. T005 adds error-bound metadata around existing Node GET response/body reads and POST response acquisition in the smoke. It preserves the original thrown value in a WeakMap and emits a closed route category, method, response/body phase and existing timeout only when that exact error reaches the smoke failure handler. Successful reads are returned unchanged; primitive errors remain unclassified. No body, header, token, private URL, query, fragment or dynamic identifier is added to the diagnostic. Direct fetches and unwrapped POST-body consumers remain outside this particular capture. The metadata grants no retry and adds no timer.

Six regressions verify response/body error identity, privacy, successful reads, malformed/unknown route isolation, primitive rejection and nested first-failure binding. They passed before typecheck and a single complete diagnostic campaign. That full campaign passed without either timeout recurring, so no speculative performance or scheduling correction was applied. No `SMOKE_NODE_API_FAILURE` was produced; the old requests and causes therefore remain unknown. A passing current gate is not proof of a latency improvement or guaranteed absence of recurrence.

### Fresh commands and native receipts

Evidence root: owned OS-temp directory `surtec-f4-t005-b747451ae5974f55a02b0d2a5a353d14`. Installed JS entries run directly, equivalent to the commands below, in the foreground outside the restricted sandbox with owned TEMP/TMP, 900000 ms per command and unchanged 65536-byte per-stream capture. The existing bounded output mirror preserves native exit/root/EOF/deadline semantics.

| Command | Observed result | Native elapsed |
| --- | --- | --- |
| `pnpm exec vitest run scripts/harness-validators.test.ts -t "F4 T005 node API" --silent=passed-only` | 6 PASS, 124 deliberately unselected | 2853 ms |
| `pnpm typecheck` | PASS | 24077 ms |
| `pnpm secrets:check` | Self-test and 1250 repository files PASS | 712 ms |
| `pnpm smoke:local:playwright` — full default campaign | PASS; exactly 31 fake turns (4 legacy + 27 workflow), N12 partial-history case included | 788280 ms |
| `pnpm schemas:check` | 63 schemas PASS | 693 ms |
| `pnpm build` | PASS; existing Vite >500-kB chunk warning retained | 5079 ms |

Every receipt has native exit 0, observed root exit, both EOFs, complete capture, no timeout/truncation/process or stream error and no termination request. Receipts are `captureTests-result.json`, `typecheck-result.json`, `secrets-result.json`, `smoke-result.json`, `schemas-result.json` and `build-result.json`. The full smoke consumed 788.280 of its existing 900 seconds; no deadline was extended or waived.

The actual API/Vite/Chromium fixture `surtec-local-dashboard-GPj0LA` completed all five templates, exact Planner/risk/criterion gates, candidate-bound Reviewer/QA, fresh infrastructure receipts, both correction paths, one consumed allowance and second-correction refusal, stale/budget/tree refusals, repeated requests, private-context exclusions, active-role cancellation, browser navigation/mobile checks, API restart/session rotation and no replay. The added N12 snapshot/history bytes and detail response also survived real restart/reload unchanged. Exactly 31 executor effects prove no extra role was added; the synthetic terminal history task never executes. Browser errors/HTTP errors assertions passed, owned-navigation cancellations were zero, and browser/Vite/API closure plus workspace removal all report true with no cleanup failures. Only owned fixture resources were closed; the wrapper/evidence root remains for audit.

### Consolidated mandatory controls

| ID | Final disposition and evidence |
| --- | --- |
| N01 permissions/scope | VERIFIED: T002 service/runner refusals; current full browser rejects forged/incomplete/stale authority and scope changes before write/acceptance |
| N02 required verification | VERIFIED: T002 service/runner failed/missing functional and RED refusals; current full browser accepts only exact configured verification/candidate receipts |
| N03 model claims versus receipts | VERIFIED: 33 T002 receipt-contract cases, runner positive/negative infrastructure bindings and current full browser captured-receipt assertions; model text alone grants nothing |
| N04 review finding/correction | VERIFIED: current full browser binds Reviewer/QA to the inactive exact candidate, requires fresh correction verification and reviews, consumes one allowance and refuses a repeated correction |
| N05 changed candidate/scope | VERIFIED: T002/T003 exact candidate/source/scope refusals plus current full browser stale/budget/tree/fingerprint guards; no prior approval is transferred to drifted content |
| N06 uncertain effect/usage | VERIFIED: T003 retains known charges and unknown holds, refuses generic v2 retry/refund and reconciles only provable unstarted gaps; current restart preserves identities/counters without replay |
| N07 repeated requests/decisions | VERIFIED: T002 keyed request/service cases and current browser lost-response/reload/replay/stale-decision refusals; state identity and exact turn count preserved |
| N08 cancellation/budget | VERIFIED: T003 root and independent Reviewer/QA attempt/runtime/token boundaries, durable stop before abort; current full browser active-role stop starts no successor |
| N09 context/privacy | VERIFIED: 31 T002 context-service cases with unchanged source and current actual browser source/consent/category/privacy assertions; context text grants no capability |
| N10 competing writer | VERIFIED: T003's 80 complete worker cases prove two cooperating workers share capacity and one project writer, without duplicate claim/charge/execution. The current single-worker smoke does not substitute for that concurrency proof |
| N11 integrated tree | NOT APPLICABLE: no real-project integration, merge or publication was authorized/performed. Fresh integrated-tree verification remains mandatory for any future authorized integration; synthetic candidate checks are not that acceptance |
| N12 restart/history | VERIFIED: T004's 279 state/UI cases and four selected API cases, its focused actual restart smoke and the fresh full campaign. Persisted facts survive; unavailable history is exposed without invented/backfilled events or a completeness claim |

### Source binding, scope and remaining boundaries

Before edits, all 1026 T004 final manifest entries matched byte-for-byte. Their manifest SHA-256, reused as T005's baseline, is `0dc1ec76c114cb3345f7cc6b788ce3dab2d9a7207cc8d9efb417a21a0c0362f8`. Git remains on `codex/phase-q-operating-views` at `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, with an initially empty index and preserved pre-existing work.

Both 952-file manifests from T001-T002 and T003 were compared against current source. Their only differences are the recorded T003 `runner/run-task.test.ts` adjustment and T004's API/store/events test extensions; all 948 other pinned contents, including the relevant production modules, schemas, policy, service tests and workflow/worker tests, match. The accepted final runner hash is also chained through T004's unchanged-at-start manifest. T002's 222 complete service, 33 receipt and selected runner receipts and T003's 80 worker/28 selected workflow/103 complete runner receipts retain PASS/native exit 0/both EOFs with no timeout/truncation. `prior-receipt-bindings.json` records the comparison. Reused counts are attributed, not added to six fresh diagnostic cases or counted as new executions.

T005 target files are the existing smoke, its existing validator test file, this acceptance record, the F4 plan and active roadmap. Final independent inventory/hashes, document-link and whitespace checks qualify those five changes, with no unrelated source replacement. No policy pin, schema, timeout or execution guard changes. Normal private state and build output are outside the source inventory; synthetic input never comes from real project state.

The final baseline comparison observes exactly those five changed paths and 1021 unchanged contents among 1026 pins; all 83 local document references resolve and targeted whitespace checks pass. HEAD/branch and the empty index remain unchanged. The independently enumerated final manifest/native integrity receipt is retained beside the command receipts, and the prior-receipt comparison is copied there from its owned staging directory. No private source/state body is added to this public record.

F4's technical controls and repeatable local acceptance are complete; no manual technical repetition is requested. Historical intermittent observation timeouts remain a known risk with error-only capture for a future recurrence, not a claimed runtime fix. The full repository suite, CI, evals and audit were not run as part of the approved F4 slice; their global debt remains open. No installation/download, paid model call, real pilot repair/retry, sibling write, checkout commit, push, merge or deployment occurred.

Stop at F4. Before F5, the real F3 pilot still needs renewed exact baseline/context/budget/writer authority and actual plan/candidate decisions leading to an accepted real delivery. The old stopped Planner/accounting evidence stays preserved. Synthetic success alone does not fulfill the PoC's global real-delivery criterion or authorize another live turn.

The sections below preserve dated T001-T004 observations, including their then-pending status and failed attempts. Their historical results are not overwritten by this current T005 acceptance.

## T004 snapshot/event observation — scoped verification complete

The owner authorized T004 with necessary corrections and tests, without permission per iteration, preserving guards/timeouts and prohibiting commit/push. The [prospective scope](../proposals/factory-local-f4-design.md#t004-prospective-observation-scope) keeps storage, public API shape, worker, lease/retry/accounting and runtime contracts unchanged. The only product change is the existing task detail presentation: replace "Lifecycle completo" with "Historial registrado", show saved versus greatest observed event revision and state that completeness is unknown even when revisions match. No repair/retry action is added.

### Boundary established by inspection

- `updateTask` replaces the authoritative snapshot under its task lock. `appendTaskEvent` takes separate maintenance/event ownership. A refused later append does not roll back the snapshot; no two-file transaction exists.
- Not every snapshot update emits an event, and multiple events can share a revision. A difference in revisions is an observation, not proof of a lost event or its cause. Matching latest revisions cannot exclude a missing interior event. Legacy snapshots may have no revision.
- `readTaskEvents` returns an empty list for an absent log but refuses malformed JSON/invalid records, without returning a fabricated valid prefix. Task detail/event GETs retain their existing failure responses for damaged logs; the independently validated task GET remains readable.
- Detail rebuilds from persisted task/events on each request. The UI now labels available history and uncertainty explicitly; refreshing/restarting cannot recover an unavailable event, grant authority or replay work. This is observation, not transactional consistency or a history-completeness detector.

### Source binding and focal results

Observed Git identity remains `codex/phase-q-operating-views` at `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, initially with an empty index and pre-existing user work. A fresh external manifest pinned 1026 files: `dashboard/src`, `lib`, `runner`, `schemas`, `registry`, `fixtures`, selected instructions/build inputs, the smoke/test script and three F4 documents. Its SHA-256 is `retained privately`. It does not identify unrelated files or private normal state.

Receipts are retained under the test-owned OS-temp directory `surtec-f4-t004-620ea3b7356643d898a92c3f11addacc`, separately from repository/user state. Each command uses installed native tools, foreground execution outside the restricted sandbox, owned TEMP/TMP, 900000 ms and the unchanged reviewed 65536-byte per-stream capture. A bounded output mirror uses the capture helper's existing `onSpawn` hook for visible smoke progress; it does not change capture, EOF or deadline semantics.

| Check | Result | Native closure / elapsed |
| --- | --- | --- |
| Baseline: full store, events, observability and task-detail UI files | 267 PASS (225 + 9 + 6 + 27) | Exit 0, both EOFs, 32449 ms |
| Same four complete files after the correction | 279 PASS (226 + 13 + 6 + 34) | Exit 0, both EOFs, 34212 ms |
| Selected task-detail API baseline and T004 cases | Final 4 PASS, 93 deliberately unselected | Exit 0, both EOFs, 10677 ms |
| `pnpm schemas:check` | 63 schemas PASS | Exit 0, both EOFs, 1513 ms |
| `pnpm typecheck` | PASS | Exit 0, both EOFs, 38303 ms |
| `pnpm build` | PASS; existing Vite large-chunk warning | Exit 0, both EOFs, 11048 ms |
| First `pnpm smoke:local:playwright` with the added restart/history case | FAIL before T004's new case, in existing scope-discovery flow | Exit 1, both EOFs, 77077 ms; owned cleanup all true |
| Full smoke with granular existing scope-stage labels | FAIL before T004's new case, during existing implementation workflow | Exit 1, both EOFs, 250833 ms; owned cleanup all true |
| Typecheck after the bounded stage labels / final focused selection | Both PASS | Exit 0, both EOFs, 35787 / 41645 ms |
| `pnpm smoke:local:playwright -- --history-restart-only` (installed TSX/script entry, exact flag) | PASS, actual API + Chromium, zero turns | Exit 0, both EOFs, 48728 ms; owned cleanup all true |
| `pnpm secrets:check` | Self-test and 1250 repository files PASS | Exit 0, both EOFs, 1212 ms |

The focal command runs `vitest run lib/state/store.test.ts lib/state/events.test.ts lib/state/observability.test.ts dashboard/src/ui/views/TaskDetailView.test.tsx --silent=passed-only`; API selection uses `vitest run dashboard/src/server/index.test.ts -t "/api/tasks/:id/detail|F4 T004" --silent=passed-only`. Installed JS entries are invoked directly, equivalent to `pnpm exec`, without installation or package lifecycle hooks.

The first new API fixture was incorrectly wired: `TaskControl` was passed as `createApp`'s fourth argument (HTTP security), producing 3 FAIL / 1 PASS / 93 unselected, exit 1 with both EOFs in 8659 ms. The correction passes the existing fake control in its actual second argument, with the real default HTTP security intact. All assertions stayed unchanged; the failed receipt remains. No product route/security change was necessary. Passing final focal counts are not additive with the baseline or earlier F4 receipts.

The first browser attempt stopped with a fetch `TimeoutError` in the pre-existing "verify out-of-scope work stops before commit and requires a browser decision" flow, before the T004 fixture. The receipt does not identify the exact request or prove a T004 regression; no command-level deadline was reached. Fixture `surtec-local-dashboard-2ZV2ZZ` reported browser/Vite/API closure and workspace removal all true, no cleanup failures and zero owned-navigation cancellations. Its removed state cannot supply further retrospective diagnostics. Preserve the failure; add only granular existing-stage labels (create/authorize/preview/dispatch/lineage/browser decision) before another diagnostic attempt, without changing operations, assertions or deadlines.

The second full attempt passed that scope flow without a behavioral fix and stopped later at "T013 implementation: plan-approval human gate", again with a fetch `TimeoutError`. Retained synthetic workflow facts show analysis/operations completed and implementation running at review; these do not identify the timed-out request or prove its cause. Fixture `surtec-local-dashboard-YVkbdz` reports all four cleanup booleans true, no failures and zero cancellations. Neither full attempt reached N12 or confirmed the final 31-turn total. No timeout, guard or assertion was relaxed; no production performance fix is claimed.

### Focused actual API/browser restart acceptance

The same harness now accepts the explicit `--history-restart-only` selection after its isolated startup. It reuses the history fixture/assertions also retained in the normal full campaign. It creates one test-owned, terminal read-only snapshot r3 with a queued event r1; reads the actual detail API; opens its actual dashboard history; navigates away; stops and restarts the actual API; verifies session rotation; reopens and reloads the dashboard; checks desktop/mobile overflow; compares exact task/event bytes and the complete before/after detail response. It proves no executor effects file content and no browser/page/HTTP errors, without selecting any workflow/model turn. An unavailable effects read other than ENOENT fails rather than becoming zero.

The selection passed in 48728 ms with both EOFs and complete capture, fixture `surtec-local-dashboard-djRNOb`, zero owned-navigation cancellations, all cleanup booleans true and no failures. This is scoped N12 evidence with the real API/browser, not a replacement full-compatibility PASS. It does not waive the retained failures or close T005/F4. Original default flows, assertions and deadlines stay intact. No further full-smoke repetition was used to seek a passing sample.

The only product source changed is task-detail presentation. Test targets are the task-detail UI, task store/events, API index and existing smoke; evidence targets are this record, the F4 plan and active roadmap. Existing schema/API/persistence/runtime behavior and capabilities are unchanged. No manual technical repetition is necessary for the proved N12 observation; remaining automated compatibility diagnosis belongs to T005. Real F3 delivery and global suite/CI debt remain pending. No live model call, sibling operation, installation, global suite/CI/eval campaign or publication is included.

### Final scope and delivery boundary

The 1026-file baseline comparison found exactly nine intended changed paths: five tests/smoke files, task-detail UI and the three F4 documents, with no missing pinned file. The remaining 1017 pinned contents are unchanged. All 84 local Markdown references in the three evidence documents resolve; targeted `git diff --check` passes. HEAD/branch and the empty index remain unchanged. Final independent enumeration/hashes and native receipts stay in the owned external evidence directory; build output and private normal state are outside this source inventory.

Final accepted focused counts are 279 state/UI plus four selected API cases, with 93 API cases deliberately unselected. Baseline, prior F4 and failed-run counts are not additive. Positive command receipts have exit 0, root exit and both EOFs with no timeout, truncation, spawn/stream error or termination request. Negative receipts retain exit 1 and full closure; none reached the 900-second command limit. Only the smoke fixtures' own browser, Vite, API and directories were closed/removed; wrapper TEMP/evidence parents remain retained. No commits or publication were created.

T004/N12 is complete for honest read-only reconstruction/observation. Full F4 acceptance remains incomplete: T005 must consolidate evidence and address the two retained compatibility timeouts without interpreting the focused selection as a waiver. The original full-smoke cause remains unknown, rather than silently fixed by a passing independent case.

## T001-T002 scope and source identity

This block revalidates existing contracts; no product, schema, test, policy or runtime implementation changed. Only this record, the F4 plan and the active-roadmap status are updated. Existing user changes are preserved.

Observed checkout: `codex/phase-q-operating-views`, HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, with an empty index and pre-existing uncommitted work. The commit alone does not identify the dirty implementation tested.

Before execution, an owned external manifest pinned 952 files under the server, lib, runner, schemas, registry and fixture trees plus root instructions/build configuration/lockfile. The manifest SHA-256 is `retained privately`. Final independent enumeration and hashing confirmed 952 current files, zero added/removed/missing files and zero changed hashes. No private state or sibling repository is a source of test data.

The first auxiliary integrity comparison assembled an incomplete second enumeration and produced a false removed-file inventory despite all 952 content hashes matching. That diagnostic result is retained separately; a corrected local-scope enumerator confirmed the unchanged inventory. No product source, assertions or limits changed, and no product test was repeated to correct this auxiliary helper.

## Commands and observed results

Commands ran sequentially, outside the restricted sandbox in the foreground, using installed Node, owned TEMP/TMP, the reviewed native capture and the unchanged 900000-ms per-command ceiling and 65536-byte per-stream bounds. The installed Vitest JS entry was invoked directly, equivalent to the package-manager commands below, without lifecycle hooks or installation.

| Command | Observed result | Native evidence |
| --- | --- | --- |
| `pnpm exec vitest run dashboard/src/server/context-service.test.ts dashboard/src/server/issue-service.test.ts --silent=passed-only` | 222 PASS: 31 context-service and 191 issue-service tests; both complete files | Exit 0, both EOFs, 54507 ms |
| `pnpm exec vitest run runner/terminal-usage-evidence.test.ts` | 33 PASS, complete receipt-contract file | Exit 0, both EOFs, 1133 ms |
| Runner selection below | 24 PASS, 79 deliberately unselected | Exit 0, both EOFs, 34492 ms |

Exact runner command:

```text
pnpm exec vitest run runner/run-task.test.ts -t "denies standalone v2|validated exact receipt|charges usage but rejects|late receipt after the lease is replaced|isolated budget writer|does not promote an agent success claim|non-failing RED|changed pinned probe" --silent=passed-only
```

There are 279 passing cases in these three invocations. Filtered cases are not passes, and historical runs are not added to this count. Every root exit was observed, all captures were complete, and no timeout, spawn/stream error, forced termination or capture truncation occurred. Two synthetic Git line-ending warnings appeared in the runner capture; no test failed.

Retained owned evidence consists of `services-result.json`, `receiptContract-result.json`, `receiptRunner-result.json`, `source-pins.json` and the final source-integrity receipt. An earlier faulty auxiliary inventory receipt is retained as described above. No source bodies, credentials or reasoning are copied into this public record.

## Criterion observations

| F4 case | Result for this block | Observable evidence |
| --- | --- | --- |
| N01 permission/scope | PASS at service and runner boundaries | Exact scope authorization is required; duplicate issue task ownership is refused; all seven standalone v2 roles are rejected before context/worktree/model effects |
| N02 required verification | PASS at service and runner boundaries | Failed/skipped/missing functional verification cannot be promoted by model success; a non-failing RED blocks implementation; changed pinned probes are refused before effects |
| N03 trustworthy receipts | PASS | Pure receipt validation rejects malformed/forged bindings and integrity facts; runner charges but refuses missing/lookalike/wrong-run/context/digest/usage evidence; writer commit/verification is admitted only for the valid receipt |
| N07 repeated manual request/issue dispatch | PASS for the exercised intake and issue scope | Same request identity returns the retained original without rewriting/duplicating state; changed content is refused; replay precedes capacity enforcement; duplicate issue dispatch cannot create another task |
| N09 context/policy/privacy | PASS at the context-service boundary | Changed instructions/sources/policy/consent and arbitrary caller manifests are refused; only explicit server-resolved client categories are shared; private bodies stay absent from projections and unconsented context |
| N05 exact candidate binding | Partial F4 evidence | Service tests refuse wrong run/owner/candidate/project and stale scope/receipt during acceptance; this block does not close all orchestration/restart cases |

Tests use synthetic tasks, fake executors and trusted test-built receipts. Selected writer cases additionally use real disposable Git/worktrees and configured local verification over fictional files. No paid producer or real project is involved. These results do not prove real model output, independent human review or the real pilot's delivery criteria.

## Effects, cleanup and deferred work

The issue and runner teardown assertions passed, including removal of their per-case roots; context tests also ran their normal temporary-root cleanup without error. The parent verification directory is retained for audit. No independent broad process/filesystem cleanup was performed or claimed.

No new API/browser flow or implementation behavior changed, so another full browser smoke, typecheck, schemas/build, global suite, CI, audit or eval campaign was not necessary for this verification-only block and was not run. Their earlier passing results remain separately attributed; none is relabeled as a fresh F4 execution. No manual repetition is needed for the automated checks in this block.

The next authorized-boundary proposal is T003: writer exclusion, durable cancellation, exhaustion, lease ownership and conservative recovery. T004 must still investigate/demonstrate snapshot/event-gap exposure and reconstruction after restart. T005 consolidates all mandatory cases and relevant API/browser evidence. F4 is not complete, N11 remains inapplicable without authorized integration, and global debt stays open.

No normal-state repair, sibling write, installation/download, real model call, publication, deployment, checkout commit, push or merge occurred. Human plan/candidate acceptance for the real F3 pilot remains a separate gate.

Final document checks passed: targeted whitespace validation and twelve resolving local links across this record and the plan. The secret-scanner self-test and scan passed across 1250 repository files, native exit 0 and both EOFs in 646 ms, with complete capture and no timeout/termination. This is a documentation/safety check, not another product-test or global-CI result.

## T003 — writer exclusion, cancellation, budgets, leases and recovery

The owner explicitly authorized T003 and necessary corrections. The checkout HEAD/branch and empty index were unchanged. A fresh manifest pinned the same 952-source/configuration namespace before execution; its SHA-256 is `fe6caec53a6e380df605dc92b572be2011e331bb7a8548aa8fefccfea92806c2`. The final comparison confirms 952 current files, no additions/removals/missing files, and only the expected change to `runner/run-task.test.ts`; its accepted hash matches the separately retained final adjustment receipt. The other 951 files, including all production runtime, policy, schemas and configuration, remain byte-identical.

### Final accepted commands

| Command | Result | Native/stream evidence |
| --- | --- | --- |
| `pnpm exec vitest run runner/task-orchestrator.test.ts --silent=passed-only` | 80 PASS, complete file | Exit 0, both EOFs, complete capture, 79698 ms |
| Workflow selection below | 28 PASS, 53 deliberately unselected | Exit 0, both EOFs, complete capture, 158171 ms |
| `pnpm exec vitest run runner/run-task.test.ts --silent=passed-only` after the test adjustment | 103 PASS, complete file | Exit 0, both EOFs, complete capture, 206087 ms |
| `pnpm typecheck` script body (`tsc --noEmit`) | PASS | Exit 0, both EOFs, complete capture, 31168 ms |

Exact workflow command:

```text
pnpm exec vitest run runner/workflow-orchestrator.test.ts -t "missing final usage|source drift during the turn|source drift and an uncommitted intent|caller-shaped proof|durable stop precedes|retains aggregate|actual turn reaching its root token cap|two workers share existing scheduler|different workflow issues share one project writer|stale proof cannot|explicit recovery commits|missing reserved task|changed sources prevent recovery|expired/replaced lease retains|stale recovery snapshot|records exact authorized exhaustion|canClaim read-only|final already-admitted task|retains workflow stop before|does not rewind an explicitly|preserves stopped workflow bytes|stops a real candidate's Reviewer|independent P review token cap" --silent=passed-only
```

The final three test receipts cover 211 passing cases across different files. This includes the runner cases selected in the first block, so do not add 211 to the earlier 279 as a unique-case total. Filtered cases are not passes. Every final command retained foreground installed-executable execution, owned TEMP/TMP, 900000 ms and unchanged 65536-byte stream bounds, without a command timeout, capture truncation, process/stream error or forced termination.

### Preserved failures and bounded test adjustment

The initial runner selection was:

```text
pnpm exec vitest run runner/run-task.test.ts -t "T007|budget proof before|invalid/future budget bytes|settles complete known usage|retains known charges and unknown holds|distinguishes explicit complete zero|never promotes known intermediate usage|post-snapshot settlement fails|late owned receipt|counts duplicate and decreasing|tightened current runtime|terminal receipt accounting|next verification command after runtime|expired governed lease|five-minute runtime budget|durable cancellation|cumulative token usage exceeds|stale attempt overwrite" --silent=passed-only
```

It produced 37 PASS, one FAIL and 65 unselected in 91099 ms, native exit 1 and complete capture. The failure was T007's tokens case at its unchanged 5000-ms test deadline; its last marker was release-returned, after the original assertions and proof release. The command itself did not hit its 900-second deadline.

An attempted immutable public-input cache did not resolve the timing issue: the three T007 variants produced two passes and the same tokens timeout in 20593 ms. That cache was removed; it is not part of the final source. Both failed receipts remain retained and are not relabeled as passing evidence.

The final test-only delta extends the existing failure context with six bounded elapsed-phase observations and reads the final authoritative task once for its existing lifecycle/lease assertions. Workflow admission/claim/execution, all original assertions, budget conditions, production code and every timeout remain unchanged. No new shared admitted state or private proof cache exists.

A one-case diagnostic selection then passed with native exit 0 in 9713 ms; the tokens case itself took 4555 ms. After consolidating the duplicate final-task read, the complete 103-case runner file passed. Its three T007 cases took 4543/4199/4161 ms under the original 5000-ms deadline. This establishes the final observed acceptance, not a causal explanation or guarantee that host-dependent test-duration variability is eliminated. The retained phase diagnostics will qualify any future recurrence; no speedup or runtime-bug correction is inferred from different execution contexts.

### Proven T003 boundaries

| Control | Verified behavior |
| --- | --- |
| N10 project writers and scheduler capacity | One writer per project across two cooperating workers; read-only work can use spare capacity; the final slot, task and stage cannot be claimed/charged/executed twice |
| N08 queued/running cancellation | Persist the stop before signalling abort, do not invoke queued work, preserve stop/accounting across a fresh controller and start no successor |
| N08 token/runtime/attempt limits | Respect current tightened limits and final already-admitted attempts; retain exact root and independent Reviewer/QA stop evidence; no role/correction successor after exhaustion |
| N06 unknown usage and settlement faults | Keep proven consumption and uncertain holds; neither a later sample nor restart may invent completeness, refund consumption or permit a generic v2 retry |
| N06 stale ownership and changed policy/source | Refuse observation/effects after lease/worker/attempt replacement; preserve foreign task bytes and prior charges; abort heartbeat renewal when current authority is unavailable |
| N06 conservative recovery | Reconcile only provable existing unstarted admission/link gaps; do not create replacement tasks, replay roles, refund attempts or terminalize a renewed lease from a stale snapshot |

The private P allocation tests are synthetic injected execution, not production P activation or a renewed actual-pilot budget. All model turns are fakes; some candidate/review fixtures use real disposable Git and configured local verification. Worker/workflow teardown and normal runner cleanup completed without test errors; the verification parent remains retained. No cleanup of user processes, normal state or unknown worktrees was performed.

This block does not establish N12 snapshot/event-gap detection or its API/UI exposure; that is T004. It also does not complete T005, F4 overall, the real F3 delivery or global suite/CI debt. Browser, schemas/build, audit/evals and whole-suite campaigns were not repeated because production/API/UI/schema behavior did not change. Typecheck was repeated because a TypeScript test changed. No manual repetition is needed for the automated T003 checks.

Repository changes are limited to the test delta, this record, the F4 plan and the active-roadmap status. No model call, normal-state repair, sibling write, dependency install/download, checkout commit, push, merge or deployment occurred.

Final T003 documentary checks passed: targeted whitespace validation, twelve resolving local links, and the secret-scanner self-test/scan across 1250 repository files. The scanner had native exit 0, both EOFs and complete capture in 1243 ms, without timeout, process/stream error or forced termination. This is a final safety check, not another product-suite or global-CI pass.
