# Phase S · Deny prohibited routine actions

## Scope

Add `org.routine.prohibited-action` to the mandatory S.1 offline gate. The [routine service](../../dashboard/src/server/routine-service.ts) accepts a closed set of actions and configuration fields. The [routine state reader](../../lib/state/routines.ts) validates the entire saved document, including current and historical definitions. The [runner](../../runner/routine-runner.ts) reads that document before it resolves execution policy, reserves budget or starts any action. Exercise these two entry points with an allowed action as a positive control.

## Fixture and expected outcomes

Use the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts) for an owned state root. Create a fresh enabled manual-only `refresh-evidence` revision in each case using the real routine service. Supply a fixed clock, a fictional organization and one synthetic project, and a bounded company budget policy through the service and runner injection points. Create a real `RoutineRunner` with the same fixture-only policy and attribution, a read callback returning one synthetic fresh fact, and spies for proposal and report effects. Call `runManual` with the exact routine ID and revision and one available read slot. Use the runner's completion and shutdown hooks before inspecting or removing fixture state.

| Variant | Stimulus | Required result |
| --- | --- | --- |
| Allowed read-only action | Run the valid `refresh-evidence` revision. | Exactly one occurrence completes with one evidence read, one terminal budget charge and a settled reservation. Its receipt binds the exact revision, reports zero model calls, tokens, workspace writes, proposals and reports, and records a fresh observation. |
| Prohibited action through configuration | Submit the same otherwise-valid configuration with `action: "publish"` and the current expected revision. | The service returns `RoutineServiceError` 400 with `Invalid routine or budget input.` before policy resolution or mutation. The current revision, its history and the state inventory are unchanged. |
| Caller-supplied command on an allowed action | Submit the otherwise-valid `refresh-evidence` configuration plus a synthetic `command` field. | The service returns the same 400 before policy resolution or mutation. The extra field is never persisted and the existing state is preserved. |
| Prohibited action in saved state | Starting from a validated document, replace only `action` in the enabled current record and its exact historical revision with `run-command`, then request that revision directly through `runManual`. | The document validator rejects the action, the state reader returns `RoutineStateError`, and the runner exposes `state-invalid` with zero active occurrences. It calls neither the policy resolver nor an effect callback, creates no ledger or reports, and preserves the supplied bytes and inventory. |

For each denial, snapshot the fixture after preparation and assert the exact error or refusal, byte-for-byte routine state equality and no new occurrence, accounting, task, issue or report effects. The saved-state case is a targeted mutation of an otherwise valid document with matching latest and historical records. That baseline isolates the prohibited action from revision drift or a malformed document shape. All cases verify that the synthetic checkout is preserved and that the owned root is removed after runner shutdown.

This slice uses the existing fixture-only execution composition. Production activation, HTTP behavior, other routine actions and changes to guards or schemas are outside its scope.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T024 | Add the four cases with the real service, state reader and manually driven fixture runner. | `scripts/organizational-routine-prohibited-action.test.ts` |
| T025 | Add the EVAL to the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain existing guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-routine-prohibited-action.test.ts` must pass all four variants and fixture cleanup.
2. `pnpm exec vitest run lib/routines/validation.test.ts -t 'rejects action (publish|run-command)$|rejects caller-defined command in definitions'` must pass exactly three contract regressions.
3. `pnpm exec vitest run dashboard/src/server/routine-service.test.ts -t 'distinguishes invalid input|supports explicit manual-only configuration'` must pass exactly two service regressions.
4. `pnpm exec vitest run runner/routine-runner.test.ts -t 'inactive production composition|preserves invalid/future source|reserves, persists, commits'` must pass exactly five runner regressions.
5. `pnpm evals:check` must pass v1, v2 and all twelve organizational EVALs, with 49 organizational tests expected.
6. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. Validation needs no browser, provider, model or manual setup.

## T024–T025 acceptance on 2026-11-17

**The [`org.routine.prohibited-action` increment](../../scripts/organizational-routine-prohibited-action.test.ts) is complete.** T024 verified a valid read-only refresh, rejected `publish` and a caller-supplied `command` at configuration, and rejected a saved `run-command` before policy resolution or budget reservation. The denied cases preserved the saved bytes and fixture inventory. The runners stopped and fixture cleanup passed. T025 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Prohibited routine action focused tests | Exit 0. All 4 cases passed. |
| Selected routine contract regressions | Exit 0. 3 passed and 308 skipped by the selector. |
| Selected routine service regressions | Exit 0. 2 passed and 86 skipped by the selector. |
| Selected routine runner regressions | Exit 0. 5 passed and 50 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 49 organizational tests passed in 12 files. |
| `pnpm typecheck` | Exit 0. |

The changes remained local. Phase S continues with the [proposed Harness source integrity EVAL](phase-s-harness-source-integrity-eval.md).
