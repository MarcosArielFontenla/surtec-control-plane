# Phase S · Detect context budget overflow

## Scope

Add `org.context.budget-overflow` to the mandatory S.1 offline gate. The [production assembler](../../lib/context/assemble.ts) normalizes and redacts source text, orders and deduplicates source identities, and accounts for the full rendered context. The [manifest validator](../../lib/context/validation.ts) enforces byte, physical line, and distinct source limits. The [governed prompt builder](../../runner/agent-prompt.ts) checks the full developer and user prompt against the admitted byte and line limits before the [runner](../../runner/run-task.ts) can pass it to the executor. These limits apply to text and source accounting. Runtime token budgets remain separate.

## Fixture and expected outcomes

Use two synthetic in-memory sources with stable identities, CRLF in one body and UTF-8 multibyte characters. Supply the sources out of order with one identical duplicate. Build an independent expected rendered string with normalized line endings, both complete bodies, attribution wrappers, and the inter-source separator. Use the expected string and distinct source count to set the exact limits. Tighten just one limit by one unit for each negative case. Keep limits and totals within the manifest schema bounds so a structural validation error cannot satisfy an overflow expectation.

For the final-prompt cases, use the production prompt builder with the current governed profile, a synthetic read-only task envelope, the same rendered context, and a short synthetic prior summary. Capture the full developer and user texts once under generous valid limits. Confirm they include the complete admitted context, profile guidance, prior summary, and task instructions. Derive the exact byte and line limits independently from the concatenated text, including the separator, without using the builder's reported counts. In both final-prompt overflow cases, confirm the assembled context alone still fits the tightened limit.

| Variant | Expected result |
| --- | --- |
| Assembled context at the exact limits | Return the full expected rendering. Manifest totals match its UTF-8 byte length and physical lines, and it contains the two distinct sources. |
| Assembled byte overflow | Lower the byte cap by one. Throw `ContextContractError` with `Context budget exceeded`. |
| Assembled line overflow | Lower the line cap by one. Throw the same budget error. |
| Assembled source overflow | Lower the distinct-source cap by one. Throw the same budget error. |
| Final prompt at the exact limits | Return the same complete developer and user texts. The reported counts match the independent totals. |
| Final prompt byte overflow | Lower the final byte cap by one. Throw `ContextContractError` with `Complete execution prompt exceeds the admitted context budget`. |
| Final prompt line overflow | Lower the final line cap by one. Throw the same complete-prompt budget error. |

Use the real assembler and prompt builder as pure functions. An overflow must reject the input rather than return a truncated result. The suite requires no filesystem fixture, task, worktree, worker or executor. Context policy, production limits, runtime budgets and timeouts remain outside the change.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T014 | Add the four assembler cases and three complete-prompt cases using the in-memory fixture. | `scripts/organizational-context-budget.test.ts` |
| T015 | Include the file in the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-context-budget.test.ts` must pass all seven cases.
2. `pnpm exec vitest run lib/context/assemble.test.ts lib/context/validation.test.ts runner/agent-prompt.test.ts` must pass the existing assembly, validation and prompt regressions.
3. `pnpm evals:check` must pass v1, v2 and all seven organizational EVALs.
4. `pnpm typecheck` must exit 0.

## T014–T015 acceptance on 2026-11-16

**The [`org.context.budget-overflow` increment](../../scripts/organizational-context-budget.test.ts) is complete.** T014 verified exact limits and one-unit overflows for the assembler and governed prompt builder. T015 added the case to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Context budget focused tests | Exit 0. All 7 cases passed. |
| Context assembly, validation and prompt regressions | Exit 0. 47 passed in 3 files. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 33 organizational tests passed. |
| `pnpm typecheck` | Exit 0. |

The new cases exercised pure functions without starting a worker or executor. The changes remained local. Phase S continues with the [proposed confidential context consent EVAL](phase-s-confidential-context-consent-eval.md).
