# Task Routing

Always load `AGENTS.md` and `.agents/policies/project.md` before this document. Select every applicable route; a cross-domain change loads the union, not one arbitrary route.

| Task class | Required artifacts (complete reads) | Focused evidence |
| --- | --- | --- |
| harness-maintenance | `.agents/AGENTS.md`, `docs/architecture/harness-v5.2-adaptation.md` | Use the available skill-creation workflow when creating/updating skills; no unrelated domain load |
| architecture-implementation | `docs/architecture/current-architecture.md` | Affected modules, registries, schemas, tests; add relevant domain routes |
| agent-runtime-safety | `.agents/skills/agent-execution-safety/SKILL.md`, `docs/architecture/current-architecture.md`, `docs/architecture/execution-runtime.md` | Also load `docs/security/threat-model.md` for security work; follow runtime-contract references as needed |
| persistence-migration | `.agents/skills/file-state-contracts/SKILL.md`, `docs/architecture/current-architecture.md`, `docs/decisions/ADR-0002-file-first-durable-orchestration.md` | Also load `docs/architecture/organization-state-migration.md` for compatibility/migration work |
| dashboard-workflow | `.agents/skills/local-dashboard-validation/SKILL.md`, `docs/architecture/current-architecture.md`, `docs/runbooks/local-development.md` | Actual local API/browser smoke plus focused fixtures; add persistence/runtime routes when affected |
| local-issues-acceptance | All three domain skills, `docs/architecture/current-architecture.md`, `docs/architecture/execution-runtime.md`, `docs/decisions/ADR-0002-file-first-durable-orchestration.md`, `docs/runbooks/local-work-issues.md` | Issue authorization, scope, execution, review, reload/restart and negative-path tests; select the lifecycle route for contract changes |
| issue-lifecycle-contracts | State and dashboard skills, `docs/architecture/current-architecture.md`, `docs/decisions/ADR-0002-file-first-durable-orchestration.md`, `docs/runbooks/local-work-issues.md`, `docs/architecture/issue-lifecycle-v1.md` | Compare historical design to current schemas/service tests; lifecycle changes add runtime safety and may require sequential slices |
| explanation-status | Only the applicable domain documents and code | Read-only checks; no inferred authorization to implement; add domain routes when their skill applies |
| spec-first-planning | `.agents/specs/CONTRACT.md`, `.agents/templates/entity.spec.yaml`, `.agents/templates/feature.tasks.md`, `.agents/workflows/spec-first.md`, `.agents/workflows/spec-clarify.md`, `.agents/workflows/spec-tasks.md` | New primary entity or multi-domain feature; load the actual spec/tasks and count their additional context |
| spec-convergence | `.agents/specs/CONTRACT.md`, `.agents/workflows/spec-converge.md` | Existing-code prospective delta only; actual reviewed spec/tasks/checks are additional required reads |

## Loading discipline

- Read selected skills completely. Do not replace mandatory reads with snapshots.
- Load the relevant entity spec when one exists; report missing or outdated evidence instead of inventing approvals.
- Historical plans and specs under `docs/superpowers/` and `docs/roadmap/` are evidence, not proof of current implementation.
- Load a workflow only when executing it. Do not preload telemetry, eval histories, decision logs, skill indexes, or unrelated domains.
- The three H2 skills are operational. Supplemental snapshots are hand-authored summaries, not substitutes for full skills; load them only when useful and count them additionally if loaded.
- `.agents/cold-start/budget-manifest.yaml` lists full skills and routed documents, including stated conditional references. Union selected routes and deduplicate paths; if over 500 lines, split the work into sequential scoped slices, never skip mandatory rules. Additional specs/code/workflow reads consume extra context and may require further decomposition. H4 enforces declared physical-line budgets, not runtime token counts.
- H3 activates spec-first review workflows for new triggered work, with historical exemptions in the contract. Do not retroactively block historical phases or claim those gates already ran. H4 validates structure and guarded checks, not human authority; unavailable tooling cannot count as a pass.
- Multi-agent orchestration, skill drift evaluation, and telemetry are inactive. A parallelizable task marker does not authorize delegation.
