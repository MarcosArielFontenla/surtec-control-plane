# PR on Approve (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a workspace-write task is approved (and its branch pushed), also open a GitHub Pull Request via the `gh` CLI, targeting the project's registry `default_branch`; gracefully degrade if `gh` is unavailable. Never merges.

**Architecture:** A new `runner/github.ts` (gh run by the runner, parallel to `worktree.ts`) provides a pure `buildPrBody` + a `openPullRequest` wrapper. `review.ts`'s `approveTask` opens the PR after a successful push, resolving the base branch from the registry (`loadRegistryProjects` now exposes `default_branch`). A `pr_url` is recorded on the decision.

**Tech Stack:** TypeScript (ESM), Hono, Vite/React, Vitest, the `gh` CLI.

**Conventions:**
- Commands run from repo root `E:\product-projects\surtec-control-plane`. Branch: `feat/pr-on-approve`.
- Extensionless relative imports.
- Spec: `docs/superpowers/specs/2026-05-29-pr-on-approve-design.md`.
- Governance: `gh` only CREATES a PR (never `gh pr merge`); PR is part of the UI-confirmed approve action; graceful on gh-missing/unauth/PR-exists.

---

## File Structure

```
lib/state/derive.ts                              # MODIFY: RegistryProject += default_branch?
dashboard/src/server/registry.ts                 # MODIFY: loadRegistryProjects reads default_branch
dashboard/src/server/registry.test.ts            # MODIFY: expect default_branch
lib/state/types.ts                               # MODIFY: ReviewDecision += pr_url?
runner/github.ts                                 # CREATE: buildPrBody (pure) + openPullRequest (gh)
runner/github.test.ts                            # CREATE: buildPrBody tests
dashboard/src/server/review.ts                   # MODIFY: approveTask opens PR after push (+ repoRoot, defaultBranchFor)
dashboard/src/server/review.test.ts              # MODIFY: mock github, registry fixture, PR assertions
dashboard/src/server/index.ts                    # MODIFY: approve endpoint passes repoRoot
dashboard/src/ui/components/AttentionPanel.tsx    # MODIFY: approve confirm text mentions the PR
README.md                                        # MODIFY: PR-on-approve note
```

---

## Task 1: Expose `default_branch` from the registry

**Files:** Modify `lib/state/derive.ts`, `dashboard/src/server/registry.ts`, `dashboard/src/server/registry.test.ts`.

- [ ] **Step 1: Extend `RegistryProject` in `lib/state/derive.ts`** — add one optional field:

```ts
export interface RegistryProject {
  id: string;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  repo_path?: string | null;
  default_branch?: string | null;
}
```

- [ ] **Step 2: Update `dashboard/src/server/registry.test.ts`** — add `default_branch` to the fixture YAML and the expectation. In `beforeEach`, change the `stock-control` block of the projects.yml to include `default_branch: main`, and update the assertion's `stock-control` object to include `default_branch: "main"` and `portfolio-site` to include `default_branch: null`. The full updated fixture + assertion:

```ts
// projects.yml fixture (beforeEach):
      [
        "projects:",
        "  stock-control:",
        "    repo: git@github.com:surtec/stock-control.git",
        "    local_path: ~/dev/surtec/stock-control",
        "    status: active",
        "    default_branch: main",
        "    allowed_agents:",
        "      - backend-engineer",
        "      - qa-reviewer",
        "  portfolio-site:",
        "    status: planned",
        "",
      ].join("\n"),

// assertion:
    expect(loadRegistryProjects(root)).toEqual([
      {
        id: "stock-control",
        status: "active",
        repo: "git@github.com:surtec/stock-control.git",
        allowed_agents: ["backend-engineer", "qa-reviewer"],
        repo_path: "~/dev/surtec/stock-control",
        default_branch: "main",
      },
      {
        id: "portfolio-site",
        status: "planned",
        repo: null,
        allowed_agents: [],
        repo_path: null,
        default_branch: null,
      },
    ]);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: FAIL — loader returns no `default_branch`.

- [ ] **Step 4: Update `dashboard/src/server/registry.ts`** — read `default_branch`:

```ts
interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    local_path?: string;
    allowed_agents?: string[];
    default_branch?: string;
  }>;
}

export function loadRegistryProjects(repoRoot: string = process.cwd()): RegistryProject[] {
  const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as RegistryDoc;
  const projects = doc.projects ?? {};
  return Object.entries(projects).map(([id, v]) => ({
    id,
    status: v?.status ?? "unknown",
    repo: v?.repo ?? null,
    allowed_agents: v?.allowed_agents ?? [],
    repo_path: v?.local_path ?? null,
    default_branch: v?.default_branch ?? null,
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass + full suite**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: PASS (1 test). Run `pnpm exec vitest run` (all pass — the overview/api tests ignore the new field), `pnpm exec tsc --noEmit` (no errors).

- [ ] **Step 6: Commit**

```bash
git add lib/state/derive.ts dashboard/src/server/registry.ts dashboard/src/server/registry.test.ts
git commit -m "feat(dashboard): expose default_branch from the registry"
```

---

## Task 2: `pr_url` on the decision (`lib/state/types.ts`)

**Files:** Modify `lib/state/types.ts`.

- [ ] **Step 1: Add `pr_url` to `ReviewDecision`**

```ts
export interface ReviewDecision {
  status: "approved" | "rejected";
  at: string;
  branch?: string;
  pushed?: boolean;
  pr_url?: string;
  error?: string;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(state): add pr_url to ReviewDecision"
```

---

## Task 3: GitHub PR helper (`runner/github.ts`)

**Files:** Create `runner/github.ts`, `runner/github.test.ts`.

- [ ] **Step 1: Write the failing test `runner/github.test.ts`** (tests the pure `buildPrBody` only — `openPullRequest` runs `gh` and is mocked in review tests):

```ts
import { describe, it, expect } from "vitest";
import { buildPrBody } from "./github";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "implementation",
  agent: "backend-engineer", title: "Add alert", instructions: "do it", repo_path: "~/dev/x",
  branch: "agent/T-1", sandbox: "workspace-write", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    task_id: "T-1", agent: "backend-engineer", status: "completed",
    summary: "Added the alert endpoint.",
    files_changed: ["src/a.ts"], commands_run: [], tests_run: [],
    risks: ["no rate limit"], blockers: [], next_steps: ["add tests"], artifacts: [],
    logs_path: "reports/T-1.jsonl",
    ...over,
  };
}

describe("buildPrBody", () => {
  it("includes summary, risks, next steps, and a footer with the task id + agent", () => {
    const body = buildPrBody(envelope, result());
    expect(body).toContain("## Summary");
    expect(body).toContain("Added the alert endpoint.");
    expect(body).toContain("## Risks");
    expect(body).toContain("- no rate limit");
    expect(body).toContain("## Next steps");
    expect(body).toContain("- add tests");
    expect(body).toContain("task T-1");
    expect(body).toContain("agent backend-engineer");
  });

  it("omits empty risk/next-step sections", () => {
    const body = buildPrBody(envelope, result({ risks: [], next_steps: [] }));
    expect(body).not.toContain("## Risks");
    expect(body).not.toContain("## Next steps");
    expect(body).toContain("## Summary");
  });

  it("handles a null result with a placeholder summary", () => {
    const body = buildPrBody(envelope, null);
    expect(body).toContain("(no summary)");
    expect(body).toContain("task T-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/github.test.ts`
Expected: FAIL — cannot find module `./github`.

- [ ] **Step 3: Write `runner/github.ts`**

```ts
import { spawnSync } from "node:child_process";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";

export function buildPrBody(envelope: TaskEnvelope, result: AgentResult | null): string {
  const lines: string[] = [];
  lines.push("## Summary", result?.summary?.trim() || "(no summary)", "");
  if (result && result.risks.length > 0) {
    lines.push("## Risks", ...result.risks.map((r) => `- ${r}`), "");
  }
  if (result && result.next_steps.length > 0) {
    lines.push("## Next steps", ...result.next_steps.map((s) => `- ${s}`), "");
  }
  lines.push("---", `Dispatched by Surtec Control Plane · task ${envelope.id} · agent ${envelope.agent}`);
  return lines.join("\n");
}

export function openPullRequest(
  sourceRepo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): { url?: string; error?: string } {
  const r = spawnSync(
    "gh",
    ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body],
    { cwd: sourceRepo, encoding: "utf8", timeout: 30_000 },
  );
  if (r.status === 0) return { url: (r.stdout ?? "").trim() };
  const err = (r.stderr ?? "") || (r.stdout ?? "") || (r.error ? r.error.message : "");
  return { error: err.trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/github.test.ts`
Expected: PASS (3 tests). Run `pnpm exec tsc --noEmit` (no errors).

- [ ] **Step 5: Commit**

```bash
git add runner/github.ts runner/github.test.ts
git commit -m "feat(runner): github PR helper (buildPrBody + openPullRequest, no merge)"
```

---

## Task 4: Open the PR on approve (`dashboard/src/server/review.ts`)

**Files:** Modify `dashboard/src/server/review.ts`, `dashboard/src/server/review.test.ts`.

- [ ] **Step 1: Update `dashboard/src/server/review.test.ts`**

At the top, add the github mock and import (alongside the existing `vi.mock("../../../runner/worktree", ...)`):
```ts
vi.mock("../../../runner/github", () => ({ openPullRequest: vi.fn(), buildPrBody: vi.fn(() => "PR_BODY") }));
import { openPullRequest } from "../../../runner/github";
```
Add `mkdirSync, writeFileSync` to the `node:fs` import in the test.

In `beforeEach`, after creating `root` and setting `SURTEC_STATE_DIR`, create a registry so `defaultBranchFor` resolves, and set the github mock default:
```ts
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  stock-control:\n    default_branch: main\n", "utf8");
  vi.mocked(openPullRequest).mockReset();
  vi.mocked(openPullRequest).mockReturnValue({ url: "https://github.com/x/pull/1" });
```

Replace the existing "approves a workspace-write task and pushes its branch" test body with one that passes `root` and asserts the PR:
```ts
  it("approves a workspace-write task: pushes the branch and opens a PR", () => {
    writeTask(record("RV-1"));
    const d = approveTask("RV-1", root);
    expect(d.status).toBe("approved");
    expect(pushBranch).toHaveBeenCalledWith(expandHome("~/dev/x"), "agent/RV-1-backend-engineer");
    expect(d.pushed).toBe(true);
    expect(openPullRequest).toHaveBeenCalledWith(expandHome("~/dev/x"), "agent/RV-1-backend-engineer", "main", "t", "PR_BODY");
    expect(d.pr_url).toBe("https://github.com/x/pull/1");
    expect(readTask("RV-1")!.decision?.pr_url).toBe("https://github.com/x/pull/1");
  });
```

Add a PR-failure test in `describe("approveTask", ...)`:
```ts
  it("records the PR error but stays approved when gh fails", () => {
    vi.mocked(openPullRequest).mockReturnValue({ error: "gh: command not found" });
    writeTask(record("RV-8"));
    const d = approveTask("RV-8", root);
    expect(d.status).toBe("approved");
    expect(d.pushed).toBe(true);
    expect(d.pr_url).toBeUndefined();
    expect(d.error).toContain("gh: command not found");
  });
```

In the read-only approve test, add `expect(openPullRequest).not.toHaveBeenCalled();`. In the push-failure test (where `pushBranch` returns `{pushed:false}`), add `expect(openPullRequest).not.toHaveBeenCalled();`.

(The push-failure test currently mocks `pushBranch.mockReturnValue({ pushed: false, error: "..." })`. If that test does not exist yet from Task R-4, add one: write `record("RV-9")`, mock `pushBranch` `{pushed:false, error:"no upstream"}`, `approveTask("RV-9", root)`, assert `d.pushed === false`, `d.error === "no upstream"`, `openPullRequest` not called.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run dashboard/src/server/review.test.ts`
Expected: FAIL — `approveTask` does not open a PR / does not accept `repoRoot`.

- [ ] **Step 3: Update `dashboard/src/server/review.ts`**

Add imports (with the existing ones):
```ts
import { loadRegistryProjects } from "./registry";
import { openPullRequest, buildPrBody } from "../../../runner/github";
```
Add a helper above `approveTask`:
```ts
function defaultBranchFor(repoRoot: string, project: string): string {
  try {
    const p = loadRegistryProjects(repoRoot).find((x) => x.id === project);
    return p?.default_branch ?? "main";
  } catch {
    return "main";
  }
}
```
Replace `approveTask` with:
```ts
export function approveTask(taskId: string, repoRoot: string = process.cwd()): ReviewDecision {
  const rec = loadDecidable(taskId);
  const decision: ReviewDecision = { status: "approved", at: new Date().toISOString() };
  const { branch, committed } = runInfo(rec);
  if (rec.envelope.sandbox === "workspace-write" && branch && committed) {
    const repoPath = expandHome(rec.envelope.repo_path);
    const r = pushBranch(repoPath, branch);
    decision.branch = branch;
    decision.pushed = r.pushed;
    if (!r.pushed) {
      decision.error = r.error;
    } else {
      const base = defaultBranchFor(repoRoot, rec.envelope.project);
      const pr = openPullRequest(repoPath, branch, base, rec.envelope.title, buildPrBody(rec.envelope, rec.result));
      if (pr.url) decision.pr_url = pr.url;
      else decision.error = pr.error;
    }
  }
  rec.decision = decision;
  rec.updated_at = decision.at;
  writeTask(rec);
  return decision;
}
```
(Leave `rejectTask`, `loadDecidable`, `runInfo` unchanged.)

- [ ] **Step 4: Run tests to verify they pass + full suite**

Run: `pnpm exec vitest run dashboard/src/server/review.test.ts`
Expected: PASS (all, incl. the new PR + PR-failure + no-PR-on-push-fail/read-only cases).
Run `pnpm exec vitest run` (all pass), `pnpm exec tsc --noEmit` (no errors).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/review.ts dashboard/src/server/review.test.ts
git commit -m "feat(dashboard): open a PR on approve (after push, targeting default_branch)"
```

---

## Task 5: Wire the endpoint + confirm text

**Files:** Modify `dashboard/src/server/index.ts`, `dashboard/src/ui/components/AttentionPanel.tsx`.

- [ ] **Step 1: `dashboard/src/server/index.ts`** — pass `repoRoot` to `approveTask` in the approve route:

Change `return c.json({ decision: approveTask(c.req.param("id")) });` to:
```ts
      return c.json({ decision: approveTask(c.req.param("id"), repoRoot) });
```
(The `/reject` route is unchanged; `rejectTask` takes no repoRoot.)

- [ ] **Step 2: `dashboard/src/ui/components/AttentionPanel.tsx`** — update the approve confirm text:

Change the approve branch of the `window.confirm` message to:
```ts
        ? `¿Aprobar ${id}? Si es workspace-write, se pushea su branch a origin y se abre un PR.`
```
(Leave the reject message and everything else unchanged.)

- [ ] **Step 3: Run tests + tsc + build**

Run: `pnpm exec vitest run` — all pass (the existing index.test approve tests use read-only tasks, so no `gh`/registry path runs; the AttentionPanel test stubs `confirm` → true and only checks the POST, so the changed text doesn't affect it).
Run: `pnpm exec tsc --noEmit` (no errors). Run: `pnpm build` (compiles).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/ui/components/AttentionPanel.tsx
git commit -m "feat(dashboard): thread repoRoot to approve + mention PR in the confirm"
```

---

## Task 6: README + full verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Append to the "### Review (approve / reject)" subsection in `README.md`** (after the existing content):

```markdown
On approve, a workspace-write task also opens a **Pull Request** via the `gh` CLI (after the push),
targeting the project's `default_branch` from the registry. The merge stays manual on GitHub. If `gh`
is not installed/authenticated (or a PR already exists), the task is still recorded approved + pushed
with the PR error noted. Design: `docs/superpowers/specs/2026-05-29-pr-on-approve-design.md`.
```

- [ ] **Step 2: Full test suite** — `pnpm test` — all PASS; report the count.
- [ ] **Step 3: Type-check** — `pnpm exec tsc --noEmit` — no errors.
- [ ] **Step 4: Production build** — `pnpm build` — succeeds.
- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document PR on approve"
```

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** registry default_branch (Task 1), pr_url field (Task 2), github.ts buildPrBody + openPullRequest (Task 3), approveTask opens PR after push + base from registry + graceful failure (Task 4), endpoint passes repoRoot + confirm text (Task 5), README + verify (Task 6). All spec sections map to a task.
- **Placeholder scan:** none — complete code/edits + commands throughout.
- **Type consistency:** `RegistryProject.default_branch`, `ReviewDecision.pr_url`, `buildPrBody(envelope, result)`, `openPullRequest(sourceRepo, branch, base, title, body) → {url?, error?}`, `approveTask(taskId, repoRoot)`, `defaultBranchFor(repoRoot, project)` are consistent across tasks. PR is attempted only after `pushed === true`; a single `error` field holds whichever step (push OR pr) failed.
- **Governance:** `gh pr create` only — no `gh pr merge`/deploy; PR inside the UI-confirmed approve; graceful degradation recorded; base is a PR *target* (never a push to a protected branch).
```
