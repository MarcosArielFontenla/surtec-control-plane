# Factory Local F3 — Engineer implementation context pack

Status: **PROPOSED — DESIGN ONLY**, 2026-11-06. Actual owner approval is pending. This proposal authorizes no implementation, test campaign, model or metadata session, workflow admission, recovery, commit, push or merge.

## Problem and retained evidence

The r3 Planner produced the exact plan accepted at G2. Engineer then stopped with `token budget exhausted (180000)`, before edits, candidate creation, verification or independent review. The retained original checkout and managed worktree are clean at baseline `retained privately`. Reviewer and QA did not start.

The observed Engineer usage is 189767 tokens in 52973 ms, with incomplete terminal accounting. Seven tool calls were inspections; four outputs were truncated and three commands failed. Inspection guessed nonexistent input folders, treated a planned output directory as an existing input, and used shell syntax incompatible with PowerShell. These are observed avoidable inspection costs, not proof that every input token came from repository reads.

The seven native usage samples total 188413 input and 1354 output tokens. Cached input, 153088 tokens, is already included in input and remains chargeable under the existing budget contract. After six samples, 155467 tokens had been observed; the seventh added 34300 and crossed the 180000-token cap. The runner charges differences of cumulative usage, not the cumulative total repeatedly. No accounting correction, cache discount or refund is proposed.

The actual initial transmitted context was 26829 UTF-8 bytes / 80 physical lines, within its 60000-byte / 500-line limits. Input per inference grew from 20958 to 34093 tokens. The failure concerns accumulated usage, not an observed context-window overflow. Required instructions and the retained plan are not candidates for removal.

Sources are the retained private `tmp/f3-p3/evidence/G1-result.json`, `G2-result.json`, `G2-command.json`, `G2-stopped-checkpoint.json`, `G2-worktree-observation.json`, task events, and the pinned source capsule. Relevant capsule modules are `runner/run-task.ts`, `runner/codex-app-server.ts`, `runner/agent-prompt.ts`, `runner/runtime-context-profile.ts`, `dashboard/src/server/issue-service.ts` and `dashboard/src/server/workflow-context-service.ts`. Their implementations are not targets.

## Smallest proposed increment

Prepare an attributed factual brief as private issue data. Keep the existing 21 plan entries byte-for-byte: five reviewed facts and sixteen complete bridge fragments. Append exactly nine brief entries, B01 through B09, producing exactly 30 entries within the existing issue contract. Do not replace the approved plan or full bridge with a summary.

Each new entry must be a nonempty, unique, trimmed single line, at most 300 UTF-16 code units **and** 300 UTF-8 bytes including its label. The nine entries add at most 2700 payload bytes; enclosing source formatting and the complete transmitted prompt must still be measured separately. This is a stricter private payload bound, not a product limit change.

The brief supplies verified locations, API/request/response facts, enum constraints, UI route/label facts, isolation requirements and a PowerShell-safe reading recipe. It distinguishes existing inputs from new output paths. It recommends targeted follow-up only for missing facts; all mandatory complete policy, instruction, skill and routed-document reads remain required. No tool-call quota or permission is supplied through text.

The collector uses the fixed source inventory in the private design annex, with 20 baseline Git blobs and three separately identified rehearsal references, totaling 122023 input bytes. These are local compilation inputs, not content to inline in full. It performs no recursive discovery or dependency/build-output reading. The reference revision is not the product baseline or an accepted candidate.

| Brief entry | Required topic |
| --- | --- |
| B01 | Baseline/source-map identity; existing inputs versus planned outputs; no implied authority |
| B02 | Authentication API and form facts needed by the isolated smoke |
| B03 | List API and corresponding UI facts |
| B04 | Item request fields, enum values and relevant validation constraints |
| B05 | Purchase/archive transitions and actual UI locations |
| B06 | API host and prerequisite constraints |
| B07 | Frontend command, routing and proxy facts |
| B08 | Persistence, unauthenticated and cross-user checks; owned resource closure |
| B09 | Fixed-path, bounded-range, PowerShell-safe follow-up guidance |

Each fact binds to its baseline or reference source ID, Git blob identity, SHA-256 and semantic anchor. A matching word outside the relevant handler/form context is insufficient. Reference-only files cannot establish baseline API/UI behavior. All existing acceptance criteria and verifier commands remain authoritative and complete.

Missing or ambiguous evidence, unsupported facts, a normalization/redaction change, an entry overflow, a missing instruction or a complete-context overflow stops preparation. Emit a bounded private gap report. Do not truncate, omit criteria, add a tenth entry, alter the redactor, increase caps or silently switch to another source. Feasibility of fitting the required facts into nine entries is a technical acceptance condition, not a result already established here.

## Composition and compatibility

Keep the sealed `tmp/f3-p3/protocol-draft.mjs` and `prepare.mjs` unchanged. The former validates exactly its five facts plus all bridge fragments; the latter's full preparation also embeds historical counters and operative state transitions. Its complete preparation function must not be reused for this stopped workflow.

A new private wrapper builds the legacy 21-entry projection through its pinned pure factory and validator, then validates the nine-entry tail and exact concatenation independently. Its closed private envelope binds the legacy projection, source manifest, factual brief, complete plan and their digests. It is not a new product schema, grant or live execution packet.

The old pure `assertCreateDraft` may validate only a separately reconstructed 21-entry projection with its correctly recomputed projection payload digest. A new full-draft validator checks the complete 30-entry payload digest, exact prefix and tail, unchanged criteria/scope, and all existing create constraints. Passing the projection is never reported as validation or authorization of the full draft.

Use actual issue normalization, source selection, attribution and governed prompt composition in synthetic acceptance. Assert all 30 exact strings survive creation and every Planner, Engineer, Reviewer and QA context, including their complete transmitted prompts and required generated sources. Recompute manifest/source fingerprints for the new data. Old previews, consent bindings and readiness seals cannot be reused for changed context.

The prompt/profile, instruction catalog policy, redaction, context schema, source caps, roles, safety prose, sandbox, network policy and structured-output validators remain unchanged. Private facts stay attributed task data. They confer no filesystem, shell, network or execution capability.

## Preserved accounting, verification and authority

| Boundary | Preserved requirement |
| --- | --- |
| Current workflow | Two tasks, two attempts, 71350 ms, 209565 observed tokens, `accounting_complete:false`; remains stopped in `needs-decision` |
| Historical accounting | Distinct observed floor 738401; combined final total unknown; all charges, receipts and incomplete evidence retained |
| Root limits | Four tasks / four attempts / 900000 ms / 300000 tokens |
| Planner | One attempt / 150000 ms / 30000 tokens |
| Engineer | One attempt / 450000 ms / 180000 tokens |
| Reviewer and QA | One attempt / 150000 ms / 45000 tokens each |
| Context | 500 lines / 60000 UTF-8 bytes / 64 sources; existing issue maximum 30 entries of 300 UTF-16 code units |
| Review | Full independent Reviewer and QA; correction OFF; existing human plan and acceptance gates |
| Verifier | Retained r3 commands and predicates; 300000-ms shared internal deadline, 2000-ms port observation and 65536 bytes per stream |
| Runtime | Same configured model/effort, native identity, read-only or isolated workspace-write policy, network OFF and existing guards |

The arithmetic remainder is two task/attempt slots, 828650 ms and 90435 tokens; it is not an executable allowance. Two slots cannot cover a fresh Engineer plus required Reviewer and QA. Incomplete accounting remains a separate blocker. This increment does not retry, recover, requeue, cancel, reset or replace the current workflow, issue, task, grant or candidate.

The retained r3 rehearsal passed V01–V08 in 260855 ms, with both independently observed business sessions and owned closure. That measurement and its 39145-ms observed margin are not a guarantee for another candidate or model turn. Preserve the r3 verifier manifest SHA-256 `714c84de789f4d3927734ef1a39854f476d01860f483064eba69dc35d56080ca`, campaign receipt `a959d7213ebde84e29a675c3c928800cd089c714bc8ff6217fda13dcb85b5cd9` and current p3 verifier seal `7f67406ab01aaeb90b1a99540fab4eb8e83624f19434bfcd56fa335622ae1930`.

Fewer inspection round trips are the intended benefit. No token, cache, runtime or delivery saving is measured by offline acceptance. The brief may itself increase initial input. Actual private role admission and a real implementation remain unqualified until separately authorized.

## Exact future files and generated data

This is a single-domain private operator preparation increment. It introduces no primary product entity, product contract, schema or cross-domain behavior. The [Spec-First Contract](../../.agents/specs/CONTRACT.md) does not require a new product spec/task artifact set for this scope. This proposal defines its bounded tasks and acceptance for actual owner review; no Harness artifact or pin is changed.

The only files authored at the design boundary are this proposal and the ignored private source-review annex (retained locally). The annex SHA-256 is `retained privately`. It contains the exact 23-source inventory, source identities and topic bindings, without generating the implementation payload. A clone without ignored evidence must report it unavailable, not assume review passed.

After implementation approval, exactly nine code/test files may be created under the new ignored root `tmp/f3-engineer-context-pack`:

| ID | Future target | Responsibility |
| --- | --- | --- |
| F01 | `tmp/f3-engineer-context-pack/implementation-brief.mjs` | Closed factual compiler, semantic bindings, provenance and strict nine-entry bounds |
| F02 | `tmp/f3-engineer-context-pack/implementation-brief.test.mjs` | Synthetic facts; missing, ambiguous, unsafe, normalization, Unicode and overflow negatives |
| F03 | `tmp/f3-engineer-context-pack/protocol-draft.mjs` | New wrapper over pinned pure legacy exports; immutable 21-entry prefix plus exact nine-entry tail |
| F04 | `tmp/f3-engineer-context-pack/protocol-draft.test.mjs` | Exact 30-entry composition, prefix/bridge preservation and all-role normalization regressions |
| F05 | `tmp/f3-engineer-context-pack/prepare-contract.mjs` | Pure full-draft/private-handoff validator; no operative preparation or execution entry point |
| F06 | `tmp/f3-engineer-context-pack/prepare-contract.test.mjs` | Synthetic authority, accounting, provenance and full-payload binding negatives |
| F07 | `tmp/f3-engineer-context-pack/admission-qualification.mjs` | Copy of retained synthetic full-flow qualification; only draft factory/data expectations change |
| F08 | `tmp/f3-engineer-context-pack/prepare.mjs` | Fixed inspect/fake-checks/qualification/seal modes, source collection, containment and preservation checks |
| F09 | `tmp/f3-engineer-context-pack/acceptance.test.mjs` | Pure operator refusal, provenance, path, cap and seal tests |

Future generated data is limited to source/fact inventories and digests, private fact seeds and brief, exact data-only draft, owned synthetic Git fixtures/state/temp, bounded technical receipts and seals. No normal operational-state copy, source-capsule overlay, verifier/native distribution copy, dependency acquisition, real issue/workflow/task/grant or live readiness packet is generated.

Require an absent root, exclusive normal-file creation, contained paths, no redirected/link targets, and refusal of unknown occupants or existing generated outputs. Use pinned local Node and fixed argument/test lists, never a generic command mode. Read the retained source capsule and legacy helpers through verified pins; do not substitute the current main runtime. Stop on missing/drifted dependencies without installing anything. Local source bodies and semantic review remain private; public receipts carry only bounded counts, categories and digests, never credentials or raw model reasoning.

## Proposed tasks

| Task | Dependency | Work and exit condition |
| --- | --- | --- |
| T001 | Actual implementation approval | Freeze source/evidence identities; implement the fixed read-only collector and private semantic fact review; distinguish baseline, reference and planned outputs |
| T002 | T001 | Implement F01/F03/F05 with synthetic contracts: exact nine entries, preserved 21-prefix, closed digests and no execution authority |
| T003 | T002 | Complete F02/F04/F06/F09; prove normalization, source attribution, full-draft binding, cap refusals and preservation negatives |
| T004 | T003 | Complete F07/F08 and synthetic full-flow qualification through actual services, workers, handoffs, independent review and QA; stop at pending G3 |
| T005 | T004 | Execute the proposed acceptance below in order; seal only technical evidence, preserved charges and unresolved live blockers |

No task is implemented or completed by this design. No parallel agent work is required.

## Proposed technical acceptance after approval

All commands remain foreground operations with owned TEMP/TMP, the existing 900000-ms command ceiling and 65536-byte per-stream capture. Stop at the first failure or unknown; do not automatically repair source, widen limits, repeat a campaign or start a model. The fixed operator records exact commands, exit/EOF observations and bounded receipts.

| Check | Proposed operation | Required result |
| --- | --- | --- |
| C01 | Syntax-check the nine reviewed files with pinned Node, then fixed read-only inspect | Normal owned targets; exact frozen Git blobs, inventories and historical evidence; no operative environment/state load or external process beyond fixed read-only Git |
| C02 | Fixed `node --test --test-reporter=tap` selection: the four new test files plus unchanged retained `tmp/f3-p3/protocol-draft.test.mjs` | Every selected test passes; zero skipped/todo/cancelled cases; all negatives prove refusal, not relaxed expectations |
| C03 | Compile/review only the private fact data against the fixed 23-source inventory | All semantic anchors supported; nine entries within both bounds; exact prefix, normalization and digests; no claim of actual role admission |
| C04 | One fixed complete synthetic admission qualification with synthetic brief and manufactured project/state | Existing two-parent-role/four-child-role fake flow preserved; all 30 strings in all four child roles; exact scope/consent, verified candidate, independent Reviewer/QA receipts, G3 pending, restart without replay |
| C05 | Fixed final preservation and seal | Frozen sources, p3/r3 operators/verifier, charges and historical state unchanged; bounded evidence matches reviewed inputs and all checks |

C04 uses actual pinned application services and a fake injected executor. It must have no path to the real model binary or native metadata session. Only its owned synthetic repository may receive fixture/baseline/candidate Git commits, as required by the retained qualification. No Gear List, Surtec repository or historical state commit/write is permitted. A fixed owned Node fixture verification command remains; Docker, browser, real business sessions and real V01–V08 are not run. Synthetic state and fact values are manufactured, never seeded from normal operational records or private product source bodies.

The technical seal is `OFFLINE_ENGINEER_CONTEXT_PACK_PASS` only if C01–C05 pass, with `live_ready:false`, `real_token_savings_qualified:false` and zero model/metadata calls. Synthetic admission, private source-data review and actual future private admission are distinct evidence classes. A PASS cannot close F3, accept a delivery, clear unknown accounting or issue additional paid authority.

Product tests, typecheck, build, browser smoke, CI, global suites, real verifier campaigns and live calls are outside this private data-only increment. They are not reported as passed or made unnecessary for a later product delivery.

## Stop boundary and next decision

At this boundary, run only documentary checks of these two design artifacts: expected paths/tasks/checks, local references, whitespace/encoding, annex inventory/hash, ignored status and preservation of retained records. Do not create the future implementation root or execute any proposed technical acceptance.

Stop for owner approval of this design, nine-file scope, T001–T005 and technical acceptance. Approval would permit only offline preparation and synthetic qualification. A later real continuation requires its own reviewed execution package, current source/state/ownership checks, reconciled accounting and explicit additional execution authority. Changed context requires fresh previews/consent and any applicable new Planner/exact-plan gate; G1/G2 are not replayed by this proposal.
