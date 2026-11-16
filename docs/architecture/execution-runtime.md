# Product Stack and Execution Runtime Contract

This product-specific contract preserves the stack and runtime requirements formerly held in root `AGENTS.md`. It is mandatory for runtime, protocol, dispatch, sandbox, approval, and verification changes via the project policy and routing.

## Product stack

- TypeScript ESM on Node.js 20 or newer.
- React and Vite provide the dashboard UI.
- Hono provides the local API.
- Preserve the modular-monolith boundaries documented in [Current architecture](current-architecture.md).

## Sole agent runtime

- Codex App Server over local `stdio` JSON-RPC is the only agent execution runtime.
- Use the installed Codex runtime and current official OpenAI documentation as protocol sources of truth.
- Default to the stable App Server surface and `stdio`. Do not enable experimental protocol fields without an ADR and demonstrated need.
- Keep the model configurable; do not hardcode a model name.
- Map analysis/planning/operations and Reviewer/QA to read-only sandboxes; Reviewer/QA inspect the inactive owner's exact managed candidate before/after with separate task/thread contracts. Engineer/correction writes use isolated managed Git worktrees.
- Never use a full-access sandbox for dispatched tasks.
- Enforce capabilities in code, sandbox configuration, approvals, and registry policy, never by prompt instructions alone.
- Phase O uses the existing worker only: a v2 stage requires current bounded grant/context, committed intent, charged attempt and live controller/lease identity. Finite root/correction caps, explicit human plan/scope/acceptance gates and retained-tree ownership prohibit generic retry, arbitrary delegation and publication bypasses.
- Automated tests use protocol fakes and never paid model calls. Real runtime smokes require explicit opt-in.
- Positive reported usage completeness requires a fresh first turn, exact task/run/context/thread/turn-bound adapter receipt, explicit final_answer item, later coherent cumulative usage, successful terminal event, unforced native exit 0 and both drained EOFs/handlers. The runner charges observations before validation and rejects explicit positive claims without the receipt under its current lease; optional normalized task metadata is evidence, never authority.
- This is operational transcript completeness, not provider-final billing. Resumes, unsupported phase/order, tainted/late activity, missing EOF, forced shutdown and cancellation remain unknown without refund/replay. Drain consumes the existing deadline and retains cancellation; the [bounded evidence delta](../proposals/factory-local-f3-terminal-evidence-design.md) documents acceptance status and leaves real producer qualification separately gated.
- Missing or invalid structured output fails safely as `needs-review`.
- Never persist auth material or raw chain-of-thought; retain operational events and concise summaries only.

See [ADR-0001](../decisions/ADR-0001-codex-app-server-runtime.md), [runtime runbook](../runbooks/codex-runtime.md), [Phase O design](phase-o-workflow-design.md) and [threat model](../security/threat-model.md). Phase O adds finite logical-role control, not another runtime or stronger runtime-read isolation; selected-source/candidate containment does not guarantee all subsequent filesystem reads are project-only.

## Human-origin planning recovery boundary

The explicit retained-Planner recovery in the [bounded design](../proposals/factory-local-f3-planner-recovery-design.md) is a human proposal/approval path, never a runtime completion override. Only a valid first read-only planning result with `needs-review`, unchanged scope and complete independently validated terminal evidence can qualify. The receipt binds the runtime execution-contract fingerprint in metadata separately from the admitted manifest fingerprint; both original task/context and charged-run identities remain required. Unknown/interrupted usage, cancellation, policy/scope failures, malformed output and production P budget-admission scaffolds cannot qualify.

Offering recovery creates no model turn or worker notification. Exact human plan approval remains a separate action; only then can the existing finite Engineer/Reviewer/QA sequence use its remaining original caps. The old task, original status, usage and events persist. No runtime transport, sandbox, output contract, generic retry or timeout changes. Technical synthetic acceptance does not authorize real recovery or a paid successor.

## Stopped-owner pre-charge recovery boundary

The [uncharged first-claim delta](../proposals/factory-local-f3-engineer-claim-recovery-design.md) adds a process-private explicit worker operation, not a model transport or retry endpoint. Qualification requires an exact reviewed producer/operator pair, unforced native closure with both EOFs, the known initial event/failure shape, no execution identity or candidate effects, complete existing Planner usage and current authority/context. Absence of a run row, error text or human assertion alone is insufficient.

Recovery retains the original failure, task identity and attempt, leaves numeric counters/caps untouched and starts no worker. Only the unchanged normal scheduler/controller can charge and execute its next attempt. Atomic-write diagnostics expose bounded phase/allowlisted code/syscall without private native bodies; the next private observer uses bounded synchronous reads with closed handles. The historical first filesystem cause remains unknown. Technical acceptance cannot renew live writer ownership, apply real recovery, spend quota or accept a candidate.

## Governed execution context profiles

New first governed contracts select the code-owned `governed-local-context-v1` profile. Its fixed settings and inspection-guidance hashes join the full existing execution-contract fingerprint; the selected identifier travels only through trusted stage/runner/executor data. The existing stored opaque fingerprint selects an exact legacy or new candidate. Unknown/malformed hashes, bare threads and changed bindings refuse without reset, backfill or a new persisted facet. Legacy prompts, spawn arguments and RPC order stay unchanged.

Only the new profile spawns `codex -c skills.include_instructions=false app-server --stdio` and sends the same fixed skills setting in thread configuration. After initialization and before any thread start/resume, stable `config/read` with the execution cwd must return an own explicit `config.skills.include_instructions === false`. Missing, invalid, true, refused or unsupported values stop with a generic error; effective configuration is never logged and there is no fallback. This check remains within existing charged preparation and does not refund a refusal.

The setting suppresses automatic skills instruction/catalog text, not the skills subsystem or admitted/routed mandatory sources. Fixed guidance encourages bounded searches and complete sliced reads; all source bodies, prompt byte/line limits, tool ceilings, verification, permission/base instructions, agents-disabled configuration, sandbox/network/approval controls and cumulative usage rules remain intact. Guidance is not a capability boundary. Synthetic tests qualify deterministic composition and denial; actual installed-native support, token savings, latency, cost and four-role feasibility remain unmeasured. The [bounded context design](../proposals/factory-local-f3-context-efficiency-design.md) records technical acceptance separately from the exhausted real F3 ledger.

## Terminal evidence acceptance checkpoint

On 2026-11-02 the bounded terminal-evidence delta completed its synthetic technical acceptance: 258 protocol cases, 184 complete consumer cases, 33 focused browser-read regressions, schemas/typecheck/build/secrets and the real isolated API/Chromium campaign with exactly 31 fake turns and complete owned cleanup. This qualifies the implementation and fake-producer transcript boundary, not a live producer, provider-final billing or the real F3 delivery. The historical failed attempt remains unchanged; a fresh actual workflow still requires its separately bound execution authority and human plan/acceptance decisions. Full-suite/CI debt remains open.
