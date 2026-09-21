# Phase 1 plan — security, policy, and reliable review

## Goal

Make every local control-plane mutation pass through one typed policy boundary, fail closed on malformed or untrusted input, and remain recoverable across retries and restarts.

## Security invariants

1. Registry YAML, persisted JSON, HTTP input, App Server messages, and subprocess output are untrusted until validated.
2. Project, task, agent, run, note, and branch identifiers use explicit allowlists before they reach a path or process argument.
3. Project and worktree paths must be contained by their declared roots after canonical resolution.
4. Analysis runs are read-only. Write runs use an isolated Git worktree. Verification may only execute the exact registry commands approved for that project.
5. Sandbox capability and approval policy remain separate controls. App Server approval requests must match the active thread and turn and must satisfy the local policy service.
6. Non-agent subprocesses receive a minimal environment. Logs and surfaced subprocess errors pass through one redaction function.
7. The HTTP server binds to loopback. Mutations require a same-origin session token, and hostile `Host`/`Origin` values fail closed.
8. Review decisions are durable state machines. Retrying an interrupted approval or rejection resumes unfinished effects instead of duplicating them.
9. Startup reconciliation closes interrupted tasks and records orphan worktrees for safe cleanup; it never deletes an unrecognized path.
10. CI runs schemas, tests, type checks, the production build, dependency audit, and secret scanning without paid model calls.

## Delivery slices

### 1. Canonical policy and validation

- Add shared identifier, path-containment, environment, and redaction primitives.
- Add schemas for both registries and persisted task records.
- Replace independent YAML readers with a typed `PolicyService`.
- Revalidate policy at execution time so a stale or tampered task cannot broaden access.

### 2. HTTP and subprocess hardening

- Bind the API to `127.0.0.1` by default.
- Add host/origin checks and an in-memory session token for mutation routes.
- Attach the session token in the dashboard API client.
- Apply environment allowlists and output redaction to every non-agent subprocess.

### 3. Retryable review and reconciliation

- Persist effect-level review progress before external side effects.
- Make approval/rejection retries return or resume the same decision.
- Reconcile interrupted task records and known managed worktrees on startup.

### 4. CI and verification

- Add a deterministic CI workflow and a local secret-scanning command.
- Cover traversal, malformed registries/state, leaked secrets, forged HTTP requests, exact-command approvals, retry/restart behavior, and orphan reconciliation.
- Run the full offline suite, API/browser smoke tests, and document evidence before stopping at the Phase 1 boundary.

## Explicit non-goals

- No database, queue, or external auth provider.
- No remote deployment, merge, or unattended production mutation.
- No paid Codex run in the automated test suite.
- No Phase 2 scheduler or multi-process worker architecture.
