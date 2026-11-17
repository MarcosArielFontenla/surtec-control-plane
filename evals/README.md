# Agent evaluation suites

The report evaluation suites under `evals/vN/` use structured synthetic fixtures. Commands recorded in those fixtures are treated as data.

Run the mandatory offline gate with:

```text
pnpm evals:check
```

This runs both `v1` policy/contract coverage and the pinned `surtec-outcome-golden-v2` suite. The v1 runner validates manifests and fixtures against JSON Schema, contains paths under the suite directory, expands cases across declared task types, and checks positive coverage against `registry/agents.yml`. V2 retains the same hard-failure evaluator and adds observable checks for required report sections, evidence references, changed-file scope, tests, verification, risks, actionable next steps, and prohibited side effects.

Verdicts are:

- `pass`: required checks pass and the weighted score meets the suite threshold;
- `fail`: deterministic quality or scope evidence is insufficient;
- `hard-fail`: a security or policy invariant is violated, or required evidence is absent, regardless of score.

The golden cases are synthetic examples, not copied client tasks. Do not add private client content, credentials, real prompts, or user-specific paths. When adding a role or task type to the registry, add positive fixture coverage to v1. When the evaluation contract changes incompatibly, create a new versioned suite rather than silently changing historical fixtures.

## Deterministic organizational cases

After v1 and v2, the offline gate runs [`org.harness.read-only`](../scripts/organizational-harness-read-only.test.ts). It calls the Doctor read service and the scaffold preview CLI against a registered disposable Git project. Each operation must produce the expected observation and preserve the fixture inventory, including the checkout, Git metadata, canonical source and isolated state location. Controls prove that the comparison detects a persistent addition, a same-byte overwrite and a transient file via its parent directory metadata. The check observes file effects at operation boundaries. A missing observation, a changed inventory or unverified cleanup fails the gate.

[`org.objective.ancestry`](../scripts/organizational-objective-ancestry.test.ts) calls the production organization state reader against schema-valid synthetic files. It accepts an eight-level chain and rejects a missing parent, self-parent, multi-objective cycle and ninth level for their respective ancestry errors. Each read must preserve the saved bytes and fixture inventory, and the check verifies cleanup of its disposable directory.

[`org.issue.cycles`](../scripts/organizational-issue-cycles.test.ts) calls the production issue reader with schema-valid synthetic files. It accepts a parent tree and acyclic blocker graph with a shared dependency. It rejects self-loops and transitive cycles with the corresponding parent or blocker error. Each read must preserve the saved bytes and fixture inventory, and the check verifies cleanup of its disposable directory.

[`org.execution.permitted-role`](../scripts/organizational-execution-role.test.ts) exercises the production role policy during preview and execution of a governed analysis task. An allowed role reaches a fake read-only executor once. Missing or unknown roles prevent task admission. Revoking the queued task's role permission holds it for review before executor, worktree, commit or verification effects. The check uses disposable policy and state, and verifies cleanup.

[`org.role.permission-ceilings`](../scripts/organizational-role-permissions.test.ts) calls the production policy resolver against disposable registries. It verifies the exact read and write tool sets, then checks denials for project sandbox and verification limits, the global agent sandbox and task-kind limits, and an unsupported role sandbox. Policy resolution must preserve the prepared registry bytes and create no task or worktree state.

[`org.issue.required-approval`](../scripts/organizational-issue-approval.test.ts) exercises the production preview, issue service and task writer against disposable state. Missing and blank scope approvals preserve the proposed issue and leave the queue empty. Explicit approval of the current scope is recorded before one bound write task is queued. The EVAL ends at admission and verifies fixture cleanup.

[`org.context.budget-overflow`](../scripts/organizational-context-budget.test.ts) exercises the production context assembler and governed prompt builder in memory. The assembler accepts complete context at the exact UTF-8 byte, physical line and distinct-source limits, then rejects an excess of one in each dimension. The prompt builder applies the byte and line limits to the complete developer and user texts, including profile guidance and the prior summary.

[`org.context.confidential-consent`](../scripts/organizational-confidential-context-consent.test.ts) exercises the production client resolver, preview, task admission and context reconstruction in disposable state. Confidential notes require explicit category consent. With that selection, the notes appear in the admitted instructions and reconstructed context, while the preview, manifest and audit expose only metadata. Removing consent invalidates the issued preview and creates no task or events. The check preserves the client and profile files and verifies fixture cleanup.

[`org.issue.completion-evidence`](../scripts/organizational-issue-completion-evidence.test.ts) exercises governed issue admission, verification and local acceptance in disposable state. A reported pass without a captured receipt holds the issue for a decision. Losing the receipt after verification blocks acceptance even with an explicit gap acknowledgment. Exact passing evidence and explicit confirmation of every criterion allow completion and persist the candidate-bound approval. The denied attempts preserve saved issue and task bytes, and the check verifies checkout preservation and fixture cleanup.

[`org.execution.active-write-checkout`](../scripts/organizational-active-write-checkout.test.ts) exercises two production scheduler instances sharing disposable state and real managed Git worktrees. One writer and a reader can run together while a second writer for the same project stays queued without a claim or checkout, even when another worker has free capacity. After the first lease closes, the second writer can start while the inactive checkout remains registered. The check preserves the source checkout and verifies worker, worktree and fixture cleanup.

[`org.execution.budget-overrun`](../scripts/organizational-execution-budget.test.ts) drives the production scheduler and runner with a fake executor in disposable state. Exact token usage completes without a duplicate debit, usage above the cap aborts with the full observed count retained, and the runtime deadline aborts without an automatic retry. Transient failure can retry within the admitted attempt budget, and exhausted token or attempt budgets also deny manual retry without changing the saved task or events.

[`org.routine.prohibited-action`](../scripts/organizational-routine-prohibited-action.test.ts) exercises the routine service, state reader and fixture-owned runner with disposable state and a fake evidence reader. A valid refresh completes with one accounting charge and zero model, workspace, proposal or report effects. The service rejects publication and caller-supplied commands before updating configuration. The runner rejects a saved prohibited action before resolving policy or reserving budget. Denials preserve the saved routine bytes and fixture inventory.

[`org.harness.source-integrity`](../scripts/organizational-harness-source-integrity.test.ts) exercises the source loader, Doctor and registered scaffold preview on disposable Git fixtures. The reviewed source yields a matching fingerprint and a pinned template addition. A changed source entry or a byte-level change to the manifest makes canonical comparison unavailable and prevents any partial scaffold plan. Each observation preserves the fixture inventory and file hashes, and the check verifies cleanup.

[`org.harness.scaffold-ownership-conflict`](../scripts/organizational-scaffold-ownership-conflict.test.ts) drives registered preview and apply in disposable Git checkouts. An unresolved user-owned conflict is preserved and excluded from the effect set. Apply can create an independently approved template, and its sealed preimage and escrow bind that addition. A missing path with user ownership is refused before approval. The check verifies preserved file identity and bytes, Git metadata and fixture cleanup.

[`org.issue.invalid-transition`](../scripts/organizational-issue-transition.test.ts) exercises the issue service in disposable state and the pure v1 lifecycle guard. The service records exact scope authorization and rejects stale revisions, reauthorization, a working-to-authorized jump and attempts to resume or resolve a decision on a proposed issue. The proposed issue remains eligible for authorization at its original revision. Denials preserve the issue and related task files and events. The pure guard rejects every destination from both terminal states. The check verifies the checkout and fixture cleanup.

## Optional live canaries

The live canary command is not part of CI and skips without explicit opt-in. It uses exactly two pinned read-only cases against `fixtures/evals-canary`, refuses execution when `CI` is set, verifies both offline suites before running, snapshots the fixture before and after, and reports only status, runtime, and token usage. It does not print model output or estimate monetary cost. Usage notifications trigger an abort at 3,000 tokens per request; because the runtime reports usage asynchronously, a notification can arrive after some usage has already accrued. Each turn is capped at two minutes and the suite at five minutes.

To intentionally run the two real turns in PowerShell:

```powershell
$env:SURTEC_LIVE_CANARIES = "1"
pnpm run evals:canary -- --confirm-live-canaries
Remove-Item Env:SURTEC_LIVE_CANARIES
```

The command can consume model quota. Automated tests use a fake executor; no live call is required for ordinary development or CI.
