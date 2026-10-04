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
- Map analysis to a read-only sandbox and implementation to a workspace-write sandbox in an isolated Git worktree.
- Never use a full-access sandbox for dispatched tasks.
- Enforce capabilities in code, sandbox configuration, approvals, and registry policy, never by prompt instructions alone.
- Automated tests use protocol fakes and never paid model calls. Real runtime smokes require explicit opt-in.
- Missing or invalid structured output fails safely as `needs-review`.
- Never persist auth material or raw chain-of-thought; retain operational events and concise summaries only.

See [ADR-0001](../decisions/ADR-0001-codex-app-server-runtime.md), [runtime runbook](../runbooks/codex-runtime.md), and [threat model](../security/threat-model.md). This document restates existing constraints; it neither changes the ADR nor claims that historical architecture descriptions already cover the latest Phase L implementation.
