# Surtec Control Plane

A **personal portfolio control plane**: one local dashboard to see the live status of, and orchestrate,
my bespoke git projects from a single place — instead of opening each one by hand in the CLI / VS Code.

It is intentionally **not** a product repository: real applications live in their own repos under a
projects root (default: this repo's parent folder). This repository is only the control plane.

## Stack

- **UI:** Vite + React 18 (`dashboard/src/ui`).
- **API:** Hono + `@hono/node-server` (`dashboard/src/server`), on `:4317`.
- **Task runner:** the **Claude Agent SDK** (`runner/`) — execution is Claude-only.
- **State:** a file-first store under `state/` (gitignored).
- **Tests:** Vitest + Testing Library (jsdom). **Package manager:** pnpm.

```bash
pnpm install
pnpm state seed     # load example data into state/ (optional)
pnpm dev            # UI on http://localhost:5173 (API on :4317; /api proxied)
```

Production-style run: `pnpm build && pnpm start`. Tests: `pnpm test`.
Set `ANTHROPIC_API_KEY` for dispatch (copy `.env.example` → `.env`).

## What it does

The dashboard is organized into four views (sidebar): **Overview**, **Procesos**, **Issues**, **Actividad**.

- **Portfolio discovery + live git status.** Auto-discovers git repos under a root
  (`SURTEC_PROJECTS_ROOT`, default = parent dir; ignore with `SURTEC_PROJECTS_IGNORE`) and shows
  per-project branch, dirty/uncommitted, ahead/behind, and last commit (read-only local git, cached).
  `registry/projects.yml` is a config overlay matched by folder name.
- **Agent dispatch.** From **Nueva tarea**, pick a project + agent + mode and write instructions; the
  control plane runs a Claude agent (Agent SDK) against the repo and records its lifecycle + result live.
  - **Analizar** = read-only (inspect only).
  - **Implementar** = workspace-write: edits in an isolated git worktree (`../surtec-worktrees/...`) on
    `agent/<task>-<agent>`; the runner commits the edits. The agent never runs shell, merges, deploys, or pushes.
  - **Implementar + auto-fix (verify)** = the agent gets a Bash tool restricted to the project's declared
    verify commands so it can run tests and fix failures during its turn.
  - After a workspace-write task finishes, the runner runs the project's **verification** commands and
    records the real pass/fail (a ✓/✗ badge), independent of what the agent claims.
- **Review.** Finished tasks show **Aprobar** / **Rechazar**. Aprobar (workspace-write) pushes the branch
  to origin and opens a **PR** via `gh` (merge stays manual); Rechazar discards the worktree + branch.
- **Per-project actions.** Open in **VS Code** / **folder** (server resolves the real path; no
  client-supplied paths), **GitHub** link, **git Fetch/Pull/Push** (push confirmed), **branch** list/
  switch/create, **PRs · Issues + CI** and **dependency staleness** (read-only `gh`/`npm outdated`,
  on-demand + cached), and per-project **Notas** (a persisted TODO checklist).
- **Procesos.** Launch a project's `dev`/`build`/`test`/`lint`/`install` from the dashboard and stream
  output live over SSE; stop them (tree-kill). **Bulk sync:** Fetch-all / Pull-all across repos.
- **Issues.** A unified inbox aggregating open GitHub issues across all configured repos (read-only `gh`,
  async + parallel), repo-filterable, sorted by activity.
- **Actividad.** A cross-project timeline merging recent local commits with dispatched tasks.

## Design

The UI uses the **Boreal** design tokens (dark alpine theme — `dashboard/src/ui/styles/boreal-tokens.css`:
ink/glacier/ember/aurora, Bricolage/Hanken/Space Mono) with the **Claude redesign** layout
(`dashboard.css`): a fixed sidebar, KPI strip, dense frosted-glass project cards, and lucide icons.

## Safety

No deploys. No merges to protected branches. No pushing branches unless you ask. No secrets. The agent
never runs shell except under the explicit per-task auto-fix opt-in (and only the declared verify commands).

## Conventions & methodology

See `CLAUDE.md`. Work is done as Superpowers slices (brainstorm → spec → plan → TDD → review → finish);
specs and plans live in `docs/superpowers/`.
