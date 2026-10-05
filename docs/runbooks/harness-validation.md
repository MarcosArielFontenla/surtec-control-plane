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

Execution preflights the entire selected spec, rejects unapproved/waiver-only specs, invokes explicit argument arrays without a shell evaluator, reduces inherited environment, discards raw child output and reports check ids/exit codes. Default timeout is 120 seconds per check (`-TimeoutSeconds` 1..900); timeout terminates the child process tree. The owner approved the explicit ceiling and exact validator/manifest repin in Phase O T014 after measuring a 678.53-second suite; this does not change test/runtime timeouts, checks or execution authority. On Windows a standard npm-installed pnpm launcher must resolve to its sibling `node_modules/pnpm/bin/pnpm.cjs`; unsupported launchers fail closed.

This is **not an OS sandbox**: trusted repository scripts, installed tools and transitive test/config code run with the current OS user's permissions. pnpm may internally use the platform shell for the fixed reviewed package script; the validator never evaluates free-form spec text. Review actual code/dependencies before execution; matching a package script string cannot attest all downstream code. A human metadata name or `-ConfirmExecution` flag cannot independently prove genuine approval. Preserve actual review and observed completion evidence in the task conversation; never treat a waived criterion as an executable pass.

## Failure evidence

Share the validator command, exit code, check id and sanitized error. For snapshot drift include the changed public skill/version and intended reviewed summary. For budget overflow share selected routes and additional public paths. Do not share normal state, credentials, auth files or raw child output. Fixtures use unique temporary roots and harmless version checks; no paid calls, sibling mutation or normal `state/` reads are needed.

## Git checkout portability - 2026-10-04

The owner explicitly approved this publication adjustment after the pre-push gate caught a stale snapshot on switching to master. Git stored the validation skill with LF, but its snapshot/manifest still referred to the previous CRLF bytes. Windows also converted six pinned PowerShell scripts to CRLF during checkout. The instructions, script content, versions, capabilities and execution permissions were unchanged; raw-byte trust correctly rejected the mismatches.

`.gitattributes` now keeps `.agents/scripts/*.ps1` in LF, preserving those six existing canonical script hashes. The validation skill's snapshot source hash and its two manifest entries were reviewed against the exact LF bytes; the registry pins the resulting manifest. The snapshot summary and skill version remain unchanged. This is an explicitly approved metadata repin, not automatic drift repair or a relaxation of full-file SHA-256 checks.

Two regression cases in `scripts/harness-foundations.test.ts` stage the real public canonical artifacts into a unique temporary Git repository and export them with `core.autocrlf=false` and `true`. Both require a trusted exported source, the same source fingerprint and exact bytes for every pinned artifact/registry/manifest. Hooks and local Git effects remain contained in the fixture, which is removed after a verified ownership/containment check. The initial two cases failed on the unavailable canonical source before the repair; the subsequent seven-suite repeat passed all 93 tests. Native `pnpm harness:check` and `pnpm typecheck` also exited 0, with unchanged three snapshot versions and all ten route ceilings.

`skill-creator` guided the metadata-only correction and behavioral regression. Its Python `quick_validate.py` was attempted with both system and bundled Python, but neither had PyYAML; those attempts failed and are not passes. No dependency was installed. Native PowerShell/YAML Harness checks validated the unchanged skill identities/descriptions/version/snapshot metadata and the current full-byte hashes. Product state, sibling repositories, runtime permissions and private local prompts remain untouched.

Fresh publication checks after the adjustment:

- `pnpm ci:check`: exit 0, 1701 tests / 122 files, 55 schemas, typecheck/build (1920 modules), repository/Harness/security/evaluation checks. All three snapshots and ten route ceilings remained valid; guarded whole-feature acceptance was not executed. The two checkout regressions are included in the full count.
- `pnpm smoke:local:playwright`: exit 0/PASS, real isolated API/dashboard, four fake turns, reload/API restart/session rotation and prior privacy/role/context/Harness/candidate/scope flows. Fixture `surtec-local-dashboard-6ZWoMr` reported browser_closed, vite_closed, api_stopped and workspace_removed all true, failures empty. No paid runtime or provider write occurred.
- Before pushing, verify the committed artifacts in a fresh local clone under both autocrlf settings and run the native Harness gate there. This checks checkout bytes, not only the original working directory. Keep this validation temporary and do not repin or auto-refresh normal project state to hide drift.

## Hidden-path CI repair - 2026-10-05

The current master run [37256047910](https://github.com/MarcosArielFontenla/surtec-control-plane/actions/runs/37256047910) failed before schema/test/type/build checks: `Validate Harness contracts` reported that `.agents` could not be found on Ubuntu. The directory is tracked. The shared resolver used `Get-Item` without `-Force` while inspecting existing path attributes; Unix dot directories are hidden. The same defect affected a hidden repository root. The owner authorized a contained CI repair, separately from drafting Phase P.

Only the two attribute-inspection calls in `common.ps1` add `-Force`. This includes hidden items in inspection; it does not permit linked paths, traversal, arbitrary commands or new execution. Existing `LiteralPath`, containment and `ReparsePoint` denials remain. Four portable fixture cases cover hidden artifacts/roots and explicit rejection of hidden artifact/root links. Unix uses dot directories; Windows marks only test-owned directories Hidden. Every case preserves fixture bytes, executes zero acceptance checks and asserts temporary cleanup.

Observed RED: four failed/35 filtered out, exit 1 (9.38 seconds); the failure is the missing hidden item or missing explicit link-denial message. Focused GREEN: four passed/35 filtered out, exit 0 (9.33 seconds). Complete native suite: 39 passed/no skips, exit 0 (88.00 seconds). No test/runtime timeout, catalog, skill, snapshot, capability, route ceiling, workflow trigger or product source changed. The repair repins only `common.ps1` and the enclosing manifest; the other 24 entries and manifest metadata remain unchanged. Future design/spec/task documents are unapproved proposals, not part of this repair.

Windows fixture acceptance is not an Ubuntu CI pass. Local Docker was unavailable and WSL had no supported test distribution; no daemon was started or Linux runtime installed. Record Linux/remote verification separately. Publication and PR creation require the owner's separate explicit authorization; the failing master run is not reclassified as green by local evidence.

Fresh repair-only local checks, before adding any Phase P proposal:

- `pnpm harness:check`: exit 0; three unchanged snapshots, ten unchanged route ceilings, three existing specs/task plans and zero acceptance checks executed.
- The four additional source/context/contract suites: 54 passed / four files, exit 0 (4.79 seconds). Independent read-only diff review found no blocking issue; the 25-entry manifest retained the other 24 exact pins.
- `pnpm ci:check`: exit 0 (598.99 seconds); 123 test files passed, 1820 tests passed and one explicit browser opt-in skipped, 55 schemas, typecheck/build (1922 modules), repository/Harness/security/evaluation gates. The skipped `App.test.tsx` isolated workflow browser acceptance requires `SURTEC_WORKFLOW_UI_BROWSER_SMOKE=1`; it is not a pass and this Harness-only repair does not change product UI/runtime behavior.
- `pnpm audit:check`: exit 0, no known vulnerabilities at this observation. No install or dependency/lockfile change occurred.
- `git diff --check`: exit 0. No normal state, sibling repository, live model, deployment or provider write was exercised. Product browser acceptance and the guarded Phase P done gate were not run.
