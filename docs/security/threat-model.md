# Threat model

## Assets

- Source code and Git history across all managed projects.
- Local credentials for Codex, GitHub, Railway, package registries, and cloud providers.
- Task instructions, results, diffs, logs, and usage data.
- The user's ability to approve external side effects intentionally.

## Trust boundaries

- Browser to local Hono API.
- API to filesystem and Git.
- Control plane to external project repositories.
- Control plane to App Server JSONL.
- Agent-generated commands and file changes.
- Registry, persisted state, provider responses, and process output.

## Primary threats

- A read-only task writes files or escapes its repository.
- A write task modifies the main checkout or another project.
- Project-controlled commands inherit control-plane secrets.
- Malformed persisted or protocol data is treated as trusted success.
- A forged browser request triggers a local mutation.
- Path traversal escapes state or worktree directories.
- Partial push, PR, or cleanup effects are recorded as final success.
- Logs persist credentials or unbounded sensitive output.
- A crashed server leaves orphan processes, worktrees, or ambiguous tasks.

## Implemented controls

### Policy and persisted data

- One `PolicyService` validates registry schemas, agent references, sandbox ceilings, task types, exact verification commands, and canonical repository containment.
- Dispatch, execution, and review revalidate current policy. A persisted task cannot broaden access by changing its repository path or sandbox.
- Task records, project overrides, agent reports, and agent results have runtime JSON Schema validation.
- Identifiers are allowlisted before becoming paths or process arguments. Worktree cleanup accepts only contained managed paths and `agent/` branches.

### Agent and subprocess isolation

- Read-only and workspace-write App Server sandboxes.
- Isolated Git worktrees for implementation.
- Network disabled for dispatched turns.
- Purpose-specific environment allowlists for agent, Git, GitHub, project-command, verification, and local-open subprocesses.
- Stable local `stdio` transport only.
- Fail-closed handling of unknown or out-of-scope approvals, malformed protocol data, and malformed structured results.
- Approval requests must match the active thread and turn and the exact approved command or path.
- Central redaction is applied before subprocess output, errors, structured logs, and persisted events are surfaced.

### Browser and review boundary

- The API binds to loopback and rejects non-loopback `Host`, cross-origin, and cross-site requests.
- Every HTTP mutation requires a random in-memory same-origin session token compared in constant time.
- Review decisions persist intermediate state and checkpoints around push, PR creation, and cleanup.
- PR publication first searches for an existing open PR for the branch. Worktree cleanup is idempotent.
- Startup closes interrupted running tasks and records, but never automatically deletes, unknown managed worktrees.

### Supply chain and verification

- CI installs from the lockfile and runs schema validation, deterministic secret scanning, tests, type checking, the production build, and dependency audit.
- Automated tests use protocol fakes and make no paid model calls.
- Opt-in read-only smoke with a filesystem before/after assertion.
- The local secret scanner reports only file, line, and rule, not the matched credential value.

## Residual risk and deferred controls

- This is a single-user local application, not a security boundary against another process running as the same operating-system user.
- The session token is CSRF and local-request protection, not multi-user authentication, and resets with the server.
- File-first state has no durable queue, cross-record transaction, or multi-process concurrency control; Phase 2 owns those guarantees.
- In-memory project processes are not reconciled after a server crash.
- Registry project commands are privileged administrator configuration. The policy service restricts selection to exact configured commands but does not make a malicious configured command safe.
- Orphan cleanup remains manual because automatic deletion would turn ambiguous state into destructive action.
- Pattern-based redaction and scanning can miss novel credential formats. Credentials must still remain outside repositories and task inputs.
- Merge, deploy, push outside the explicit review flow, and any real paid Codex smoke remain human-authorized operations.
