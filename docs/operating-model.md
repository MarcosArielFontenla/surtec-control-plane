# Operating Model

Surtec Control Plane supports a small software studio model where humans make decisions and agents assist with analysis, implementation, review, and documentation.

## Roles

- Humans decide strategy, scope, approvals, merges, releases, and legal conclusions.
- Paperclip or a future orchestrator coordinates tasks and schedules.
- Codex CLI executes task envelopes in project repositories.
- Codex in VS Code supports visual review of generated diffs and docs.
- Surtec agents provide role-specific help under governance rules.

## Work Flow

1. A task is created by a human, Paperclip, GitHub, Linear, Jira, a CLI, or a future dashboard.
2. The task is normalized into a `TaskEnvelope`.
3. The selected agent runs through Codex CLI in the target repository.
4. The agent produces logs, summaries, changed files, tests run, risks, and next steps.
5. A human reviews the result before merge, deployment, publication, or legal reliance.

## Boundaries

The control plane coordinates work but does not contain product source code. Product repositories remain separate.

