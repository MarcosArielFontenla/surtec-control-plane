# Phase S · Objective ancestry evaluation

## Scope

Add the S.1 case `org.objective.ancestry` to the mandatory offline gate. The [organization store](../../lib/state/organization.ts) checks the parent graph when it loads a saved document. Its [existing tests](../../lib/state/organization.test.ts) exercise cycle and depth rejection through writes, and reject unreadable and unsupported saved documents. The new case exercises semantic ancestry validation when loading syntactically valid state. Each negative case must satisfy the [organization state schema](../../schemas/organization-state.schema.json) before the production reader rejects it.

## Fixture and expected outcomes

Create a small synthetic version-1 organization aggregate with draft objectives, an empty active index and no project links. The positive fixture is an eight-level chain with a root whose parent is null. Build the negative fixtures from the same valid aggregate. Each variant changes one parent relation or adds one level.

| Variant | Input | Expected observation |
| --- | --- | --- |
| Valid boundary | Eight levels, counting the root | Accept and return the exact aggregate |
| Missing parent | Set an objective's parent to a valid ID absent from the aggregate | Reject with `OrganizationStateError` for an absent parent |
| Self-parent | Point the root at itself | Reject with `OrganizationStateError` for a cycle |
| Multi-objective cycle | Point the root at a descendant in the chain | Reject with `OrganizationStateError` for a cycle |
| Excessive depth | Append a ninth objective | Reject with `OrganizationStateError` for depth beyond eight |

Use an explicit file path in a disposable temporary root and call `readOrganizationDocument(filePath)`. Confirm the aggregate schema accepts each input so an unrelated parse or schema error cannot satisfy the negative expectation. Compare the saved bytes and temporary inventory after each read, including on rejection. Require cleanup of the identity-checked temporary root. A wrong error, unexpected acceptance, changed input, or unverified cleanup fails the gate. Failure output identifies the synthetic case and expectation.

Use the production reader and schema validator directly. The case affects only evaluation infrastructure. Live state, objective mutations, API routes and the versioned v1/v2 report suites are outside its scope.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T004 | Add the five variants and verify the state reader's result, file preservation and fixture cleanup. | `scripts/organizational-objective-ancestry.test.ts` |
| T005 | Add the file to the existing organizational Vitest invocation in `pnpm evals:check` and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval.

1. `pnpm exec vitest run scripts/organizational-objective-ancestry.test.ts lib/state/organization.test.ts` exercises the new case and the existing organization store regressions.
2. `pnpm evals:check` must pass v1, v2, the Doctor and preview case, and the new ancestry case.
3. `pnpm typecheck` must exit 0.

This proposal is ready for review. Its scope is the single S.1 invariant for invalid objective ancestry. Issue and blocker cycles remain separate checks.

## T004–T005 acceptance on 2026-11-16

**The [`org.objective.ancestry` increment](../../scripts/organizational-objective-ancestry.test.ts) is complete.** T004 exercised the production reader with five schema-valid fixtures. It accepted the eight-level chain, rejected all four invalid variants for their expected ancestry errors, and verified fixture preservation and cleanup. T005 added the case to the mandatory offline gate and documented it in the [evaluation guide](../../evals/README.md).

| Check | Observed result |
| --- | --- |
| Objective ancestry and organization store focused tests | Exit 0. 11 passed in 2 files. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. The organizational cases passed 7 of 7 tests. |
| `pnpm typecheck` | Exit 0. |

The changes remained local. Phase S continues with the [proposed issue and blocker cycles EVAL](phase-s-issue-cycles-eval.md).
