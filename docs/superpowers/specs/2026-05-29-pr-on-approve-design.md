# Surtec Control Plane — PR on Approve (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** PR on approve (fifth control-plane slice; extends review-gate)
- **Builds on:** `docs/superpowers/specs/2026-05-29-review-gate-design.md`

## 1. Context & Goal

Approving a finished workspace-write task already pushes its branch to origin. This slice
additionally **opens a Pull Request** via the `gh` CLI on approve, closing the GitHub loop:
dispatch → implement → review → push + PR. The merge stays manual on GitHub. PR creation is part
of the human-approved, UI-confirmed action, and degrades gracefully when `gh` is unavailable.

## 2. Key Decisions

- **PR is opened automatically on approve** (of a workspace-write task that pushed successfully),
  in the same action — not a separate button.
- **Graceful degradation:** if `gh` is missing / not authenticated / a PR already exists, the task is
  still recorded `approved` + `pushed`, with the PR error recorded; nothing crashes.
- **Base branch = the registry's `default_branch`** for the project (e.g. `main`), exposed via
  `loadRegistryProjects`; falls back to `"main"` if unavailable. Honors the registry as source of truth.
- **`gh` is run by the runner** (a new `runner/github.ts`, parallel to `runner/worktree.ts`). It only
  **creates** a PR (`gh pr create`) — never `gh pr merge`, never deploy.
- **Read-only tasks** never push and never open a PR (unchanged).

## 3. Scope

**In scope (v1):**

- `lib/state/derive.ts` — `RegistryProject` gains `default_branch?`.
- `dashboard/src/server/registry.ts` — `loadRegistryProjects` reads `default_branch`.
- `lib/state/types.ts` — `ReviewDecision` gains `pr_url?`.
- `runner/github.ts` — `buildPrBody` (pure) + `openPullRequest` (gh pr create; no throw).
- `dashboard/src/server/review.ts` — `approveTask` opens a PR after a successful push.
- `dashboard/src/server/index.ts` — the approve endpoint passes `repoRoot` to `approveTask`.
- `dashboard/src/ui/components/AttentionPanel.tsx` — approve confirm text mentions the PR.

**Out of scope (future):** merging the PR; auto-merge; choosing reviewers/labels/draft; a PR for
read-only tasks (no branch); surfacing the PR link in a task-detail view (it is recorded on the task).

## 4. Architecture

```
Aprobar (confirm: "...pushea la branch y abre un PR") → POST /api/tasks/:id/approve
  approveTask(id, repoRoot):
    (validate finished + not decided, as today)
    decision = { status: "approved", at: now }
    if sandbox === "workspace-write" && branch && committed:
        r = pushBranch(expandHome(repo_path), branch)
        decision.branch = branch; decision.pushed = r.pushed
        if (!r.pushed) decision.error = r.error
        else:
            base  = defaultBranchFor(repoRoot, project)            // registry default_branch, fallback "main"
            title = envelope.title
            body  = buildPrBody(envelope, result)
            pr = openPullRequest(expandHome(repo_path), branch, base, title, body)   // gh pr create — never merge
            if (pr.url) decision.pr_url = pr.url
            else decision.error = pr.error
    rec.decision = decision; rec.updated_at = decision.at; writeTask(rec); return decision
read-only / push failed → no PR.
```

`gh` is confined to `runner/github.ts`. The PR targets the project's `default_branch`; the head is the
agent branch. Nothing merges.

## 5. Components

`lib/state/derive.ts`: `RegistryProject` gains `default_branch?: string` (optional — existing
`buildOverview` and its fixtures unaffected).

`dashboard/src/server/registry.ts`: `loadRegistryProjects` maps `default_branch: v?.default_branch ?? null`
(reads the `default_branch` key already present in `registry/projects.yml`). `RegistryDoc` updated.

`lib/state/types.ts`: `ReviewDecision` gains `pr_url?: string`.

`runner/github.ts` (new):
- `buildPrBody(envelope: TaskEnvelope, result: AgentResult | null): string` — pure. Sections:
  `## Summary` (result.summary or "(no summary)"), `## Risks` / `## Next steps` (bulleted, omitted when
  empty), and a footer `\n---\nDispatched by Surtec Control Plane · task <id> · agent <agent>`.
- `openPullRequest(sourceRepo, branch, base, title, body): { url?: string; error?: string }` —
  `spawnSync("gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], { cwd: sourceRepo, encoding: "utf8", timeout: 30_000 })`.
  On success returns `{ url: stdout.trim() }` (gh prints the PR URL); on any failure (non-zero exit,
  gh missing via `r.error`) returns `{ error: (stderr || stdout || r.error?.message).trim() }`. Never throws.

`dashboard/src/server/review.ts`:
- `approveTask(taskId, repoRoot = process.cwd())` — after a successful push, resolve the base branch
  (`defaultBranchFor(repoRoot, project)`: load the registry, find the project, return `default_branch`;
  any error or missing → `"main"`), build the body, call `openPullRequest`, and record `pr_url` or `error`.
- Imports `loadRegistryProjects` from `./registry` and `openPullRequest`/`buildPrBody` from `../../../runner/github`.

`dashboard/src/server/index.ts`: the `POST /api/tasks/:id/approve` handler passes `repoRoot` —
`approveTask(c.req.param("id"), repoRoot)`. (Reject is unchanged.)

`dashboard/src/ui/components/AttentionPanel.tsx`: the approve confirm message becomes
"¿Aprobar <id>? Si es workspace-write, se pushea su branch a origin y se abre un PR."

## 6. Data Flow & State Transitions

No new lifecycle states; extends the `decision` record. On approve of a workspace-write task:
push first; only if `pushed === true` do we attempt the PR. `decision.pr_url` is set on PR success;
`decision.error` holds the push error (push failed, no PR) OR the PR error (push ok, PR failed) —
at most one step fails, so a single `error` field is unambiguous. Decided tasks still drop from the
attention panel (unchanged).

## 7. Safety & Governance

- `gh` only **creates** a PR. There is no `gh pr merge`, no deploy, anywhere. The merge remains a
  manual human action on GitHub. (AGENTS.md: no auto-merge.)
- PR creation runs only inside the human-approved, UI-confirmed approve action, only for a
  workspace-write task whose branch was already pushed.
- Run by the runner via `spawnSync("gh", argsArray, ...)` — no shell, no injection; 30s timeout.
- Graceful: `gh` missing / unauthenticated / PR already exists → recorded in `decision.error`, task
  still `approved` + `pushed`, server never crashes.
- No new secrets: `gh` uses its own stored auth; nothing is logged or persisted by the control plane.
- Base branch is the project's declared `default_branch` (not a protected-branch push — we open a PR
  *targeting* it, we never push to it).

## 8. Error Handling

`openPullRequest` returns `{ error }` rather than throwing. `approveTask` skips the PR entirely when the
push failed. A PR failure is recorded in `decision.error` while the decision stays `approved`. The
endpoint's existing try/catch (ReviewError/TaskNotFoundError/500) is unchanged.

## 9. Testing (TDD)

- `runner/github.test.ts`: `buildPrBody(envelope, result)` includes the summary, bulleted risks +
  next_steps, and the footer with the task id; omits empty sections; handles `result === null`.
- `dashboard/src/server/review.test.ts` (extend; mock `../../../runner/github`): approve a
  workspace-write task → `openPullRequest` called with `(repoPath, branch, "main", title, body)` and
  `decision.pr_url` set; PR failure (`openPullRequest` returns `{error}`) → `decision.error` recorded,
  status still `approved`; read-only approve → no `openPullRequest`; push-failure (mock `pushBranch`
  `{pushed:false}`) → no `openPullRequest`.
- `dashboard/src/server/registry.test.ts` (extend): `loadRegistryProjects` returns `default_branch`.
- `dashboard/src/server/index.test.ts`: the approve endpoint still returns 200 for a read-only task
  (no gh). (The endpoint now passes `repoRoot`; confirm no regression.)

Test runner: vitest. `runner/github.ts`'s `openPullRequest` (the gh call) is mocked in review tests
(like the SDK boundary); only the pure `buildPrBody` is unit-tested directly.

## 10. Evolution Path

- `gh pr merge` / auto-merge for non-protected targets after CI passes.
- Reviewers / labels / draft PRs; a configurable PR template.
- Surface `pr_url` as a link in the dashboard (task-detail view).

## 11. Open Questions

None blocking. Opening a PR requires `gh` installed + authenticated and the project repo to have a
GitHub remote; absent any of these, the task is recorded `approved` + `pushed` with the gh error noted.
