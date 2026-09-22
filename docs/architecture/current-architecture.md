# Current architecture

## Product boundary

Surtec Control Plane is a local modular monolith. It discovers sibling Git repositories, overlays trusted project configuration, records local task state, and exposes safe operational actions through one dashboard.

## Modules

- `dashboard/src/ui`: React views and project controls.
- `dashboard/src/server`: Hono API and infrastructure adapters for Git, GitHub, deployment health, Railway, dependencies, and local open actions.
- `lib/policy`: the canonical typed policy boundary for project, agent, sandbox, task-type, repository, command, and approval configuration.
- `lib/security`: shared identifier, canonical path-containment, environment-allowlist, and redaction primitives.
- `lib/integrations`: versioned project-integration contracts, runtime validation, URL safety, and bounded error normalization.
- `lib/state`: schema-validated file-first task and project state with per-task locks, atomic replacement writes, and append-only task events.
- Other `lib` modules: discovery, Git status, portfolio derivation, and URL helpers.
- `runner`: durable task scheduling, agent execution, worktrees, verification, process management, review publication, and startup reconciliation.
- `registry`: trusted project and agent configuration.
- `schemas`: persisted and structured-output contracts.

## Data flows

### Portfolio overview

1. Discover depth-one Git repositories under `SURTEC_PROJECTS_ROOT` or the control plane's parent directory.
2. Read local Git status with a short cache.
3. Overlay matching registry metadata.
4. Combine task state and project overrides into the overview model.
5. Poll the API from the dashboard.

### Agent task

1. Validate a dashboard request through `PolicyService`, write a schema-valid queued task snapshot, and append a `queued` event.
2. The API notifies `TaskOrchestrator` and returns. It never executes the task in the request handler.
3. Under the scheduler lock, the worker enforces global capacity and per-project write exclusion, then atomically claims the task with a unique run id and expiring lease.
4. Re-resolve current project and agent policy at execution time; reject stale paths or broadened capabilities.
5. For a write task, create or safely reuse its isolated Git worktree and managed `agent/` branch.
6. Invoke `AgentExecutor`; the production implementation uses Codex App Server over local `stdio` and resumes a persisted thread when available.
7. Persist concise lifecycle events, thread/turn identifiers, cumulative usage, lease heartbeats, and the current task snapshot. Cancellation reaches App Server through `turn/interrupt`.
8. Commit agent edits and run registry verification commands only while the attempt still owns the current lease.
9. Validate the structured result and finish the task. Transient failures retry with bounded backoff while attempt and token budgets remain.
10. A human may approve publication or reject and clean up. The review state machine persists intent and each completed effect so a retry resumes rather than duplicates work.

### Durable orchestration

- Task JSON is the authoritative current snapshot; `state/events/<task-id>.jsonl` is append-only operational history.
- A per-task cross-process lock serializes claim, cancel, retry, heartbeat, recovery, and completion. Atomic replacement protects each snapshot.
- A short global scheduler lock makes the configured concurrency bound and project-write exclusion consistent across local worker processes.
- A stale run id cannot publish progress or a terminal result after its lease was replaced.
- Startup leaves current leases alone, requeues expired leases when budgets remain, and terminally fails exhausted attempts. Unknown worktrees are still report-only.
- See [ADR-0002](../decisions/ADR-0002-file-first-durable-orchestration.md) for the persistence boundary and migration threshold.

### Review publication

1. Revalidate the persisted task against current policy before any Git effect.
2. Persist `approving` or `rejecting` with an attempt count.
3. Approval pushes once, records that checkpoint, finds an existing open PR before creating one, and then records `approved`.
4. Rejection removes only a contained managed worktree and `agent/` branch, tolerates already-completed cleanup, and then records `rejected`.
5. Startup recovers expired task leases and writes an orphan-worktree report. Unknown worktrees are reported, never automatically deleted.

### Project processes

Configured `dev`, `build`, `test`, `lint`, and `install` commands run through the in-memory process manager. Output is held in a bounded server buffer and streamed over SSE. Process history does not yet survive a server restart.

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

## Known limitations

- Some long operations still block the API event loop.
- Worker execution shares the API process; a process crash waits for lease expiry before recovery.
- Snapshot replacement and event append are two separate durable operations. A revision can therefore reveal a missing event after an I/O failure, but the pair is not one filesystem transaction.
- File locks coordinate cooperating control-plane processes, not arbitrary same-user filesystem writers or distributed hosts.
- Project-process history and the HTTP session token do not survive a server restart.
- Project-integration caches are process-local; the legacy provider-specific endpoints and aggregate endpoint can briefly expose observations from different cache windows.
- Only deployment currently has multiple concrete implementations. Source-control, CI, and tracing interfaces must not be generalized without another real implementation.
- Orphan worktrees require an explicit human cleanup decision after inspecting the reconciliation report.
- Pattern-based redaction and secret scanning reduce accidental exposure but are not general data-loss-prevention systems.
