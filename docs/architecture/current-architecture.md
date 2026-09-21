# Current architecture

## Product boundary

Surtec Control Plane is a local modular monolith. It discovers sibling Git repositories, overlays trusted project configuration, records local task state, and exposes safe operational actions through one dashboard.

## Modules

- `dashboard/src/ui`: React views and project controls.
- `dashboard/src/server`: Hono API and infrastructure adapters for Git, GitHub, deployment health, Railway, dependencies, and local open actions.
- `lib/policy`: the canonical typed policy boundary for project, agent, sandbox, task-type, repository, command, and approval configuration.
- `lib/security`: shared identifier, canonical path-containment, environment-allowlist, and redaction primitives.
- `lib/state`: schema-validated file-first task and project state with atomic replacement writes.
- Other `lib` modules: discovery, Git status, portfolio derivation, and URL helpers.
- `runner`: agent execution, worktrees, verification, process management, review publication, and startup reconciliation.
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

1. Validate a dashboard request through `PolicyService` and write a schema-valid queued task record.
2. Re-resolve current project and agent policy at execution time; reject stale paths or broadened capabilities.
3. For a write task, create an isolated Git worktree and managed `agent/` branch under the worktree root.
4. Invoke `AgentExecutor`; the production implementation uses Codex App Server over local `stdio`.
5. Persist normalized operational events, thread/turn identifiers, and usage.
6. Commit agent edits and run registry verification commands.
7. Validate the structured result and mark the task finished.
8. A human may approve publication or reject and clean up. The review state machine persists intent and each completed effect so a retry resumes rather than duplicates work.

### Review publication

1. Revalidate the persisted task against current policy before any Git effect.
2. Persist `approving` or `rejecting` with an attempt count.
3. Approval pushes once, records that checkpoint, finds an existing open PR before creating one, and then records `approved`.
4. Rejection removes only a contained managed worktree and `agent/` branch, tolerates already-completed cleanup, and then records `rejected`.
5. Startup marks interrupted running tasks as failed and writes an orphan-worktree report. Unknown worktrees are reported, never automatically deleted.

### Project processes

Configured `dev`, `build`, `test`, `lint`, and `install` commands run through the in-memory process manager. Output is held in a bounded server buffer and streamed over SSE. Process history does not yet survive a server restart.

### Local HTTP boundary

The production API binds to `127.0.0.1`. API middleware rejects non-loopback `Host` values, cross-origin requests, and cross-site fetch metadata. Mutations additionally require a random in-memory session token obtained by the same-origin dashboard from a no-store endpoint.

## Current trust boundaries

- Registry YAML is privileged configuration but is untrusted data until it passes its JSON Schema and cross-reference checks.
- Dashboard request bodies, route identifiers, persisted JSON, child-process output, GitHub output, deployment responses, and agent protocol messages are untrusted.
- Persisted task and project JSON is validated on both read and write.
- Non-agent subprocesses receive purpose-specific allowlisted environments, and surfaced output passes through centralized redaction.
- App Server owns model authentication and sandbox enforcement.
- External project repositories are outside this repository's ownership boundary.

## Known limitations

- Some long operations still block the API event loop.
- Task orchestration is in-process and has no durable queue.
- File-first state uses atomic file replacement but does not provide cross-record transactions or multi-process locking.
- Project-process history and the HTTP session token do not survive a server restart.
- Orphan worktrees require an explicit human cleanup decision after inspecting the reconciliation report.
- Pattern-based redaction and secret scanning reduce accidental exposure but are not general data-loss-prevention systems.
