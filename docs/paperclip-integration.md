# Paperclip Integration

Paperclip is an external orchestrator candidate. It is not the center of Surtec Control Plane.

## Adapter Layer

Paperclip-like tasks should map into:

```text
PaperclipTask -> TaskEnvelope -> Codex CLI
```

The adapter lives under:

```text
adapters/paperclip-codex-adapter/
```

## Replacement Path

A future dashboard, GitHub Issues workflow, Linear integration, Jira integration, or Surtec CLI can replace Paperclip by producing the same `TaskEnvelope` contract.

## Current Status

The adapter is conceptual and has no real Paperclip API dependency. This keeps the control plane independent until Paperclip deployment choices are finalized.

