# Factory Local F2 acceptance

Status: revised functional F2 acceptance is approved and active as of 2026-10-30T13:46:42Z. Functional automated verification is now complete under that revised procedure: earlier six-check gate, functional groups and Harness are recorded PASS; the polling repair passed 80 targeted tests/typecheck, and the latest single real API/Chromium smoke is PASS with exactly 31 fake turns, native exit 0, both EOFs, 670440 ms wall and complete reported owned cleanup. The owner has explicitly confirmed the prepared replacement-pilot checkpoint; T008 is complete: F2 functional acceptance complete for the local PoC, global debt open. DEBT-F2-GLOBAL-900 remains open with prior failures and unknowns preserved.

The owner approved the [reviewed revision](../proposals/f2-functional-acceptance-revision.md) and its activation. After polling regressions/typecheck passed, the owner authorized exactly one smoke with 900 seconds. That smoke and its owned cleanup passed. The owner subsequently authorized replacement-pilot preparation and explicitly confirmed its exact technical checkpoint. Authority ends after recording closure; further checks/evals/CI, paid runtime, independent cleanup, publication and F3 require their own explicit scope and authority.
## Current F2 functional acceptance

The current [spec](../../.agents/specs/factory-request-contract.spec.yaml), [design](../architecture/factory-request-contract-design.md#current-acceptance-contract) and [tasks](../../.agents/specs/tasks/factory-request-contract.tasks.md) require ALL stages below. Execution needs a separate explicit owner instruction. Check metadata/commands and this runbook are not execution authority.

### 1. Readiness and six-check H4 gate

Inspect the current reviewed dirty baseline and recorded ownership/closure evidence. Use foreground native completion, fresh qualified owned external TEMP/TMP and the original purpose-specific environment and owned-tree termination policy. Preserve user work. Do not reuse detached launchers, repair/clean unknown state or infer cleanup success from a retained directory or an outer exit.

The unchanged validator command below ran the six active checks once under separate execution approval, with 900 seconds PER command and no shorter aggregate cap. This is the revised six-check gate, not an original seven-check PASS. Documentary activation itself did not execute it.

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

| Active ID | Exact catalog command | Required result |
| --- | --- | --- |
| ac-schemas | `pnpm schemas:check` | Native exit 0 |
| ac-types | `pnpm typecheck` | Native exit 0 |
| ac-build | `pnpm build` | Native exit 0; warnings recorded |
| ac-repository | `pnpm repository:check` | Native exit 0 |
| ac-secrets | `pnpm secrets:check` | Native exit 0; no universal DLP claim |
| ac-evals | `pnpm evals:check` | Native exit 0; offline fixtures, no live canary |

All six retain their original definitions, requirement mappings and expected exit codes; `checksWaiver: null`. Types, schemas and builds do not prove behavioral requirements. `ac-behavior` / complete `pnpm test` is retired only from the active F2 exit list and remains unresolved global regression/performance debt. No validator/catalog, package script, limit or test is changed.

### 2. Mandatory functional commands

Only after all six pass, and under explicit authority for this stage, run each fixed command once in this order. These are required external procedure IDs, not unsupported YAML catalog entries. The first three groups select nine complete files; do not filter their cases.

| Procedure ID | Coverage |
| --- | --- |
| f2-functional-state-http | req-001/002: identity/fingerprint, replay/progress/restart, conflict/capacity, strict immutable legacy/future receipts, locks/replacement safety, protected HTTP and zero intake execution effects |
| f2-functional-context-plan | req-004/005: contained sources, attribution/revisions, limits/exclusions, renewed issuance, scope/consent, current exact human plan approvals and refusals |
| f2-functional-ui | req-003/004/005: pending UUID/payload, storage/refusal, retry/reload/cancel uncertainty, context evidence/privacy and bound UI decisions |
| f2-functional-smoke-helpers | req-006: existing read-synchronization and Issues-refresh helpers; not a browser substitute |

```text
pnpm exec vitest run lib/state/issues.test.ts dashboard/src/server/issue-service.test.ts dashboard/src/server/index.test.ts --bail=1

pnpm exec vitest run lib/context/sources.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/workflow-api.test.ts --bail=1

pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/components/ContextPreview.test.tsx dashboard/src/ui/components/WorkflowPanel.test.tsx --bail=1

pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|Issues refresh)" --bail=1
```

Each command retains 900 seconds, the two configured workers and original assertions/test/poll limits. Record actual native result, expected file inventory, active/filtered/skipped counts and reasons, stream completion, duration and owned lifecycle. The existing helper selection historically had 28 active and 70 filtered cases; verify coverage against current source. Missing selected cases, unexplained or requirement-critical skips and unavailable terminal evidence are not acceptance. Old passes or the partial global inventory do not automatically satisfy the revised procedure.

### 3. Harness and real API/browser

Only after preceding required checks pass, execute the separately authorized Harness check. Only after Harness passes, execute the separately authorized real isolated browser smoke:

```text
pnpm harness:check
pnpm smoke:local:playwright
```

The smoke starts its own loopback API, Vite and browser with synthetic repositories/state and an injected fake executor. Use neither a manually started server, normal state nor a real sibling/model. Retain all K-O scenarios and exactly 31 fake turns; F2 intake/context/recovery assertions add no dispatch. Require real receipt/replay/unchanged-byte checks, double submit, lost acknowledgement, retry/reload GET reconciliation, progress/restart, stale/forged source/scope/preview/plan refusals and explicit human gates.

Record native completion, browser/API errors, criterion evidence, final fake-turn count and each owned process closure/fixture-removal result independently. Unknown relevant cleanup is incomplete acceptance. No blanket process/filesystem cleanup, raw private payload persistence or authority to inspect unrelated processes follows.

### 4. Human pilot readiness and closure

The owner selected a replacement private pilot, authorized preparation and explicitly confirmed its exact baseline, outcome/criteria, permitted/excluded paths/categories, contained sources, trusted verification commands and approver. The confirmation is recorded in the closure checkpoint below. Private source/path/business details remain outside this public evidence. Future pilot changes or implementation require separate scope and authority.

All revised checks, current attributable results and relevant owned lifecycle evidence plus the human checkpoint are mandatory. If automated verification passes but pilot readiness is missing, report functional verification complete with pilot preparation pending; retain T008 unchecked/F2 in progress.

Only once every criterion is satisfied may T008 complete under the label F2 functional acceptance complete for the local PoC, global debt open. The original gate and whole repository remain unverified; this is not a Q/CI PASS, deferred P activation, product-candidate acceptance, F3 start, paid-call or publication permission.

### Stop, debt and current results

Stop at the first failed or unknown command; leave successors NOT RUN. No automatic rerun, global suite/CI campaign, profiling, assertion/guard/timeout change, repair, extra cleanup or publication. No timing guarantee is implied for the focused groups.

| Revised requirement | Current result |
| --- | --- |
| Six-check H4 gate | PASS: six ordered native exit-0 markers; validator native exit 0, both EOFs, 36578 ms host wall |
| Four functional commands / nine complete files plus helpers | PASS: 376 + 72 + 209 + 28 active cases; one explained browser skip and 70 filtered helper cases |
| Harness check | PASS: native exit 0, both EOFs, 5426 ms host wall |
| Real API/Vite/browser smoke and relevant cleanup | PASS after polling correction: native exit 0, both EOFs, 670440 ms, exactly 31 synthetic turns; subsequent browser/Vite/API closure and workspace removal all true, failures empty and confirmation present |
| Private-pilot technical/human checkpoint | COMPLETE: exact prepared baseline, outcome/criteria, allowlist/exclusions, context, commands and owner approver explicitly confirmed in this conversation; session acknowledgement 2026-10-30T23:02:57Z |

See the separate [DEBT-F2-GLOBAL-900 record](../roadmap/factory-local-poc.md#debt-f2-global-900). Historical timeouts and fixture-cleanup unknowns remain unchanged. Resolving that debt requires the complete unfiltered suite with native/terminal/stream and relevant lifecycle evidence under existing limits; focused PASS, revised gate PASS or a model summary cannot close it.

### Revised six-check gate result - 2026-10-30

One foreground invocation of the exact validator command above completed outside the sandbox with newly owned qualified external TEMP/TMP. Read-only preflight matched the six approved check definitions, all five activated-document hashes, 98 out-of-scope changed-file hashes, nine protected artifacts, HEAD/branch and the empty index. No source, guard, catalog, capture limit or timeout changed. The in-memory host preserved PATHEXT only for the validator host; the validator's child environment policy remained intact.

| Ordered check | Exact command | Validator-reported native exit |
| --- | --- | --- |
| ac-schemas | `pnpm schemas:check` | 0 |
| ac-types | `pnpm typecheck` | 0 |
| ac-build | `pnpm build` | 0 |
| ac-repository | `pnpm repository:check` | 0 |
| ac-secrets | `pnpm secrets:check` | 0 |
| ac-evals | `pnpm evals:check` | 0 |

The tool session closed with native exit 0. The host receipt is `status: completed`, `exit_code: 0`, `wall_ms: 36578`, with stdout/stderr EOFs true and both truncation flags false; validator stderr is empty. Stdout contains exactly the six ordered `[OK] acceptance <id>: exit 0` markers followed by `[OK] specs: 1 structurally checked; 6 checks executed`. The unchanged per-command allowance is 900 seconds; no aggregate 900-second cap was imposed.

Both captured streams belong to the validator. Its unchanged common helper drains and discards individual child output, so detailed case inventories and child/build warning text are unavailable here; empty validator stderr does not establish their absence. No full-suite result or new cleanup proof is inferred. Owned temporary parents remain retained, and historical fixture-cleanup unknowns remain unchanged.

Execution stopped after this single gate PASS, with only the three evidence records updated. Functional commands, Harness, real API/Vite/browser, pilot preparation, CI, audit, smokes, paid calls, sibling operations, independent process investigation/cleanup, commit, push and merge were not run. The next required stage is the four fixed functional commands under separate authority. This gate alone does not close T008/F2, `DEBT-F2-GLOBAL-900`, Q or CI, or authorize F3.

### Four functional block results - 2026-10-30

After the six-check gate PASS, the owner authorized the four exact commands in stage 2 above, excluding evals. Each ran once, sequentially outside the sandbox in the foreground through the existing in-memory host, with a fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI, and the original 900000-ms wait/owned-tree termination policy. No browser opt-in variable, reporter, filter beyond the approved helper selection, worker override or timeout change was added.

| Procedure | Files passed | Active cases passed | Skipped / filtered | Host wall ms | Vitest duration |
| --- | --- | --- | --- | --- | --- |
| f2-functional-state-http | 3 | 376 | 0 / 0 | 54727 | 53.40 s |
| f2-functional-context-plan | 3 | 72 | 0 / 0 | 104066 | 102.93 s |
| f2-functional-ui | 3 | 209 | 1 / 0 | 11592 | 10.50 s |
| f2-functional-smoke-helpers | 1 | 28 | 0 / 70 | 2325 | 1.27 s |

Every command and foreground tool session exited natively with code 0; all receipts are `passed`, have both stdout/stderr EOFs, empty stderr and no owned-tree termination request. All terminal JSON captures were available and parsed completely. The totals match independent source inventory: **685 active cases passed**, not 756 executions. The first three groups cover all nine complete files, without case-name filtering.

File inventories: issues store 91, issue service 191 and API index 94; context sources 12, context service 31 and workflow API 29; IssuesView 87 active plus one skipped, ContextPreview 16 and WorkflowPanel 106. The explicit IssuesView skip at line 96 requires `SURTEC_ISSUE_OPERATING_BROWSER_SMOKE=1`; that flag and `SURTEC_WORKFLOW_BROWSER_SMOKE` remained absent. Other inline browser opt-in branches were not exercised. The existing separately required real API/browser smoke remains pending; this skip does not supply browser evidence. Helpers ran fourteen read-synchronization and fourteen Issues-refresh cases; the other seventy registered cases were filtered by the approved pattern and are not PASS.

Read-only preflight preserved 107 expected identities and the Git baseline. Post-execution review preserved 111 distinct source/document/protected identities, including the nine test files and helper, with an empty index and T008 still unchecked. Only these three evidence documents changed afterward. HTTP, Git/worktree/verification and teardown within the selected synthetic fixtures are part of the approved tests; they are not publication or commits in this checkout. Passing test teardown is not an independent audit of every fixture removal. Owned temporary parents remain retained and earlier cleanup unknowns remain unchanged.

Execution stopped after the fourth PASS. No eval suite, whole-repository suite, extra focal check, typecheck/build, Harness command, real browser smoke, CI, audit, paid call, pilot/sibling operation, independent process probe/cleanup, commit, push or merge ran in this continuation. No source, guard or timeout changed. Next required checks are separately authorized `pnpm harness:check`, then the isolated real API/browser smoke; the human pilot readiness checkpoint still blocks T008/F2 closure and global debt remains open.

### Harness and browser attempt - 2026-10-30

The owner authorized continuing the remaining acceptance steps without evals. Read-only preflight preserved 108 expected source/protected identities, exact package scripts, HEAD/branch and empty index; the three current evidence documents were fingerprinted separately. Both commands used the same foreground in-memory host outside the sandbox, newly owned qualified external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI, and 900000 ms per command.

1. `pnpm harness:check` **PASS**, native tool/child exit 0, `wall_ms: 5426`, both EOFs, empty stderr and no termination request. Output confirms three snapshots, all ten declared context routes within 500 lines, six specs structurally checked with zero acceptance checks executed, six active task plans and the final Harness structure/snapshots/budgets/contracts marker. This is structural evidence, not another functional or eval run.
2. `pnpm smoke:local:playwright` **FAIL**, native tool/child exit 1, `wall_ms: 15324`, both EOFs and no termination request; the 900-second deadline was not reached. Captured stage: `migrate legacy portfolio profiles in the real browser flow`. The exact error category is `browserType.launch`: Chromium distribution `msedge` was not found at its expected local executable. Call sites are `launchBrowser` at `scripts/playwright-local-app-smoke.ts:377` and `main` at line 902. The machine-specific absolute path is omitted from public evidence. This is an unavailable browser launch, not an observed assertion failure in the F2 browser flow; the capture alone does not establish the earlier browser-selection cause.

No final PASS marker or exact 31-turn confirmation was emitted. Browser-dependent acceptance remains unexecuted/unverified, even though fixture setup had begun. Git emitted LF-to-CRLF warnings for synthetic fixture files; they are not the terminal launch error and do not establish a source-checkout modification. No raw stderr/private payload is copied into this record.

The smoke's finally block emitted `SMOKE_CLEANUP` for synthetic fixture `surtec-local-dashboard-Aud8iZ`: `browser_closed: true`, `vite_closed: true`, `api_stopped: true`, `workspace_removed: true`, `failures: []`, followed by its cleanup confirmation. These are the smoke's callback/removal results, not a separate process audit; a resource not yet created also has a true default closure field. The wrapper's owned TEMP parent remains retained intentionally. Historical timeout-fixture cleanup uncertainty is unchanged.

Execution stopped immediately after this failure, before pilot preparation. Only the three evidence records were updated afterward. No browser/source/process inspection after failure, installation, retry, repair, evals, full suite, CI, audit, extra checks, paid call, sibling operation, independent cleanup, commit, push or merge followed. No guard or timeout changed. Next work requires a bounded read-only browser-resolution diagnosis and a separately authorized smoke retry after the prerequisite is resolved. T008/F2 remains incomplete; pilot technical/human confirmation and global debt remain open, and F3 is not authorized.

### Chromium resolution diagnosis - 2026-10-30

The owner authorized diagnosis and recovery of the original Chromium error, without installation or another smoke. Read-only source/package/cache inspection found Playwright 1.63.0 and Chromium/headless-shell revision 1243. The default `%LOCALAPPDATA%/ms-playwright` cache is absent. With `{ headless: true }` and no channel, Playwright selects `chromium-headless-shell`; `chromium.executablePath()` describes the separate full-Chromium executable and was not used as proof of the headless binary. The smoke's Windows catch at lines 373-377 discards any first Chromium error and returns the Edge launch, which explains the masked message.

One isolated diagnostic invoked only the exact original `chromium.launch({ headless: true })`, without fallback, pages, navigation, API, Vite or smoke import. It used the same unchanged ten-variable environment allowlist plus CI, a new qualified owned TEMP/TMP and the existing foreground host/900000-ms limit. The diagnostic recovered this path-normalized original error:

```text
browserType.launch: Executable doesn't exist at %LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe
```

The diagnostic host/tool exited 0 with both EOFs, empty stderr, 453 ms host wall and no termination. This means the expected error was captured: browser `launched: false`, one launch attempt, zero fallback attempts, zero pages/navigation and closure `not-created`. It is not a successful browser launch or acceptance PASS. Playwright can create temporary artifacts before executable validation; the owned TEMP parent remains retained and no independent cleanup was attempted. Changing TEMP/TMP does not redirect the browser cache when LOCALAPPDATA is preserved.

Read-only checks of six standard executable candidates found Edge under `%ProgramFiles(x86)%/Microsoft/Edge/Application/msedge.exe` and Chrome under `%ProgramFiles%/Google/Chrome/Application/chrome.exe`. Edge was absent from the expected LOCALAPPDATA location. The current host omits PROGRAMFILES and PROGRAMFILES(X86), which Playwright's installed Edge resolver consults. Therefore the earlier fallback error did not establish that Edge is uninstalled; the existing system executable was outside the retained resolution inputs. Executable presence alone does not prove a launch will work.

No source, canonical environment policy, guard, timeout or launcher environment changed; no browser was installed, Edge launched, smoke repeated, eval/check/CI run, pilot inspected or Git publication performed. Proposed next increment: explicitly approve forwarding only the trusted `ProgramFiles(x86)` OS path to the ephemeral browser-validation host, preserve every other boundary, then perform one isolated Edge launch/close qualification. This proposal is not applied or executed. The failed smoke and T008/F2/pilot/global-debt status remain unchanged.

### Managed Chromium and single smoke continuation - 2026-10-30

The owner chose Playwright-managed Chromium without Edge, superseding the earlier no-install boundary for this prerequisite. Read-only preflight preserved 108 expected identities and HEAD/branch/empty index, confirmed installed Playwright 1.63.0 and an absent default browser cache, and recorded the four intended repository target hashes. All commands used the existing foreground host outside the sandbox with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment allowlist plus CI, and 900000 ms per command. PROGRAMFILES variables were not added.

| Ordered operation | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| pnpm exec playwright install chromium --only-shell --no-remove | 0 / 0 | Installed Headless Shell 1243 | 10615 |
| Exact chromium.launch({ headless: true }) and browser.close() | 0 / 0 | Launch and close PASS; version 153.0.8010.12 | 1035 |
| pnpm smoke:local:playwright | 1 / 1 | FAIL in Phase N effect capture | 44300 |

All three receipts have both stdout/stderr EOFs, no owned-tree termination and a completed native foreground session. Installer and qualification stderr are empty. The installer reported a 114.6-MiB Headless Shell download from the official Playwright CDN into its default local cache. Only that download is reported; planned auxiliary targets are not additional observed downloads. `--no-remove` disables global browser GC; no force/system-dependency install, package/lock update, Edge install or other browser selection occurred. The launch probe opened no page or URL, used zero fallback attempts and confirmed its browser close; owned wrapper temporary parents remain retained.

To enforce the owner's browser choice, only the private `launchBrowser` function in `scripts/playwright-local-app-smoke.ts` now directly returns `chromium.launch({ headless: true })`. The Windows catch/Edge fallback was removed. The source identity changed from `retained privately` to `retained privately`; an inverse replacement verified every other byte unchanged at edit time. Assertions, public helpers, stages, fake executor, timeout/cleanup behavior and canonical policies/pins are unchanged. Earlier gate/functional/Harness results precede this launcher-only delta; those commands were not repeated.

Chromium then entered the real smoke flow. The terminal stage was `Phase N no-effect preview, role/source guards and default privacy`, with `Error: Browser API reads did not settle within the effect capture deadline` from the existing tracker timer at source line 108. This is not the old browser-resolution failure or the 900-second supervisor deadline. Stdout also observed Vite optimizing `ajv/dist/2020.js` and reloading; that chronology does not prove a cause. The capture does not identify the pending GET, its server state or an individual request duration. No final PASS/31-turn confirmation appeared; API/browser acceptance remains incomplete.

`SMOKE_BROWSER_READ_CANCELLATIONS` was 0. The finally receipt for fixture `surtec-local-dashboard-4tRaec` reports browser/Vite/API closure and workspace removal all true, `failures: []`, followed by cleanup confirmation. These are the smoke's own awaited closure/removal facts, not an independent process audit. Earlier fixture-cleanup unknowns remain historical; wrapper temporary parents remain retained.

Execution stopped at this first failed command. Only the three evidence documents were updated after failure; no additional source/process/browser inspection, check, retry, guard/timeout change, eval, complete suite, CI, audit, paid runtime, pilot/sibling work, independent cleanup or Git publication followed. The next proposed bounded diagnosis is identifying the pending browser API read and its completion across the observed Vite reload, preserving every assertion and deadline. It is not started. T008/F2, pilot readiness and global debt remain open; F3 is unauthorized.

### Phase N read-only diagnosis - 2026-10-30

The owner authorized diagnosis of the pending API read without changing assertions/timeouts or repeating the smoke. Source and existing-capture inspection completed without launching browser/API/Vite, probes, tests, evals or campaigns. No endpoint can be recovered from the existing receipt: the tracker retains pending Request identities only in memory, emits a generic error and clears them during disposal. No trace/HAR recording is configured in this smoke, and its owned workspace was removed.

The same Phase N stage covers three possible failures in `scripts/playwright-local-app-smoke.ts`: line 1026 (before preview), 1050 (after Node preview/refusal checks) and 1093 (after browser preview/consent checks). All call `effects()` without an argument, so the actual shared observation deadline is 10000 ms, not the 30-second workflow allowance or 900-second command limit. `snapshot` covers pre-capture idle, the filesystem hash and post-capture idle, and repeats when generation changes. The timer at line 108 therefore does not prove that any GET was pending at expiry: hashing or repeated generations can produce the same error.

Static browser candidates are global `/api/overview` and `/api/today` polls every three seconds and `/api/runs` every two seconds; Organization reads `/api/organization` and `/api/operating/overview`; after Overview mounts the form, `/api/dispatch-options`, `/api/projects/:id/client-context-options` and `/api/projects/:id/context/roles` can run. Profile/session reads may also occur on mount/reload. Polls can overlap, but actual pending identity, duration or server state is unobserved. The Node-process fetch calls are outside the BrowserContext tracker. No deliberate long-lived SSE, active held route or circular wait was found in this segment; the intake interception is installed later at line 1168. The Phase N preview does not activate the budget reader, so the old budget incident is not evidence for this failure.

Vite's observed AJV optimization/reload is consistent with a dynamically imported operating-view module, but no causal link or abandoned request is established. Zero counted owned-navigation cancellations does not imply zero pending requests. No source fix, poll suspension, added endpoint exclusion, timeout change or retry is justified by these facts alone.

Proposed next bounded increment, NOT implemented: add error-only evidence for the three closed Phase N boundary labels, active snapshot phase (waiting/capturing/post-wait/recapture), generation/recapture facts and bounded pending-GET route families/counts/omissions, captured at the timeout before disposal. Emit no query/fragment, URL host, headers, token, body or private ID. Keep the pending set, every check/assertion, all timers and the error prefix intact; no new runtime/HTTP/filesystem probe. Scope is the smoke source, its existing helper test file and the three evidence records. Proposed validation is six new diagnostic cases plus the existing fourteen read-synchronization cases using `pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|read diagnostics)" --bail=1`, then typecheck only if all pass. A real smoke still needs separate authority and is not included in this diagnostic-only result.

Only the three evidence documents were updated; no implementation, assertions, guards, timeouts, cache/dependency or user-state change occurred. T008/F2 remains incomplete with the exact endpoint unknown, real-browser acceptance/pilot readiness pending and global debt open. The next increment is a proposal for review, not execution authority.

### Phase N capture implemented and focused validation - 2026-10-30

The owner approved the preceding five-file proposal, preserving existing assertions/timeouts and authorizing only twenty focused tests plus typecheck on success. Implementation adds a deadline-only `SMOKE_READ_DIAGNOSTIC` JSON suffix to the existing error prefix. It is created and memoized at expiry, before tracker disposal. Per-invocation state reports a closed boundary label, snapshot phase, generation/capture/recapture counts, exact pending count, at most eight normalized GET route rows and explicit omissions. Unknown routes/getter failures become `/api/:unknown`; arbitrary labels become `unlabelled`. No URL host, query/fragment, private path ID, headers, token or body is reflected.

The three Phase N calls receive closed labels before invocation, then reset to `unlabelled`. Existing snapshot/idle/failure conditions and timers remain. All 363 existing smoke assertion lines are byte-identical; an inverse transform preserved every unrelated source byte. The original 51435-byte test-file prefix is unchanged; exactly six new cases were appended. No new timer, request, poll suppression, route exclusion, capture allowance, runtime policy or source authority was introduced.

| Approved command | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization\|read diagnostics)" --bail=1 | 0 / 0 | 20 active PASS, 84 filtered skips, one file passed | 3462 |
| pnpm typecheck | 0 / 0 | PASS, tsc --noEmit | 21206 |

Both ran once in order, outside the sandbox in the foreground with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment plus CI and 900000 ms per command. Both have native closed sessions, stdout/stderr EOFs, empty stderr and no termination. Vitest reports 104 registered cases, 20 executed passes and 84 cases excluded by the approved name filter, not 104 executions; duration 1.74 seconds, tests 30 ms. Coverage comprises the existing fourteen synchronization cases plus six new diagnostic cases: pending read, pending capture without reads, generation recapture, closed labels, privacy/capacity and a later-throwing URL accessor. Frozen error evidence after disposal is also verified. Typecheck ran only after the exact focused inventory passed.

| Current changed source | SHA-256 |
| --- | --- |
| scripts/playwright-local-app-smoke.ts | 3b703cacaa534288b23f072b14f802af54f7c83b3a32e2ab12072cec8d0991da |
| scripts/harness-validators.test.ts | 3cf162b2a93f3388b15949ed618b2e5a89ee6ecfd548db6da244f580f0a9fe94 |

The preserved test prefix SHA is `d95cbd10e14d835e13fb374355fb00d895ee51a8c0b1875284c3b3af17a91752`; the prior smoke source SHA is `1f7d61e353a2e9d77de46498619f4b345d3be04d73ab634796a08fc2098be680`. Preflight preserved 106 out-of-scope identities; post-validation review preserved all 111 current identities, HEAD/branch and empty index before updating the three evidence records. The completed checks did not modify unrelated files. Wrapper temporary parents remain retained; no independent cleanup occurred.

Execution stopped after typecheck PASS. No real browser/API/Vite, smoke, evals, whole suite, Harness/CI/audit, install, process probe, paid runtime, pilot/sibling work, independent cleanup, commit, push or merge ran. Synthetic preparation does not identify the actual prior pending endpoint or turn the recorded 44300-ms smoke failure into PASS. T008/F2 remains incomplete; the next proposed separately authorized action is one Chromium-only smoke using this validated capture, preserving all existing limits and stopping at failure/unknown. Pilot readiness and global debt remain open, and F3 is unauthorized.

### Single smoke with validated Phase N capture - 2026-10-30

The owner authorized exactly one `pnpm smoke:local:playwright` invocation with the validated capture, preserving all assertions, guards and timeouts. Read-only preflight matched 108 protected/source identities, including smoke SHA `3b703cacaa534288b23f072b14f802af54f7c83b3a32e2ab12072cec8d0991da` and helper-test SHA `3cf162b2a93f3388b15949ed618b2e5a89ee6ecfd548db6da244f580f0a9fe94`; the three current evidence documents were fingerprinted separately. HEAD/branch and empty index matched. No source or environment policy was changed.

That single foreground invocation ran outside the sandbox with fresh qualified owned external TEMP/TMP, the existing ten-variable environment allowlist plus CI and 900000-ms limit. It returned **FAIL, native tool/child exit 1**, `wall_ms: 45764`, both stdout/stderr EOFs, a closed session and no termination request. The command deadline was not reached.

The recorded stage is `Phase M real API/browser read-only inventory, Doctor and explicit observation refresh`. `AssertionError [ERR_ASSERTION]` at `scripts/playwright-local-app-smoke.ts:1481:12` has operator `strictEqual`, actual `unknown`, expected `healthy`. The reason for that status and its response provenance are not present in this receipt; no further source/API/process inspection was performed. This is a known assertion failure, not an unknown command result or another browser-launch error.

The sequential flow reached Phase M without reproducing the earlier Phase N deadline. No `SMOKE_READ_DIAGNOSTIC` was emitted, so the old pending-read identity and cause remain unresolved; absence of recurrence is not proof of a permanent fix. No final PASS or exact 31-turn confirmation appeared. Git emitted the already observed LF-to-CRLF fixture warnings; no new Vite optimization message was present in this capture, without implying causation or a guarantee about future reloads.

`SMOKE_BROWSER_READ_CANCELLATIONS` was 0. `SMOKE_CLEANUP` for fixture `surtec-local-dashboard-UlBfhU` reports browser/Vite/API closure and workspace removal all true, `failures: []`, followed by the cleanup confirmation. These are the smoke's own awaited lifecycle/removal facts; no independent audit/cleanup ran. Wrapper temporary parents remain retained and historical cleanup uncertainty is unchanged.

Execution stopped at this failed assertion. Only the three evidence records changed afterward; no additional source/hash/process/browser inspection, diagnosis, repair, retry, check, eval, full suite, CI, audit, install, paid runtime, pilot/sibling operation, independent cleanup, commit, push or merge followed. The next proposed bounded review is the Harness response/fixture provenance feeding the exact failed assertion, including its reason fields, while preserving `unknown` as a failure rather than changing the expectation. That review is not started. T008/F2, browser/pilot readiness and global debt remain open; F3 is unauthorized.

### Phase M unknown status: fixture diagnosis - 2026-10-30

The owner authorized reviewing the reason for the latest `unknown` status. Read-only source, registry, file-size and SHA inspection found a sufficient deterministic cause in the current fixture. The failed assertion is `healthyHarness.observation.status` from `GET /api/projects/:id/harness/doctor` at smoke line 1481. Doctor/service return the inspector's observation without rewriting its status.

The seed at smoke lines 827-830 recursively copies all `.agents` into canonical and both profile-project fixtures. That includes `.agents/specs/tasks/phase-p-operational-continuity.tasks.md`, currently **314347 bytes**. `readContained` defaults to **262144 bytes per file**, and `inspectHarness` inventories unpinned additions as well as pinned entries. The read rejection becomes an `unsafe` entry; any such initial entry forces `observation.status: unknown` at inspect line 79. Recognized frontmatter and matching canonical files cannot make that oversized addition healthy. The partial fixture inherits the same issue before its deliberate validator deletion.

The current manifest SHA is `f61aa371c5366a5886887d448328542e692a0446ec30683eaaa846e9cf727a4e`, matching the registry, and all 25 expected-entry hashes match current source. The read-only source inventory counted 36 `.agents` files and found that one file above the per-file boundary. No repinning is indicated. This is a source/fixture reconstruction, not a recovered `unsafe-*` finding from the deleted failed run; that response's details were not captured. The inspector's conservative behavior is correct for a real oversized tree.

Proposed correction, NOT implemented: make the healthy/partial synthetic Harness seeds independent of growing feature histories. Follow the existing reviewed 25-entry plus mandatory route/reference support materialization in `lib/harness/inspect.test.ts:10-63`, rather than recursively copying the working `.agents` tree. Preserve pinned bytes and all required links; leave actual history/source bytes unchanged. Do not filter arbitrary oversize files out of production inspection, increase 256-KiB/128-entry/2-MiB bounds, change `healthy`/`partial` expectations, weaken negative cases or repin. Keep existing real API/browser assertions and explicit later drift/missing-validator scenarios.

The proposed five existing targets are the smoke source, `scripts/harness-validators.test.ts` and these three evidence records. Add focused fixture regressions for curated required-file completeness/pins, exclusion of unselected oversized history with source preservation, and unchanged missing-validator/oversize negative behavior. Proposed validation is the new helper selection plus the complete existing `lib/harness/inspect.test.ts`, then typecheck only on PASS, preserving 900 seconds per command. A real smoke retry remains separately authorized work.

Only the three evidence documents changed in this diagnostic continuation. No inspector invocation, test/check, browser/API/Vite, source repair, assertion/guard/timeout change, install, repin, evals, CI/audit, paid call, pilot/sibling action, cleanup, commit, push or merge ran. The fixture correction and its checks remain a proposal. The recorded smoke FAIL and T008/F2/pilot/global-debt status are unchanged.

### Curated Harness fixture correction validated - 2026-10-30

The owner approved the five-file correction after the read-only diagnosis. The smoke now uses `materializeReviewedHarnessFixture` for canonical and both profile-project destinations instead of recursively copying the working `AGENTS.md`/`.agents`/`docs` trees. It follows the already tested inspection-fixture selection: 25 exact reviewed pins, every context-manifest/routing artifact and first-hop instruction references. Complete selected inputs are validated before any destination files are written, using the same per-file/entry/total bounds. Exclusive writes preserve any pre-existing target file; an I/O failure after writing starts can still leave a partial disposable fixture, not an automatic rollback claim.

Only source preparation changes. Real history remains untouched, unknown real entries are not filtered from production inspection, and no reader limit, manifest/pin, ownership rule, assertion, timer or timeout changed. All 363 existing smoke assertion lines and every unrelated source byte are preserved by the inverse edit. The original 60438-byte test prefix remains exact; five regression cases were appended. An initial in-memory JavaScript patch assembly had a syntax error before any editor/tool mutation; its quoting was corrected within the approved scope before implementation or validation ran.

| Ordered approved command | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness fixture" --bail=1 | 0 / 0 | 5 active PASS; 104 filtered skips | 7811 |
| pnpm exec vitest run lib/harness/inspect.test.ts --bail=1 | 0 / 0 | 15 PASS, complete file, no skips | 12093 |
| pnpm typecheck | 0 / 0 | PASS, tsc --noEmit | 27945 |

Each ran once in order outside the sandbox in the foreground with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment plus CI and 900000 ms per command. All sessions closed natively with both EOFs, empty stderr and no termination. Vitest durations were 6.13 seconds (fixture selection, tests 4.00 s) and 10.53 seconds (inspection file, tests 9.34 s). The helper file registered 109 cases; only five ran in its selection, so the other 104 are not passes. Typecheck ran only after both preceding commands passed.

The new cases prove byte-exact pins and complete required support yield healthy/compatible, unselected oversized source history and its neighbor remain unchanged and uncopied, missing validator remains partial/drift, a genuine oversized target addition remains unsafe/unknown with its bytes retained, and missing support/changed pins reject before destination writes. The unchanged complete inspection file additionally covers the exact 262144/262145-byte boundary with and without the validator. No expected healthy/partial/unknown outcome was relaxed.

| Current changed artifact | SHA-256 |
| --- | --- |
| scripts/playwright-local-app-smoke.ts | 9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59 |
| scripts/harness-validators.test.ts | 1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10 |

Prior smoke SHA was `3b703cacaa534288b23f072b14f802af54f7c83b3a32e2ab12072cec8d0991da`; the unchanged test prefix SHA is `3cf162b2a93f3388b15949ed618b2e5a89ee6ecfd548db6da244f580f0a9fe94`. Preflight preserved 106 out-of-scope identities; final review matched all 111 current identities, HEAD/branch and empty index before evidence updates. The protected Phase P history remains 314347 bytes and its original hash. Tests asserted removal of their owned roots; wrapper temporary parents remain retained without independent cleanup.

Execution stopped after typecheck PASS. Only the two approved code/test files and three evidence records changed. No actual API/Vite/browser, real smoke, evals, complete suite, extra build/Harness/CI/audit, install, paid runtime, pilot/sibling action, independent cleanup, commit, push or merge ran. These are fixture-level results, not a fresh successful Doctor/browser response: the prior 45764-ms smoke remains FAIL until a separately authorized single smoke validates this seed. T008/F2, pilot readiness and global debt remain open; F3 is unauthorized.

### Single smoke with curated Harness fixture - 2026-10-30

The owner authorized exactly one `pnpm smoke:local:playwright` run after the curated fixture's passing regressions/typecheck. Read-only preflight matched 108 protected/source identities, including smoke SHA `9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59` and test SHA `1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10`, plus HEAD/branch/empty index; the three evidence documents were fingerprinted separately. Source, assertions and timeouts were unchanged.

The one foreground invocation ran outside the sandbox with fresh qualified owned external TEMP/TMP, the unchanged ten-variable environment plus CI and 900000 ms. Result: **FAIL, native tool/child exit 1**, `wall_ms: 65514`, both EOFs and a closed session, without termination or reaching the command deadline.

In `Phase M real API/browser read-only inventory, Doctor and explicit observation refresh`, `AssertionError [ERR_ASSERTION]` at smoke line 1549 has actual `unknown`, expected `absent`, operator `strictEqual`. The sequential preceding assertions for healthy status, compatible comparison and partial status passed in this run, so the earlier healthy-fixture failure did not recur. Phase M as a whole is incomplete; the absent-case reason/findings are not in the receipt and were not investigated after failure.

No Phase N timeout, `SMOKE_READ_DIAGNOSTIC`, final PASS or exact 31-turn confirmation was emitted. Zero owned-navigation read cancellations were reported. The familiar synthetic Git LF-to-CRLF warnings were not the terminal assertion. No inference closes the old Phase N cause or the remaining acceptance.

`SMOKE_CLEANUP` for fixture `surtec-local-dashboard-Osh3WF` reports browser/Vite/API closure and workspace removal all true, `failures: []`, followed by removal confirmation. These are the smoke's own awaited lifecycle facts. Wrapper TEMP parents remain retained and historical cleanup unknowns are unchanged; no independent cleanup/audit ran.

Execution stopped at the first failed assertion. Only the three evidence documents changed afterward; no additional source/hash/API/process/browser inspection, diagnosis, repair, retry, tests, evals, whole suite, CI/audit, install, paid call, pilot/sibling operation, independent cleanup, checkout commit, push or merge followed. Proposed next work is bounded review of the absent fixture's contents/response provenance while preserving the `absent` expectation and all limits; that review is not started. T008/F2, browser/pilot readiness and global debt remain open; F3 is unauthorized.

### Absent-case fixture diagnosis - 2026-10-30

The owner authorized reviewing the absent fixture without assertion/timeout changes or another smoke. Read-only source tracing confirms the query at smoke line 1548 still uses `issueProjectId`. F2 now seeds that project at lines 909-927 with a Factory `AGENTS.md` carrying `role: session-primer`, policies, ROUTING and a structured context manifest. No `.agents/AGENTS.md` artifact registry is installed there. It is therefore no longer a no-Harness fixture.

The exact inspector branch is deterministic: primer/instruction presence makes `installed` true; missing artifact registry makes the H1-H4 layout unrecognized; present ROUTING selects `unknown` rather than `absent` at `lib/harness/inspect.ts:75-77`, with `unsupported-format`. The observation retains unknown comparison/null detected version and is returned directly by the service/API. Valid Factory context and unrecognized H1-H4 inspection can coexist; neither reader needs weakening. This is source reconstruction, not recovery of the removed run's original findings.

The existing `workflowProjectId` is a suitable explicit absent input at this point: before Phase M it has only its initialized Git repository, `docs/smoke-context.md`, verifier and baseline. The curated Harness copy excludes it, and Factory files are written only to the issue project. Its role campaign starts later at line 1598. The Harness GET has no source mutation, saved-observation write or dispatch effect, so reading that project does not change its later workflow baseline, permissions or 31-turn contract.

Proposed five-file correction, NOT implemented: change only the absent query's project argument from `issueProjectId` to `workflowProjectId`, document the fixture role, and keep the existing `absent` assertion unchanged. Add two focused cases in `scripts/harness-validators.test.ts`: minimal Factory without artifact registry remains unknown/unsupported, while a project with docs/verifier but no instructions remains absent; both retain exact source bytes and do not backfill files. The other targets are these three evidence records. Proposed checks are `pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness absence" --bail=1`, then typecheck only on PASS, with existing limits. No new project, registry/pin, permission, reader, fake turn or smoke run is proposed automatically.

Only the three evidence documents changed in this diagnostic continuation. No source fix, inspector/test/check, browser/API/Vite/process probe, assertion/guard/timeout change, install, evals, CI/audit, paid call, pilot/sibling action, cleanup, commit, push or merge ran. The last smoke remains FAIL, the correction is a proposal and T008/F2/pilot/global-debt status remains open.

### Absent-fixture query correction validated - 2026-10-30

The owner approved the five-file correction and exactly two focal regressions plus typecheck on PASS, stopping on failure/unknown without smoke/evals/CI/publication. Only the absent query's project argument changed from `issueProjectId` to `workflowProjectId`, with a comment explaining the pre-campaign fixture role. The existing `absent` assertion and all 363 smoke assertion lines remain exact. An inverse edit restores every other source byte. No new repository, runtime permission, reader behavior, pin, fake turn, guard or timeout was introduced; Factory instructions remain intact.

| Approved command | Native tool/child exit | Result | Host wall ms |
| --- | --- | --- | --- |
| pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke Harness absence" --bail=1 | 0 / 0 | 2 PASS; 109 filtered skips | 3943 |
| pnpm typecheck | 0 / 0 | PASS, tsc --noEmit | 26641 |

Both ran once in order in the foreground outside the sandbox with qualified owned external TEMP/TMP, the unchanged ten-variable environment plus CI and 900000 ms per command. Both native sessions closed with stdout/stderr EOFs, empty stderr and no termination. Vitest reports 111 registered cases but only two active executions, duration 2.43 seconds and tests 253 ms; the 109 filtered cases are not passes. Typecheck ran only after the exact focused inventory passed.

The regressions preserve the semantic distinction: minimal Factory instructions without an artifact registry remain unknown/unsupported, with unknown comparison and no detected version/backfill; documents and a verifier without AGENTS/.agents remain absent. Both retain exact source-tree bytes. They invoke only the read-only inspector against synthetic roots; no verifier, API, browser or agent executes. The original 68580-byte test prefix is unchanged.

| Changed artifact | SHA-256 |
| --- | --- |
| scripts/playwright-local-app-smoke.ts | 52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a |
| scripts/harness-validators.test.ts | 9f9f59285714e9cba6ddc9f339915b6672c567ed80308cade54be554da879d7c |

Prior smoke SHA is `9ef27d8ec88fa064baa9f5ab6bf43ee3d44782a1ecd31834f5299a5834af7d59`; preserved test-prefix SHA is `1e8124cf067e26249ae11e987a1be1b1e53bd315a000e6d2741c0f11650f2f10`. Preflight preserved 106 outside identities; final review matched all 111 current identities, protected history, HEAD/branch and empty index before evidence updates. Tests assert removal of their owned roots; wrapper TEMP parents remain retained without an independent cleanup audit.

Execution stopped after typecheck PASS. Only the two approved source/test files and three evidence records changed. No real smoke/API/Vite/browser, evals, whole suite, extra focal/build/Harness/CI/audit, install, paid runtime, pilot/sibling work, independent cleanup, checkout commit, push or merge ran. These are correction-preparation results: the last 65514-ms real smoke remains FAIL until a separately authorized single run validates the corrected absent query. T008/F2, browser/pilot readiness and global debt remain open; F3 is unauthorized.

### Single smoke after absent-query correction - 2026-10-30

The owner authorized exactly one `pnpm smoke:local:playwright` invocation after the two absence regressions/typecheck passed, preserving assertions/timeouts and the 900-second limit. Read-only preflight matched 108 protected/source identities, including source SHA `52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a` and helper-test SHA `9f9f59285714e9cba6ddc9f339915b6672c567ed80308cade54be554da879d7c`, plus HEAD/branch/empty index. The three evidence documents were fingerprinted separately. No source or execution boundary changed.

The single Chromium-only run used the existing foreground host outside the sandbox, qualified owned external TEMP/TMP, unchanged ten-variable environment plus CI and 900000 ms. Result: **FAIL, native tool/child exit 1**, `wall_ms: 254343`, both stdout/stderr EOFs, closed session and no termination. The 900-second command deadline was not reached.

Phase M completed sequentially before the workflow campaign started, so the healthy/partial/absent fixture checks no longer blocked this run. The recorded last stage label is `T013 implementation: risk-acknowledgement human gate`; the terminal error is a later `locator.waitFor` timeout after 30000 ms waiting for the implementation issue card's `.work-issue-status` to display `ready-for-review`. Stack: `open` line 592, `refresh` 648, `approve` 667, `workflowCampaign` 740 and `main` 1599. The stage label alone does not prove a failed risk decision; the following captured workflow facts are more advanced.

| Captured synthetic template | Status | Current stage | Tasks / attempts | Runtime ms | Reported tokens | Accounting complete | Blocked reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| analysis | completed | null | 1 / 1 | 2927 | 3 | true | null |
| operations-investigation | completed | null | 1 / 1 | 2656 | 3 | true | null |
| implementation | waiting-human | qa | 4 / 4 | 41208 | 12 | true | null |

These are the smoke's bounded `SYNTHETIC_WORKFLOW_FACTS`, not paid-model usage or a full role-result inventory. The capture lacks the actual issue status, candidate/decision details and rendered DOM at failure, so it cannot distinguish an application-state discrepancy from a stale/different UI observation. Waiting-human at QA does not by itself prove ready-for-review, successful final acceptance or the cause of the missing locator. No post-failure source/API/browser inspection was performed.

No Phase N read diagnostic, final PASS or exact 31-turn confirmation appeared. Owned-navigation read cancellations were 0. Cleanup for fixture `surtec-local-dashboard-1DN9zM` reports browser/Vite/API closure and workspace removal all true, `failures: []`, followed by removal confirmation. These are the smoke's own awaited lifecycle facts; wrapper TEMP parents remain retained, with historical cleanup unknowns unchanged and no independent audit/cleanup.

Execution stopped at this failed locator. Only the three evidence records changed afterward; no new inspection/diagnosis, repair, retry, checks/evals/full-suite/CI/audit, install, paid runtime, pilot/sibling action, independent cleanup, checkout commit, push or merge followed. Proposed next bounded review is the implementation issue's expected status binding across QA/human gates and the UI refresh/open sequence, keeping every assertion and deadline. It is not started. T008/F2, browser/pilot readiness and global debt remain open; F3 is unauthorized.

### QA/ready-for-review wait: selector diagnosis - 2026-10-30

The owner authorized reviewing issue state after QA and the UI wait without assertion/timeout changes or another smoke. Read-only source/log correlation identifies a deterministic selector mismatch. At smoke line 592, `open()` waits for canonical `fresh.status` as exact text inside `.work-issue-status`. IssuesView lines 143-145/487 render six primary statuses as translated labels: ready-for-review becomes `Listo para revisión`. The canonical value is in the BEM class `work-issue-status--ready-for-review` and a sibling badge, not the selected span's text. The existing UI test at line 283 explicitly covers all six translations and the three unlocalized statuses.

The failed locator contains `^ready-for-review$` because it was constructed from the selected refreshed API issue's `fresh.status`. This recovers the status used by the wait indirectly from the error and code, although the raw issue/DOM response was not retained. Even a correctly refreshed ready-for-review card cannot satisfy that exact-text predicate. No claim is made about an actual captured DOM image or every later concurrent state.

Backend review is consistent with that status: workflow-orchestrator lines 312-323 obtain/mark the candidate ready and require issue ready-for-review before requesting the risk/candidate human gate. Issue-service line 823 and review-evidence enforce the current candidate, verification and required reviewer/QA receipts before this transition. The workflow then waits for a human independently of the issue label; ready-for-review is not done. An existing orchestrator regression covers QA completion, receipts and this issue state. No backend transition defect is established by the receipt.

UI refresh also exists: IssuesView gathers the five parent GETs and applies the current generation; WorkflowPanel refreshes the parent on changed revision and awaits it after decisions. No further impossible refresh path was found. Timing races remain possible in general, but they are not needed to explain the invalid text selector and do not justify another timeout or delay.

Proposed correction, NOT implemented: change only the wait to the same card's exact canonical status class, `.work-issue-status--` plus the validated `fresh.status`. Retain state equality, identity/project/revision bindings, existing assertions, default 30-second locator wait and all human gates; do not change Spanish UI labels or runtime state transitions. Scope is four existing files: smoke source and the three evidence records. No mirrored selector test or new dependency is needed; use the existing nine IssuesView lifecycle-label cases plus fourteen Issues-refresh helper cases, then conditional typecheck. Proposed focal command:

```text
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx scripts/harness-validators.test.ts --testNamePattern="projects .* without changing its authoritative lifecycle|isolated browser smoke Issues refresh" --bail=1
```

That proposal selects 23 active cases with no browser opt-in, followed by `pnpm typecheck` only on PASS. No smoke is included automatically. Only the three evidence documents changed during diagnosis; no source repair, test/check, browser/API/Vite/probe, assertion/guard/timeout change, evals, CI/audit, install, paid call, pilot/sibling action, cleanup or Git publication ran. T008/F2 remains incomplete with the last real smoke FAIL, pilot readiness and global debt open.

### Canonical issue-status selector validated - 2026-10-30

Following explicit owner approval, the four-file increment corrected only open()'s one wait selector: the exact canonical `.work-issue-status--${fresh.status}` class replaces a text comparison against a deliberately translated span. The same card, refreshed expected state, issue/project/revision bindings, 363 byte-identical assertion lines and existing waitFor() options/30000-ms timeout remain. No UI or test file changed. A literal inverse of the selector edit restores all other source bytes.

The existing focused command and its conditional successor ran once in order:

```text
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx scripts/harness-validators.test.ts --testNamePattern="projects .* without changing its authoritative lifecycle|isolated browser smoke Issues refresh" --bail=1
pnpm typecheck
```

| Check | Observed result | Host wall ms |
| --- | --- | --- |
| Existing focused cases | 23 PASS: nine UI lifecycle labels and fourteen refresh/binding helpers; two files, 176 other cases not executed out of 199 registered | 7723 |
| Conditional typecheck | PASS, tsc --noEmit | 30567 |

Each tool/child exit was native 0 with a closed session, both streams at EOF, empty stderr and no termination. Commands used the unchanged foreground host outside the sandbox, fresh qualified owned external TEMP/TMP, original environment allowlist and 900000 ms per command. Vitest reports 6.19 seconds total/tests 454 ms. Browser opt-in remained disabled. The focused cases validate existing label and binding contracts, not the private browser wait or complete smoke.

The first authoring verifier rejected replacement-string interpolation before any source write or test; literal callbacks corrected the packaging and preserved the exact inverse check. Current smoke SHA is `9bf66c7f17ede3e0698266db6063a6f9a1e9638b2c1a4e0785a57912e3265486` (prior `52df2ef59a86c8f8c821bdb8953e10bdee176b077052ac077b8161853ee17d4a`). Post-check read-only review preserved all 107 out-of-scope identities and matched all 111 expected identities, HEAD/branch and empty index before evidence updates. Independent source review found no blocker. Wrapper TEMP parents remain retained; no independent cleanup audit is inferred.

Only the selector and three evidence records changed. No smoke, actual API/Vite/browser, eval/full-suite/CI/audit, extra product check, install, paid runtime, pilot/sibling operation, independent cleanup, checkout commit, push or merge ran. The last real smoke is still the recorded FAIL, not retroactively PASS. Next proposed work is one separately authorized unchanged smoke, requiring native success, exactly 31 fake turns and its awaited owned cleanup. Browser acceptance, the human pilot checkpoint, T008/F2 and global debt remain open; F3 is unauthorized.

### Single smoke after canonical selector correction - 2026-10-30

The owner authorized exactly one smoke with the validated selector, 900 seconds and stop-on-failure/unknown, without assertion/timeout changes, evals, CI or Git publication. Preflight matched 111 expected identities, smoke SHA `9bf66c7f17ede3e0698266db6063a6f9a1e9638b2c1a4e0785a57912e3265486`, HEAD/branch and empty index. No source or guard changed.

```text
pnpm smoke:local:playwright
```

The foreground command ran once outside the sandbox with Chromium, the real isolated loopback API/Vite, fake execution, fresh qualified owned external TEMP/TMP and the unchanged purpose-specific environment. Result: **FAIL**, native tool/child exit 1, closed session, both EOFs, 851442 ms host wall and no termination. The 900000-ms command limit was not reached.

The previous ready-for-review wait no longer stopped the flow: the corresponding implementation workflow is captured completed, followed by completed correction and progress into repeat-correction. The last stage is `T013 repeat-correction: one consumed allowance and exact second-correction refusal`. The terminal error is `Browser API reads did not settle within the effect capture deadline`, from deadlineError at smoke line 129 and the timer at line 141.

| Existing diagnostic field | Captured value |
| --- | --- |
| schema_version / label / phase | 1 / unlabelled / drain |
| generation_at_capture / captures_started / recaptures | null / 0 / 0 |
| pending_count / omitted_pending / generation_now | 2 / 0 / 2055 |
| Pending reads | GET /api/runs; GET /api/today |

These requests were outstanding at expiry; their underlying delay and the exact capture caller remain unknown. No new inspection ran. This is not proof of a correction-budget defect or that every refusal assertion passed. The repeat-correction workflow is needs-decision/current stage qa, with seven tasks/attempts, accounting complete and the recorded single-correction/budget-exhaustion reason. Earlier analysis, operations, implementation, quality-review and correction workflows are captured completed; trivial-change is cancelled by the human-stop scenario. No final PASS or exactly-31-turn confirmation was emitted. Synthetic line-ending warnings are recorded without causal attribution.

The smoke reports zero owned-navigation read cancellations. After failure, `SMOKE_CLEANUP` for `surtec-local-dashboard-Enb5NZ` reports browser/Vite/API closure and workspace removal all true, failures empty, followed by removal confirmation. This is its own awaited cleanup result; it does not turn functional FAIL into PASS or independently audit processes. Wrapper TEMP parents remain retained and historical cleanup uncertainty is unchanged.

Only three evidence records were updated from the captured result. No further source/API/browser/process inspection, repair/retry, tests/typecheck/Harness/evals/full suite/CI/audit, installation, paid call, pilot/sibling work, independent cleanup or Git publication followed. Proposed next work is bounded review of repeat-correction read synchronization, not yet authorized or started. Browser acceptance, the human pilot checkpoint and T008/F2 remain incomplete; global debt stays open and F3 remains unauthorized.

### Bounded read-activity preparation - 2026-10-30

The owner approved the proposed capture adjustment. Static diagnosis identifies the failing call as repeat-correction refresh -> open -> input.drainReads(), supplied with the existing 30000-ms workflow bound. It is not the snapshot/hash path or default 10000-ms read bound. The preceding needs-decision, one-correction and exhausted-reason assertions were reached; later visual/lineage checks were not. Always-active overlapping polling and synchronous work in the shared API/worker are possible delay mechanisms, not measured causes.

The smoke preserves its legacy SMOKE_READ_DIAGNOSTIC byte format and all 363 existing assertion lines. A separate SMOKE_READ_ACTIVITY receipt is frozen at that same expiry and emitted only when the caught error matches, before facts/cleanup. It records elapsed/configured time, pending-at-start/end, start/finish/failure deltas inside the window and up to eight normalized pending GETs with process-local sequence, age and in-window origin. Completed-request history is not retained. The clock is observational: faulty or observed backwards measurements become null without changing scheduling, deadlines, idle rules or failures. Error-specific weak associations and deep freeze preserve simultaneous-window and post-disposal evidence. URL hosts, query/fragment/user information, private IDs, headers and bodies are excluded.

```text
pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|read diagnostics|read activity)" --bail=1
pnpm typecheck
```

The first command passed 28 active cases (20 existing, eight new) in one file, with 91 other cases not executed out of 119 registered; host wall 7391 ms, Vitest total 4.51 seconds/tests 113 ms. Conditional typecheck then passed in 31068 ms. Both ran once with native tool/child exit 0, closed sessions, both EOFs, empty stderr and no termination, outside the sandbox in the existing foreground host with fresh qualified owned external TEMP/TMP and the unchanged 900000-ms limit. These are synthetic helper tests, not real browser acceptance.

The eight additions distinguish old reads from continuous finite replacements, preserve 10/30-second limits, enforce row bounds/privacy and frozen/error-specific evidence, reject stale attribution after transport failure, exercise invalid/backwards clocks and verify concurrent windows. Every byte of the original 71695-byte test prefix remains unchanged. Independent source review found no blocker; final review preserved all 111 expected identities, 106 outside scope and the Git baseline before evidence writes.

Current source SHA is `915860c579a3a9d20b7deb7519f9e130f794fa51d011ac7fe98c339b7d3a44e7`; test SHA is `10a8756463b52d74795bc0f3f92f0adce95a1a56f02943fa581f5709362bdc2e`. Only those two files and three evidence records changed. No smoke, real API/Vite/browser, eval/full suite, CI, audit, install, paid call, pilot/sibling work, process investigation/cleanup or Git publication ran. Wrapper TEMP parents remain retained. The last real smoke FAIL and its reported cleanup remain historical facts; no new activity receipt proves its cause yet. A separately authorized single smoke is the next proposed execution; T008/F2, the human checkpoint and global debt remain open, with F3 unauthorized.

### Single read-activity smoke - 2026-10-30

The owner authorized one real smoke with the validated activity instrumentation and the original 900-second boundary. Preflight matched 111 expected identities and the Git baseline. Exactly one `pnpm smoke:local:playwright` ran outside the sandbox, in the foreground with fresh qualified owned external TEMP/TMP, Chromium, isolated API/Vite and fake execution. Result: **FAIL**, native tool/child exit 1, both EOFs, closed session, 899500 ms wall and no termination. The outer 900000-ms limit was not reached.

The same T013 repeat-correction stage stopped at browser-read drain expiry. Its separately frozen activity now provides actual turnover evidence: configured 30000 ms, observed 30007 ms, 171 pending at entry, 39 started, 206 finished and zero failed inside the window, four pending at expiry, no omitted rows. Balance: 171 + 39 - 206 = 4.

| Pending GET at expiry | Local sequence | Age ms | New inside window |
| --- | --- | --- | --- |
| /api/runs | 2084 | 7536 | true |
| /api/runs | 2085 | 5545 | true |
| /api/runs | 2088 | 3532 | true |
| /api/runs | 2091 | 1538 | true |

All initial pending reads cleared, while new requests continued arriving. The four ending Runs requests overlap with approximately two-second start spacing, matching the known global polling interval. The drain failed to observe its required idle point. The initial routes and the origin of server/proxy/browser delay remain unknown; finished events do not assert HTTP 2xx. This supports a bounded anti-overlap correction proposal without proving it sufficient for final acceptance.

The legacy diagnostic is unchanged and consistent: drain, captures_started/recaptures zero, generation_at_capture null, generation_now 2091 and four pending /api/runs rows. No filesystem capture began and no final PASS/31-turn confirmation was emitted. Prior implementation and correction workflows are captured completed; repeat-correction remains needs-decision/qa with the exhausted correction/budget reason. Full visual/refusal/lineage/restart acceptance is not inferred from those partial facts.

The smoke reports zero owned-navigation read cancellations and, after failure, complete browser/Vite/API closure and removal of fixture `surtec-local-dashboard-taPNPq`, all true with failures empty and removal confirmation. These are its own awaited cleanup facts; wrapper TEMP parents remain retained and earlier cleanup unknowns stay unchanged.

Only the three evidence records changed after the captured failure. No further inspection, repair/retry, product checks/evals/CI/audit, paid call, pilot/sibling work, independent cleanup or Git publication followed. Proposed next work is preventing overlapping polling with lifecycle regressions while preserving deadlines and existing acceptance assertions; it requires separate implementation authority. T008/F2, browser acceptance, human pilot readiness and global debt remain open; F3 remains unauthorized.

### Polling overlap correction prepared - 2026-10-30

Following owner approval, the three global pollers share a small per-instance pending-read mechanism in usePolling.ts. Automatic ticks do not start or queue another read while fetch/JSON is pending. Overview/Today/Runs keep their existing 3000/3000/2000-ms intervals and public response shapes. Promise identity governs release; last good data survives error. Effect replay, interval changes and StrictMode retain ownership, while mounted/reader identity guards publication. Cleanup stops ticks without cancelling an in-flight read.

Today.refresh preserves post-action freshness: it waits for prior reads to settle, rechecks the slot and starts its own later GET. Previous failure does not refuse that fresh request, while the fresh request's failure still propagates. Concurrent manual callers serialize; an unmounted waiting caller starts no deferred GET. No HTTP timeout, abortion policy, existing assertion, state/agent runtime contract or permission changed.

```text
pnpm exec vitest run dashboard/src/ui/polling.test.tsx dashboard/src/ui/App.test.tsx --bail=1
pnpm typecheck
```

The focused command passed 80 active cases across two complete files: 22 new regressions and 58 existing App cases, with only the two original browser opt-ins skipped (82 registered). Host wall: 9122 ms; Vitest: 8.01 seconds total, tests 4.38 seconds. Conditional typecheck then passed in 16464 ms. Each tool/child exit was native 0, session closed, both EOFs, empty stderr and no termination. The unchanged foreground host ran outside the sandbox with fresh qualified owned external TEMP/TMP and 900000 ms per command.

The additions cover deferred headers/JSON, fixed cadence, no overlap, errors/last good data/recovery, interval changes, unmount, StrictMode, independent instances and fresh serialized Today refreshes. All existing test bytes are unchanged, including the complete App file and smoke helpers. Operating/workflow browser flags remained absent, so neither opt-in is real-browser evidence. Independent code review found no blocker. Post-check review preserved 114 expected identities, 107 outside scope, HEAD/branch and empty index before these records were updated.

Only api.ts, useRuns.ts, the new usePolling.ts and polling.test.tsx, and three evidence records changed. The smoke remains SHA915860c579a3a9d20b7deb7519f9e130f794fa51d011ac7fe98c339b7d3a44e7, with all 363 assertions and its diagnostic capture intact. No real API/Vite/browser or smoke, eval/full suite, CI, audit, build/Harness rerun, paid call, installation, pilot/sibling work, process probe/cleanup or Git publication ran. Wrapper TEMP parents remain retained.

This is targeted polling-regression/typecheck PASS, not complete F2 acceptance or proof that backend response delays disappeared. The last actual smoke FAIL at 899500 ms is preserved with its reported cleanup. One separately authorized smoke is the next proposed validation. T008/F2, browser acceptance, human pilot readiness and global debt remain open; F3 is unauthorized.

### Single smoke after polling correction - PASS, 2026-10-30

The owner authorized exactly one unchanged 900-second smoke with the polling repair. Preflight preserved 114 expected identities and Git baseline; the smoke source and all 363 existing assertions remained unchanged.

```text
pnpm smoke:local:playwright
```

The command ran once in the foreground outside the sandbox, using managed Chromium, the actual isolated loopback API/Vite, fake execution and fresh qualified owned external TEMP/TMP under the original environment and 900000-ms ceiling. Result: **PASS**, native tool/child exit 0, host status passed, closed session, both EOFs, 670440 ms wall and no termination. Stderr has eleven synthetic Git LF-to-CRLF warnings, not a failure.

The complete stage sequence passes repeat-correction, held-role stop and pending-plan restart. Exactly one final PASS confirms five templates; exact Planner/risk/criteria gates; candidate-only Reviewer/QA and receipts; bounded correction/second refusal; stale/budget/tree and task-ownership guards; responsive evidence; stop/restart/no replay/session rotation; preserved K-N and F2 assertions; and exactly 31 synthetic turns (four v1 plus 27 workflow), without paid runtime/provider writes.

Only after that marker, the smoke emits zero owned-navigation read cancellations and SMOKE_CLEANUP for `surtec-local-dashboard-ECRkLR`: browser_closed, vite_closed, api_stopped and workspace_removed all true, failures empty. The removal confirmation follows. Thus functional success and relevant owned closure are both recorded with native completion. These are its own awaited lifecycle facts; wrapper TEMP parents remain retained and historical cleanup uncertainty is not erased.

Neither SMOKE_READ_ACTIVITY nor the legacy read-deadline diagnostic appeared. This run completed the previously failing flow with the polling repair; it does not establish per-handler latency or a performance guarantee. Independent terminal review confirms the PASS classification. Read-only post-run audit preserved all 114 expected identities, HEAD/branch and empty index before evidence updates.

Only three evidence records changed. No further test campaign, smoke retry, typecheck/build/Harness/evals/full suite/CI/audit, install, paid call, private pilot/sibling operation, process probe/independent cleanup or Git publication followed. All assertions, guards and timeouts remain unchanged.

Current disposition: **functional automated verification complete; human pilot preparation/confirmation pending**. Keep T008 unchecked/F2 in progress until the selected private pilot's exact technical baseline, criteria, permitted/excluded scope, contained sources, trusted verification commands and approver are confirmed. Private technical preparation requires separate scope/authority. Global debt stays open; this does not certify CI/Q/the original gate, activate P or authorize F3.

## Prior procedure and evidence (historical)

The prior runbook body below is preserved verbatim. Its old seven-check instructions and earlier continuation permissions are historical; the current procedure and current explicit user instruction govern new work.

Status: F2 is `in_progress`. T001-T006 have focused evidence and T007 documentary checks passed. Isolated correction passed 2/2; the latest original gate still timed out in `pnpm test` at 901630 ms outer wall. The subsequent authorized full-suite attribution also reached its 900000-ms deadline: 150 modules passed, 6546 cases passed, zero failures observed and workflows still pending. Complete coverage/native suite exit/EOF were not observed. Earlier outcomes remain historical. Harness, actual F2 browser smoke and private-pilot technical/human readiness remain pending. This document does not certify F2 acceptance or F3 authority.

Authority comes from the owner's current continuation. The [approved design](../architecture/factory-request-contract-design.md), [specification](../../.agents/specs/factory-request-contract.spec.yaml), [ordered task plan](../../.agents/specs/tasks/factory-request-contract.tasks.md) and [active roadmap](../roadmap/factory-local-poc.md) define the boundary. The current continuation authorizes only documenting the unchanged observer plan and one `full-suite-attribution` diagnostic with 900 seconds, stopping after failure/unknown or completion without a successor. Earlier implementation/check permissions are historical, not standing authority for more work. No code/guard/timeout change, repeated synthetic/focal/typecheck, gate, CI, smoke, extra cleanup, commit, push or merge is included.

## Current attribution-observer boundary - 2026-10-26

The approved increment contains exactly eight files: existing local `core.mjs`, `runner.mjs`, `synthetics.mjs` and `launch.ps1`, new `reporter.mjs`, and the three T008 evidence documents (this runbook, the task plan and active roadmap). The five ignored artifacts live under `node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/`; they are not part of a published checkout. The rejected documentary context patch changed none of these files or results. The owner explicitly authorized correcting that context and resuming the same synthetic-only increment.

The closed `full-suite-attribution` mode supplements the four focal modes. A minimal reporter observes public Vitest run, module and case events without changing tests or their hooks. It supplies validated relative file/line locations, opaque identities, closed statuses and numeric timing facts, not arbitrary titles, private errors, payloads or environment values. The projector reserves bounded evidence for slow completed cases/files and pending cases/modules. Invalid or lost events and saturation remain explicit partial/unknown coverage; an observation cannot invent a passing result.

Node data/progress/exit/EOF milestones and PowerShell guarded-wait/termination/closure milestones remain separate clock domains. A case-ready/result interval includes hooks; an open module does not identify a specific hook, collection gap does not prove a blocked import, and concurrent duration sums are not wall time or CPU. Reporter callbacks have observation overhead. This is bounded operational observation, without hook instrumentation, CPU/heap profiling, extra timers or process queries.

Any future real invocation would be fixed to `pnpm test --reporter=verbose --reporter=<derived ephemeral reporter path> --includeTaskLocation`, with no filter or worker/timeout override. **That invocation is NOT AUTHORIZED by this increment.** The synthetic-only execution has completed; this documentary continuation permits no further check. The 900000-ms deadline, 32-KiB visible and 32-KiB retained capture limits, 8192-byte line limit, continued draining, environment/temporary-ownership guards and process-termination behavior remain intact. No product/runtime, package/Vitest configuration, canonical Harness script/catalog/pin or original acceptance command is in the write scope.

Synthetic-only validation completed in one foreground invocation outside the sandbox: **75/75 checks PASS, native exit 0**, using `pwsh -NoProfile -File node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/launch.ps1 -SyntheticChecks`. The supervisor reported `status: completed`, `mode: synthetic`, `acceptance: false`, `deadline_ms: 900000`, `exit_code: 0` and `wall_ms: 1413`; its separate final timing was 1430 ms, with no termination requested. All 53 earlier checks were retained with the approved closed-mode adaptations, plus 22 new checks. Coverage includes interleaved modules/cases, incomplete or inconsistent lifecycle/EOF/terminal evidence, invalid timing/events, bounded rankings/overflow, fragmented UTF-8/saturation, privacy getters, inert imports and preservation of the existing focal/environment/ownership/guard contracts. Negative fixtures deliberately model failure/unknown/timeout; every check itself passed. No real suite, gate, CI, smoke, real fixture-filesystem/process probe or cleanup ran.

The first attempt to record this successful result failed while packaging the patch in memory, before the editor was invoked; no documentary update or repeat check followed that failure. The owner separately authorized correcting only that packaging and updating the three evidence documents. This documentary continuation reruns no check and grants no real-execution authority.

This increment does not alter the original gate timeout, certify fixture cleanup or establish acceptance. F2 stays `in_progress` and T008 unchecked pending the original complete seven-check gate, separate Harness/browser evidence and the private-pilot technical/human checkpoint. P/Q historical results and F3 authority remain unchanged.

## Bounded follow-up implementation - 2026-10-27

The preceding single real diagnostic reached 900000 ms without a run-end or native suite exit. Its complete diagnostic receipt observed 151 modules, 150 closed and one pending; 6552 cases finished (6529 passed, nine failed, fourteen skipped), with one open correction case in the then-current workflow fixture line 897. That case had about 51.21 seconds of observed age under its unchanged 90-second test timeout. The module had about 327.18 seconds of observed execution; collection/CPU/hooks were not individually attributed. The supervisor finished at 900070 ms after terminating only its owned tree; fixture cleanup stayed unknown. This does not replace the failed original gate or establish all error messages.

The owner subsequently approved twelve files: architecture formatting, three workflow test fixtures, historical diagnostic test references, four existing local capture/launcher/synthetic artifacts, and these three evidence documents. Architecture removes 22 blank lines only, retaining all nonblank content and required reads; the formerly overflowing routes become 487/500 and 500/500. Portable historical wording is restored in the core task record. Service/API fixtures reuse only immutable public bytes with independent exclusive-created files, and four added regression cases remain NOT RUN. Four same-checkpoint duplicate reads are consolidated without sharing authority across effects. The case-897 real seven-stage flow, every existing assertion, polling and all deadlines remain.

Five literal integrity-reference updates in `scripts/profile-maintenance.test.ts` are explicitly included: two fixture hashes and three chained prefix hashes. The [task record](../../.agents/specs/tasks/factory-request-contract.tasks.md) preserves old/new values. Byte lengths, the original prefix, assertion logic and six independent runtime pins remain unchanged. The existing reporter is unchanged; eight closed focal modes and reserved same-stream private-safe error evidence prepare later inspection of the remaining failures. Capture limits, default full-suite command, environment/ownership and wait/termination behavior are unchanged.

Synthetic execution result: **FAILED / INCOMPLETE**. One foreground `-SyntheticChecks` invocation returned native exit 1: **88 passed, one failed, one NOT RUN, out of 90**. Check 89, `preserves all nonblank architecture bytes and the original declared context budget`, failed before the final historical-reference audit could run. This combined check also covers route counts and portable task wording; its exact failing predicate or error class is unknown because the driver discards stderr. The earlier 75 checks and thirteen added focal/capture checks passed, including protected source hashes and the unchanged reporter. Supervisor mode was `synthetic`, `acceptance: false`, deadline 900000 ms, wall 2799 ms and final timing 2819 ms, with no termination requested. The process completed; this was not a 900-second timeout.

Execution stopped without rerunning the matrix, repairing source, typecheck, focal product tests, suite/gate, CI, smokes, probes/cleanup or Git effects. Only the three evidence records were updated. The final historical-reference synthetic audit and all four real fixture-isolation regression cases are NOT RUN. Earlier preparation encountered an oversized documentary read capture and two edit-helper preconditions that blocked before writing; their capture/normalization was corrected within the approved scope, without changing an execution guard or treating them as passing checks. Recover the concrete documentary-check error in a later bounded continuation before drawing a root-cause conclusion or validating further.

Future product checks require separate authority: static contract/reference tests first, then the identified capacity/bootstrap/first-stage cases, fixture-isolation cases, bounded correction groups and service/API files, followed by typecheck only if preceding commands pass. No complete suite is included here. T008 remains unchecked, F2 `in_progress`, and the original gate, Harness/browser evidence plus real-pilot technical/human checkpoint remain pending.

A later explicit continuation authorized only recovering the documentary-check error and executing that check, then the historical-reference check only on success. The closed driver selection registers 90 but invokes only the two exact remaining bodies, documentary first. A bounded stdout error record prevents the unchanged launcher's stderr discard from losing the classification. Its on-disk source remains unchanged; only two substitutions in a memory copy pass the selector and retain the verified artifact root. Every execution guard, environment/ownership constraint and 900000-ms deadline is preserved.

That one focused invocation returned native exit 1: **zero PASS, one FAIL, one NOT RUN, 88 not selected**. Captured error: `AssertionError [ERR_ASSERTION]`, `strictEqual`, actual `true`, expected `false`. The unchanged documentary body identifies this as its final portable-wording assertion over the core task plan. Earlier architecture and route-count assertions completed, but the compound check remains failed; the matching source token/location has not yet been captured. Supervisor wall was 420 ms and final timing 437 ms, without termination. Execution stopped without wording repair, a hash check, any repeated passing check, suite or CI. Only evidence records were updated.

A separately authorized read-only inspection then identified three historical branch-prefix mentions in the task plan. Their minimal correction replaces only those fragments with neutral links to the exact baseline already retained in the roadmap outside the portable core. Recorded branch/HEAD facts and prior results remain traceable; the correction involved no Git operation or validation run.

The next explicitly authorized invocation selected only the documentary check and, after it passed, the historical-reference check: **2/2 PASS, native exit 0**. The receipt records 90 registered and **88 not selected**, selection `remaining-documentary-checks`, `synthetic_only: true`, `acceptance: false` and the unchanged 900000-ms deadline. Supervisor mode was `synthetic`, status `completed`, wall 555 ms and final timing 567 ms; capture closed at 554 ms and all termination fields stayed null. The earlier 88 PASS results plus these two passing remaining checks complete synthetic coverage across separate invocations, not a new 90-case run. No execution guard or timeout changed; the on-disk launcher is intact.

This closes only the bounded synthetic increment. The four product fixture-isolation regressions, native context/reference/validator tests, identified product failures, correction workflows, service/API checks and typecheck remain NOT RUN for this revision. No real suite/gate, CI, smoke, paid call, cleanup or publication followed. Future targeted product checks require their own continuation; F2/T008, the original full acceptance gate, Harness/browser evidence and the private-pilot checkpoint remain pending.

A subsequent explicit continuation authorized three native focal commands, in order, with 900 seconds each: `harness-context`, `profile-reference-contracts`, then `harness-validators`. All used the validated original launcher and closed selections, with no guard, timeout, worker, environment/ownership or command-catalog change. Initial read-only hashes matched five protected sources and four execution artifacts. Every successor was launched only after the preceding native result, both EOFs and coherent coverage were confirmed.

Results: **19/19 active PASS** for context (supervisor wall 9534 ms), **4/4 selected PASS with 1289 filtered skips** for historical references (3650 ms), and **98/98 PASS** for native validators (96934 ms). All returned native exit 0, complete coverage, observed root exit, both stream EOFs, `run-end: passed`, no stream errors or pending modules/cases, and unchanged 900000-ms deadlines. Supervisors completed without termination; final timings were 9542, 3656 and 96941 ms. The four selected reference tests do not certify execution of the other 1289 cases. See the ordered receipts in the [task evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md).

Execution stopped after the authorized third PASS. These are scoped tests, always labeled `diagnostic_only: true` and `acceptance: false`; they do not replace the original spec gate or separate Harness/browser acceptance. No full suite, gate, CI, typecheck, smoke, paid call, independent cleanup or publication ran. Native fixture-owned teardown belongs to the test lifecycle; historical unknown fixture cleanup remains unknown. Product-failure/fixture-isolation/correction/service/API validation and the private-pilot checkpoint remain pending, so T008/F2 is still incomplete.

A separate continuation next authorized only `issue-intake-capacity`, `workflow-budget-bootstrap` and `workflow-first-stage`, sequentially with 900 seconds each. The unchanged launcher, five protected sources and four execution artifacts matched their reviewed identities before execution. All three passed with native exit 0, complete coverage, root exit observed, both EOFs and no stream failure: **1 active PASS / 190 filtered skips**, **1 active PASS / 78 filtered skips**, and **3 active PASS / 76 filtered skips**, respectively. Supervisor wall/final timings were 8554/8561, 7645/7651 and 14362/14376 ms, all with unchanged 900000-ms deadlines and no termination requested.

The two reported selections prove their exact file/module, selected active count and passed run-end. The legacy first-stage selection proves exactly the three expected read-only role variants and its coherent summary; no attribution field is required for that legacy mode. The earlier full-suite failures did not reproduce in these isolated cases; their root cause and behavior under whole-suite load remain unproven. Neither source/assertion repair nor guard/timeout changes were used. Execution stopped after the third PASS, without typecheck, full suite/gate, CI, smoke, paid call, independent process cleanup or publication. Service/API fixture regressions, correction workflows and service/API checks, full acceptance and the real-pilot checkpoint remain pending.

## Contract to observe

Use the existing WorkIssue, issue aggregate/lock, context preview and exact human decisions. Manual HTTP creation requires a caller-owned canonical `request_id`; its optional server-owned receipt remains inside WorkIssue v1. Replay returns the current issue with HTTP 201 and `{ issue }`, without resetting progress, appending events or rewriting state. Equal content with different identities may be intentional; title equality is not request identity. An identity is neither a credential nor execution authority.

The form retains its submitted payload only in memory and persists only its pending UUID in sessionStorage. Explicit retry sends that same payload/UUID. Reload uses validated GET evidence; absence, incomplete coverage and errors leave the result uncertain. Acknowledged cancellation closes only the local intent and does not delete an already-created issue. No retry, reload or intake authorizes scope, creates a task or approves a plan.

See [compatibility and downgrade limits](../architecture/organization-state-migration.md) and [local recovery steps](local-work-issues.md). No migration/backfill or normal-state repair is required. Selected document bodies cannot grant tools, scope, consent, publication or configured verification. A listed command is not a passing verification receipt.

## Observed focused evidence - 2026-10-24

The task plan retains complete commands, native exits, failures, separate human continuations and preservation evidence. Do not add counts across overlapping runs or interpret skipped cases as passing.

| Task | Observed result | Limit |
| --- | --- | --- |
| T001 | Structural spec/task and documentary checks PASS; zero acceptance checks executed | Planning evidence only |
| T002 | 91 store tests PASS; 63 schemas and typecheck PASS | The initial sandbox TEMP cache EPERM is retained; the authorized TEMP/TMP retry passed |
| T003 | 376 tests in three backend/store files PASS, 40.09 s; 63 schemas and typecheck PASS | Earlier sandbox refusals/capacity timeout and the fixture-only correction remain recorded; no F2 browser campaign |
| T004 | 209 tests PASS plus one opt-in browser case skipped, 22.74 s; typecheck/build PASS | Build warned about a 516.68-kB chunk; no guard/config change or browser acceptance implied |
| T005 | 70 context/workflow tests PASS, 98.36 s; typecheck PASS | Synthetic sources and existing exact-plan controls, not real pilot delivery |
| T006 | 28 selected helper tests PASS plus 70 filtered out, 1.24 s; typecheck PASS | New E2E assertions are implemented but unexecuted; browser lifecycle/cleanup NOT RUN |
| T007 | Spec/task structure and five-document reference/scope/whitespace/preservation checks PASS; zero acceptance commands executed | No product tests, campaigns or T008 execution |
| T008 | Gate FAIL: native exit 1, check timeout under the 900-second ceiling; zero reported PASS checks | Harness/browser NOT RUN; suite-fixture cleanup and human pilot readiness unconfirmed |

All reported focused commands supplied native exit 0 after their separately authorized continuations. Tests used synthetic data/fakes, not paid calls or normal user state. T006's fault injects an unusable acknowledgement only after a real fixture POST persists; until the smoke runs, it is prepared coverage, not observed F2 success or proof of every network-failure mode.

## Requirement-to-evidence map

| Requirement | Focused evidence already observed | Required T008 evidence still pending |
| --- | --- | --- |
| req-001 | T002/T003 locked replay, conflicts, current result, distinct identity and no-write checks | Real form double submit, lost acknowledgement/retry, HTTP conflicts and replay after progress/restart |
| req-002 | T002/T003 schema/runtime receipt, absence, invalid/future, uniqueness and immutability tests | Whole-feature gate plus persisted receipt/byte assertions in the real smoke |
| req-003 | T004 pending UUID, frozen payload, storage refusal, reload uncertainty, cancellation and stale-response tests | Actual browser recovery by GET, no automatic POST and acknowledged cancellation |
| req-004 | T005 contained README/architecture/ADR/contract selection, hashes/reasons/limits/exclusions and configured checks | Attributed real API/browser previews with no effects, drift refusal and renewed issuance after restart |
| req-005 | Existing context/workflow tests reject forged/stale scope/consent/plan authority and retain exact human gates | Real UI root/Planner/risk/criterion decisions, no writer before plan approval and unchanged runtime/correction limits |
| req-006 | Isolated focused fixtures/fakes; T006 smoke implementation/typecheck | Native full gate, actual API/Vite/browser result, fixture lifecycle/cleanup and human real-project/request/criteria/sources/commands confirmation |

Configured checks, typecheck, a model success message and a completed task cannot replace candidate-bound infrastructure verification plus human acceptance. F2 evidence cannot certify Q, enable deferred P capabilities or start F3.

## T008 attempted acceptance - stopped on timeout

The exact approved gate ran once outside the sandbox in the foreground with owned TEMP/TMP and `-TimeoutSeconds 900`. It returned native exit 1 with `Acceptance check timed out; process tree terminated`. There was no `[OK] acceptance` output. The first catalog command is `pnpm test`; the Harness discards its child logs, so no test totals, assertion error, underlying cause or actual Vitest duration are available. Do not treat the absence of detailed logs as either a zero-test run or a passing suite.

The sequence stopped. The separate Harness and actual API/Vite/browser smoke commands were NOT RUN, without rerun, profiling, repair or guard/timeout change. The validator reported terminating its owned process tree; that does not independently certify suite-fixture cleanup. The outer environment restoration remained in `finally`; the owned TEMP parent was retained. No post-failure inspection/check/cleanup command was run. A reviewed continuation is required before diagnostics or another workload.

The owner has now supplied a private real project and the desired scheduling/rescheduling outcome in the conversation. Read-only preparation was partial and stopped when checkout status could not be established. Baseline, source/verification selection and technical scope still need review; no real issue, project mutation, provider call, message or paid turn occurred. No private project source is reproduced here. Full T008/F2 closure and F3 readiness remain unavailable.

## Visible diagnostic launcher - synthetic checks passed

A separately approved ephemeral launcher is prepared under `node_modules/.surtec-t008-visible-08ad63fadd0345aa8777c2ac128b1a56/`. Syntax checks passed for its four files, then **29/29 in-memory synthetic checks passed with native exit 0** under `launch.ps1 -SyntheticChecks`. Its supervisor retained the 900000-ms guard and reported `acceptance: false`. Artifact hashes and the exact synthetic command are recorded in the task plan. No real `pnpm test`, API/Vite/browser campaign, provider call or cleanup ran in this preparation.

The launcher preserves the existing command environment and runtime configuration while showing only bounded sanitized metadata. Its PS Process object owns the diagnostic root/descendants; native exit and stream EOF are independent facts. Overflow is explicitly truncated while draining continues, and incomplete terminal evidence remains UNKNOWN. Tests cover fake deadlines rather than shortening a real timeout. No common script, validator, package script, Vitest configuration, redactor or Harness pin was edited. The ignored local files are retained and are not available in a published checkout.

At that preparation checkpoint, a future explicitly authorized diagnostic would use the original `launch.ps1 -RunDiagnostic -ConfirmDiagnostic` and fixed `pnpm test --reporter=verbose --includeTaskLocation`; no real diagnostic had yet executed. The later timeout and replacement with closed focal selections are recorded below. The reporter describes completed tests; with two workers, its last completion cannot conclusively identify a currently blocked test. These diagnostic records do not certify full/pilot acceptance.

## T008 procedure - renewed authorization required after the stopped attempt

1. Read current instructions/spec/tasks and inspect the actual dirty baseline. Confirm explicit T008 execution authority and the isolated fixture lifecycle. Review the human checkpoint below: it may remain pending while synthetic checks run, but prevents full F2 closure. Do not discard user changes, install dependencies, change guards/timeouts or infer authority from metadata.
2. Use foreground native completion, process-scoped owned TEMP/TMP and the separately authorized host execution environment. Restore the environment afterward. Never reuse the old detached Q supervisor. Its operational closure was established by a separately authorized same-host boot observation after the old launch; Q CI remains UNKNOWN and historical fixture cleanup remains unknown. A new unavailable terminal receipt requires bounded ownership/closure resolution before another workload, not a blind retry or process cleanup.
3. Run the approved formal gate once, with its existing explicit ceiling of 900 seconds **per command**. It contains the complete suite once; do not repeat that suite through CI or another campaign automatically.

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

The seven unchanged catalog entries below describe the commands inside that gate, not seven extra invocations:

| Check | Exact catalog command | Required result |
| --- | --- | --- |
| ac-behavior | `pnpm test` | Native exit 0; skipped cases and limitations reported separately |
| ac-schemas | `pnpm schemas:check` | Native exit 0 |
| ac-types | `pnpm typecheck` | Native exit 0 |
| ac-build | `pnpm build` | Native exit 0; warnings recorded |
| ac-repository | `pnpm repository:check` | Native exit 0 |
| ac-secrets | `pnpm secrets:check` | Native exit 0; no universal secret-prevention claim |
| ac-evals | `pnpm evals:check` | Native exit 0; offline fixtures, no live canary |

4. Only if the gate passes, execute the separately reviewed Harness check; only if that passes, execute the existing isolated real-browser smoke. These are outside the guarded catalog and need actual execution authority. Audit, another CI campaign and paid runtime smokes are not implicit successors.

```text
pnpm harness:check
pnpm smoke:local:playwright
```

The smoke starts its own loopback API, Vite and browser, uses synthetic repositories/state and an injected fake executor, and owns its contained fixture lifecycle. Do not use a manually started server, normal `state/`, real sibling repositories or a real model. Its managed Git/verification operations occur only inside that fixture. Existing teardown stops only owned resources and removes the owned fixture when safe; report each closure and workspace-removal result independently. No permission to investigate, terminate or clean up unknown processes follows from a smoke run. If fixture-lifecycle authority is unavailable, leave the command NOT RUN.

5. Record the native exit, duration, selected/skipped counts, requirement coverage, restart facts, browser errors, refusals, final fake-turn count and cleanup result. The script retains the prior K-O checks and exactly 31 synthetic turns; new intake/preview/refusal/recovery assertions must add no execution. Inspect the real 201/current-receipt and unchanged-byte assertions, not just the final PASS text. Do not infer success from a missing stream, a running session or a retained directory.
6. Stop at the first failed or unknown result; leave every successor NOT RUN. Do not rerun, add profiling, loosen an assertion, increase timeouts, strip facets or repair unrelated code automatically. Preserve bounded evidence and obtain a reviewed continuation where needed. Actual success plus the human checkpoint is required before closing T008/F2; it still grants no F3 dispatch or publication authority.

## Recovery and evidence when a check fails

Keep the command/check ID, native exit or explicit UNKNOWN, stage, duration, test name and bounded error category. For intake, include only necessary issue/request identity, receipt fingerprint, current revision/status, method/path/status and whether original bytes were preserved. Do not attach session headers/tokens, private form/document bodies, credentials, raw reasoning, normal-state files or unrelated logs.

For a lost acknowledgement, keep the pending identity and use the UI's explicit same-request retry while its original payload remains in memory, or validated GET reconciliation after reload. A missing result does not prove non-creation. Do not rotate the UUID or delete local state to force success. Acknowledged cancellation closes local uncertainty only; separately inspect any server-side issue through existing controls. Restart requires fresh session authority and newly issued preview for new dispatch, while the persisted original request can replay with the current token.

Report fixture closure/cleanup separately from test outcome. A failure with safe teardown is still a failure; a successful assertion sequence with unavailable cleanup is not complete acceptance. Preserve bytes when ownership or rollback compatibility is uncertain; follow the existing migration contract rather than removing receipts for an older reader.

## Human real-pilot readiness checkpoint

Marcos must explicitly identify the real project and exact baseline, desired request/outcome, acceptance criteria, allowed/excluded paths and categories, selected README/architecture/ADR/contracts, trusted verification commands and approver. Confirm the required scope/consent/plan gates through the existing workflow. No candidate request or project is chosen automatically; the status-filter idea in the roadmap is still a proposal.

These inputs cannot be inferred from synthetic fixtures. Do not ask the user to repeat automated checks; ask only for the actual project/request/source/command decisions that require the owner's intent. With fixture acceptance but this checkpoint missing, report **contract verified with fixtures; real pilot preparation pending**. With T008 unexecuted, report **focused checks passed; full contract acceptance pending**. Neither status is full F2 completion or F3 readiness.

Any real issue creation, paid runtime turn, integration, push, merge, deployment or F3 implementation retains separate explicit authority. T007 performs none of them.

## T008 visible diagnostic outcome - 2026-10-24

The separately authorized single diagnostic ran outside the sandbox, in the foreground with owned TEMP/TMP, using the validated ephemeral launcher and fixed `pnpm test --reporter=verbose --includeTaskLocation` command. The unchanged 900-second supervisor ceiling expired: **native exit 124**, supervisor `deadline`, owned-tree termination requested, fixture cleanup **UNKNOWN**. The inner observer did not see the child native exit or either stream EOF before its deadline. This is a diagnostic timeout, not passing acceptance or proof of successful fixture cleanup.

Its bounded buffer retained failure markers at `lib/git-status.test.ts:74:3`, `runner/verify.test.ts:125:3` and `runner/workflow-orchestrator.test.ts:328:118` / `506:3`. The four-entry buffer is not a total failure count, and no complete assertion errors or final suite summary were captured. Output truncation was explicit while draining continued. The last retained successful test does not identify a blocked worker. Exact names, durations and observation limitations are recorded in the [T008 task evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md).

Execution stopped without another launch, gate, CI, Harness or browser smoke. No repair, guard/timeout change, process investigation or additional cleanup followed. Only the three authorized evidence documents record this outcome, with no post-result validation commands, commit, push or merge. The original gate remains FAIL; separate Harness/browser checks remain NOT RUN, and T008/F2 remains incomplete. Any diagnosis or correction of these concrete failures needs a separately reviewed continuation rather than another automatic full-suite run.

## Focal-launcher continuation - implementation incomplete

The owner approved the four ephemeral artifacts plus the three T008 evidence documents, with synthetic checks only and the unchanged 900-second ceiling. Implementation stopped on a rejected `launch.ps1` patch: the patch context incorrectly used `-or` instead of the source's `-and`. The rejected patch applied no changes. Agent-reported partial edits exist in `core.mjs`, `runner.mjs` and `synthetics.mjs`; the launcher remains at its previous version, so the combined artifacts are not ready for execution.

No syntax or synthetic check ran, and no real focal/full-suite diagnostic was launched. The reported 37 declared synthetic cases are not passing evidence; coverage/error cases and static review remain unfinished. Only these evidence records were updated after the stop. No guard/timeout change, process investigation/cleanup, gate, CI, commit, push or merge occurred. Finish and review the bounded implementation under renewed authority before using it; T008/F2 remains incomplete.

## Focal launcher completed - synthetic checks passed

The owner renewed authority to correct the patch, finish the four existing ephemeral files and execute synthetic checks only. The completed revision passed **53/53 synthetic checks, native exit 0**, through one foreground `launch.ps1 -SyntheticChecks` invocation outside the sandbox. Its supervisor reported `completed`, `mode: synthetic`, `deadline_ms: 900000`, `acceptance: false` and 697 ms wall time. The [task evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md) records the exact command, artifact hashes, coverage and preservation. This supersedes the preceding partial-implementation warning for that revision; it changes no product acceptance result.

The launcher now admits only `git-nonrepo`, `verify-runtime`, `workflow-first-stage` and `workflow-capacity`, with exact counts 1/1/3/1. Future real invocation requires both diagnostic flags plus `-Selection` with one of those values. Fixed files/patterns and `--bail=1` prevent an arbitrary command or automatic full suite. Real mode separately qualifies a new owned fixture TEMP/TMP outside worktrees before the test child starts, with Node revalidation. Synthetic mode uses injected filesystem/process/clock facts and creates no external fixture or pnpm/Vitest child; real qualification and cleanup have not been tested by this check.

Bounded error details bind only to an explicit matching FAIL block on the same stream. Coverage needs exact selected cases, standard terminal summaries, native success and both EOFs; ambiguity remains unknown. The existing 900-second execution guard, allowlist, capture limits, runtime/test deadlines and assertions remain intact. No real focal run, suite, gate, CI, Harness, browser smoke, process probe/cleanup, commit, push or merge ran. T008/F2 remains incomplete, with four observed failed cases and the global timeout cause unresolved. The next separately authorized workload may use the closed focal selections, stopping on the first failure or unknown; no acceptance or F3 successor follows automatically.

## Four real focal selections - passed

The owner separately authorized all four selections once, in order, outside the sandbox with freshly owned TEMP/TMP and the unchanged 900-second ceiling. The launcher used the fixed argument form `-RunDiagnostic -ConfirmDiagnostic -Selection <selection>`. Results were:

| Selection | Selected PASS | Filtered SKIP | Native exit | Vitest duration |
| --- | --- | --- | --- | --- |
| `git-nonrepo` | 1 | 4 | 0 | 627 ms |
| `verify-runtime` | 1 | 17 | 0 | 4.12 s |
| `workflow-first-stage` | 3 | 74 | 0 | 15.66 s |
| `workflow-capacity` | 1 | 76 | 0 | 6.27 s |

All four had exact complete coverage, selected cases passed, coherent terminal summaries, native exit 0, both stream EOFs, root exit observed, no deadline/stream failure and supervisor `completed/exit_code: 0`. This is six distinct selected passing cases; the workflow filters overlap in their skipped inventory, so skip counts are not additive unique tests. The first-stage implementation variant reported 4889 ms, while analysis reported 4322 ms and operations-investigation 3167 ms. These are observations, not proof of the earlier failures or aggregate timeout cause. Complete commands, independent timing scopes and preservation evidence are in the [task record](../../.agents/specs/tasks/factory-request-contract.tasks.md).

Real temporary-root qualification and propagation now executed before each selected child. Existing fixture hooks remained part of the tests; no extra process/filesystem probe or cleanup ran, and owned temporary parents were retained. Native process closure is established for these four invocations; historical fixture cleanup remains unknown and current hooks were not independently audited. No source, assertion, guard or timeout changed. No automatic rerun, full suite, gate, CI, audit, Harness/browser smoke, paid runtime, commit, push or merge followed. The prior failed cases were not reproduced in isolation; full acceptance, the global timeout diagnosis and the real-pilot technical checkpoint remain pending. T008/F2 is still incomplete.

## Workflow fixture cost reduction - focused checks passed

The owner approved only the workflow test file and three evidence documents. The test-only adjustment reuses private original public YAML/evaluation bytes while writing new independent files per case, plus single validated snapshots inside synchronous capacity checkpoints. It shares no persisted state or execution authority and retains every existing assertion, the exact first-stage dispatch/wait contract, case setup/teardown, guards and timeouts. Two new regressions verify exact materialization and isolation after mutation.

The authorized sequence completed outside the sandbox, in the foreground with owned qualified TEMP/TMP and 900 seconds per command:

| Check | Selected PASS / filtered SKIP | Native exit | Reported duration |
| --- | --- | --- | --- |
| `workflow fixture input isolation` | 2 / 77 | 0 | Vitest 2.89 s |
| `workflow-first-stage` | 3 / 76 | 0 | Vitest 12.62 s |
| `workflow-capacity` | 1 / 78 | 0 | Vitest 6.13 s |
| `pnpm typecheck` | Not a test selection | 0 | Supervisor 20.085 s |

Each launch supplied native success, root exit and both EOFs, no deadline/stream failure and normal supervisor completion; test names/counts and standard summaries were checked. The regression/typecheck invocations were fixed in memory using the existing observer/redactor/ownership validator and unchanged 900000-ms owned-process guard; the existing focal launcher was not edited. Source hashes and exact commands are in the [task evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md). Filtered skips overlap and are not passing or additive unique evidence.

The implementation variant reported 4086 ms versus the previous isolated 4889 ms, and capacity 3413 ms versus 3539 ms. This is not a controlled benchmark, proof of causation or explanation of the old full-suite timeout. Only the approved test and evidence changed; no runtime/store/schema/policy, original assertion, profiler, guard, timeout or worker setting changed. No extra cleanup/probe or automatic rerun, whole file/full suite, gate, CI, audit, Harness/browser/runtime smoke, paid call, commit, push or merge ran. Selected fixture teardown assertions passed, but historical cleanup uncertainty remains; temporary parents were retained. This focused slice is complete, while T008/F2, full acceptance and private-pilot technical readiness remain pending.

## Renewed original gate - 2026-10-25, stopped without internal evidence

Under the owner's request to finish the remaining work, the original `validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900` ran once outside the sandbox in the foreground with a qualified owned external TEMP/TMP parent. The unchanged validator retained 900 seconds per catalog command, with no shorter aggregate deadline. The outer process reported **native exit 1 after 1839 ms**, but supplied no validator error, acceptance-check result or structural result. The internal stage/cause is **UNKNOWN**. This was not an observed 900-second timeout and does not establish either a test failure or zero tests executed.

The outer process closed natively; inner activity/fixture cleanup could not be established from the missing child stdout/stderr. Only outer start/result metadata was available through inherited child output handles. The sequence stopped without another diagnostic, retry, repair, post-failure status/hash check or additional cleanup. The owned temporary parent remains retained. Harness and the real API/browser smoke are **NOT RUN**, and no 31-turn/cleanup acceptance exists for F2.

Separately, read-only preparation of the human-selected private pilot stopped on a baseline-wrapper exit 1 whose underlying command/stderr were absorbed. No private code inspection, tests, edits, provider call, real issue or paid turn followed; technical scope and specific human confirmation remain pending. Only these evidence documents record the results. No guard/timeout/runtime change, CI, commit, push or merge occurred. T008/F2 remains incomplete; the next step must recover the exact invocation error without assuming another suite run is warranted.

## Pre-launch error reproduced without acceptance execution

Under explicit diagnostic authority, the original validator ran once in structural-only mode, omitting `-Run` and `-ConfirmExecution`. It returned **native exit 0 in 1099 ms**, reporting one structurally checked spec and **zero acceptance commands**, with empty stderr and complete streams. The current YAML module/spec/catalog initialization therefore passed.

A subsequent read-only resolution probe in the same sanitized child environment successfully found `pnpm` and its standard JavaScript entry, then failed at the original `Get-Command node -CommandType Application` step. It returned **native exit 1 in 866 ms**, `ObjectNotFound` / `CommandNotFoundException`, with this captured error:

```text
The term 'node' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

Both streams closed and neither was truncated. No resolved program was executed: this is evidence of a pre-launch lookup failure, not a failing suite. PATHEXT was present. The original historical stderr remains irretrievable; this reproduces the current failing code path without establishing the exact PATH cause or that Node is uninstalled. Do not install dependencies or widen child environments based on an assumption.

Only evidence was updated. No guard/timeout/PATH/source change, acceptance retry, test, gate, CI, Harness/browser smoke, paid call, sibling operation, process cleanup, commit, push or merge followed. Temporary parents were retained. Prepare explicit Node resolution for the validator host under a reviewed continuation before another acceptance attempt; T008/F2 and the pilot checkpoint remain pending.

## Validator Node preparation - readiness verified

The owner authorized preparing and checking explicit Node resolution before gate resumption. Read-only comparison found that the parent already had Node's directory in PATH, while the sanitized PowerShell child had PATHEXT `.CPL` only: `node.exe` and the absolute executable resolved, but bare `node` did not. The child pnpm candidate also differed from the expected parent candidate.

The temporary host preparation now resolves/verifies Node and pnpm in the parent and preserves the parent's executable extensions in `ProcessStartInfo.Environment['PATHEXT']`. It does not modify global PATH, add another PATH prefix, change a Harness source/pin or expand the existing project-child variable allowlist. Both executable identities and the standard pnpm entry are checked before accepting readiness. An initial in-memory packaging ParserError was corrected without executing the project or changing guards; it remains recorded in the task evidence.

The completed checks were:

| Check | Native result | Scope |
| --- | --- | --- |
| Prepared Node/pnpm identity and `node --version` | Exit 0, 551 ms | Same expected executables; Node v24.16.0 / exit 0; zero spec checks |
| Original validator, structural-only | Exit 0, 1050 ms | One spec structurally checked; zero acceptance commands |

Both had complete stdout/stderr, no truncation, empty stderr, qualified owned TEMP/TMP and the existing 900-second guard. The observed Node version is not a dependency pin. Temporary parents were retained without cleanup. The full gate is prepared in memory with host-only PATHEXT and captured streams, preserving 900 seconds per original catalog command without an aggregate 900-second cap, but was **NOT EXECUTED**. No tests, suite, CI, Harness/browser/runtime smoke, paid call, sibling operation, dependency installation, commit, push or merge followed. T008/F2 still needs full acceptance and the private-pilot technical checkpoint; host readiness alone does not close it.

## Prepared gate executed once - captured timeout

The owner then explicitly authorized the prepared original seven-check gate. The single invocation ran outside the sandbox in the foreground with qualified owned external TEMP/TMP, host-only parent PATHEXT, concurrent capture of both streams and the unchanged validator's 900 seconds per catalog command. No shorter aggregate deadline was added.

It returned **native exit 1**, both EOFs and untruncated capture after **972908 ms outer wall time**. Stdout was empty; stderr contained `Write-Error: Acceptance check timed out; process tree terminated`. No acceptance PASS or final spec summary was emitted. The unchanged first command is `pnpm test` (`ac-behavior`); the other six catalog checks were not reached. The original guard discards that child's raw output, so this capture establishes the validator timeout but supplies no individual test error, test totals or Vitest duration. The outer interval includes unmeasured initialization/termination/capture overhead and does not change the 900-second wait limit.

The validator reported owned-tree termination and the outer process closed natively; internal fixture cleanup remains unconfirmed. The temporary parent was retained. The sequence stopped without repair, retry, diagnostic, post-failure status/hash check or additional cleanup. Only the three evidence documents were updated. No source, guard, timeout, catalog or global environment changed. CI, audit, Harness/browser/runtime smokes, paid calls, sibling work, commit, push and merge were NOT RUN. T008/F2 remains incomplete; earlier focused PASS/readiness results do not replace complete acceptance or the private-pilot checkpoint.

## Authorized fixture-file and correction focals - 2026-10-28

The separately authorized ordered block used the original validated diagnostic launcher, outside the sandbox in the foreground with owned TEMP/TMP and 900 seconds per command. Protected source/launcher identities matched before launch; successors waited for complete native closure and passing coverage.

| Selection | Native exit | Result and coverage | Supervisor wall / final ms |
| --- | --- | --- | --- |
| workflow-service-file | 0 | 111 PASS, zero skips, complete | 130250 / 130257 |
| workflow-api-file | 0 | 29 PASS, zero skips, complete | 146142 / 146166 |
| workflow-correction | 1 | one failed case, 77 filtered skips, second variant unresolved; coverage unknown | 106196 / 106206 |

The complete service/API files include the four new byte-equivalence/normal-file and copy-isolation regressions. Both report passed run-end, no failed/open/pending cases or modules and zero unhandled errors. Service display truncation did not prevent draining or complete reporter/terminal coverage. These are 140 passing active cases across two separate commands, not full acceptance.

Correction captured `Error: Test timed out in 90000ms` at `runner/workflow-orchestrator.test.ts:897:24`, category `test-timeout`. Its first selected case failed with reported duration 99637.7907 ms; the second lacks a valid terminal status. Coverage/attribution is `unknown` (`reporter-invalid-status`), run-end `interrupted`; the textual 79 total denotes registered cases. Do not count the unresolved variant or the 77 filtered skips as passing executions, infer a particular blocking operation, or reinterpret the explicit first-case failure as merely missing observation.

Every command closed natively with both EOFs, no stream failure, `deadline_ms: 900000`, `acceptance: false`, null termination fields and no outer deadline reached. The correction failure is the unchanged 90000-ms test timeout, not exhaustion of the command allowance. Internal correction-fixture cleanup is not independently established.

Stop at this failure. Only the three evidence records changed afterward; no retry, source/assertion change, further diagnostic/probe, cleanup, typecheck, whole suite/gate, CI, smoke, paid call or Git publication followed. T008/F2 remains incomplete. Prepare a bounded design from the captured timeout before separately authorizing a repair or another execution; the original gate, separate Harness/browser evidence and private-pilot checkpoint remain required.

## Approved correction checkpoint increment - 2026-10-28

The owner approved six files: the workflow worker test fixture, five fixed-size historical test references, the same five current literals in the existing ignored synthetic inverse audit, and these three evidence records. A fresh validated-store checkpoint replaces nine explicit public-detail observations per variant only in the two existing T010 correction cases. All original assertions, seven worker executions, real Git/worktree/verification effects, Reviewer/QA, human gates, reconciliations and teardown remain. Other fixture consumers retain the full-detail path. Embedded checkpoint checks cover equivalence with the existing start response, one read, unknown identity refusal, disposable-copy independence and later freshness; they create no extra registered test or launcher selection.

The authorized future sequence is byte/invariant review, the two existing documentary/reference synthetics without repeating the other 88, `profile-reference-contracts`, `workflow-correction`, then typecheck only after all PASS. Native success, complete expected coverage, root exit and both EOFs remain required; stop at the first failure/unknown. Every command retains 900 seconds; the correction cases retain 90000 ms and their polls 15000 ms. Execution artifacts, output/ownership/environment/termination guards and runtime pins are unchanged. No full gate, suite, CI, paid call, independent cleanup, commit, push or merge is included.

This checkpoint records implementation only; validation is NOT RUN here and the timing effect is unproven. T008/F2 remains incomplete. Later results must preserve the failed first variant and unresolved second variant as historical evidence, and cannot stand in for original-gate, separate Harness/browser or private-pilot acceptance.

### Focused results - correction still fails

The scoped byte/invariant review passed, reconstructing the original fixture bytes and preserving all protected source/execution hashes. Only five 64-character literals changed in the 583607-byte profile test and the same five current synthetic inverse entries; their prior file hashes are recoverable exactly. The task record retains the new fixture/reference identities.

The two closed documentary/reference synthetic bodies passed **2/2, native exit 0**, with 90 registered and 88 not selected, supervisor wall/final 495/514 ms. `profile-reference-contracts` then passed **4 active cases, native exit 0**, with 1289 filtered skips, complete coherent coverage, passed run-end and supervisor wall/final 5525/5539 ms. The on-disk launcher, two-case correction selector and other execution artifacts remained unchanged.

The single `workflow-correction` invocation returned **native exit 1**. It captured `Error: Test timed out in 90000ms` at `runner/workflow-orchestrator.test.ts:926:24`: one failed first case, reported duration 91013.1522 ms, 77 filtered skips and an unresolved second variant. Coverage/attribution is `unknown` (`reporter-invalid-status`), run-end `interrupted`; the 79 registered cases are not passing executions. The new embedded assertions have no independent passing result. The precise incomplete internal operation is still unknown, and the adjustment did not resolve the timeout.

Root exit and both EOFs were observed with no stream failure. Supervisor wall/final were 96542/96551 ms, the outer 900000-ms deadline was not reached and termination fields stayed null. No causal timing gain or correction-fixture cleanup success is inferred. **Typecheck was NOT RUN** because its prerequisite failed. Only these evidence records changed afterward; no retry, source repair, new diagnostic/probe, independent cleanup, whole suite/gate, CI, smoke, paid call or Git publication followed.

Stop here under the approved first-failure rule. The six-file increment remains applied, guards/timeouts remain intact, and T008/F2 remains incomplete. The next reviewed continuation must address the missing operation-level evidence; full-gate, separate Harness/browser and private-pilot requirements are unchanged.

## Approved bounded correction operation observer - 2026-10-28

The owner approved eight files: a new pure progress helper, the workflow correction fixture, five fixed-size historical references, the existing ignored core and synthetic driver, and these three evidence records. Two independent fixture/attempt lanes retain operation entries/returns and existing task-tracer milestones using only closed enums, ordinal/sequence values and reported opaque case bindings. Tracer context remains null; attributes, titles, instructions, real IDs, paths, commands and arbitrary errors are omitted. The fixture seals/detaches its emitter before the existing worker stop; callbacks retain their own instance, and late events cannot enter the next variant.

The core reserves at most 3072 observation bytes within its unchanged snapshot cap. Prefix admission is correction-only and tied to the unique active reported case. Invalid input produces unknown observation without changing test PASS/coverage or suppressing the original error. The default historical 90-check matrix remains intact; a new closed selector executes twelve pure progress checks and the two existing documentary/reference audit bodies, with 88 old checks unselected.

The only authorized sequence is those fourteen synthetics, four reference cases and conditional typecheck; stop on the first failed/unknown result. No real correction run, complete suite/gate, CI, independent cleanup, paid call or Git publication is included. Environment, ownership, output/line/stream handling and all command/test/poll guards remain unchanged. Implementation is being completed and validation is NOT RUN at this checkpoint. T008/F2 stays incomplete; an open interval is evidence of a return not observed, not a causal diagnosis.

### Operation observer focused results

The eight-file implementation and authorized focused sequence completed successfully. A pre-launch audit preserved 96 pre-existing changed files outside the increment, eight protected source/execution hashes, the recorded HEAD/branch and empty index. The historical profile keeps 583607 bytes, fixed offsets, original assertion bodies and independent pins; the task record retains the new helper/fixture/core/synthetic and five derived reference identities.

| Validation | Native result | Coverage and supervisor timing |
| --- | --- | --- |
| Closed correction-progress synthetics | 0; 14/14 PASS | Twelve new plus two existing audits; 102 registered, 88 not selected; wall/final 649/671 ms |
| profile-reference-contracts | 0; 4 active PASS | 1289 filtered skips, complete attribution and passed run-end; wall/final 5314/5328 ms |
| pnpm typecheck | 0; PASS | Fixed compiler command, wall 37611 ms; 900000-ms allowance not reached |

The fourteen synthetics exercised bounded privacy/schema, both variants, overlapping lanes, open operations after failure/bail, saturation/tail eviction, stream chunk/EOF/oversize handling, rejected payloads/bindings/sequences, capacity, seal/late-event separation, sink errors and unchanged execution/coverage guards. The default historical matrix was not repeated. The reference focal closed natively with both EOFs and no stream failure; display saturation did not lose reported coverage. Typecheck followed only after both prior PASS results, outside the sandbox in the foreground, using an owned qualified external TEMP/TMP root and the existing environment/wait/owned-tree termination boundaries; it requested no termination, and its temporary parent remains retained.

Execution stopped at this approved boundary. No real workflow-correction run, full suite/gate, CI, smoke, paid call, independent process probe/cleanup or Git publication followed. This validates preparation, not the real failure's operation or cause; missing/unsealed producer output remains incomplete even when some facts are `observed`. The earlier first-case 90000-ms timeout and unresolved second variant remain current real evidence. T008/F2, original-gate, separate Harness/browser and private-pilot requirements remain pending. A single real correction diagnostic requires separate authorization.

### Single correction run with the new capture - FAILED / progress UNKNOWN

The separately authorized single diagnostic used the original validated correction command outside the sandbox in the foreground with owned TEMP/TMP and the unchanged 900-second guard. Thirteen pre-launch source/execution hashes matched. It returned **native exit 1**, capturing `Error: Test timed out in 90000ms` at `runner/workflow-orchestrator.test.ts:972:24`: the first variant failed with reported duration 90159.9598 ms, while the second has no valid terminal result. Coverage is `unknown` (`reporter-invalid-status`), run-end `interrupted`, zero active passes, one failure and 77 filtered skips among 79 registered cases.

The operation observer failed to supply usable progress: global `invalid-binding`, one first-variant row with sequence 0, unsealed, `event-order`, empty open stacks and null last-completed/milestone fields. **No stage or operation is identified.** Do not infer why frame binding/order failed or where execution stalled from these missing fields. Prior synthetic PASS establishes only the simulated cases, and the real observation remains unknown.

Root exit and both EOFs were observed without stream failure. Supervisor wall/final were 95721/95732 ms, without an outer deadline or termination request. Fixture cleanup remains unconfirmed. Execution stopped; only these evidence documents changed afterward, without retry, source repair, further probe/check, repeated typecheck, full suite/gate, CI, smoke, paid call, independent cleanup or Git publication. Guards/timeouts remain intact. T008/F2 stays incomplete; the next proposed design concerns binding/order of the capture, with no presumed runtime cause.

## Approved correction identity/order repair - 2026-10-29

The eight-file continuation replaces v2 capture's dependency on a currently open reported test with an explicit opaque digest of the actual test task ID. The existing hook obtains that identity; each correction emitter retains its own immutable copy. V2 frames are reduced provisionally from sequence one and confirmed against the same reported ID plus expected module/file, regardless of whether lifecycle arrives before or after progress. A prior case's late frames cannot be assigned to a currently open successor. V1 behavior remains compatible.

Pending confirmation is reversible diagnostic uncertainty; it is UNKNOWN if still absent at closure. Invalid bindings/lifecycle, schema/sequence failures and cross-variant reuse remain sticky. Sealed event facts cannot be changed by late events. No raw FIFO, clock, timer, guard, wait, output cap, test assertion or native/coverage criterion changes; reporter, runner and launcher remain intact. Five fixed-size reference literals and their inverse audit follow the fixture; original budgets and independent pins remain.

The approved validation is exactly ten selected synthetics (eight new binding groups plus the existing two audits; 110 registered, 100 not selected), four reference cases and typecheck only after preceding PASS results, with the unchanged 900-second command limit. The historical default and progress selectors are retained. Stop at the first failed/unknown result. No real correction diagnostic, suite/gate, CI, independent cleanup, paid call or Git publication is included. Implementation is being completed and validation is NOT RUN here. Capture repair is not evidence of a resolved runtime timeout or T008/F2 acceptance.

### Identity/order repair focused results

The approved eight-file implementation and conditional validation sequence passed. Pre-launch audit preserved 96 out-of-scope changed files, eight protected execution/source identities, HEAD/branch and the empty index. Exactly five 64-character profile literals changed within the unchanged 583607-byte file; their inverse restores the immediately prior file, and the historical inverse check preserves its independent baseline. Current source/reference hashes are recorded in the task evidence.

| Validation | Native result | Coverage and supervisor timing |
| --- | --- | --- |
| Closed correction-binding synthetics | 0; 10/10 PASS | Eight new plus two existing audits; 110 registered, 100 not selected; wall/final 2498/2540 ms |
| profile-reference-contracts | 0; 4 active PASS | 1289 filtered skips, complete coherent coverage and passed run-end; wall/final 13039/13051 ms |
| pnpm typecheck | 0; PASS | Fixed compiler command; wall 20044 ms, 900000-ms allowance not reached |

The synthetic invocation used the existing launcher with only reversible in-memory root/closed-selector substitutions; the on-disk launcher remained byte-identical. The eight new groups covered delayed ready/result ordering, exact/interleaved identities, pending closure, refused foreign/skipped/repeated/contradictory cases, sticky schema/sequence failures, sealing/late events and v1/cap/coverage compatibility. The other 100 registered checks were not repeated.

The reference focal ran once outside the sandbox in the foreground with owned external TEMP/TMP. Native root exit, both EOFs, complete expected 4/4 coverage, no unhandled/stream error and null termination fields were observed. Visible saturation did not prevent draining or the final coverage result; filtered skips are not passing executions. Conditional typecheck then ran once through verified Node and the resolved standard package-manager entry, with its own qualified external TEMP/TMP, unchanged environment/wait/owned-tree termination boundaries, native exit 0 and no termination. Temporary parents were retained without additional cleanup.

The authorized preparation is complete; no manual UI check is needed for this diagnostic-only repair. Security authority, assertions, all timeouts and protected execution files remain unchanged. No real correction, full suite/gate, schema/build, CI, smoke, paid call, independent process probe/cleanup or Git publication ran. T008/F2 remains incomplete: only a separately authorized real correction diagnostic can exercise the repair against the latest failed timeout, and the original gate, separate Harness/browser evidence and private-pilot checkpoint remain required.

### Single real correction diagnostic after identity repair - PASS, 2026-10-29

Under separate explicit authority, the original closed `workflow-correction` diagnostic ran exactly once outside the sandbox, in the foreground with owned qualified external TEMP/TMP and 900 seconds. Preflight matched thirteen validated source/execution identities plus the recorded Git baseline. No source, execution guard or timeout changed.

The command completed with **native exit 0**, complete expected/observed **2/2 active coverage**, a passed module/run-end, zero failures/unhandled errors, no open cases/pending modules and 77 filtered skips among 79 observed cases. The two active variants passed at `runner/workflow-orchestrator.test.ts:980:24`, with reported durations **63188.3692 ms** and **60693.686 ms**. Filtered cases are not passing executions.

The repaired progress capture is valid: `observed` / `captured`, both exact case IDs `confirmed`, both sequences 180, sealed, no sticky reason, empty fixture/attempt stacks. Last-closed is `case` / `return` at sequence 179, and last milestone `task.finished` in final QA/ordinal 7 at sequence 160 for each variant. No missing or cross-case binding remains in this receipt; no runtime cause or authority is inferred from that observation.

Root exit and both EOFs were observed without stream failure, truncation or outer deadline. Supervisor wall/final were **129197/129203 ms**, Node observer wall 128935 ms, with all termination fields null and the 900000-ms allowance intact. Original selected-case teardown assertions passed. No independent filesystem/process cleanup audit or additional cleanup ran; owned temporary parents remain retained and historical cleanup unknowns remain historical.

The previous 90000-ms test timeout did not reproduce in this isolated run; its cause and complete-suite timing remain unresolved. Only this runbook, the task evidence and roadmap were updated afterward. No retry, further test/typecheck, schema/build, full suite/gate, CI, smoke, paid call, source/guard/timeout change or Git publication followed. No manual UI validation is required for this diagnostic-only continuation. T008/F2 is still incomplete pending original-gate, separate Harness/browser and private-pilot acceptance; a separately authorized original-gate resumption is the next proposed action.

### Original gate resumed after correction PASS - FAIL, 2026-10-29

The separately authorized original seven-command gate ran once outside the sandbox in the foreground with qualified owned external TEMP/TMP, host-only parent PATHEXT and both validator streams captured concurrently. Preflight preserved 96 out-of-scope changed files, eight protected hashes, five validated source identities, HEAD/branch and the empty index. The validator, exact command catalog, original child allowlist and 900 seconds per command remained unchanged; there was no aggregate 900-second cap on the complete gate.

The result was **native exit 1 after 901630 ms outer wall time**, stdout/stderr EOFs, no truncation, empty stdout and this ANSI-normalized stderr:

```text
Write-Error: Acceptance check timed out; process tree terminated
```

No acceptance PASS or final spec/check summary was reported. The first catalog check, `pnpm test`, timed out; all six successors (schemas, types, build, repository, secrets and evaluations) are **NOT RUN**. The original Harness drains/discards the suite's internal streams, so this outer capture cannot identify test totals, the incomplete/failing case or a concrete assertion error. It does not establish that zero tests executed, and the outer wall interval does not change the configured 900000-ms wait.

The validator reported termination of its owned tree and the outer process closed natively. Fixture cleanup remains unknown; temporary parents were retained without additional inspection or cleanup. The earlier isolated 2/2 correction PASS with confirmed progress stays valid for that selection and does not certify complete-suite timing.

Execution stopped. Only the three evidence documents changed afterward. No rerun, additional probe/check/typecheck, repair, profiling, guard/timeout/source/catalog/global environment change, CI, audit, Harness/browser/runtime smoke, paid call, sibling work or Git publication followed. T008/F2 remains incomplete pending full-suite timeout resolution, the complete original gate, separate Harness/browser acceptance and private-pilot confirmation. No manual local action was requested during this failed automated gate; a new bounded continuation is needed before more investigation or execution.

### Approved unchanged full-suite attribution plan - 2026-10-29

Exactly three evidence files may change: this runbook, the task evidence and active roadmap. Verify the recorded source/Git baseline read-only, then run the existing `launch.ps1 -RunDiagnostic -ConfirmDiagnostic -Selection full-suite-attribution` once outside the sandbox in the foreground, with its own qualified external TEMP/TMP and original 900000-ms supervision. The existing complete-suite command adds only its already reviewed verbose/public-reporter/location observation; no filter, bail, worker, test limit, environment, output cap or termination behavior changes.

Use retained ranked case/module durations, open cases, pending modules, bounded concrete failures and omission counters together with native exit, EOF and lifecycle/clock facts. Do not equate duration sums to CPU/global time, local pending age to a proven blocked operation, or unrelated failure-detail digests to exact case error bindings. Missing/invalid evidence remains unknown. The unchanged observer is already covered by the recorded synthetic checks; no test repeat or new capturer is needed for preparation.

Stop after the single command's failure/unknown, existing deadline or complete result. Record evidence only; no automatic repair, second diagnostic, original gate, CI, audit, smoke, process probe/extra cleanup, paid call, sibling change or publication. This checkpoint records the plan before execution: the authorized single diagnostic is NOT RUN here. A diagnostic PASS will not close T008/F2; original complete gate, separate Harness/browser and private-pilot technical/human confirmation remain mandatory.

### Single unchanged full-suite attribution result - TIMEOUT, 2026-10-29

The approved single diagnostic ran with the original launcher, outside the sandbox in the foreground with its qualified owned external TEMP/TMP. The recorded 96 out-of-scope file hashes, thirteen protected/validated identities and Git baseline matched. No source, observer, guard, worker, filter, bail, output limit or timeout changed.

It reached 900000 ms with diagnostic status `timeout`, coverage `unknown` / `missing-run-end`, no final suite summary and no observed native suite exit or EOFs. The outer tool session then closed with exit 1; that is not the suite's unknown exit code. The partial inventory was **151 modules, 150 completed/passed, zero module failures; 6561 observed cases, 6560 completed, 6546 passed, zero observed failures and fourteen skipped**.

The sole pending module was `runner/workflow-orchestrator.test.ts`: 72 completed cases with **475276.7324 ms** summed reported duration, no terminal module timing and local pending age **510853.6154 ms**. Its observed open case was at **1028:118**, opaque prefix `983d47573c36`, local age **29514.4416 ms**. There may be tests that had not yet started. This does not demonstrate that case's own timeout or its internal cause.

The largest closed-module case-duration sums were workflow service **129762.4974 ms**, workflow API **115411.759 ms**, run-task **108553.8314 ms** and Harness validators **93431.9932 ms**. Both correction cases at line 980 passed within the suite, reporting **72198.1612 / 75077.46 ms**. The task evidence records the retained module ranking and ten largest case locations, including groups 1021, 808 and 796. These sums are diagnostic observations, not additive wall/CPU attribution.

The bounded capture retained twenty case ranks, sixteen module ranks and all observed open/pending/failure rows; no capacity or open/pending/failure omission occurred. Ranking omissions were 6526 case rows and 135 module rows. Visible capture saturated while draining continued, with no reported stream or capture-schema/order error. Missing final lifecycle at the deadline remains explicit incomplete coverage.

PowerShell reported its existing deadline/owned-tree termination, with guarded wait 900021 ms, kill return 900062 ms, post-kill wait 900064 ms and final 900072 ms; capture-closed remained null. Node observer wall was 899791 ms. Fixture cleanup remains unknown and temporary parents retained; no independent cleanup/probe ran.

The sequence stopped. Only the task evidence, this runbook and roadmap were updated after the result, without further inspection, repair, repeat, tests/typecheck, original gate, CI, audit, smoke, paid call, sibling work or publication. No manual UI validation is needed for this diagnostic-only continuation. A proposed next read-only design would examine the identified workflow groups and shared fixture cost, without automatically launching it. T008/F2, original-gate, separate Harness/browser and real-pilot requirements remain pending.

### Approved seven-negative-case checkpoint optimization - 2026-10-30

The owner approved six existing files: the workflow fixture, five fixed-size historical references, their existing ignored inverse-audit counterparts and these three evidence records. Only the two negative T010 groups (three plus four cases) reuse the already validated five-field checkpoint for setup, advancement and final lineage reads. Their existing assertions and the checkpoint contract assertions remain. Exactly 37 explicit public-detail reads are removed; implicit runtime reads, real stages/Git/verification, refusal paths, teardown and all budgets/timeouts remain unchanged. Other fixtures retain their original detail path.

The only authorized focused sequence is seven negative cases once, four historical reference cases, then conditional typecheck; stop at first failed/unknown. Use the fixed two-group pattern with original 90000-ms case limits and 15000-ms polls, unchanged two-worker configuration, owned qualified external TEMP/TMP, foreground execution outside the sandbox and 900 seconds per command. Expected active/skipped counts are 7/72 for the fixture selection and 4/1289 for the reference selection. Existing observers/launcher, environment, ownership, output/termination boundaries and independent pins remain unchanged.

The fixture inverse restores its immediate prior bytes; the profile keeps 583607 bytes and changes only five 64-character derived references, with the same five inverse-audit updates. Static review found no actionable semantic change. Preparation is complete but validation is NOT RUN here. No additional synthetic run, full suite/gate, CI, audit, Harness/browser/runtime smoke, paid call, independent process probe/cleanup or publication is included. Actual savings remain unmeasured and complete F2 acceptance is still pending.

### Seven-negative-case optimization - focused PASS, 2026-10-30

The approved six-file fixture/reference/evidence adjustment is implemented and its entire authorized focused sequence passed: seven negative variants, four historical reference cases and typecheck, all with native exit 0. The scope audit preserved 97 out-of-scope changed files, ten protected identities, HEAD/branch and empty index. Only four fixture observation lines and five fixed-size profile/inverse literals changed outside these evidence records; all original assertions and limits remain.

| Validation | Active result | Filtered skips | Supervisor wall ms |
| --- | --- | --- | --- |
| T010 unavailable/unsuccessful correction variants | 7/7 PASS | 72 | 271221 |
| Historical profile references | 4/4 PASS, complete attribution | 1289 | 3713; final 3721 |
| pnpm typecheck | PASS | not applicable | 21438 |

The seven-case command captured both EOFs, empty stderr, exact three-plus-four group coverage and the unchanged 900000-ms allowance without termination. Vitest reported 268.55 seconds total and 262.05 seconds tests. The reference command reused the unmodified closed launcher; native root exit, both EOFs, passed run-end, zero unhandled/stream errors and null termination fields were observed despite visible saturation. Typecheck used the fixed compiler command, fresh owned external TEMP/TMP and the unchanged environment/wait/termination boundaries, with native completion and empty stderr.

Exactly 37 explicit detail reads were removed, but the observed timing does not prove savings sufficient for the full gate: the three comparable negatives total 105.889 seconds versus 108.565 seconds in a different, loaded whole-suite run. That is not a controlled benchmark or causal improvement claim. Four further negatives total 156.154 seconds; all seven still take about 262 seconds of reported test duration. Do not infer complete-suite readiness from the focused PASS.

Existing selected-case teardown assertions passed and temporary parents were retained; no extra cleanup/probe or manual UI check was needed. Scope/reference identities and per-case durations are recorded in the task evidence. No synthetic repeat, other focal, complete suite/gate, schema/build, CI, audit, smoke, paid call, sibling work or Git publication ran. The approved slice is complete; T008/F2 acceptance is not. Further gate execution, contract changes or broader test restructuring need a separate decision, with existing Harness/browser and private-pilot conditions preserved.

## F2 functional closure and human checkpoint - 2026-10-30

The repository owner explicitly confirmed the prepared replacement pilot checkpoint in this conversation. This acknowledgement was recorded at 2026-10-30T23:02:57Z; it is not an inferred earlier approval timestamp. The confirmation covers its exact clean Git baseline, requested acceptance-harness outcome, measurable criteria, versioned allowlist/exclusions, contained context, trusted verification entry points and the owner as approver. Detailed private project paths/source/business data remain only in the conversation and owned external checkpoint, outside this public repository.

All revised mandatory Surtec F2 conditions are now satisfied: the six-check gate; 376 + 72 + 209 + 28 active functional cases with the previously explained skip/filter inventory; Harness; the real API/Chromium smoke with exactly 31 fake turns, native exit 0/both EOFs, 670440 ms and complete reported owned cleanup; and explicit human pilot confirmation. T001-T008 are complete under the precise disposition **F2 functional acceptance complete for the local PoC, global debt open**.

Additional preparation of the selected pilot passed 82 frontend unit cases, TypeScript and a qualified production build using owned temporary copies. Its single existing mocked-API browser selection reached the unchanged 900-second supervisor deadline without a report or attributable test counts: browser acceptance is **UNKNOWN**, not PASS or a demonstrated product failure. Both streams closed; the owned process tree was terminated by its supervisor, no owned survivor remained and the loopback port was free. Wall time including closure was 914364 ms; the command limit remained 900000 ms. No rerun followed. Two dependency-restore setup failures preceded product backend tests; a later offline MSBuild initialization probe passed, but backend build/tests and real pilot API/database acceptance remain **NOT RUN**. No database was created or existing data reused. These pilot-product results are disclosed preparation limitations, not substitutes for Surtec's independently passing mandatory smoke or extra retrospective F2 exit requirements.

Only the three existing F2 evidence documents are changed for closure. Private source repositories remain unchanged; generated evidence/builds stay in owned external temporaries. Historical status/failure records below retain their contemporaneous meaning. DEBT-F2-GLOBAL-900 stays open; no whole-suite, Q/CI/original-gate PASS, P activation, F3 implementation, model dispatch, commit, push or merge is implied. Next: prepare a separately reviewed F3 design/plan with exact permissions, prerequisite handling, budget and one-writer/runtime consent before implementation.
