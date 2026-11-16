# Local issue recovery and sealed adoption

## Factory F2 manual request identity and recovery

The current manual create contract adds durable request identity to the existing local issue. It does not authorize the issue, dispatch a task, approve a plan or publish anything. The browser creates one UUID for a deliberate pending form attempt, keeps the submitted body in memory for explicit retries, and stores only that UUID under `surtec.work-issue.pending-request.v1` in `sessionStorage` for this tab.

| Observed outcome | Next action and expected behavior |
| --- | --- |
| Confirmed create or identical retry | The UI identifies the confirmed issue and clears its pending UUID. The issue may already have later progress if this is a replay; it is not reset to `proposed`. A subsequent deliberate form submission may create a new identity. |
| Response lost, malformed or not bound to the submitted UUID/project | Keep the pending intent. New creation and edits to its frozen form are blocked. Use **Reintentar mismo pedido** for an explicit retry of the same UUID and body still held in memory, or **Comprobar pedido pendiente** for a read. No automatic POST or identity rotation occurs. |
| Browser reload | Only the UUID survives. The view reconciles through the existing validated issue GET; it does not resend a body or invent one. A matching receipt confirms the current issue. The previous private form body cannot be recovered for retry from sessionStorage. |
| Failed/incomplete read, no matching issue, or unavailable/invalid stored identity | The outcome remains visibly uncertain and new creation stays blocked. A missing result is not proof that persistence never happened. Check again explicitly; do not create another request merely because the prior issue is absent from this observation. |
| Deliberate cancellation of uncertainty | Check **Entiendo que el pedido podría existir; cancelar este intento no lo elimina.** before **Cancelar intento pendiente**. Cancellation closes only the local pending intent; it deletes no server issue and creates no replacement automatically. A later explicit new UUID represents another request and can create duplicate content intentionally. |

An unavailable identity store or a changed stored UUID does not silently unlock creation. Do not clear browser storage or edit local issue JSON as a recovery shortcut. Retain the pending state and inspect the available safe evidence; a confirmed server result and successful local identity closure are separate facts.

For manual HTTP callers, supply `request_id` as a lowercase hexadecimal UUID in 8-4-4-4-12 form with the original create payload. The server owns `intake_receipt`; callers cannot provide it. Missing/invalid identity returns `400`. Under current access/input checks and the issue lock, an identical normalized request with that UUID returns the same current issue; a different valid normalized request or project with the same UUID returns `409`. Keep the same key and original payload for a later explicit retry after a lost response or lock conflict. Never substitute a new UUID to hide a conflict. Distinct UUIDs permit identical content; title matching is not deduplication.

Both new creation and replay preserve the existing HTTP `201` plus `{ issue }` response. Use issue/receipt identity and unchanged aggregate bytes/audit/revisions in isolated tests to prove replay, rather than interpreting `201` as another creation. The fingerprint binds the original normalized input, not the issue's mutable current state. Historical issues without a receipt remain readable without backfill; malformed or future receipts fail closed. See the [F2 compatibility addendum](../architecture/organization-state-migration.md#factory-local-f2-additive-manual-intake-compatibility) before any rollback decision.

API restart rotates the local session token and loses pending context-preview issuance; durable issue receipts remain in the aggregate. New mutations still require current session authority. Dispatch additionally requires a fresh explicit preview and the current human scope/consent/plan decisions. Configured verification commands shown in a preview are not executed passing evidence, and request/source text grants no capabilities.

The [Factory request contract acceptance runbook](factory-request-contract-acceptance.md) separates observed T002-T006 focused results from the unexecuted full smoke/final gate and the human real-pilot checkpoint. Its commands are procedures for separately authorized execution, not instructions to start T008 during documentary T007. Repeatable local acceptance is automated against synthetic state; normal user state, sibling repositories and paid runtime are outside that fixture. Report a failed/unknown native result and stop without automatic reruns, guard/timeout changes or cleanup outside the fixture's explicitly authorized ownership.


## Prepare a sealed candidate for human review

Use this local operation when an issue is in **Needs decision**, its original governed write attempt has stopped, and the same project already has an isolated committed candidate and its sealed verification report. It prepares a private review package while the issue and workflow continue to reflect the original attempt. A retained staged tree without a sealed commit and report requires the existing human decision.

Keep the two original UTF-8 files under `tmp/sealed-adoption/dossiers/<dossier-id>/` as `seal.json` and `report.json`. Use the digest of the exact seal bytes independently recorded by the owner for the issue and scope. The command accepts the F5 sealed report v1 from the current policy's single pinned verifier command. The verifier pins and contract must be available locally and bind the project, approved base and permitted paths. Use the original report bytes including whitespace.

The seal is a closed JSON record. Supply `schema_version` (1), `project_id`, `issue_id`, `issue_revision`, `scope_revision`, `scope_sha256`, `workflow_id`, `stage_id`, `task_id`, `run_id`, `plan_sha256`, `review_policy_sha256`, `testing_policy_sha256`, `base`, `commit`, `tree`, `report_sha256` and `verifier_pins_sha256`. Use the original workflow scope, approved plan, review policy and grant testing fingerprints, the Git object IDs, and SHA-256 of the exact report and verifier pin manifest. Seal construction is an operator step based on already recorded evidence.

```powershell
pnpm exec tsx cli/surtec-sealed-adoption.ts prepare --issue-id '<issue-id>' --expected-revision '<revision>' --dossier-id '<dossier-id>' --seal-sha256 '<seal-sha256>'
```

| Exit | Result | Operator action |
| --- | --- | --- |
| 0 | `READY_FOR_HUMAN_REVIEW` | Open `tmp/sealed-adoption/reviews/<package-id>.json` beside the private dossier. Repeating the exact command rechecks the evidence and returns the same ID when it still matches. |
| 1 | `REFUSED` | Check the named binding, including `TREE_MISMATCH` for Git content or `REPORT_SHA256_MISMATCH` for report bytes. Resolve drift through the issue's human decision. |
| 2 | `UNKNOWN` | Inspect unavailable, changing, incomplete or conflicting evidence before proceeding. Retain earlier receipts for inspection. |

Record Reviewer findings, QA when the package requires it, and the owner's decision per criterion in the private dossier. Each decision references the same package ID, commit, tree and report SHA-256. Run `prepare` again immediately before recording a decision to revalidate those bindings. If the ID changes, review the changed evidence before recording the decision. Use the existing issue and publication gates for their respective decisions. The command uses already captured verification evidence.

The command reports its elapsed time. Record active setup and review time and human interventions separately when measuring a real use. See the [approved design](../proposals/factory-local-sealed-adoption-design.md) and the [F5 rehearsal](factory-local-f5-pilot-review.md#next-bounded-increment-for-review).


## Revalidate the historical Gear List acceptance

Use the historical command for the Gear List F5 dossier and its original local acceptance. Supply the two fingerprints from the independent owner record. Surtec reads the original stopped attempt, the human adoption record, the separately committed candidate and its correction, the stored verification, and the Reviewer, QA and owner evidence.

```powershell
pnpm exec tsx cli/surtec-sealed-adoption.ts prepare-historical --profile gear-list-f5 --seal-sha256 <owner-seal-sha256> --acceptance-sha256 <owner-acceptance-sha256>
```

Exit 0 with `HISTORICAL_ACCEPTANCE_REVALIDATED` returns the receipt ID under `tmp/sealed-adoption/historical-reviews/<receipt-id>.json`. The command rechecks the original evidence even when it returns an existing receipt. The receipt includes the original decision date and criteria and records preparation time separately. Exit 1 reports a proved mismatch. Exit 2 reports missing, changing or conflicting evidence. Keep the historical sources and any conflicting output available for inspection.

Use the daily `prepare` operation for candidates awaiting human review. The historical receipt documents an existing local acceptance and carries no execution, integration or publication authority. See the [historical design](../proposals/factory-local-historical-adoption-design.md) and the [F5 closure evidence](factory-local-f5-pilot-review.md#evidence-and-disposition).
