# ADR-0001: Codex App Server as the execution runtime

- Status: Accepted
- Date: 2026-09-21
- Runtime evaluated: Codex CLI 0.145.0 on Windows

## Context

The control plane needs a local execution runtime with sandbox selection, explicit approvals, streamed operational events, cancellation, resumable conversations, structured final results, usage reporting, and deterministic automated tests without a paid request.

The supported candidates are the Codex TypeScript SDK and Codex App Server. The evidence was checked against the installed CLI and current official documentation:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## Decision drivers

| Requirement | App Server | TypeScript SDK |
| --- | --- | --- |
| Read-only and workspace-write sandbox | Explicit thread/turn fields | Supported at thread level |
| Approval requests and decisions | Bidirectional server requests | The public high-level surface does not expose the same client workflow |
| Streamed items and deltas | First-class notifications | Higher-level thread streaming is suitable for simpler automation |
| Cancellation | `turn/interrupt` plus process termination | Abort support is simpler but exposes less lifecycle detail |
| Start/resume conversation | `thread/start` and `thread/resume` | Start and resume are supported |
| Structured final result | Per-turn `outputSchema` | Final response is available; the App Server exposes the underlying turn contract |
| Usage | Token-usage notifications | Result-oriented abstraction |
| Windows | Native installed CLI is available | Node.js is supported, but the package would add another runtime dependency |
| Testability | JSONL transport can be replaced with a deterministic fake | SDK calls can be mocked but hide protocol lifecycle behavior |

Official guidance positions App Server for rich clients that need authentication, conversation history, approvals, and streamed events, while positioning the SDK for automation and CI-style jobs. This product is a rich local client.

## Decision

Use Codex App Server over its default local `stdio` JSONL transport.

- Spawn the installed `codex app-server --stdio` process without a shell.
- Initialize once per connection.
- Start or resume one thread and start one turn per dispatched task.
- Use only the stable protocol surface. Experimental capabilities remain disabled.
- Generate TypeScript protocol bindings from the installed CLI and keep the generation command reproducible.
- Normalize protocol notifications behind an `AgentExecutor` boundary.
- Persist thread and turn identifiers, normalized usage, and operational events.
- Route approval requests through code. Unknown requests fail closed.
- On abort, request `turn/interrupt` and then terminate the child if it does not exit.
- Use the user's existing documented Codex authentication. The control plane does not copy, persist, or log auth material.
- Omit the model by default so the user's configured model applies. An optional environment setting may override it.

## Sandbox mapping

| Control-plane mode | App Server sandbox | Working directory |
| --- | --- | --- |
| Analysis | read-only | Target repository |
| Implementation | workspace-write | Isolated task worktree |
| Implementation with verification | workspace-write | Isolated task worktree |

Network access is disabled for dispatched turns. Full-access mode is never used. Project subprocesses receive a reduced environment through the runtime shell-environment policy. The control plane continues to run the registry's exact verification commands after the agent commit as the authoritative result.

The stable App Server surface does not provide a general per-turn allowlist for commands that already fit inside the sandbox. Phase 0 therefore combines sandbox isolation, no network, a reduced subprocess environment, approval denial for non-allowlisted escalation requests, and explicit instructions. Canonical registry policy and stronger command enforcement remain Phase 1 work; this residual limitation is not represented as stronger protection than the runtime actually provides.

## Structured results

The turn receives the repository's agent-output JSON Schema through `outputSchema`. The final payload is parsed without markdown scraping, combined with control-plane-owned evidence, and validated as an `AgentResult`. Missing or invalid output becomes `needs-review`; it never defaults to success.

## Generated bindings

`pnpm codex:generate-protocol` regenerates stable TypeScript bindings from the installed CLI into `runner/generated/codex-app-server/`. Generated files are not edited manually. A version marker records which CLI generated them.

## Consequences

Positive:

- The runtime exposes the complete lifecycle needed by the planned task detail view.
- Protocol behavior is testable with a fake process and no external request.
- The control plane follows the installed runtime instead of guessing protocol fields.
- No model name or separate agent SDK version is embedded in application code.

Trade-offs:

- The client owns JSON-RPC correlation, malformed-line handling, approval responses, shutdown, and compatibility checks.
- Generated protocol bindings add repository files.
- One App Server process per task is intentionally simple for Phase 0; connection pooling and worker health belong to durable orchestration work.

## Rejected alternatives

- TypeScript SDK as the primary runtime: simpler for one-shot automation, but loses direct control over the rich approval and event lifecycle this product requires.
- Non-interactive CLI output parsing: useful only as a diagnostic or CI fallback, not as the main product protocol.
- WebSocket transport: unnecessary locally and currently not the supported production transport.

