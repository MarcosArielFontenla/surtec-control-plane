# Current architecture
## Product boundary
Surtec Control Plane is a local modular monolith. It discovers sibling Git repositories, overlays trusted project configuration, records local task state, and exposes safe operational actions through one dashboard.
## Modules

- `dashboard/src/ui`: React views and project controls.
- `dashboard/src/server`: Hono API and infrastructure adapters for Git, GitHub, deployment health, Railway, dependencies, and local open actions.
- `lib/policy`: the canonical typed policy boundary for project, agent, sandbox, task-type, repository, command, and approval configuration.
- `lib/context`: bounded attributed assembly, routing/testing requirements and validation of infrastructure-owned testing receipts; context text never grants capabilities.
- `lib/security`: shared identifier, canonical path-containment, environment-allowlist, and redaction primitives.
- `lib/integrations`: versioned project-integration contracts, runtime validation, URL safety, and bounded error normalization.
- `lib/state`: schema-validated file-first task, project, signal, profile, work-session and optional workflow state with locks, atomic replacement writes, and append-only task events.
- `lib/workflows`: five finite templates, review/budget/correction policy, strict role outputs and candidate-bound evidence validation; no execution scheduler.
- Other `lib` modules: discovery, Git status, portfolio derivation, and URL helpers.
- `runner`: durable task scheduling, agent execution, worktrees, verification, process management, review publication, and startup reconciliation.
- `registry`: trusted project, agent, logical-role, context-policy and Harness-source configuration.
- `schemas`: persisted and structured-output contracts.
## Data flows
### Portfolio overview

1. Discover depth-one Git repositories under `SURTEC_PROJECTS_ROOT` or the control plane's parent directory.
2. Read local Git status with a short cache.
3. Overlay matching registry metadata.
4. Combine task state and project overrides into the overview model.
5. Poll the API from the dashboard.
### Agent task

1. Explicitly preview an analysis, authorized issue or finite workflow; reassemble its issued request/source/consent/policy binding before task persistence. Workflow approval reserves server-owned stages/intents; implementation additionally needs exact plan/scope approval. API and CLI cannot supply their own manifest or grant.
2. The API returns without executing a task in the handler. `TaskOrchestrator` remains the sole worker; its injected `WorkflowOrchestrator` reconciles committed intents and finite successors, with no second scheduler or runtime.
3. Under the scheduler lock, the worker enforces global capacity and per-project write exclusion, then atomically claims the task with a unique run id and expiring lease.
4. Re-resolve policy and admitted context before each attempt; reject changed sources, scope, consent or capabilities before model/worktree effects. A v2 stage also requires a live controller identity, exact grant/intent/lease and durable attempt charge; legacy retries need new governed dispatch.
5. For a write task, create or safely reuse its isolated Git worktree and managed `agent/` branch.
6. Invoke `AgentExecutor` through local Codex App Server `stdio`; a persisted thread requires the same context, prompt version, execution mode, repository, verification commands and output contract. Strict TDD observes trusted RED before the implementation turn.
7. Persist concise lifecycle events, thread/turn identifiers, cumulative usage, lease heartbeats, and the current task snapshot. Cancellation reaches App Server through `turn/interrupt`.
8. Commit edits and capture exact configured verification while the lease remains owned. Acceptance requires a functional or ordered strict-TDD receipt bound to candidate/scope/policy; workflow writers stay `checking` through required candidate-tree Reviewer/QA receipts, not model-authored success claims.
9. Validate bounded structured output and finish the task. Supported non-workflow transient failures may retry within budgets; v2 never uses generic retry/requeue. Unknown interrupted usage stops its workflow for human review, not a replacement attempt.
10. Independently authorized publication/reject cleanup is available only outside active workflow ownership. Workflow acceptance never publishes, and stopping retains candidate trees/evidence. The publication state machine persists effect checkpoints for idempotent resumption.
### Durable orchestration

- Task JSON is the authoritative current snapshot; `state/events/<task-id>.jsonl` is append-only operational history.
- A per-task cross-process lock serializes claim, cancel, retry, heartbeat, recovery, and completion. Atomic replacement protects each snapshot.
- A short global scheduler lock makes the configured concurrency bound and project-write exclusion consistent across local worker processes.
- A stale run id cannot publish progress or a terminal result after its lease was replaced.
- Startup leaves current leases alone; eligible non-workflow expired leases requeue within budgets. V2 recovery retains identities and finishes expired runs as `needs-review`; unknown usage blocks progression. Unknown worktrees remain report-only.
- See [ADR-0002](../decisions/ADR-0002-file-first-durable-orchestration.md) for the persistence boundary and migration threshold.
### Review publication

1. Revalidate current policy and retained workflow task/tree ownership before any decision, Git or cleanup effect; missing/unavailable ownership fails closed.
2. Persist `approving` or `rejecting` with an attempt count.
3. Approval pushes once, records that checkpoint, finds an existing open PR before creating one, and then records `approved`.
4. Rejection removes only a contained managed worktree and `agent/` branch, tolerates already-completed cleanup, and then records `rejected`.
5. Startup recovers expired task leases and writes an orphan-worktree report. Unknown worktrees are reported, never automatically deleted.
### Project processes
Configured `dev`, `build`, `test`, `lint`, and `install` commands run through the in-memory process manager. Output is held in a bounded server buffer and streamed over SSE. Process history does not yet survive a server restart.
### Resumable work sessions
`GET /api/today` composes the active, paused, and five most recent completed work sessions from `state/sessions/work-sessions.json`. Protected `POST /api/sessions` and `POST /api/sessions/:id/action` mutations start, annotate, associate, pause, resume, and complete sessions. The persisted document is schema-validated, globally locked, and atomically replaced; the lock makes the single-active-session rule consistent across cooperating local processes. Project IDs are resolved from discovered sibling repositories, task/process links must belong to the same project, and the current Git branch is captured on start.
Resume evidence is a deterministic read model over stored notes and existing task/process state. It omits event payloads, task instructions/results, raw process commands, absolute paths, and invalid PR URLs. Manual active intervals are accumulated as focused time without collecting user-activity telemetry. Pausing and completing update only session state.
### Project integrations

1. `GET /api/projects/:id/integrations` resolves the project through `PolicyService`.
2. The integration service reads contained local Git status and, for registry-backed GitHub repositories, open pull-request/issue counts and default-branch CI state.
3. Two explicitly registered deployment providers independently observe the registry-backed HTTP health URL and Railway deployment state.
4. Provider output is normalized, redacted, URL-filtered, and validated against `project-integrations.schema.json`.
5. A short in-memory cache avoids multiplying GitHub and deployment reads. Successful Git and branch mutations invalidate the affected aggregate snapshot.
6. The optional tracer records aggregate and per-deployment-provider spans; the API exposes only a validated trace identifier.
The deployment provider contract exists because HTTP health and Railway are two real implementations. Source control and CI remain concrete integrations until another implementation creates a demonstrated shared abstraction. Provider registration is static code, not dynamic plugin loading.
### Local HTTP boundary
The production API binds to `127.0.0.1`. API middleware rejects non-loopback `Host` values, cross-origin requests, and cross-site fetch metadata. Mutations additionally require a random in-memory session token obtained by the same-origin dashboard from a no-store endpoint.
## Current trust boundaries

- Registry YAML is privileged configuration but is untrusted data until it passes its JSON Schema and cross-reference checks.
- Dashboard request bodies, route identifiers, persisted JSON, child-process output, GitHub output, deployment responses, integration-provider output, and agent protocol messages are untrusted.
- Persisted task and project JSON is validated on both read and write.
- Non-agent subprocesses receive purpose-specific allowlisted environments, and surfaced output passes through centralized redaction.
- App Server owns model authentication and sandbox enforcement.
- External project repositories are outside this repository's ownership boundary.

## Domain notes by phase

Read the [architecture domain notes](architecture-domain-notes.md) for the applicable organization, Harness, governed workflow, recovery or operating-view details. Count those additional reads in the task route.

## Known limitations

- Some long operations still block the API event loop.
- Worker execution shares the API process; a process crash waits for lease expiry before recovery.
- Snapshot replacement and event append are two separate durable operations. A revision can therefore reveal a missing event after an I/O failure, but the pair is not one filesystem transaction.
- File locks coordinate cooperating control-plane processes, not arbitrary same-user filesystem writers or distributed hosts.
- Project-process history and the HTTP session token do not survive a server restart.
- Work-session records and accumulated elapsed time survive restart, but a related process's live status cannot be recovered because the process manager is in-memory only.
- Project-integration caches are process-local; the legacy provider-specific endpoints and aggregate endpoint can briefly expose observations from different cache windows.
- Only deployment currently has multiple concrete implementations. Source-control, CI, and tracing interfaces must not be generalized without another real implementation.
- Orphan worktrees require an explicit human cleanup decision after inspecting the reconciliation report.
- Pattern-based redaction and secret scanning reduce accidental exposure but are not general data-loss-prevention systems.
- Subsequent runtime filesystem reads are not guaranteed project-only; selected-source containment does not strengthen the existing sandbox's read isolation.
- Context is reassembled before attempts, not continuously watched; verification rechecks command/role/config authority. Fingerprints are hashes, not signatures. Unknown usage is not zero; an in-flight reported token chunk can overshoot a cap, which is not a provider billing guarantee.
