# Spec Converge — Align Existing Code to a Reviewed Contract

Use only for brownfield work: migrations, existing-code adoption or resumed features. Load `.agents/specs/CONTRACT.md`, the affected spec and feature tasks completely. Do not use this to create retroactive approvals for completed phases.

1. Confirm the spec has actual human review, valid structure, no unresolved markers, and at least one executable reviewed acceptance check. Refuse draft/unapproved or waiver-only specs: there is no executable target to measure. Obtain prospective review first without changing approval status from this workflow.
2. After explicit human execution authorization, run `pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath <actual-spec-path>`. Report unavailable tooling as unavailable, not passed. Never silently skip unapproved checks or invoke commands through an unrestricted shell.
3. Record actual observed check results. Failing checks define a measurable delta; execution errors or missing tools are distinct from behavior failures. Do not infer that passing checks cover every requirement.
4. Audit relevant code and requirements for gaps no check covers. Propose additional acceptanceChecks and their requirement mappings for human review. Do not self-approve or modify designContract.status/review metadata; amendments return to spec-first review.
5. APPEND remaining work to the feature's tasks artifact, creating a draft if absent. Allocate new ids and real paths, dependency order and phase/check mappings. Never rewrite, remove or uncheck completed tasks or claim a historical step passed without evidence.
6. Present the measured delta and appended tasks for human review before implementation resumes. A discovered gap does not authorize implementation, migration, external publication or broader scope.

Output is the evidence-backed proposed delta, not changes to product code. Preserve all source state; no paid runtime or external write is part of ordinary convergence. A check waiver cannot turn unavailable executable evidence into a passing done gate.
