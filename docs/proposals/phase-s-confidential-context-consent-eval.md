# Phase S · Require consent for confidential client context

## Scope

Add `org.context.confidential-consent` to the mandatory S.1 offline gate. The [client portfolio service](../../dashboard/src/server/client-portfolio-service.ts) builds context only from selected categories and appends confidential notes only for `confidential-notes`. The [context service](../../dashboard/src/server/context-service.ts) binds the selected categories and resolved sources into the preview fingerprint. The [task writer](../../dashboard/src/server/dispatch.ts) reassembles the request before admission and persists the exact selected content and consent audit in the governed task. The preview exposes source metadata and category selection. It keeps the confidential body out of the public result and manifest.

## Fixture and expected outcomes

Reuse the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts). Create a synthetic linked client and a `client-product` profile in the fixture state through the existing client service and profile writer. Give the client a distinct fictional display name and a distinct confidential note marker. Confirm that both `client-identity` and `confidential-notes` are available. Use the production context service's default client resolver and the real read-only analysis admission path. Keep the marker out of task-authored instructions and all other sources.

| Variant | Request | Expected result |
| --- | --- | --- |
| Default consent | Omit `client_context_categories` | The preview and persisted manifest exclude confidential notes. The queued task instructions and context reconstructed for execution contain neither client marker. The task has no client consent audit. |
| Consent for another category | Select only `client-identity` | The queued instructions and reconstructed context contain the fictional client name and exclude the note marker. The audit and selected categories name only `client-identity`, and `confidential-notes` remains excluded. |
| Explicit confidential consent | Select only `confidential-notes` | The note marker appears in admitted instructions and reconstructed context. The preview, serialized manifest and audit omit the note text. The audit binds the linked synthetic client and exactly the selected category. |
| Consent removed before dispatch | Issue a preview with `confidential-notes`, then submit the same task without that selection using the original fingerprint | Task admission returns the existing changed-preview conflict. It creates no task or task events and leaves the prepared state intact. |

For each admitted task, exercise `revalidateTask` on the saved record with the same current fixture policy. Check the serialized preview and manifest for absence of the note marker in all variants, including explicit consent. Preserve the client and project-profile bytes and verify cleanup of the owned temporary root. Report the precise rejection on the changed-consent case so an unrelated failure cannot satisfy the EVAL. Stop at queue admission and context reconstruction. Model or worker execution, workflow-specific role consent, and later runtime filesystem reads are outside this slice.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T016 | Add the four cases with real client resolution, context preview, admission and revalidation in disposable state. | `scripts/organizational-confidential-context-consent.test.ts` |
| T017 | Include the new file in the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain the existing limits and stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-confidential-context-consent.test.ts` must pass all four cases.
2. `pnpm exec vitest run dashboard/src/server/client-portfolio-service.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/dispatch.test.ts` must pass the existing client resolution, context and admission regressions.
3. `pnpm evals:check` must pass v1, v2 and all eight organizational EVALs.
4. `pnpm typecheck` must exit 0.

## T016–T017 acceptance on 2026-11-16

**The [`org.context.confidential-consent` increment](../../scripts/organizational-confidential-context-consent.test.ts) is complete.** T016 verified default exclusion, identity-only consent, explicit notes consent and rejection when consent is removed after preview. The rejection returned the expected 409 and persisted no task or events. The client and project profile bytes were preserved, and fixture cleanup passed. T017 documented the case and added it to the mandatory offline gate.

| Check | Observed result |
| --- | --- |
| Confidential context consent focused tests | Exit 0. All 4 cases passed. |
| Client portfolio, context and admission regressions | Exit 0. 84 passed in 3 files. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 37 organizational tests passed in 8 files. |
| `pnpm typecheck` | Exit 0. |

The cases stopped at queue admission and context reconstruction in disposable state. The changes remained local. Phase S continues with the [proposed issue completion evidence EVAL](phase-s-issue-completion-evidence-eval.md).
