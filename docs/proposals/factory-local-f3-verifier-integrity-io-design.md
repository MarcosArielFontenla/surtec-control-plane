# Factory Local F3 — verifier integrity reads and native failure evidence

Status: **PROPOSED — DESIGN ONLY**, 2026-11-06. The owner requested this bounded design. Implementation, synthetic acceptance and another campaign are not authorized by this document. No model, commit, push or merge is authorized.

## Baseline and problem

The [short-path continuation](factory-local-f3-inline-protocol-execution-design.md#short-path-continuation--v08-unknown-2026-11-06) passed V01–V07 and returned UNKNOWN at V08 after 301597 ms. The report retains `final-candidate` / `candidate-git`, without the native details of that Git observation. Two independent real business sessions and their owned closure passed. Candidate identity was not confirmed at closure; this is not proof that the candidate changed.

The previous passing campaign lasted 293985 ms. Its V07 command took 101805 ms versus 117465 ms in the latest campaign. The recorded native command totals are 196007 and 205265 ms respectively. Preparation bounds inferred from existing filesystem timestamps are 30588 and 30853 ms. These are comparisons of separate runs, not a controlled performance experiment. They identify a small aggregate margin and V07 variation, not a measured regression in dependency copying.

Code inspection identifies fourteen complete copied-input checks in the successful V01–V07/final-observation path. Existing metadata indicates approximately 21485 initially copied dependency files, plus four generated configuration/lock pins. Preparation and repeated integrity reads consume the same existing 300000-ms window as commands and final sealing. The last V07 observation was written about 296565 ms after the execution owner file; that owner file was created after the deadline began. At that boundary, at most about 3435 ms remained. Filesystem timestamps support bounds, not precise runtime attribution.

Deadline exhaustion is consistent with the failure. The original `requireNative` call discarded whether Git was refused before spawn, failed to spawn, exited nonzero, lacked EOF, or reached its deadline. This design preserves that distinction prospectively; it cannot reconstruct the lost native result or promote the old UNKNOWN.

The source is the retained short-path revision: verifier manifest SHA-256 `51eafed5e3e5d8cad3c5acfe4c8fa3125ef14ae76290937b9eb331a22bb310c5`. Its 22 verifier files and 39 pins remain frozen. The failed report SHA-256 is `0091a5e744653ed828a12812d71d74682f763171254935a53aab583f76946eff`. Retained source, reports, test outputs, runtime distributions, worktrees and accounting are immutable inputs.

## Scope and unchanged boundaries

This is a single-domain change to a private operator-owned verifier, not a product entity or cross-domain feature. Under the [Spec-First Contract](../../.agents/specs/CONTRACT.md), no new product spec or Harness change is required. This proposal supplies the prospective scope, tasks and acceptance for actual owner review. It changes no product runtime, state schema, API, dashboard, policy, dependency or registry.

Future implementation writes are confined to the new ignored workspace root `tmp/f3-g0-r3`. It has not been created by this design. Initial bootstrap requires an absent root, exclusive creation, and exclusive writes of the three reviewed operator source files. The subsequent fixed preparation mode permits exactly those three normal files as its bootstrap occupants; all generated destinations must still be absent. Refuse unknown occupants, redirected/linked roots or existing generated targets. Keep the existing short layout: verifier `v`, execution parent `r`, owned homes/temp, and a physical complete `native/powershell` copy. The corresponding native DLL path remains projected at 195 characters. Never move or overwrite the earlier roots.

| Invariant | Preserved requirement |
| --- | --- |
| Time | 300000-ms shared internal deadline; 900000-ms command ceiling; all existing individual test, HTTP and runtime deadlines |
| Capture | 65536 bytes per native stream; existing EOF, exit, signal, truncation and cancellation classification |
| Concurrency | At most 64 file observations per `verifyPins` invocation and 16 per `verifyCopiedSourceFiles` invocation; existing concurrent final candidate/pin observations remain concurrent |
| Integrity | Fresh hashes on every call, original inventory order and fingerprint algorithm, normal-file/link checks, exact Git blob framing, exclusions and all before/after/final checks |
| Coverage | Same V01–V08 sequence, 82 frontend cases, 10 selected backend cases, build artifacts, offline locked restore/build and exactly two independent observed sessions |
| Resources | Existing 2000-ms port observation; unchanged process, image, store, ownership, lineage, database and closure assertions |
| Tools | Same Node/Git/.NET/npm/Chromium identities and complete 658-file stable PowerShell distribution; other static pins remain unchanged |
| Authority | No inference, metadata session, issue/workflow/grant/task admission, operative continuation or G1/G2/G3 decision |

The dependency copier, `capture`, `requireNative`, observation rules and existing verdict/seal logic retain their current implementations. Preparation remains inside the shared deadline. No verification hash cache, size/mtime shortcut, read-through dependency link, skipped/reduced inventory, removed check, extra deadline window, replay, retry or timeout increase is introduced. No global environment, thread-pool setting or OS configuration changes.

## Integrity read scheduling

Replace fixed batch barriers in the two integrity readers with a fixed-size in-process asynchronous read pool. A finished observation can take the next inventory entry while a slower observation remains pending. This changes scheduling, not the predicates that accept bytes.

- Allocate entries monotonically by their original index. A successful invocation checks every included entry exactly once, including duplicate entries. Preserve the original pin fingerprint computation and order.
- Each slot performs the same `lstat`, file/link validation, read and SHA-256 or Git-blob hash as today. Source exclusions and framing remain unchanged.
- A pin failure retains `pin-changed` versus `pin-unavailable`. Source validation retains its boolean result. The result corresponds to the lowest failing original inventory index, regardless of completion order.
- On the first observed failure, stop assigning additional entries and await all observations already started. Account for earlier slow indices before returning the ordered failure. No work may remain detached after resolution.
- Later indices can have started while an earlier slow index was pending. They remain within the same declared read-only inventory; no new paths or writes are authorized. The change does not create an atomic filesystem snapshot or stronger same-user race protection.
- Keep independent per-invocation state. Repeated calls re-read and re-hash every included input; no shared cache or last-success reuse exists.

Place the small read-pool helper in the existing `lib/snapshot.mjs`, with explicit 64/16 call sites. Pure injected observers let tests control completion order and count active work without filesystem timing thresholds. This is an I/O scheduling optimization, not a new scheduler, worker process or agent runtime. Speedup and sufficient real-campaign margin remain unmeasured until separately authorized representative acceptance.

## Bounded native failure evidence

Add a pure first-failure recorder to the existing `lib/core.mjs`; leave its current verdict/seal functions unchanged. The entry point supplies trusted phase/tool/operation enums and the already returned native result before any caller can collapse it into `candidate-git`. `capture` and `requireNative` themselves remain unchanged.

Record at most one normalized native failure. Subsequent failures cannot replace the first observation. A failure before the native result is available remains an explicitly unavailable diagnostic, not fabricated exit evidence.

The closed payload contains only:

- Diagnostic version, owner/verifier/report digest bindings.
- A closed phase enum: initial candidate, V01–V07, or final candidate. A closed tool enum and operation enum distinguish common-dir, status, HEAD, tree id, diff and tree listing. No argv, cwd, command text or absolute path is copied.
- Numeric elapsed time since the existing deadline began, remaining milliseconds immediately before the capture call, remaining milliseconds afterward, and the native elapsed duration. These are observations of the existing clock/window, not an added timer or allowance.
- Whether the inherited abort signal was already set and whether the existing deadline had expired at the call boundary.
- Observed PID when available, native exit/signal, root-exit and EOF flags, timeout/truncation/termination flags, and the existing allowlisted spawn/stream error codes. Unrecognized values receive fixed unknown categories; raw exception text is excluded.
- Optional counts and SHA-256 digests of retained captured streams, never stream bodies. Counts describe retained bytes, not unobserved bytes discarded by truncation.

These fields distinguish observed execution from an unobserved start and preserve evidence consistent with an expired-before-spawn case. Do not infer a successful start from a PID-less result or claim an underlying OS/Git cause that the native result did not expose. This is exact retained native evidence within its available fields, not reconstruction of arbitrary private stderr or historical errors.

Keep the primary report, stdout envelope, exit classification, `observation_errors` and seal predicates unchanged. After the primary report is written, write one separate deterministic `<report-stem>.native-failure.json` sidecar with exclusive creation in the same owned execution root. Bind it to the report digest and verifier seal. A closed status explicitly distinguishes `OBSERVED` with one normalized failure from `NO_NATIVE_FAILURE_OBSERVED` with a null failure. Its JSON is capped at 4096 bytes, below the existing stream bound; no output capacity is increased.

Projection is memory-only during native execution. Sidecar persistence adds no new deadline or retry. A missing, oversized, malformed, unreadable or mismatched sidecar is reported as diagnostic `UNAVAILABLE`; absence never means no failure. Preserve the original verifier result if diagnostic persistence fails. The wrapper keeps that primary outcome and reports diagnostic availability separately; its new technical-observability check cannot pass with an unavailable sidecar. No diagnostic can upgrade a failed/unknown primary outcome or supply a candidate seal. No raw prompts, reasoning, credentials, effective configuration, environment values or native output bodies enter the sidecar or wrapper receipt.

## Exact future implementation targets

The only repository document authored at this boundary is this proposal. After implementation approval, the following nine code/test files belong to the new private root. The six verifier targets are copies, never edits to retained revisions.

| ID | Future target | Change |
| --- | --- | --- |
| F01 | `tmp/f3-g0-r3/v/lib/snapshot.mjs` | Bounded ordered read pool; retain all integrity predicates and call sites |
| F02 | `tmp/f3-g0-r3/v/lib/core.mjs` | Pure normalized first-native-failure recorder; existing verdict logic unchanged |
| F03 | `tmp/f3-g0-r3/v/verify-candidate.mjs` | Phase/operation binding, capture-result projection and terminal sidecar |
| F04 | `tmp/f3-g0-r3/v/dependency-integrity.test.mjs` | Real owned-file mutation, missing/type/link, order and repeated-read regressions |
| F05 | `tmp/f3-g0-r3/v/source-integrity.test.mjs` | Exact Git-blob, exclusion, final-file and no-stale-read regressions |
| F06 | `tmp/f3-g0-r3/v/terminal-receipt.test.mjs` | Diagnostic cases and unchanged fail-fast/seal/verdict/privacy behavior |
| F07 | `tmp/f3-g0-r3/prepare.mjs` | Fixed prepare/fake-checks/regression-checks/seal modes; no arbitrary command runner |
| F08 | `tmp/f3-g0-r3/campaign.mjs` | Future separately gated one-shot campaign; bounded sidecar reader and unchanged acceptance |
| F09 | `tmp/f3-g0-r3/acceptance.test.mjs` | Pure scheduling, diagnostic and operator refusal fakes |

Declared generated data: copied unchanged baseline verifier files, all 658 runtime files, owned fixture/temp directories, `v/verification-contract.json`, `v/verifier-pins.json`, native inventories, `operator-pins.json`, `revision.json`, and bounded evidence under the new root. Keep 22 verifier files and 39 pins: no runtime module/test file is added inside `v`; only the six listed copied files may change. Rebind owner/contained paths and update the six reviewed hashes plus contract/manifest identity. Every other tool/static hash and baseline verifier file must remain identical. Operator files have their own three-file seal.

The future private `prepare` implementation must compare the complete native copy with the reviewed source inventory, refuse links/drift, use exclusive destinations, record prior UNKNOWN/FAIL/PASS provenance and preserve the previous manifests. Do not create or alter any operative state or source capsule. No PowerShell pin, global installation, dependency, lockfile, Harness manifest or sibling project is a target.

## Prospective tasks

| Task | Dependencies | Work and exit evidence |
| --- | --- | --- |
| T001 | Actual owner implementation approval | Implement the fixed preparation helper; qualify frozen inputs and make the new owned copy. Record exact baseline/native/operator identities, short paths and absence of real execution authority. |
| T002 | T001 | Implement F01/F04/F05 and scheduling fakes in F09. Preserve all reads, limits, ordered reasons, exclusions and fresh repeated validation. |
| T003 | T001 | Implement F02/F03/F06 and diagnostic fakes in F09. Preserve native transport, primary reports, first failure and existing seal outcomes. |
| T004 | T002, T003 | Complete fixed operator/wrapper validation, sidecar bounds, one-shot refusal and immutable source-delta checks. No campaign approval artifact exists. |
| T005 | T004 | Execute only the proposed technical checks below, in order; stop at the first failed/unknown command. Freeze actual results/seals and stop before any real campaign. |

No task is implemented or completed by this proposal. T002/F3/F5 and historical global acceptance debt remain open.

## Proposed technical acceptance after approval

All checks are foreground, with pinned Node and sanitized environments using owned TEMP/TMP, an unchanged 900000-ms command ceiling and 65536-byte captures. Preserve existing test timeouts. Helpers use fixed test-file lists and native executable identities, never shell evaluation of supplied commands. No install, download, Docker query/container, model or metadata session is part of these checks.

1. **C01 — syntax and preparation:** `node --check` the three operator files and, after copying/implementation, the six changed verifier files. Run `node tmp/f3-g0-r3/prepare.mjs --mode prepare` once during T001; T005 consumes that preparation receipt and never reruns the mode against the populated root. Existing destinations refuse; a partial result is retained and cannot silently be restarted. Preparation does not run tests or native business commands.
2. **C02 — pure fakes:** `node tmp/f3-g0-r3/prepare.mjs --mode fake-checks` invokes pinned Node `--test --test-reporter=tap` on F09 only. No real child program, clock-based benchmark or business filesystem fixture is exercised by the fakes.
3. **C03 — focused compatibility:** `node tmp/f3-g0-r3/prepare.mjs --mode regression-checks` invokes pinned Node `--test --test-reporter=tap` once with the exact nine retained verifier test filenames: `database-storage`, `dependency-integrity`, `dependency-traversal`, `observer-evidence`, `port-ownership`, `process-policy`, `source-integrity`, `terminal-receipt`, `verify-candidate` (each `.test.mjs` under `v`). This includes the three extended files. Existing fixtures use only new owned temporary files, local Git hashing, mocked observer executors, owned loopback sockets, fixed CLI refusal/syntax checks and PowerShell wrappers with fake port queries. They do not execute Docker or real business/API/browser flows. Retain all existing assertions and full test-file inventories; zero skipped/cancelled/todo cases.
4. **C04 — seal and preservation:** `node tmp/f3-g0-r3/prepare.mjs --mode seal` rechecks the six-file delta, all 22/39 verifier identities, all 658 runtime files, the three operator files, all bounds/recipes and prior input preservation. Record `TECHNICAL_CHECKS_PASS`, with representative campaign, timing qualification and G1 readiness explicitly pending. No full-campaign once marker or approval is issued.

Expected exit is 0 for every approved technical command, with observed root exit/both EOFs, no timeout/truncation and complete fixture closure. A failed/unknown command stops the sequence; retain its evidence and do not advance or replay it automatically. Public product TypeScript/build/schema/CI/full-suite checks are not required for this isolated JavaScript verifier-only delta; no product source changes. Syntax and synthetic passes prove no real speedup, margin or F3 delivery.

Required fake/fixture coverage:

- Positive inventories larger than 64 and 16, empty inventories, duplicate entries and the final entry; every eligible entry read exactly once per call. Repeated calls re-read unchanged inputs and detect same-size mutations.
- Slow-first completion demonstrates that the next eligible entry starts without a fixed batch barrier, while maximum active observations stay 64/16. Use controlled promises, not elapsed-time thresholds.
- Out-of-order differing failures preserve the lowest original-index reason, stop new assignments when a failure becomes known, drain existing work and leave no later callback activity. Fingerprints preserve original order.
- Missing files, directories/links replacing files, unreadable inputs, Git framing and exclusions keep their original outcomes. Existing dependency-copy containment/batch-drain tests remain unchanged.
- Fake expired-before-call, abort-before-call, spawn error, nonzero exit, signal, missing root exit/EOF, timeout, truncation and stream error remain distinguishable where fields permit. PID-less ambiguity remains explicit; a successful native result does not create a failure record.
- The first failure survives later failures; unknown/private error bodies, argv, paths, environment and synthetic secrets never enter normalized diagnostics. Oversized/malformed data and absent fields cannot become positive evidence.
- Sidecar owner/report/seal mismatch, path escape/link, malformed/oversized/unavailable data and missing future campaign approval refuse use or launch. Exact expected `UNAVAILABLE` diagnostics never promote the primary outcome.
- A valid synthetic V08 still needs matching current candidate/pin identities. Changed/missing/unobserved identities stay UNKNOWN, and earlier failures still refuse successors. Diagnostic availability cannot override this guard.

## Later decisions and risks

This proposal changes scheduling of read-only observations within the same inventory. It must preserve deterministic ordered failure semantics and drainage; slower earlier observations are a specific regression risk covered by fakes. It does not strengthen filesystem atomicity. Useful real performance improvement and enough margin for V07 variation remain unproven.

Only a separately authorized single representative V01–V08 campaign can establish actual timing and aggregate acceptance for the new revision. That campaign must repeat all original assertions and final sealing inside the unchanged deadline, with existing engine/image/cache prerequisites; it may stop UNKNOWN again. No standalone successful V08, sidecar, technical check or historical passing rehearsal can substitute for it.

Even a passing new rehearsal does not complete T003–T006 of G0, fix the operative live verifier binding automatically, issue a paid grant or authorize Planner/Engineer. Current real recorded usage of 112662 tokens/53674 ms, the distinct historical floor of 528836 and unknown combined final total remain preserved; no refund, transfer or additional nominal allowance is issued.

At this boundary, only the design document and its documentary checks are permitted. No new private revision, implementation, synthetic test, runtime call, campaign, cleanup, commit, push or merge is performed. Stop for actual owner review of the nine targets, tasks and proposed technical acceptance.
