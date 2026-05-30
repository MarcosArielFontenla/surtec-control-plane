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

On approve, a workspace-write task also opens a **Pull Request** via the `gh` CLI (after the push),
targeting the project's `default_branch` from the registry. The merge stays manual on GitHub. If `gh`
is not installed/authenticated (or a PR already exists), the task is still recorded approved + pushed
with the PR error noted. Design: `docs/superpowers/specs/2026-05-29-pr-on-approve-design.md`.

### Self-verify

When a workspace-write task finishes and its edits are committed, the runner runs the project's
declared verification commands (from `registry/projects.yml` — an explicit `verify:` list, or by
default `[install, test]` from `commands`) inside the worktree, captures the real exit codes, and
records the result on the task. The dashboard shows a ✓/✗ badge in the attention panel so you see
verified work before approving. The agent never runs shell — the runner performs verification.
Verification is fail-fast and never crashes a run; it does not block approval (the human decides).

### Auto-fix loop (opt-in)

A workspace-write task can be dispatched in "Implementar + auto-fix (verify)" mode. In this mode the
agent is given a Bash tool restricted by an exact-match allowlist: it may run ONLY the project's
declared verify commands (from `registry/projects.yml`), so it can run tests/typecheck during its turn,
see failures, and fix its edits before finishing. Any other shell command is denied by the runner's
`canUseTool` policy. This is the one place the "agent never runs shell" rule is relaxed, and only under
this explicit per-task opt-in. read-only and plain workspace-write tasks never get shell. The runner
still runs verification after the commit (see Self-verify) as the authoritative pass/fail record.

### Portfolio discovery

The dashboard auto-discovers your projects by scanning a root folder (default: the control plane's
parent dir; override with `SURTEC_PROJECTS_ROOT`) for git repos at depth 1, and shows live local git
status per project (branch, dirty + uncommitted count, ahead/behind origin, last commit). The
`registry/projects.yml` is now a config overlay matched by folder name — a discovered project without a
registry entry is shown but not yet dispatchable. Ignore folders with `SURTEC_PROJECTS_IGNORE`
(comma-separated). Git status is read-only and local (no fetch), cached ~15s.
