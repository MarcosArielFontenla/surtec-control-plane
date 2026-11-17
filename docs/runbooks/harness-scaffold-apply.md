# Apply a reviewed personal scaffold

Run the scaffold CLI from the Surtec Control Plane root. The project argument is an ID from `registry/projects.yml`. Surtec resolves its local checkout using the registered project policy. Use the ignored local `state/` directory or an explicitly configured private state root. The checkout needs an existing physical `.agents/templates` directory.

```powershell
pnpm exec tsx cli/surtec-scaffold.ts preview <project-id> personal@1
pnpm exec tsx cli/surtec-scaffold.ts apply <project-id> personal@1
pnpm exec tsx cli/surtec-scaffold.ts status <operation-id>
pnpm exec tsx cli/surtec-scaffold.ts rollback <operation-id>
```

## Preview and apply

1. Review the archetype, checkout and Git binding, Doctor observation, preserved entries, and exact additions in `preview`. The only eligible writes are the two pinned authoring templates. An absent template still tracked, staged, or ignored by Git is excluded from the effect list.
2. Before running `apply`, ensure exclusive access to the checkout and its local state for the mutation window. Coordinate editors, manual Git operations, and Surtec instances configured with other state roots. A cooperating worker or an unknown maintenance lock blocks the operation.
3. `apply` displays a fresh offer on stderr. Read it before typing the displayed `apply <apply-digest>` line. The exact line also confirms exclusive access. A different reply, EOF, or Ctrl+C cancels. Mutating commands require terminal input and an interactive stderr. They accept approval only in that terminal, with no flag or piped approval.
4. Keep the returned operation ID. The command verifies the preimage and saves the canonical bytes before publication. It returns a scoped verification receipt and the Doctor's own validation result. For example, scoped verification can pass while the Doctor's overall validation remains `unknown`.

## Status and rollback

Use `status` with the operation ID to read current evidence. The record is stored under `harness/scaffold-operations/<operation-id>/` in the configured state root. Use that directory name to recover the operation ID after an interruption. Preserve the records and escrow bytes while an operation is unresolved.

`rollback` presents a fresh, separate offer. Type the displayed `rollback <rollback-digest>` line after reviewing the current removal and absence decisions. The command only removes a proven creation whose bytes, file identity, recorded metadata, ownership evidence, physical parent, and Git binding still match. A replaced, edited, tracked, staged, or multiply linked file requires review. An interrupted removal can be reconciled as already absent through a fresh approved plan. Status and retries never replay an earlier apply. An unknown lock or unresolved file identity requires inspection before another mutation.

Commands produce one JSON result on stdout. Exit 0 denotes a successful preview, apply, rollback, or no-op. Exit 1 denotes a refused, unavailable, missing, or review-required result. Exit 2 denotes invalid invocation. `--help` prints the supported forms.

## Qualification and pilot

The development acceptance uses disposable registered Git trees, a synthetic policy registry, a copy of the reviewed canonical source, and a disposable state directory. The integration tests exercise the actual CLI entry point with pipes, the terminal adapter for approval and cancellation, and the native Git and filesystem lifecycle. The operation tests inject collisions, interrupted publication and rollback, and changed ownership or file metadata. The approved final gate runs `pnpm test`, `pnpm schemas:check`, and `pnpm typecheck` with a limit of 900 seconds per command.

The first real-project pilot requires a separate decision after qualification. Review one registered checkout, its exact fresh preview and the exclusive mutation window before approving an apply. The disposable rollback acceptance covers the removal mechanism and allows a pilot to retain its delivered templates.

### T004 acceptance on 2026-11-16

**The Phase R scaffold application increment passed qualification.** The native Git fixtures covered subprocess preview, refusal of piped approval, exact terminal confirmation for apply and rollback, read-only status, and refusal when an addition had been staged. The accepted rollback restored the original file and Git metadata inventory. The in-process terminal adapter supplied the simulated operator responses. The templates and canonical source were verified against pinned bytes.

| Check | Observed result |
| --- | --- |
| Focused CLI, application, journal, checkout and original preview acceptance | 69 tests passed in 6 files |
| CLI and application acceptance rerun after correcting JSON result typing | 17 tests passed in 2 files, typecheck exit 0 |
| `ac-behavior` / `pnpm test` | Exit 0 |
| `ac-schema` / `pnpm schemas:check` | Exit 0 |
| `ac-types` / `pnpm typecheck` | Exit 0 |

The guarded [specification](../../.agents/specs/harness-scaffold-operation.spec.yaml) executed all three approved checks with a 900-second limit per command. The sequence completed in 903.26 seconds total with no waiver. Disposable directories and the dedicated TEMP/TMP root were removed and verified absent. The Windows run also created a literal `%SystemDrive%` scratch directory in the checkout. Its creation time and four shell-cache databases were verified before removing that directory. No real checkout was used for application. The [completed task plan](../../.agents/specs/tasks/phase-r-archetype-apply.tasks.md) records the closure.

### Phase R pilot closure on 2026-11-16

**The `personal@1` pilot passed on `stock-control-mvp`, closing the approved Phase R scope.** The project owner approved the exact preview and confirmed 30 minutes of exclusive access. The fresh preview matched the approved fingerprint before the interactive apply. The two approved additions were `.agents/templates/entity.spec.yaml` and `.agents/templates/feature.tasks.md`.

The sealed operation recorded `verification: passed`. A separate read-only CLI `status` returned `applied`. Both files matched their approved SHA-256 digests, `AGENTS.md` and the Git index retained their original hashes, and the branch and HEAD matched the preimage. The destination contained zero operation staging files after verification. The templates remain in place. The sealed receipt and recovery bytes remain in ignored local state. The real checkout had no rollback, commit, or push. Rollback was exercised in the disposable T004 fixtures.

**Doctor limitation.** The global inventory hit the 128-entry cap (`entry-count`). Inventory coverage was `partial` and overall validation remained `unknown`. Scoped verification covered the two exact template paths and the preserved root primer. The complete project Harness inventory remains unverified, and the existing Doctor limits and scaffold guards still apply.

### After Phase R

The next roadmap phase is **Phase S — Organizational EVALs and learning loop**. The proposed first increment is an inventory of existing offline EVALs and a deterministic check in a disposable fixture that verifies a non-mutating Doctor and scaffold preview. Extend coverage to the other organizational checks, role golden cases, and outcome feedback in subsequent slices. Additional archetypes, generated-file updates and obsolete-file reconciliation remain outside the completed pilot scope.
