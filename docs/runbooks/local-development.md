# Local development

## Requirements

- Node.js 20 or newer.
- pnpm.
- Git.
- Codex CLI for real dispatch.
- Optional `gh` and Railway credentials for their integrations.

## Setup

```text
pnpm install --frozen-lockfile
pnpm codex:generate-protocol
pnpm test
pnpm typecheck
pnpm build
```

Set `SURTEC_PROJECTS_ROOT` when sibling repositories are not under the control plane's parent directory. Keep machine-specific values outside Git.

## Run

```text
pnpm dev
```

- UI: `http://localhost:5173`
- API: `http://localhost:4317`

For a production-style local run:

```text
pnpm build
pnpm start
```

## Validation

Use `pnpm smoke:api` for the local API smoke. Real agent execution is never part of the normal test suite; see the Codex runtime runbook for the explicit smoke command.
