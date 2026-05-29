# Surtec Control Plane

Surtec Control Plane is the coordination layer for Surtec projects, agents, skills, automation, upstream monitoring, and orchestration adapters.

It is intentionally not a product repository. Real applications such as `legal-ai-workbench`, `stock-control`, `appointment-manager`, `automation-lab`, `portfolio-site`, and `personal-saas` must live in separate repositories. This repository manages how work is described, delegated, reviewed, and monitored.

## What This Is

- A registry for Surtec companies, projects, agents, routines, permissions, and upstreams.
- A neutral task contract centered on `TaskEnvelope`.
- A Codex CLI runner layer for dry-run and controlled execution.
- A Paperclip adapter placeholder that can be replaced by another orchestrator.
- A home for Surtec-specific skills across software, QA, product, security, and Argentine legal review.
- A lightweight upstream monitor for external repositories used as references.

## What This Is Not

- It is not the source code for Surtec products.
- It is not a direct fork of Paperclip, Superpowers, agency-agents, or legal reference repositories.
- It is not a deployment system.
- It does not store secrets or production credentials.
- It does not merge or deploy work automatically.

## Architecture

```text
Paperclip or another orchestrator
  -> Surtec Adapter Layer
  -> TaskEnvelope
  -> Codex CLI runner
  -> Surtec project repositories
```

Paperclip is treated as the first external orchestrator, not as the core of the system. Any future dashboard, GitHub issue workflow, Linear integration, Jira integration, CLI tool, or custom Surtec UI should be able to emit the same `TaskEnvelope` shape.

## Codex CLI

Codex CLI is the primary execution engine for agent tasks. Runners in `adapters/codex-runner/` and `scripts/projects/` default to dry-run mode. Real execution requires:

```bash
SURTEC_EXECUTE=1 ./adapters/codex-runner/run-task.sh path/to/task.json
```

All real execution must preserve human review gates, avoid deployments, and avoid merges.

## Codex in VS Code

Codex in VS Code is the preferred place for human review. Agents can generate branches, logs, reports, and suggestions, but humans inspect diffs before accepting changes.

## Superpowers

Superpowers is used as a development methodology when installed. Surtec agents should use it for brainstorming, planning, TDD, debugging, review, verification, and branch finishing workflows when applicable.

## agency-agents

`agency-agents` is treated as an inspiration source for agent definitions. Surtec does not import it wholesale. Candidate agents must be selected, transformed, reviewed, and adapted to Surtec naming and governance.

## claude-for-legal-argentina

`claude-for-legal-argentina` is treated as a legal reference source for building Argentine legal skills. Legal materials require human legal review before use. Agents must not invent law or present legal analysis as professional advice.

## Project Organization

Expected external layout:

```text
surtec/
  legal-ai-workbench/
  stock-control/
  appointment-manager/
  automation-lab/
  portfolio-site/
  personal-saas/
```

This repository points to those projects through `registry/projects.yml`.

## Run a Task

Create a `TaskEnvelope` JSON file, then run:

```bash
./adapters/codex-runner/run-task.sh task.json
```

By default, the runner prints the `codex exec` command that would run. It executes only when `SURTEC_EXECUTE=1`.

The shell scripts require a Bash-compatible environment. On Windows, use WSL, Git Bash, or run the scripts in CI on Ubuntu.

## Add a New Project

1. Add the project to `registry/projects.yml`.
2. Define allowed agents, commands, sandbox defaults, and approval requirements.
3. Bootstrap the external repo:

```bash
./scripts/projects/bootstrap-project.sh project-id ~/dev/surtec/project-id
```

## Add a New Agent

1. Add an entry to `registry/agents.yml`.
2. Add a matching TOML file under `agents/codex/`.
3. Keep the agent scoped, reviewable, and aligned with `AGENTS.md`.
4. Add eval coverage under `evals/agents/` when behavior becomes important.

## Watch Upstreams

Run:

```bash
./scripts/upstream/check-updates.sh
```

The workflow `.github/workflows/upstream-watcher.yml` runs this weekly and uploads reports. It does not update upstreams automatically.

## Status

Initial scaffold only. Not production-ready.

## Dashboard (local)

A local web dashboard shows live status across Surtec projects (project cards,
in-progress/history tasks, risks and pending approvals). It reads a file-first store
under `state/` (gitignored).

```bash
pnpm install
pnpm state seed     # load example data into state/
pnpm dev            # UI on http://localhost:5173 (API on :4317)
```

For a production-style run: `pnpm build && pnpm start` (serves UI + API on :4317).
Design: `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.

### Dispatch (read-only)

Set `ANTHROPIC_API_KEY` (copy `.env.example` to `.env`). From the dashboard, use
**Nueva tarea** to pick a project + agent and write instructions; the control plane
runs a **read-only** Claude agent (Agent SDK) against the project repo and writes its
lifecycle and result to the store, which the dashboard shows live. Read-only means the
agent can inspect the repo but cannot modify files, run commands, merge, deploy, or push.
Design: `docs/superpowers/specs/2026-05-29-dispatch-runner-design.md`.

**Workspace-write (implement):** In **Nueva tarea**, choosing **Implementar** runs the agent in
workspace-write mode: it edits files **in an isolated git worktree** (`../surtec-worktrees/...`) on
a branch `agent/<task>-<agent>`, and the control plane commits the edits to that branch. The agent
still cannot run shell commands, merge, deploy, or push. Review the branch in VS Code and run the
tests; the changed files + diffstat are recorded on the task. Worktrees are not auto-removed.
Design: `docs/superpowers/specs/2026-05-29-workspace-write-design.md`.

### Review (approve / reject)

Finished tasks show **Aprobar** / **Rechazar** in the attention panel. **Aprobar** records the
decision and, for a workspace-write task, pushes its branch `agent/<task>-<agent>` to origin
(after a confirmation — nothing is merged or PR'd; you open the PR on GitHub). **Rechazar** records
the decision and discards the worktree + local branch. Decided tasks leave the attention panel.
Pushing needs an `origin` remote and your git credentials; if absent, the task is still recorded
approved with the push error noted. Design: `docs/superpowers/specs/2026-05-29-review-gate-design.md`.
