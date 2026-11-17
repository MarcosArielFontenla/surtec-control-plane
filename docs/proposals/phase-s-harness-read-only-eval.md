# Phase S · Read-only Doctor and scaffold preview evaluation

## Existing coverage

[`pnpm evals:check`](../../package.json) runs two offline suites. [V1](../../evals/v1/suite.json) validates policy and structured reports. Its [read-only mutation fixture](../../evals/v1/cases/hard-readonly-mutation.json) expects a hard failure when a synthetic candidate reports a changed file. [V2](../../evals/v2/suite.json) evaluates fixed golden outputs, including changed-file scope and reported side effects. Both consume synthetic data. The optional live canary is outside this increment.

Phase R already compares before-and-after file inventories around the [Doctor and preview calls](../../scripts/harness-scaffold-preview.test.ts). Its [registered CLI fixture](../../scripts/harness-scaffold-apply.test.ts) also checks checkout bytes and absence of state after a preview and a refused apply. Phase S can reuse that fixture to put independent, observable read-only assertions for Doctor and preview in the mandatory offline gate.

## Case `org.harness.read-only`

Reuse the registered Phase R fixture with a temporary canonical source and registry, an independent Git checkout and an isolated state path that starts absent. Keep the local README edit, the synthetic `AGENTS.md`, one canonical template present, and one canonical template absent. Use the existing source pins and keep setup and cleanup outside the measured operations.

1. After fixture setup, take a sorted inventory of the entire owned temporary root, including the root, directories, hidden files, `.git` and the expected absence of state. Record entry kind, file SHA-256, identities and modification/change timestamps. Exclude access times because reads can update them. Refuse unexpected links, unsupported entry kinds and incomplete snapshots. Seed a fixed old modification time on the disposable entries before the baseline so that a same-byte write or a brief directory change need not be separated from setup by a sleep.
2. Run `createHarnessService(...).read(projectId)` with the fixture policy, clock and state path. Require a Doctor observation for the fixture from the trusted source, with the expected absent template and `saved: null`. Compare the inventory immediately after this operation.
3. Run the actual `surtec-scaffold.ts preview fixture personal@1` CLI entry point with the existing bounded subprocess and isolated environment. Require exit 0, an available plan with the one expected pinned addition, `execution_authority: none`, and a Doctor project fingerprint matching the preceding observation. Compare the inventory again. Both comparisons cover the checkout, the source and the isolated state location.
4. Require owned-root cleanup after success or failure. Report only the case, operation and affected relative paths or metadata fields. Treat any observed mutation, missing observation, snapshot error or unverified cleanup as a failing offline check with a nonzero exit.

The snapshot controls use the same inventory code and deliberately introduce a persistent file addition, a same-byte overwrite and a create/remove cycle under the owned root. The first changes the path inventory. The latter two must still be detected through file or parent metadata. This case observes effects on the fixture at each boundary. It does not trace operating-system calls or claim to detect an operation that restores all observed bytes and metadata.

## Implementation plan

| Task | Scope | Files |
| --- | --- | --- |
| T001 | Extract the existing registered fixture setup and identity-checked cleanup for reuse. Preserve the Phase R assertions. | `scripts/testing/scaffold-cli-fixture.ts`, `scripts/harness-scaffold-apply.test.ts` |
| T002 | Add the case and the mutation controls in a dedicated test file. Exercise both production read paths and verify cleanup. | `scripts/organizational-harness-read-only.test.ts` |
| T003 | Add the dedicated file to the end of `pnpm evals:check` with an explicit Vitest file selector. Document that v1 and v2 still use synthetic reports and this case observes a real local fixture. | `package.json`, `evals/README.md` |

The existing CI invocation of `pnpm evals:check` makes the case mandatory. The normal test suite also discovers the file. The two executions use independent disposable roots. The change is confined to evaluation and test infrastructure. It introduces no product entity, runtime policy, registry or schema change. The production Doctor and preview code supply the behavior being evaluated.

## Proposed acceptance

1. `pnpm exec vitest run scripts/organizational-harness-read-only.test.ts scripts/harness-scaffold-apply.test.ts scripts/harness-scaffold-preview.test.ts` must pass the case, the mutation controls and the existing Phase R coverage.
2. `pnpm evals:check` must pass both historical suites and the new file. An unavailable observation or a detected mutation must fail the gate independently of the v1/v2 results.
3. `pnpm typecheck` must exit 0. Retain the existing command and test limits. No browser or manual acceptance is needed for this offline fixture.

Approval covers the first S.1 check only. Other organizational invariants, role golden cases, feedback metrics and live qualification remain later Phase S work.

## T001–T003 acceptance on 2026-11-16

**The `org.harness.read-only` increment is complete.** T001 extracted the registered [scaffold CLI fixture](../../scripts/testing/scaffold-cli-fixture.ts) for reuse. T002 verified the Doctor and preview independently, with controls for a persistent addition, a same-byte overwrite and a transient file. T003 wired the [case](../../scripts/organizational-harness-read-only.test.ts) into the mandatory offline gate.

| Check | Observed result |
| --- | --- |
| Focused Phase R and S tests | 7 passed in 3 files |
| `pnpm evals:check` | V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8 expectations. The new EVAL passed both tests. |
| Launcher temporary directory | The initial finalizer rejected an otherwise matching parent path because of a trailing separator. A separate cleanup normalized the parent, verified the exact owned directory and its cache entries, and confirmed removal. |
| `pnpm typecheck` | The initial exit code was obscured by the finalizer. The standalone rerun exited 0. |

The focused tests and offline gate results were retained. The closing turn reran only typecheck and published no changes. Phase S continues with the [proposed objective ancestry EVAL](phase-s-objective-ancestry-eval.md).
