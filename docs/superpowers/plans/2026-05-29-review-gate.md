# Review Gate (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the dashboard, Approve a finished task (record the verdict + push its branch to origin, UI-confirmed, no merge/PR) or Reject it (record the verdict + discard its worktree/branch); decided tasks leave the attention panel.

**Architecture:** A dedicated `dashboard/src/server/review.ts` (`approveTask`/`rejectTask` + `ReviewError`/`TaskNotFoundError`) records a `decision` on the `TaskRecord` and runs the git side effect. `runner/worktree.ts` gains `pushBranch`/`removeWorktree` (git run by the runner; never merge). Two endpoints, a `derive` change that hides decided tasks, and Approve/Reject buttons on the attention panel.

**Tech Stack:** TypeScript (ESM), Hono, Vite/React, Vitest, the `git` CLI.

**Conventions:**
- Commands run from repo root `E:\product-projects\surtec-control-plane`. Branch: `feat/review-gate`.
- Extensionless relative imports. Every commit ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Spec: `docs/superpowers/specs/2026-05-29-review-gate-design.md`.
- Governance preserved: push is the ONLY outward action, only on Approve, UI-confirmed; never merge; protected branches untouched.

---

## File Structure

```
lib/state/types.ts                              # MODIFY: ReviewDecision + optional decision on TaskRecord
lib/state/derive.ts                             # MODIFY: skip decided tasks in the attention loop
lib/state/derive.test.ts                        # MODIFY: assert decided task excluded from attention
runner/worktree.ts                              # MODIFY: pushBranch + removeWorktree
runner/worktree.test.ts                         # MODIFY: pushBranch (bare remote) + removeWorktree tests
dashboard/src/server/review.ts                  # CREATE: approveTask/rejectTask + ReviewError/TaskNotFoundError
dashboard/src/server/review.test.ts             # CREATE
dashboard/src/server/index.ts                   # MODIFY: POST /api/tasks/:id/approve + /reject
dashboard/src/server/index.test.ts              # MODIFY: approve/reject endpoint tests
dashboard/src/ui/api.ts                         # MODIFY: approveTask/rejectTask
dashboard/src/ui/components/AttentionPanel.tsx  # MODIFY: Aprobar/Rechazar buttons + confirm
dashboard/src/ui/components/AttentionPanel.test.tsx # CREATE
README.md                                       # MODIFY: review-gate note
```

---

## Task 1: `decision` on the task record (`lib/state/types.ts`)

**Files:** Modify `lib/state/types.ts`.

- [ ] **Step 1: Add the `ReviewDecision` interface and the `decision` field**

After the `AgentResult` interface (or anywhere among the interfaces), add:

```ts
export interface ReviewDecision {
  status: "approved" | "rejected";
  at: string;
  branch?: string;
  pushed?: boolean;
  error?: string;
}
```

In the `TaskRecord` interface, add an optional `decision` field after `logs_path`:

```ts
export interface TaskRecord {
  envelope: TaskEnvelope;
  lifecycle: Lifecycle;
  outcome: AgentOutcome | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  result: AgentResult | null;
  logs_path: string | null;
  decision?: ReviewDecision | null;
}
```

(Optional so all existing `TaskRecord` constructors and test fixtures keep compiling — `undefined` means "not decided", same as `null`.)

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(state): add ReviewDecision + decision field on TaskRecord" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Decided tasks leave the attention panel (`lib/state/derive.ts`)

**Files:** Modify `lib/state/derive.ts`, `lib/state/derive.test.ts`.

- [ ] **Step 1: Add a failing test to `lib/state/derive.test.ts`** (inside the `describe("buildOverview", ...)` block)

```ts
  it("a decided task contributes no attention items", () => {
    const base = rec({
      id: "A", project: "stock-control", lifecycle: "finished", outcome: "needs-review",
      finished_at: "2026-05-29T12:00:00Z",
    });
    // pending → it IS in attention
    expect(buildOverview(registry, [base], []).attention.some((a) => a.task_id === "A")).toBe(true);
    // decided → it is NOT in attention
    const decided = { ...base, decision: { status: "approved" as const, at: "2026-05-29T13:00:00Z" } };
    expect(buildOverview(registry, [decided], []).attention).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/state/derive.test.ts`
Expected: FAIL — the decided task still appears in attention.

- [ ] **Step 3: Update `lib/state/derive.ts`**

In `buildOverview`, at the very start of the `for (const t of tasks) {` loop body (the attention loop), add:

```ts
  for (const t of tasks) {
    if (t.decision != null) continue; // decided tasks contribute no attention items
    // ... existing needs-review / awaiting-approval / risks / blockers logic unchanged ...
```

(Leave the rest of the loop — needs-review, awaiting-approval, risks, blockers — exactly as is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/state/derive.test.ts`
Expected: PASS (existing 4 + 1 new = 5).

- [ ] **Step 5: Commit**

```bash
git add lib/state/derive.ts lib/state/derive.test.ts
git commit -m "feat(state): exclude decided tasks from the attention panel" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Push + discard git helpers (`runner/worktree.ts`)

**Files:** Modify `runner/worktree.ts`, `runner/worktree.test.ts`.

- [ ] **Step 1: Add failing tests to `runner/worktree.test.ts`**

Update the import to include the new functions:
```ts
import { createWorktree, commitAndDiff, pushBranch, removeWorktree } from "./worktree";
```
Add these describe blocks (the `beforeEach` already creates `repo` as a git repo with one commit on branch `main`, and imports `spawnSync`, `mkdtempSync`, `writeFileSync`, `existsSync`, `join`):

```ts
describe("pushBranch", () => {
  it("pushes a branch to a configured origin", () => {
    const bare = join(dir, "remote.git");
    spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "remote", "add", "origin", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "checkout", "-b", "agent/x"], { encoding: "utf8" });
    writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "commit", "-m", "c"], { encoding: "utf8" });

    const r = pushBranch(repo, "agent/x");

    expect(r.pushed).toBe(true);
    const ls = spawnSync("git", ["-C", bare, "branch", "--list", "agent/x"], { encoding: "utf8" });
    expect(ls.stdout).toContain("agent/x");
  });

  it("returns pushed:false with an error when there is no remote", () => {
    const r = pushBranch(repo, "main");
    expect(r.pushed).toBe(false);
    expect(r.error && r.error.length > 0).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory and deletes the branch", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-9", "a");
    expect(existsSync(worktreePath)).toBe(true);

    removeWorktree(repo, worktreePath, branch);

    expect(existsSync(worktreePath)).toBe(false);
    const ls = spawnSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
    expect(ls.stdout.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/worktree.test.ts`
Expected: FAIL — `pushBranch` / `removeWorktree` not exported.

- [ ] **Step 3: Add the functions to `runner/worktree.ts`** (append after `commitAndDiff`; they reuse the existing private `git` helper)

```ts
export function pushBranch(sourceRepo: string, branch: string): { pushed: boolean; error?: string } {
  const r = git(["-C", sourceRepo, "push", "origin", branch]);
  return r.ok ? { pushed: true } : { pushed: false, error: (r.stderr || r.stdout).trim() };
}

export function removeWorktree(sourceRepo: string, worktreePath: string, branch: string): void {
  const rm = git(["-C", sourceRepo, "worktree", "remove", "--force", worktreePath]);
  if (!rm.ok) throw new Error(`git worktree remove failed: ${(rm.stderr || rm.stdout).trim()}`);
  const del = git(["-C", sourceRepo, "branch", "-D", branch]);
  if (!del.ok) throw new Error(`git branch -D failed: ${(del.stderr || del.stdout).trim()}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/worktree.test.ts`
Expected: PASS (existing 3 + 3 new = 6).

- [ ] **Step 5: Commit**

```bash
git add runner/worktree.ts runner/worktree.test.ts
git commit -m "feat(runner): pushBranch + removeWorktree (git by the runner, no merge)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Review module (`dashboard/src/server/review.ts`)

**Files:** Create `dashboard/src/server/review.ts`, `dashboard/src/server/review.test.ts`.

- [ ] **Step 1: Write the failing test `dashboard/src/server/review.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../../../lib/state/types";

vi.mock("../../../runner/worktree", () => ({ pushBranch: vi.fn(), removeWorktree: vi.fn() }));
import { pushBranch, removeWorktree } from "../../../runner/worktree";
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
import { writeTask, readTask } from "../../../lib/state/store";

let root: string;

function record(id: string, over: Partial<TaskRecord> & { sandbox?: "read-only" | "workspace-write" } = {}): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "stock-control", task_type: "implementation",
      agent: "backend-engineer", title: "t", instructions: "i", repo_path: "~/dev/x",
      branch: `agent/${id}`, sandbox: over.sandbox ?? "workspace-write",
      expected_outputs: [], requires_human_approval: true,
      metadata: { run: { branch: `agent/${id}-backend-engineer`, worktree_path: "/tmp/wt", committed: true } },
    },
    lifecycle: over.lifecycle ?? "finished",
    outcome: "completed", created_at: "2026-05-29T10:00:00Z", started_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:00:00Z", finished_at: "2026-05-29T10:30:00Z",
    result: null, logs_path: null, decision: over.decision ?? null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-review-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
  vi.mocked(pushBranch).mockReset();
  vi.mocked(removeWorktree).mockReset();
  vi.mocked(pushBranch).mockReturnValue({ pushed: true });
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("approveTask", () => {
  it("approves a workspace-write task and pushes its branch", () => {
    writeTask(record("RV-1"));
    const d = approveTask("RV-1");
    expect(d.status).toBe("approved");
    expect(pushBranch).toHaveBeenCalledWith(expect.stringContaining("dev/x"), "agent/RV-1-backend-engineer");
    expect(d.pushed).toBe(true);
    expect(readTask("RV-1")!.decision?.status).toBe("approved");
  });

  it("approves a read-only task without pushing", () => {
    const r = record("RV-2", { sandbox: "read-only" });
    r.envelope.metadata = {};
    writeTask(r);
    const d = approveTask("RV-2");
    expect(d.status).toBe("approved");
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it("throws ReviewError when already decided", () => {
    writeTask(record("RV-3", { decision: { status: "approved", at: "2026-05-29T11:00:00Z" } }));
    expect(() => approveTask("RV-3")).toThrow(ReviewError);
  });

  it("throws ReviewError when not finished", () => {
    writeTask(record("RV-4", { lifecycle: "running" }));
    expect(() => approveTask("RV-4")).toThrow(ReviewError);
  });

  it("throws TaskNotFoundError for a missing task", () => {
    expect(() => approveTask("NOPE")).toThrow(TaskNotFoundError);
  });
});

describe("rejectTask", () => {
  it("rejects a workspace-write task and removes its worktree", () => {
    writeTask(record("RV-5"));
    const d = rejectTask("RV-5");
    expect(d.status).toBe("rejected");
    expect(removeWorktree).toHaveBeenCalledWith(expect.stringContaining("dev/x"), "/tmp/wt", "agent/RV-5-backend-engineer");
    expect(readTask("RV-5")!.decision?.status).toBe("rejected");
  });

  it("records rejected with an error note when discard throws", () => {
    writeTask(record("RV-6"));
    vi.mocked(removeWorktree).mockImplementation(() => { throw new Error("git worktree remove failed: boom"); });
    const d = rejectTask("RV-6");
    expect(d.status).toBe("rejected");
    expect(d.error).toContain("git worktree remove failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/review.test.ts`
Expected: FAIL — cannot find module `./review`.

- [ ] **Step 3: Write `dashboard/src/server/review.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewDecision, TaskRecord } from "../../../lib/state/types";
import { readTask, writeTask } from "../../../lib/state/store";
import { pushBranch, removeWorktree } from "../../../runner/worktree";

export class ReviewError extends Error {}
export class TaskNotFoundError extends ReviewError {}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

interface RunInfo {
  branch?: string;
  worktreePath?: string;
  committed?: boolean;
}

function runInfo(rec: TaskRecord): RunInfo {
  const run = (rec.envelope.metadata?.run ?? {}) as { branch?: string; worktree_path?: string; committed?: boolean };
  return { branch: run.branch, worktreePath: run.worktree_path, committed: run.committed };
}

function loadDecidable(taskId: string): TaskRecord {
  const rec = readTask(taskId);
  if (!rec) throw new TaskNotFoundError(`task not found: ${taskId}`);
  if (rec.lifecycle !== "finished") throw new ReviewError(`task ${taskId} is not finished`);
  if (rec.decision != null) throw new ReviewError(`task ${taskId} is already ${rec.decision.status}`);
  return rec;
}

export function approveTask(taskId: string): ReviewDecision {
  const rec = loadDecidable(taskId);
  const decision: ReviewDecision = { status: "approved", at: new Date().toISOString() };
  const { branch, committed } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && committed) {
    const r = pushBranch(expandHome(rec.envelope.repo_path), branch);
    decision.branch = branch;
    decision.pushed = r.pushed;
    if (!r.pushed) decision.error = r.error;
  }
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
}

export function rejectTask(taskId: string): ReviewDecision {
  const rec = loadDecidable(taskId);
  const decision: ReviewDecision = { status: "rejected", at: new Date().toISOString() };
  const { branch, worktreePath } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && worktreePath) {
    decision.branch = branch;
    try {
      removeWorktree(expandHome(rec.envelope.repo_path), worktreePath, branch);
    } catch (e) {
      decision.error = (e as Error).message;
    }
  }
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/review.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/review.ts dashboard/src/server/review.test.ts
git commit -m "feat(dashboard): review module (approve pushes branch, reject discards worktree)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Approve/Reject endpoints (`dashboard/src/server/index.ts`)

**Files:** Modify `dashboard/src/server/index.ts`, `dashboard/src/server/index.test.ts`.

- [ ] **Step 1: Add failing tests to `dashboard/src/server/index.test.ts`** (inside the existing `describe("api", ...)`)

Add a helper to write a finished read-only task (no git side effects), then the endpoint tests. `mkdirSync`, `join`, `writeFileSync`, `readTask` are already imported; `stateDir` is set up in `beforeEach`:

```ts
  function writeFinishedReadOnly(id: string): void {
    const task = {
      envelope: {
        id, source: "dashboard", project: "stock-control", task_type: "analysis",
        agent: "backend-engineer", title: "Look", instructions: "x", repo_path: "~/dev",
        branch: `agent/${id}`, sandbox: "read-only", expected_outputs: [],
        requires_human_approval: true, metadata: {},
      },
      lifecycle: "finished", outcome: "completed", created_at: "2026-05-29T10:00:00Z",
      started_at: "2026-05-29T10:00:00Z", updated_at: "2026-05-29T10:00:00Z",
      finished_at: "2026-05-29T10:30:00Z", result: null, logs_path: null, decision: null,
    };
    writeFileSync(join(stateDir, "tasks", `${id}.json`), JSON.stringify(task), "utf8");
  }

  it("POST /api/tasks/:id/approve records an approved decision", async () => {
    writeFinishedReadOnly("RV-1");
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks/RV-1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.status).toBe("approved");
    expect(readTask("RV-1")!.decision?.status).toBe("approved");
  });

  it("POST /api/tasks/:id/reject records a rejected decision", async () => {
    writeFinishedReadOnly("RV-2");
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks/RV-2/reject", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).decision.status).toBe("rejected");
  });

  it("POST /api/tasks/:id/approve returns 404 for a missing task", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks/NOPE/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/approve returns 400 when already decided", async () => {
    writeFinishedReadOnly("RV-3");
    const app = createApp(root, () => {});
    await app.request("/api/tasks/RV-3/approve", { method: "POST" });
    const res = await app.request("/api/tasks/RV-3/approve", { method: "POST" });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — routes `/api/tasks/:id/approve` and `/reject` do not exist (404 for the approve success test means the body parse / route is missing → actually returns 404 for all; the "200" expectations fail).

- [ ] **Step 3: Update `dashboard/src/server/index.ts`**

Add the import (with the other server imports):
```ts
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
```
Add the two routes inside `createApp`, after the `app.post("/api/tasks", ...)` block:
```ts
  app.post("/api/tasks/:id/approve", (c) => {
    try {
      return c.json({ decision: approveTask(c.req.param("id")) });
    } catch (err) {
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/reject", (c) => {
    try {
      return c.json({ decision: rejectTask(c.req.param("id")) });
    } catch (err) {
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```
(Note: `TaskNotFoundError extends ReviewError`, so check `TaskNotFoundError` first.)

- [ ] **Step 4: Run tests to verify they pass + full suite**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS (the prior 7 + 4 new = 11).
Run: `pnpm exec vitest run` — all pass. `pnpm exec tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(dashboard): POST approve/reject endpoints" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Approve/Reject buttons in the UI

**Files:** Modify `dashboard/src/ui/api.ts`, `dashboard/src/ui/components/AttentionPanel.tsx`; create `dashboard/src/ui/components/AttentionPanel.test.tsx`.

- [ ] **Step 1: Add helpers to `dashboard/src/ui/api.ts`** (append)

```ts
async function decide(id: string, action: "approve" | "reject"): Promise<{ decision: unknown }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `${action} failed: ${res.status}`);
  }
  return (await res.json()) as { decision: unknown };
}

export function approveTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "approve");
}

export function rejectTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "reject");
}
```

- [ ] **Step 2: Write the failing test `dashboard/src/ui/components/AttentionPanel.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttentionPanel } from "./AttentionPanel";
import type { AttentionItem } from "../../../../lib/state/types";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ decision: { status: "approved" } }),
  })) as unknown as typeof fetch);
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(() => vi.unstubAllGlobals());

describe("AttentionPanel", () => {
  it("shows Aprobar/Rechazar on task-level items and POSTs approve on click", async () => {
    const items: AttentionItem[] = [
      { kind: "awaiting-approval", task_id: "T-1", project: "p", title: "Do it" },
      { kind: "risk", task_id: "T-1", project: "p", title: "no rate limit" },
    ];
    render(<AttentionPanel items={items} />);

    const approve = screen.getAllByRole("button", { name: /aprobar/i });
    expect(approve).toHaveLength(1); // only the awaiting-approval item, not the risk
    fireEvent.click(approve[0]);

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks/T-1/approve"));
      expect(post).toBeTruthy();
      expect((post![1] as RequestInit).method).toBe("POST");
    });
  });

  it("renders no buttons for risk/blocker items", () => {
    render(<AttentionPanel items={[{ kind: "risk", task_id: "T-2", project: "p", title: "r" }]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: FAIL — no buttons rendered.

- [ ] **Step 4: Update `dashboard/src/ui/components/AttentionPanel.tsx`** to:

```tsx
import { useState } from "react";
import type { AttentionItem } from "../../../../lib/state/types";
import { approveTask, rejectTask } from "../api";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};

const TASK_KINDS: AttentionItem["kind"][] = ["needs-review", "awaiting-approval"];

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, action: "approve" | "reject") => {
    const ok = window.confirm(
      action === "approve"
        ? `¿Aprobar ${id}? Si es workspace-write, se pushea su branch a origin.`
        : `¿Rechazar ${id}? Si es workspace-write, se descartan su worktree y branch.`,
    );
    if (!ok) return;
    setError(null);
    try {
      if (action === "approve") await approveTask(id);
      else await rejectTask(id);
      // the 3s polling refresh drops the decided item from the panel
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={{ flex: 1 }}>
      <h4>⚠ Necesita tu atención</h4>
      {error && <div style={{ background: "#f8d7da", padding: 6, borderRadius: 6, marginBottom: 8 }}>{error}</div>}
      {items.length === 0 ? (
        <p style={{ color: "#999" }}>Todo en orden.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {items.map((a) => (
            <li key={`${a.task_id}-${a.kind}-${a.title}`}>
              <em>{LABEL[a.kind]}</em> · {a.task_id} · {a.title}
              {TASK_KINDS.includes(a.kind) && (
                <>
                  {" "}
                  <button type="button" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>{" "}
                  <button type="button" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: PASS (2 tests). Then full suite `pnpm exec vitest run` (all pass — the existing App test renders AttentionPanel with a risk item, which now renders no buttons and triggers no fetch on render, so it stays green), `pnpm exec tsc --noEmit` (no errors), `pnpm build` (compiles).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/ui/api.ts dashboard/src/ui/components/AttentionPanel.tsx dashboard/src/ui/components/AttentionPanel.test.tsx
git commit -m "feat(dashboard): Aprobar/Rechazar buttons in the attention panel" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: README note + full verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Append a "### Review (approve / reject)" subsection to the "## Dashboard (local)" section in `README.md`** (after the workspace-write paragraph):

```markdown
### Review (approve / reject)

Finished tasks show **Aprobar** / **Rechazar** in the attention panel. **Aprobar** records the
decision and, for a workspace-write task, pushes its branch `agent/<task>-<agent>` to origin
(after a confirmation — nothing is merged or PR'd; you open the PR on GitHub). **Rechazar** records
the decision and discards the worktree + local branch. Decided tasks leave the attention panel.
Pushing needs an `origin` remote and your git credentials; if absent, the task is still recorded
approved with the push error noted. Design: `docs/superpowers/specs/2026-05-29-review-gate-design.md`.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all PASS. Report the count.

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: Vite builds `dashboard/dist` without errors.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the review gate (approve/reject)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** ReviewDecision + decision field (Task 1), derive excludes decided (Task 2), pushBranch/removeWorktree (Task 3), approveTask/rejectTask + ReviewError/TaskNotFoundError + push/discard + read-only handling + immutability + push-failure recorded (Task 4), approve/reject endpoints with 200/400/404 (Task 5), UI buttons + confirm + api helpers (Task 6), README + verification (Task 7). All spec sections map to a task.
- **Placeholder scan:** none — complete code or exact edits + commands throughout.
- **Type consistency:** `ReviewDecision` (status/at/branch/pushed/error), `decision` field, `pushBranch`→`{pushed,error}`, `removeWorktree`, `approveTask`/`rejectTask`/`ReviewError`/`TaskNotFoundError`, `runInfo` reading `metadata.run.{branch,worktree_path,committed}` (snake_case keys, matching what run-task writes), `approveTask`/`rejectTask` (id-only) used consistently across server + UI + tests.
- **Governance:** push only on approve (UI-confirmed), never merge; protected branches untouched; reject discard is local + confirmed; decisions immutable; push failure recorded not thrown.
```
