# Current architecture

## Product boundary

Surtec Control Plane is a local modular monolith. It discovers sibling Git repositories, overlays trusted project configuration, records local task state, and exposes safe operational actions through one dashboard.

## Modules

- `dashboard/src/ui`: React views and project controls.
- `dashboard/src/server`: Hono API and infrastructure adapters for Git, GitHub, deployment health, Railway, dependencies, and local open actions.
- `lib`: discovery, Git status, portfolio derivation, URL helpers, and file-first state.
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

1. Validate a dashboard request and write a queued task record.
2. Resolve the project and agent configuration.
3. For a write task, create an isolated Git worktree and task branch.
4. Invoke `AgentExecutor`; the production implementation uses Codex App Server over local `stdio`.
5. Persist normalized operational events, thread/turn identifiers, and usage.
6. Commit agent edits and run registry verification commands.
7. Validate the structured result and mark the task finished.
8. A human may approve publication or reject and clean up.

### Project processes

Configured `dev`, `build`, `test`, `lint`, and `install` commands run through the in-memory process manager. Output is held in a bounded server buffer and streamed over SSE. Process history does not yet survive a server restart.

## Current trust boundaries

- Registry files are trusted configuration.
- Dashboard request bodies, route identifiers, persisted JSON, child-process output, GitHub output, deployment responses, and agent protocol messages are untrusted.
- App Server owns model authentication and sandbox enforcement.
- External project repositories are outside this repository's ownership boundary.

## Known limitations

- Registry policy is not yet enforced by one canonical service.
- Some long operations still block the API event loop.
- Task orchestration is in-process and has no durable queue.
- Review side effects are not yet fully idempotent.
- Project paths currently require environment-specific reconciliation.
- The HTTP server needs stronger loopback/session/origin enforcement.

