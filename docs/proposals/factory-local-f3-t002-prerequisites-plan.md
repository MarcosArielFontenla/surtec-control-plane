# F3 T002 — bounded prerequisite-resolution plan

Status: proposed, not approved for execution. Prepared on 2026-10-30.
Current authority is documentary planning only. No inventory rerun, service start, package/image acquisition, restore/build, probe, model call or Git mutation is part of this preparation.

## Evidence and unchanged boundary

The [F3 design and P01 record](factory-local-f3-design.md#p01-aggregate-inventory--complete-readiness-blocked-2026-10-30) retain the single completed inventory: collection exit 0, readiness BLOCKED, no helper error/timeout, nine successful Git observations and one failed local-engine observation. The private result and hashes remain unchanged.

Observed blockers: local Linux Docker endpoint unavailable; eight direct package pins absent from the two inspected caches; native test-asset identity and live writer coverage unqualified. No local database image was inspected. Absence from those caches does not establish absence from every possible cache; eight direct pins are not the full dependency graph.

T001 and revised F2 acceptance remain complete. T002 is incomplete. DEBT-F2-GLOBAL-900 and historical P/Q/CI results remain open. Candidate scope, model configurability, existing budgets, guards, assertions and runtime permissions are unchanged.

This plan adds no Surtec product source, schema, state migration, UI, lock service or execution runtime. The exact private inputs, cache pins, paths and command bindings stay in a separate external annex.

## Two prospective clarifications requiring explicit review

### Temporary-environment gate and project-writer gate

Split the next observation into two independently reported dimensions:

- `temporary_environment`: may become READY_FOR_TEMP_ONLY_T002 only when environment, approved immutable source snapshot and ownership of every probe resource are known.
- `project_writer_gate`: remains PENDING until the finite operator window, known-instance evidence and existing runtime checks below are satisfied. Global absence of every possible external writer stays NOT_PROVEN.

Only an explicitly approved new continuation may allow P02–P05 in private temporary copies while that later writer gate is pending. No real project/candidate write or workflow dispatch is allowed. Known conflicting activity, source drift or unknown ownership of a probe resource still blocks. This is a prospective scope clarification, not a retroactive P01 PASS, receipt waiver or weakening of runtime fencing.

Before T003 and again immediately before the Engineer, require the writer gate. An operator declaration states a working agreement; the existing policy, sandbox, scheduler and lease controls remain the technical enforcement. It is not a global filesystem lock.

### One complete temporary build graph

The future API probe must be prepared before dependency resolution. Use one operator-owned temporary solution containing the unchanged original backend/test projects plus the small probe host. The original project solution and all versioned inputs remain unchanged.

This explicitly amends only P02's temporary entry point: one cached/offline locked restore of that complete temporary graph, followed by one build with no implicit restore. P03 executes the already built host. No new package reference is permitted in the probe.

The frozen T001 document remains intact. Before R01/R03 execution, approve and bind this plan, source/route policy, commands, limits, original input hashes and the derived solution/probe identities. R03 then resolves the closure; only after that result, and before R05/P02, seal its actual locks, versions and content hashes. An unknown closure never authorizes P02, and its absence before R03 is not a circular requirement to have already resolved it.

## Ordered continuation R01–R06

All stages are PROPOSED / NOT RUN. Each listed command/probe has at most one invocation; dependencies are fail-fast. A future approval can authorize the concrete bounded package as a whole instead of approving each package separately.

| Stage | Work and allowed effects after explicit execution authority | Required result / stopping boundary |
| --- | --- | --- |
| R01 | Bind the reviewed plan/input hashes, installed executable identities and exact SDK selection; allocate one new private root using direct file APIs; prepare the derived source/probe graph and declare ownership/instance coverage. No live application or model start. | Exact original baseline and owned normal paths; no write-through links, source drift or known conflicting owner. Unresolved required binding stops before service/acquisition effects. |
| R02 | Qualify the installed Desktop CLI interface, allow at most one synchronous start of the existing Docker Desktop, then one local engine observation and one local image inspection. No installation, update, backend switch, remote context or automatic fallback. | Known root exit/EOF and ready local Linux endpoint; record immutable image ID/platform/digests. An absent image stops here: no pull is included without a separate concrete image approval. |
| R03 | Prepare an isolated complete package closure by one reviewed route: reuse an explicitly qualified existing cache, or perform one explicitly authorized restore acquisition from the single reviewed public source. Resolve the temporary three-project graph, generate private locks and verify exact direct pins and package hashes. | Complete closure and local feed, no direct-version drift, no extra source or credential dependency. Failure/unknown stops; no fallback from offline to online. |
| R04 | Identify/hash native Windows assets from the resolved package graph; create one new aggregate readiness revision linked to the original P01 and changed prerequisites. Do not load a DLL or repeat a full test campaign. | Known environment/probe ownership and native-file identity. Report temporary readiness and pending writer gate separately. Nothing changed or incomplete evidence means no automatic revalidation/retry. |
| R05 | Resume P02 once: locked offline restore and build of the temporary complete graph, with the same external artifacts path and no implicit restore. | Native success, complete streams, unchanged locks/source/pins and sealed project checkout. No network acquisition inside P02. |
| R06 | Resume P03, P04 and P05 in their original order: one owned API/database probe, one managed-browser lifecycle/capture probe, then one synthetic verifier qualification command. | Known actual results and owned closure for each; stop at first failure/unknown. No T003, real agent turn or candidate write follows. |

R02 starts a shared installed component; it may create its own engine/log/state files. Do not stop Docker, terminate its shared backend tree or remove existing containers/volumes as test cleanup. If its CLI times out, terminate only the owned observation/start client where safe, retain UNKNOWN and stop.

The Docker Desktop start command is synchronous unless detached; use no detach mode and retain the existing 900000-ms external supervision. A start return is not proof of the selected engine or image. See the [official Desktop start reference](https://docs.docker.com/reference/cli/docker/desktop/start/).

An image tag is only a lookup key. If present, pin its immutable local identity and use it without pulling during P03. If absent or platform-incompatible, report the exact next needed image metadata/source before requesting acquisition. No registry digest is asserted by this proposal.

## Package-cache routes and isolation

**Route A — reuse only:** the operator identifies an additional concrete cache/feed. Inspect/copy only the required package artifacts into owned storage; do not search the whole machine or import a user's NuGet configuration. The two already observed incomplete caches are not magically made complete. If the closure cannot resolve locally, stop with no network fallback.

**Route B — isolated acquisition:** requires explicit future download authority. Use only the reviewed public feed, owned configuration and caches, unchanged source pins, and one restore of the complete temporary graph. Record every resolved direct/transitive package version and content hash; reject changed direct versions. No system SDK/workload/application installation or credential configuration is authorized.

An online restore is acquisition R03, not cached P02. NuGet configuration and package output can be selected explicitly; subsequent build uses no implicit restore. See [restore options](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-restore) and [build options](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build).

Preserve private per-project locks and the closure manifest. P02 uses only the selected local feed, locked mode and owned packages; missing artifacts fail. Locks and resolved content hashes support repeatability; see [NuGet lock-file behavior](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#locking-dependencies).

Redirect packages, HTTP/plugin/scratch caches, CLI home, profile and TEMP/TMP into the new owned root. No global cache clearing, global build-server shutdown or shared-cache writes. NuGet documents its distinct caches and overrides in [cache management](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders).

The actual SDK selection must match the approved version; directory presence and the original roll-forward setting are not execution proof. Qualify once from the owned working directory and stop on mismatch rather than editing the project's selector. [SDK selection rules](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) distinguish CLI and project-resolution search locations.

Bind the native launcher path/hash, fixed argv, fresh-process strategy and complete owned Windows environment in R01 before using the restore/build entry points. The earlier same-MSBuild initialization probe passed, but direct restore/build compatibility remains NOT QUALIFIED; R03 is the one actual resolution attempt. It must preserve failure evidence and stop, not add another initializer/restore or silently switch commands.

Native asset presence/hash/architecture is the R04 result. Functional native loading remains unverified until the already planned backend tests; do not invent an executable, package, silent substitution or extra probe.

## Writer gate for the later real workflow

1. Record a private operator-confirmed finite window, exact repository/Git-common-dir, managed-worktree area and the sole authorized writing instance. Exclude concurrent editors/agents/automations writing that target; identify only instances already known to the operator.
2. In known available instances explicitly included in scope, use only project-filtered reads and minimize returned task details to IDs/project/sandbox/lifecycle/lease/retry/cancellation fields. A known conflicting workflow/task/process, ambiguous lease, incomplete coverage or inaccessible required instance blocks the writer gate. Do not infer process closure from an expired lease.
3. The existing `GET /api/workflows?project_id=...` and project command-slot read can supply scoped observations. Operating-project views are optional only when the target is actually discoverable and coverage is complete; the exact-root private configuration must not be forced through an unavailable overview. Task details are read only for target IDs already identified.
4. Filtered endpoints may internally read their instance's aggregate stores. Approve that narrow application-mediated scope explicitly; otherwise omit those sources and retain unknown coverage. Never query general overview/today/runs/issue lists or enumerate unrelated processes/state to manufacture absence.
5. Do not launch a normal instance merely to inspect it: its bootstrap starts reconciliation and the worker. Before writing, renew the observation if facts/window changed and retain the existing scheduler's one-writer and task-lease checks.

Record the qualified claim only: `operator-confirmed window; no conflicting owner observed within declared instance coverage`. Do not record `global absence proven`. Different state roots do not share a scheduler lock. See [scheduler implementation](../../runner/task-orchestrator.ts), [workflow routes](../../dashboard/src/server/index.ts) and [threat-model limits](../security/threat-model.md).

## Future private artifacts and allowed edits

Current preparation changes documentation only: this proposal, its external private annex and a minimal link in the existing F3 proposal.

Future execution may create only a new owned root containing a continuation manifest, normal approved source copy, temporary probe/solution, explicit online/offline NuGet configurations, selected package archives/feed, closure/locks, owned caches/artifacts/TEMP and normalized evidence. Exact targets/commands are in the private annex. These are operator artifacts, not candidate-editable authority.

No pilot versioned file, Surtec source/registry, policy, runtime, timeout, acceptance assertion or original checkout configuration changes. The eight eventual candidate targets stay fixed. No direct edit of the frozen T001 contract or original P01 result.

## Capture, completion and approval boundary

Retain direct-file script/data transport, short native command lines, exact argv, purpose-specific environments and bounded complete stream handling. Preserve the existing 900000-ms external command ceiling and tighter stage/role limits; acquisition or waiting cannot refill the later workflow budget. Do not repeat a timed-out command, switch launchers or add profiling/CI/evals/full-suite campaigns automatically.

Record each native exit, both EOFs, elapsed time, failed/unknown stage and each owned resource's closure separately. Credentials, raw reasoning, private prompts, auth responses/headers and connection strings stay out of persisted evidence.

Original P01 stays invocation 1 / BLOCKED. The prospective observation receives its own revision/authority/hash and links its changed prerequisites; it does not overwrite P01 or silently reset an invocation allowance.

Approval of the design is separate from effect authority. A future execution instruction must explicitly authorize any Desktop start and choose Route A or Route B; image acquisition remains excluded until concrete approval. It must also approve the two prospective clarifications above. Only then can the defined continuation run and stop at its boundary. T003/model calls, candidate writes/commits, push/merge/deploy remain unauthorized.

This planning delivery asserts documentary results only. No R01–R06 step or new P01 was executed.
