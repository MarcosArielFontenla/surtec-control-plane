---
version: 1.3.0
lastUpdated: 2026-09-29
role: artifact-registry
---

# Harness Artifact Registry

This is the artifact registry, not the session primer. Sessions enter through the repository-root `AGENTS.md`; mandatory policy and routing are always loaded. Read this registry when maintaining the Harness.

## Foundation inventory

| Artifact | Role | Status |
| --- | --- | --- |
| `AGENTS.md` | Session primer, maximum 40 lines | Operational |
| `.agents/policies/project.md` | Mandatory ownership, safety, workflow and delivery rules | Operational |
| `.agents/orchestration/ROUTING.md` | Task-scoped loading of real artifacts | Operational |
| `.agents/skills/local-dashboard-validation/SKILL.md` | Isolated real API/browser acceptance workflow | Operational v1.1.0 |
| `.agents/skills/agent-execution-safety/SKILL.md` | Dispatch, scope, sandbox, protocol and attempt ownership | Operational v1.0.0 |
| `.agents/skills/file-state-contracts/SKILL.md` | Versioned state, locks, schema invariants and safe migration | Operational v1.0.0 |
| `.agents/cold-start/budget-manifest.yaml` | Ten task classes, complete skill/document reads and extra-load accounting | Enforced by PowerShell and repository tests |
| `.agents/cold-start/snapshots/` | Three hand-authored supplemental skill summaries | Exact version/hash/line checks; new-draft-only scaffolder |
| `.agents/specs/CONTRACT.md` | Prospective spec/task approval and historical exemption rules | Procedural workflow active from H3 |
| `.agents/contracts/spec.schema.json` | Versioned structural spec contract | Structural and semantic guards; human authority remains external |
| `.agents/templates/entity.spec.yaml`, `.agents/templates/feature.tasks.md` | Unapproved scaffold templates | Not active specs/tasks or execution authority |
| `.agents/workflows/` | Specify, clarify, tasks and brownfield convergence | Selected workflows with guarded executable gates |
| `.agents/scripts/` | Structure, snapshots, context, spec/task validation and opt-in checks | Operational; no arbitrary shell evaluation |
| `docs/architecture/execution-runtime.md` | Product-specific runtime and stack contract | Operational |
| `docs/architecture/harness-v5.2-adaptation.md` | Approved adaptation scope, rule mapping and readiness | Maintained audit document |

## Activation boundaries

- H1: primer, mandatory policy, routing and preservation map.
- H2: three domain skills, versioned supplemental snapshots and context manifest are present. The full skills are mandatory; snapshots are optional additions.
- H3: prospective spec-first review, task decomposition and convergence workflows are active for triggered work. Templates stay unapproved; historical phases are not retro-approved or blocked.
- H4: executable validators, invalid fixtures and CI integration are operational; execution is separate explicit opt-in.
- Skill drift evaluation: inactive until sufficient real skill evaluations exist; product evaluations are distinct.
- Multi-agent contracts and projections: inactive until an authorized concrete workflow exists.
- Telemetry: inactive pending explicit activation; no fabricated events or measurements.

## Portability boundary

Keep orchestration rules independent of runtime vendors. Product runtime constraints and archived optional interface metadata belong in product documentation, not core rules. Skill version/snapshot fields live under supported `metadata`; inactive drift has no dangling rubric pointer.

Do not label manually maintained content auto-generated. PowerShell checks and synthetic fixtures enforce declared contracts, not runtime context measurement or human approval. Operational instructions live in `docs/runbooks/harness-validation.md`.
