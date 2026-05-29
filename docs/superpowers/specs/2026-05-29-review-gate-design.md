# Surtec Control Plane — Review Gate (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Review gate (fourth control-plane slice; follows workspace-write)
- **Builds on:** dispatch + workspace-write specs (`2026-05-29-dispatch-runner-design.md`, `2026-05-29-workspace-write-design.md`)

## 1. Context & Goal

Workspace-write tasks finish as a committed branch `agent/<task>-<agent>` in an isolated worktree.
Review gate lets a human **act on a finished task from the dashboard**: **Approve** (record the
verdict and push the branch to origin) or **Reject** (record the verdict and discard the worktree +
local branch). This closes the human-in-the-loop and cleans up rejected work. Nothing is merged or
deployed; pushing is the human's explicit, UI-confirmed action.

## 2. Key Decisions

- **Approve = record + push the branch** (no merge, no PR). The approved branch lands on origin
  ready for a human PR/merge on GitHub. `requires_human_approval` and the no-auto-merge governance
  are honored — push is the explicit approval action.
- **Push gate = a UI confirmation dialog.** Clicking Approve confirms "Push `agent/<task>-<agent>`
  to origin?" before the control plane pushes. The confirmation is the explicit human ask.
- **Reject = record + discard.** Marks the task rejected and removes the worktree + deletes the
  local branch (`git worktree remove --force` + `git branch -D`), after a UI confirmation (it
  deletes local work). This also resolves the deferred worktree cleanup.
- **Structure (Approach A):** a dedicated `dashboard/src/server/review.ts` (`approveTask`/`rejectTask`),
  and `runner/worktree.ts` gains `pushBranch`/`removeWorktree` (git run by the runner). Endpoints +
  a `decision` field on the task + an `AttentionPanel` change.
- **Read-only tasks** (no branch) are also reviewable: Approve records the verdict with no git;
  Reject records the verdict with no worktree to remove.

## 3. Scope

**In scope (v1):**

- `runner/worktree.ts` += `pushBranch(sourceRepo, branch)` and `removeWorktree(sourceRepo, worktreePath, branch)`.
- `dashboard/src/server/review.ts` — `approveTask`/`rejectTask` + `ReviewError`.
- `POST /api/tasks/:id/approve` and `POST /api/tasks/:id/reject`.
- `lib/state/types.ts` — `ReviewDecision` + `decision` on `TaskRecord`.
- `lib/state/derive.ts` — exclude already-decided tasks from the attention panel.
- `dashboard/src/ui/` — Approve/Reject buttons (with confirm) on task-level attention items; `api.ts` helpers.

**Out of scope (future):** opening a PR (gh), merging, bulk worktree cleanup, multi-user, an audit log
beyond the single `decision` record, undo.

## 4. Architecture

```
Dashboard AttentionPanel — items of kind "needs-review" / "awaiting-approval" get [Aprobar] [Rechazar];
"risk"/"blocker" items are informational (no buttons).

Aprobar → UI confirm → POST /api/tasks/:id/approve
  review.approveTask(id, repoRoot):
    load record; require lifecycle === "finished" and decision == null (else ReviewError);
    decision = { status: "approved", at: now };
    if envelope.sandbox === "workspace-write" AND metadata.run.branch AND committed:
        const r = pushBranch(sourceRepo, branch);   // git push origin <branch>; never merge
        decision.branch = branch; decision.pushed = r.pushed; if (!r.pushed) decision.error = r.error;
    rec.decision = decision; writeTask(rec); return decision;

Rechazar → UI confirm → POST /api/tasks/:id/reject
  review.rejectTask(id, repoRoot):
    load; require finished and decision == null;
    decision = { status: "rejected", at: now };
    if workspace-write AND metadata.run.worktree_path:
        try { removeWorktree(sourceRepo, worktree_path, branch); }
        catch (e) { decision.error = e.message; }   // still recorded rejected; cleanup error noted
    rec.decision = decision; writeTask(rec); return decision;

derive.buildOverview: a DECIDED task (rec.decision != null) contributes NO attention items
(needs-review, awaiting-approval, risks, or blockers). Decided tasks therefore drop out of the
attention panel entirely on the next poll.
```

`lib/state` stays dependency-free; git stays confined to `runner/worktree.ts` (the runner).
`sourceRepo` = `expandHome(envelope.repo_path)`; `branch`/`worktree_path` come from `metadata.run`.

## 5. Components

`runner/worktree.ts` (extend):
- `pushBranch(sourceRepo: string, branch: string): { pushed: boolean; error?: string }` —
  `git -C <sourceRepo> push origin <branch>`; returns `{ pushed: true }` on success, else
  `{ pushed: false, error }`. Does NOT throw (push failure is a reportable outcome, not a crash).
- `removeWorktree(sourceRepo: string, worktreePath: string, branch: string): void` —
  `git -C <sourceRepo> worktree remove --force <worktreePath>` then `git -C <sourceRepo> branch -D <branch>`.
  Best-effort: a failure throws (caught by the caller and recorded), but a missing worktree is tolerated.

`dashboard/src/server/review.ts`:
- `class ReviewError extends Error`.
- `approveTask(taskId, repoRoot = process.cwd()): ReviewDecision` and
  `rejectTask(taskId, repoRoot = process.cwd()): ReviewDecision` — load via the store, validate
  (`finished` + not already decided → else `ReviewError`), record `decision`, run the git side effect
  for workspace-write tasks, `writeTask`, return the decision.

`dashboard/src/server/index.ts`:
- `POST /api/tasks/:id/approve` and `POST /api/tasks/:id/reject` → call the review functions →
  200 `{ decision }`; `ReviewError` → 400; missing task → 404; other → 500. (No request body needed.)

`lib/state/types.ts`:
```ts
export interface ReviewDecision {
  status: "approved" | "rejected";
  at: string;
  branch?: string;
  pushed?: boolean;
  error?: string;
}
// TaskRecord gains: decision: ReviewDecision | null
```

`lib/state/derive.ts`: in the attention loop, skip a task entirely (`continue`) when
`t.decision != null` — a decided task contributes no attention items at all.

`dashboard/src/ui/`:
- `api.ts` — `approveTask(id)` / `rejectTask(id)` (POST, no body; throw with the server `{error}` on !ok).
- `AttentionPanel.tsx` — for items of kind `needs-review` / `awaiting-approval`, render
  **Aprobar** / **Rechazar** buttons; each uses a confirm (`window.confirm`) before calling the API;
  on success the polling refresh drops the item. A submit error shows inline.

## 6. Data Flow & State Transitions

`decision` is a new field on `TaskRecord`, `null` until a human decides. No lifecycle change (the task
is already `finished`). Approve/Reject set `decision` once (immutable: a second decision → `ReviewError`).
- Approve (workspace-write, branch present) → `decision.status = "approved"`, push attempted,
  `decision.pushed`/`error` recorded.
- Approve (read-only / no branch) → `decision.status = "approved"`, no git.
- Reject (workspace-write) → `decision.status = "rejected"`, worktree + branch removed.
- Reject (read-only) → `decision.status = "rejected"`, no git.
Decided tasks leave the attention panel (derive). History/detail still show the task + its decision.

## 7. Safety & Governance

- **Push is the only outward action**, only on Approve **after a UI confirm** (the explicit human ask
  per AGENTS.md "do not push unless explicitly asked"). Never merges; never touches protected branches
  (main/master) — it pushes the feature branch only.
- **git is run only by the runner** (`worktree.ts`), with fixed commands (`push`, `worktree remove`,
  `branch -D`). No merge/deploy command exists.
- **Reject discard is destructive but local and confirmed** (`--force` worktree remove + `branch -D`).
- **Decisions are immutable** — re-deciding a decided task returns `ReviewError` (→ 400).
- **Push failure** (no remote, auth) is caught: the task is still `approved` with `pushed: false` +
  `error`, surfaced to the UI; the server never crashes.
- **Secrets:** push uses the user's ambient git credentials; nothing is stored or logged.

## 8. Error Handling

`approveTask`/`rejectTask` validate and never crash the server. `pushBranch` returns an error rather
than throwing (recorded in `decision`). `removeWorktree` may throw on a genuine git failure; the caller
catches it and still records `rejected` with the error noted. Endpoints map `ReviewError` → 400,
missing task → 404, anything else → 500 `{error}`.

## 9. Testing (TDD)

- `runner/worktree.test.ts` (extend, real git): `pushBranch` against a temp **bare** remote added as
  `origin` (after push, the branch exists on the remote); `removeWorktree` (the worktree dir is gone
  and the branch is deleted).
- `dashboard/src/server/review.test.ts` (mock `./worktree` `pushBranch`/`removeWorktree`; temp store):
  approve a workspace-write task → `approved` + `pushBranch` called with the branch; approve a read-only
  task → `approved`, no push; reject a workspace-write task → `rejected` + `removeWorktree` called;
  re-deciding a decided task → `ReviewError`; a non-`finished` task → `ReviewError`.
- `lib/state/derive.test.ts` (extend): a finished `requires_human_approval` task with a `decision`
  is NOT in attention; with `decision == null` it IS (awaiting-approval). Same for `needs-review`.
- `dashboard/src/server/index.test.ts` (extend): `POST /api/tasks/:id/approve` → 200 + `decision`
  recorded (read-only finished task, no git); `POST .../reject` → 200; missing → 404; already-decided → 400.
- `dashboard/src/ui/components/AttentionPanel.test.tsx` (new, jsdom): a task-level item renders
  Aprobar/Rechazar; clicking (with `window.confirm` stubbed true) POSTs to the right endpoint; risk
  items render no buttons.

Test runner: vitest.

## 10. Evolution Path

- Open a PR via `gh` on approve; optional auto-merge for non-protected targets.
- A decisions/audit log; undo a decision; bulk worktree cleanup.
- Surface `pushed`/`error` and the branch link in a task-detail view.

## 11. Open Questions

None blocking. Pushing requires the project repo to have an `origin` remote and the user's git
credentials available; absent either, Approve records `approved` with `pushed: false` + the git error.
