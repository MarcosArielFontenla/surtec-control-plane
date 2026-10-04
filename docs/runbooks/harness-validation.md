# Harness Validation

## Prerequisites and repeatable checks

Use PowerShell 7 (`pwsh` on PATH), Node >=20, installed pnpm and `powershell-yaml` **0.4.12**:

```powershell
Install-Module powershell-yaml -RequiredVersion 0.4.12 -Scope CurrentUser
pnpm harness:check
pnpm exec vitest run scripts/harness-validators.test.ts
pnpm ci:check
```

Missing tooling fails; tests are not silently skipped. CI installs the pinned YAML module and runs the same Harness gate. The module is an external prerequisite, not a pnpm dependency. CI uses PSGallery; a future supply-chain pin/vendor review is independent work.

The default gate checks the <=40-line primer, portable core, concrete registry references, full-source skill hashes/versions, <=25-line snapshots, ten context profiles, draft spec template and prospective active spec/tasks. No active artifacts means zero validated artifacts, not evidence of feature completion. Historical documentation and scaffold templates are not retro-approved. No acceptance command runs by default.

## Context and snapshots

```powershell
pwsh -NoProfile -File .agents/scripts/validate-budget.ps1 -TaskClasses dashboard-workflow -ExtraArtifacts dashboard/src/ui/api.ts
pwsh -NoProfile -File .agents/scripts/generate-snapshots.ps1 -Check
pwsh -NoProfile -File .agents/scripts/generate-snapshots.ps1 -Scaffold -SkillName file-state-contracts -OutputPath .agents/cold-start/draft.snapshot.md
```

Selected routes are unioned and deduplicated. Count additional documents/code/snapshots explicitly; over 500 physical lines requires scoped decomposition, never omitted mandatory reads. This is not runtime token measurement. Scaffolding creates only a new draft; it refuses overwrite. Draft TODO content is not a valid canonical snapshot. Human compression/review and explicit replacement remain necessary; source skills and hashes are never automatically rewritten.

## Prospective spec/tasks and execution

```powershell
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1
pwsh -NoProfile -File .agents/scripts/validate-tasks.ps1
# Only after approval of this exact contract AND authorization to execute:
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/example.spec.yaml
```

Approved specs need valid dates, zero raw clarification markers (including comments), unique ids, known requirement references, coverage or a complete waiver, and exact catalog commands. Tasks use `## Phase ...`, `<!-- maps to: ac-001,ac-002 -->` and `- [ ] T001 (depends: T000) Description -> lib/path.ts, scripts/path.test.ts`; dependencies must reference earlier tasks. Paths may be future files but cannot traverse or use links/junctions. Parallel markers require disjoint independent targets. Structural task validation does not execute checks, attest approval, verify historical completion evidence or automatically mark done.

The executable catalog is `node --version`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm schemas:check`, `pnpm secrets:check`, `pnpm repository:check` and `pnpm evals:check`. Case, arguments and package script implementations must match exactly; pre/post hooks are rejected. New commands need a reviewed code/catalog change, not a YAML edit. Paid runtime, live canary, browser smoke, install, push, deployment and arbitrary shell commands are excluded. Run those separately only under their own approved workflow.

Execution preflights the entire selected spec, rejects unapproved/waiver-only specs, invokes explicit argument arrays without a shell evaluator, reduces inherited environment, discards raw child output and reports check ids/exit codes. Default timeout is 120 seconds per check (`-TimeoutSeconds` 1..600); timeout terminates the child process tree. On Windows a standard npm-installed pnpm launcher must resolve to its sibling `node_modules/pnpm/bin/pnpm.cjs`; unsupported launchers fail closed.

This is **not an OS sandbox**: trusted repository scripts, installed tools and transitive test/config code run with the current OS user's permissions. pnpm may internally use the platform shell for the fixed reviewed package script; the validator never evaluates free-form spec text. Review actual code/dependencies before execution; matching a package script string cannot attest all downstream code. A human metadata name or `-ConfirmExecution` flag cannot independently prove genuine approval. Preserve actual review and observed completion evidence in the task conversation; never treat a waived criterion as an executable pass.

## Failure evidence

Share the validator command, exit code, check id and sanitized error. For snapshot drift include the changed public skill/version and intended reviewed summary. For budget overflow share selected routes and additional public paths. Do not share normal state, credentials, auth files or raw child output. Fixtures use unique temporary roots and harmless version checks; no paid calls, sibling mutation or normal `state/` reads are needed.
