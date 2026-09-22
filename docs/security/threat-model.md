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
- Task records, append-only task events, project overrides, agent reports, and agent results have runtime JSON Schema validation.
- Task mutations use per-task cross-process locks and atomic snapshot replacement. Scheduler claims also use a short global lock.
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
- Attempt ownership is tied to a unique run id. Git effects recheck ownership before starting, and a stale process cannot publish progress or overwrite a newer terminal result.
- Runtime, cumulative-token, and retry budgets are persisted per task. Concurrent work is bounded, and workspace writes are serialized per project.

### Browser and review boundary

- The API binds to loopback and rejects non-loopback `Host`, cross-origin, and cross-site requests.
- Every HTTP mutation requires a random in-memory same-origin session token compared in constant time.
- Review decisions persist intermediate state and checkpoints around push, PR creation, and cleanup.
- PR publication first searches for an existing open PR for the branch. Worktree cleanup is idempotent.
- Cancellation intent is persisted before the in-memory abort is delivered. Startup recovers only expired leases and never automatically deletes unknown managed worktrees.

### Supply chain and verification

- CI installs from the lockfile and runs schema validation, deterministic secret scanning, tests, type checking, the production build, and dependency audit.
- Automated tests use protocol fakes and make no paid model calls.
- Opt-in read-only smoke with a filesystem before/after assertion.
- The local secret scanner reports only file, line, and rule, not the matched credential value.

### Integration reads

- The aggregate integration endpoint resolves identifiers, repository paths, repository URLs, and provider configuration through `PolicyService`; request parameters never supply a path, GitHub slug, deployment URL, or Railway identifier directly.
- Local Git and GitHub readers retain fixed argument vectors, no shell, bounded timeouts, allowlisted environments, and centralized redaction.
- Deployment providers are explicitly registered in code. They cannot load packages, discover modules, or execute registry commands.
- HTTP deployment probes accept only `http` or `https` registry URLs without embedded credentials. Railway uses a fixed endpoint and an environment-only credential.
- Provider failures are isolated. Errors are redacted and capped, URLs are revalidated, unknown fields are discarded, and the complete response must pass its versioned JSON Schema.
- Tracing receives only project, provider, health, and configuration attributes. Credentials and provider error text are not recorded as trace attributes.
- The consolidated endpoint is read-only. Push, merge, deployment, rollback, and provider configuration changes remain outside this surface.

## Residual risk and deferred controls

- This is a single-user local application, not a security boundary against another process running as the same operating-system user.
- The session token is CSRF and local-request protection, not multi-user authentication, and resets with the server.
- Snapshot replacement and event append are not one transaction; snapshot revision gaps make missing events detectable, but an I/O failure can leave history incomplete.
- File locks coordinate local control-plane processes only. This design is not a distributed lock and does not defend against arbitrary same-user filesystem mutation.
- The worker shares the API process, so crash recovery begins after lease expiry rather than continuing immediately in a separate service.
- Git and filesystem effects cannot participate in the task-snapshot transaction. Lease expiry during a non-interruptible Git operation can leave a managed artifact that needs inspection, though stale snapshot completion remains fenced.
- Cancelling a write task preserves its known managed worktree so a manual retry can resume safely. Cleanup remains an explicit review action rather than an automatic destructive effect.
- In-memory project processes are not reconciled after a server crash.
- Registry project commands are privileged administrator configuration. The policy service restricts selection to exact configured commands but does not make a malicious configured command safe.
- Orphan cleanup remains manual because automatic deletion would turn ambiguous state into destructive action.
- Pattern-based redaction and scanning can miss novel credential formats. Credentials must still remain outside repositories and task inputs.
- Merge, deploy, push outside the explicit review flow, and any real paid Codex smoke remain human-authorized operations.
- Registry deployment URLs are privileged operator configuration. Scheme and credential checks prevent accidental unsafe forms, but this local single-user product does not attempt to classify every private or link-local network destination.
- Integration observations are cached in memory and can be stale for the configured TTL. Provider-specific endpoints use separate legacy caches and can temporarily disagree with the aggregate snapshot.
