# Paperclip Codex Adapter

This adapter is a conceptual bridge from Paperclip-like tasks to Surtec `TaskEnvelope` tasks.

Paperclip is optional and replaceable. The Surtec Control Plane should not call a Paperclip-specific API from project automation. Instead, Paperclip, a future dashboard, GitHub Issues, Linear, Jira, or a Surtec CLI can map work into the same neutral `TaskEnvelope` contract.

## Current Scope

- Define local TypeScript types.
- Map a Paperclip-like task into `TaskEnvelope`.
- Provide a placeholder entrypoint for future integration.
- Avoid real Paperclip API dependencies.

## Future Work

- Add a real Paperclip source adapter when Paperclip deployment choices are finalized.
- Add validation against `schemas/task-envelope.schema.json`.
- Add persistence for adapter events and execution results.

