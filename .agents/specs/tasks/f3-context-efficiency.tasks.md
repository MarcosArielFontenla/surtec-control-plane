---
spec: .agents/specs/governed-context-efficiency.spec.yaml
feature: f3-context-efficiency
status: done
createdAt: "2026-11-04"
reviewedBy: repository-owner
approvedAt: "2026-11-04T00:23:56Z"
---

# F3 governed context efficiency — completed technical tasks

The owner explicitly approved the [exact 23-path design](../../../docs/proposals/factory-local-f3-context-efficiency-design.md), specification, T001–T005 and mandatory C01-C06 in the conversation. Review acknowledgement is 2026-11-04T00:23:56Z, not an inferred earlier human timestamp. The owner subsequently authorized necessary scoped adjustments and revalidation through T001-T005. Retain historical failed receipts and do not advance dependent checks past an unresolved failure or unknown result; preserve the exact 23-path scope and all limits/model/side-effect boundaries. Recorded usage and the real exhausted workflow remain unchanged.

## Phase 1 — fixed profile and compatible execution contracts

<!-- maps to: ac-types,ac-schemas,ac-secrets -->
- [x] T001 Define the pure closed profile, bounded read guidance and exact legacy/new fingerprint selection with mandatory-source and unknown-profile tests -> runner/runtime-context-profile.ts, runner/runtime-context-profile.test.ts, runner/agent-executor.ts, runner/agent-prompt.ts, runner/agent-prompt.test.ts.

No filesystem/process/network work in the profile module. Keep current legacy hash serialization and prompt defaults byte-equivalent; bind the new fixed settings/guidance in the new candidate without replacing old version constants. Existing contract hashes select only their exact matching supported profile; malformed/unknown metadata or a bare saved thread refuses. Preserve all admitted/routed source bodies and count all guidance under existing limits. Run C01 only after actual implementation approval.

## Phase 2 — minimal fixed native configuration and pre-turn guard

<!-- maps to: ac-types,ac-secrets -->
- [x] T002 (depends: T001) Carry the trusted profile into fixed spawning and stable pre-thread config verification using protocol fakes for the exact T002 runtime targets listed in the product design -> docs/proposals/factory-local-f3-context-efficiency-design.md

New profile uses only the documented fixed skills.include_instructions=false override, plus the unchanged stdio/approval/sandbox/environment controls. Check own explicit false from config/read with the execution cwd before any thread/turn request. Missing/true/malformed/refused/unsupported values fail closed with generic errors and no raw effective-config logging. Preserve legacy argument/RPC sequences and existing terminal evidence/EOF tests. C02 uses fake processes and owned native Node producers, without invoking the installed product runtime or a provider.

## Phase 3 — trusted stage/runner propagation and budget preservation

<!-- maps to: ac-types,ac-schemas,ac-secrets -->
- [x] T003 (depends: T002) Propagate the bound profile through current stage preparation and runner ownership paths with cumulative-usage regressions -> runner/workflow-stage.ts, runner/workflow-stage.test.ts, runner/run-task.ts, runner/run-task.test.ts.

No stored facet/schema/admission change or caller-selected profile. Use existing opaque execution fingerprints and exact private preparation data; do not backfill old records. New context-economy cases cover positive profile selection, exact legacy behavior, unknown denial, cancellation/lost lease and unchanged budget interruption using synthetic cumulative samples/duplicates, retaining unknown final usage and no candidate effects. Run C03a then C03b; the filtered selection must execute cases and report excluded cases honestly.

## Phase 4 — retained claim proofs and actual isolated workflow compatibility

<!-- maps to: ac-types,ac-schemas,ac-build,ac-secrets -->
- [x] T004 (depends: T003) Preserve prior producer pairs, append one reviewed final source/fixture pair and assert new-profile propagation in the existing fake producer -> lib/workflows/uncharged-claim-recovery.ts, lib/workflows/uncharged-claim-recovery.test.ts, scripts/fixtures/local-issue-api.ts.

The two prior coherent source/operator pairs remain verbatim. New static pins follow final reviewed public source and the owned fixture; no automatic adoption, mixed-pair acceptance or registry/Harness changes. Keep charge-before-run proof and all recovery/charged/unknown/refusal assertions unchanged. Synthetic fixtures contain no private archive/state or auth. Run C04a then C04b; C06 remains mandatory after the catalog gate, without changing UI, browser selectors, assertions or deadlines.

## Phase 5 — bounded acceptance and honest F3 handoff

<!-- maps to: ac-schemas,ac-types,ac-build,ac-secrets -->
- [x] T005 (depends: T004) Complete technical acceptance, document the profile and native/unmeasured boundary, and retain the real token stop as the current F3 state -> docs/architecture/execution-runtime.md, docs/security/threat-model.md, docs/proposals/factory-local-f3-design.md, docs/roadmap/factory-local-poc.md, docs/proposals/factory-local-f3-context-efficiency-design.md, .agents/specs/governed-context-efficiency.spec.yaml, .agents/specs/tasks/f3-context-efficiency.tasks.md.

Complete C01-C04 as affected, the four-command C05 catalog gate and existing C06 focused actual API/Chromium with exactly four fake roles, candidate-bound verification/reviews, actual restart/no replay and owned cleanup. Use external owned TEMP/TMP, foreground native capture, both EOFs and 900 seconds per command; stop at failure/unknown without widening limits. No full suite, CI, eval, audit, installed product runtime probe, model call, sibling operation, cleanup, commit, push or merge.

Record bytes/config assertions separately from unmeasured real token savings and native setting support. Preserve all original usage, failures, unknown accounting, Planner approval and retained worktree; do not mark F3/F5 complete. Future real execution needs a separate honest feasibility/accounting proposal and actual owner authority, with no reset hidden behind a new identity.

## Done gate after actual approval

    pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/governed-context-efficiency.spec.yaml -TimeoutSeconds 900

This executes schemas, typecheck, build and secrets only. Every separately named C01-C04/C06 behavioral group in the design is mandatory. Missing, filtered, skipped, unknown, native-unmeasured and not-run results cannot be reported as passes. Structure does not prove human approval or actual F3 delivery.

## Historical design-only boundary

At the original design boundary only this plan, proposed specification and design were authored; structural checks executed no acceptance commands and approval metadata was null. Later explicit approval above permits only the stated synthetic technical implementation/acceptance, preserving the historical design observations and real token stop.

## Historical stopped checkpoint

T001 remains partial and unchecked. First C01: 47 PASS, one FAIL, native exit 1/2366 ms with complete capture. The new agent-prompt non-workflow fixture uses a hash derived from a different key order than the actual preserved legacy contract. No remediation or repeat followed the first failure. T002–T005 and C02–C06 are NOT RUN; all original limits and real evidence remain retained. Follow the design's checkpoint before resuming.

## Historical resumption and stopped checkpoint

Owner-approved two-literal fixture correction completed; C01 PASS 48/48, native exit 0/1893 ms. T002 and C02 PASS 243/243, native exit 0/2608 ms. T001 and T002 are checked complete.

T003 remains partial and unchecked. First C03a: 7 PASS, one FAIL, 103 unrelated cases excluded; native exit 1/7696 ms with complete capture. Its new usage fixture passes the preview-only `kind` field into closed `createTask` input and fails before its executor. Read-only inspection identifies passing explicit task fields without `kind` as the minimal pending correction; no remediation or repeat followed this failure. C03b, T004-T005, C04-C06, typecheck and build remain NOT RUN. Existing assertions, guards, limits, real evidence and usage remain intact. No model call, sibling write, commit, push or merge.

## Historical stopped checkpoint — synthetic cap mismatch

Owner-authorized removal of preview-only `kind` from the new fixture task call completed, with all assertions retained. Repeated C03a: 7 PASS, one FAIL, 103 unrelated cases excluded; native exit 1/9688 ms, both EOFs, null signal, no timeout or capture error. Its reported assertion observes the fixture cap as 100000 instead of the expected 78488, with 94366 cumulative observed tokens. Read-only inspection identifies the fixture selecting the wrong temporary budget policy: software-engineer uses implementation, whereas the fixture configured analysis. Moving the same synthetic 78488 value to the role-selected temporary policy is the minimal pending correction, NOT applied. Budget-stop assertions remain unvalidated. No assertion, guard, production cap or timeout changed; no dependent check or remediation followed this failure. T003 remains partial; C03b-C06 and T004-T005 remain NOT RUN. No model call, real workflow mutation, sibling write, commit or push.

## Authorized continuation toward technical closure

The owner authorized the suggested fixture correction and all necessary scoped fixes to close these tasks, superseding the former stop-before-each-remediation condition. Production caps, unknown-usage rules, model-call exclusion and the 23-path boundary remain unchanged. The fixture now configures the role-selected temporary implementation policy and additionally checks its admitted caps and executor invocation. C03a PASS 8/8, 103 unrelated cases excluded, native exit 0/9561 ms. C03b first reported a missing contextHash import in the new legacy test (19 PASS/1 FAIL); adding that import preserved all assertions, then C03b PASS 20/20, native exit 0/28866 ms. T003 is complete. C04a PASS 28/28, native exit 0/1937 ms; C04b and T004/T005 acceptance remain in progress.

## Final technical acceptance — 2026-11-04 UTC

T001-T005 are complete within the exact 23-path approval and later scoped-fix authority. Final C01 48/48 (1911 ms), C02 243/243 (2439 ms), C03a 8/8 with 103 unrelated cases excluded (9561 ms), C03b 20/20 (28866 ms), C04a 28/28 (1937 ms), C04b 23/23 with 80 unrelated cases excluded (111839 ms). Total: 370 distinct selected cases; 183 excluded cases are not passes. Both historical coherent claim pairs remain verbatim; the third final public-source/fixture pair refuses mixtures and drift.

C05 PASS: schemas, typecheck, build, secrets; native exit 0/30568 ms, no waiver. C06 PASS: actual isolated API/Chromium with exactly four fake roles, retained Planner task/output/events/charges, separate human gates, exact candidate verification/independent reviews, local criterion action, actual restart/no replay and mobile evidence; native exit 0/93711 ms. Browser/Vite/API closed, workspace removed, no cleanup failures or browser-read cancellations. All final native captures have both EOFs, root exit, null signal and no timeout/truncation/spawn/stream error/termination request.

C05 initially stopped on five TypeScript narrowing errors; the direct captured typecheck and failed gate remain retained. The same terminating guard is now a function declaration with an explicit private contract return type. Logic, serialization, caps and assertions are unchanged; C01/C02 and the complete catalog gate passed afterward. Earlier fixture/import failures remain preserved above and in the design. No duplicate manual technical validation is needed.

No full suite, CI, eval, audit, installed-native qualification, model call, real workflow mutation, sibling write, quota reset/increase, commit, push or merge. Original real evidence and usage remain retained. Actual native support and token/latency/cost savings remain unmeasured; the real F3 ledger is exhausted with unknown accounting and no candidate, so F3/F5 remain open pending a separate feasibility/accounting and owner execution decision.
