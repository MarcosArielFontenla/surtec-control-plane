# Threat model

## Assets

- Source code and Git history across all managed projects.
- Local credentials for Codex, GitHub, Railway, package registries, and cloud providers.
- Task instructions, results, diffs, logs, and usage data.
- Local portfolio context, including client references, goals, next actions, deadlines, and review dates.
- Local client delivery records and commitments, including confidential notes and SLA context.
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
- Task records, events, project overrides, agent results and optional workflow v1 aggregates have strict runtime validation. Admission dispatch is explicit legacy/v1/v2; malformed/future state retains bytes and denies effects, never fabricated empty ownership or approval.
- Operating profiles use a separate, ignored `state/portfolio/` store and a strict versioned schema; tracked technical policy stays in `registry/projects.yml`.
- Portfolio profile writes are locked and atomically replaced; unsupported future versions and invalid existing data fail closed. The secret scanner rejects tracked files under `state/portfolio/`.
- Client and commitment records share the ignored `state/portfolio/` boundary, strict versioned validation, size limits, cross-process locking, and atomic replacement. Project-to-client links are derived from validated local profiles. Commitment associations are checked against discovered projects and same-project task/session records.
- Client context availability returns category names only. Task dispatch resolves context server-side only for explicitly selected categories, keeps confidential notes separately selectable, bounds the composed context, and stores the selected category list plus opaque client ID and timestamp as a task audit record. Today signals and project quick-task prefill do not include client notes or automatically copy client profile text.
- POSIX owner-only modes are requested for profile storage where supported. Local state is not application-encrypted and relies on host account/disk protections.
- Signal evidence is assembled from bounded allowlisted fields; raw provider payloads, issue titles/authors/URLs, note text, task instructions/results, deployment URLs, and absolute project paths are excluded. The feed is schema-validated and marked `no-store`.
- Signal interaction state is separate under ignored `state/signals/human-state.json`; updates use a cross-process lock, unique temporary file, atomic replacement, and strict schema validation. Unsupported future versions and malformed files fail closed. Dismissal and snooze expiry are feed projections, not destructive evidence edits.
- Phase I adds optional first-action/evidence timestamps to that local signal state without invalidating older records. The no-store feedback API returns aggregates only and does not identify projects, tasks, signals, paths, or prompts; it sends no external analytics. The new real-model canary is disabled by default and only uses the read-only sandbox against a fixed synthetic repository fixture.
- Signal mutations use the existing loopback, same-origin, and in-memory session-token middleware. This token is local request protection, not multi-user authentication. The deterministic browser smoke uses synthetic inputs and isolated temporary state.
- Task mutations use per-task cross-process locks and atomic snapshot replacement. Scheduler claims also use a short global lock.
- Workflow mutations reread under their own exclusive lock without stealing unknown locks by age; immutable grants/handoffs/receipts, exact revisions and monotonic run/lineage accounting are validated. Workflow/issue/task/event/Git effects are not one transaction.
- Identifiers are allowlisted before becoming paths or process arguments. Worktree cleanup accepts only contained managed paths and `agent/` branches.

### Phase Q operating reads and manual delivery evidence

- The four `/api/operating/*` GETs return independently versioned, closed derived responses with `no-store`, `execution_authority: none` and navigation references that still require current authorization. Independent bounded sources preserve unavailable/absent/partial/stale distinctions, unknown totals and candidate-validity gaps. The no-migration readers reject unsafe links and incompatible snapshots rather than repairing state, refreshing providers, running Doctor or admitting tasks. Production has no saved signal-feed adapter; its missing data is not a healthy signal inventory.
- These projections allowlist public labels, IDs, states, source metadata and evidence references. Confidential client notes, delivery summaries/source references/next actions, task instructions/results/logs and private filesystem paths are not copied into operating summaries or generic prefills. This is a bounded contract and pattern-based redaction, not general DLP for user-entered public labels. Explicit private delivery disclosure remains local plain text, not executable HTML or an automatically fetched link. The local detail API still contains the private fields: UI reveal reduces casual exposure, not storage encryption or access control against the same user. Operator records have no independent attestation; follow-up recording does not prove an open/closed state.
- `POST /api/work-issues/:id/delivery-observations` retains loopback/Host/origin/fetch-site/session middleware and accepts at most 8 KiB of JSON after reading the request body. Its closed confirmed input must match current project/issue revision/scope and an explicit all-null or exact latest valid candidate binding. The existing issue lock and writer revalidate the aggregate; active task/workflow ownership, unknown ownership, stale/repeated inputs, future observation times and capacity exhaustion refuse without an append.
- A non-null commitment must already be linked to the issue and exist in a bounded stable same-project snapshot. That read does not lock or write the client store and is not a cross-store transaction. Manual evidence is optional strict nested v1, informational work-product with null task/execution identities and no testing receipt; it cannot authorize scope, satisfy verification/review, complete a commitment, change lifecycle or publish anything. Absent historical facets stay absent; present null/malformed/future facets fail closed without rewriting bytes.
- Summary/source/next-action lengths are limited to 500/300/500 characters; 64 manual observations per issue are further constrained by the existing 500 per-issue references, 5000 evidence and 20000 events. Source references are inert opaque identifiers or restricted HTTP(S) data without credentials/query/fragment/escaping/filesystem syntax; recording neither probes nor opens them. Audit payloads retain only bounded IDs/kinds, not the private observation text.
- Isolated Q acceptance uses fictional state, forbidden runtime/effect callbacks, a credential-stripped environment and child-only closed IPC, never a product control endpoint. Browser traffic is loopback-only except the one exact optional font CSS request fulfilled locally with an empty stylesheet; other external requests fail acceptance. Saved synthetic candidate references are not proof of a real runtime receipt, current Git validity or human acceptance. These controls do not activate deferred P budgets, routine effects, continuity, recovery or Harness remediation.

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
- Per-task limits intersect finite workflow root/correction caps; attempts are charged before execution, usage deduplicates by run and unknown interruption is not zero. The existing worker bounds concurrency and serializes project writers; no second role scheduler exists.
- V2 execution requires a private live controller identity, exact committed intent/grant/context and lease. Reassembled role/project/agent/Harness restrictions and independent explicit per-role client consent, empty by default, precede effects; prompts, role output and caller metadata cannot grant capabilities.
- Reviewer/QA use separate read-only task/thread contracts over the exact inactive implementer's managed candidate; containment, commit, clean physical content, captured patch/receipt and current authority are checked before/after. Invalid role output has no authoritative raw-text fallback.

### Governed context advertisement and contract continuity

- The new code-owned context profile suppresses only automatic skills instructions/catalog text. Complete admitted/routed sources and required skill reads remain mandatory and bounded. Prompt guidance cannot grant permissions, constrain all subsequent filesystem reads or prove token savings.
- Selection requires either a first governed contract without a retained binding/thread or an exact match to a supported legacy/new execution fingerprint. Unknown or changed hashes and bare threads refuse. Caller metadata cannot select settings, reset a binding or upgrade a retained contract; no persisted profile facet or migration is introduced.
- The new fixed process/thread setting requires an own explicit false from stable `config/read` before thread creation/resume. Unsupported, missing, true, malformed or refused responses stop without fallback; generic errors avoid exposing effective configuration. Existing charged-attempt and unknown-usage handling still applies. Legacy process arguments, RPC sequence and prompts remain unchanged.
- Reviewed claim-recovery source/operator pairs remain coherent and static: both historical pairs are retained and one public context-profile fixture pair is appended. The pure pair classifier grants no package/worker authority; the inspector independently reads/hashes bounded closed files and constructs its opaque proof only after all checks. Mixed/changed pairs refuse; filesystem changes cannot repin themselves. Charged or exhausted attempts remain ineligible.
- Existing sandboxes, network denial, approvals, environment allowlists, agents-disabled setting, leases, terminal receipts, cumulative/cache accounting and candidate/review gates remain unchanged. Fake acceptance is not native qualification, final billing or authority to spend the real exhausted ledger.

### Browser and review boundary

- The API binds to loopback and rejects non-loopback `Host`, cross-origin, and cross-site requests.
- Every HTTP mutation requires a random in-memory same-origin session token compared in constant time.
- Review decisions persist intermediate state and checkpoints around push, PR creation, and cleanup.
- PR publication first searches for an existing open PR for the branch. Worktree cleanup is idempotent.
- Durable stop precedes abort, prevents downstream admission and retains candidate/evidence. V2 expired leases finish needs-review, not generic requeue; only provable existing unstarted admission gaps reconcile. Unknown usage/progress or missing facts require human direction.
- Root approval enumerates five finite templates, scope/role/consent/source bindings and caps; exact plan/scope, advisory-risk acknowledgement and every final criterion remain human gates. Verification keeps workflow writers checking until required candidate-bound reviews pass; review cannot waive trusted failures.
- One correction is opt-in, consumed before admission and retained across replacement/cancellation/restart. It keeps original Engineer/scope/protected probes, starts at the prior exact candidate, and requires new verification/reviews. Another finding or exhausted caps stops for a decision.
- Generic API/CLI retry/cancel/import/publication/reject cleanup consult retained task/tree ownership, including old generations and aliases; unavailable ownership fails closed. Workflow acceptance/stop grants no push, PR, merge, deploy, scaffold or sibling-write permission.

### Explicit human recovery of an incomplete planning proposal

- The new protected planner-recovery POST offers only the exact first retained plan for separate human approval, with the existing 4-KiB body bound, loopback/origin/fetch-site/session checks and current revision/source fingerprints. GET offers issue no dispatch grant and write no state; lost results require a fresh explicit read, not replay.
- Valid output plus an independent exact-bound terminal receipt, known charged accounting, inactive task, current scope/role/consent/testing authority and remaining finite capacity are all required. Matching generic error text alone is insufficient. Cancelled/interrupted/unknown, scope-changing or malformed results remain blocked; the exception cannot activate P execution scaffolds.
- The append-once receipt retains every original question/risk and explicit human dispositions. These are private operator attestations, not verified technical facts or permission to waive tests, caps, scope or candidate review. List/operating summaries do not inherit clarification bodies.
- Original task/output/failure/events/charges remain intact. Only a receipt-bound approved human planning basis can satisfy the narrow planning prerequisite in downstream guards; ordinary roles still require genuine completion. Reviewer/QA, managed candidate checks, final human criteria and publication controls remain. A completed workflow does not relabel its retained Planner as completed.
- One workflow replacement records offering and its pending decision, with cross-store snapshot fences and unchanged locks. Restart/duplicate/stale requests cannot refund charges or admit another stage twice. Hashes are bindings, not signatures; existing same-user and cross-store transaction limitations remain. Technical tests use owned synthetic state/fakes, never live recovery or model calls.

### Explicit recovery of a proven uncharged first implementation claim

- Only a code-owned coherent producer/operator profile plus bounded closed native/archive evidence can qualify. Missing accounting is not zero-cost inference. Exact first Engineer task/intent/history, approved plan, current source/consent/testing/grant and absent worktree/branch effects remain required; charged, cancelled, progressed, drifted, other-role or P-scaffold cases are refused.
- A temporary unforgeable owner identity exists only during the explicit call from the stopped, idle owning worker; serialized receipts and caller flags grant no authority. Recovery has no production endpoint, starts no worker and cannot change scope/caps/approval or relax ordinary scheduler/lease/verification/review gates.
- The monotonic journal preserves original failure/archived bytes, charges and task attempts through separate fenced store operations. Unknown/partial/unrecognized event gaps stay blocked, repeated ready recovery is refused and a new ordinary claim must charge before effects. Hashes bind cooperating same-user state; they are not signatures or an atomic filesystem transaction.
- Native write failures retain generic public messages with bounded internal phase/code/syscall only. Synchronous private observation closes handles before yielding and refuses malformed/redirected reads. Synthetic fake-runtime API/browser qualification uses closed parent-child IPC with fixed actions and no caller-selected path/command; it is not a product or paid-runtime activation surface.

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
- Cancellation preserves known managed worktrees. Generic v2 retry is denied; stop does not release a tree still owned by an active workflow. Any later non-workflow cleanup/publication needs its independently authorized current policy/review checks.
- In-memory project processes are not reconciled after a server crash.
- Registry project commands are privileged administrator configuration. The policy service restricts selection to exact configured commands but does not make a malicious configured command safe.
- Orphan cleanup remains manual because automatic deletion would turn ambiguous state into destructive action.
- Pattern-based redaction and scanning can miss novel credential formats. Credentials must still remain outside repositories and task inputs.
- Source/candidate fingerprints and receipts are hashes, not signatures against same-user mutation; application-selected containment does not guarantee subsequent runtime reads are project-only. Context is reassembled at boundaries, not continuously watched.
- An in-flight usage chunk can overshoot a token cap before abort; interrupted usage remains unknown and cannot authorize another stage. These counters do not guarantee provider billing limits or model/review quality; acceptance uses deterministic protocol fakes.
- Merge, deploy, push outside the explicit review flow, and any real paid Codex smoke remain human-authorized operations.
- Registry deployment URLs are privileged operator configuration. Scheme and credential checks prevent accidental unsafe forms, but this local single-user product does not attempt to classify every private or link-local network destination.
- Integration observations are cached in memory and can be stale for the configured TTL. Provider-specific endpoints use separate legacy caches and can temporarily disagree with the aggregate snapshot.
