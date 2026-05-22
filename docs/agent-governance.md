# Agent Governance

Surtec agents operate under explicit safety and review rules.

## Non-Negotiable Rules

- Agents do not merge.
- Agents do not deploy.
- Agents do not push without approval.
- Agents do not touch real secrets.
- Agents do not update upstreams automatically.
- Legal agents do not provide final legal advice.

## Branches And Worktrees

Each implementation task should use a dedicated branch or worktree. The recommended branch pattern is:

```text
agent/<task-id>-<agent-id>
```

Worktrees should be created outside the project repository, under a sibling `surtec-worktrees` directory.

## Review Gates

Human review is required before:

- Merge.
- Deployment.
- Secret changes.
- Legal external delivery.
- Architecture changes with broad impact.
- Upstream imports.

