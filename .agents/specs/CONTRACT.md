# Spec-First Contract v1

H3 activates the procedural workflow for new work meeting either trigger: a new primary entity, or a feature touching at least two real domains. Small single-domain changes do not require a spec/task artifact. The approved H1-H4 Harness bootstrap continues under its existing plan.

## Authority and legacy boundary

- Specifications live at `.agents/specs/<entity>.spec.yaml`; feature tasks live at `.agents/specs/tasks/<feature>.tasks.md`. Templates are not active specs or evidence of approval.
- Historical specs and plans under `docs/superpowers/` and `docs/roadmap/`, and already implemented phases, are exempt from retroactive gates. Do not add fake approvals, timestamps or contracts to them.
- The gate applies when a legacy spec is materially amended for a new triggered feature. Draft the prospective delta; do not approve past implementation retrospectively. Validation of unchanged Phase L work is not a new feature approval.
- The agent drafts; the human approves the exact proposed spec and tasks before implementation. A roadmap approval is not approval of every later design. Preserve the approval evidence in the task conversation; never infer it from a passing test or a metadata field.
- Material changes to approved requirements, checks, scope, dependencies or task targets require renewed human review. Propose the change explicitly; do not silently change approval metadata or implement the broadened scope.

## Specification shape

Use `.agents/templates/entity.spec.yaml` and `.agents/contracts/spec.schema.json`. `schema_version: 1` versions this Harness document, not product storage or API contracts.

| Field | Meaning |
| --- | --- |
| `name`, `entity`, `domains`, `purpose` | Concrete entity, real affected domains and intended behavior |
| `requirements` | Stable ids and observable requirements; no invented historical evidence |
| `constraints`, `nonGoals` | Ownership, security, compatibility and explicit exclusions |
| `designContract.status` | `placeholder`, `proposed`, or `approved`; no automatic promotion |
| `reviewedBy`, `approvedAt` | Human review evidence; null until actually approved |
| `acceptanceChecks` | Stable id, requirementIds, description, reviewed command, expectedExitCode |
| `checksWaiver` | Null, or reason, approvedBy and date for genuinely non-executable criteria |
| `clarifications` | Append-only answered questions: date, question, answer, affects |

First generation derives check descriptions from requirements and uses `command: placeholder`; do not invent runnable commands. Promotion to proposed requires drafted checks. Approval requires executable checks or a complete justified waiver, actual human review, and zero unresolved clarification markers. A waiver does not approve shell access or make a placeholder executable.

Mark genuine ambiguity inline as `[NEEDS CLARIFICATION: question]`. Maximum five markers; more means the intent needs human clarification before further drafting. Resolve one question at a time, ordered scope -> behavior -> data -> edge cases, log the human answer, and remove its marker in the same edit. Never resolve a marker by assumption.

## Tasks and completion

Use `.agents/templates/feature.tasks.md`. Task status is `draft`, `approved`, `in_progress`, or `done`, independently of spec status. Human review precedes implementation; metadata alone cannot establish that review.

- Each task has a stable id, real target paths, and explicit dependencies. A future target may not exist yet; that is not a pre-implementation failure.
- Models precede services and endpoints; tests are written before or alongside the behavior. Each phase maps to existing acceptanceCheck ids.
- `[P]` means independent tasks with different files and no dependency edge. It never authorizes subagents or external effects.
- The done gate runs all executable approved checks and reports observed exit codes and any human-waived criteria separately. Missing tooling, skipped/failed checks or unreviewed deltas cannot become `done`.
- Preserve completed tasks and their evidence. Append a reviewed delta for resumed work; keep task history rather than deleting or archiving it without authorization.

## H3/H4 enforcement boundary

H4 supplies `.agents/scripts/validate-spec.ps1`, guarded `-Run -ConfirmExecution -SpecPath`, raw-marker scanning, calendar dates, unique ids, requirement coverage, contained paths and CI integration. `validate-tasks.ps1` checks concrete task syntax and references. Use the documented exact command catalog; human approval and fresh done evidence remain independent of structural validation.

The schema cannot prove human authority, raw YAML marker absence, path safety or command safety. A command string is data, never authorization to execute it. Do not use an unrestricted shell evaluator. Convergence requires runnable reviewed checks, not merely an approved metadata flag or waiver-only spec.
