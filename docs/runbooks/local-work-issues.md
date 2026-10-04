# Local Work Issues

## Source of truth

`state/issues/issues.json` is the local operational source for work issues, scope revisions, review candidates, evidence references, and issue audit events. The document is schema-versioned and updated under the `issues` state lock with an atomic replacement. It is bounded to 500 issues, 1,000 candidates, 5,000 evidence references, and 20,000 audit events. External references are pointers only; the Control Plane does not copy issue content to a provider or synchronize provider state.

The Issue screen keeps the existing GitHub inbox in a separate read-only section. A local issue is never inferred from an external issue. Credentials detected in issue fields and references are rejected before persistence; runtime evidence is redacted before it is recorded.

## Execution lineage and admission

`WorkIssue -> TaskRecord -> TaskEvent(run_id, attempt) -> ReviewCandidate -> IssueEvidenceReference` is queryable from `GET /api/work-issues/:id`. Work sessions are linked by their existing task associations and commitments remain references by local ID. The task record remains the durable task/request and latest attempt summary; append-only task events preserve each execution attempt and run identity.

Issue-linked write tasks carry an internal issue ID and exact scope revision in task metadata. The generic task request body cannot set this trusted metadata. Manual retry of an issue-linked task is rejected; after a blocker or decision, the owner must resume the issue and admit a new linked task. Automatic lease recovery continues to use the existing task orchestration semantics.

The existing orchestrator admits at most one active workspace-write task per project while allowing permitted read-only analysis to coexist. Its global scheduling lock coordinates local workers, and expired task leases are recovered before new claims. The issue state lock admits at most one active task owner for a given issue. There is intentionally no manual concurrency-override endpoint; stale ownership must be resolved through the existing lease recovery and explicit issue workflow.

## Scope and review gates

The generic `POST /api/tasks` path is reserved for `read-only` analysis. Workspace writes must be created through a local issue, explicitly authorized against its current scope revision, and dispatched through the issue workflow. The dashboard task form disables write modes and points users to Issues; the API returns `409` if a direct write is attempted.

Classification is deterministic and inspectable. High criticality, migration/security impact, sensitive change categories, or more than two affected domains route work to `substantial`, which requires a durable plan, at least two acceptance criteria, and a next action. Other narrow work is `trivial` or `bounded`; classification does not itself authorize execution.

An issue starts `proposed`. A human authorizes the exact stored scope revision before dispatch. Before the runner commits, staged changed paths are compared against allowed and excluded repository-relative glob patterns. Out-of-scope changes stop before commit, become a bounded evidence-backed proposal, and move the issue to `needs-decision`. Approval creates a new scope revision; discovery never changes the current authorization.

Each committed issue execution creates a review candidate bound to the base revision, candidate commit, changed paths, scope revision, and SHA-256 fingerprint. A newer candidate invalidates the previous candidate. Verification and human review evidence bind to the exact candidate revision, fingerprint, and scope. Only an unchanged candidate with passing verification and explicit confirmation of all acceptance criteria can be marked done through the local issue route. This local acceptance never pushes a branch or opens a PR; the existing task-review publication controls remain separate.

## Local validation

Run `pnpm smoke:local:playwright` for actual API + Vite + Playwright acceptance with a test-only injected executor. It uses temporary public runtime source, synthetic repositories/state, real managed worktrees/commits/verification, objective/task/session lineage, candidate review, scope approval/rejection, negative gates, responsive layout and restart persistence. External reads are stubbed; cleanup removes only the fixture. No model turn runs. See `docs/runbooks/phase-l-acceptance.md` for current evidence and open regressions.

Optional real-project/paid-runtime exploration (not required Phase L acceptance; separate explicit authorization is needed):

1. Open Issues and create a proposal for a project whose registry policy permits workspace-write for the selected role. Define the expected outcome, acceptance criteria, allowed paths, excluded paths, change categories, and explicit exclusions.
2. Confirm the displayed work scale/rationale. Substantial work must have a plan and next action. Create leaves the issue proposed; authorize the exact scope only when it matches the intended work.
3. Dispatch the linked task. The task runs through the existing policy, isolated worktree, lease, verification, and task-event runtime. No provider operation is part of this flow.
4. Inspect the issue lineage. A passing verification creates a ready-for-review candidate. Confirm the commit, fingerprint, changed paths, scope revision, and each acceptance criterion before local acceptance.
5. If an out-of-scope path is discovered, verify there is no commit for that attempt. Review the recorded path proposal; approve it as a new revision only if intended, otherwise reject and cancel the issue.
6. Reload the browser and, if useful, restart only the local API. Issue, candidate, event, and evidence references should remain readable from the versioned local document.

For failures, capture the failing `pnpm` command and output, the issue ID/status/revision, linked task ID, and the bounded evidence/candidate IDs shown by the local API. Do not attach credentials, task logs containing secrets, private keys, or unrelated repository files.
