# ADR-0003: Organization domain boundary and governed issue lifecycle

- Status: Accepted as a design contract; not wired into application flows
- Date: 2026-09-28
- Scope: Organization/Harness roadmap Phase J only

## Context

Phases A–I provide a local portfolio, projects and profiles, deterministic signals, Today, project operating detail, work sessions, client commitments, durable tasks, and outcome feedback. The next roadmap needs organization-level language and workflow authority without creating a second task system, changing existing behavior, or turning the current single-user product into an enterprise platform.

The existing application is a local-first TypeScript modular monolith. `TaskRecord` and its event log represent execution/runtime state; profiles, signals, sessions, and commitments have their own persistence boundaries. Phase J defines how future organization concepts may relate to those capabilities. It does not add organization records, APIs, UI, migrations, or new runtime behavior.

## Domain vocabulary

| Term | Meaning | It is not |
| --- | --- | --- |
| `Company` | The single strategic root, `SURTEC`, for objectives and portfolio alignment. | A tenant, account boundary, identity provider, or multi-company abstraction. |
| `Objective` | A measurable desired outcome with success criteria and a review horizon. | A project, a task title, or an unmeasured aspiration treated as progress. |
| `Project` | An operational software initiative, linked to a discovered repository when applicable. Existing project discovery, registry, and `ProjectProfile` remain the integration boundary. | A new copy of repository metadata or a requirement that every experiment have a company objective. |
| `Issue` | A local, outcome-oriented, authorized unit of work with scope, acceptance, evidence, and a deterministic status. | Necessarily a GitHub Issue, an execution attempt, or a renamed `TaskRecord`. |
| `Execution` | An attempt to perform an issue through the existing task, orchestration, worktree, and Codex runtime capabilities. | A second runner, agent provider, or source of authorization. |
| `Evidence` | A bounded, attributable observation that supports a claim or transition, with source and time where available. | Agent narration, raw chain-of-thought, an unverified assertion, or automatically sufficient proof. |
| `Harness` | The governed execution contract assembled from applicable policy, role/context, repository instructions, sandbox, tools, budgets, and verification expectations. | A prompt dump, arbitrary instruction bundle, or alternative runtime. |
| `AgentRole` | A named Codex policy/context profile that selects permitted work and relevant guidance. | A separate agent process/runtime, provider, identity, or grant of authority. |
| `Routine` | A governed recurring read or proposal action with an explicit schedule, inputs, output, and action allowlist. | Unattended repository mutation, authorization, external publication, or a hidden worker service. |

Canonical work scale is `trivial | bounded | substantial`. Scale is a workflow-proportionality input, not an authorization, sandbox, or budget grant. Trivial work may use concise scope and proportionate checks; it must not inherit substantial-work ceremony by default. Substantial work requires durable scope, acceptance criteria, evidence requirements, and a next action. A classification or recommendation does not itself approve work.

## Authority and scope invariants

- The authorized issue scope is an immutable revision. It identifies the outcome and target, included and excluded work, acceptance criteria, evidence requirements, work scale, and applicable policy limits.
- New discoveries may be recorded as findings or scope-revision proposals. They cannot silently mutate the authorized scope. A material revision requires a new, explicit decision bound to that exact revision and a fresh policy evaluation.
- Agent output is untrusted evidence or a proposal. It cannot directly set issue status, approval, scope, or policy. The control plane may record a transition only after validating the event, evidence, current revision, policy, and required human approval.
- A transition event must be validated against the current status, expected revision, and unique event id. Unknown, stale, duplicate, out-of-order, or disallowed transitions fail closed without changing state.
- Material ambiguity, unauthorized scope change, exhausted budget, or conflicting evidence enters `needs-decision`; it never becomes success by omission or optimistic parsing.
- Review is bound to an immutable candidate fingerprint that includes the authorized scope revision, base/candidate content, verification profile, and evidence manifest. Any material change invalidates that review approval and requires a new candidate review.
- `ready-for-review -> done` records human acceptance of the exact verified candidate only. It does not authorize push, PR creation, merge, release, deployment, or any other external side effect. Existing task-publication approvals remain a distinct capability and boundary.
- Do not persist chain-of-thought. Persist concise decisions, evidence references, operational events, and the minimum summaries required to resume work.

## Intended dependency direction

Runtime flow:

```text
dashboard UI
  -> application use cases
    -> organization / portfolio domain policy
      -> ports
        -> file-first state and provider adapters
```

The application composition root supplies port implementations. Infrastructure may depend on port contracts; domain policy must not import React, Hono, Node filesystem/process APIs, Git subprocess code, provider SDKs, or Codex protocol details. Keep the current policy, task/orchestration, project/profile, signal, session, commitment, and integration boundaries and compose them through use cases. Do not build a parallel registry, task store, event log, Git layer, or execution runtime.

This is an intended boundary, not a claim that all current modules already follow it perfectly. Any later exception needs concrete evidence and a focused decision record.

## Workflow contract

Phase J's versioned transition catalog lives in [Issue lifecycle contract v1](../architecture/issue-lifecycle-v1.md) and its reference type/test implementation. The catalog identifies allowed status edges and, for each edge, the initiating actor, required evidence, policy gate, and approval basis. `human` and `control-plane` are the only transition initiators; Codex may provide evidence but is never a state-changing actor.

The catalog is a normative reference and pure guard only. It is not connected to existing task routes or persistence, and it does not implement later workflow behavior.

## Persistence and migration

Later organization state must extend existing file-first boundaries rather than create a parallel store. Persisted contract inventory, legacy version treatment, staged migration/rollback, quarantine, defaults, fixture compatibility, and backup requirements are specified in [Organization state migration contract](../architecture/organization-state-migration.md). No persisted schema is changed in Phase J.

## Consequences

- Future phases can connect organizational intent to existing project and execution capabilities while keeping authorization separate from model output.
- The single-company model avoids accidental multi-tenancy and identity scope.
- Evidence and immutable revisions make stale or scope-expanded approvals detectable.
- Proportional work scale preserves a lightweight path for trivial work while making substantial work auditable.
- Later workflow behavior must add durable event validation, actor/policy enforcement, and migration tests before exposing transitions in the UI.

## Rejected directions

- A second issue/task execution system: duplicates durable task orchestration and creates ambiguous ownership.
- A generic organization, tenant, or plugin framework: no current single-user requirement supports that complexity.
- Agent-role-specific runtimes or an alternative orchestrator: conflicts with the Codex App Server boundary in [ADR-0001](ADR-0001-codex-app-server-runtime.md).
- Treating review approval as publication approval: conflates evidence acceptance with external side-effect authority.
