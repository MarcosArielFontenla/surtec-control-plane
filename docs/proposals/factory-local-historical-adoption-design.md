# Factory Local — historical human adoption of the Gear List dossier

Status: **Proposed design**. This increment covers the single Gear List acceptance already recorded for F3-01 through F3-08.

## Decision

Add an explicit historical entry point to the local sealed adoption command. It produces a private receipt that revalidates the existing local acceptance. The pilot's Engineer task ended before committing, and its worktree still points to the base. The owner approved adoption of the retained index into a separate detached worktree. The accepted correction is a descendant of that adopted commit. The historical dossier uses a different seal format from the daily command. Gear List is absent from the current project registry. See the [F5 closure report](../runbooks/factory-local-f5-pilot-review.md#evidence-and-disposition) and the [daily preparation design](factory-local-sealed-adoption-design.md).

```text
pnpm exec tsx cli/surtec-sealed-adoption.ts prepare-historical --profile gear-list-f5 --seal-sha256 <owner-seal-sha256> --acceptance-sha256 <owner-acceptance-sha256>
```

The operator explicitly selects the one reviewed profile. The profile maps fixed, checkout-relative locations to the known historical documents. The operator supplies both reviewed SHA-256 anchors from the independent owner record. The command accepts no path, command, project ID or alternate profile. The daily `prepare` operation continues to read current policy, match the original managed writer's worktree and prepare a candidate awaiting human review.

## Trusted inputs

| Evidence | SHA-256 anchor |
| --- | --- |
| Corrected dossier seal | Independent owner record |
| Original local acceptance | Independent owner record |
| Prior adopted dossier seal | Reference in the corrected dossier |
| Corrected verification report | Matching references in the seal and owner decision |

The operator supplies the first two anchors from the independent F5 closure record. Match them against the exact original file bytes before parsing. Resolve the prior seal from the corrected seal and require the final report hash to agree across the seal, verification receipt and acceptance record. Verify the manifests' listed files, the two report hashes and the exact historical Reviewer and QA references. Read the adoption-issued record, G2 result and plan binding through their existing seals. Scope every read to bounded, physical files at the reviewed locations, including historic absolute references reconciled to their pinned records. A matching hash proves identity relative to the reviewed anchors in Surtec's local trust model.

## Evidence checks and receipt

| Check | Required observation |
| --- | --- |
| Original attempt and human approval | Read the retained issue, workflow, task and event records through the G2 result's pinned inventory. Confirm the failed attempt, inactive lease, approved plan, exact patch and scope, and preserved usage. Match the human adoption record to that stopped execution, approved criteria F3-01 and F3-07, base, retained index digest, adopted tree and isolated destination. The original workflow remains `needs-decision` with its original consumption and outcome. |
| Git lineage | Confirm the approved base, the first adopted commit and its tree, and the exact corrected child and its tree against the original dossier. Check both parent edges and the authorized changed paths, including the corrected paths recorded in the corrected dossier. Match the retained index to the original adopted tree through read-only inspection. Require the worktrees to be distinct where recorded, physically contained and registered in the same Git common directory. For the corrected candidate, require the recorded detached HEAD, exact index and physical bytes, and a clean worktree. |
| Stored verification | Validate the retained PASS records and the verifier manifest and contract bytes against their historical evidence. Reuse the sealed report v1 predicate against the corrected commit, tree and Git-derived content fingerprint. Check the original successful verification receipt, including unforced native exit 0, both drained streams and the two independent sessions. Use the installed, trusted Git executable solely for bounded read-only Git inspection. The historical verifier identity is evidence of the recorded run. |
| Human decision | Read the owner decision anchored above. Require `ACCEPTED_LOCALLY` on the exact commit, tree, report and dossier. Check Reviewer approval, the QA digest and confirmation, and exactly the original eight accepted criterion IDs. Carry forward the original timestamp, F3/F5 closure and recorded integration disposition. |
| Final observation and output | Compare the relevant records, Git identities, index and worktree observations before and after inspection. Stop on active known ownership or unstable evidence. Atomically create the receipt under `tmp/sealed-adoption/historical-reviews/` with a deterministic ID based on the profile, candidate, seal, report and acceptance hashes. An identical call revalidates all inputs and returns the same ID and byte-identical receipt. Conflicting or partial output remains available for inspection. |

Successful preparation returns `HISTORICAL_ACCEPTANCE_REVALIDATED` with exit 0 and the private receipt ID. `REFUSED` with exit 1 covers proven byte, identity, scope or decision mismatches. `UNKNOWN` with exit 2 covers missing or unstable evidence and conflicting output. The receipt records provenance and timestamps separately from the original decision. It confers zero task, verification, integration or publication authority and writes only to the private historical receipt directory. The canonical issue, workflow, acceptance records, dossiers and Git worktrees remain evidence sources.

## Proposed tasks

| Task | Scope and target files |
| --- | --- |
| T001 | Add `lib/workflows/historical-adoption.ts` and `lib/workflows/historical-adoption.test.ts`. Validate the closed historical profile and evidence chain. Reuse the bounded reader and report predicate in `lib/workflows/sealed-adoption.ts`. Keep the retained producer files as data. |
| T002 | Extend `cli/surtec-sealed-adoption.ts` and `cli/surtec-sealed-adoption.test.ts` after T001. Reuse read-only Git and atomic private output logic. Admit the recorded detached adoption lineage only through the historical entry point. |
| T003 | Document both entry points, the private receipt and failure handling in `docs/runbooks/local-work-issues.md` and link from `docs/runbooks/factory-local-f5-pilot-review.md` after T002. |

## Proposed acceptance

1. In isolated fixtures, validate a credible stopped task, its staged tree, the separately adopted commit and the corrected child. The historical command returns one receipt with the original decision. A second call verifies the source again, returns the same ID and preserves the receipt bytes. Assert preservation of source files, state, indexes and repository objects.
2. Reject a changed seal, report or acceptance byte, including whitespace. Reject a wrong detached worktree, changed index or physical file, different base or parent, out-of-scope changed path and mismatched Reviewer, QA or criterion evidence. Test missing, linked or changing inputs and partial output. A refusal or unknown result creates no receipt.
3. Exercise ordinary `prepare` with its existing fixture. Require its current policy and managed-worktree checks to keep refusing historical inputs. Assert zero dispatch, verifier, Docker and publication calls in the historical route.
4. Run `pnpm exec vitest run lib/workflows/sealed-adoption.test.ts lib/workflows/historical-adoption.test.ts cli/surtec-sealed-adoption.test.ts`, then `pnpm typecheck` if the focused tests pass. The fixture uses retained-shaped reports and the recorded V01–V08 results remain the pilot's verification evidence.
5. For real qualification once authorized, invoke the historical command twice for Gear List after the focused checks pass. Compare IDs, receipt bytes and both original anchors, and record the integrity outcome. No fixture test counts as real dossier revalidation.
