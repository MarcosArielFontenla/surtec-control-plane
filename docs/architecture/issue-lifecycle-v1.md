# Issue lifecycle contract v1

Status: Normative Phase J design baseline and transition reference. Phase L now uses this vocabulary and envelope guard in its local issue workflow; this catalog alone does not prove every designed edge has a production endpoint. Current implementation and acceptance are documented in `docs/runbooks/local-work-issues.md` and `docs/runbooks/phase-l-acceptance.md`.

## Canonical vocabulary

```ts
type WorkScale = "trivial" | "bounded" | "substantial";

type IssueStatus =
  | "proposed"
  | "authorized"
  | "working"
  | "checking"
  | "needs-decision"
  | "ready-for-review"
  | "done"
  | "blocked"
  | "cancelled";
```

`WorkScale` describes proportionate process, not permission. Trivial work must not be given substantial-work ceremony merely by default. Substantial work needs durable scope, acceptance criteria, evidence requirements, and a next action before authorization. Bounded work uses explicit scope and acceptance proportional to its risk. No scale bypasses project policy, sandbox, budget, or required approval.

`IssueStatus` describes local issue intent and decisions, not a replacement for `TaskRecord.lifecycle`, task outcome, Codex turn status, work-session status, or GitHub status. Phase L links those records while preserving their owners; new mappings must continue to respect that boundary.

## Transition contract

Every accepted transition is initiated by a `human` or the `control-plane` after validation. Codex/agent output can supply evidence or a proposal, but it is never a transition actor. `Approval basis` names the authorization that must exist before the event is accepted; `none` means no new human approval is needed for that edge, not that scope or policy checks may be skipped.

| From → To | Event | Actor | Required evidence | Policy decision | Approval basis |
| --- | --- | --- | --- | --- | --- |
| proposed → authorized | `scope-authorization-recorded` | human | Exact issue content and immutable scope-revision fingerprint, including outcome, in/out scope, acceptance, evidence, scale, and target. | Validate project/role eligibility, required fields for scale, applicable policy, and budget feasibility. | Human approval of that exact scope revision. |
| proposed → cancelled | `proposal-cancelled` | human | Proposal id and cancellation reason. | Actor may decide this proposal; no execution is admitted. | Explicit human cancellation. |
| authorized → working | `execution-admitted` | control-plane | Current issue/scope revision, execution/task id, selected role, and attempt identity. | Revalidate current policy, target, sandbox/capabilities, concurrency, and budgets before dispatch. | Existing authorization for the exact current scope revision; no broader approval. |
| authorized → blocked | `dependency-blocked` | control-plane | Verifiable blocker reference, observed time/source, and next action. | Confirm the blocker prevents safe progress and no permitted action resolves it. | None to record the block; explicit human authorization is required to resume. |
| authorized → needs-decision | `authorization-stale` | control-plane | Specific changed policy, target, scope, budget, ambiguity, or conflicting evidence. | Fail closed; do not dispatch using stale authorization. | Human decision is required to leave `needs-decision`. |
| authorized → cancelled | `issue-cancelled` | human | Issue id and cancellation reason. | Confirm the request targets this issue and prevent a new execution admission. | Explicit human cancellation. |
| working → checking | `candidate-produced` | control-plane | Completed execution identity, immutable candidate fingerprint, and collected verification/evidence references. | Confirm the attempt still owns the execution, candidate is within authorized scope, and required verification has run. | Current scope authorization; no completion/review approval is implied. |
| working → blocked | `execution-blocked` | control-plane | Concrete external/dependency blocker, source/time, and next action. | Confirm safe work cannot continue; stop or pause execution as applicable. | None to record the block; human authorization is required to resume. |
| working → needs-decision | `decision-required` | control-plane | Exact ambiguity, proposed scope change, budget exhaustion, or conflicting evidence. | Reject unauthorized expansion and stop affected work safely. | Human decision is required to resume or revise scope. |
| working → cancelled | `execution-cancelled` | human | Explicit cancellation request and runtime cancellation/cleanup evidence when applicable. | Validate the active issue/execution binding and cancellation procedure. | Explicit human cancellation. |
| checking → ready-for-review | `verification-passed` | control-plane | Candidate fingerprint, required test/check results, evidence manifest, and scope comparison. | Deterministic done-gate passes for the exact candidate and current scope revision. | None to request review; human review/acceptance is still required for `done`. |
| checking → working | `bounded-correction-authorized` | control-plane | Failed check findings and the candidate they describe. | Correction budget remains; proposed edits stay inside the exact authorized scope and policy. | Existing scope authorization; no new scope authority. |
| checking → blocked | `verification-blocked` | control-plane | Verifiable unavailable dependency or required verifier and a next action. | Confirm completion cannot be evaluated safely yet. | None to record the block; human authorization is required to resume. |
| checking → needs-decision | `verification-needs-decision` | control-plane | Missing/conflicting evidence, material scope delta, or exhausted correction/budget limit. | Do not downgrade evidence requirements or infer success. | Human decision is required to exit. |
| checking → cancelled | `issue-cancelled` | human | Issue id and cancellation reason; stop/cleanup evidence if an execution is still active. | Validate target and cancellation procedure. | Explicit human cancellation. |
| needs-decision → authorized | `decision-recorded` | human | Decision rationale and exact retained or revised scope-revision fingerprint. | Re-evaluate policy and budget against the chosen target and revision; a material change is a new revision. | Human decision plus explicit approval of the exact revised scope when it changed. |
| needs-decision → cancelled | `decision-cancelled` | human | Decision record and cancellation reason. | Confirm the issue is not admitted for new work. | Explicit human cancellation. |
| ready-for-review → done | `candidate-accepted` | human | Review and required QA evidence bound to the exact current candidate fingerprint and scope revision. | Confirm all acceptance/evidence gates pass and candidate has not changed since review. | Human approval of this exact immutable candidate only. |
| ready-for-review → working | `bounded-rework-requested` | human | Review findings and fingerprint of the rejected candidate. | Correction allowance remains and requested work is inside the current authorized scope. | Human rework decision under the existing scope authorization; any candidate approval is invalidated. |
| ready-for-review → needs-decision | `review-escalated` | human | Specific scope, evidence, policy, or budget issue found during review. | Fail closed; no candidate can be accepted while the issue is unresolved. | Human decision required to exit. |
| ready-for-review → cancelled | `issue-cancelled` | human | Issue id, review context, and cancellation reason. | Confirm cancellation is allowed and no new execution is admitted. | Explicit human cancellation. |
| blocked → authorized | `blocker-resolved` | human | Evidence the blocker is resolved, current scope revision, and intended next action. | Revalidate target, policy, and remaining budgets before new dispatch. | Explicit human resume authorization for the current exact scope revision. |
| blocked → needs-decision | `blocker-conflict-found` | control-plane | Conflicting blocker evidence, changed scope, or newly discovered risk. | Preserve the block and ask for a human decision; do not infer resolution. | Human decision required to exit. |
| blocked → cancelled | `blocked-issue-cancelled` | human | Issue id, blocker context, and cancellation reason. | Confirm the target issue and prevent further execution admission. | Explicit human cancellation. |

Any edge not in this table is forbidden. `done` and `cancelled` are terminal in v1; a reopened body of work requires a new issue or a later, explicitly versioned policy change, not a hidden terminal-state rewrite.

## Candidate and scope binding

An authorization revision must be immutable. A review candidate fingerprint should bind at least the issue id, authorized scope revision, base revision, candidate content/diff, verification profile, and evidence manifest using canonical serialization and a cryptographic digest. Review approval is valid only while every bound input matches. A content, base, scope, verification-profile, or evidence change creates a different candidate and invalidates prior approval.

Discoveries may be appended as evidence or a proposed scope revision. They may not edit the approved scope in place. Budget exhaustion, ambiguity, material scope expansion, and conflicting evidence route to `needs-decision`; they cannot be resolved by agent narration.

## Event acceptance guard

The Phase J reference implementation in `lib/organization/issue-lifecycle.ts` exposes the closed vocabularies, transition metadata, and a pure envelope guard. The guard only checks event identity, expected revision, current source status, and whether the edge exists in v1. It does not mutate/persist state, authenticate a human, validate evidence, decide policy, or consume approval. A future use case must do those checks before it records an event and must update state atomically with its event/revision contract.

Duplicate event ids, stale expected revisions, wrong source status, invalid ids/revisions, and unknown edges are rejected without mutation. `issue-lifecycle.test.ts` locks these reference invariants. These tests validate the design catalog, not a production workflow.

## External-effect boundary

No issue transition in this version grants push, PR creation, merge, release, deployment, external messaging, or another repository mutation. `candidate-accepted` is evidence/issue acceptance only. Existing task publication remains governed by its separate explicit approval and implementation boundary.

## Versioning

Changes to status meanings, allowed edges, actor/evidence/policy/approval requirements, terminal semantics, or scope/candidate binding require an explicit lifecycle version change and migration/compatibility review. Do not silently reinterpret v1 persisted events or approvals as v2.
