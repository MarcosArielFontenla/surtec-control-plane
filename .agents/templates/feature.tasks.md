---
spec: .agents/specs/placeholder.spec.yaml
feature: placeholder
status: draft
createdAt: null
reviewedBy: null
approvedAt: null
---

# Tasks — replace scaffold before human review

This is a template, not an approved feature or runnable done gate.
Fill dates from actual drafting/review; never fabricate earlier approvals.

## Phase 1 — define behavior and verification

<!-- maps to: ac-001; replace with real ids from the feature spec -->
- [ ] T001 Define the behavior and focused test -> replace with real target paths.
- [ ] T002 (depends: T001) Implement the verified behavior -> replace with real target paths.

## Done gate

After explicit human execution authorization: `pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/<entity>.spec.yaml`.
Do not mark done until all executable checks pass and human-only waived criteria are reported.
Add `[P]` only for genuinely independent tasks targeting different files; it grants no delegation authority.
