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
- Missing or invalid structured output fails safely as `needs-review`.
- Never persist auth material or raw chain-of-thought; retain operational events and concise summaries only.

See [ADR-0001](../decisions/ADR-0001-codex-app-server-runtime.md), [runtime runbook](../runbooks/codex-runtime.md), [Phase O design](phase-o-workflow-design.md) and [threat model](../security/threat-model.md). Phase O adds finite logical-role control, not another runtime or stronger runtime-read isolation; selected-source/candidate containment does not guarantee all subsequent filesystem reads are project-only.
