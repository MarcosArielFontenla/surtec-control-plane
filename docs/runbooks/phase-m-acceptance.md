# Phase M acceptance - Harness observations

## Scope and authority

The user approved the exact prospective design and selected the reviewed H1-H4 scaffold in the task conversation on 2026-09-29 local date. The release label `surtec-h1-h4-v1` identifies this curated baseline, not the root primer or a skill's independent version. The source is local, explicitly registered and fingerprint-pinned. No generator or scaffold application is enabled.

The user separately approved adding App.tsx for Harness-only dashboard evidence navigation. Other signals retain their previous editor navigation. On 2026-09-30 the user approved adding lib/feedback-metrics.ts for a thirty-day Harness freshness window, matching profile/objective windows without changing cost or execution authority.

## Interfaces and storage

- `GET /api/projects/:id/harness` and `/harness/doctor`: current read-only observation plus last explicitly saved observation.
- `POST /api/projects/:id/harness/refresh`: existing loopback/origin/session protection; writes only bounded control-plane observation state.
- `state/harness/profiles.json`: version 1, locked reread/validation/atomic replacement; absent state is optional, malformed/future state is preserved and rejected.
- `registry/harness-sources.yml`: trusted canonical source, exact registered runner identities/commands and optional explicit project ownership/policy/validation metadata. No project Markdown may edit or override it.
- `registry/harness-manifests/surtec-h1-h4.json`: 25 reviewed source fingerprints and version-dependent capabilities. Dynamic feature specs/tasks and private state are not baseline entries.

Updating a source requires a separate explicit review of the changed manifest and fingerprints. Do not automatically regenerate pins to make health green. Do not classify matching files as scaffold-owned or treat ownership metadata as overwrite permission.

## Evidence and limitations

Inspection bounds entries to 128, individual reads to 256 KiB and project content reads to 2 MiB. Filesystem links, escaped references, secret/auth locations and unsupported entries are not followed. Project text is parsed as data, never evaluated as commands. Findings contain bounded paths/classifications, not private document bodies.

Supported recognition is the reviewed H1-H4 frontmatter/layout. Other dialects remain legacy or unknown; no general historical compatibility is claimed. A differing installation may still be structurally healthy while reporting drift. Its exact installed release remains unknown unless it matches a reviewed baseline. Additional project entries are preserved, not automatically invalid.

Doctor observes local references, routing, skill metadata/snapshot identity, declared context budgets, required capabilities, canonical drift and explicit policy evidence. Natural-language instruction consistency requires human review and is reported as unverified. Physical line budgets are not runtime token measurements. No project validator, runner, generator, done gate or agent runtime is executed by inspection.

Testing defaults to functional. Strict TDD requires explicit trusted configuration, a registered exact runner and red-evidence policy; observing that policy does not enable execution. Unknown ownership remains protected. Backup/rollback readiness and review policy are not fabricated. Recorded validation applies only when its trusted content fingerprint exactly matches the observation.

Today consumes explicitly saved observations rather than scanning every project on each poll. Signals retain observation timestamps and existing portfolio prioritization; opening Harness evidence performs no editor/task action. Viewing detail obtains a fresh read; only the explicit refresh saves it.

## Automated acceptance

Run in order:

```text
pnpm harness:check
pnpm ci:check
pnpm smoke:local:playwright
```

The isolated browser smoke starts real Hono API/Vite plus the existing fake-executor orchestration flow. It copies reviewed public scaffold/runtime files to a unique OS-temp directory and creates synthetic Git repositories; normal state and real sibling repositories are never used. Harness assertions cover healthy/absent/partial/invalid installations, canonical drift degrading to unknown, explicit ownership, functional default, protected refresh, responsive controls, unchanged complete project bytes, saved observations across reload/API restart and unchanged saved evidence after read-only negative observations. Fixture tests complement it with legacy/unknown formats, context/reference failures, external links, strict-TDD configuration, stale validation fingerprints, malformed/future state, locks and failed atomic replacement.

No paid model or provider call is part of these checks. Temporary cleanup is verified by the smoke after stopping its API/browser.

## Verification record

Baseline `pnpm test`: 91 files passed, one Harness validator fixture failed, 667 tests passed / one failed. The fixture assumed `.agents/specs/tasks` did not exist after the first prospective design was added. Its preparation now uses idempotent mkdir; no production behavior was changed by this repair.

Intermediate checks: 37 focused service/state/UI tests passed; 14 signal-engine tests passed after correcting the evidence schema location; full `pnpm test` passed 100 files / 701 tests before subsequent negative-case additions. `pnpm schemas:check` compiled 42 product schemas. Initial real API/browser smoke passed and cleaned up its fixture. These are checkpoints, not final post-edit acceptance; final CI/browser results must be appended before marking the phase done.

Latest checkpoint: `pnpm ci:check` passed repository/Harness/schema/secret/evaluation gates and 702 tests across 100 files, then failed typecheck because the exhaustive Feedback freshness map lacks the new Harness source. That narrowly scoped file addition awaits the user's separate approval; build was not reached by CI. Independent `pnpm build` passed with 1918 modules. Real API/browser smoke passed again, including Today-to-Harness dashboard navigation, explicitly saved invalid observations, restoration, restart and cleanup. After the final source-configuration fingerprint change, 58 focused tests across 12 files passed. The phase remains in progress; neither CI nor typecheck is claimed passed.

Post-edit browser revalidation did not finish cleanly: one run timed out before Harness acceptance while waiting for the company form PUT. The smoke now explicitly fills the synthetic visible company name and asserts native form validity before waiting for the write; no production form change or timeout increase was made. The next run completed Harness assertions but failed the final browser-error gate after API restart with `net::ERR_NO_BUFFER_SPACE` on `/api/activity`. Both runs cleaned their temporary state/repositories. The cause of the environment/resource error is not established; earlier passing runs are not final acceptance for these edits. A clean post-edit smoke and CI/typecheck remain required.

## Final acceptance checkpoint - 2026-09-30

The separately approved Feedback delta is implemented as `harness: 30` in `SIGNAL_FRESHNESS_DAYS`, with a regression assertion in the signal-engine suite. A subsequent CI run passed all 703 tests but caught an unused smoke variable during typecheck. The smoke now uses that observation to assert that explicit refresh persisted healthy status; no production behavior or timeout was changed. Historical failures above remain recorded and are superseded by these final post-code-edit results, not erased.

- `pnpm ci:check`: exit 0. Repository and Harness checks passed; all three snapshots and ten declared context profiles passed (135-485 physical lines). 42 product schemas compiled; secret scanner self-test and scan of 1085 repository files passed. Evaluation coverage 36/36, expectations 42/42 and outcome expectations 8/8 passed. All 703 tests across 100 files passed; `pnpm typecheck` and `pnpm build` passed, with 1918 transformed modules. The approved catalog commands ran through CI, not through the guarded spec runner; no waived check was used.
- `pnpm smoke:local:playwright`: exit 0 after final code edits. Actual local API/browser assertions passed for Harness source/inventory/Doctor/ownership, absent/healthy/partial/invalid/source drift, protected refresh, unchanged project bytes, Today evidence navigation, responsive controls and reload/restart persistence. Existing organization/migration and issue dispatch/Git/verification/candidate/lineage/scope flows also passed. Final browser-error assertions passed and temporary synthetic state/repositories were cleaned up.
- `git diff --check`: exit 0; only line-ending conversion warnings for existing tracked UI files. No dependency installation or lockfile change was needed. A separate registry audit and remote CI were not run; ordinary CI here is offline local evidence.

Phase M implementation files: `lib/harness/{types,validation,source,inspect,doctor}.ts` and corresponding tests; `lib/state/harness-profiles.ts` and its test plus `lib/state/paths.ts`; four Harness product schemas; `registry/harness-sources.yml` and its curated manifest; API Harness service/API tests and server wiring; signal types/engine/evidence/schema and tests; Feedback freshness map; UI API, Harness panel/tests, project detail, Today and App navigation; isolated Playwright acceptance and Harness-validator fixture compatibility; this runbook, current architecture, approved spec and task evidence. Existing Phase L/Harness changes remain preserved. The test bootstrap and state-validation file were inspected targets, not newly changed for this final delta.

All ten approved tasks are complete. Inspection still does not apply scaffolds, execute project validators, infer ownership or authorize repair. The transient browser resource error in an earlier run has no established root cause; a clean final run does not prove it cannot recur. Repeatable acceptance is covered automatically using the local-dashboard-validation skill; user review is optional and subjective only.

## Local user review and failure evidence

Repeatable acceptance is automated; no manual data-entry checklist is needed. Optional subjective review: run `pnpm dev`, open a registered project's detail, inspect Harness readability and use `Actualizar Harness` only if you want to save its observation. Unknown validation or ownership is expected when no trusted evidence was supplied, not an installation failure.

If a check fails, share the command, failing test/assertion or stage, HTTP status and sanitized error. Do not share private normal state, tokens, source document bodies or auth files. Preserve malformed observation bytes rather than deleting the store to make checks pass.

No local commit, push, merge, deploy, sibling-project mutation or paid runtime smoke is included. Stop after completed Phase M; Phase N (bounded context assembly and logical roles) requires separate authorization.
