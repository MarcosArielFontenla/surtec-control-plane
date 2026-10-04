# Spec-First Workflow

Load `.agents/specs/CONTRACT.md` completely when executing this workflow. Use it for a new primary entity or a feature affecting two or more real domains; otherwise use the ordinary scoped development workflow.

1. Specify: inspect the affected code, schemas, registries, tests and historical evidence. Copy the entity template into a prospective spec. Record requirements, constraints and non-goals; derive acceptance descriptions and leave commands as `placeholder` initially.
2. Clarify: execute `.agents/workflows/spec-clarify.md` for genuine ambiguities. Resolve every marker with a human answer; do not invent answers to accelerate approval.
3. Propose: wire real repeatable local checks to requirement ids, document any genuinely non-executable waiver, and present the complete prospective contract/diff for human review. Shell permissions remain independent of design approval.
4. Approve: only after explicit human approval of this exact proposal, record reviewedBy/approvedAt and the approved state. If the proposal changes materially, seek renewed review before implementation. Never promote based on a validator result alone.
5. Tasks: execute `.agents/workflows/spec-tasks.md`; obtain human approval of the ordered, path-specific delta before implementation.
6. Implement: follow the approved tasks and relevant domain skills, add tests alongside behavior, and stop at each authorized phase boundary. New scope or ambiguous requirements return to human review.
7. Done gate: structurally validate first; then execute every approved, runnable check through the guarded H4 interface and compare observed exit codes. Report waived criteria separately. Do not mark done on skipped checks, unavailable tooling or fabricated evidence.
8. Existing-code adoption: use `.agents/workflows/spec-converge.md` to append a measured delta. It never rewrites completed tasks or retro-approves old contracts.

H4 provides PowerShell validation and explicitly confirmed check execution; no implementation is authorized by an embedded command, passing validator or template.
