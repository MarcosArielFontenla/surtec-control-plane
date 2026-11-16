# Factory Local F3 — verifier binding before G2

Status: **PROPOSED — DESIGN ONLY**, 2026-11-06 (local date). The owner approved the exact retained Planner plan and its risk, and requested this bounded design. Implementation and technical qualification remain pending approval. This proposal does not authorize G2, model usage, Engineer, a candidate commit or publication.

## Problem and decision

The [context-pack reentry](factory-local-f3-context-pack-reentry-design.md) completed G0 preparation and one authorized G1 Planner turn. G1 stopped for human review with valid retained output, complete terminal usage and native closure. The owner has now approved that exact plan and its one risk in chat. No application recovery/plan decision has been applied; the workflow still has one finished Planner task, no approved-plan record and no candidate.

The private operator at `tmp/f3-p4/execute.mjs:62` derives Engineer's expected command from `context.verifierPinsSha256`. That property is absent from the closed, sealed context. Its quoted Node path also has doubled separators relative to the registered command. In a read-only comparison, inserting the correct hash alone still fails exact equality. The existing executor guard would refuse Engineer before the producer; G1 was unaffected because Planner receives no verify commands.

The single configured command, source-manifest binding and verifier manifest remain intact. Correct the operator's expected-command binding using those already reviewed inputs. Do not edit the context, weaken command equality, change the verifier or registry, or backfill an old seal.

Create one separate, append-only private operator amendment. Preserve the original nine operator files and every G0/G1 artifact byte for byte. The new executable must be independently pinned and explicitly referenced by any later G2 consent; old readiness cannot silently cover new executable bytes.

Read-only identities, exact registered command and the 24-artifact baseline are recorded in the private review annex (retained locally), SHA-256 `retained privately`. The original preparation context, packet, readiness, approval, Planner output, charges and historical source state are immutable inputs.

## Preserved state, accounting and limits

Current workflow: `WF-669acd7e-752b-4996-b040-dea60de73b59`, revision 9, needs-decision. Planner is finished/needs-review without a lease; the stage's retained running snapshot is eligible for the existing explicit human recovery path. Preserve both statuses and the recovery offer. Design/technical qualification must not apply recovery or convert the model outcome into completed.

| Fact | Retained value |
| --- | --- |
| Current grant usage | 1 task / 1 attempt / 17571 ms / 20226 tokens; accounting complete true |
| Historical observed floor before G1 | 738401 tokens |
| Combined observed floor after G1 | 758627 tokens; combined final total unknown |
| Arithmetic remainder, without authority | 3 tasks / 3 attempts / 882429 ms / 279774 tokens |
| Root ceiling | 4 tasks / 4 attempts / 900000 active ms / 300000 tokens |
| Planner ceiling | 1 attempt / 150000 ms / 30000 tokens; no second Planner |
| Engineer ceiling | 1 attempt / 450000 ms / 180000 tokens |
| Reviewer and QA, each | 1 attempt / 150000 ms / 45000 tokens; full independent review |
| Model/profile | gpt-6-luna / medium / governed-local-context-v1 |
| Context | 500 physical lines / 60000 UTF-8 bytes / 64 sources; all mandatory instructions and thirty admitted plan entries |
| Verification | Existing V01–V08 and both independently observed sessions; shared 300000 ms |
| Operator/capture | 900000 ms per command; 65536 bytes per stream; foreground, owned TEMP/TMP |
| Closure | Existing native exit/EOF/signal predicates; 2000-ms port observation |
| Correction/publication | Correction OFF; no push, merge or deploy |

The new allowance was already authorized at G1. This amendment allocates **zero** additional tokens, attempts, runtime, workflows or grants. Preserve the previous incomplete historical accounting; do not refund, reset, transfer or double-count any charge, discount cached input or claim provider-final settlement. The old gate's historical_observed_floor remains 738401; the current combined floor is a separate observation, not a replacement gate field.

## Exact proposed file scope

This is a single-domain private operator compatibility change under the [Spec-First Contract](../../.agents/specs/CONTRACT.md), with no new primary product entity or product spec/task artifact set. Approval of the tasks and checks below is required before implementation.

Proposed root `tmp/f3-p4-g2-binding` is absent. After approval, create it exclusively; refuse unknown occupants, redirected/link roots and reused outputs. New private files require nlink=1. Preserve the installed-Git identity exception already qualified by the context pack; do not broaden it.

| ID | Future source/test file | Responsibility |
| --- | --- | --- |
| F01 | `tmp/f3-p4-g2-binding/verifier-binding.mjs` | Pure closed resolver plus contained read-only loaders; validate original anchors, exact command and qualified amendment provenance |
| F02 | `tmp/f3-p4-g2-binding/verifier-binding.test.mjs` | Manufactured metadata/reader cases, exact command bytes, drift/path/manifest refusals and zero-mutation assertions |
| F03 | `tmp/f3-p4-g2-binding/execute-post-plan.mjs` | Separately pinned derivation of the frozen p4 operator, restricted to post-plan, with only the reviewed binding/provenance delta |
| F04 | `tmp/f3-p4-g2-binding/execute-post-plan.test.mjs` | Synthetic amended-gate, source-derivation, original-guard and pre-effect refusal cases; never call real post-plan execution |
| F05 | `tmp/f3-p4-g2-binding/qualify.mjs` | Fixed C01–C04 offline qualification only; bounded evidence and technical seal; no arbitrary runner or live mode |

Generated data is limited to exclusive-root ownership, input inventory, a record-only acknowledgement of the current chat, binding provenance, code pins, bounded check receipts, manufactured fixtures and the amendment seal under the new root. The acknowledgement binds the exact plan/risk but declares workflow_decision_written:false, G2 execution unauthorized and managed candidate commit unauthorized. Do not create a real G2 approval file.

No changes to product code, schemas, Harness, dependencies, lockfiles, registry, native/runtime distribution, verifier, context pack, original operator, original ownership records, G0/G1 receipts, plan or normal state. No new source capsule, state copy, issue, workflow, task or grant. No metadata session, Docker operation, verifier campaign, install, restore, browser smoke, evals, CI or general cleanup.

## Binding resolution

1. Validate the original context/packet/readiness and their existing SHA-256 chain. Require the source manifest hash already bound by G0/G1; an unanchored command or self-reported hash is insufficient.
2. Require exactly one manifest entry for `registry/projects.yml`, verify its physical contained file and bytes, and parse its existing JSON encoding. Require exactly one command for the exact Gear List project. No YAML dependency or alternate registry overlay is introduced.
3. Validate the reviewed command bytes/digest, its single lowercase 64-hex --pins-sha256 value, and its exact quoted Node/script paths against the existing sealed contract. Reject extra commands, duplicate pins, undefined values, changed separators/quoting, arbitrary shell text and any fallback. Do not normalize or repair a supplied command.
4. Require the actual verifier-pins.json file hash to equal that token and the existing reviewed manifest hash. Validate the manifest's unique script/contract entries and every existing file pin, plus the contract's canonical Node executable and hash. Keep all original checkStaticInputs and installed-tool predicates.
5. Return a copied array containing the exact registered command, plus closed provenance. Keep the existing same(input.verifyCommands, verifyCommands) executor assertion. Correctly identifying the verifier never permits a different command.

Reviewed command SHA-256: `retained privately`. Verifier manifest SHA-256: `retained privately`. The private annex fixes the remaining source, registry, script, contract and tool hashes. Missing or changed evidence stops; no acquisition, repinning or automatic repair.

## New executable and consent binding

Derive F03 from original execute.mjs SHA-256 `9784834e464b8c00efa2b82010a906b566960a5952a25742aece41540fb87b49`. Keep a deterministic, bounded source-delta map in the new qualification code, with unique old/new fragments and no wildcard replacement. Qualification must compare the whole generated file with the exact original plus only these reviewed hunks:

- Point its prepare import to the unchanged `../f3-p4/prepare.mjs`, preserving OPERATION_ROOT at p4 and its original G2-issued/G2-result no-replay paths. Import the new binding/provenance helpers.
- Reject modes other than post-plan immediately at the executable function boundary, before file/state/API effects; restrict the CLI too. Planner code may remain unreachable in the derived source, without another execution entry point.
- Load and verify the qualified amendment and resolved command before setEnvironment/loadApi or any recovery/state action. Extend the binding object with only operator_amendment_sha256 and verifier_binding_sha256.
- Add an amended-gate wrapper requiring those two exact qualified hashes. After validation, remove only those two extra properties from a copy, then invoke the unchanged closed original assertExecutionGate for post-plan. Unknown extra fields still fail; no permissive projection or default values.
- Replace initial/window gate calls with that wrapper and immutable-amendment rechecks. Retain all original gate predicates, task/lease guards, exact transmitted context, role/sandbox restrictions, native guards, accounting, terminal receipts, candidate verification, independent review, cleanup, no-replay and G3 stop predicates.
- Replace only the defective expected-command initializer with the validated exact command array. Keep the existing contract and executor equality check.
- Add immutable-amendment/source-pin verification to existing final preservation and bind the amendment/provenance in the existing issued receipt binding. All original helper-pin checks still validate the original files. No original file is repinned as if it were the new executable.

The technical amendment manifest binds the approved design/annex, all five new source files, exact original helper pins and preparation/G1 inputs, source/verifier provenance and the offline check results. Generate inputs, binding proof and source pins first, receipts next, then a separate final manifest: do not create cyclic self-hashes. A future G2 receipt must bind that manifest's actual file hash and the binding proof's actual file hash. These are private operator-envelope fields, with no product schema/API change.

At technical qualification and future G2 entry, require all 25 current state files to match G1-result.state_after, including the original task/event/charge bytes, and require the frozen source-state inventory to match the original packet. Once a separately authorized G2 begins, do not repeatedly demand the entry snapshot after legitimate workflow transitions. Throughout and finally, preserve immutable input/amendment pins and the original transition-specific historical task/event/accounting protections.

## Proposed tasks

| Task | Depends on | Files / work | Completion evidence |
| --- | --- | --- | --- |
| T001 | Human approval | F01–F02; exclusive root, input/provenance inventory and closed resolver with fakes | Both original defects reproduced as data; exact sealed command accepted; all refusal cases pass |
| T002 | T001 | F03–F04; bounded source derivation and amended gate; no operational invocation | Whole-file derivation exact; original guards intact; synthetic consent and pre-effect refusals pass |
| T003 | T002 | F05; ordered C01–C04 and separate technical seal | Every check PASS with exit 0, no skips/unknowns, preserved original inputs/state and zero live effects |

These tasks do not recover Planner or execute G2. A technical seal is not human approval or spending authority.

## Proposed acceptance, in order

Each fixed command uses the already pinned Node executable, foreground execution, owned TEMP/TMP, a maximum of 900000 ms and 65536 bytes per output stream. Stop on the first failed, truncated or unknown result; no automatic retry, timeout change or continued sequence.

| Check | Reviewed future PowerShell command | Required evidence |
| --- | --- | --- |
| C01 | `& 'C:\Program Files\nodejs\node.exe' tmp/f3-p4-g2-binding/qualify.mjs --check C01` | Five syntax checks; exact original and new source pins; closed fixed derivation and prerequisite/input identities |
| C02 | `& 'C:\Program Files\nodejs\node.exe' tmp/f3-p4-g2-binding/qualify.mjs --check C02` | Node --test of exactly F02 and F04, all cases pass, zero skip/todo/cancel; synthetic adapters only |
| C03 | `& 'C:\Program Files\nodejs\node.exe' tmp/f3-p4-g2-binding/qualify.mjs --check C03` | Read-only actual resolver: single registered command, all referenced pins and exact command-array equality; no command execution |
| C04 | `& 'C:\Program Files\nodejs\node.exe' tmp/f3-p4-g2-binding/qualify.mjs --check C04` | C01–C03 receipts qualified; 24 original artifacts, nine helper files, full 25-file state and original source-state inventory unchanged; emit separate seal |

C02 must include meaningful fakes for: missing context property and doubled-separator regression; positive exact registered command without mutating input; valid manifest with wrong command still refused; missing/duplicate/changed registry and manifest entries; malformed hash, alternate tool/script, quote/separator or path redirection; linked private files; missing/stale amendment and tampered new executable; unknown consent fields; changed workflow/output/result/risk; expired/nonexclusive ownership; extra allowance/cap/role, missing candidate-commit consent, skipped QA, unknown accounting and publication. Test the mode guard with a deliberately nonexistent gate to prove refusal before I/O. Mock readers/spawn/write boundaries must fail if used outside the synthetic scope; no live post-plan invocation or Git commit.

Final status: `QUALIFIED_FOR_SEPARATE_G2_REVIEW`, with paid_execution_authorized:false, model_calls:0, planner_recovery_applied:false, managed_candidate_commit_authorized:false, g3_accepted:false and publication_authorized:false. Existing G0/G1 statuses and receipts remain historical and unchanged. No old broad suite, 109/129-case block, six-role admission campaign, full suite, typecheck/build, metadata session or V01–V08 rerun is needed to qualify this private JavaScript binding delta.

## Separate future G2 boundary

After technical qualification, present the amendment/source pins and exact binding, unchanged plan/risk, current state/usage and proposed command for a separate actual authorization. Reuse the owner's current exact plan/risk approval without requesting it again unless the bytes change. Execution still requires explicit Engineer/Reviewer/QA authority through G3, explicit isolated managed candidate-commit authority, and a fresh thirty-minute exclusivity declaration covering Gear List and pilot roots. Do not reuse an expired G1 window.

The future receipt retains every original G2 field, exact G1 result/workflow/output and indexed risk acknowledgement, adds only the two qualified amendment hashes, and consents to zero additional nominal tokens. It must use the same grant/counters and unchanged caps. Existing protected recovery/decision APIs may apply the already approved retained plan only inside that separately authorized operation; there is no JSON patch, G1 replay, second Planner or new workflow. Preserve model status, original task/output, historical incomplete accounting and all recorded usage.

Any refusal/drift/unknown outcome stops for review without fallback. Final human G3 acceptance remains separate. This design ends before implementation approval, G2 execution, model usage or candidate commit.
