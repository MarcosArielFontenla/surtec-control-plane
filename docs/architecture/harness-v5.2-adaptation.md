# Harness V5.2 Adaptation

## Authority and scope

The user approved the H1-H4 adaptation scope on 2026-09-29: Codex only for development, PowerShell 7 validators, portable core, preserved project rules, conditional system activation, then resumed Phase L verification. This is approval of the adaptation scope, not retrospective approval of historical specs or skill proposals.

This is a brownfield bootstrap from the supplied V5.2 prompt, template, and migration guide. The inherited V3.1/V4 documents were not supplied; complete legacy-format compliance is not claimed. External source templates remain untouched. No commit, push, merge, deployment, paid runtime call, or sibling-project mutation is authorized by this adaptation.

## Preservation map

| Previous root section | Canonical destination | Required loading |
| --- | --- | --- |
| Purpose and modular-monolith constraints | `.agents/policies/project.md`, Purpose and architecture | Every task |
| Language | `.agents/policies/project.md`, Language | Every task |
| Repository boundaries and ownership | `.agents/policies/project.md`, Ownership and authorization | Every task |
| Stack and sole runtime | `docs/architecture/execution-runtime.md` | Architecture/implementation and runtime routes |
| File-first state, discovery and module boundaries | `.agents/policies/project.md`, Purpose and architecture | Every task |
| Runtime source of truth, stable protocol and model configuration | Policy safety section plus `docs/architecture/execution-runtime.md` | Policy always; runtime contract for affected changes |
| Sandboxes, approvals, protocol fakes, opt-in real smokes, structured output and no raw chain-of-thought | `.agents/policies/project.md`, Agent execution safety | Every task |
| Baseline, reversible slices, tests, phase boundaries and required commands | `.agents/policies/project.md`, Development workflow | Every task |
| Automated real API/browser acceptance and isolated fixtures | Policy plus existing validation skill | Policy always; full skill for affected changes |
| Nine-item phase delivery | `.agents/policies/project.md`, Delivery format | Every task |

## Milestones and honest readiness

| Milestone | Scope | Readiness |
| --- | --- | --- |
| H1 | Compact primer, registry, mandatory policy, routing, preservation map | Implemented; see delivery for verification evidence |
| H2 | Preserve validation skill, add runtime/persistence skills, version metadata, snapshots, manifest | Implemented; see delivery for verification evidence |
| H3 | Spec-first contracts, clarify/tasks/converge workflows, legacy exemptions | Implemented; historical exemptions preserved |
| H4 | PowerShell 7 validators, fixture tests, guarded check execution, CI integration | Implemented; local verification recorded below |

Repository tests and native PowerShell validators verify snapshot identity/version/full SHA-256/line limits, routing/manifest consistency, declared context sizes and prospective contracts. H4 supplies a new-draft-only scaffolder and explicitly confirmed exact-catalog acceptance checks. Structural validity cannot attest human approval or completion evidence. Full skill reads remain mandatory. The 500-line manifest is a design-time proxy, not runtime token counts or externally injected instructions.

Existing product evaluations do not count as skill drift history. Skill drift remains inactive until sufficient real runs exist; no baseline is fabricated. Multi-agent workflows and telemetry remain inactive.

## Portability adaptations

- Product-specific stack/runtime names live outside `.agents/`; core rules refer to the product runtime contract.
- H2 preserves the validation workflow while replacing vendor-specific wording. Synthetic tasks through protocol fakes remain allowed; real dispatch and paid calls remain opt-in.
- Version, snapshotPath, snapshotVersion and driftStatus live under the supported skill `metadata` mapping rather than unsupported additional top-level fields. A future driftPolicyPath will point to a real rubric only when that system activates; no dangling pointer, fake baseline or empty rubric is introduced now.
- The optional native UI metadata was relocated unchanged from `.agents/skills/local-dashboard-validation/agents/openai.yaml` to [its archive](harness-adapters/codex/local-dashboard-validation.interface.yaml). This is a recoverable documentation archive, not an automatically loaded adapter. The skill still has name/description/instructions at its discoverable location; the custom display label/default prompt are no longer supplied by native UI metadata. No invocation policy or tool dependency existed in the relocated file.
- Official [Build skills documentation](https://learn.chatgpt.com/docs/build-skills) confirms repository discovery through `.agents/skills`, complete reads of selected SKILL.md files, and optional agents/openai.yaml appearance/dependency metadata. The installed skill-creation validator accepts `metadata` but rejects the template's extra top-level fields; this is an explicit compatibility adaptation, not a claim that unmodified V5.2 examples pass native validation.
- No adapter is required for the current development tool's native root entry point. No unused vendor adapter or subagent projection is generated.
- The root primer enforces complete policy and selected skill reads; snapshots will remain supplemental where full reads are mandatory.
- Snapshots are hand-authored summaries, limited to 25 physical lines including frontmatter, with exact source-file SHA-256. Existing `.gitattributes` enforces LF for Markdown. H4 checks them and scaffolds only new drafts; it never automatically compresses or replaces reviewed summaries.
- The manifest counts the primer, mandatory policy and routing in every class, full skill bodies, required product documents and stated conditional references. It excludes neither full skills in favor of summaries nor mandatory architecture references. It does not count arbitrary code/spec/workflow reads, optional snapshots or host/system skills automatically: add those actual reads and decompose if necessary. Union multi-domain routes with unique paths; no per-class pass is proof that a combined route fits.
- Issue acceptance and lifecycle-contract review are separate declared classes because their combined context exceeds the budget. Splitting work must retain the mandatory policy and domain requirements in every slice; never bypass a required read to claim compliance.
- The V5.2 examples are not copied as arbitrary command executors. H4 preflights the whole selected spec, requires explicit execution confirmation and uses a code-defined exact catalog. It is not an OS sandbox; trusted repository code still requires review.

## Phase L follow-up

After Harness completion, validate the latest unverified Phase L authorization changes, run `pnpm ci:check` and `pnpm smoke:local:playwright`, and close uncovered issue lifecycle, scope, persistence/restart, review and negative-path acceptance criteria with isolated tests and protocol fakes. Do not present earlier passing commands as evidence for edits made afterward.

## H3 contract decisions

- H3's procedural activation applies to new triggered work from this delivery, not historical features, plans or already implemented phases. The authorized Harness bootstrap remains under its approved H1-H4 plan. No historical document is rewritten or promoted to approved.
- `.agents/specs/CONTRACT.md` defines exact spec/task locations, prospective review, maximum five clarification markers, logged human answers, requirement/check mappings, concrete paths, dependency order, safe parallel markers and append-only convergence deltas. Neither a YAML status nor a passing validator can establish human approval.
- The templates intentionally start at placeholder/draft with null review metadata. They are stored outside the active specs/tasks namespace and contain no fabricated runnable commands or real approvals. Tasks are retained as history; archival/deletion is not automatic.
- The structural contract `.agents/contracts/spec.schema.json` uses schema_version 1, checks nested types/unknown fields, and requires approved review metadata plus executable checks or a complete waiver. Requirement mappings extend the supplied check shape to support coverage and future cross-reference validation.
- H3 tests compile this schema and evaluate synthetic in-memory cases only. Product `pnpm schemas:check` still checks the 38 product schemas; the Harness schema is separately compiled by its focused tests. H4 will wire the explicit Harness validators into CI rather than claiming the product checker already scans `.agents/`.
- H4 implements raw YAML marker scanning, actual calendar dates, duplicate ids, cross-reference coverage, path containment, exact command checks and explicit execution opt-in. Structural validity never grants shell access. Convergence refuses unapproved or waiver-only specs and cannot report unavailable tooling as a passing gate.
- The two new context profiles account for the selected contract, templates and workflows. Actual spec/task/schema/code reads are additional; union/decomposition rules still apply. Existing skills/snapshots are unchanged.

## H2 verification checkpoint

- `pnpm exec vitest run scripts/harness-foundations.test.ts scripts/harness-context.test.ts`: 23 tests passed across two files, including source hash/version drift and multi-route overflow.
- `pnpm ci:check`: 90 test files / 618 tests passed; 38 schemas valid; secret scan passed for 1040 repository files; product coverage 36/36, expectations 42/42 and outcome expectations 8/8; typecheck and build passed (1917 modules).
- The skill-creation `quick_validate.py` accepted all three skill folders. Both existing Python environments lacked PyYAML, so PyYAML 6.0.3 was installed only into a unique task-owned temporary directory for this check. That directory was removed and cleanup verified; no global Python or project dependency was changed.
- All eight declared profiles fit within 500 lines; additional reads and combined profiles still require explicit accounting. Repository tests do not prove skill selection quality or replace the planned H4 PowerShell checks.
- `git diff --check` passed, with the pre-existing line-ending warning for OrganizationView. No user state, sibling repository, paid runtime, commit or push was involved. No browser smoke was needed for this instruction-only phase; Phase L browser acceptance remains pending.
- At H2 delivery, H3 was next. Drift evaluation, telemetry and multi-agent systems remained inactive; no approval, metric, baseline or event was fabricated.

## H3 verification checkpoint

- Baseline: the existing H1/H2 focused suites passed 23 tests before edits. No product implementation or historical spec/plan was changed during H3.
- `pnpm exec vitest run scripts/harness-foundations.test.ts scripts/harness-context.test.ts scripts/harness-spec-contract.test.ts`: 48 tests passed across three files, including structural invalid cases and all ten declared context profiles (135-481 lines at verification).
- Native PowerShell 7 `Test-Json` accepted the draft template, rejected an unreviewed approved document, and accepted a complete synthetic reviewed document. All values remained in memory; no acceptance command was executed.
- `pnpm ci:check`: 91 files / 643 tests passed; 38 product schemas valid; secret scan passed for 1049 files; product coverage 36/36, expectations 42/42 and outcome expectations 8/8; typecheck and build passed (1917 modules). The separate Harness schema was compiled by its tests and native structural smoke, not counted as a 39th product schema.
- `git diff --check` passed with the pre-existing OrganizationView line-ending warning. No install/lockfile change, paid runtime, user-state migration, browser smoke, commit or push was needed for this Harness-only phase.
- Added files: `.agents/specs/CONTRACT.md`, `.agents/contracts/spec.schema.json`, `.agents/templates/entity.spec.yaml`, `.agents/templates/feature.tasks.md`, `.agents/workflows/spec-first.md`, `.agents/workflows/spec-clarify.md`, `.agents/workflows/spec-tasks.md`, `.agents/workflows/spec-converge.md`, and `scripts/harness-spec-contract.test.ts`.
- Updated files: root `AGENTS.md`, `.agents/AGENTS.md`, `.agents/orchestration/ROUTING.md`, `.agents/cold-start/budget-manifest.yaml`, this adaptation record, `scripts/harness-foundations.test.ts`, and `scripts/harness-context.test.ts`. Existing skills and snapshots stayed unchanged.
- H4 is next: implement the documented PowerShell checks and guarded execution, test negative fixtures, and integrate into CI. H3's procedural human gates are not a claim that these executables already exist or that every future spec is safe to run.

## H4 verification checkpoint

- Baseline: 48 Harness tests across three files passed before H4 edits. PowerShell 7.6.5 and powershell-yaml 0.4.12 were already installed; no module/global dependency installation was needed locally.
- Added native structure, snapshot, budget, spec and task validators, exact-catalog execution, reduced environment, output discard and process-tree timeout. Scaffolding is new-draft-only; reviewed snapshots/skills are unchanged. The file-state-contracts skill guided version/reference and invalid-fixture coverage, without touching product state.
- The first native fixture run caught an exit-code stream pollution defect (20/21 passed). It was fixed; the focused four-file suite then passed 70 tests. The final full run includes two further native cases for malformed/commented YAML and environment/timeout behavior: 23 native cases, 71 total Harness tests.
- `pnpm ci:check`: 92 test files / 666 tests passed; 38 product schemas valid; secret scan passed for 1058 repository files; product coverage 36/36, expectations 42/42, outcomes 8/8; typecheck and build passed (1917 modules). Harness schema compilation/semantic checks are separate from the 38 product schemas.
- Native `pnpm harness:check` passed all three snapshots and ten individual context profiles. Actual union/additional reads still require explicit accounting and decomposition; no runtime token measurement is claimed. There are zero active specs/tasks, which is not feature completion evidence.
- An explicitly authorized direct catalog smoke ran `pnpm typecheck` through the safe Windows launcher and returned exit 0, without creating an active approval/spec. Fixtures executed only harmless local runtime checks; no paid runtime call was made.
- CI now installs the pinned YAML parser and runs `pnpm harness:check`. The remote Ubuntu workflow has not been dispatched; local Windows results do not claim remote execution. Standard npm-installed pnpm launchers are supported on Windows; unsupported layouts fail closed. The external parser/PSGallery supply-chain boundary remains documented, not vendored or cryptographically pinned by this phase.
- `git diff --check` passed with the pre-existing OrganizationView line-ending warning. No dependency/lockfile change required a new install. No user state/sibling repository, browser smoke, commit, push, merge or deployment was involved. Native fixtures clean up their unique temporary roots.
- Added files: `.agents/scripts/common.ps1`, `.agents/scripts/check-harness.ps1`, `.agents/scripts/generate-snapshots.ps1`, `.agents/scripts/validate-budget.ps1`, `.agents/scripts/validate-spec.ps1`, `.agents/scripts/validate-tasks.ps1`, `scripts/harness-validators.test.ts`, `docs/architecture/harness-adapters/portability-policy.json`, and `docs/runbooks/harness-validation.md`.
- Updated files: `AGENTS.md`, `.agents/AGENTS.md`, `.agents/orchestration/ROUTING.md`, `.agents/specs/CONTRACT.md`, `.agents/templates/feature.tasks.md`, all four `.agents/workflows/` documents, `scripts/harness-foundations.test.ts`, `scripts/harness-context.test.ts`, `package.json`, `.github/workflows/ci.yml`, `README.md`, and this adaptation record. Earlier product/Phase L changes remain preserved.
- Repeat locally in order: `pnpm harness:check` (all declared checks OK; zero acceptance executions by default), then `pnpm ci:check` (all gates passed). No manual UI step is required for H4. Share the command, exit/check id and sanitized error if a check fails; do not share normal state or credentials. See the Harness validation runbook for prerequisites and guarded execution.
- H1-H4 adaptation is complete. Next is integral Phase L acceptance with the real isolated API/browser smoke and protocol fakes, not a new Harness milestone. Skill drift, multi-agent systems and telemetry remain inactive. Structural validators cannot attest genuine human approval, task history or fresh done evidence; trusted local checks are not an OS sandbox.
