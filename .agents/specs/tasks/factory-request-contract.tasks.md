---
spec: .agents/specs/factory-request-contract.spec.yaml
feature: factory-request-contract
status: done
createdAt: "2026-10-24"
reviewedBy: repository-owner
approvedAt: "2026-10-30T13:46:42Z"
---

# Factory Local F2 - approved ordered tasks

## Current acceptance boundary - 2026-10-30

The repository owner approved the exact [bounded functional acceptance revision](../../../docs/proposals/f2-functional-acceptance-revision.md). The approval was acknowledged in this session at `2026-10-30T13:46:42Z`; current approval metadata records that acknowledgement, not an invented earlier human timestamp. The original `2026-10-24T14:25:58Z` acknowledgement and initial authorization remain historical below.

The original activation was limited to five approved acceptance documents and documentary checks. Subsequent separately authorized checks and the explicitly confirmed human checkpoint now satisfy every revised mandatory result and relevant cleanup requirement. T001-T008 are complete: F2 functional acceptance complete for the local PoC, global debt open. Historical authorizations and intermediate statuses remain below; F3 is not authorized.

The current exit requires the six unchanged catalog checks plus the four fixed external functional commands, Harness validation, the real isolated API/browser smoke and human pilot confirmation in [Current F2 functional acceptance](../../../docs/runbooks/factory-request-contract-acceptance.md#current-f2-functional-acceptance). Whole-repository timeout debt `DEBT-F2-GLOBAL-900` remains open outside this task list. No original seven-check gate, complete suite, CI or Q result becomes PASS.

The eight machine-validated maps-to lists now reference the six active check IDs by removing only retired `ac-behavior`. These current references do not rewrite historical outcomes or claim that schemas/types prove behavior. The initial scope statements below describe the original T001 authorization; the approved revision and appended activation record define the current documentary boundary.

## Original plan and initial authorization

The repository owner explicitly approved the [design](../../../docs/architecture/factory-request-contract-design.md), its 22 target paths and T001-T008 plan in the current conversation. The same message authorized **T001 only and documentary checks**, without campaigns, process cleanup, commit, push or merge. `approvedAt` is the session acknowledgement time of that approval, not an invented earlier timestamp or phase completion.

The feature stays `in_progress`; unchecked tasks are not implemented or accepted. Actual authority remains the conversation. Structural validation, approved metadata and command strings do not launch a check or authorize later work. T001 cannot edit product code, the active roadmap, runbooks or compatibility records. T002-T008 require a continuation instruction.

All tasks are sequential. Tests precede or accompany behavior. Progress/evidence updates stay within the planning artifacts and each authorized slice. The full whitelist contains 22 unique paths; T008 reuses previously listed evidence targets. No parallel marker, publication authority or new Harness orchestration is introduced.

## Phase 1 - record the approved prospective contract

<!-- maps to: ac-schemas,ac-types,ac-build,ac-repository,ac-secrets,ac-evals -->
- [x] T001 Record the approved design, specification and ordered plan; validate only their documentary structure and scope -> docs/architecture/factory-request-contract-design.md, .agents/specs/factory-request-contract.spec.yaml, .agents/specs/tasks/factory-request-contract.tasks.md

## Phase 2 - receipt contract and locked persistence

<!-- maps to: ac-schemas,ac-types -->
- [x] T002 (depends: T001) Add strict optional immutable receipt v1, legacy/future validation, global uniqueness and an explicit locked replay path that does not write; add relevant store tests -> lib/issues/types.ts, schemas/work-issue.schema.json, lib/state/validation.ts, lib/state/issues.ts, lib/state/issues.test.ts

## Phase 3 - idempotent service and protected HTTP intake

<!-- maps to: ac-schemas,ac-types -->
- [x] T003 (depends: T002) Normalize and fingerprint original create input, resolve replay/conflict before new-create constraints, require public request identity and retain declared internal legacy behavior; update endpoint handling and HTTP tests while UI and smoke callers follow in T004 and T006 -> dashboard/src/server/issue-service.ts, dashboard/src/server/issue-service.test.ts, dashboard/src/server/index.ts, dashboard/src/server/index.test.ts

## Phase 4 - pending UI identity and recovery

<!-- maps to: ac-types,ac-build,ac-secrets -->
- [x] T004 (depends: T003) Retain logical request UUID and payload for explicit retry, store only pending UUID across reload, reconcile through existing GET and expose unresolved outcomes without automatic recreation -> dashboard/src/ui/api.ts, dashboard/src/ui/views/IssuesView.tsx, dashboard/src/ui/views/IssuesView.test.tsx

## Phase 5 - prove existing project context and plan authority

<!-- maps to: ac-types,ac-evals -->
- [x] T005 (depends: T004) Demonstrate selected synthetic README and architecture/ADR/contracts, attribution and drift/no-authority boundaries while reusing current plan-gate coverage and leaving production context components unchanged -> lib/context/sources.test.ts, dashboard/src/server/context-service.test.ts

## Phase 6 - extend isolated real API and browser acceptance

<!-- maps to: ac-types,ac-build,ac-secrets -->
- [x] T006 (depends: T005) Extend the existing smoke for keyed HTTP calls, lost-response replay, reload/restart, payload conflicts, context/plan evidence and zero intake execution effects using only test-owned fixtures -> scripts/playwright-local-app-smoke.ts

## Phase 7 - document compatibility and acceptance procedure

<!-- maps to: ac-schemas,ac-types,ac-build,ac-repository,ac-secrets,ac-evals -->
- [x] T007 (depends: T006) Document additive receipt compatibility, uncertainty recovery, exact validation procedure and active-roadmap status without rewriting historical P/Q acceptance -> docs/architecture/organization-state-migration.md, docs/runbooks/local-work-issues.md, docs/runbooks/factory-request-contract-acceptance.md, docs/roadmap/factory-local-poc.md

## Phase 8 - authorized acceptance and real-pilot readiness checkpoint

<!-- maps to: ac-schemas,ac-types,ac-build,ac-repository,ac-secrets,ac-evals -->
- [x] T008 (depends: T007) After separate execution readiness and authorization, run reviewed checks and isolated smoke once, record native results and owned cleanup, and obtain the human real-project/request/criteria/source/command confirmation before full F2 closure -> docs/runbooks/factory-request-contract-acceptance.md, .agents/specs/tasks/factory-request-contract.tasks.md, docs/roadmap/factory-local-poc.md

## T001 documentary checkpoint

Current write boundary is exactly the three T001 planning artifacts. Do not create the future acceptance runbook in T001. The following structural commands execute no acceptance checks:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -SpecPath .agents/specs/factory-request-contract.spec.yaml
pwsh -NoProfile -File .agents/scripts/validate-tasks.ps1 -TasksPath .agents/specs/tasks/factory-request-contract.tasks.md
```

Additionally check local Markdown references, stable req-001 through req-006 coverage, all seven acceptance references, T001-T008 order/dependencies, the unique 22-path scope, whitespace/final newlines, and unchanged baseline files outside T001. Future task target paths may be absent. Documentary results are recorded after observation; none is presumed from this plan.

T001 documentary delivery recorded on 2026-10-24: the exact structural spec command exited 0 with **one spec checked and zero acceptance checks executed**; the exact task command exited 0 with one active plan checked. Local document checks passed four references, six stable requirements with coverage, seven exact catalog check declarations, eight ordered tasks, the exact 22-path whitelist and three-path T001 boundary, final newlines, and no trailing whitespace. `git diff --check` for the three paths exited 0; explicit whitespace checks also covered these untracked new files. A read-only independent review found no material design drift.

Preservation checks matched all 91 pre-existing path hashes and their Git status; branch, HEAD and empty index remained unchanged. Only the three new T001 paths were added to the worktree. The first in-memory coverage helper failed JavaScript parsing before any command ran; its corrected documentary check passed. No repository validator or production code was changed to accommodate that helper.

Product tests, schema checks, typecheck, build, CI, audit, browser/runtime smokes, real-project preparation and process investigation/cleanup are **NOT RUN**. No commit, push, merge or state migration occurred. T001 is complete; the feature remains in progress with T002-T008 pending. The next decision is whether to authorize T002 and its exact scoped operations; documentary completion does not remove the separate workload-readiness precondition.

## T002 continuation and focused checkpoint

On 2026-10-24 the owner explicitly resumed T002 and its focused checks in the foreground, stopping at the first failed or unknown result. This continuation authorizes the five T002 contract/store/test paths plus this progress record only. It does not start T003, a campaign, the final gate, process cleanup, commit, push or merge.

The separately authorized read-only Q inspection observed the same recorded host at `2026-10-24T16:31:59.8591106Z`, uptime `20016656` ms, and an estimated boot at `2026-10-24T10:58:23.203Z`, after the recorded Q launch at `2026-10-18T12:18:11.193Z`. Original local processes/descendants from that launch cannot remain alive across that restart. This establishes operational closure for that launch, not a CI result or historical fixture cleanup. Q final acceptance remains UNKNOWN and its historical protected gate stays separate; no process was terminated or cleaned up. The owner then explicitly authorized foreground T002 checks using their own native completion result.

The implementation adds receipt types/schema/plain-data validation, global uniqueness and immutable owner bindings, and the conditional locked helper while preserving ordinary writes. Service/HTTP replay and UI identity wiring remain T003/T004. Existing Q tests are preserved, with a separate intake describe appended. Static independent review found no material issue before execution.

The authorized sequential checks are listed below; observed results follow them. Do not chain a successor after failure or unknown. `--bail=1` honors the first-failure stopping boundary without changing assertions or timeouts.

```text
pnpm exec vitest run lib/state/issues.test.ts --bail=1
pnpm schemas:check
pnpm typecheck
```

The first test invocation exited 1 before suite loading: EPERM while renaming a Vitest SSR cache file beneath the sandbox-provided temporary directory, with zero tests executed. Execution stopped, leaving schemas/typecheck not run at that checkpoint. The owner subsequently authorized only a process-scoped TEMP/TMP adjustment and one repeat of the same test command. That foreground repeat completed with **one file / 91 tests PASS, native exit 0, 10.50 s**. No code, assertion, guard or timeout changed for the repeat; TEMP/TMP were restored afterward. The owned parent `node_modules/.surtec-t002-temp-d839a819b77543bdbf858b5cf89a11c6` was retained without additional cleanup.

The owner then separately authorized `pnpm schemas:check`, followed by `pnpm typecheck` only on success. Both completed in the foreground with native exit 0: **63 JSON Schemas validated**, then **typecheck PASS**. No detached promise or old supervisor was reused, no failing/unknown result was followed by another command without a new human continuation, and the original EPERM remains recorded.

T002 is complete at its focused contract/persistence boundary. Its changes are the five listed source/schema/test paths and this progress record; the feature stays `in_progress`, T003-T008 remain unchecked, and manual intake is not yet wired to the receipt/helper. No manual local validation is required for this store-only slice; later service/UI and isolated browser acceptance remain mandatory in their authorized tasks. P/Q final acceptance is unchanged, with no campaign, process cleanup, commit, push, merge or normal-state migration.

No complete test suite, CI, audit, EVAL campaign, build or browser/runtime smoke is part of this focused continuation. The previous detached in-memory launcher is not used.

## T003 continuation and focused checkpoint

The owner explicitly authorized T003 and its focused checks in the foreground with owned TEMP/TMP directories, stopping at the first failed or unknown result. The write boundary is the four T003 service/API/test paths and this progress record only. The Q operational-closure observation above remains applicable; historical Q CI/fixture cleanup is still unknown. No old detached launcher, campaign, process cleanup, commit, push or merge is authorized.

The service reconstructs all 16 original normalized input fields in stable object-key order, preserves array order and existing defaults, and excludes generated state/request_id from its fingerprint. Keyed requests use the existing locked conditional writer; replay/conflict precedes create-only capacity/reference/classification-plan checks and returns the current issue without resetting or writing it. Internal unkeyed direct callers retain the ordinary writer and no retrospective receipt. HTTP requires a key and rejects caller-supplied receipts, preserving existing middleware and the 201 plus issue response contract.

Tests extend the existing files without changing previous assertions or timeouts. The new API test's initial-revision expectation was corrected during static review to 2, matching the existing proposal audit increment; no runtime revision behavior changed. UI callers remain for T004 and synthetic general-smoke callers for T006. Consequently this checkpoint does not claim that the current unkeyed form or full end-to-end intake is ready.

The authorized focused sequence is below, with each command awaited and its native completion required before the next. TEMP/TMP are scoped to the individual process tree and restored afterward; owned temporary parents are retained. Observed outcomes and separate continuations are recorded below.

```text
pnpm exec vitest run lib/state/issues.test.ts dashboard/src/server/issue-service.test.ts dashboard/src/server/index.test.ts --bail=1
pnpm schemas:check
pnpm typecheck
```

The initial sandboxed invocation exited 1 with 47 passing tests and two failures: the existing index HTTP/browser case could not connect to loopback (EACCES), and an existing service hardlink fixture was refused (EPERM). Execution stopped before schemas/typecheck. The owner separately authorized the identical focused command outside the sandbox. That repeat exited 1 with 370 tests passing and the new 500-issue capacity case timing out at the unchanged 5000 ms; two other files passed. Execution again stopped without a successor check or automatic repair.

The owner then approved optimizing only that fixture while preserving its 500 records, assertions and timeout. Preparation now keeps the original server-issued receipt and seeds 499 legacy clones with collision-free deterministic IDs in compact JSON; the exercised replay and capacity refusal still use the real locked validated store. A read-only independent review confirmed the scope. An oversized auxiliary capture was truncated and could not be parsed, so execution stopped before the test. A further explicit continuation corrected only that auxiliary read: the bounded 1267-character block comparison passed, including unchanged assertions/timeout. The isolated capacity test then passed outside the sandbox: one PASS, 190 excluded by the filter, native exit 0, 6.09 s total and 3.50 s in the test phase. No timeout, guard or assertion was relaxed.

Finally the owner explicitly authorized another complete T003 focused sequence outside the sandbox with owned TEMP/TMP, followed conditionally by schemas and typecheck. The three-file command completed in the foreground with **3/3 files and 376/376 tests PASS, native exit 0, 40.09 s**, without filtered/skipped cases. The existing finite index HTTP/browser guard test remained part of that focal file; no standalone smoke command or campaign was invoked. `pnpm schemas:check` then validated **63 JSON Schemas, exit 0**; `pnpm typecheck` then completed with **exit 0**. Each command supplied its own native result. TEMP/TMP were restored after each invocation; the latest owned parent `node_modules/.surtec-t003-tests-8bf748af18a84a418464ac930a57a31b` and earlier temporary parents were retained without additional cleanup.

T003 is complete only at the service/protected-HTTP boundary, with changes in its four listed files plus this progress record. Manual keyed replay is verified; the current form still needs T004 request identity handling, and the general-smoke HTTP callers still need T006. The feature remains `in_progress`, T004-T008 remain unchecked, and historical P/Q acceptance is unchanged. No manual repetition is required for the automated backend checks; real UI/browser acceptance remains required in its later slice. No paid call, normal-state migration, process cleanup, commit, push or merge occurred.

Do not launch the full suite, CI, standalone browser smoke or paid runtime in this slice. Stop immediately on a failed or unavailable native result, preserving the current code and evidence for a new human decision.

## T004 continuation and focused checkpoint

The owner explicitly authorized T004 and its focused foreground checks outside the sandbox with owned TEMP/TMP, stopping at the first failed or unknown result. The source boundary is the three T004 UI/API/test paths plus this progress record. No campaign, process cleanup, commit, push or merge is authorized, and T005 does not start automatically.

The form reserves a request UUID before POST, retains its frozen payload only in memory, and stores only the pending UUID in sessionStorage. Explicit retry reuses that identity and payload; reload reconciles through the existing GET without POST. Missing, malformed, stale or unreadable evidence leaves creation blocked. Explicit cancellation requires acknowledgement that the issue may already exist. Independent in-flight and generation guards fence duplicate submissions, obsolete responses and foreign stored identities. API helpers require caller-owned identity and validate renderable acknowledgements/collections before confirmation, without adding authority or new endpoints.

Static review found no material remaining issue after fencing a previously started refresh when POST confirms and protecting a newly appeared valid stored UUID from an unknown pending identity. Existing guards, assertions, test timeouts and opt-in browser behavior remain unchanged. Full real API/browser acceptance and smoke caller updates remain in T006/T008; no browser campaign flag is enabled in this slice.

The focused sequence below is conditional on each prior native exit 0. TEMP/TMP are process-scoped and restored after each invocation; owned parents are retained without additional cleanup. Results are not presumed from this list:

```text
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/components/ContextPreview.test.tsx dashboard/src/ui/components/WorkflowPanel.test.tsx --bail=1
pnpm typecheck
pnpm build
```

The three-file focused command completed in the foreground outside the sandbox with **3/3 files PASS, 209 tests PASS and one existing opt-in browser test SKIPPED, native exit 0, 22.74 s**. No browser opt-in flag was enabled. The new DOM/API cases cover UUID reservation and duplicate-submit fencing, exact frozen retry, reload/read recovery without POST or execution authority, unresolved absence/error/malformed evidence, acknowledged cancellation, storage failure/foreign identity, stale responses/unmount and strict response validation. The skipped browser case is not counted as passing real-browser acceptance.

`pnpm typecheck` then completed with **native exit 0**. `pnpm build` then completed with **native exit 0**; Vite reported 2107 transformed modules and 5.32 s build time, with a non-failing warning for an output chunk larger than 500 kB (516.68 kB). No chunk threshold or build configuration changed. Each command used the owned temporary parent `node_modules/.surtec-t004-tests-f5468684d2d3484f87286df9b3263281`, restored TEMP/TMP afterward and supplied its own native completion. No additional cleanup was performed.

Preservation checks matched all **91 out-of-scope baseline hashes and Git statuses**, with unchanged branch/HEAD and an empty index. Scoped `git diff --check` exited 0. T004 is complete at its focused UI/API boundary; the feature remains `in_progress` with T005-T008 pending. No manual repetition of these automated checks is required. Full real API/browser and reload/restart acceptance remains required in its later authorized slice; no full suite, schema campaign, CI, audit, standalone smoke, paid call, normal-state migration, process cleanup, commit, push or merge ran in T004. The change introduces no new endpoint, execution authority or persisted payload: only the UUID survives reload.

## T005 continuation and focused checkpoint

The owner explicitly authorized T005 and its focused foreground checks outside the sandbox with owned TEMP/TMP, stopping at the first failed or unknown result. Only `lib/context/sources.test.ts`, `dashboard/src/server/context-service.test.ts` and this progress record may change. T006, campaigns, process cleanup, commit, push and merge remain outside this continuation. The prior Q operational-closure observation remains applicable; no old launcher or process investigation is reused.

T005 demonstrates the existing mechanisms using contained synthetic selected README, architecture, ADR and contract sources. It adds test coverage without changing production context selection/service, registry routes, UI components, workflow authority, lifecycle, permissions, budgets or timeouts. Existing `workflow-api.test.ts` cases are reused unchanged for exact human plan decisions and obsolete/forged authority: workflow/issue revisions, decision ID and resource fingerprint, consent/root confirmation, restart and no writer/worktree effects before approval. Configured verification commands remain distinct from executed passing evidence.

The approved design's context/authority group is executed below with first-failure bail, followed by typecheck only after native exit 0. The existing optional workflow-browser flag is not enabled; finite HTTP and fake-executor fixtures in the focused file remain part of the group. Each command must supply its own native result. TEMP/TMP are scoped and restored; their owned parents are retained without additional cleanup. Results are recorded after observation, not inferred from these commands:

```text
pnpm exec vitest run lib/context/sources.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/workflow-api.test.ts --bail=1
pnpm typecheck
```

The three-file command completed in the foreground outside the sandbox with **3/3 files and 70/70 tests PASS, native exit 0, 98.36 s**, without filtered or skipped cases. Six new cases exercise complete contained selection, missing/oversized required sources, IDs/reasons/types and source-body hashes/bytes/lines, assembly limits, exclusion of unselected/other-project material, configured verification without execution evidence, source drift/restart issuance, exact scope/consent and unchanged fixture bytes/inventory. Static review strengthened the new privacy assertion to compare correctly escaped individual body lines inside serialized preview data before the first execution; no previous assertion or timeout changed. Existing workflow API cases supplied the human plan-gate proof, including zero worktree effects while waiting for exact Planner approval; its loopback/fake-executor integration ran without enabling the optional browser.

`pnpm typecheck` then completed in the foreground with **native exit 0**. Each command used `node_modules/.surtec-t005-tests-109ff33f3ded4ef583d2afca7e95098d`, restored TEMP/TMP afterward and supplied its own native terminal result. No failing or unknown result occurred in this focal sequence. Test-owned fixture hooks remained part of the tests; no additional directory/process cleanup ran, and the owned temporary parent was retained.

Preservation checks matched all **94 out-of-scope baseline hashes and Git statuses**, with unchanged branch/HEAD and empty index. Scoped `git diff --check` exited 0. Only the two approved test files and this progress record changed in T005; production context, policy and workflow files remain unchanged. T005 is complete at its focal evidence boundary; the feature remains `in_progress` and T006-T008 are pending. No manual repetition of the automated checks is needed.

Full-suite, schema, build, CI, audit and EVAL checks, plus standalone browser/runtime smokes, were **NOT RUN** in this task. Full F2 actual API/Vite/browser acceptance remains T006/T008, and the real-pilot human checkpoint remains mandatory for eventual closure. No new permissions, normal-state writes/migration, paid calls, campaigns, process cleanup, commit, push or merge occurred. T005 does not imply Q acceptance, P cutover or F3 readiness.

## T006 continuation and focused checkpoint

The owner authorized T006 and its focused foreground checks outside the sandbox with owned TEMP/TMP, without campaigns, cleanup, commit, push or merge. The initial implementation added the contained synthetic source fixture, its attribution assertions, keyed workflow creation and exact-plan refusals. A subsequent patch was aborted by the tool before dispatch; execution stopped without tests or typecheck, and T006 remained incomplete. The owner then explicitly authorized applying the pending block and running focused checks under the same boundaries. That tool interruption is not a product test failure or a passing check.

The write boundary is only `scripts/playwright-local-app-smoke.ts` plus this progress record. The pending coverage extends the existing real API/browser smoke with discarded acknowledgements after actual persistence, exact-identity retry, reload uncertainty/reconciliation, explicit cancellation, payload conflicts, distinct deliberate identities and replay after later progress/API restart. Test-owned source selection and human plan decisions reuse the current implementation. No production context service, global routes, authority, count of 31 fake turns, guards, deadlines or cleanup ownership may change.

The smoke's complete workflow campaign is not launched in this continuation. Focused regression checks select only the existing in-memory read-synchronization and Issues-refresh helper suites, excluding filesystem/process-cleanup cases and native Harness executions. Typecheck follows only on native exit 0. Each command runs in the foreground outside the sandbox with process-scoped owned TEMP/TMP restored afterward; no old launcher, campaign, process investigation or additional cleanup is used.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|Issues refresh)" --bail=1
pnpm typecheck
```

These checks do not execute or certify the new actual API/Vite/browser assertions. Their real acceptance, cleanup result and full-phase gate remain pending for separately authorized T008. Results below must distinguish selected helper tests from unexecuted smoke coverage; T007 is not started by this continuation.

The resumed implementation completed the pending block using smaller patches, without another aborted or unavailable operation. New assertions forward the original browser POST to the real fixture API, then replace only its acknowledgement with an unusable successful envelope; this proves lost application confirmation after persistence when the campaign eventually runs, not a simulated server write or a claim that every transport failure was exercised. The form snapshot/UUID, duplicate-submit fence, explicit identical retry, reload GET recovery, unknown-result acknowledgement/cancellation, missing/conflicting key refusal and distinct deliberate identities are covered in the script. Original-payload replay is also asserted after `done` and after the existing API restart using the renewed session token. Full-state/aggregate-byte comparisons and separate execution-store/worktree/executor hashes retain the original exclusions; no authority or source bytes are changed by intake. Existing form criteria, guards, deadlines, baseline Git checks and the 31-turn fake-runtime count remain intact. A final independent static review found no material issue; it is not browser execution evidence.

The exact filtered Vitest command completed outside the sandbox in the foreground with **one file PASS, 28 selected tests PASS and 70 tests SKIPPED by the explicit filter, native exit 0, 1.24 s**. The skipped cases include native Harness, filesystem/process-cleanup and unrelated smoke helpers; they are not passing evidence. `pnpm typecheck` then completed in the foreground with **native exit 0**. Both commands used the owned parent `node_modules/.surtec-t006-tests-8b653ecbea16498f825d8395373db727`, restored TEMP/TMP afterward and supplied their own terminal results. The selected helper suites used in-memory fixtures; no browser/API campaign or resource-cleanup test was executed. The temporary parent was retained without additional cleanup.

Preservation checks matched all **95 out-of-scope baseline hashes and Git statuses**, with unchanged branch/HEAD and empty index. Scoped `git diff --check` exited 0. T006 is complete at its implementation/focused-check boundary, with only the approved smoke script and this progress record changed. The feature remains `in_progress`, and T007-T008 remain pending. No manual duplication of the focused checks is needed; real API/Vite/browser acceptance and its owned cleanup outcome are **NOT RUN**, still required in T008. Full suite, schemas, build, CI, audit and EVAL campaigns are also **NOT RUN** in T006. No production permission/runtime/policy change, normal-state write/migration, paid call, process cleanup, commit, push or merge occurred. Historical P/Q acceptance and the real-pilot human checkpoint remain unchanged.

## T007 continuation and documentary checkpoint

The owner explicitly authorized T007 and documentary checks only, stopping at a failed or unknown documentary result. The write boundary is `docs/architecture/organization-state-migration.md`, `docs/runbooks/local-work-issues.md`, `docs/runbooks/factory-request-contract-acceptance.md`, `docs/roadmap/factory-local-poc.md` and this progress record. No T008, product check/campaign, process investigation/cleanup, commit, push or merge is authorized.

The compatibility/runbook additions describe the implemented additive receipt, locked replay/201 response, unchanged authority and explicit UI uncertainty recovery without rewriting historical phase evidence. The new acceptance runbook maps all six requirements to observed focused results and still-pending actual API/Vite/browser/full-gate/human-pilot evidence. The roadmap now reflects the separately approved F2 continuations; old F0 findings remain historical, P stays partial/deferred and Q final CI stays UNKNOWN despite its established operational launch closure. The roadmap reader made no changes or documentary checks before its coordination wait ended before dispatch; the parent completed that document directly within the same authorized scope.

The structural commands below execute no acceptance commands: neither `-Run` nor `-ConfirmExecution` is supplied. Additional read-only documentary checks cover local Markdown file/anchor references, six-requirement/evidence mapping, seven unchanged catalog commands, T001-T008 order/boundaries and the 22-path whitelist, whitespace/final newlines and unchanged baseline files outside T007. Commands for the future T008 gate printed in the documentation are data, not execution requests. Outcomes are recorded only after observation.

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -SpecPath .agents/specs/factory-request-contract.spec.yaml
pwsh -NoProfile -File .agents/scripts/validate-tasks.ps1 -TasksPath .agents/specs/tasks/factory-request-contract.tasks.md
```

Both structural commands completed with native exit 0: **one spec structurally checked, zero acceptance commands executed**, then **one active task plan validated**. The in-memory read-only document checker completed with native exit 0 across **five documents, 39 local references, three anchors, six requirement mappings, seven unchanged catalog commands, eight ordered tasks and the exact 22-path whitelist**, with valid whitespace/final newlines. Scoped `git diff --check` exited 0. An independent static review found no material discrepancy with current code or the recorded focused evidence; it is not a product acceptance result.

Preservation checks matched all **94 out-of-scope baseline hashes and Git statuses**, with unchanged branch/HEAD and empty index. Only the four T007 documents and this progress record changed. T007 is complete at its documentary boundary; F2 remains `in_progress` and T008 is unchecked/not started. No manual repetition or browser inspection is needed for the documentation-only change. Product tests, schema execution, typecheck, build, CI, audit, EVAL/browser/runtime campaigns, normal-state writes/migration and process investigation/cleanup were **NOT RUN** in T007. No permissions, guards, timeouts, catalog or runtime changed; no paid call, commit, push or merge occurred. Full contract acceptance, owned smoke cleanup and the human real-pilot checkpoint remain pending under separate T008 authority.

## Future done gate - not authorized by T001, T002, T003, T004, T005, T006 or T007

After explicit continuation, confirmed execution readiness and actual check authorization:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

The spec lists seven exact catalog commands with expected exit 0. These are planned expectations, not results. Run the complete suite only once in that gate; keep the existing timeout defaults/ceiling, assertions, guards, environments and budgets. The design records three focused test groups, plus separate `pnpm harness:check` and `pnpm smoke:local:playwright`; they are not T001 documentary commands or catalog additions. Actual browser acceptance uses isolated API/Vite, synthetic repositories, fake execution and only owned fixture cleanup.

Stop at the first failed or unknown acceptance result without automatic reruns, profiling, repair outside scope or softened checks. Intentionally observed behavior RED within an authorized test-development cycle remains distinct from failed acceptance. Missing tools or unavailable native completion are not passing checks.

The original Q launch's operational closure is established by the separately authorized read-only boot observation recorded above; its native CI result and historical fixture cleanup remain unknown. New commands must supply their own terminal result. Any new unknown launch requires bounded ownership/closure resolution before retry; do not infer process liveness or reuse the former detached launcher. Preserve Q's original protected gate PASS separately from its final CI UNKNOWN and conditional audit/smokes NOT RUN. P T015-T026 remain deferred.

Full F2 completion additionally needs Marcos to identify the real project/request, criteria, sources and trusted commands. Fixture success with that checkpoint pending is a partial contract result, not full F2 completion or F3 readiness. No real issue creation, paid turn, integration or publication follows automatically. Do not mark this feature done on skipped checks or a missing human checkpoint.

## T008 authorized acceptance execution

The owner explicitly authorized T008/full F2 acceptance with 900 seconds per command, outside the sandbox, owned TEMP/TMP and foreground native completion, stopping at the first failed or unknown result. No guard/timeout change, commit, push or merge is authorized. The ordered sequence is the exact seven-check spec gate once, then the separate Harness check only on success, then the isolated real API/Vite/browser smoke only on success. Existing fixture-owned teardown belongs to the authorized acceptance lifecycle; unknown process cleanup, paid calls, CI/audit reruns and F3 work remain outside scope. Evidence updates are restricted to this task plan, the F2 acceptance runbook and the active roadmap.

The starting checkout has 99 changed/untracked paths, the [phase-Q branch recorded in the baseline](../../../docs/roadmap/factory-local-poc.md), HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5` and an empty index. Pre-existing work is preserved. The Q boot observation above establishes operational closure only; its historic CI result/fixture cleanup remain unknown. The current Harness drains child output to null and returns native exits; no detailed Vitest counts/errors may be inferred from that discarded output. Every current invocation must supply its own terminal result; no old launcher, profiling or additional retry is used.

The owner intends to prepare a real feature in an existing remotely hosted or local project and will describe its behavior and desired result. Project identity and the concrete request are not yet supplied. The agent can derive proposed paths, sources, criteria and trusted checks by inspecting the selected project for human review; the owner is not required to know those implementation details in advance. This pending checkpoint does not block synthetic acceptance, but prevents full T008/F2 closure and authorizes no real issue or model turn. Results will be recorded after observation; T008 remains unchecked.

The single authorized gate invocation completed with **native exit 1** and the validator message **Acceptance check timed out; process tree terminated**, using the configured **900-second per-command ceiling**. No `[OK] acceptance` result was emitted. The first catalog command is `pnpm test`; no passing gate check, test count, concrete assertion failure or Vitest duration can be established from the discarded child output. This is a failed gate/timeout result, not a claimed zero-test run or a diagnosis of the underlying cause. Execution stopped without rerun, additional diagnostics, guard/timeout changes or successor checks.

The separate `pnpm harness:check` and `pnpm smoke:local:playwright` are **NOT RUN**. No full F2 real API/Vite/browser result or fixture-cleanup success exists. The validator reported terminating its owned process tree; suite-fixture teardown was not independently established. TEMP/TMP restoration remained in the outer `finally`; the owned parent `node_modules/.surtec-t008-temp-c865bc6e74144c3c9fbed66e1daa7cb3` was retained without additional cleanup. No post-failure status/hash/check command was run; only these authorized evidence documents were updated to record the result.

During the run, the owner identified a private existing project and described dynamic availability/appointment rescheduling as the real request. Read-only preparation established only partial context: its checkout-status inspection failed, so the real baseline and proposed technical scope/checks remain unconfirmed. That inspection stopped without project edits, tests, provider access or messages; no private source body is copied here. The owner-supplied identity and business need remain in the conversation for the next reviewed step. T008/F2 remain incomplete; historical P/Q results, F3 authority and publication boundaries are unchanged. No commit, push or merge was invoked for this workspace.

## T008 visible diagnostic preparation - synthetic checkpoint

The owner approved the bounded ephemeral-launcher design and authorized implementation plus synthetic checks only, retaining 900 seconds and stopping on an unexpected failed/unknown check. No real diagnostic, acceptance rerun, guard/timeout change, commit, push or merge was authorized. Four files were created only under the unique ignored root `node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56`: `core.mjs`, `runner.mjs`, `synthetics.mjs` and `launch.ps1`. These are local diagnostic artifacts, not new Harness/catalog entries or published project sources.

PS7 owns a `Diagnostics.Process` for the diagnostic Node root and its descendants, with the literal `WaitForExit(900000)`/owned `Kill(true)` guard. The child test invocation is fixed to the standard Node/pnpm entry plus `test --reporter=verbose --includeTaskLocation`; environment construction mirrors the existing allowlist and `CI=1`, with only owned TEMP/TMP overrides. The observer imports the existing redactor, decodes each stream independently, suppresses private/unknown payload lines and bounds visible and retained evidence to 32 KiB each. It distinguishes native exit, deadline and both EOFs; exit zero with incomplete streams cannot pass. Default/import/synthetic paths cannot start the real suite. Real mode requires both explicit diagnostic flags and a new human continuation.

All four artifacts passed syntax checks (the final core revision was checked after static corrections). The sole synthetic invocation, `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -SyntheticChecks`, completed in the foreground outside the sandbox with **29/29 synthetic cases PASS, native exit 0**. The supervisor reported mode `synthetic`, `acceptance: false`, `deadline_ms: 900000` and 407 ms supervisor wall time. Deadline cases used fake clocks/process emitters; no real suite, API, browser, provider or cleanup ran. Synthetic coverage includes env/argument preservation, native failure, timeout, incomplete EOF, non-executing mode guards, UTF-8/chunk redaction, paths/private bodies, large concurrent output and retained failure markers.

Before evidence updates, all **99 baseline path hashes/statuses**, branch/HEAD and empty index matched; five additional hashes for common/validator/config/package/redactor also matched. No tracked implementation or guard was changed. The owned temporary artifacts remain in place without deletion. Only this plan, the F2 runbook and active roadmap receive durable evidence. The original gate timeout remains FAIL; a real diagnostic is **NOT RUN**, full acceptance is not resumed, and T008/F2 remain incomplete.

| Local ephemeral artifact | SHA-256 |
| --- | --- |
| `core.mjs` | `A928A4E0C77A6EDE6AC569533EDF34F1BA764ABFC996C549364290BDD22711EC` |
| `runner.mjs` | `76F2B818A37DE67FCB13BDD00A6536DB17B8E7E3A3765B5F3707C616502CA0A0` |
| `synthetics.mjs` | `B7C7F4EBE49AE62F2DEBE0DA73269AFBB55D7818F4F92F29093ABD5683D2D40F` |
| `launch.ps1` | `2C8D6FFD8549FB49087448041A41FAD59206E5AAEE047D929C7BE04220D6A56F` |

## T008 single visible diagnostic - timeout checkpoint

On 2026-10-24, the owner explicitly authorized one real diagnostic using the validated ephemeral launcher, visible bounded output, unchanged 900-second ceiling, foreground execution outside the sandbox and owned TEMP/TMP. The fixed child command was `pnpm test --reporter=verbose --includeTaskLocation`. The four local launcher artifacts and five guard/config/redactor hashes matched their validated baseline before launch. This diagnostic was not a spec gate, CI run or acceptance retry.

The single invocation completed with **native exit 124**. The supervisor reported `status: deadline`, `deadline_ms: 900000`, `owned_tree_termination_requested: true` and `fixture_cleanup: unknown`. The inner diagnostic reported `status: timeout`, `deadline_reached: true`, `root_exit_seen: false`, both stream EOF flags false and no observed stream failure; its observation interval was 899418 ms. That interval and the supervisor deadline have different start points. No successful native Vitest exit, complete stream closure or final suite summary was established.

The bounded first-failure buffer retained these four markers; its capacity is four, so this is not a total failed-test count:

| Source location | Retained failing case | Reported case duration |
| --- | --- | --- |
| `lib/git-status.test.ts:74:3` | `readGitStatus > returns ok:false for a non-repo directory` | 334 ms |
| `runner/verify.test.ts:125:3` | `interruptible infrastructure verification > bounds checks by remaining runtime and kills the process tree` | 5986 ms |
| `runner/workflow-orchestrator.test.ts:328:118` | `finite workflow controller integration > runs only the exact first read-only implementation stage and retains a human gate` | 5174 ms |
| `runner/workflow-orchestrator.test.ts:506:3` | `finite workflow controller integration > different workflow issues share one project writer while an independent read-only role uses spare capacity` | 5185 ms |

These markers establish failed cases, not their complete assertion errors or causes. The observer counted 1182458 stdout bytes and 6308 stderr bytes; visible/retained output was bounded and marked truncated while draining continued. Its last retained successful progress was `dashboard/src/ui/App.test.tsx:480:3`; with two configured workers, that does not identify a blocked test or establish where all remaining execution time was spent. No total passing/skipped/failed count or full-suite duration is available.

After observing the first failure, no successor check, repair or additional launch was started; only this same invocation's terminal result was collected. No gate, CI, Harness, schema/type/build command, browser/runtime smoke, process investigation, additional cleanup or rerun followed. Owned termination was reported as requested, not independently verified fixture teardown. The temporary root was retained. No post-result status/hash/validation check ran; only the three already authorized evidence documents were updated. Guards, timeouts, catalog and product code were not changed; no commit, push or merge occurred. The original gate remains FAIL, separate Harness/browser acceptance remains NOT RUN, and T008/F2 remains incomplete.

## T008 focal-launcher implementation - stopped before synthetic checks

The owner approved a bounded seven-file continuation: the four existing ephemeral artifacts and the three existing T008 evidence documents. Only synthetic checks were authorized, retaining 900 seconds and stopping at failure or unknown; no real focal run, suite, gate, CI, publication or cleanup was included. The pre-edit baseline supplied native exit 0 with 99 changed/untracked paths, the same branch/HEAD, an empty index and five recorded guard/config/redactor hashes.

Implementation stopped when `apply_patch` rejected a `launch.ps1` patch because its expected context incorrectly used `-or` where the existing source uses `-and`. That rejected patch did not apply. The editor error is not a product-test failure, a successful validation or a changed execution guard. No automatic correction or check followed. The implementation agents stopped and reported edits only to `core.mjs`, `runner.mjs` and `synthetics.mjs`; `launch.ps1` remains at its earlier version. The mixed artifact set is incomplete and must not be used for a real diagnostic.

The partial edits introduce fixed focal selections, ownership validation, coverage/error metadata and adapted in-memory fixtures. The synthetic agent reported 37 declared cases, but this is unverified source inventory, not an executed count; further coverage/error cases and final static review remain pending. Syntax checks and synthetic execution are **NOT RUN**. Only these three authorized evidence documents record the stop; no post-failure status/hash/validation command, real workload, process probe/cleanup, guard/timeout change, commit, push or merge followed. Original gate FAIL, diagnostic timeout, unknown historical fixture cleanup and incomplete T008/F2 remain unchanged. A reviewed continuation is needed to finish the launcher before any checks or real launch.

## T008 focal-launcher completion - synthetic checkpoint

The owner explicitly authorized correcting the rejected launcher patch, completing the same seven-file scope and running synthetic checks only, stopping on failure or unknown. The `launch.ps1` patch then applied successfully with its original real-mode conjunction preserved. The four ephemeral artifacts are now integrated; this checkpoint supersedes the immediately preceding incomplete-artifact warning for the hashes below, not any historical acceptance result.

Future real mode requires both diagnostic flags and exactly one closed selection: `git-nonrepo`, `verify-runtime`, `workflow-first-stage` or `workflow-capacity`, with expected selected counts 1/1/3/1. Each command fixes the file and test-name pattern, uses the standard verbose reporter with `--includeTaskLocation` and `--bail=1`, and cannot select the full suite or accept arbitrary commands. Missing/duplicate/skipped selected cases, unexpected active cases and absent/inconsistent terminal summaries remain unknown. Native zero and complete streams alone cannot satisfy coverage.

Artifacts stay in their existing ignored root. Only future real mode creates a fresh owned fixture parent under the host's local temporary directory, outside Git worktrees. PowerShell and Node validate ownership, normal ancestors, no redirects/links, `.git` absence and the closed bounded ownership marker; only ENOENT proves marker absence. The same fixture TEMP/TMP reaches Node and the pnpm child without broadening the environment allowlist. Synthetic mode creates no external fixture, Git probe or real pnpm/Vitest child. Its injected filesystem/process/clock facts test these branches without exercising a real filesystem qualification or process-tree kill. Prior temporary roots are retained without cleanup.

The projector reserves bounded error metadata independently of rotating progress: only an explicit matching FAIL block on the same channel binds a case. Categories, public error classes/codes, message digests and repository source locations remain bounded; private bodies, expected/actual payloads and absolute paths stay omitted. An ambiguous test/hook/teardown phase remains unknown. Capture limits remain 32 KiB visible and 32 KiB retained; the existing 900000-ms deadline, literal `WaitForExit(900000)` and owned `Kill(true)` guard are unchanged. No production code, test assertions, Vitest configuration or Harness/catalog/pin changed.

Independent static review found no material discrepancy across the four files; that review is not execution evidence. The sole resumed check command was:

```text
pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -SyntheticChecks
```

It completed outside the sandbox in the foreground with **53/53 synthetic checks PASS, native exit 0**, no skipped cases and supervisor `status: completed`, `mode: synthetic`, `acceptance: false`, `deadline_ms: 900000`, `exit_code: 0`, `wall_ms: 697`. The 29 earlier checks were retained with the approved argument-contract adaptations; new cases cover closed selections, exact coverage, failure attribution/privacy, bounded output and fake ownership/ancestry/marker behavior. Expected fake failures/timeouts/unknowns are asserted negative cases, not failed checks. No standalone syntax, typecheck, schema, build or product-test command ran.

Before these evidence updates, preservation matched **all 99 baseline path hashes/statuses**, the five guard/config/redactor hashes, unchanged branch/HEAD and empty index. The four artifact hashes below identify the completed synthetic-tested revision. This invocation did not execute the four real focal selections, a full suite, gate, CI, Harness, browser/runtime smoke, process probe/cleanup, paid call, commit, push or merge. The original gate remains FAIL, the earlier diagnostic remains a timeout with unconfirmed fixture cleanup, and T008/F2 remains incomplete. Its four product-test failures and global timeout cause require later authorized investigation; synthetic success does not resolve them or grant a real launch/F3 authority.

| Completed local ephemeral artifact | SHA-256 |
| --- | --- |
| `core.mjs` | `BB47396F8AD99AA6D4456B570FFD4A3368EA4E0E388A4B9747392AD4E708D33A` |
| `runner.mjs` | `F02E8D184BF1953A07BD6BA893ACEF05A14FBAAF6EB12647C4A50B121108E280` |
| `synthetics.mjs` | `EA78D107A6DA9BBCA8B83D7D0E8FAD65E379B997FE02B0AF604768655804BBE9` |
| `launch.ps1` | `6C1267BDD2432B35AFDF33A93E7484600B17B1725C29DC80A9E8966E6A06043C` |

## T008 four authorized focal selections - completed

The owner explicitly authorized the four closed selections in order, outside the sandbox with owned TEMP/TMP and the existing 900-second guard, stopping at the first failed or unknown result. No source/guard/timeout modification, CI, commit, push or merge was authorized. Preflight matched the four synthetic-tested artifact hashes and five guard/config/redactor hashes; the baseline remained 99 changed/untracked paths, the same branch/HEAD and an empty index. Each invocation started only after the previous native result, EOFs, exact coverage, selected statuses and terminal summaries were confirmed.

The fixed invocation form was `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection <selection>`, once for each value below. These are four focal commands, not the formal acceptance gate or CI.

| Order / selection | Selected PASS | Filtered SKIP | Native exit | Vitest reported duration | Supervisor wall time |
| --- | --- | --- | --- | --- | --- |
| 1. `git-nonrepo` | 1 | 4 | 0 | 627 ms | 2206 ms |
| 2. `verify-runtime` | 1 | 17 | 0 | 4.12 s | 5371 ms |
| 3. `workflow-first-stage` | 3 | 74 | 0 | 15.66 s | 17064 ms |
| 4. `workflow-capacity` | 1 | 76 | 0 | 6.27 s | 7592 ms |

All four supplied `status: passed`, `coverage: complete`, the expected 1/1/3/1 unique selected cases all passed, zero failed cases in their terminal summaries, native exit 0, `root_exit_seen: true`, both EOF flags true, no reached deadline or stream failure, and supervisor `completed/exit_code: 0`. No truncated output or attributed failures were reported. The three first-stage variants were analysis, implementation and operations-investigation. Six distinct selected cases passed; filtered skips are not passing evidence and must not be summed as unique skipped tests because the workflow file was selected twice. Observer wall intervals were 1915/5117/16792/7326 ms respectively and use a different start point from the supervisor and Vitest durations.

The retained per-case durations were Git non-repository 57 ms; bounded verification 3268 ms; first-stage analysis 4322 ms, implementation 4889 ms and operations-investigation 3167 ms; shared capacity 3539 ms. These identify potentially expensive fixtures, not the cause of an earlier assertion failure or of 900 seconds of aggregate suite execution. In particular, a passing isolated implementation case of 4889 ms does not prove how it behaved under the earlier full-suite load. No test assertion, fixture implementation, runtime cap, concurrency configuration or existing timeout was changed.

The real-mode temporary qualification ran before every test child: artifacts remained in the ignored checkout directory, while each invocation created a fresh owned temporary parent outside worktrees and propagated it through both process levels. Selected tests used their existing contained fixtures/fakes and hooks. The four launcher roots/pnpm children closed with complete pipes; fixture-owned hooks were not independently audited afterward. No additional process or directory cleanup/probe was performed, and the four owned temporary parents were retained. This establishes current native closure, not historical fixture-cleanup success.

Before these evidence updates, preservation matched all **99 baseline path hashes/statuses**, five guard/config/redactor hashes, four launcher artifact hashes, branch/HEAD and empty index. Only the three authorized evidence documents record this outcome. No guard/timeout/source change, repair, automatic rerun, full suite, gate, CI, audit, Harness/browser/runtime smoke, paid call, commit, push or merge ran. The four previous failures were not reproduced under these isolated conditions; this is not proof they cannot recur. The original gate remains FAIL, the earlier diagnostic remains a 900-second timeout, and the aggregate timeout cause is unresolved. T008/F2 remains incomplete pending complete acceptance and the real-pilot technical checkpoint; P/Q history and F3 authority are unchanged.

## T008 workflow fixture cost reduction - focused checkpoint

The owner approved a four-path continuation: `runner/workflow-orchestrator.test.ts` and the three existing T008 evidence documents. The authorized sequence was isolation regressions, the two workflow selections and typecheck only after those passed, stopping at the first failed/unknown result, with 900 seconds per command. Before edits, all 99 baseline records matched the previous checkpoint, with unchanged branch/HEAD, empty index, five guard/config/redactor hashes and four synthetic-tested launcher artifact hashes.

The test file now lazily captures only the original public bytes/path inventory of four registry YAML files and required evaluation fixtures in a private closure. It parses the role manifest once and writes fresh normal files exclusively into every new case root. No Buffer is exposed to tests; no issue, authorized scope, workflow, task, preview issuance, approval, decision, grant, lease, counter, controller or worker is cached across cases. `ensureBaseIssue` still creates/authorizes within its original case boundary, and `completeFirstReadOnlyStage`, its structural assertion, the original dispatch/wait, all prior assertions and timeouts remain intact. In the capacity case, one fresh task snapshot is reused only inside its synchronous callback and one fresh task collection supplies running/queued filters; later reads after actions remain fresh.

Two new cases in `workflow fixture input isolation` prove byte-equivalent files/exact public inventory and independence of cached inputs, original sources, sibling copies and later materializations after a case-local mutation. They assert normal files and absent state/workers without creating an issue or invoking the workflow fixture. Existing teardown still stops its own workers, restores test environment/mocks, removes the owned case root and asserts its absence. Static independent review found no material discrepancy; no review alone was treated as a passing check.

The authorized commands ran once each, in this order:

```text
pnpm exec vitest run runner/workflow-orchestrator.test.ts --testNamePattern "workflow fixture input isolation" --bail=1 --reporter=verbose --includeTaskLocation
pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection workflow-first-stage
pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection workflow-capacity
pnpm typecheck
```

| Check | Selected PASS | Filtered SKIP | Native exit | Vitest duration | Supervisor wall time |
| --- | --- | --- | --- | --- | --- |
| Public fixture isolation regressions | 2 | 77 | 0 | 2.89 s | 4189 ms |
| `workflow-first-stage` | 3 | 76 | 0 | 12.62 s | 13897 ms |
| `workflow-capacity` | 1 | 78 | 0 | 6.13 s | 7387 ms |
| Typecheck | Not a test selection | Not applicable | 0 | Not applicable | 20085 ms |

All four ran in the foreground outside the sandbox with a distinct qualified owned TEMP/TMP parent outside worktrees, the same environment allowlist and the unchanged 900000-ms guard. The regression/typecheck commands used a fixed two-command invocation held only in memory, reusing the existing redactor/projector, lifecycle observer and temporary ownership validator; no additional launcher file, arbitrary selector or Harness/catalog change was introduced. Its PS Process owner preserved `WaitForExit(900000)` and owned `Kill(true)` semantics. Both workflow selections reused the existing unchanged launcher. Each result supplied native exit 0, root exit seen, both EOFs, no reached deadline or stream failure and a completed exit-0 supervisor. The regression result was additionally checked for the exact two passing names and coherent one-file/two-test summary; the existing workflow receipts supplied exact 3/1 selected coverage, all passed. Filtered skips overlap across this file and must not be added as unique tests. No hidden or skipped product case is claimed passed.

Observed first-stage case durations were analysis 3061 ms, implementation 4086 ms and operations-investigation 2759 ms; capacity was 3413 ms. The immediately prior isolated observations were 4322/4889/3167 ms and 3539 ms. These different runs are not a controlled benchmark and do not establish a causal speedup, guarantee a future pass or explain the 900-second full-suite timeout. The new regressions took 78/63 ms. No profiling flag was enabled and no performance target or timeout was altered.

Before evidence updates, all **98 baseline paths outside the approved test file**, five guard/config/redactor hashes, four launcher artifact hashes, branch/HEAD and empty index matched. The tested file SHA-256 is `016FAAA9000E62BBDC3C0529C4A7C7954A394654B2CE631C9849CBA06D057E58`. Only the approved test file and these three evidence records changed. Native closure is established for these four launches; existing selected-case teardown assertions passed, without an additional process/filesystem cleanup audit. Owned temporary parents were retained without extra cleanup. Historical fixture-cleanup uncertainty is unchanged.

This focused continuation is complete. No automatic retry, whole test file/full suite, formal gate, CI, schemas/build/audit/Harness/evals/browser/runtime smoke, paid call, normal-state migration, process probe/cleanup, commit, push or merge ran. The original formal gate remains FAIL, the old diagnostic timeout and global cause remain unresolved, and complete F2 acceptance plus the private real-pilot technical checkpoint are still pending. T008 remains unchecked and F2 `in_progress`; these focused checks grant no automatic acceptance retry, P/Q closure or F3 authority.

## T008 renewed closure attempt - 2026-10-25

The owner asked to finish the remaining T008/F2 work, renewing authority for the original acceptance sequence while preserving 900 seconds per catalog command, owned TEMP/TMP outside worktrees, foreground execution and stopping at the first failed/unknown acceptance result. No guard/timeout modification, paid call, CI, commit, push or merge was included. Preflight supplied native exit 0: 99 baseline changed/untracked paths, the [phase-Q branch recorded in the baseline](../../../docs/roadmap/factory-local-poc.md), HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, empty index, matching five guard/config/redactor hashes and four launcher hashes, and the exact previously tested workflow-test hash `016FAAA9000E62BBDC3C0529C4A7C7954A394654B2CE631C9849CBA06D057E58`.

The original command was invoked once through a foreground PS Process with a fresh qualified owned external temporary parent:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

The original validator retained its existing per-command guard. No 900-second aggregate guard was imposed on the seven-check gate. The outer process received the established allowlisted environment, `CI=1` and owned TEMP/TMP, with no source/catalog changes. Its native result was **exit 1**, and the outer stopwatch reported **1839 ms**. Only outer `T008_GATE_START` and `T008_GATE_RESULT` metadata were available; no validator error, `[OK] acceptance` or structural/check result was captured. The internal command/stage and underlying cause are therefore **UNKNOWN**. This is a failed gate invocation with incomplete internal evidence, not another observed 900-second timeout, a proven test assertion failure, a passing check or proof that no tests started. The outer wrapper used inherited child output handles, and the available output cannot reconstruct the missing child stdout/stderr.

The outer validator process supplied native terminal status and was disposed; internal test activity and fixture teardown were not established from its missing output. The owned temporary parent was retained, without extra cleanup. The acceptance sequence stopped without repair, retry, further diagnostics, post-failure status/hash checks or successors. `pnpm harness:check` and the real F2 `pnpm smoke:local:playwright` remain **NOT RUN**. No complete gate, new test totals or API/browser acceptance can be inferred.

In a separate non-blocking read-only pilot-preparation branch, repository instructions and Git metadata were inspected without reading private source bodies or credentials. A single attempted baseline qualification used an explicit working directory and scoped child Git environment, but its wrapper returned native exit 1 and absorbed the child error before reporting it. The exact failing subcommand/stderr remain unknown. That branch stopped without retry, code inspection, edits, tests, provider calls or cleanup. The human-supplied project/business request remains available in the conversation, but the private baseline, technical paths/criteria/sources/trusted commands and their specific approval are still unconfirmed. No private source, configuration body or filesystem path is copied here; no real issue/model turn was created.

Only these three already authorized evidence documents record the two outcomes. No guard/timeout/source/runtime change, process probe/cleanup, CI, paid call, commit, push or merge followed. The previous focused PASS results remain historical evidence, and both formal-gate failures retain their distinct facts. T008 stays unchecked and F2 `in_progress`; current invocation-error capture and the private pilot checkpoint must be resolved under a reviewed continuation before claiming full closure. P/Q outcomes and F3 authority remain unchanged.

## T008 exact invocation-error diagnosis - no suite, 2026-10-25

The owner explicitly authorized recovering the invocation error without repeating the suite. The original retained output contained only the outer gate start/result metadata; the historical child stdout/stderr cannot be reconstructed after being lost through inherited handles. Diagnosis therefore reproduced only the pre-execution path, with captured streams, the same cleared environment allowlist and owned external TEMP/TMP. No acceptance retry, source repair, dependency installation or environment-policy change was included.

Read-only parent inspection found PowerShell 7.6.5 and available `powershell-yaml` 0.4.12 candidates. The common/validator hashes still matched the prior baseline. A separately reviewed structural-only invocation used the original validator with `-SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900`, without `-Run` or `-ConfirmExecution`. Static review confirmed `$invocations` remains empty in this mode and catalog validation never starts a command. It completed with **native exit 0, 1099 ms**, stdout `[OK] specs: 1 structurally checked; 0 checks executed`, empty stderr and both EOFs. This verifies the current initialization/spec/catalog path, not acceptance.

Next, a fixed read-only child reproduced the original executable-resolution statements only: resolve `pnpm` as an Application, check its standard `pnpm.cjs` entry, then resolve `node` as an Application. It never invoked any resolved executable. In the same sanitized environment, the first two steps passed and the third failed with **native exit 1, 866 ms**, stage `resolve-node`, category `ObjectNotFound` and error ID `CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand`. Captured stderr was:

```text
The term 'node' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again.
```

The diagnostic supplied both EOFs and non-truncated output; `commands_executed` was zero. PATHEXT was present in this child, so its absence must not be asserted as the observed cause. The reproduced error locates a pre-launch Node-resolution failure in the validator environment. It does not recover the lost historical bytes or prove the detailed PATH/module-resolution cause, nor establish that Node is absent from the host. No module or Node installation is justified merely by this message. The current structural PASS also does not support blaming a missing YAML module.

Diagnosis stopped after obtaining the exact pre-launch error. No project Node/pnpm command, test, full gate, CI, Harness/browser/runtime smoke, paid call, sibling operation, process cleanup, commit, push or merge ran. No guard/timeout, PATH, runtime, catalog or launcher source was changed. Both qualified temporary parents were retained. Only the three T008 evidence documents record the result; no post-diagnosis status/hash check or automatic retry was performed. The next reviewed step is explicit Node-resolution preparation for the validator host before considering an acceptance retry. T008 remains unchecked, F2 `in_progress`, and full acceptance plus private-pilot technical confirmation remain pending; historical P/Q outcomes and F3 authority are unchanged.

## T008 validator Node preparation - verified before gate, 2026-10-25

The owner authorized explicit Node preparation for the validator process and verification before resuming the gate. This slice remained host setup/readiness only: no full gate or project test was launched. Parent lookup resolved an existing fully qualified Node application; its directory was already literally present in PATH, which contained no variable references. The common/validator hashes remained the recorded `0E53774071A5414E13F60954489700ED1FB3388D594528CC388E2A488BE959EB` and `83495C3DEF7625C33534688CEBB1E6046F51FEED98805D89B70954D3102AD55C`.

A read-only child inventory under the former sanitized environment completed with native exit 0 in 790 ms and no programs executed. It showed `node.exe` and the expected absolute file resolving, but bare `node` not resolving. The observed child PATHEXT was exactly `.CPL`, without `.EXE`; the bare pnpm candidate also did not match the parent candidate. This narrows the reproduced lookup failure to the executable-extension environment, rather than evidence that the host needs a Node installation or another PATH prefix.

Preparation now resolves the expected Node and pnpm application paths in the parent, verifies the Node file, validates that the parent's PATHEXT admits `.EXE`, and copies that PATHEXT into `ProcessStartInfo.Environment` for the temporary validator host. The global environment, original PATH, Harness scripts/catalog, runtime policy and project-child variable allowlist are unchanged. Existing Harness child environment construction still applies independently; no new variable was added to its allowlist. Expected executable identities are checked so that restoring lookup cannot silently select a different pnpm shim or Node installation.

An initial readiness attempt failed before executing its child check with ParserError caused by the in-memory script assembler interpreting a replacement string's dollar/quote sequence. Only that packaging was corrected using literal replacement callbacks, without changing the intended environment preparation, source files, guards or timeouts. This was not a product-test failure or another suite run.

The corrected readiness probe completed with **native exit 0 in 551 ms**, both EOFs, empty stderr and no truncation. Node and pnpm matched the parent-resolved applications, the standard pnpm JavaScript entry existed, and absolute `node --version` returned **v24.16.0 / exit 0**. Exactly one version-only Node process ran; zero spec acceptance checks, pnpm scripts or tests ran. The version is observed evidence, not a newly pinned runtime requirement.

Then the original structural-only validator, still without `-Run` or `-ConfirmExecution`, ran under that prepared host environment and completed with **native exit 0 in 1050 ms**, `[OK] specs: 1 structurally checked; 0 checks executed`, both EOFs, empty stderr and no truncation. Both checks retained the unchanged 900000-ms owned-process guard and qualified owned external TEMP/TMP. Temporary parents were retained without extra cleanup.

An updated gate invocation is prepared only in memory, with explicit expected Node preparation, host-only parent PATHEXT and redirected concurrent stdout/stderr capture. It retains the original seven catalog commands and validator's 900 seconds PER command, with no shorter aggregate deadline. No launcher file or Harness source was persisted or repinned. This prepared full-gate invocation was **NOT EXECUTED**. Only the three evidence documents record this readiness result. No suite, CI, Harness/browser/runtime smoke, paid call, sibling operation, dependency installation, global PATH/environment change, commit, push or merge occurred. Host readiness is verified; full acceptance, the old aggregate-timeout question and private-pilot technical confirmation still prevent T008/F2 closure. P/Q history and F3 authority remain unchanged.

## T008 prepared gate execution - timeout, 2026-10-25

The owner explicitly authorized one prepared original gate invocation with both streams captured and 900 seconds per catalog command, stopping at failure or unknown, without guard/timeout changes, CI, commit, push or merge. Preflight completed with native exit 0: 99 baseline paths, the [phase-Q branch recorded in the baseline](../../../docs/roadmap/factory-local-poc.md), HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, empty index, matching five guard/config/redactor hashes and four launcher hashes, and the exact previously tested workflow fixture revision. The prepared host retained parent PATHEXT; the global environment, original Harness/catalog and seven commands remained unchanged. No aggregate 900-second deadline shortened the multi-command gate.

The original `validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900` was launched once in the foreground outside the sandbox with fresh qualified owned external TEMP/TMP. The wrapper drained/captured validator stdout and stderr concurrently. It completed with **native exit 1**, outer stopwatch **972908 ms**, `stdout_eof: true`, `stderr_eof: true`, no truncation and `validator_host_pathext_preserved: true`. Captured stdout was empty. Captured stderr was:

```text
Write-Error: Acceptance check timed out; process tree terminated
```

This is a definite validator timeout result, distinct from the earlier Node lookup failure. No `[OK] acceptance` or final spec summary was emitted. Given the unchanged fixed order, the first catalog command is `ac-behavior` / `pnpm test`; no passing gate check is established, and the remaining six commands were not reached. The common guard discards the test child's raw stdout/stderr, so the retained validator streams do not identify an individual failing/blocked test, test totals, filtered/skipped counts or actual Vitest duration. Do not infer any such result from the earlier isolated PASS evidence.

The 972908-ms outer wall interval includes initialization, guarded execution, owned-tree termination and stream collection. No separate timings attribute the difference from the 900-second command wait to one of those phases; it is not evidence of a changed timeout or a 972.908-second Vitest duration. The validator reported terminating its owned process tree and the outer process returned native terminal status with both streams complete. Internal fixture teardown was not independently established, and the owned temporary parent was retained without extra cleanup.

Execution stopped at this failure. No repair, retry, new diagnostic, post-failure status/hash/inventory command or successor was run. Only the three already authorized evidence documents record the result; no product/test/Harness source, guard, timeout, catalog, policy or global environment change followed. Schemas, typecheck, build, repository, secrets and eval checks in this attempt remain NOT RUN; separate Harness/browser/runtime smokes, CI, audit, paid calls, sibling operations, cleanup, commit, push and merge were also NOT RUN. The earlier focused and readiness PASS results remain valid only at their recorded scopes. T008 stays unchecked and F2 `in_progress`: the full-suite timeout, complete acceptance and private-pilot technical confirmation remain unresolved. P/Q outcomes and F3 authority are unchanged.

## T008 full-suite attribution observer - approved synthetic-only increment, 2026-10-26

The owner approved a bounded eight-file increment to identify what consumes the unchanged 900-second `pnpm test` allowance. Its first implementation attempt stopped when the documentary patch did not match the runbook header. Read-only inspection confirmed that none of the eight target files changed and no synthetic or real check ran. The owner then explicitly authorized correcting only that patch context and resuming the approved implementation and synthetic checks, stopping at the first failed or unknown result.

The exact scope is the four existing ignored artifacts `core.mjs`, `runner.mjs`, `synthetics.mjs` and `launch.ps1`, plus new `reporter.mjs`, under `node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/`, together with this task record, `docs/runbooks/factory-request-contract-acceptance.md` and `docs/roadmap/factory-local-poc.md`. The new closed mode is `full-suite-attribution`; the four existing focal modes remain available with their prior contracts. The five local artifacts are ephemeral implementation inputs, not published product or Harness sources.

The minimal reporter uses public Vitest run/module/case lifecycle callbacks. It records closed-schema events, relative validated test-file locations, opaque IDs, terminal numeric durations and pending states; it omits arbitrary case titles, private errors, payloads and environment values. Bounded projection retains slow completed cases/files and unfinished modules/cases, with explicit omissions or unknown coverage rather than an inferred pass. Node observes data/progress, native exit and separate stream EOFs; PowerShell records the existing guarded wait and termination/closure milestones. Each clock domain remains separate. No hook instrumentation, CPU/heap profiling, new timer or process query is included.

The prepared future diagnostic command is fixed to `pnpm test --reporter=verbose --reporter=<derived ephemeral reporter path> --includeTaskLocation`, without filters or worker/timeout overrides. That mode is diagnostic-only and cannot certify acceptance. Its real invocation needs a separate continuation: implementation and the single in-memory synthetic execution were authorized separately from this later documentary-only result update. The existing 900000-ms deadline, 32-KiB visible and 32-KiB retained output limits, 8192-byte line limit, continuous draining, environment/temporary-ownership guards and process-termination behavior remain unchanged. Product tests/runtime, package scripts, Vitest configuration, exact gate catalog, canonical Harness scripts and pins are outside scope.

One foreground synthetic-only invocation outside the sandbox passed **75/75 checks, native exit 0**, with the original 900000-ms limit. Command: `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -SyntheticChecks`. The supervisor reported `status: completed`, `mode: synthetic`, `acceptance: false`, `exit_code: 0`, `deadline_ms: 900000` and `wall_ms: 1413`; its final timing was 1430 ms. The root started at 15 ms, the guarded wait returned at 1398 ms, stderr capture closed at 1412 ms, and all termination fields stayed null. These supervisor-relative observations do not measure Vitest duration.

The 53 earlier checks were retained with the approved closed-mode adaptations, plus 22 new checks. They cover interleaved modules/cases, unfinished lifecycles and EOFs, invalid or missing events, contradictory terminal evidence, bounded rankings/overflow, fragmented UTF-8 and output saturation, privacy getters, import inertness, and preservation of focal/environment/ownership/guard contracts. Internal identity tables are limited to 512 modules and 16384 cases; exceeding either yields explicit unknown coverage. Display rankings/pending lists have separate omission counters and do not erase known terminal totals. The runner reserves 30000 bytes for the projected snapshot inside the existing 32768-byte retained receipt budget. All five protected source hashes passed byte-integrity assertions.

Validated ephemeral SHA-256 identities:

| Artifact | SHA-256 |
| --- | --- |
| core.mjs | 1EAA99B886B52A8C60C4AA4ED86AB593D6F3B4E5E46C36D5061B02562ED53CB1 |
| runner.mjs | CC3EE07DDD66611DE1EE844F2A29D17B25DACC8F3F27B34D28BF7A55148CBBA5 |
| synthetics.mjs | B02666713FF2D534FEBE930E64513961A039EE19651AB4F17B0A8322E59D3F53 |
| launch.ps1 | 29B6A0FD97BAE2D9DD45CA1BB56A228040F6C4FC417381D3064578A11825B126 |
| reporter.mjs | 68FC75096F525945EEEA6CB930DFD5598929B997942DB572C1F5F7010D28E055 |

Negative fixtures intentionally assert refused, failed, timeout and unknown states; those are passing synthetic checks, not failed real commands. No standalone syntax, typecheck, schema, build or product-test command, real suite/diagnostic, CI, gate, smoke, real fixture-filesystem/process probe, cleanup, sibling operation, paid call, commit, push or merge ran. A later result-recording patch failed during in-memory packaging before invoking the editor, so the documents still read PENDING at that stopping point. Under renewed explicit authority, only that packaging and these three evidence documents were corrected, without repeating any check. A real diagnostic requires a separate continuation.

The latest original gate remains the recorded native-exit-1 timeout after 972908 ms outer wall time, with no passing acceptance result and six later catalog commands not reached. This observer cannot retrospectively attribute that interval, certify cleanup or substitute for the original seven-check gate, separate Harness/browser acceptance and private-pilot technical/human checkpoint. T008 remains unchecked, F2 `in_progress`, and P/Q history plus F3 authority are unchanged.

## T008 bounded contracts, fixture cost and focal capture - 2026-10-27

The owner approved exactly twelve files and synthetic checks only: `docs/architecture/current-architecture.md`; `runner/workflow-orchestrator.test.ts`; `dashboard/src/server/workflow-service.test.ts`; `dashboard/src/server/workflow-api.test.ts`; `scripts/profile-maintenance.test.ts`; existing local `core.mjs`, `runner.mjs`, `synthetics.mjs` and `launch.ps1` under the same ignored diagnostic directory; this plan, the F2 acceptance runbook and active roadmap. Product runtime, original guard scripts/catalog, manifest budgets, package/configuration, independent pins and user changes remain outside scope. Focal product tests, typecheck, suite, gate, CI, smokes, paid calls, process cleanup and publication are not authorized by this increment.

The preceding single authorized real diagnostic timed out at 900000 ms: 151 modules observed, 150 closed (146 passed, four failed), and 6552 cases completed (6529 passed, nine failed, fourteen skipped), with one case still open. The pending workflow module had run about 327.18 seconds; its case at the then-current line 897 had been open about 51.21 seconds. That case has a 90-second limit, so its individual timeout was not established. No run-end or terminal suite summary was received; native suite exit remained null and coverage unknown. The supervisor requested only its owned-tree termination and ended at 900070 ms; fixture cleanup remained unknown. These are diagnostic observations, not acceptance.

Architecture removes exactly 22 blank lines (128 to 106), preserving every byte of the 98 nonblank lines in order. Their SHA-256 is `retained privately`. The formerly over-budget route totals become 487 and 500 without changing required reads or the 500-line cap. The vendor-specific project-reference wording in the historical intake checkpoint becomes portable terminology; private project details stay outside this core record.

Service/API fixtures cache only private immutable public-source bytes and materialize independent normal files with exclusive creation per case. Four new regression cases cover byte inventory and copy independence. Repeated authority reads share one fresh snapshot only inside the same synchronous checkpoint. All stages, human decisions, real Git/worktree/verification boundaries, polling and test timeouts remain intact; no snapshot crosses an await or mutation. The protected first-read-only helper remains unchanged.

Only five explicit integrity-reference literals change in the historical diagnostic tests; the original prefix, byte lengths, assertion logic and six independent runtime pins remain intact. Old/new identities:

| Reference | Previous | Reviewed replacement |
| --- | --- | --- |
| P13/P14 fixture (two sites) | 5e1b0fe9a9f97579e0aa76c1d8d6fe239ac05c0d503fb8f36b598e032f32bbba | 458a7a0e8a1d6d2cdab331c230d88c4140d812aafb32abd0e03c4350bc959745 |
| P14 prefix | f715ffa05c7081f5df407ba326268e8dca1af49c2a4620c5a4fdf3eb612d76ac | 6726b9013a3847bd7df2bb9fa53ea730d70a4d801298ec4d5f230ae5e928219b |
| P15 prefix | 553ade9bc5d4040a4752f00d3b26c58ece400970dc07d72f317f2d5368f85547 | 9b00ac58aaa6c010ce5d09279650cb0f77f919308c5e5cba46a9c224dfeec7f1 |
| P16 normalized prefix | 047908d4a61a11579a7e84470ced8044f5772a86c3e055e201d221a45a445012 | 9e45d25006e10023be63a78d07fd37f964395e664220c77fadb5d565c396c4aa |

The existing reporter is unchanged. Eight additional closed focal selections use fixed files/patterns and the existing reporter with bail-on-first-failure; the whole-suite mode retains its original command. Known active counts, a single expected module/file, native exit, both EOFs and complete consistent evidence remain mandatory for a passing focal diagnostic. Reserved error details bind only an explicit same-stream failure block and contain an opaque title digest, class/category/code and safe repository locations; no arbitrary title, raw error body or private values are retained. Existing 900000-ms, 32768-byte visible/retained, 8192-byte line, ownership, environment and termination contracts remain intact.

Synthetic execution result: **FAILED / INCOMPLETE**. One foreground invocation of `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -SyntheticChecks` returned native exit 1. Of 90 checks, 88 passed, check 89 failed, and check 90 was NOT RUN because the matrix stops at its first exception. All 75 prior checks and the first 13 added checks passed, including protected source/reporter identity and focal/error-capture contracts. The failing check is `preserves all nonblank architecture bytes and the original declared context budget`; it also checks route counts and portable core wording, so its precise failing condition is not established by the retained output. The driver discards stderr; the error name/message/frame was therefore unavailable. Do not infer an architecture, route, portability or module-resolution root cause from this combined check alone.

The supervisor completed with native exit 1, mode `synthetic`, `acceptance: false`, `deadline_ms: 900000`, `wall_ms: 2799` and final supervisor timing 2819 ms; termination fields were null. The final synthetic check, `changes only the five approved fixed-size historical integrity-reference literals`, remains NOT RUN; the earlier read-only reference review is not a passing execution of that check. No second invocation, source repair, typecheck, focal product test, suite, CI, gate, smoke, process probe/cleanup or Git mutation followed the failure. Only these three evidence documents record the result. Fixture regressions remain implemented but NOT RUN. T008 stays unchecked and F2 `in_progress`; later work first needs a bounded recovery of the concrete documentary-check error without repeating the 88 passing checks.

### Authorized remaining-check recovery

The owner authorized only the documentary check and, conditionally on its success, the historical-reference check, without repeating the 88 previously passing checks. A closed `--remaining-documentary-checks` driver selector admits those two exact names in order; the default matrix and all check bodies remain unchanged. Error capture uses bounded own data properties, permitted scalar assertion facts and safe source metadata on stdout. The on-disk launcher is unchanged; its in-memory copy changes only the selected driver argument and its absolute artifact-root binding, preserving every execution guard, environment/ownership rule and the 900000-ms deadline.

The sole focused invocation failed immediately on the documentary check: `AssertionError`, code `ERR_ASSERTION`, operator `strictEqual`, actual `true`, expected `false`. In that unchanged check body this is the final portable-wording assertion over this task record; all earlier architecture line/content and declared route-count assertions completed without throwing. The compound check is still FAILED. The exact matching text/location was not captured and has not been inferred. No source wording repair or second check followed.

Receipt: zero PASS, one FAIL, one NOT RUN among two selected checks; 90 registered and 88 not selected. Native exit 1; supervisor `status: completed`, `mode: synthetic`, `acceptance: false`, `deadline_ms: 900000`, wall 420 ms and final timing 437 ms; termination fields null. The historical-reference audit and fixture product tests remain NOT RUN. Stop at this failure; only these evidence documents are updated. T008/F2 remains incomplete, with no real suite, CI, guard/timeout change, process cleanup or publication.

### Minimal portability correction and remaining-check completion

Under separate explicit authority, read-only inspection located three historical branch-prefix literals at the then-current lines 226, 362 and 413. The plan now links each to the existing roadmap baseline outside the portable core, preserving exact branch identity there, recorded HEADs, counts and historical results. Only those three textual fragments changed; no branch operation, guard/timeout change or check execution accompanied that correction.

The owner then authorized only the documentary check and, on success, the historical-reference check. A single foreground closed-selection invocation passed **2/2 selected checks, native exit 0**: `preserves all nonblank architecture bytes and the original declared context budget`, then `changes only the five approved fixed-size historical integrity-reference literals`. Its receipt records 90 registered, 88 not selected, `synthetic_only: true`, `acceptance: false`, selection `remaining-documentary-checks` and `deadline_ms: 900000`. The 88 earlier passing checks were not repeated. This completes the planned synthetic coverage across the recorded invocations; it is not a claim that all 90 ran again in one invocation.

Supervisor: `status: completed`, `mode: synthetic`, exit 0, wall 555 ms and final timing 567 ms; start returned at 12 ms, guarded wait at 541 ms and capture closed at 554 ms. All termination fields remained null. The on-disk launcher, 900000-ms guard, environment/ownership controls and timeouts are unchanged. The two executed checks now cover architecture content/counts, portable plan wording and preservation of historical test bytes apart from the five approved reference literals. No product fixture regression, native contract/reference suite, typecheck, full suite/gate, CI, smoke, paid call, cleanup, commit, push or merge ran. T008 remains unchecked and F2 `in_progress`; targeted product validation is the next separately authorized step.

### Authorized native contract focals - 2026-10-28

The owner authorized only `harness-context`, `profile-reference-contracts` and `harness-validators`, in that order, with 900 seconds per command and stop on the first failed/unknown result. Before dispatch, read-only identities matched all five protected sources and the four execution artifacts; the synthetic-only driver is not invoked by these real focal modes. Each command used `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection <fixed-id>`, outside the sandbox, with its owned temporary environment. No whole-suite, original gate or CI command ran.

| Ordered selection | Native exit | Active passed | Filtered skipped | Coverage | Supervisor wall / final ms |
| --- | --- | --- | --- | --- | --- |
| harness-context | 0 | 19 | 0 | complete | 9534 / 9542 |
| profile-reference-contracts | 0 | 4 | 1289 | complete | 3650 / 3656 |
| harness-validators | 0 | 98 | 0 | complete | 96934 / 96941 |

All three diagnostic receipts report `status: passed`, root exit observed, stdout/stderr EOF true, no stream failure, coherent terminal summaries, `run-end: passed`, zero failed cases and no pending cases/modules. Supervisors completed with exit 0, `deadline_ms: 900000`, `mode: diagnostic-only`, `acceptance: false` and null termination fields. The reference focal executed exactly four selected preservation cases, not all 1293 registered cases; the other 1289 were deliberately filtered. Overall, 121 active cases passed across three separate commands. Display-only top-ranking omissions do not indicate lost lifecycle coverage.

These results validate the context/portability contracts, the four historical reference-preservation cases and the native validator test file at this scope. Existing fixture-owned teardown stayed inside each test's lifecycle; no independent process probe or cleanup was performed, and no claim is made that earlier unknown diagnostic fixtures were cleaned. No source repair, guard/timeout change, typecheck, complete suite/gate, CI, smoke, paid call, commit, push or merge followed. Stop after the third PASS. The remaining identified product failures, new fixture-isolation regressions, correction/service/API validation, original full gate, separate Harness/browser acceptance and private-pilot checkpoint keep T008 unchecked and F2 `in_progress`.

### Authorized capacity and first-stage product focals - 2026-10-28

The owner separately authorized only `issue-intake-capacity`, `workflow-budget-bootstrap` and `workflow-first-stage`, in that order, with 900 seconds per command and stop on the first failed/unknown result. Read-only preflight matched the same five protected source identities and four execution artifacts. Each command used the original validated `launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection <fixed-id>`, outside the sandbox with owned temporary state/environment, and every successor waited for complete native closure and coverage of its predecessor.

| Ordered selection | Native exit | Active passed | Filtered skipped | Coverage | Supervisor wall / final ms |
| --- | --- | --- | --- | --- | --- |
| issue-intake-capacity | 0 | 1 | 190 | complete | 8554 / 8561 |
| workflow-budget-bootstrap | 0 | 1 | 78 | complete | 7645 / 7651 |
| workflow-first-stage | 0 | 3 | 76 | complete | 14362 / 14376 |

All three receipts report `status: passed`, root exit observed, stdout/stderr EOF true, no stream failure and coherent terminal summaries. The first two reported modes each prove one active case, the exact fixed file/module and a passed run-end. The legacy first-stage mode proves the three exact analysis, implementation and operations-investigation names, all passed; it does not require a reported-attribution field. No failure detail was recorded. Supervisors completed with exit 0, `deadline_ms: 900000`, `mode: diagnostic-only`, `acceptance: false` and null termination fields.

The capacity case reported about 3172.31 ms and the bootstrap case about 3628.50 ms; these isolated observations do not establish why their earlier full-suite executions failed. Five distinct active cases passed across the three commands; filtered skips are not passing executions or new global coverage. The prior failures did not reproduce at this selected scope, without assertion, guard, timeout or source repair. This is not evidence that the full suite now fits or passes under its earlier load.

Execution stopped after the third authorized PASS. Existing fixture-owned teardown remained within the tests; no independent process probe/cleanup, product source edit, typecheck, full suite/gate, CI, smoke, paid call, commit, push or merge ran. New service/API fixture-isolation regressions, real correction stages and service/API validation, the original full gate, separate Harness/browser evidence and the private-pilot checkpoint remain pending. T008 stays unchecked and F2 `in_progress`.

### Authorized fixture files and correction variants - 2026-10-28

The owner authorized only `workflow-service-file`, `workflow-api-file` and `workflow-correction`, in that order, with 900 seconds per command and stop on the first failed/unknown result. Read-only preflight matched all five protected source identities, four execution artifacts, the recorded baseline and empty index. Each command used the original validated `launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection <fixed-id>`, outside the sandbox in the foreground with owned TEMP/TMP. Each successor waited for its predecessor's native closure and complete coherent coverage.

| Ordered selection | Native exit | Result | Active passed / failed | Filtered skipped | Coverage | Supervisor wall / final ms |
| --- | --- | --- | --- | --- | --- | --- |
| workflow-service-file | 0 | PASS | 111 / 0 | 0 | complete | 130250 / 130257 |
| workflow-api-file | 0 | PASS | 29 / 0 | 0 | complete | 146142 / 146166 |
| workflow-correction | 1 | FAILED | 0 / 1 | 77 | unknown; second variant unresolved | 106196 / 106206 |

The two complete fixed-file runs include all four new fixture-isolation regressions: service locations 72/85 and API locations 67/80. They validate normal byte-equivalent registry/evaluation files and independence between source, modified copies, sibling copies and later materializations. Both receipts have passed run-end, zero unhandled errors, no failed/open/pending cases or modules, root exit and both EOFs. Service display capture reached its existing cap while draining continued; complete reporter/terminal coverage remained intact. In total, 140 active cases passed across those two commands.

The correction command failed on its first selected case at `runner/workflow-orchestrator.test.ts:897:24`, with captured `Error: Test timed out in 90000ms` and reserved category `test-timeout`, `timeout_ms: 90000`. The reporter recorded one failed case (opaque prefix `654393c136aa`) with duration 99637.7907 ms. This duration is the reported case observation; the record does not assign its excess over 90000 ms to an internal cause. The next variant (opaque prefix `ec412574d5af`) has no valid terminal status. The run ended `interrupted`; attribution/coverage is `unknown` with `reporter-invalid-status`, one of two required active cases observed, and 77 filtered skips. The textual total is 79 registered, not 79 executed or 78 passing cases. The first case's explicit failure is established despite incomplete coverage of the second.

All three roots closed natively with stdout/stderr EOF and no stream failure. Supervisors completed with their respective native codes, `deadline_ms: 900000`, `acceptance: false`, null termination fields and no reached outer deadline. The correction failed at the unchanged test-level 90000-ms limit, not at the 900-second command guard. Its precise blocking operation and internal fixture cleanup are not established by this receipt.

Execution stopped at that failure. Only these three evidence documents were updated afterward; no source/assertion repair, retry, additional diagnostic, post-failure process/status probe, cleanup, typecheck, full suite/gate, CI, smoke, paid call, commit, push or merge followed. Guard, timeout and output limits remain unchanged. T008 stays unchecked and F2 `in_progress`; correction completion, the original gate, separate Harness/browser evidence and private-pilot readiness remain pending. A bounded design based on the captured correction timeout is the proposed next step, requiring a new continuation before implementation or execution.

### Approved correction checkpoint increment - 2026-10-28

The owner approved six existing files and this ordered focused sequence: byte/invariant review; the two already selectable documentary/reference synthetics only; `profile-reference-contracts`; `workflow-correction`; and typecheck only if all preceding checks pass. Stop at the first failed/unknown result. No full gate, suite, CI, independent process cleanup or publication is authorized by this continuation.

The fixture adds a test-owned checkpoint reader over a fresh validated workflow document, selecting only workflow, stages, decisions, review receipts and lineage. Only the two existing T010 variants opt in for setup and subsequent observations. Their original assertions, names/count, seven real worker executions, Git/worktrees, verification, both reviews, reconciliations and cleanup remain. The existing full-detail/advance path remains for every other fixture consumer, including budgets and lost-callback recovery. Embedded checks compare against the existing start response, verify one reader call, unknown identity rejection, independent disposable observations and freshness after planning. No public-detail query is added per stage, no snapshot grants authority, and no state observation is cached across effects for a decision.

The source update requires exactly five 64-character reference replacements in the historical diagnostic test file and the same five current literals in the ignored synthetic inverse audit. The profile file remains 583607 bytes; its immediate previous bytes and the synthetic driver's previous bytes are recoverable by reversing only those literals. The historical inverse baseline, independent runtime pins, P13 prefix, fixed offsets, two-case selection, existing launcher/core/runner/reporter, guard scripts and all test/poll/command deadlines remain unchanged. The reduction concerns nine explicit public-detail observations per variant; its timing effect and correction success are not assumed.

Implementation is recorded; the proposed validation sequence is NOT RUN at this checkpoint. T008 remains unchecked and F2 `in_progress`. Append native results below without replacing earlier failures or treating focused tests as the original gate, browser/Harness acceptance or private-pilot readiness.

#### Focused execution result - stopped on correction timeout

The byte/invariant review passed: reversing only the reviewed helper/call-site changes reconstructs the prior fixture SHA-256 `458a7a0e8a1d6d2cdab331c230d88c4140d812aafb32abd0e03c4350bc959745`. All five protected source hashes and four execution-artifact hashes match their baseline. The historical profile remains 583607 bytes; reversing its five literal changes restores the immediate prior SHA `7eddc70045616566d2ea0d9c581481d6c70f78fdee3710f7267870d313c8b2b5`. Reversing only the synthetic driver's five current literals restores its immediate prior SHA `00f1192301b4b3e340be1e807fec4169755909236b0fddca11dd0045a00625ad`.

| Artifact/reference | Current SHA-256 |
| --- | --- |
| Workflow fixture, also the two full-fixture reference slots | 4366308bce9d44bcf9b9ce2d28e800c917093222e1e1b2fc11c96ce5698e1227 |
| P14 prefix | bac29b2effe6cfe4ce1bacbb3b660fe9e4e0e0b003f90479ec7e846efee8bc2e |
| P15 prefix | c71d0cd02a6e2e0782405d53abb56b0ba4c49059d6a0e815241206c964648b54 |
| P16 normalized prefix | 0fef993f2f1221baad80b98278aec18dd89ab90cbb532bdae795d57772e9d89c |
| Historical profile test file | 15f53e53f5a0b4e6b7e47411f415712a954c8b08c3626782d58246bab6264b5f |
| Ignored synthetic driver | 8244e10cabdcc4e27bfc89baf37fc5670de6b40fa17b077412941a8b11dab322 |

| Ordered check | Native exit | Result | Supervisor wall / final ms |
| --- | --- | --- | --- |
| Byte/invariant review | 0 | PASS | not a test supervisor |
| Closed documentary/reference synthetics | 0 | 2/2 PASS; 90 registered, 88 not selected | 495 / 514 |
| profile-reference-contracts | 0 | 4 active PASS; 1289 filtered skips; complete coverage | 5525 / 5539 |
| workflow-correction | 1 | first selected case FAILED; second unresolved; coverage unknown | 96542 / 96551 |
| pnpm typecheck | not run | NOT RUN after failure | not applicable |

The two synthetic bodies ran through the existing closed remaining-check selector, using only the approved in-memory root/argument substitutions; reversing those substitutions reproduced the on-disk launcher before invocation. The other 88 checks were not repeated. The reference focal proves its four preservation cases, with complete attribution, passed run-end, root exit and both EOFs. Its display capture saturated while draining continued; 1293 registered cases do not mean 1293 active passes.

The sole correction invocation captured `Error: Test timed out in 90000ms` at the shifted location `runner/workflow-orchestrator.test.ts:926:24`, category `test-timeout`, timeout 90000 ms. The first selected case (same opaque prefix `654393c136aa`) failed with reported duration 91013.1522 ms. The second (`ec412574d5af`) lacks a valid terminal status. Attribution/coverage remains `unknown`, reason `reporter-invalid-status`, run-end `interrupted`, with 79 registered/observed, 78 completed, zero passed, one failed and 77 filtered skips. No separate passing result is claimed for the new embedded checkpoint assertions.

The root closed natively with exit 1, both EOFs and no stream failure. The supervisor completed under `deadline_ms: 900000`, with no outer deadline reached and all termination fields null. Its reported case duration differs from the earlier 99637.7907-ms observation, but these two timeout samples establish neither the internal blocking operation nor a causal performance improvement. The optimization did not resolve the timeout; internal fixture cleanup remains unconfirmed.

Execution stopped at the first failure. Only the three authorized evidence records changed afterward. No retry, repair, additional diagnostic/process/status probe, typecheck, full suite/gate, CI, smoke, independent cleanup, paid call, commit, push or merge followed. All guards, timeouts and publication boundaries remain unchanged. T008 stays unchecked and F2 `in_progress`; a new bounded continuation must identify the incomplete correction operation before another implementation or execution.

### Approved correction operation observation - 2026-10-28

The owner approved eight files and only this validation sequence: fourteen selected synthetics (twelve new progress checks plus the two existing documentary/reference bodies), four `profile-reference-contracts` cases, then typecheck if preceding checks pass. Stop at the first failed/unknown result. No real correction execution, full gate/suite, CI, independent cleanup, paid call or publication is authorized.

A new pure `scripts/diagnostics/correction-progress.ts` defines closed progress frames, a non-throwing emitter and bounded collector. Only the two existing T010 correction variants emit observations. Fixture and attempt lanes remain independent because the worker can continue after `runOnce` returns. The fixture records stage selection, worker calls, terminal waits, reconciliation/checkpoints, synthetic executor boundaries, setup/Git and exact human decisions. The existing task tracer supplies only admitted milestone names, with `context: null`; all attributes and real identities are discarded. Callbacks close over their own emitter. `afterEach` detaches and seals it before the existing worker stop, so late continuations cannot attach to the next variant. Original assertions, stage execution, worker ownership, real Git/worktree/verification and all deadlines remain.

The ignored core admits the reserved prefix only for the correction selection and binds it to the unique currently open reported case. A separate bounded snapshot retains last completed/milestone and open operations after tail eviction, bail or timeout, without granting authority or changing native/EOF/coverage criteria. New observation bounds are two variants, 256 events per variant, four frames per lane, 512 bytes per frame and 3072 bytes per retained observation, inside the existing 8192..32768-byte snapshot limits. The original environment, line/output limits, 900-second guard, runner, launcher, reporter and independent runtime pins remain unchanged.

The historical synthetic matrix/default and existing two-check selector remain intact. A closed `--correction-progress-checks` selection chooses twelve separate progress checks and the two existing audit bodies, leaving the other 88 unselected. Five fixed-size historical references and their five inverse-audit entries follow the changed fixture bytes. Only this task plan, the acceptance runbook and active roadmap record evidence. Implementation is being completed; validation is NOT RUN at this checkpoint. T008/F2 remains incomplete, and an open operation will indicate only an unobserved return rather than a proven internal cause.

#### Operation observer validation - authorized slice complete

The eight-file implementation is complete. Before dispatch, a scoped audit preserved all 96 pre-existing changed files outside this increment, eight protected source/runner/launcher/reporter identities, the recorded HEAD/branch and empty index. The profile remains 583607 bytes; reversing only the five new reference literals recovers its immediate prior SHA `15f53e53f5a0b4e6b7e47411f415712a954c8b08c3626782d58246bab6264b5f`. The historical inverse test still restores its independent original baseline rather than adopting unrelated source changes.

| Current artifact/reference | SHA-256 |
| --- | --- |
| Pure correction-progress helper | d83f2695ee72287e9acd99db0dbf1e73fb20d428db88c6c35c16a28d134f0042 |
| Workflow fixture / its two reference slots | c6524d28c589dd15af33b5ee72b555a5e0567046e1490a05dfdb6db2644827eb |
| P14 prefix | 8b308d9586b6981a70b57cff9320861c3ee7ff12e199ff96a3468a63b99edac2 |
| P15 prefix | 2513f19951a5d85f7d6ab2ca68a274ea93c37e661e02e4c0bf7ebb1b52f8c44f |
| P16 normalized prefix | 740cd836089cd446ffe54516595535d39bc2be7cae174f96242e091a458c5716 |
| Historical profile test file | db61e86d302ae63b037eba5a3c5c73c3f37288ecb9c94642b771e10ed721126c |
| Ignored capture core | ca8ec215b7d4b461d39bca7630fd2e39c5b81a6a091e4de471e40b77d2bf86d9 |
| Ignored synthetic driver | 126e93c5bf8f8adf47afa1f5fc5c7a593c3d57885a3bfd508e3a698699e3836a |

| Ordered validation | Native exit | Observed result | Supervisor wall / final ms |
| --- | --- | --- | --- |
| Closed correction-progress synthetics | 0 | 14/14 PASS; 102 registered, 88 not selected | 649 / 671 |
| profile-reference-contracts | 0 | 4 active PASS; 1289 filtered skips; complete coverage | 5314 / 5328 |
| pnpm typecheck | 0 | PASS | 37611 / not separately reported |

The single synthetic invocation used the reviewed in-memory root/closed-selector substitutions; reversing them recovered the untouched on-disk launcher. It executed twelve pure progress checks and the two existing documentary/reference bodies, without running the other 88. The checks cover schema/privacy, both variants, overlapping lanes, partial failure/bail, saturation and tail eviction, chunks/EOF/oversize, invalid identity/channel/sequence, bounds, sealing and late events, sink failures, the smallest existing snapshot, and unchanged coverage/environment/deadline/guard criteria.

The reference focal used the original launcher outside the sandbox with owned TEMP/TMP. Its receipt has native exit 0, complete expected four-case coverage, passed run-end, root exit, both EOFs, no stream failure and null termination fields. Display saturation did not prevent draining or terminal coverage; 1293 registered cases do not mean 1293 active passes. The following fixed `pnpm typecheck` ran once in the foreground through Node and the resolved standard package-manager entry, with an owned external temporary root, the unchanged ten-variable environment allowlist plus CI and a 900000-ms wait/owned-tree termination boundary. Its supervisor returned native exit 0/PASS after 37611 ms without requesting termination; temporary state was retained without cleanup.

Stop after the conditional typecheck PASS. No real correction flow, complete suite/gate, CI, browser/runtime smoke, paid call, independent process probe/cleanup, commit, push or merge ran. All original assertions, names, stages and test/poll/command limits remain. The observation is prepared and synthetically validated, not yet exercised against the real timeout. A producer sink failure can leave missing/unsealed progress; `observed` means retained facts, never complete execution or a proven cause. The prior first-case timeout and unresolved second variant remain the latest real correction result. T008 stays unchecked and F2 `in_progress`; a single correction diagnostic with the new capture needs separate continuation authority.

#### Single authorized correction diagnostic - observation binding unknown

The owner separately authorized exactly one `workflow-correction` diagnostic with the validated capture, 900 seconds and stop on failed/unknown. Read-only preflight matched thirteen validated source/execution identities. The original `launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection workflow-correction` ran once outside the sandbox in the foreground with owned TEMP/TMP. No source, guard or timeout changed.

Native result: **exit 1 / FAILED**. The first selected case captured `Error: Test timed out in 90000ms` at `runner/workflow-orchestrator.test.ts:972:24`, category `test-timeout`, with reported duration 90159.9598 ms. Its opaque case prefix remains `654393c136aa`. The second case (`ec412574d5af`) has no valid terminal result. Attribution/coverage is `unknown`, `reporter-invalid-status`, run-end `interrupted`: 79 registered/observed, 78 completed, zero passed, one failed and 77 filtered skips. These skips and the unresolved variant are not passing executions.

The new progress receipt is also **UNKNOWN**, global reason `invalid-binding`. It retains one `qa-false` row bound to the first case, but with sequence 0, `sealed: false`, row reason `event-order`, empty fixture/attempt stacks and null last-closed/milestone fields. No valid operation or stage was retained. The receipt therefore does not identify which internal operation failed to return, establish the ordering/source of the rejected frames, or distinguish an execution defect from cumulative cost. The fourteen prior synthetic checks remain recorded PASS at their simulated scope; this real run exposes an observation gap they did not establish away.

The root exited natively with both EOFs and no stream failure. Supervisor completed with exit 1, `deadline_ms: 900000`, wall/final 95721/95732 ms; start returned at 13 ms, guarded wait at 95702 ms and capture closed at 95719 ms. All termination fields were null and the outer 900-second deadline was not reached. Neither test completion nor internal fixture-cleanup success is inferred from native process closure.

Execution stopped at this failure/unknown. Only the three authorized evidence records changed afterward; no retry, repair, additional source/process/status probe, test/typecheck repeat, complete suite/gate, CI, smoke, paid call, independent cleanup, commit, push or merge followed. T008 stays unchecked and F2 `in_progress`. A separately reviewed continuation must address progress binding/order without assuming a runtime cause or selecting another optimization from this empty progress receipt.

### Approved correction identity/order repair - 2026-10-29

The owner approved this bounded eight-file increment and only ten selected synthetics, four historical reference cases, then conditional typecheck, stopping at the first failed or unknown result. The real correction diagnostic, complete suite/gate, CI, independent cleanup and publication remain outside this continuation.

The existing test hook derives an opaque SHA-256 from the actual test task identity. Each of the two correction bodies copies that value into its own emitter; no late callback consults a mutable current-case identity. Exact v2 frames carry that digest. V1 frames and their legacy current-case binding remain compatible. The core reduces v2 events immediately from sequence one into the existing bounded operation stacks and summaries, even before case-ready arrives, then confirms the same reported case ID, expected file and module. Lifecycle before progress and progress after a terminal result are supported without adopting another open case. Pending binding is provisional uncertainty, not a sticky event error; missing confirmation at closure stays UNKNOWN. Invalid identity, contradictory lifecycle, skipped/repeated cases, schema/sequence failures and cross-variant reuse still fail closed.

No raw frame FIFO, sequence reset, new timer, wait, output allowance or execution authority is added. Existing variant/event/lane/frame/snapshot caps, native/EOF/coverage criteria, reporter, runner, launcher, assertions and test/poll/command deadlines remain unchanged. Exactly five 64-character historical reference slots and their inverse-audit entries follow the changed fixture bytes; the profile keeps 583607 bytes and independent pins.

A separate closed correction-binding selector adds eight synthetic regression groups and reuses the two documentary/reference bodies: ten selected, 110 registered and 100 not selected. The historical ninety-check default, twelve progress bodies and existing selectors remain intact. Coverage includes pre-ready reduction/confirmation, frames after a prior result while a successor is open, interleaving, unresolved closure, invalid identities, sticky schema/sequence errors, sealing/late events and unchanged v1/caps/execution criteria. These checks use synthetic events only. Implementation is being completed; validation is NOT RUN at this checkpoint. This repairs a statically demonstrated capture dependency, not the runtime timeout. T008 remains unchecked and F2 in progress; original acceptance and pilot checkpoints remain required.

#### Identity/order repair validation - authorized slice complete

The eight-file repair is complete. Static review found no actionable integration issue. The scoped pre-launch audit preserved all 96 pre-existing changed files outside this increment, eight protected source/execution identities, the recorded HEAD/branch and empty index. The 583607-byte profile changes only five fixed-size literals; reversing those changes recovers its immediate previous SHA `db61e86d302ae63b037eba5a3c5c73c3f37288ecb9c94642b771e10ed721126c`. The selected historical inverse audit independently restores its original baseline.

| Current source/reference | SHA-256 |
| --- | --- |
| Pure correction progress helper | d38706274ae3be03c7ae485ab79cf72c91f0b914409c99c42251fab4e58bc941 |
| Workflow fixture / two reference slots | c6d0c267e4ccd2bd4d8daebfda213f4dbca36d36f69036f647ca26ac1caa4a18 |
| P14 prefix | eeb9f5fb4ef3424dab4ec6b3881e8aab4da3821ab1eb353d810abdc676fa54f4 |
| P15 prefix | ef91a61115a3972774b13b4502a7321b67235402333dab2c108d57614c89d9de |
| P16 normalized prefix | 6270837f9a070cf9b427d5cc3cce86a8c12ca5ebc63d23f1ae675d6eca577f6b |
| Historical profile test file | 89d7c0d2c35b4e619f7839335419e9e65bafc5b275ea2716a5ffb5ee6909631a |
| Ignored capture core | a0a2314b345fa945ca857fb6437018b265a531b1807f68d3318484a21b8560ee |
| Ignored synthetic driver | 67af93da4395c114595c6d7cf18a1c6ba8125c157b11f56075feac41d9c8222d |

| Ordered command | Native exit | Result | Supervisor wall / final ms |
| --- | --- | --- | --- |
| Closed correction-binding synthetics | 0 | 10/10 PASS; 110 registered, 100 not selected | 2498 / 2540 |
| profile-reference-contracts | 0 | 4 active PASS; 1289 filtered skips; complete coverage | 13039 / 13051 |
| pnpm typecheck | 0 | PASS | 20044 / not separately reported |

The synthetic command used only the reviewed in-memory absolute-root and closed-selector substitutions; their inverse recovered the unchanged on-disk launcher before invocation. All eight new binding groups and both existing documentary/reference audit bodies passed. The historical default ninety and twelve progress checks were not repeated. Synthetic pending/invalid/timeout cases are expected fixtures, not unknown check outcomes.

The four-reference focal used the unchanged original launcher outside the sandbox, foreground with freshly owned external TEMP/TMP. The receipt has expected/observed active coverage 4/4, native root exit, both EOFs, passed run-end, no unhandled error, no stream failure and no outer deadline; termination fields stayed null. Its bounded visible capture saturated while draining continued. All 1293 registered cases were observed, but only four passed actively; the other 1289 are filtered skips.

Typecheck followed both PASS results, using the fixed compiler command through verified parent Node and the standard package-manager entry. It ran once outside the sandbox in the foreground with a separately owned qualified external TEMP/TMP root, unchanged ten-variable environment allowlist plus CI and the original 900000-ms wait/owned-tree termination boundary. Native exit was 0, no termination was requested and the temporary parent was retained. No separate process cleanup or probe ran.

Stop at this authorized boundary. No real correction diagnostic, original full gate/suite, build/schema check, CI, browser/runtime smoke, paid call, independent cleanup, commit, push or merge ran. The repair adds no runtime capability and retains all assertions, test/poll/command limits and protected execution files. No manual local UI validation is needed for this diagnostic-only change. The latest real correction still failed after 90000 ms with unusable binding evidence; this preparatory PASS does not resolve that timeout or close T008/F2. A separately authorized single correction diagnostic is the next proposed step. Original acceptance, separate Harness/browser evidence and private-pilot readiness remain pending.

#### Single authorized correction diagnostic after identity repair - PASS, 2026-10-29

The owner separately authorized exactly one real diagnostic with the repaired capture and the unchanged 900-second command limit, stopping at the first failed/unknown result. Preflight matched all thirteen validated source/execution identities, unchanged HEAD/branch and empty index. The original `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection workflow-correction` ran once outside the sandbox, in the foreground, with its freshly owned qualified external TEMP/TMP.

Result: **native exit 0 / diagnostic PASS**. Expected/observed active coverage is **2/2**, with 79 registered/observed/completed cases, two active passes, zero failures and 77 filtered skips. Attribution is `complete`, run-end `passed`, one passed module, zero unhandled errors, no open cases or pending modules, and no failure details. The active cases at `runner/workflow-orchestrator.test.ts:980:24` retained their exact opaque identities:

| Variant / opaque prefix | Native case status | Reported duration ms | Progress sequence / binding |
| --- | --- | --- | --- |
| qa-false / 654393c136aa | passed | 63188.3692 | 180 / confirmed |
| qa-true / ec412574d5af | passed | 60693.686 | 180 / confirmed |

Progress is `observed` / `captured`. Both rows are bound to their exact passed case IDs, sealed, without a sticky reason, and have empty fixture/attempt stacks. Each last-closed frame is fixture `case` / `return`, sequence 179; each last milestone is attempt `task.finished`, stage `qa`, ordinal 7, sequence 160. This exercises the repaired binding against the actual fixture; these observations remain diagnostic facts rather than separate execution authority or proof of a timeout cause.

Native root exit and both EOFs were observed, with no stream failure or output truncation. Node observer wall was 128935 ms; the supervisor completed with exit 0 at wall/final **129197/129203 ms**, start returned at 10 ms, guarded wait at 129184 ms and capture closed at 129196 ms. The 900000-ms deadline was not reached; termination, kill and post-kill fields were null. Both original selected cases and their original teardown hooks/assertions passed. There was no independent cleanup audit or extra process probe, temporary parents remain retained, and historical cleanup uncertainty is not retroactively resolved.

The previous 90000-ms case timeout did not reproduce in this single isolated invocation. Its cause, full-suite behavior and any causal performance effect remain unproven. Stop at this authorized boundary; only these three evidence records changed afterward. No rerun, source/guard/timeout adjustment, further check, typecheck, schema/build, full gate/suite, CI, smoke, paid call, independent cleanup, commit, push or merge ran.

T008 stays unchecked and F2 `in_progress`. The original seven-command acceptance gate, separate Harness and real F2 API/browser evidence, and private-pilot technical/human checkpoint still prevent closure. P/Q historical outcomes are unchanged and F3 remains unauthorized. Proposed next continuation: resume the original gate under its existing 900 seconds per command and capture, with separate owner authority; this diagnostic PASS does not launch it.

#### Original gate resumed after correction PASS - timeout, 2026-10-29

The owner explicitly authorized one resumption of the original T008/F2 gate, capturing both streams, preserving 900 seconds per command and stopping at the first failure/unknown, without CI or Git publication. Preflight matched 96 out-of-scope changed-file identities, eight protected execution/source hashes, five validated fixture/capture/reference sources, the recorded HEAD/branch and empty index.

The unchanged `validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900` ran once outside the sandbox in the foreground, through the prepared host with qualified owned external TEMP/TMP and parent PATHEXT preserved only for that host. Node and the standard package-manager entry were resolved before launch. No aggregate 900-second cap shortened the seven-command gate; the original validator retained its own per-command environment, wait and owned-tree termination behavior.

Result: **native exit 1 / FAIL**, outer wall **901630 ms**, both EOFs, no truncation. Captured stdout was empty. The ANSI-normalized stderr was exactly:

```text
Write-Error: Acceptance check timed out; process tree terminated
```

No acceptance PASS marker or final spec/check summary was emitted. The fixed first catalog command, `pnpm test` / `ac-behavior`, exhausted its 900-second allowance. The remaining commands were **NOT RUN**: `pnpm schemas:check`, `pnpm typecheck`, `pnpm build`, `pnpm repository:check`, `pnpm secrets:check`, `pnpm evals:check`. The original Harness discards internal child output; the complete outer capture therefore supplies no test counts, failing assertion/location or precise suite-duration breakdown. Empty stdout is not evidence that zero tests ran.

The validator reported owned-tree termination and its outer process closed natively. Fixture cleanup remains **UNKNOWN**, and the owned temporary parent remains retained. The 901630-ms outer interval includes initialization/termination/capture overhead; the configured per-command wait remains 900000 ms. No independent process/filesystem inspection, cleanup or post-failure check followed.

Execution stopped at this first failure. Only this task evidence, the acceptance runbook and roadmap were updated afterward. No retry, further diagnostic, repair, profiling, source/guard/timeout/catalog/global-environment change, CI, audit, Harness/browser/runtime smoke, paid call, sibling operation, commit, push or merge occurred. The earlier isolated correction 2/2 PASS and valid v2 progress remain scoped historical evidence; they do not establish full-suite acceptance or diagnose this timeout.

T008 remains unchecked and F2 `in_progress`. Whole-suite timeout resolution and the original complete gate, separate Harness/actual F2 API-browser evidence and private-pilot technical/human checkpoint still prevent closure. P/Q history and F3 authority remain unchanged. Any next investigation or execution needs a separate bounded continuation; no successor was started from this failed result.

#### Approved unchanged full-suite attribution plan - 2026-10-29

The owner approved documenting this plan and executing exactly one `full-suite-attribution` diagnostic under the existing 900000-ms limit. The only write targets are this task evidence, `docs/runbooks/factory-request-contract-acceptance.md` and `docs/roadmap/factory-local-poc.md`. Reuse the existing validated ignored launcher, runner, reporter, core and synthetic driver without edits. Preserve all pre-existing work and recorded historical outcomes.

Preparation is read-only identity verification: recorded HEAD/branch/empty index, 96 out-of-scope changed-file hashes and thirteen protected/validated source-execution identities. The closed invocation is `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection full-suite-attribution`. Run once outside the sandbox in the foreground with the launcher's newly qualified, independently owned external TEMP/TMP. The underlying fixed command is the complete package test script with verbose output, the derived public reporter and task locations. Keep the two configured workers and original suite behavior; add no filter, bail, timeout, guard, environment, output-limit or termination change.

Use the existing bounded output to distinguish expensive completed work, still-open work, concrete failures, and incomplete process/stream closure. Retain up to twenty ranked cases, sixteen ranked modules, sixteen open cases, eight pending modules and four failed-case/error details with explicit omission counters. Native child exit, EOFs, reporter lifecycle and supervisor timing remain separate facts. Reported durations are not CPU profiles or additive global wall time; pending ages are since local receipt. Failure identities and error-detail digests are not an invented exact join.

At native failure/unknown or the existing deadline, stop without retry, repair or successor; the unmodified complete-suite invocation retains its original no-bail behavior internally. Even a diagnostic PASS does not authorize the original gate, Harness/browser checks or F3. Missing final error blocks, truncation or omitted rows remain explicit uncertainty. Existing owned-tree termination is not independent cleanup evidence.

Document preparation and then this single result only. Do not repeat synthetics, focal tests or typecheck; add no profiler/capturer and run no CI, audit, smoke, paid call, process probe/extra cleanup, sibling operation or Git publication. At this documentary checkpoint the one real diagnostic is authorized but NOT RUN. T008 stays unchecked, F2 in progress. Full closure still requires resolution of the observed suite issue, the original complete seven-check gate, separate Harness/API-browser acceptance and the private-pilot scope/baseline/criteria/sources/commands confirmation.

#### Single unchanged full-suite attribution - TIMEOUT / incomplete coverage, 2026-10-29

The documented diagnostic ran exactly once through the unchanged launcher outside the sandbox, in the foreground with qualified owned external TEMP/TMP. Preflight preserved the 96 out-of-scope changed-file hashes, eight protected identities, five validated source identities, HEAD/branch and empty index. No execution artifact, test, worker, filter, bail, guard, timeout or output limit changed.

The retained diagnostic reached its existing 900000-ms deadline: status `timeout`, coverage `unknown` / `missing-run-end`, no run-end or terminal suite summary. At the observation point, suite native exit was null, root exit was not seen, stdout/stderr EOF were false and stream failure was false. Node observer wall was 899791 ms, with deadline observed at 899754 ms. The host tool subsequently closed the session with observed exit 1. Do not substitute that outer code for an unobserved suite exit.

| Retained inventory | Observed | Completed | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| Modules | 151 | 150 | 150 | 0 | 0 |
| Cases | 6561 | 6560 | 6546 | 0 | 14 |

These are partial observed counts, not a final complete test inventory. No failed case or bounded failure detail was observed. Exactly one observed case and module remained open; additional cases may not yet have started. The incomplete workflow module had 72 completed cases. Its only retained open case was `runner/workflow-orchestrator.test.ts:1028:118`, opaque ID `983d47573c360b877dfad2c9f0e5dc5f162c1b4a02125cf482d37f0d91ae7db0`, with ready reporter time 869205.159 ms and local age 29514.4416 ms. This is not an observed individual-test timeout or proof of a specific blocked operation.

The sole pending module was `runner/workflow-orchestrator.test.ts`, phase `started`, with reporter queue/collection/start times 385956.0711 / 387864.778 / 387865.9943 ms and local pending age 510853.6154 ms. Local age is since event receipt; it is not interchangeable with a reporter duration or CPU time. Its terminal module timings remain unavailable.

The following module ranking uses sums of reported durations for completed cases, rounded to three decimal milliseconds. It excludes unfinished work and is not additive global wall/CPU attribution:

| File | Module status | Completed cases | Reported case sum ms |
| --- | --- | --- | --- |
| runner/workflow-orchestrator.test.ts | pending | 72 | 475276.732 |
| dashboard/src/server/workflow-service.test.ts | passed | 111 | 129762.497 |
| dashboard/src/server/workflow-api.test.ts | passed | 29 | 115411.759 |
| runner/run-task.test.ts | passed | 85 | 108553.831 |
| scripts/harness-validators.test.ts | passed | 98 | 93431.993 |
| runner/task-orchestrator.test.ts | passed | 80 | 55795.263 |
| dashboard/src/server/issue-service.test.ts | passed | 191 | 54288.851 |
| runner/routine-runner.test.ts | passed | 55 | 47920.864 |
| dashboard/src/server/workflow-context-service.test.ts | passed | 111 | 47274.730 |
| lib/budgets/reservations.test.ts | passed | 85 | 41377.456 |
| scripts/profile-maintenance.test.ts | passed | 1293 | 39973.055 |
| runner/worktree.test.ts | passed | 42 | 39414.908 |
| lib/state/routines.test.ts | passed | 112 | 37666.120 |
| runner/workflow-stage.test.ts | passed | 17 | 34519.653 |
| lib/routines/actions.test.ts | passed | 72 | 32930.992 |
| runner/verify.test.ts | passed | 18 | 21154.682 |

The ten largest of the twenty retained completed-case rows were:

| Location | Opaque ID prefix | Case status | Reported duration ms |
| --- | --- | --- | --- |
| runner/workflow-orchestrator.test.ts:980:24 | ec412574d5af | passed | 75077.460 |
| runner/workflow-orchestrator.test.ts:980:24 | 654393c136aa | passed | 72198.161 |
| dashboard/src/server/workflow-api.test.ts:253:56 | d42048a1e27e | passed | 46059.445 |
| dashboard/src/server/workflow-api.test.ts:253:56 | 4017f972d54c | passed | 45272.034 |
| runner/workflow-orchestrator.test.ts:1021:112 | 6da6eca3dafc | passed | 37889.494 |
| runner/workflow-orchestrator.test.ts:1021:112 | abd6bfa17bc3 | passed | 36245.881 |
| runner/workflow-orchestrator.test.ts:808:36 | 274ec5a1ff4f | passed | 34582.094 |
| runner/workflow-orchestrator.test.ts:1021:112 | 26c9961c632d | passed | 34429.163 |
| runner/workflow-orchestrator.test.ts:808:36 | 4a8e3c9e1226 | passed | 24633.944 |
| runner/workflow-orchestrator.test.ts:796:3 | 16c41462390a | passed | 24141.133 |

The two correction variants at line 980 both passed in this complete-suite workload (72198.1612 / 75077.46 ms), independently of their earlier isolated PASS. The line-1021 group also supplied three completed passing rows. The new observation localizes a large accumulated workflow-fixture cost and later unfinished work; it does not establish a causal filesystem, policy, wait or CPU explanation.

The observer retained twenty ranked cases, sixteen ranked modules, one open case and one pending module. Capacity omissions were zero, with no open/pending/failure omissions; ranking omissions were 6526 cases and 135 modules. Visible/bounded output was truncated while draining continued. The observation counted 7438867 stdout bytes, 19458 stderr bytes, 20665/317 lines and 696 discarded non-public lines; raw bodies were not retained in this record. No capture schema/order/identity error was reported; expected missing final lifecycle remains incomplete coverage.

The original PowerShell supervisor reported `deadline`, owned-tree termination requested and fixture cleanup `unknown`. Timing: start returned 10 ms, guarded wait 900021 ms, termination requested 900022 ms, kill returned 900062 ms, post-kill wait returned 900064 ms, final 900072 ms; capture-closed time was null. The outer session is closed, but the pre-termination suite receipt lacks native exit and EOFs. Neither these facts nor the reported kill certify fixture cleanup. Owned temporary parents remain retained, and historical cleanup uncertainty is unchanged.

Execution stopped at this timeout/incomplete result. Only the three authorized evidence documents changed afterward. No source inspection, post-failure hash/process probe, repeat, repair, synthetic/focal/typecheck, schema/build, gate, CI, audit, smoke, paid call, sibling operation, independent cleanup or Git publication followed. Original assertions, capabilities and limits remain intact.

T008 stays unchecked and F2 in progress. The proposed next bounded design is read-only inspection of the line-1028 case, costly groups at lines 980/1021/808/796 and their shared fixture helpers, seeking repeated work while preserving assertions and every guard/timeout. That inspection or any implementation/execution is not started by this result. Full closure still needs the original seven-check gate, separate Harness/API-browser acceptance and private-pilot technical/human confirmation.

#### Approved seven-negative-case checkpoint optimization - 2026-10-30

The owner approved this concrete six-file adjustment and its focused validation, without changing the F2 acceptance contract or deferring its complete-suite requirement. Targets: `runner/workflow-orchestrator.test.ts`, exactly five fixed-size reference literals in `scripts/profile-maintenance.test.ts`, the same five current literals in the existing ignored synthetic inverse audit, this task evidence, the acceptance runbook and active roadmap.

Only the two negative T010 parameterized groups (three unavailable-authority and four unsuccessful-correction variants) now opt into the existing `checkpointSetup: true`, `advanceCheckpoint` and final `checkpoint` paths. Their assertions use only workflow, stages, decisions, review receipts and lineage. The existing checkpoint equivalence, read-count, invalid-identity, copy-isolation and freshness assertions also apply. This removes exactly 37 explicit test-owned public-detail observations: twelve in the first group and twenty-five in the second. Production/implicit reads remain. No assertion, variant, task, real Git/worktree/verification, refusal, reconciliation, teardown or budget changes; original 90000-ms cases, 15000-ms waits and two-worker configuration remain.

All other fixture consumers, including partial admission, T007 budget views and T013 recovery/accounting, retain the full-detail path. The four-line inverse reconstructs the immediately prior fixture SHA `c6d0c267e4ccd2bd4d8daebfda213f4dbca36d36f69036f647ca26ac1caa4a18`; the historical profile remains 583607 bytes and its five-literal inverse restores prior SHA `89d7c0d2c35b4e619f7839335419e9e65bafc5b275ea2716a5ffb5ee6909631a`. No independent pins, historical assertion bodies, observer/default inventories or execution artifacts change.

The authorized sequence is exactly: static scope/preservation review; the seven selected negative cases once using the fixed name pattern `denies unavailable correction authority without a new task|retains consumption and stops after unsuccessful correction`; four `profile-reference-contracts` cases; typecheck only after preceding PASS results. The first command is `pnpm exec vitest run runner/workflow-orchestrator.test.ts --testNamePattern <fixed two-group pattern> --bail=1 --reporter=verbose --includeTaskLocation`, with expected seven active passes and 72 filtered skips. Use foreground execution outside the sandbox, freshly owned external TEMP/TMP and 900 seconds per command, preserving existing environment/ownership/termination boundaries. Reference execution reuses the unchanged closed launcher. Stop at first failed/unknown; native closure and exact selected coverage are required.

Implementation is complete and focused validation is NOT RUN at this checkpoint. No synthetic matrix, other focal tests, full suite/gate, CI, audit, Harness/browser/runtime smoke, paid call, process probe/extra cleanup, sibling operation or Git publication is authorized. Measured savings are not yet available; the 37 removed calls do not establish a causal performance gain or enough savings for the full gate. T008 remains unchecked and F2 in progress, with original-gate, Harness/browser and private-pilot checkpoints preserved.

#### Seven-negative-case focused results - approved slice complete, 2026-10-30

The six-file adjustment passed static and focused validation. A scope audit preserved 97 pre-existing changed files outside this increment, ten protected source/execution identities, HEAD/branch and empty index. The fixture four-line inverse restores its immediate previous SHA; no existing assertion body, variant, timeout or task execution changed. Exactly five 64-character profile reference literals and the five current inverse-audit literals changed; the profile remains 583607 bytes, with both immediate and historical preservation boundaries retained.

| Current artifact/reference | SHA-256 |
| --- | --- |
| Workflow fixture / two reference slots | 93249820fd2c7edff923c1ccd8f70760abdce35ac55dca9e13ba7f606b406c87 |
| P14 prefix | 29a4a08160bf277011e81327ed4bcc59b02d1f246f9c5ee394ad7fc3b276e863 |
| P15 prefix | 14df0037ca4e42d65311b396393edf1119156b91e0df3d74aa24bbd9cf84083b |
| P16 normalized prefix | 146f86454f3017cf3f893fbe6e994b11403aaa6a01724358096ce80f76aee7b7 |
| Historical profile test file | e8148953f2026de62479908c5e99e44b8b6117a29d44a515f98996e5ed7f469f |
| Ignored synthetic inverse audit | 5ba71191d69dc1161349c774c51cb901ccea3d2407cc0217e72db6b5daf6b77a |

| Ordered validation | Native exit | Result | Supervisor wall ms |
| --- | --- | --- | --- |
| Seven selected T010 negative variants | 0 | 7 active PASS; 72 filtered skips; one file passed | 271221 |
| profile-reference-contracts | 0 | 4 active PASS; 1289 filtered skips; complete coverage | 3713 (final 3721) |
| pnpm typecheck | 0 | PASS | 21438 |

The fixed-pattern command ran once with native foreground completion, captured stdout/stderr EOFs, empty stderr, no termination request and the unchanged 900000-ms allowance. Exact active group coverage was three unavailable-authority and four unsuccessful-correction cases. Vitest reported 268.55 seconds total, 262.05 seconds tests; integer durations from its verbose case rows were:

| Selected group / variant | Reported duration ms | Result |
| --- | --- | --- |
| unavailable-authority / 0 | 37367 | PASS |
| unavailable-authority / 1 | 34591 | PASS |
| unavailable-authority / 2 | 33931 | PASS |
| unsuccessful-correction / 0 | 36783 | PASS |
| unsuccessful-correction / 1 | 37311 | PASS |
| unsuccessful-correction / 2 | 47277 | PASS |
| unsuccessful-correction / 3 | 34783 | PASS |

The reference command reused the unchanged original closed launcher outside the sandbox with separately owned TEMP/TMP. Its receipt has expected/observed active coverage 4/4, complete attribution, passed run-end, zero failures/unhandled errors, native root exit, both EOFs, no stream failure/deadline and null termination fields. Display saturation did not prevent draining or coverage. The four-case receipt reports 1293 registered cases, not 1293 active passes.

Typecheck then ran once through the same in-memory owned foreground host with only its closed mode changed to the fixed compiler command. It used a fresh qualified external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000-ms wait/owned-tree termination boundary. It closed natively with both EOFs, empty stderr and no termination request. No new persistent launcher, selection, observer or profiler was introduced.

The explicit public-detail call reduction is proven statically (37 removed); sufficient wall-time savings are not established. The three unavailable-authority cases sum to 105889 ms in this isolated run, versus 108564.5374 ms in the earlier loaded whole-suite observation. Those different runs/workloads are not a controlled before/after comparison, and the approximately 2676-ms difference cannot be attributed causally or extrapolated. The four unsuccessful-correction cases sum to 156154 ms; all seven sum to 262043 ms, consistent with the rounded reported test total. This evidence does not show that the complete suite will fit 900 seconds.

Selected original worker/fixture teardown assertions passed; owned temporary parents were retained without independent cleanup. Historical timeout/cleanup uncertainty remains. No manual UI check is required for this fixture-only change. Runtime capabilities, assertion semantics, schema/storage/product behavior, worker count, independent pins and all limits remain intact.

Stop after the conditional typecheck PASS. Only the six approved files changed; no synthetic execution, other focal/complete-file/full-suite campaign, original gate, schema/build, CI, audit, Harness/browser/runtime smoke, paid call, process probe/extra cleanup, sibling operation, commit, push or merge ran. T008 remains unchecked and F2 in progress. A further original-gate run is not automatically warranted by this result. Any acceptance-strategy revision or larger fixture/test-structure adjustment needs explicit review; the existing full gate, Harness/browser and private-pilot requirements remain unchanged.

## Approved F2 functional acceptance revision - 2026-10-30

The owner approved the exact [revision](../../../docs/proposals/f2-functional-acceptance-revision.md) and its five existing-document activation with documentary checks only. Session acknowledgement is `2026-10-30T13:46:42Z`. This is prospective review of acceptance scope, not retrospective approval of implementation or a passing product result. The original design/spec/task approval acknowledged on `2026-10-24T14:25:58Z` and every subsequent result above remain historical.

Only active `ac-behavior` is retired from the executable spec list. The remaining six check blocks retain their IDs, exact commands, requirement mappings, descriptions and expected exit 0. `checksWaiver` stays null. The original exact catalog, validators, schemas, assertions, workers, budgets and test/poll/900-second command limits remain unchanged. The future validator run is the revised six-check gate; it cannot be reported as the original seven-check gate PASS.

### Archived original check definition

The following original definition is retained verbatim as historical data, not an active check or execution authority. Its recorded FAIL/TIMEOUT/UNKNOWN results above remain unchanged.

```yaml
    - id: ac-behavior
      requirementIds: [req-001, req-002, req-003, req-004, req-005, req-006]
      description: Offline tests prove receipt semantics, persistence compatibility, UI uncertainty, context attribution and current human gates. The separately authorized real local browser smoke and real-project human checkpoint remain mandatory and are not certified by this command.
      command: pnpm test
      expectedExitCode: 0
```

### Mandatory functional evidence outside the guarded catalog

The complete fixed commands, sequence, baseline/coverage rules and lifecycle requirements are in [Current F2 functional acceptance](../../../docs/runbooks/factory-request-contract-acceptance.md#current-f2-functional-acceptance). The IDs below are external procedure references, not invented YAML checks or package aliases.

| Procedure | Required scope |
| --- | --- |
| f2-functional-state-http | Complete issues store, issue service and API index files; req-001/002 identity, replay/conflict, immutable compatible receipts, persistence failures, protected HTTP and no intake execution |
| f2-functional-context-plan | Complete context sources, context service and workflow API files; req-004/005 attribution, exclusions, current consent/scope/plan gates and drift/refusals |
| f2-functional-ui | Complete IssuesView, ContextPreview and WorkflowPanel files; req-003/004/005 explicit pending/retry/reload uncertainty and bound human decisions |
| f2-functional-smoke-helpers | Existing reviewed read-synchronization/Issues-refresh helper selection, with actual selected coverage; supporting evidence rather than a browser substitute |

The first three groups comprise nine complete files without individual-case filtering. Prior passes, overlapping totals and filtered skips do not automatically satisfy the revised current-baseline acceptance. Record native results, coherent coverage and complete streams; unexplained or requirement-critical skips leave acceptance incomplete.

After the revised six-check gate and four functional commands pass under separate authority, require `pnpm harness:check`, then `pnpm smoke:local:playwright` through its actual isolated local API/Vite/browser. Preserve all prior K-O checks and exactly 31 fake turns; new intake/context/recovery/refusal assertions introduce no dispatch. Confirm current owned-process closure and fixture removal separately. No paid execution, normal-state or sibling mutation, arbitrary cleanup, CI, audit, publication or F3 operation is included.

Full F2 closure also requires the owner-confirmed private pilot baseline, already supplied request/outcome, concrete criteria, allowed/excluded paths and categories, contained context sources, trusted verification commands and approver. Technical preparation needs its own authorized scope. Fixture success does not satisfy that human checkpoint, create a real issue or authorize a runtime turn.

### Open debt and completion boundary

`DEBT-F2-GLOBAL-900` remains an independent open roadmap debt for complete whole-repository regression/performance. Removing its blocking role applies only to this explicitly revised functional F2 exit. Keep all old failures, timeouts, unknown coverage and historical cleanup uncertainty; do not relabel them successful or close the debt from focused/browser evidence. No unchecked T009 debt task is added to this feature.

T001-T007 completion lines are preserved and T008 remains unchecked. The active requirement IDs and req-001 through req-005 behavior remain unchanged. Six catalog PASS results alone cannot complete F2. Only all revised mandatory checks, relevant known cleanup and human pilot readiness can later justify T008 completion, with the global debt still open. That future report must distinguish functional PoC acceptance from whole-checkout/CI/Q acceptance and retain separate F3 permission, budget and runtime opt-in.

Current authority ends after documentary activation and the owner-authorized documentary checks. No acceptance test, gate, typecheck, build, smoke, campaign, process investigation/cleanup, commit, push or merge is executed in this activation. Report documentary results and unavailable tooling honestly; those results do not launch acceptance. Metadata cannot grant execution authority.

## Revised six-check H4 gate result - 2026-10-30

After documentary activation, the owner explicitly authorized exactly one revised six-check gate, capturing both validator outputs with 900 seconds per command and stopping on failure/unknown. The existing validator ran once in the foreground outside the sandbox, using newly owned qualified external TEMP/TMP:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

Read-only preflight matched all six approved check definitions and the five activated-document hashes; 98 out-of-scope changed-file hashes, nine protected artifacts, HEAD/branch and empty index remained unchanged. The in-memory host preserved parent PATHEXT only for the validator host and concurrently captured its stdout/stderr. The unchanged validator/common child environment, checks, guards, timeout/termination behavior and catalog were retained; no shorter aggregate deadline was added.

| Ordered active check | Exact command | Validator-reported native exit |
| --- | --- | --- |
| ac-schemas | `pnpm schemas:check` | 0 |
| ac-types | `pnpm typecheck` | 0 |
| ac-build | `pnpm build` | 0 |
| ac-repository | `pnpm repository:check` | 0 |
| ac-secrets | `pnpm secrets:check` | 0 |
| ac-evals | `pnpm evals:check` | 0 |

Result: **revised six-check gate PASS**, foreground tool native exit 0/session closed. Host receipt: `status: completed`, `exit_code: 0`, `wall_ms: 36578`, per-command timeout 900 seconds, no aggregate timeout imposed, both EOFs true and both truncation flags false. Validator stderr is empty; stdout has exactly six ordered `[OK] acceptance <id>: exit 0` markers and `[OK] specs: 1 structurally checked; 6 checks executed`.

This capture is of validator output. Its unchanged common helper drains and discards individual child streams; per-case counts and child/build warnings cannot be recovered or declared absent from this receipt. No complete `pnpm test`, original seven-check PASS, CI result or fixture-cleanup success is inferred. Owned temporary parents remain retained, and historical cleanup uncertainty and `DEBT-F2-GLOBAL-900` remain open.

Execution stopped at the approved boundary. Only this task evidence, the acceptance runbook and active roadmap were updated afterward; no functional test command, Harness, real API/Vite/browser, pilot inspection, full suite, CI, audit, smoke, paid call, sibling operation, independent process investigation/cleanup, commit, push or merge followed. No source, guard or timeout changed. The next required stage is the four fixed functional commands under separate explicit authority, followed by the remaining Harness/browser/human criteria. T008 remains unchecked and F2 in progress; F3 is not authorized.

## Four functional block results - 2026-10-30

After the revised gate PASS, the owner authorized all four functional blocks and explicitly excluded eval suites. The exact commands below ran once in order, outside the sandbox in the foreground with fresh qualified owned external TEMP/TMP:

```text
pnpm exec vitest run lib/state/issues.test.ts dashboard/src/server/issue-service.test.ts dashboard/src/server/index.test.ts --bail=1
pnpm exec vitest run lib/context/sources.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/workflow-api.test.ts --bail=1
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/components/ContextPreview.test.tsx dashboard/src/ui/components/WorkflowPanel.test.tsx --bail=1
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|Issues refresh)" --bail=1
```

| Procedure | Files passed | Active PASS | Skipped / filtered | Native exit | Host wall ms | Vitest duration |
| --- | --- | --- | --- | --- | --- | --- |
| f2-functional-state-http | 3 | 376 | 0 / 0 | 0 | 54727 | 53.40 s |
| f2-functional-context-plan | 3 | 72 | 0 / 0 | 0 | 104066 | 102.93 s |
| f2-functional-ui | 3 | 209 | 1 / 0 | 0 | 11592 | 10.50 s |
| f2-functional-smoke-helpers | 1 | 28 | 0 / 70 | 0 | 2325 | 1.27 s |

All four receipts report `passed`, both stdout/stderr EOFs, empty stderr, native foreground session closure and no owned-tree termination request. Captured terminal JSON was complete and parseable. The existing in-memory host retained the ten-variable environment allowlist plus CI, original 900000-ms wait and owned-tree termination boundary. No worker, test/poll/command timeout, guard, reporter or argument change was introduced beyond selecting each approved command. Its per-command receipt does not itself certify full phase acceptance.

Actual inventory matches independent source review: store/service/index 91/191/94; context sources/service/workflow API 12/31/29; IssuesView/ContextPreview/WorkflowPanel 87/16/106 active; helper groups fourteen plus fourteen. The first three commands ran all nine complete files without case filtering. Exactly **685 active cases passed**. IssuesView's single skip at line 96 is its existing `SURTEC_ISSUE_OPERATING_BROWSER_SMOKE` opt-in; that variable and `SURTEC_WORKFLOW_BROWSER_SMOKE` were absent. Inline browser-only branches were also not exercised. The helper's seventy filtered cases are not executed passes. These exclusions do not replace the mandatory real API/Vite/browser smoke.

Preflight preserved 107 baseline identities, exact commands and Git state. Post-execution review preserved 111 distinct source/document/protected identities, HEAD/branch and the empty index, with T008 unchecked. Only this task record, the acceptance runbook and active roadmap changed afterward. HTTP, real Git/worktree/verification and teardown within test-owned synthetic fixtures are inherent to these approved files; no commit/push occurred in this checkout. Passing fixture teardown is not an independent removal audit, owned temporary parents remain retained, and historical cleanup uncertainty is unchanged.

Execution stopped after the fourth PASS, without evals, a complete repository suite, further focal/typecheck/build, Harness, actual browser smoke, CI, audit, paid runtime, pilot/sibling operation, independent process investigation/cleanup, commit, push or merge. No source, guard or timeout changed. Remaining acceptance is separately authorized Harness, real isolated API/browser with known owned lifecycle, and human pilot technical readiness. T008 remains unchecked/F2 in progress; `DEBT-F2-GLOBAL-900` stays open and F3 remains unauthorized.

## Harness and real browser attempt - 2026-10-30

The owner explicitly authorized continuing the remaining acceptance steps, preserving the existing no-evals boundary. Read-only preflight preserved 108 expected source/protected identities, the two exact package scripts, HEAD/branch and empty index, while separately recording the three evidence-document hashes. Each command ran once, in order outside the sandbox in the foreground, with newly owned qualified external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI, and 900000-ms per-command wait/owned-tree termination policy.

| Command | Native tool/child exit | Result | Host wall ms | Streams / termination |
| --- | --- | --- | --- | --- |
| pnpm harness:check | 0 / 0 | PASS | 5426 | Both EOFs, empty stderr, no termination |
| pnpm smoke:local:playwright | 1 / 1 | FAIL at browser launch | 15324 | Both EOFs, no termination; deadline not reached |

Harness output confirms three snapshots, ten declared context routes within 500 lines, six specs structurally checked with zero acceptance execution, six active task plans and its final structure/snapshots/budgets/contracts marker. No eval or behavioral suite was repeated by this check.

The smoke recorded stage `migrate legacy portfolio profiles in the real browser flow`, then `browserType.launch` reported Chromium distribution `msedge` absent from its expected local executable. Exact source call sites: `scripts/playwright-local-app-smoke.ts:377` (`launchBrowser`) and line 902 (`main`). The public record omits the machine-specific absolute path and raw stderr. This is a launch prerequisite failure, not a demonstrated F2 browser assertion regression; the capture alone does not explain the earlier selection/fallback cause. LF-to-CRLF warnings concern synthetic fixture Git setup and are not the terminal error. No PASS marker or exact 31-turn confirmation appeared; browser-dependent acceptance remains unexecuted/unverified.

The smoke finally receipt is `SMOKE_CLEANUP` with fixture ID `surtec-local-dashboard-Aud8iZ`, `browser_closed: true`, `vite_closed: true`, `api_stopped: true`, `workspace_removed: true`, `failures: []`, followed by `Temporary synthetic API state and repositories cleaned up.` These fields report its callbacks/removal, not an independent process audit, and closure defaults can describe resources not yet started. The wrapper-owned TEMP parent remains retained intentionally. Earlier cleanup uncertainty is unchanged.

Execution stopped immediately after this failure, before pilot preparation. Only this task evidence, acceptance runbook and active roadmap changed afterward. No post-failure browser/process/source inspection, install, retry, repair, evals, full suite, CI, audit, extra check, paid runtime, sibling operation, independent cleanup, commit, push or merge followed. No guard, timeout, source or assertion changed. Next proposed work is bounded read-only diagnosis of browser resolution, followed only under explicit authority by prerequisite repair and a smoke retry. T008 stays unchecked/F2 in progress; human pilot readiness and `DEBT-F2-GLOBAL-900` remain open and F3 unauthorized.

## Original Chromium error recovered - 2026-10-30

The owner explicitly authorized browser-resolution diagnosis and original-error recovery, without installation or a smoke retry. Read-only installed-source/package/cache inspection found Playwright 1.63.0, revision 1243 and an absent default LOCALAPPDATA browser cache. The Windows fallback at smoke lines 373-377 catches every original Chromium error and replaces it with the Edge attempt. The installed resolver uses `chromium-headless-shell` for the original `{ headless: true }` call; the full-browser path returned by `chromium.executablePath()` is a different executable.

One isolated probe ran that exact original launch call, with no fallback or other launch options, using the unchanged foreground host, ten-variable allowlist plus CI, newly qualified owned TEMP/TMP and 900000-ms boundary. It recovered `browserType.launch: Executable doesn't exist at %LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe`. The expected launch error was captured successfully: diagnostic tool/child exit 0, both EOFs, empty stderr, 453 ms host wall and no termination. Browser launch itself failed, with one launch attempt, zero fallback attempts, zero pages/navigation and closure `not-created`; no acceptance PASS is implied. Temporary artifacts may be created before executable validation, and the owned TEMP parent remains retained without independent cleanup.

A separate read-only presence check of six standard executable paths found Edge under ProgramFiles(x86) and Chrome under ProgramFiles, while Edge's LOCALAPPDATA candidate is absent. Playwright consults the two program-path variables, which the current ephemeral host omits. This explains why the fallback could not resolve the existing Edge executable; no assertion of globally missing Edge or a usable launch is made. Preserving LOCALAPPDATA means TEMP/TMP changes do not redirect the missing Chromium cache.

Only the three evidence records were updated. No source/guard/canonical environment/timeout change, browser installation, Edge launch, smoke retry, test/eval/Harness/CI/audit, pilot/sibling inspection, independent cleanup, commit, push or merge ran. Proposed next scope is forwarding only the trusted ProgramFiles(x86) OS path in the ephemeral validation host, then one Edge-only launch/close qualification, without weakening other environment or execution boundaries. It remains unapplied and needs explicit continuation. T008 stays unchecked/F2 in progress, with browser/pilot readiness and global debt open and no F3 authority.

## Managed Chromium without Edge - 2026-10-30

The owner chose the previously explained Playwright-managed Chromium path without Edge. This authorizes its download, the minimum Chromium-only smoke change, one launch/close qualification and one smoke continuation; the earlier no-install boundary no longer applies to that prerequisite. Preflight preserved 108 expected source/protected identities and HEAD/branch/empty index, confirmed Playwright 1.63.0 and the absent default cache, and fingerprinted the intended four repository targets. Existing ten-variable environment allowlist plus CI, qualified owned external TEMP/TMP, foreground execution and 900000-ms per-command boundaries were retained.

| Ordered operation | Native tool/child exit | Outcome | Host wall ms |
| --- | --- | --- | --- |
| pnpm exec playwright install chromium --only-shell --no-remove | 0 / 0 | Headless Shell 1243 installed | 10615 |
| chromium.launch({ headless: true }) and browser.close() | 0 / 0 | PASS; version 153.0.8010.12 | 1035 |
| pnpm smoke:local:playwright | 1 / 1 | FAIL in Phase N effect capture | 44300 |

All three receipts have both EOFs and no termination request; installer/probe stderr is empty. The installer reported only the 114.6-MiB Headless Shell download from the official Playwright CDN; static auxiliary targets are not additional observed downloads. `--no-remove` prevents browser GC; no force, system-dependency install, other browser install, dependency update or Edge path-variable change ran. The isolated browser probe opened no page/URL, used zero fallbacks and confirmed browser closure.

Only private `launchBrowser` changed in the smoke: direct `return chromium.launch({ headless: true })` replaces the Windows try/catch/Edge fallback. SHA changed from `retained privately` to `retained privately`. Its inverse preserved every other byte at edit time. Public helpers, assertions, real API/Git/verification flows, fake turns, cleanup, pins and every timeout remain. No profiler-reference cascade is needed. Earlier gate/functional/Harness passes preceded this launcher-only delta and were not repeated.

The actual Chromium smoke progressed to `Phase N no-effect preview, role/source guards and default privacy`, then failed with `Error: Browser API reads did not settle within the effect capture deadline`, from the existing tracker timer at source line 108. The 900-second limit was not reached. Stdout observed Vite optimizing `ajv/dist/2020.js` and reloading before the failure, but this does not prove causation or identify the pending GET or its server/request timing. No final PASS or exact 31-turn confirmation appeared.

The smoke reported `SMOKE_BROWSER_READ_CANCELLATIONS 0` and cleanup for `surtec-local-dashboard-4tRaec`: browser/Vite/API closure and workspace removal all true, `failures: []`, followed by removal confirmation. These are its own awaited lifecycle facts, not an independent audit. Owned wrapper TEMP parents remain retained; prior timeout-fixture cleanup uncertainty is unchanged.

Execution stopped at this failed command. Only this task record, acceptance runbook and active roadmap changed afterward; no further source/browser/process inspection, diagnosis, test, retry, assertion/guard/timeout change, eval, complete suite, CI, audit, paid runtime, pilot/sibling operation, independent cleanup, commit, push or merge followed. Next proposed work is bounded identification of the pending API read and completion around the observed Vite reload, preserving all assertions and deadlines; it is not started. T008 remains unchecked/F2 in progress, pilot readiness and global debt stay open, and F3 is unauthorized.

## Phase N read-only diagnosis - 2026-10-30

The owner authorized diagnosis only, without assertion/timeout changes or another smoke. Source/capture review identifies three possible `effects()` call sites under the same Phase N stage: 1026 before preview, 1050 after Node preview/refusal checks and 1093 after browser preview/consent checks. All use the original 10000-ms default. That deadline wraps pre-idle, filesystem hashing, post-idle and generation-triggered recapture; the existing error is not proof that a GET was still pending. The receipt lacks subphase/route identity, the tracker clears its in-memory set on disposal, no trace/HAR is configured and the fixture was removed. The exact offender therefore remains UNKNOWN.

Static candidates: overview/today/runs polling at 3/3/2 seconds; organization/operating overview; and dispatch-options/project client-context-options/context roles after the form mounts. Profile/session reads can occur on mount/reload. None is established as the stalled read. Node fetches do not enter the BrowserContext tracker; no deliberate SSE or held route is active here, and the intake interception begins later at line 1168. The preview does not request budgets. Vite's observed AJV optimization/reload is compatible with dynamic operating-view import but not demonstrated cause. Zero owned-navigation cancellations is not zero pending reads.

The proposed next increment has five existing targets: `scripts/playwright-local-app-smoke.ts`, `scripts/harness-validators.test.ts`, this task record, `docs/runbooks/factory-request-contract-acceptance.md` and `docs/roadmap/factory-local-poc.md`. Add error-only, privacy-safe bounded evidence at the original deadline before disposal: exact closed Phase N boundary, active snapshot phase, generation/recapture facts and pending GET route-family count/rows/omissions. Never emit arbitrary URLs/IDs, query/fragment, host, headers, tokens or bodies. Preserve existing assertion lines, pending tracking, exceptions, all timers/defaults and command/capture limits; add no probe, poll suspension or request exclusion.

Proposed checks, NOT RUN: six added diagnostic cases plus all fourteen existing read-synchronization cases with `pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|read diagnostics)" --bail=1`; conditional `pnpm typecheck` only after focused PASS. A smoke rerun is separately authorized work, not part of this diagnostic-only scope. No new primary entity, package/script/pin change or runtime authority is proposed.

Only the three evidence documents changed in this continuation. No source implementation, test/check, browser/API/Vite/process probe, assertion/guard/timeout change, install, eval, complete suite, CI, audit, pilot/sibling operation, cleanup, commit, push or merge ran. The observation proposal remains unapproved/unimplemented; T008 stays unchecked/F2 in progress, browser/pilot criteria and global debt remain open, and F3 is unauthorized.

## Phase N capture implementation and focused PASS - 2026-10-30

The owner approved the exact five-file capture proposal and authorized twenty focused tests, then typecheck only on success, stopping on first failure/unknown without changing existing assertions/timeouts or running smoke/evals/CI/publication. The implemented deadline error retains its original prefix and appends bounded `SMOKE_READ_DIAGNOSTIC` JSON before disposal. Each invocation has isolated phase/capture/generation facts and a closed boundary label; at most eight pending GET route-family rows are retained with total/omission counts. Unknown routes/getter failures normalize to `/api/:unknown`, and invalid labels to `unlabelled`. URL hosts, private IDs, queries/fragments, headers, tokens and bodies are never read for output or reflected.

The three Phase N labels are assigned before the existing calls and reset afterward; all 363 smoke assertion lines are identical. An inverse transformation restores the entire previous smoke source, proving unrelated bytes unchanged. Exactly six plain test cases were appended; the original 51435-byte prefix still hashes to `d95cbd10e14d835e13fb374355fb00d895ee51a8c0b1875284c3b3af17a91752`. Timers, defaults, pending request tracking, failure priority, recapture conditions, request exclusions and all command/capture limits are unchanged. No new runtime or probe was added.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|read diagnostics)" --bail=1
pnpm typecheck
```

| Ordered check | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| Exact focused selection | 0 / 0 | 20 PASS, 84 filtered skips; one file passed | 3462 |
| Conditional typecheck | 0 / 0 | PASS, tsc --noEmit | 21206 |

Both ran once, sequentially outside the sandbox in the foreground using fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000 ms per command. Both receipts have complete stdout/stderr EOFs, empty stderr, no termination and native closed sessions. Vitest registered 104 cases and executed 20 passes (fourteen existing synchronization cases plus six new diagnostic cases), reporting 1.74 seconds total and 30 ms tests; the 84 filtered cases are not passes. New coverage distinguishes stalled read, stalled filesystem capture and completed-read recapture, checks all three labels and invalid-label privacy, proves the eight-row bound/omissions and getter isolation, and verifies error evidence survives disposal.

Current smoke SHA is `3b703cacaa534288b23f072b14f802af54f7c83b3a32e2ab12072cec8d0991da` (prior `1f7d61e353a2e9d77de46498619f4b345d3be04d73ab634796a08fc2098be680`); current helper-test SHA is `3cf162b2a93f3388b15949ed618b2e5a89ee6ecfd548db6da244f580f0a9fe94`. Read-only preflight preserved 106 out-of-scope identities; final review preserved 111 current identities, existing-test prefix, HEAD/branch and empty index before the evidence updates. Only the two approved code/test files and three evidence records changed. Owned wrapper temporary parents remain retained without extra cleanup.

Execution stopped after typecheck PASS. No real browser/API/Vite, smoke, evals, complete suite, extra focal/build/Harness/CI/audit, install, process probe, paid call, pilot/sibling operation, independent cleanup, commit, push or merge ran. Actual endpoint identity remains UNKNOWN and the old smoke failure is unchanged. The next proposed separately authorized step is one Chromium-only smoke with the validated capture and existing limits; no rerun follows automatically. T008 remains unchecked/F2 in progress, browser/pilot readiness and global debt stay open, and F3 is unauthorized.

## Single smoke with validated capture - Phase M FAIL, 2026-10-30

The owner explicitly authorized exactly one smoke using the validated Phase N capture, without assertion/guard/timeout changes or a retry. Read-only preflight preserved 108 protected/source identities, the reviewed smoke/helper hashes, HEAD/branch and empty index; the three evidence documents were fingerprinted separately. The existing foreground host ran `pnpm smoke:local:playwright` once outside the sandbox with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000-ms boundary.

Terminal result: **FAIL**, native tool/child exit 1, `wall_ms: 45764`, closed foreground session, both stdout/stderr EOFs and no termination request. The 900-second command deadline was not reached. Recorded stage: `Phase M real API/browser read-only inventory, Doctor and explicit observation refresh`; `AssertionError [ERR_ASSERTION]` at `scripts/playwright-local-app-smoke.ts:1481:12`, `strictEqual`, actual `unknown`, expected `healthy`. The response's reason/baseline/provenance is not in the receipt; no explanation is inferred from that string alone.

The sequential smoke progressed beyond Phase N without reproducing its earlier deadline, and no `SMOKE_READ_DIAGNOSTIC` was emitted. This does not identify the earlier pending endpoint or prove a permanent correction. There was no final PASS or confirmation of exactly 31 turns. The familiar LF-to-CRLF warnings concern synthetic fixture setup; no new Vite optimization message was observed, without a causal conclusion.

The smoke reported zero owned-navigation read cancellations and `SMOKE_CLEANUP` for `surtec-local-dashboard-UlBfhU`: browser/Vite/API closure and workspace removal all true, `failures: []`, followed by cleanup confirmation. This is its own awaited closure/removal result, not an independent audit. Owned wrapper temporary parents remain retained; prior cleanup unknowns are unchanged.

Execution stopped at this first failed assertion. Only this task evidence, acceptance runbook and active roadmap changed afterward. No additional source/hash/process/browser inspection, diagnosis, repair, retry, focal/type/build/Harness/eval/full-suite/CI/audit command, install, paid runtime, pilot/sibling operation, independent cleanup, commit, push or merge ran. Next proposed work is a bounded review of the exact failed Harness response and fixture provenance/reason fields, preserving the existing healthy expectation and all limits; it is not started. T008 remains unchecked/F2 in progress, browser/pilot readiness and global debt remain open, and F3 is unauthorized.

## Phase M unknown: read-only fixture diagnosis - 2026-10-30

The owner authorized reviewing the latest `unknown` reason. The failing assertion at smoke line 1481 reads `healthyHarness.observation.status` from the Doctor GET. Source/service review confirms Doctor does not transform that observation status. The smoke's seed at lines 827-830 recursively copies the complete working `.agents` tree into canonical and both profile-project fixtures; the healthy copy is unchanged before the assertion, while the partial copy only has its validator deliberately removed.

A read-only file-size audit found `.agents/specs/tasks/phase-p-operational-continuity.tasks.md` at **314347 bytes**, exceeding `readContained`'s **262144-byte** default. `inspectHarness` walks additions as well as pins, catches the rejection as an `unsafe` entry and forces status `unknown`. This copied history is therefore a sufficient deterministic cause in the current fixture. The audit counted 36 `.agents` files and one over the per-file limit; all 25 manifest entries and manifest digest `f61aa371c5366a5886887d448328542e692a0446ec30683eaaa846e9cf727a4e` match the reviewed registry. No baseline repin is indicated. The exact runtime finding from the deleted failed fixture remains unavailable; no inspector/API was invoked to recreate it.

The existing curated builder in `lib/harness/inspect.test.ts:10-63` already materializes reviewed pins plus mandatory context/routing/first-hop support without copying arbitrary feature history, and its negative cases retain the exact file-size boundary. Proposed next correction is applying that fixture principle to the smoke's healthy/partial seeds (and coherent canonical support), preserving all source history and required bytes rather than raising production limits or relaxing expectations.

Proposed scope is five existing files: smoke source, `scripts/harness-validators.test.ts`, this task record, acceptance runbook and active roadmap. Add fixture regressions proving required pins/reference completeness, unselected oversized-history isolation and original-source preservation; retain missing-validator and genuine oversize-negative behavior. Proposed checks are the new helper tests, complete existing inspection-test file, and typecheck only after PASS, using the existing 900-second command boundary. No real smoke is included automatically.

Only the three evidence records changed now. No source fix, inspector/test/check/probe, browser/API/Vite, assertion/guard/timeout/manifest change, install, eval/full-suite/CI/audit, paid runtime, pilot/sibling operation, cleanup, commit, push or merge ran. The correction/checks remain unimplemented proposals; the last smoke remains FAIL and T008 stays unchecked/F2 in progress, with browser/pilot readiness and global debt open and F3 unauthorized.

## Curated Harness fixture correction and focused PASS - 2026-10-30

The owner approved the five-file correction and proposed verification. `materializeReviewedHarnessFixture` now prepares canonical and both profile Harness projects from the 25 byte-exact reviewed pins, every required budget/routing artifact and first-hop instruction references. It follows the existing inspected-fixture builder, validates all selected source inputs before writing destination files, preserves the existing 256-KiB/128-entry/2-MiB boundaries and writes exclusively. Unselected live feature histories are not copied; production inspection still reports genuine oversized additions as unsafe/unknown. Destination I/O is not a multi-file transaction and no rollback guarantee is claimed.

The main change is isolated to fixture preparation; all 363 smoke assertion lines, other source bytes, request tracking, snapshots, fake turns, guards and timeouts are preserved by an exact inverse. The five new helper tests are append-only after the original 60438-byte prefix. An initial JavaScript patch assembly failed in memory before any editor/mutation/check; the formatting was corrected within scope before the actual source edit and validation. No failed product check was repaired or rerun.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness fixture" --bail=1
pnpm exec vitest run lib/harness/inspect.test.ts --bail=1
pnpm typecheck
```

| Ordered check | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| Five new fixture regressions | 0 / 0 | 5 PASS; 104 filtered skips | 7811 |
| Complete inspection-test file | 0 / 0 | 15 PASS, no skips | 12093 |
| Conditional typecheck | 0 / 0 | PASS, tsc --noEmit | 27945 |

Each command ran once sequentially in the foreground outside the sandbox, with qualified owned external TEMP/TMP, unchanged ten-variable environment allowlist plus CI and 900000 ms per command. Every receipt has both EOFs, empty stderr, native closed session and no termination. Vitest reports 109 registered helper cases but only five active executions, duration 6.13 s/tests 4.00 s; the complete inspection file reports fifteen active passes, duration 10.53 s/tests 9.34 s. No filtered execution is counted as PASS.

Regressions verify complete required support and identical pins, healthy/compatible curated seeds, preservation/exclusion of unselected oversized history and a neighbor, partial/drift on a removed validator, unsafe/unknown for a genuine oversized addition without leaking its body, and source rejection before target writes for missing support/changed pins. Existing inspection cases preserve the exact 262144/262145-byte boundary and all negative behavior. Actual source history remains 314347 bytes and its previous hash; no task journal is truncated or removed.

Current smoke SHA is `9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59` (prior `3b703cacaa534288b23f072b14f802af54f7c83b3a32e2ab12072cec8d0991da`); helper-test SHA is `1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10`, with original prefix SHA `3cf162b2a93f3388b15949ed618b2e5a89ee6ecfd548db6da244f580f0a9fe94`. Preflight preserved 106 outside identities; final review matched all 111 current identities, protected history, HEAD/branch and empty index before updating evidence. The test cleanup asserts owned roots removed; wrapper temporary parents remain retained without independent cleanup.

Execution stopped after typecheck PASS. Only the two approved source/test files and three evidence records changed. No actual API/Vite/browser, real smoke, evals, complete suite, extra build/Harness/CI/audit, install, paid call, pilot/sibling operation, independent cleanup, commit, push or merge ran. This validates the fixture correction, not a fresh real Doctor/browser response or the full 31-turn smoke. That next single smoke requires separate authority; the last real result stays FAIL. T008 remains unchecked/F2 in progress, pilot readiness and global debt remain open, and F3 is unauthorized.

## Single curated-fixture smoke - absent-case FAIL, 2026-10-30

The owner authorized exactly one smoke after the curated seed's five focused regressions, complete fifteen-case inspection file and typecheck passed. Preflight matched 108 protected/source identities, smoke SHA `9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59`, helper-test SHA `1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10`, HEAD/branch and empty index; the three evidence records were fingerprinted separately. No assertion, source, guard or timeout changed.

One `pnpm smoke:local:playwright` invocation ran in the foreground outside the sandbox using Chromium, fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000-ms boundary. It returned **FAIL**, native tool/child exit 1, `wall_ms: 65514`, both EOFs, closed session and no termination request. The command deadline was not reached.

The recorded Phase M inventory/Doctor/refresh stage stopped at `AssertionError [ERR_ASSERTION]`, smoke line 1549, `strictEqual`, actual `unknown`, expected `absent`. Sequential earlier healthy status, compatible comparison and partial status assertions passed, so the former healthy-fixture failure did not recur. This is not full Phase M or smoke acceptance; the absent response's underlying findings/reason are unavailable from this receipt. No post-failure inspection was performed.

No Phase N deadline/read diagnostic, final PASS or exact 31-turn confirmation was emitted. The smoke reported zero owned-navigation read cancellations and cleanup for `surtec-local-dashboard-Osh3WF`: browser/Vite/API closure and workspace removal all true, `failures: []`, followed by cleanup confirmation. These are its own awaited lifecycle/removal facts, not an independent audit. Wrapper TEMP parents remain retained and prior cleanup uncertainty is unchanged.

Execution stopped at the first failed assertion. Only this task evidence, acceptance runbook and roadmap changed afterward. No additional source/hash/API/browser/process inspection, diagnosis, repair, retry, focal/type/build/Harness/eval/full-suite/CI/audit, install, paid runtime, pilot/sibling operation, independent cleanup, checkout commit, push or merge ran. The proposed next bounded review is the absent fixture's contents and response provenance, preserving the absent expectation and all limits; it is not started. T008 remains unchecked/F2 in progress, browser/pilot readiness and global debt stay open, and F3 is unauthorized.

## Absent fixture review: Factory layout is not absent - 2026-10-30

The owner authorized source/fixture diagnosis without changing assertions/timeouts or repeating the smoke. The absent GET at smoke line 1548 uses `issueProjectId`, whose Factory setup at lines 909-927 now writes AGENTS with a session-primer role, policy, ROUTING and structured budget but no artifact registry. The inspector therefore has installed=true, recognized=false and ROUTING present, selecting unknown at inspect lines 75-77 and adding unsupported-format. This is not an absent layout or a reader regression, and valid Factory context does not require recognition as complete H1-H4. The API returns the observation unchanged; no live inspection or original deleted findings were recovered.

The workflow project is still free of AGENTS/.agents at this boundary: only Git, selected docs and verifier/baseline are seeded there. Curated Harness destinations and Factory files exclude it, and its workflow campaign starts after the query (line 1598). The Harness read does not mutate its files, save an observation, admit a task or consume a turn, so it can serve as the explicit absence fixture without adding a repository or changing the 31-turn contract.

The proposed next five-file correction is one project-argument change in the smoke query (`issueProjectId` to `workflowProjectId`) with an explanatory fixture-role comment, two appended regression cases in the existing helper-test file, and these three evidence records. Existing absent/healthy/partial assertions, Factory source files, reader semantics, permissions, pins and timeouts remain unchanged. Regressions distinguish minimal Factory unknown/unsupported from docs/verifier-only absent, preserving bytes and absent registry files without repair.

Proposed checks, NOT RUN: `pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness absence" --bail=1`, then `pnpm typecheck` only after PASS, retaining the 900-second foreground/owned-TEMP boundary. No smoke retry is included automatically. Only the three evidence records changed now; no source fix, inspector/test/check/probe, API/Vite/browser, assertion/guard/timeout change, install, eval/full-suite/CI/audit, paid call, pilot/sibling action, cleanup, commit, push or merge ran. The correction remains a proposal; T008 stays unchecked/F2 in progress, with browser/pilot readiness and global debt open and F3 unauthorized.

## Absent-query correction and two regressions PASS - 2026-10-30

The owner explicitly approved the five-file correction and two regressions, then typecheck only on focal PASS, preserving assertions/timeouts and prohibiting smoke/evals/CI/commit/push. The absent GET now reads the existing `workflowProjectId` before its role campaign instead of `issueProjectId`, with an explanatory fixture-role comment. The absent expectation and all 363 existing smoke assertion lines are byte-identical; the inverse edit restores the entire earlier source. No repository, execution permission, reader/pin, fake turn, guard or timer changed, and the Factory context scaffold remains untouched.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness absence" --bail=1
pnpm typecheck
```

| Ordered check | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| Two absence regressions | 0 / 0 | 2 PASS; 109 filtered skips | 3943 |
| Conditional typecheck | 0 / 0 | PASS, tsc --noEmit | 26641 |

Both commands ran once in the foreground outside the sandbox, sequentially with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000 ms per command. Each receipt has a closed native session, both EOFs, empty stderr and no termination. Vitest reports 111 registered cases, two active executions, 109 deliberately filtered cases, duration 2.43 seconds/tests 253 ms. Typecheck followed only after exact focused coverage passed.

The two synthetic cases distinguish valid minimal Factory instructions from absent H1-H4: Factory without artifact registry remains unknown, comparison unknown, version null and unsupported-format, with bytes and missing registry preserved; docs/verifier without AGENTS/.agents remains absent with unchanged bytes/no backfill. They invoke no verifier/runtime/browser/API. All previous tests remain byte-exact in the original 68580-byte prefix.

Current source SHA is `52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a` (prior `9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59`); test SHA is `9f9f59285714e9cba6ddc9f339915b6672c567ed80308cade54be554da879d7c`, with prefix SHA `1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10`. Preflight preserved 106 outside identities; final review matched all 111 current identities, protected 314347-byte history, HEAD/branch and empty index before evidence updates. Test teardown asserts its owned roots removed; wrapper TEMP parents remain retained without independent cleanup.

Execution stopped after typecheck PASS. Only the two approved source/test files and three evidence records changed. No actual API/Vite/browser, real smoke, eval/full suite, extra focal/build/Harness/CI/audit, install, paid runtime, pilot/sibling operation, independent cleanup, checkout commit, push or merge ran. The corrected real absent response and full 31-turn smoke are still unverified; the last actual smoke remains FAIL pending separate single-run authority. T008 remains unchecked/F2 in progress, browser/pilot readiness and global debt remain open, and F3 is unauthorized.

## Single smoke after absence correction - workflow UI FAIL, 2026-10-30

The owner authorized exactly one smoke with the validated absence correction, 900 seconds, unchanged assertions/timeouts and stop-on-failure/unknown, without evals/CI/commit/push. Preflight matched 108 protected/source identities, source SHA `52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a`, helper-test SHA `9f9f59285714e9cba6ddc9f339915b6672c567ed80308cade54be554da879d7c`, HEAD/branch and empty index; the three evidence documents were fingerprinted separately. No source or guard changed.

One `pnpm smoke:local:playwright` invocation ran in the foreground outside the sandbox using Chromium, qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000-ms boundary. It returned **FAIL**, native tool/child exit 1, `wall_ms: 254343`, both EOFs, closed session and no termination request. The outer command deadline was not reached.

Phase M completed before the workflow campaign. The last stage label is `T013 implementation: risk-acknowledgement human gate`, but the actual terminal error is `locator.waitFor: Timeout 30000ms exceeded`, waiting for the Synthetic workflow implementation issue card's `.work-issue-status` to display ready-for-review. Stack locations: open 592, refresh 648, approve 667, workflowCampaign 740, main 1599. No Phase N read diagnostic or final PASS/31-turn confirmation appeared.

Bounded synthetic workflow facts captured at failure:

| Template | Status / current stage | Tasks / attempts | Runtime ms | Reported tokens | Accounting complete | Blocked reason |
| --- | --- | --- | --- | --- | --- | --- |
| analysis | completed / null | 1 / 1 | 2927 | 3 | true | null |
| operations-investigation | completed / null | 1 / 1 | 2656 | 3 | true | null |
| implementation | waiting-human / qa | 4 / 4 | 41208 | 12 | true | null |

These counters are fake-executor evidence, not paid-model billing or proof of every role result. The capture lacks actual issue status, current candidate/decision details and the DOM. It cannot establish a backend defect, UI staleness, successful QA/final acceptance or why that locator was absent. The stale stage label alone is not evidence that the risk acknowledgement failed. No post-failure source/API/browser inspection ran.

The smoke reported zero owned-navigation read cancellations and cleanup for `surtec-local-dashboard-1DN9zM`: browser/Vite/API closure and workspace removal all true, `failures: []`, followed by removal confirmation. These are its own awaited lifecycle facts, not an independent audit; wrapper TEMP parents remain retained and historical cleanup uncertainty is unchanged.

Execution stopped at this failed locator. Only this task evidence, acceptance runbook and roadmap changed afterward. No additional inspection/diagnosis, repair, retry, focal/type/build/Harness/eval/full-suite/CI/audit, install, paid runtime, pilot/sibling operation, independent cleanup, checkout commit, push or merge ran. Proposed next bounded work is reviewing the expected issue/candidate state across QA/human gates and the refresh/open sequence while preserving all assertions/deadlines; it is not started. T008 remains unchecked/F2 in progress, browser/pilot readiness and global debt remain open, and F3 is unauthorized.

## Ready-for-review selector diagnosis after QA - 2026-10-30

The owner authorized reviewing QA/issue state and the UI wait only, without assertion/timeout changes or another smoke. The source/log comparison identifies the mismatch: open() at smoke line 592 filters `.work-issue-status` by canonical `fresh.status` text, whereas IssuesView lines 143-145/487 render ready-for-review as `Listo para revisión`. Its canonical code lives in a BEM class and sibling badge. All six primary translations are deliberate and covered by the existing UI test at line 283.

The failed exact regular expression `^ready-for-review$` is constructed from the selected refreshed API issue, so the value used by the wait was ready-for-review. That is an indirect observation recovered from the existing error/code, not a newly fetched issue or retained DOM. An updated card with that canonical state cannot match the translated span's text. No additional UI/backend race is established or needed for this explanation.

Backend review confirms issue ready-for-review is required before a workflow's human risk/candidate gate: orchestrator lines 312-323 call markWorkflowReady when needed and require the ready state; issue-service/review-evidence retain current candidate/verification/reviewer/QA bindings. Workflow waiting-human is independent of final issue done. Parent/UI refresh paths exist and preserve generation/revision checks. No reader/transition/consent defect is demonstrated; Spanish UI labels must not be reverted to satisfy an obsolete test selector.

The proposed four-file correction is one wait-selector change to the exact canonical status class within the same issue card, plus this task evidence, acceptance runbook and roadmap. Existing state expectation, issue/project/revision binding, all assertions, 30-second locator wait, timers and human gates stay intact. No new mirrored test or package change is proposed. Reuse nine UI lifecycle-label cases and fourteen Issues-refresh helpers with:

```text
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx scripts/harness-validators.test.ts --testNamePattern="projects .* without changing its authoritative lifecycle|isolated browser smoke Issues refresh" --bail=1
```

This selects 23 active cases without browser opt-in; only if PASS, typecheck. Neither command nor a smoke ran in this diagnostic turn. Only three evidence records changed; no implementation, test/check, browser/API/Vite/probe, assertion/guard/timeout change, install, eval/full-suite/CI/audit, paid call, pilot/sibling work, cleanup, checkout commit, push or merge occurred. The selector correction is not yet approved/applied. T008 remains unchecked/F2 in progress, last real smoke FAIL, pilot readiness and global debt open, and F3 unauthorized.

## Canonical issue-status selector validated - 2026-10-30

The owner approved the preceding four-file correction and its existing focused tests, followed by typecheck only after PASS. The smoke's open() wait now selects the exact `.work-issue-status--${fresh.status}` class within the same issue card rather than comparing canonical state with translated visible text. The expected API status and issue/project/revision bindings are unchanged. All 363 existing assertion lines are byte-identical; the inverse one-line edit restores every other source byte. No UI or test file changed, and the existing waitFor() arguments and 30000-ms locator timeout remain unchanged.

```text
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx scripts/harness-validators.test.ts --testNamePattern="projects .* without changing its authoritative lifecycle|isolated browser smoke Issues refresh" --bail=1
pnpm typecheck
```

| Ordered check | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| Existing lifecycle labels and Issues-refresh helpers | 0 / 0 | 23 PASS across two files; 176 not executed by selection/opt-in | 7723 |
| Conditional typecheck | 0 / 0 | PASS, tsc --noEmit | 30567 |

The focused selection executed nine UI lifecycle-label cases and fourteen refresh/binding helpers out of 199 registered cases. The other 176 were not executed; browser opt-in remained disabled. Vitest reports 6.19 seconds total and 454 ms of tests. Both commands ran once, sequentially in the foreground outside the sandbox, with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI and 900000 ms per command. Each receipt has native exit 0, a closed session, both EOFs, empty stderr and no termination request. These checks do not execute the private Playwright wait or establish real-browser acceptance.

A preparation-only inverse-edit check initially rejected JavaScript replacement-string interpretation of the old regex's dollar/backtick sequence before writing any file or running tests. Literal replacement callbacks corrected that verifier packaging; the preservation check then passed without relaxing it. Source SHA changed from `52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a` to `9bf66c7f17ede3e0698266db6063a6f9a1e9638b2c1a4e0785a57912e3265486`. Read-only post-check review matched 111 identities, including all 107 out-of-scope identities, HEAD/branch and the empty index before the three evidence records were updated. Independent source review found no blocker; no runtime transition, consent, assertion, guard or timeout changed.

Execution ended after typecheck and evidence recording. Only the smoke selector and the three approved evidence documents changed. No actual API/Vite/browser, smoke, eval/full-suite/CI/audit, extra product check, install, paid runtime, pilot/sibling operation, independent cleanup, checkout commit, push or merge ran. Owned wrapper TEMP parents remain retained. The latest actual smoke remains FAIL at its historical status wait; exactly 31 fake turns and full owned smoke closure still require a separately authorized run. T008 remains unchecked/F2 in progress, the human pilot checkpoint and global debt remain open, and F3 is unauthorized.

## Single smoke after canonical selector correction - repeat-correction read wait FAIL, 2026-10-30

The owner explicitly authorized one smoke with the validated canonical status-class selector, 900 seconds and stop-on-failure/unknown, without assertion/timeout changes, evals, CI or Git publication. Read-only preflight matched 111 expected identities, the approved smoke SHA `9bf66c7f17ede3e0698266db6063a6f9a1e9638b2c1a4e0785a57912e3265486`, HEAD/branch and the empty index. No source, guard, environment allowlist or timeout changed.

Exactly one `pnpm smoke:local:playwright` ran in the foreground outside the sandbox with managed Chromium, the real isolated loopback API/Vite, fake execution and fresh qualified owned external TEMP/TMP. It returned **FAIL** with native tool/child exit 1, closed session, both EOFs and `wall_ms: 851442` (14 minutes 11.442 seconds), below the unchanged 900000-ms command limit. No termination was requested. This is an internal read-synchronization failure, not an outer command timeout.

The prior ready-for-review selector failure did not recur: the capture reaches implementation candidate acceptance, and the corresponding implementation workflow is completed. It subsequently reaches the correction and repeat-correction scenarios. The terminal stage label is `T013 repeat-correction: one consumed allowance and exact second-correction refusal`; its error is `Browser API reads did not settle within the effect capture deadline`.

The existing bounded read diagnostic reports schema 1, label unlabelled, phase drain, generation_at_capture null, captures_started 0, recaptures 0, pending_count 2, omitted_pending 0 and generation_now 2055. The two pending browser reads at expiry are GET `/api/runs` and GET `/api/today`. This identifies outstanding requests at the drain deadline, not why they remained pending or an exact call-site/numeric inner limit. It does not establish a broken correction-budget guard or completion of the second-correction refusal assertion.

Captured synthetic workflow facts:

| Template / scenario | Status / current stage | Tasks / attempts | Runtime ms | Reported tokens | Accounting complete | Blocked reason |
| --- | --- | --- | --- | --- | --- | --- |
| analysis | completed / null | 1 / 1 | 2801 | 3 | true | null |
| operations-investigation | completed / null | 1 / 1 | 3712 | 3 | true | null |
| implementation | completed / null | 4 / 4 | 40568 | 12 | true | null |
| trivial-change | cancelled / null | 3 / 3 | 32660 | 9 | true | Human stop requested |
| quality-review | completed / null | 2 / 2 | 18289 | 6 | true | null |
| implementation / correction | completed / null | 7 / 7 | 73094 | 21 | true | null |
| implementation / repeat-correction | needs-decision / qa | 7 / 7 | 80101 | 21 | true | Single correction allowance or workflow budget exhausted; human decision required |

These counters describe fake execution, not paid billing or proof of all remaining scenarios. No final PASS or exactly-31-turn confirmation appears. Synthetic-file LF/CRLF warnings are present but no causal connection to the failure is established.

The smoke reports zero owned-navigation read cancellations. Its awaited cleanup receipt for `surtec-local-dashboard-Enb5NZ` has browser_closed, vite_closed, api_stopped and workspace_removed all true with failures empty, followed by `Temporary synthetic API state and repositories cleaned up.` This is the smoke's own cleanup evidence, not an independent audit. Wrapper temporary parents remain retained; historical cleanup unknowns are unchanged.

Execution stopped at this failure. Only this task evidence, the acceptance runbook and roadmap were updated from the captured result. No post-failure source/API/browser/process inspection, repair, retry, focal/type/build/Harness/eval/full-suite/CI/audit, installation, paid call, private pilot/sibling operation, independent cleanup, checkout commit, push or merge followed. The bounded next proposal is reviewing the repeat-correction read synchronization without changing assertions or deadlines; it is not started. Browser acceptance, T008/F2, the human pilot checkpoint and global debt remain open; F3 is unauthorized.

## Bounded read-activity preparation validated - 2026-10-30

The owner approved the bounded read-activity adjustment after the read-only diagnosis. That diagnosis located repeat-correction refresh -> open -> drainReads(30000), before the explicit Issues refresh. The needs-decision/one-correction/reason assertions precede that wait; later visual and lineage checks remain unverified. Global Runs/Today polling can overlap, and synchronous shared API/worker work can delay reads, but the existing receipt does not identify which mechanism occurred.

Only the smoke helper, its existing test file and these three evidence records changed. The original SMOKE_READ_DIAGNOSTIC message/payload, every existing assertion and all timers/idle/navigation/capture rules remain intact. The tracker now freezes a separate activity receipt at the same deadline: configured limit, observed elapsed time, initial/final pending counts, per-window start/finish/failure deltas and at most eight normalized GET rows with local numeric sequence, age and whether each started inside the window. Weak metadata retains no completed-request history; receipts bind exact Error objects and support concurrent windows. Unknown/throwing/backwards clocks leave times null without changing authority or scheduling. No private URL components, bodies or headers are inspected or emitted.

The catch emits SMOKE_READ_ACTIVITY only for the matching deadline error, before workflow facts and owned cleanup. Existing legacy diagnostics are unchanged; no receipt from an earlier deadline attaches to a different failure. This prepares observation, not a polling/backend repair or proof of the old timeout's cause.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|read diagnostics|read activity)" --bail=1
pnpm typecheck
```

| Ordered check | Result | Native tool/child exit | Host wall ms |
| --- | --- | --- | --- |
| Existing synchronization/diagnostics plus new activity cases | 28 PASS: 20 existing + 8 new; 91 other cases not executed, 119 registered | 0 / 0 | 7391 |
| Conditional typecheck | PASS, tsc --noEmit | 0 / 0 | 31068 |

Both ran once in the foreground outside the sandbox with fresh qualified owned external TEMP/TMP, unchanged purpose-specific environment and 900000 ms per command. Sessions closed with both EOFs, empty stderr and no termination. Vitest reports 4.51 seconds total/tests 113 ms. New cases cover old reads versus finite replacements, unchanged 10/30-second limits, capped private-safe rows, deep freeze and exact error association, later transport failure, faulty/intermediately backwards clocks and concurrent snapshot/drain windows. No browser opt-in or real API/browser ran.

Post-check read-only review matched all 111 expected identities, including 106 outside scope, HEAD/branch and empty index before evidence recording. All 363 smoke assertion lines are byte-identical; reversing the nine source edits restores SHA `9bf66c7f17ede3e0698266db6063a6f9a1e9638b2c1a4e0785a57912e3265486`. Current source SHA is `915860c579a3a9d20b7deb7519f9e130f794fa51d011ac7fe98c339b7d3a44e7`. The test's original 71695-byte prefix retains SHA `9f9f59285714e9cba6ddc9f339915b6672c567ed80308cade54be554da879d7c`; its append-only result is `10a8756463b52d74795bc0f3f92f0adce95a1a56f02943fa581f5709362bdc2e`. Independent source review found no remaining blocker.

Execution ends after these checks and records. Wrapper TEMP parents remain retained; no independent cleanup is claimed. No smoke, real API/Vite/browser, eval/full-suite/CI/audit, install, paid runtime, pilot/sibling operation, process probe/cleanup, checkout commit, push or merge ran. The latest actual smoke remains FAIL at 851442 ms, with its own cleanup reported complete; the new activity receipt has not been observed in a real run. T008/F2, the pilot checkpoint and global debt remain open; F3 is unauthorized. A separate single-smoke authorization is required for prospective browser evidence.

## Single smoke with read activity - overlapping polling observed, FAIL, 2026-10-30

The owner authorized exactly one smoke to observe the validated activity capture, retaining 900 seconds and the stop-on-failure/unknown boundary. Read-only preflight matched 111 expected identities, the prepared source/test hashes, HEAD/branch and empty index. No code, assertion, guard, environment allowlist or timeout changed.

One `pnpm smoke:local:playwright` ran in the foreground outside the sandbox with managed Chromium, isolated real API/Vite, fake execution and fresh qualified owned external TEMP/TMP. It returned **FAIL**, native tool/child exit 1, closed session, both EOFs, wall_ms 899500 and no termination. The 900000-ms command limit was not reached. The terminal stage remains `T013 repeat-correction: one consumed allowance and exact second-correction refusal`; the failure is the existing browser-read drain deadline.

The separate frozen SMOKE_READ_ACTIVITY was observed in this real run:

| Window field | Value |
| --- | --- |
| Label / phase | unlabelled / drain |
| Configured / observed window ms | 30000 / 30007 |
| Pending at entry / expiry | 171 / 4 |
| Started / finished / failed inside window | 39 / 206 / 0 |
| Omitted pending rows | 0 |

| Pending GET path | Local sequence | Age ms | Started inside window |
| --- | --- | --- | --- |
| /api/runs | 2084 | 7536 | true |
| /api/runs | 2085 | 5545 | true |
| /api/runs | 2088 | 3532 | true |
| /api/runs | 2091 | 1538 | true |

The balance 171 + 39 - 206 - 0 = 4 is consistent. All four remaining reads are new, so the initial 171 pending reads cleared during the window. The ending sample demonstrates concurrent unfinished requests to the same endpoint, started about two seconds apart, consistent with the known global Runs poll. The drain did not observe its required idle point while new reads arrived. The receipt does not identify the initial requests' routes, HTTP success statuses, handler timings or whether individual delay occurred in the browser, proxy or shared API/worker. It does not establish that preventing overlap alone will make acceptance pass.

The unchanged legacy diagnostic agrees: phase drain, captures_started 0, recaptures 0, generation_at_capture null, generation_now 2091 and four pending /api/runs rows with no omissions. The error originates at deadlineError/timer, not a filesystem capture. No final PASS or exactly-31-turn confirmation appears. The synthetic facts retain completed analysis/operations/implementation/quality-review/correction workflows, cancelled trivial-change and repeat-correction needs-decision/qa with seven tasks/attempts, complete accounting and the exhausted single-correction/budget reason. This is fake execution evidence, not paid billing.

The smoke reports zero owned-navigation read cancellations. Its awaited SMOKE_CLEANUP for `surtec-local-dashboard-taPNPq` reports browser_closed, vite_closed, api_stopped and workspace_removed all true with failures empty, followed by removal confirmation. This is its own cleanup result, not an independent process audit. Wrapper TEMP parents remain retained and historical cleanup uncertainty is unchanged.

Execution stopped at FAIL. Only the three evidence records were updated from the captured output; no post-failure source/API/browser/process inspection, repair/retry, tests/typecheck/build/Harness/evals/full suite/CI/audit, install, paid call, pilot/sibling operation, independent cleanup, checkout commit, push or merge followed. The next proposal is a bounded polling correction to prevent overlapping requests, with lifecycle regressions and unchanged deadlines/acceptance assertions; it is not implemented or authorized by this run. Browser acceptance, T008/F2, the human pilot checkpoint and global debt remain open; F3 is unauthorized.

## Polling overlap correction validated - 2026-10-30

The owner approved preventing a poller from issuing another read while its previous read is pending, with regression coverage and unchanged existing assertions. A small shared usePolling hook now owns one pending Promise per hook instance, spanning fetch and JSON completion. Overview, Today and Runs use their existing stable readers and unchanged 3000/3000/2000-ms intervals. Ticks skip occupied slots; success or failure releases only the matching Promise. Last good data remains visible on error.

Effect replay and interval changes retain the pending read; mounting and reader identity protect publication. Real unmount stops interval work and ignores late results without aborting a request. Explicit Today.refresh waits for any previous reads to settle, rechecks ownership and starts its own fresh GET after the action; it does not return a pre-action payload. Concurrent manual refresh callers serialize their own fresh reads. An unmounted waiting caller rejects without starting a deferred GET. These are local UI read semantics, not agent dispatch or a new execution scheduler.

Implementation scope: dashboard/src/ui/api.ts, dashboard/src/ui/useRuns.ts, new dashboard/src/ui/usePolling.ts and new dashboard/src/ui/polling.test.tsx, plus the three evidence documents. The rest of api.ts is byte-preserved by inverse verification. Existing tests, smoke source/diagnostics, all assertions, timeouts, HTTP paths, payloads, state/runtime policies and permissions remain unchanged.

```text
pnpm exec vitest run dashboard/src/ui/polling.test.tsx dashboard/src/ui/App.test.tsx --bail=1
pnpm typecheck
```

| Ordered check | Result | Native tool/child exit | Host wall ms |
| --- | --- | --- | --- |
| Polling regressions and complete existing App tests | 80 PASS: 22 new + 58 existing; two browser opt-in skips, 82 registered | 0 / 0 | 9122 |
| Conditional typecheck | PASS, tsc --noEmit | 0 / 0 | 16464 |

Both commands ran once in the foreground outside the sandbox with fresh qualified owned external TEMP/TMP, original purpose-specific environment and unchanged 900000-ms ceiling. Sessions closed with both EOFs, empty stderr and no termination. Vitest reports two passing files, 8.01 seconds total/tests 4.38 seconds. The two App browser tests require their explicit operating/workflow flags, absent from the sanitized environment; they did not execute and are not browser acceptance.

The 22 additions exercise the public hooks with deferred fake headers and JSON: per-hook default cadence, no overlap while pending, errors/recovery and last good data, interval rerender, unmount without cancellation, StrictMode's first visible response and independent instances; Today cases additionally test fresh results after previous success/failure, serial manual callers, own rejection/recovery and unmount while waiting. The existing 60-case App file remains byte-identical. Independent source review found no blocker.

Post-check review matched 114 expected identities, including all 107 outside scope, HEAD/branch and empty index before evidence recording. Source hashes: api.ts a67f288ea77ee0c565d1b84d02941ccd5df381f22fb0f2261a96d7c6e5e2cc83; useRuns.ts 87ec712cde032c3384a5f8f6469ed4be3a49c901a8d97ac14f624e6db8c52099; usePolling.ts 7d400548c8fc1238069b779f21146e3ac0401c2602bf6188883ea979896b687b; polling.test.tsx 8631c15217e180feb7155343aeff306c73f91f7d4d19eb47d79c9df85e0e97bf. The smoke remains SHA915860c579a3a9d20b7deb7519f9e130f794fa51d011ac7fe98c339b7d3a44e7 with all 363 assertions intact; its helper tests remain unchanged.

Only the seven scoped files changed. Execution stops after targeted tests/typecheck and records. No real API/Vite/browser or smoke, eval/full-suite/CI/audit, build/Harness rerun, install, paid call, pilot/sibling operation, process probe/cleanup, checkout commit, push or merge ran. Wrapper TEMP parents remain retained. This validates polling ownership in regression tests, not a passing full smoke or a measured backend latency fix. The latest actual smoke remains FAIL at 899500 ms with its own cleanup reported complete. A separately authorized single smoke is the next proposed check; T008/F2, human pilot readiness and global debt remain open, and F3 remains unauthorized.

## Single smoke after polling correction - automated functional PASS, 2026-10-30

The owner authorized exactly one smoke with the validated polling repair, 900 seconds and stop-on-failure/unknown, without assertion/timeout changes, evals, CI or Git publication. Read-only preflight matched 114 expected identities, current polling source/test hashes, unchanged smoke SHA915860c579a3a9d20b7deb7519f9e130f794fa51d011ac7fe98c339b7d3a44e7, HEAD/branch and empty index. No source or guard changed.

Exactly one `pnpm smoke:local:playwright` ran in the foreground outside the sandbox with managed Chromium, isolated real API/Vite, fake execution, fresh qualified owned external TEMP/TMP, the original purpose-specific environment and the unchanged 900000-ms ceiling.

| Required terminal evidence | Observed result |
| --- | --- |
| Native tool / child exit | 0 / 0 |
| Foreground host status / session | passed / closed |
| Host wall ms | 670440, below 900000 |
| stdout / stderr EOF | true / true |
| Supervisor termination | false |
| Final PASS markers | exactly one |
| Synthetic turns | exactly 31: four v1 and 27 workflow |
| Owned-navigation read cancellations | 0 |
| Deadline/activity failure diagnostics | none emitted |

The stdout stage sequence passes repeat-correction, invoked read-only role cancellation and the pending-plan restart scenario, then reports all five templates and durable gates completed. Its final PASS confirms exact Planner/risk/criterion decisions, candidate-only Reviewer/QA, verified receipts, one bounded correction and second-correction refusal, stale/budget/tree guards, task ownership/mobile evidence, active-role stop and restart/no replay/session rotation, retaining prior K-N and F2 assertions. There were no paid runtime or provider-write turns.

After that PASS, the awaited SMOKE_CLEANUP for `surtec-local-dashboard-ECRkLR` reports browser_closed, vite_closed, api_stopped and workspace_removed all true, failures empty, followed by `Temporary synthetic API state and repositories cleaned up.` Required order PASS -> cleanup -> removal confirmation is verified. This is the smoke's own resource-closure evidence, not an independent process audit. Wrapper TEMP parents remain retained; historical cleanup unknowns stay recorded.

Stderr contains eleven nonfatal LF-to-CRLF warnings from synthetic Git fixture files. It contains neither SMOKE_READ_ACTIVITY nor the legacy deadline diagnostic. Their absence means no such deadline error was emitted in this run; it does not measure per-route latency, prove the previous latency's unique cause or promise future performance.

Independent terminal review confirms browser/API automated acceptance PASS. Read-only post-run review matched all 114 expected identities, HEAD/branch and empty index before updating only these three evidence records. No second smoke, extra tests/typecheck/build/Harness/evals/full suite/CI/audit, installation, paid call, pilot/sibling inspection, process probe/independent cleanup, checkout commit, push or merge followed. No assertion or timeout changed.

Under the approved revised F2 procedure, functional automated verification is complete, with the human pilot checkpoint pending. T008 remains unchecked and F2 in progress until the already-selected private pilot's exact baseline, result/criteria, permitted/excluded scope, contained sources, trusted commands and approver are prepared and confirmed under separate authority. DEBT-F2-GLOBAL-900 remains open/nonblocking only for this revised functional exit. This is not CI/Q/original-gate acceptance, P activation, paid execution, publication or F3 permission.

## F2 functional closure and human checkpoint - 2026-10-30

The repository owner explicitly confirmed the prepared replacement pilot checkpoint in this conversation. This acknowledgement was recorded at 2026-10-30T23:02:57Z; it is not an inferred earlier approval timestamp. The confirmation covers its exact clean Git baseline, requested acceptance-harness outcome, measurable criteria, versioned allowlist/exclusions, contained context, trusted verification entry points and the owner as approver. Detailed private project paths/source/business data remain only in the conversation and owned external checkpoint, outside this public repository.

All revised mandatory Surtec F2 conditions are now satisfied: the six-check gate; 376 + 72 + 209 + 28 active functional cases with the previously explained skip/filter inventory; Harness; the real API/Chromium smoke with exactly 31 fake turns, native exit 0/both EOFs, 670440 ms and complete reported owned cleanup; and explicit human pilot confirmation. T001-T008 are complete under the precise disposition **F2 functional acceptance complete for the local PoC, global debt open**.

Additional preparation of the selected pilot passed 82 frontend unit cases, TypeScript and a qualified production build using owned temporary copies. Its single existing mocked-API browser selection reached the unchanged 900-second supervisor deadline without a report or attributable test counts: browser acceptance is **UNKNOWN**, not PASS or a demonstrated product failure. Both streams closed; the owned process tree was terminated by its supervisor, no owned survivor remained and the loopback port was free. Wall time including closure was 914364 ms; the command limit remained 900000 ms. No rerun followed. Two dependency-restore setup failures preceded product backend tests; a later offline MSBuild initialization probe passed, but backend build/tests and real pilot API/database acceptance remain **NOT RUN**. No database was created or existing data reused. These pilot-product results are disclosed preparation limitations, not substitutes for Surtec's independently passing mandatory smoke or extra retrospective F2 exit requirements.

Only the three existing F2 evidence documents are changed for closure. Private source repositories remain unchanged; generated evidence/builds stay in owned external temporaries. Historical status/failure records below retain their contemporaneous meaning. DEBT-F2-GLOBAL-900 stays open; no whole-suite, Q/CI/original-gate PASS, P activation, F3 implementation, model dispatch, commit, push or merge is implied. Next: prepare a separately reviewed F3 design/plan with exact permissions, prerequisite handling, budget and one-writer/runtime consent before implementation.
