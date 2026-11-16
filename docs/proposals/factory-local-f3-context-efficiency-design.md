# Factory Local F3 — governed context efficiency

Status: T001–T005 TECHNICALLY COMPLETE under the exact approved 23-path scope and mandatory C01–C06 synthetic acceptance, 2026-11-04 UTC. Original implementation approval acknowledgement was 2026-11-04T00:23:56Z. After the historical stop checkpoints, the owner authorized necessary scoped adjustments and revalidation through closure. All limits and model/side-effect boundaries remain intact; no model call, commit, push or merge occurred. Acknowledgements are not inferred earlier human timestamps. Original drafting occurred 2026-11-04 UTC (2026-11-03 in the owner's timezone); documentary observations and failed invocations below remain historical evidence. Real F3/F5 remain blocked/open, not technically accepted by this increment.

Specification: [governed-context-efficiency](../../.agents/specs/governed-context-efficiency.spec.yaml). Ordered work: [T001–T005](../../.agents/specs/tasks/f3-context-efficiency.tasks.md). Human approval of this exact proposal/spec/tasks is required by the [Spec-First Contract](../../.agents/specs/CONTRACT.md) before implementation.

## Objective and hard boundary

Reduce avoidable context added to a newly starting governed Codex execution while retaining every admitted source and mandatory instruction, the existing sandbox/approval/lease/verification/review controls and original numeric limits. This is one code-owned runtime context profile, not a new scheduler, tokenizer, context store or generic prompt optimizer.

The real F3 workflow remains needs-decision after the [recorded Engineer token stop](factory-local-f3-design.md#real-uncharged-claim-recovery-and-engineer-token-stop--2026-11-03). Observed usage is 115878 against the unchanged 100000 root token cap; Engineer observed 94366 against 78488 available. Final accounting is unknown. No reduction in a future prompt can restore capacity, complete missing usage or authorize replay of this charged attempt. The existing claim-recovery receipt is ready and one-use; the interrupted run is not an uncharged claim.

This increment can improve technical readiness for a future F3 decision. It cannot finish the real delivery under the exhausted ledger. Any later paid work needs its own explicit accounting/execution decision preserving all prior consumption and failures; a replacement identity cannot disguise a reset. No new budget, refund, transfer, grant, cancellation or real workflow mutation is proposed here.

## Read-only evidence and attribution

The retained session and normalized operational events were inspected with bounded local readers. Only numeric metrics, type classifications and hashes were recorded privately; prompts, tool-output bodies, credentials and reasoning were not copied into this repository or new evidence. No runtime process or model was started.

| Observed component | Size or count | Interpretation |
| --- | ---: | --- |
| Surtec admitted manifest | 24305 UTF-8 bytes / 66 lines / 16 sources | Selected source rendering, not runtime tokens |
| Surtec developer-instruction part | 24548 bytes | Manifest plus code-owned prompt wrapper |
| Runtime-added automatic skills instructions/catalog | 14408 bytes | Extra advertised context outside Surtec's source manifest |
| Runtime-added permission instructions | 7176 bytes | Safety context; preserve |
| Runtime-added collaboration instructions | 1056 bytes | Preserve |
| Runtime-added plugin recommendations | 796 bytes | Preserve in this first increment |
| Runtime base instructions | 17799 bytes | Preserve; no baseInstructions replacement |
| Two retained serialized tool-output payloads | 41666 and 8039 bytes | History payload sizes, not token counts or proof of complete tool output |
| Runtime CLI recorded by the retained session | 0.158.0 | Historical producer identity, not a claim about future support |

The three cumulative totals are 24150, 58091 and 94366. Retained last-inference totals are 24150, 33941 and 36275; their sum is 94366. Last-inference input grows from 23987 to 33793 to 35975. Thus the records do not demonstrate double counting: the adapter's existing cumulative high-water logic agrees with the producer's totals. Temporal alignment with the tool outputs supports investigating inspection breadth, not exact token attribution to an individual file or command.

The last observation reports 93755 input tokens, including 57472 cached, and 611 output tokens. Cached input is not free quota under the current raw total-token policy. This proposal changes no usage arithmetic, high-water handling, interruption classification, terminal receipt, billing interpretation or reported history. Byte reductions do not establish token or monetary savings.

The application issue source is 9892 bytes and generated workflow sources include repeated plan-related material. They remain complete and unchanged in this first increment: generic summarization, subtree deduplication and changed manifest/admission encodings would create another compatibility problem. The larger directly identified avoidable addition is the automatic skills catalog.

## Selected first increment

### One closed profile and bounded inspection guidance

Add a pure internal profile named governed-local-context-v1, with fixed versioned identity, fixed settings fingerprint and fixed inspection-guidance fingerprint. It has no caller-controlled configuration map, policy path, environment switch or HTTP/UI selector. Keep explicit legacy behavior for existing execution contracts and ungoverned adapter callers.

For a first governed execution with no retained execution contract/thread, select the new profile through trusted stage/runner composition. Carry its closed identifier through AgentRunInput. It never substitutes for context admission, role consent, a charged controller identity or a lease.

The new profile suppresses only automatic skills-instruction/catalog embedding through the documented skills.include_instructions=false setting. Surtec's complete admitted sources, project/ancestor instructions and every routed required skill body remain available through the existing trusted assembly. Required content must never be truncated, omitted or reduced to a hash to save space. A route whose mandatory content cannot be assembled still refuses execution.

Keep the automatic skills subsystem itself, optional tools/apps/MCP configuration, model base instructions, plugin recommendations, permission text and existing safety settings unchanged. Hiding catalog text is not an ACL or a stronger filesystem-read boundary. This increment does not turn off a mandatory skill, edit a skill, change a Harness route or repin its curated baseline.

Add concise, fixed guidance to inspect from admitted paths: search filenames/symbols first, read relevant bounded ranges, use explicit per-call output budgets supported by the tool and complete all required reads in ordered slices. Avoid recursive repository/dependency/build dumps. This is inspection guidance, not permission enforcement or proof that a model will follow it. Existing tool-output ceilings, required verifications and every timeout stay unchanged.

### Process setting plus pre-turn verification

For the new profile only, CodexExecutor uses the existing fixed stdio command with the fixed process override:

    codex -c skills.include_instructions=false app-server --stdio

The executable remains the current separately qualified configurable runtime. The profile cannot supply extra arguments. Legacy spawning remains byte-equivalent to its current argument vector.

After initialize and before thread/start or thread/resume, the client uses the generated stable config/read contract with includeLayers=false and the execution cwd. Require an own explicit boolean false at config.skills.include_instructions. Missing, true, malformed, unsupported or refused configuration stops before any thread/turn; it must never silently fall back. Only that allowlisted setting is inspected, with generic bounded errors: no raw effective config or credentials in events/logs. Send the same fixed setting in the thread's existing config override so the process/thread composition is coherent.

Approval routing, sandbox/network fields, shell inheritance, agents.enabled=false, output schema, cancellation and native terminal/EOF handling remain as currently enforced. Do not enable experimental API fields. Documentation and generic config types do not prove that a future installed binary honors the setting: the pre-turn check is mandatory and native savings remain unmeasured.

That native check remains inside the existing charge-before-preparation path: refusal does not refund an attempt or turn incomplete usage into zero. Do not schedule a real attempt merely to qualify a setting. Installed-runtime qualification belongs to any later explicitly authorized operational preflight, not these fake-only technical checks.

### Explicit execution-contract compatibility

Do not globally replace old prompt-version constants or reinterpret stored fingerprints. Preserve the exact existing legacy hash input/serialization.

Derive a second execution fingerprint from the existing complete task/stage/role/grant/manifest/cwd/mode/verification/output contract plus the fixed profile/settings/guidance fingerprints. The private profile identifier travels beside that fingerprint; arbitrary request metadata cannot choose it.

When an execution contract already exists, recompute both supported candidates from current bound facts and select only an exact match. A legacy match retains its old prompt/spawn/RPC behavior; a new-profile match retains the same profile. Wrong types, present undefined/null, unknown hashes, a bare saved thread without its valid contract and changed task/stage/role/source/cwd/schema/config bindings refuse. Never reset a fingerprint because matching failed. Do not infer legacy from missing newly invented metadata.

This finite hash dispatch adds no persisted facet, schema migration or backfill. Existing metadata.run.context_fingerprint remains the binding; return the selected profile as process-private preparation data. Old records, receipts, exact Planner approval, counters, events and archives remain unchanged. Generic v2 retry, unknown accounting and exhausted budgets continue to deny execution independently of profile selection.

### Existing pre-charge proof compatibility

Changing runner/run-task.ts and the synthetic operator changes two pinned producer inputs. Preserve both existing coherent producer/operator pairs verbatim in uncharged-claim-recovery.ts and append one explicitly reviewed static pair for the final new public source and test fixture. Do not mutate old pins, accept mixed pairs, adopt current filesystem hashes at runtime or touch registry/Harness pins.

The new profile helper must be pure, with no process/filesystem/network side effects or model entry point. The pinned charge-before-run ordering, immutable ledger and existing exact claim eligibility remain unchanged. New synthetic positives use only public fake sources. No private runtime/state is copied into tests. The actual charged/exhausted real attempt stays ineligible even if an earlier archived claim remains structurally valid.

## Approved implementation targets

The original design-only turn authored the first three artifacts. The approved implementation uses exactly these 23 paths, including tests and compatibility work; no other source target is implied.

1. `docs/proposals/factory-local-f3-context-efficiency-design.md`
2. `.agents/specs/governed-context-efficiency.spec.yaml`
3. `.agents/specs/tasks/f3-context-efficiency.tasks.md`
4. `runner/runtime-context-profile.ts`
5. `runner/runtime-context-profile.test.ts`
6. `runner/agent-executor.ts`
7. `runner/agent-prompt.ts`
8. `runner/agent-prompt.test.ts`
9. `runner/workflow-stage.ts`
10. `runner/workflow-stage.test.ts`
11. `runner/run-task.ts`
12. `runner/run-task.test.ts`
13. `runner/codex-app-server.ts`
14. `runner/codex-app-server.test.ts`
15. `runner/codex-executor.ts`
16. `runner/codex-executor.test.ts`
17. `lib/workflows/uncharged-claim-recovery.ts`
18. `lib/workflows/uncharged-claim-recovery.test.ts`
19. `scripts/fixtures/local-issue-api.ts`
20. `docs/architecture/execution-runtime.md`
21. `docs/security/threat-model.md`
22. `docs/proposals/factory-local-f3-design.md`
23. `docs/roadmap/factory-local-poc.md`

No generated bindings, package/lockfile, registry, Harness script/skill/catalog, prompt source manifest, admission schema, normal user state or sibling source is a target.

## Ordered work

- T001: pure profile, finite legacy/new fingerprint dispatch, complete-prompt guidance and focused contract tests.
- T002: fixed spawn override, pre-thread effective-config verification and fake/native-Node protocol regression coverage.
- T003: stage/runner propagation under existing ownership/accounting guards; synthetic cumulative-usage and legacy-byte preservation cases.
- T004: preserve existing producer pins, add the final reviewed pair and assert new-profile propagation inside the owned API/browser fixture; retain all current assertions.
- T005: complete bounded acceptance, record evidence/limitations and leave the real exhausted workflow untouched.

The [task plan](../../.agents/specs/tasks/f3-context-efficiency.tasks.md) gives exact per-task paths and dependencies. Tasks remain unchecked until their actual acceptance; approval metadata now records the owner's explicit technical authorization above.

## Proposed acceptance after actual implementation approval

Use foreground native capture, separate drained stdout/stderr, owned external TEMP/TMP and 900 seconds per command. Existing test/HTTP/worker/role/capture limits remain unchanged. Stop dependent checks at the first failure or unknown; retain the result. Routine scoped remediation is permitted only inside the approved targets/requirements.

1. C01 pure contracts:

       pnpm exec vitest run runner/runtime-context-profile.test.ts runner/agent-prompt.test.ts --silent=passed-only

2. C02 transport and existing terminal evidence:

       pnpm exec vitest run runner/codex-app-server.test.ts runner/codex-executor.test.ts --silent=passed-only

   Use in-memory protocol fakes and existing owned native Node producers only. Cover old spawn/RPC byte equivalence, new fixed args, false/true/missing/malformed/refused config, unsupported profile, zero thread/turn requests on refusal, no raw config leakage, exact fingerprint propagation and current cancellation/terminal/EOF cases.

3. C03a runner integration:

       pnpm exec vitest run runner/run-task.test.ts --testNamePattern=context-economy --silent=passed-only

   New named cases must actually execute; zero selected or skipped-only is not PASS. Reproduce the three cumulative samples and a duplicate with synthetic data, retain 94366 rather than summing cumulative totals or subtracting cache, enforce the unchanged 78488 cap, preserve unknown final usage and forbid candidate/verification effects. Cover new and exact legacy selection, unknown profile refusal, cancellation and lost lease. No real pilot data seeds these cases.

4. C03b complete existing stage guards:

       pnpm exec vitest run runner/workflow-stage.test.ts --silent=passed-only

5. C04a current and retained claim-proof compatibility:

       pnpm exec vitest run lib/workflows/uncharged-claim-recovery.test.ts --silent=passed-only

6. C04b existing recovery and charged/unknown denials:

       pnpm exec vitest run runner/workflow-orchestrator.test.ts --testNamePattern="planner-recovery|uncharged-claim|missing final usage is unknown and cannot be recovered as zero or retried" --silent=passed-only

7. C05 four existing catalog checks:

       pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/governed-context-efficiency.spec.yaml -TimeoutSeconds 900

   Exactly schemas, typecheck, build and secrets. This does not replace C01–C04/C06 or prove native provider behavior.

8. C06 existing actual isolated API/Chromium flow:

       pnpm smoke:local:playwright --planner-recovery-only

   Exactly four fake roles, complete owned cleanup, retained original Planner/human gate, exact verified candidate and independent Reviewer/QA, reload/restart/no replay. The test-only executor asserts trusted new-profile propagation. No browser selector/assertion/deadline change or normal state/server is needed.

Require exact legacy hash/prompt/request compatibility, strict unknown denial, unchanged admitted source bytes and mandatory reads, complete byte/line accounting for new guidance, stable profile hashes, no provider/secret side effects and no arithmetic/limits changes. Retain all historical failures and global full-suite/CI debt.

Technical PASS establishes deterministic configuration, binding and fake execution behavior. It does not measure real token/latency/cost reduction, guarantee a future installed native setting, certify quality or prove that all four real roles can fit inside 100000 tokens. No paid acceptance, live runtime, CLI generation/upgrade, install/download, full suite, CI, eval, audit, process cleanup or sibling work belongs to this increment.

## Real F3 decision after technical acceptance

The existing operation remains closed BLOCKED_BY_TOKENS. Preserve its 115878 observed tokens, unknown final usage, original Planner charge/approval, ready recovery journal and clean retained worktree. Do not start a worker, issue preview, requeue, cancel, top up, settle unknown or create a replacement identity as part of this work.

Before any future real execution proposal, present measured offline byte/config changes separately from unmeasured runtime token savings, the intact historical ledger and an honest feasibility assessment reserving verification and both reviews. If feasibility is unknown or the existing ledger has no capacity, report the blocker. Changing context alone cannot make this ledger spendable. Additional execution authority/accounting is an explicit later human decision, not an implementation detail or implied approval of this design. F3/F5 and final human criterion acceptance remain open.

## Official references and scope of inference

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): documents the automatic skills-instruction setting. It does not certify this installation or permit removing required project instructions.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): documents config/read and thread usage updates. Local generated types and existing producer records provide the implementation evidence.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): distinguishes cached input and full rendered context, which includes tools/history. No cache discount, API price estimate or ChatGPT billing claim is inferred for this workflow.

## Historical design-only checks

Only structural spec/task validation and in-memory target/dependency/link/privacy/whitespace/hash checks are authorized now. Use no -Run or -ConfirmExecution. Do not run C01–C06, a suite, build, typecheck, smoke, runtime or model while drafting. Record actual documentary results separately; passing structure is not human approval.

## Documentary observations — 2026-11-04 UTC

- Structural validation of the single proposed spec exited 0 and executed zero acceptance commands.
- Structural validation of the single draft task plan exited 0; all five ordered tasks remain unchecked and human review metadata remains null.
- Detailed numeric/type/hash evidence and the final target/link/privacy/integrity report are retained outside Git. No private source bodies, normal state or runtime configuration were copied into these drafts.

These documentary results are not C01–C06, implementation acceptance, native setting qualification, measured token savings, a new execution grant or F3/F5 completion.

## Historical implementation checkpoint — first acceptance failure

The owner subsequently approved this exact design/specification/T001–T005 and required stopping at the first failed or unknown result. T001 is partially implemented; no task is marked complete. Its first foreground C01 invocation executed both selected files: 47 cases passed and one new non-workflow legacy-fingerprint fixture case failed. Native exit was 1 after 2366 ms, with root exit/both EOFs, null signal and no timeout, truncation, spawn/stream error or requested termination.

Read-only inspection of the failure identifies inconsistent fixture serialization: the frozen hash used by the new agent-prompt test was computed with version before manifest, whereas the existing non-workflow runner and its new extracted helper serialize manifest before version. The guard refused the mismatched binding. The separate pure-profile fixture legitimately uses the former object order and passed. No test expectation, runtime guard or limit was changed after failure; no test was repeated.

T002–T005, C02–C06, typecheck, build and all other acceptance remain NOT RUN. The native result and baseline are retained privately. No model/runtime, normal workflow mutation, sibling write, commit, push or merge occurred. The next minimal remediation is to correct only the new agent-prompt fixture's legacy hash and repeat C01 after further owner direction; that remediation has not been applied.

## Historical resumed implementation checkpoint — C03a fixture rejection

The owner authorized the proposed fixture-hash correction. Only its two literals changed; C01 then passed all 48 cases (native exit 0, 1893 ms). T002 was implemented within the original approved sequence; C02 passed all 243 cases (native exit 0, 2608 ms), including fixed-profile pre-thread verification, safe rejection and existing legacy/terminal evidence coverage.

T001 and T002 are complete. T003 is implemented but remains partially validated. Its first C03a selected eight new runner cases: seven passed, one failed, and 103 unrelated cases were excluded by the approved filter. Native exit was 1 after 7696 ms, with both EOFs, null signal and no timeout, capture truncation, spawn/stream error or requested termination.

The new cumulative-usage fixture failed with `Invalid task admission fields` at `createTask`, before calling its executor. Read-only inspection confirms that the fixture spreads the preview request's `kind` into task creation, whose closed input contract excludes that field. The proposed minimal correction is to pass the existing explicit task fields without `kind`; this correction has NOT been applied. No guard, assertion, cap, timeout or real ledger was changed in response to this failure, and no check was repeated afterward.

C03b, T004–T005, C04–C06, typecheck and build remain NOT RUN. Work stopped at the first new failed check as authorized. The partial code and complete native receipts are retained for review; neither synthetic acceptance nor F3/F5 is complete. No model call, real workflow mutation, sibling write, commit, push or merge occurred.

## Historical implementation checkpoint — C03a synthetic cap mismatch

The owner explicitly authorized removing only the preview-only `kind` from the new fixture's `createTask` input and repeating C03a, continuing only on PASS. That single call now passes explicit existing task fields and retains all assertions. The repeated C03a ran eight cases: seven PASS, one FAIL, 103 unrelated cases excluded. Native exit was 1 after 9688 ms, both EOFs observed, null signal and no timeout, truncation, spawn/stream error or requested termination.

The first reported assertion expects the fixture's unchanged 78488 cap but observes 100000; its cumulative observed counter is 94366. Read-only inspection identifies a second fixture wiring error: it configures the temporary `analysis` budget policy, but its admitted `software-engineer` role selects `default_budget_policy_id: implementation`. The temporary role budget therefore remains 100000. No runtime/accounting defect is established by this failed fixture, and budget-stop assertions remain unvalidated. The minimal pending correction is to place the same synthetic 78488 policy value in the role-selected temporary `implementation` policy before admission, preserving expectations, production policy, guards and limits; this correction has NOT been applied.

Work stopped at this new failure. T003 remains partial; C03b–C06 and T004–T005 remain NOT RUN. No further test, typecheck, build, model call, real workflow mutation, sibling write, commit or push followed the failure. Historical failed receipts remain retained.

## Technical acceptance — 2026-11-04 UTC

The owner subsequently authorized the suggested fixture correction and all necessary scoped adjustments to close T001–T005. The fixture now configures the same 78488 value in the role-selected temporary implementation policy before admission, with additional assertions for admitted caps and actual executor invocation. All original assertions remain. C03b then exposed a missing import in its new legacy test; adding that import preserved all checks. C05 first stopped on TypeScript narrowing errors; a direct captured typecheck identified them, and an explicitly declared terminating rejection function plus private return type resolved them without changing guards, fingerprints, settings, accounting or limits. Every failed native receipt remains retained.

| Group | Final result | Native elapsed |
| --- | --- | ---: |
| C01 complete pure-profile/prompts | PASS 48/48 after the type-only correction | 1911 ms |
| C02 complete fake protocol/native Node executor | PASS 243/243 after the type-only correction | 2439 ms |
| C03a selected runner context-economy | PASS 8/8; 103 unrelated cases excluded | 9561 ms |
| C03b complete workflow-stage guards | PASS 20/20 | 28866 ms |
| C04a complete claim-proof compatibility | PASS 28/28, including all three coherent pairs and mixed/drift denial | 1937 ms |
| C04b selected recovery/unknown-usage integration | PASS 23/23; 80 unrelated cases excluded | 111839 ms |
| C05 existing four-command catalog gate | PASS schemas, typecheck, build and secrets; no waiver | 30568 ms |
| C06 focused actual API/Chromium | PASS exactly four fake roles and complete owned cleanup | 93711 ms |

The behavioral groups cover 370 distinct selected cases; 183 excluded cases are not reported as passed. Final captures have native exit 0, null signal, observed root exit and both EOFs, with no timeout, truncation, spawn/stream error or requested termination. The gate retained 900 seconds per command. The focused browser flow preserves the original incomplete Planner/output/events/charge, a separate human plan gate, exact verified candidate and independent Reviewer/QA, local human criterion action, actual restart/no replay and mobile evidence. Browser, Vite and API closed; the synthetic workspace was removed with an empty cleanup-failure list and zero browser-read cancellations.

Only the two profile source/test files are new; remaining changes are within the approved targets. Final documentary/integrity observations and native receipts are retained outside Git. No real workflow/state, sibling source, global configuration, Harness baseline, dependency, ledger, usage, cap or approval was changed. No full suite, CI, eval, audit, installed-native probe or paid/model turn ran. Repeatable technical acceptance is automated; no duplicate manual local check is required for this increment. Actual native support and token/latency/cost savings remain unmeasured. The separately exhausted real F3 ledger remains blocked at its original 115878/100000 observation with unknown final accounting; F3/F5 need a separate honest feasibility/accounting and owner execution decision.
