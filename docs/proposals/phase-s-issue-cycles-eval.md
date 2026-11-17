# Phase S · Issue and blocker cycle evaluation

## Scope

Add `org.issue.cycles` to the mandatory S.1 offline checks. The [issue store](../../lib/state/issues.ts) checks parent ancestry and blocker dependencies independently when reading the saved aggregate. The [existing issue service regression](../../dashboard/src/server/issue-service.test.ts#L503) covers a two-node cycle in each graph. The new case exercises the production reader with isolated schema-valid fixtures that cover a shared blocker, self-loops and transitive cycles.

## Fixture and expected outcomes

Save a synthetic version-1 [issue document](../../schemas/issue-document.schema.json) with four proposed issues, fixed synthetic IDs and timestamps, no external references, and empty candidate, evidence and event collections. Use `A`, `B`, `C` and `D` as labels for the fixture's schema-valid IDs.

- Parenthood forms a tree. `B` and `C` have parent `A`, and `D` has parent `B`.
- Blockers form a diamond. `D` depends on `B` and `C`, and both depend on `A`. Accepting the fixture proves that revisiting a shared dependency does not count as a cycle.

Each negative variant starts from a fresh copy of the valid fixture and changes one relation in one graph.

| Variant | Change | Expected result |
| --- | --- | --- |
| Acyclic tree and diamond | Keep both graphs as seeded | Return the exact aggregate |
| Parent self-loop | Set `A`'s parent to `A` | `IssueStateError` with `issue parent ancestry contains a cycle` |
| Transitive parent cycle | Set `A`'s parent to `D` | The same ancestry error for `A → D → B → A` |
| Blocker self-loop | Add `A` as its own blocker | `IssueStateError` with `issue blocker graph contains a cycle` |
| Transitive blocker cycle | Add `D` as a blocker of `A` | The same blocker error for `A → D → B → A` and the branch through `C` |

Use `validateIssueDocument` on the serialized fixture and require that it passes before calling `readIssueDocument(filePath)`. On every read, check the saved bytes and temporary inventory even if the reader throws. Require cleanup of the identity-checked temporary directory. An unrelated error, unexpected acceptance, changed fixture, or unverified cleanup fails the gate. Reuse the saved-document fixture checks from the [objective ancestry EVAL](../../scripts/organizational-objective-ancestry.test.ts) by extracting only temporary file setup, preservation checks and cleanup. Keep schema and outcome assertions in each EVAL.

This slice covers the two graph invariants enforced by the saved-state reader. Cycles formed only by combining parent and blocker edges, missing references, maximum ancestry depth, and issue lifecycle or dispatch behavior are outside its scope. All reads are against disposable fixture files.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T006 | Extract the shared saved-document fixture checks and add the five issue-graph variants. Preserve every objective ancestry assertion. | `scripts/testing/saved-document-fixture.ts`, `scripts/organizational-objective-ancestry.test.ts`, `scripts/organizational-issue-cycles.test.ts` |
| T007 | Include the new file in the existing organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval.

1. `pnpm exec vitest run scripts/organizational-issue-cycles.test.ts scripts/organizational-objective-ancestry.test.ts` must pass the new cases and the shared-fixture regression.
2. `pnpm exec vitest run dashboard/src/server/issue-service.test.ts -t "rejects cyclic parent and blocker relationships when reading persisted state"` must run and pass the existing issue service regression.
3. `pnpm evals:check` must pass v1, v2 and all three organizational EVALs.
4. `pnpm typecheck` must exit 0.

## T006–T007 acceptance on 2026-11-16

**The [`org.issue.cycles` increment](../../scripts/organizational-issue-cycles.test.ts) is complete.** T006 covered the acyclic tree and blocker diamond, both self-loops, and both transitive cycles through the production issue reader. All five cases verified preservation and cleanup through the shared saved-document fixture. T007 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Issue cycle and objective ancestry focused tests | Exit 0. 10 passed in 2 files. |
| Selected issue service regression | Exit 0. 1 passed, 190 skipped by the selector. |
| Harness timeout follow-up | Exit 0. Both focused tests passed. The positive case took 3,130 ms with the original 5,000 ms limit after the [approved evaluation adjustment](phase-s-harness-read-only-cost.md). |
| `pnpm evals:check` after the adjustment | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 12 organizational tests passed. |
| `pnpm typecheck` | Exit 0. |

The initial gate timed out in the earlier Harness EVAL at 5,422 ms. The issue cycle checks passed in that run, and the resumed gate passed with the existing assertions and timeouts. The changes remained local. Phase S continues with the [proposed execution role EVAL](phase-s-execution-role-eval.md).
