# Workspace-Write Execution (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude agent implement changes edit-only in an isolated git worktree on a dedicated branch; the runner commits them and captures the diffstat; the dashboard surfaces `files_changed`. No Bash, no push/merge/deploy.

**Architecture:** Thread a `mode` ("read-only" | "workspace-write") through the existing runner. A new `runner/worktree.ts` (git run by the runner) creates the worktree and commits the agent's edits. `run-task` branches on `envelope.sandbox`; the read-only path is unchanged. The dispatch form gains a mode toggle; `createTask` accepts `sandbox`.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk`, Hono, Vite/React, `yaml`, Vitest, the `git` CLI (for the runner's worktree/commit).

**Conventions:**
- Commands run from repo root `E:\product-projects\surtec-control-plane`. Branch: `feat/workspace-write`.
- Extensionless relative imports. Every commit ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Spec: `docs/superpowers/specs/2026-05-29-workspace-write-design.md`.
- **Read-only is preserved:** the agent never gets Bash; `canUseTool` denies anything outside the mode's allowlist.

---

## File Structure

```
runner/worktree.ts                 # CREATE: createWorktree + commitAndDiff (git via child_process)
runner/worktree.test.ts            # CREATE (real temp git repo)
runner/claude.ts                   # MODIFY: RunMode + mode in RunOptions; WRITE_TOOLS; mode-aware allow/disallow; rename runReadOnlyAgent -> runAgent
runner/claude.test.ts              # MODIFY: pass mode; add write-mode assertions
runner/agent-prompt.ts             # MODIFY: buildSystemPrompt(agent, agentsMd, mode = "read-only")
runner/agent-prompt.test.ts        # MODIFY: add write-mode test
runner/result.ts                   # MODIFY: toAgentResult(envelope, text, logsPath, filesChanged = [])
runner/result.test.ts              # MODIFY: add filesChanged test
runner/run-task.ts                 # MODIFY: rename call -> runAgent(mode); then branch on envelope.sandbox (worktree path)
runner/run-task.test.ts            # MODIFY: rename mock -> runAgent; add workspace-write tests
dashboard/src/server/dispatch.ts        # MODIFY: createTask accepts sandbox (validated); task_type by mode
dashboard/src/server/dispatch.test.ts   # MODIFY: add sandbox tests
dashboard/src/ui/api.ts                 # MODIFY: createTask sends sandbox
dashboard/src/ui/components/NewTaskForm.tsx       # MODIFY: mode <select>
dashboard/src/ui/components/NewTaskForm.test.tsx  # MODIFY: assert mode -> sandbox in POST
README.md                          # MODIFY: workspace-write note
```

---

## Task 1: Worktree git helper (`runner/worktree.ts`)

**Files:** Create `runner/worktree.ts`, `runner/worktree.test.ts`.

- [ ] **Step 1: Write the failing test** (uses real git in a temp repo)

```ts
// runner/worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, commitAndDiff } from "./worktree";

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "surtec-wt-"));
  repo = join(dir, "myrepo");
  spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t.t"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { encoding: "utf8" });
  writeFileSync(join(repo, "README.md"), "hi\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init"], { encoding: "utf8" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createWorktree", () => {
  it("creates a worktree on a dedicated agent branch", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-1", "backend-engineer");
    expect(branch).toBe("agent/STK-1-backend-engineer");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  });
});

describe("commitAndDiff", () => {
  it("commits edits and reports files + diffstat", () => {
    const { worktreePath } = createWorktree(repo, "STK-2", "a");
    writeFileSync(join(worktreePath, "new.txt"), "content\n", "utf8");
    const r = commitAndDiff(worktreePath, "agent STK-2");
    expect(r.committed).toBe(true);
    expect(r.filesChanged).toContain("new.txt");
    expect(r.diffstat).toContain("new.txt");
  });

  it("reports no commit when there are no changes", () => {
    const { worktreePath } = createWorktree(repo, "STK-3", "a");
    const r = commitAndDiff(worktreePath, "agent STK-3");
    expect(r.committed).toBe(false);
    expect(r.filesChanged).toEqual([]);
    expect(r.diffstat).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/worktree.test.ts`
Expected: FAIL — cannot find module `./worktree`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/worktree.ts
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export interface WorktreeInfo {
  branch: string;
  worktreePath: string;
}

export interface CommitResult {
  filesChanged: string[];
  diffstat: string;
  committed: boolean;
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function createWorktree(sourceRepo: string, taskId: string, agentId: string): WorktreeInfo {
  const branch = `agent/${sanitizeId(taskId)}-${sanitizeId(agentId)}`;
  const worktreeRoot = join(dirname(sourceRepo), "surtec-worktrees");
  const worktreePath = join(worktreeRoot, `${basename(sourceRepo)}-${sanitizeId(taskId)}-${sanitizeId(agentId)}`);
  const r = git(["-C", sourceRepo, "worktree", "add", "-b", branch, worktreePath]);
  if (!r.ok) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim()}`);
  return { branch, worktreePath };
}

export function commitAndDiff(worktreePath: string, message: string): CommitResult {
  const add = git(["-C", worktreePath, "add", "-A"]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const names = git(["-C", worktreePath, "diff", "--cached", "--name-only"]);
  const filesChanged = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (filesChanged.length === 0) return { filesChanged: [], diffstat: "", committed: false };
  const stat = git(["-C", worktreePath, "diff", "--cached", "--stat"]);
  const commit = git(["-C", worktreePath, "commit", "-m", message]);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  return { filesChanged, diffstat: stat.stdout.trim(), committed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/worktree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/worktree.ts runner/worktree.test.ts
git commit -m "feat(runner): worktree helper (createWorktree + commitAndDiff)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Mode in the SDK wrapper + rename to `runAgent` (`runner/claude.ts`)

This adds the write toolset and renames `runReadOnlyAgent` → `runAgent`. Because `run-task.ts` and `run-task.test.ts` consume that name, they are updated in THIS task (keeping the suite green). The read-only behavior is preserved.

**Files:** Modify `runner/claude.ts`, `runner/claude.test.ts`, `runner/run-task.ts`, `runner/run-task.test.ts`.

- [ ] **Step 1: Update `runner/claude.test.ts`** (existing tests pass `mode`; add write-mode tests)

Replace the file with:

```ts
import { describe, it, expect } from "vitest";
import { buildQueryOptions, READ_ONLY_TOOLS, WRITE_TOOLS } from "./claude";

describe("buildQueryOptions (read-only)", () => {
  it("allows only Read/Grep/Glob and passes through cwd/systemPrompt", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toBe("sp");
    expect(o.maxTurns).toBe(12);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("canUseTool allows read tools and denies write/edit/bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "read-only" });
    expect((await o.canUseTool("Read", { file: "x" })).behavior).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      expect((await o.canUseTool(tool, {})).behavior).toBe("deny");
    }
  });
});

describe("buildQueryOptions (workspace-write)", () => {
  it("allows Read/Grep/Glob + Edit/Write/MultiEdit", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect(o.allowedTools).toEqual([...WRITE_TOOLS]);
    expect(WRITE_TOOLS).toEqual(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"]);
  });

  it("canUseTool allows Edit/Write but STILL denies Bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect((await o.canUseTool("Edit", {})).behavior).toBe("allow");
    expect((await o.canUseTool("Write", {})).behavior).toBe("allow");
    expect((await o.canUseTool("Bash", {})).behavior).toBe("deny");
    expect((await o.canUseTool("BashOutput", {})).behavior).toBe("deny");
  });

  it("disallows shell/exec tools in workspace-write mode", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p", mode: "workspace-write" });
    expect(o.disallowedTools).toContain("Bash");
    expect(o.disallowedTools).not.toContain("Edit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/claude.test.ts`
Expected: FAIL — `mode` not in RunOptions / `WRITE_TOOLS` not exported / `disallowedTools` not on the return.

- [ ] **Step 3: Replace `runner/claude.ts` with:**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type RunMode = "read-only" | "workspace-write";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const WRITE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"] as const;

// Shell/exec + notebook edits are NEVER allowed, in either mode.
const EXEC_TOOLS = ["Bash", "BashOutput", "KillBash", "NotebookEdit"];
// Write tools additionally disallowed in read-only mode.
const WRITE_TOOLS_DISALLOWED_IN_READONLY = ["Write", "Edit", "MultiEdit"];

export interface RunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  mode: RunMode;
  model?: string;
  maxTurns?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  tokens: number;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

// Pure mode-aware policy. Tested without the SDK.
export function buildQueryOptions(o: RunOptions): {
  cwd: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  disallowedTools: string[];
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
} {
  const allowed = (o.mode === "workspace-write" ? WRITE_TOOLS : READ_ONLY_TOOLS) as readonly string[];
  const disallowed =
    o.mode === "workspace-write" ? [...EXEC_TOOLS] : [...EXEC_TOOLS, ...WRITE_TOOLS_DISALLOWED_IN_READONLY];
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? 12,
    allowedTools: [...allowed],
    disallowedTools: disallowed,
    canUseTool: async (toolName, input) =>
      allowed.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `runner (${o.mode}): tool '${toolName}' is not permitted` },
  };
}

export async function runAgent(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const policyOpts = buildQueryOptions(o);
  const canUseToolSdk: CanUseTool = async (toolName, input, _sdkOptions) =>
    policyOpts.canUseTool(toolName, input) as ReturnType<CanUseTool>;

  const sdkOptions: Options = {
    cwd: policyOpts.cwd,
    systemPrompt: policyOpts.systemPrompt,
    model: policyOpts.model,
    maxTurns: policyOpts.maxTurns,
    allowedTools: policyOpts.allowedTools,
    disallowedTools: policyOpts.disallowedTools,
    canUseTool: canUseToolSdk,
    abortController: controller,
  };

  let resultMessage: SDKResultMessage | undefined;
  for await (const message of query({ prompt: o.prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
    if ((message as { type: string }).type === "result") {
      resultMessage = message as SDKResultMessage;
    }
  }

  if (!resultMessage) {
    throw new Error("agent produced no result message");
  }
  if (resultMessage.subtype === "success") {
    return {
      text: resultMessage.result ?? "",
      costUsd: resultMessage.total_cost_usd ?? 0,
      tokens: resultMessage.usage?.output_tokens ?? 0,
    };
  }
  const errors: string[] = resultMessage.errors ?? [];
  throw new Error(
    "agent run failed: " + resultMessage.subtype + (errors.length > 0 ? ": " + errors.join("; ") : ""),
  );
}
```

- [ ] **Step 4: Update `runner/run-task.ts` for the rename** (the write branch comes in Task 6)

- Change the import on line 6 from `import { runReadOnlyAgent } from "./claude";` to `import { runAgent } from "./claude";`
- Change the call on line 78 from `await runReadOnlyAgent({ cwd, systemPrompt, prompt }, controller.signal)` to `await runAgent({ cwd, systemPrompt, prompt, mode: "read-only" }, controller.signal)`

- [ ] **Step 5: Update `runner/run-task.test.ts` for the rename**

- Change `vi.mock("./claude", () => ({ runReadOnlyAgent: vi.fn() }))` to `vi.mock("./claude", () => ({ runAgent: vi.fn() }))`
- Change `import { runReadOnlyAgent } from "./claude";` to `import { runAgent } from "./claude";`
- Replace every `vi.mocked(runReadOnlyAgent)` with `vi.mocked(runAgent)` and every `runReadOnlyAgent` reference in assertions (e.g. `expect(runReadOnlyAgent).not.toHaveBeenCalled()`) with `runAgent`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run runner/claude.test.ts runner/run-task.test.ts`
Expected: PASS (claude: 5 tests; run-task: 5 tests). Then `pnpm exec tsc --noEmit` — no errors. Then `pnpm exec vitest run` — all pass.

- [ ] **Step 7: Commit**

```bash
git add runner/claude.ts runner/claude.test.ts runner/run-task.ts runner/run-task.test.ts
git commit -m "feat(runner): mode-aware toolset in the SDK wrapper; rename to runAgent" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Mode-aware system prompt (`runner/agent-prompt.ts`)

**Files:** Modify `runner/agent-prompt.ts`, `runner/agent-prompt.test.ts`.

- [ ] **Step 1: Add a failing test to `runner/agent-prompt.test.ts`**

Add the `RunMode` import is not needed in the test. Inside the existing `describe("buildSystemPrompt", ...)` block, add:

```ts
  it("uses read-only wording by default", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.");
    expect(p).toContain("READ-ONLY");
    expect(p).not.toContain("WORKSPACE-WRITE");
  });

  it("grants edit tools and forbids commands in workspace-write mode", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.", "workspace-write");
    expect(p).toContain("WORKSPACE-WRITE");
    expect(p).toContain("edit files");
    expect(p).toContain("must NOT run");
    expect(p).toContain("```json");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/agent-prompt.test.ts`
Expected: FAIL — `buildSystemPrompt` ignores the 3rd arg / never contains "WORKSPACE-WRITE".

- [ ] **Step 3: Update `runner/agent-prompt.ts`**

Add the `RunMode` type import and a `mode` parameter. Change the imports line to include `RunMode`:

```ts
import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";
import type { RunMode } from "./claude";
```

Replace `buildSystemPrompt` with:

```ts
export function buildSystemPrompt(agent: RegistryAgent, agentsMd: string, mode: RunMode = "read-only"): string {
  const modeLines =
    mode === "workspace-write"
      ? [
          "You are running in WORKSPACE-WRITE mode. You MAY use Read, Grep, and Glob to inspect",
          "the repository AND edit files with Edit, Write, and MultiEdit. You must NOT run shell",
          "commands, execute scripts, merge, deploy, or push. The control plane commits your edits",
          "to a branch for human review.",
        ]
      : [
          "You are running in READ-ONLY mode. You MAY use the Read, Grep, and Glob tools to",
          "inspect the repository. You must NOT modify files, run shell commands, execute",
          "scripts, merge, deploy, or push.",
        ];
  return [
    `You are the Surtec "${agent.name}" agent (id: ${agent.id}).`,
    `Role: ${agent.description}`,
    `Allowed task types: ${agent.allowed_task_types.join(", ") || "(unspecified)"}.`,
    "",
    ...modeLines,
    "",
    "Repository rules (AGENTS.md):",
    agentsMd.trim(),
    "",
    // Keep these report fields in sync with AgentResult in lib/state/types.ts.
    "When you finish, end your reply with a single fenced ```json block. Use real values",
    "(do not echo the placeholders). Example shape:",
    "```json",
    "{",
    '  "summary": "one-sentence summary of what you found",',
    '  "risks": ["a risk you identified, or omit for none"],',
    '  "blockers": [],',
    '  "next_steps": ["a suggested next step"],',
    '  "status": "completed"',
    "}",
    "```",
    'The "status" field must be exactly one of: completed, partial, blocked, failed, needs-review.',
  ].join("\n");
}
```

(Leave `buildUserPrompt` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/agent-prompt.test.ts`
Expected: PASS (the original test + 2 new = 4). Then `pnpm exec tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add runner/agent-prompt.ts runner/agent-prompt.test.ts
git commit -m "feat(runner): mode-aware system prompt (read-only vs workspace-write)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `filesChanged` in the result builder (`runner/result.ts`)

**Files:** Modify `runner/result.ts`, `runner/result.test.ts`.

- [ ] **Step 1: Add a failing test to `runner/result.test.ts`** (inside `describe("toAgentResult", ...)`)

```ts
  it("uses the provided filesChanged (workspace-write) instead of empty", () => {
    const r = toAgentResult(envelope, "ok", "l", ["src/a.ts", "src/b.ts"]);
    expect(r.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("defaults files_changed to [] when none provided", () => {
    const r = toAgentResult(envelope, "ok", "l");
    expect(r.files_changed).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/result.test.ts`
Expected: FAIL — the first new test gets `[]` (filesChanged ignored).

- [ ] **Step 3: Update `runner/result.ts`**

Change the `toAgentResult` signature and the `files_changed` field:

```ts
export function toAgentResult(
  envelope: TaskEnvelope,
  text: string,
  logsPath: string,
  filesChanged: string[] = [],
): AgentResult {
```

and in the returned object change `files_changed: [],` to `files_changed: filesChanged,`. Leave everything else (parse, status validation, fallback, `failureResult`) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/result.test.ts`
Expected: PASS (original 4 + 2 new = 6).

- [ ] **Step 5: Commit**

```bash
git add runner/result.ts runner/result.test.ts
git commit -m "feat(runner): toAgentResult accepts a filesChanged override" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: createTask accepts `sandbox` (`dashboard/src/server/dispatch.ts`)

**Files:** Modify `dashboard/src/server/dispatch.ts`, `dashboard/src/server/dispatch.test.ts`.

- [ ] **Step 1: Add failing tests to `dashboard/src/server/dispatch.test.ts`** (inside `describe("createTask", ...)`)

```ts
  it("records a workspace-write task with task_type implementation", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Implement X.", sandbox: "workspace-write" },
      root,
    );
    expect(id).toMatch(/^T-/);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("workspace-write");
    expect(t.envelope.task_type).toBe("implementation");
  });

  it("defaults to read-only / analysis when sandbox is absent", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "Look." }, root);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.task_type).toBe("analysis");
  });

  it("rejects an invalid sandbox value", () => {
    expect(() =>
      createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "danger" } as never, root),
    ).toThrow(ValidationError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/dispatch.test.ts`
Expected: FAIL — `sandbox` ignored / `task_type` always "analysis".

- [ ] **Step 3: Update `dashboard/src/server/dispatch.ts`**

Add `sandbox` to the input type:

```ts
export interface CreateTaskInput {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
}
```

In `createTask`, after computing `instructions`, add sandbox validation (before building the envelope):

```ts
  const sandbox = String(input?.sandbox ?? "read-only");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new ValidationError(`invalid sandbox: ${sandbox} (use read-only or workspace-write)`);
  }
```

In the `TaskEnvelope` literal, change `task_type` and `sandbox`:

```ts
    task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
    sandbox: sandbox as "read-only" | "workspace-write",
```

(Leave the rest of `createTask` — id, validation order, expected_outputs, requires_human_approval, writeTask — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/dispatch.test.ts`
Expected: PASS (original 4 + 3 new = 7). Then `pnpm exec tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/dispatch.ts dashboard/src/server/dispatch.test.ts
git commit -m "feat(dashboard): createTask accepts sandbox (read-only|workspace-write)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Workspace-write branch in the runner (`runner/run-task.ts`)

**Files:** Modify `runner/run-task.ts`, `runner/run-task.test.ts`.

- [ ] **Step 1: Add failing tests to `runner/run-task.test.ts`**

At the top, extend the mocks to also mock `./worktree`:

```ts
vi.mock("./claude", () => ({ runAgent: vi.fn() }));
vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
import { runAgent } from "./claude";
import { createWorktree, commitAndDiff } from "./worktree";
```

Add a helper to make a workspace-write queued record (next to the existing `queuedRecord`):

```ts
function writeRecord(): TaskRecord {
  const r = queuedRecord();
  r.envelope.sandbox = "workspace-write";
  r.envelope.task_type = "implementation";
  return r;
}
```

In `beforeEach`, also reset the worktree mocks: `vi.mocked(createWorktree).mockReset(); vi.mocked(commitAndDiff).mockReset();`

Add these tests inside `describe("runTask", ...)`. The source repo `repo` is created by the existing `beforeEach`; for the success test it must look like a git repo, so create a `.git` dir:

```ts
  it("workspace-write: creates a worktree, runs the agent in write mode, commits, records files_changed", async () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath: join(repo, "..", "wt") });
    vi.mocked(runAgent).mockResolvedValue({
      text: '```json\n{ "summary": "did it", "status": "completed" }\n```',
      costUsd: 0.02,
      tokens: 10,
    });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true });

    await runTask("T-1", root);

    expect(createWorktree).toHaveBeenCalledWith(repo, "T-1", "backend-engineer");
    expect(vi.mocked(runAgent).mock.calls[0][0].mode).toBe("workspace-write");
    expect(commitAndDiff).toHaveBeenCalled();
    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("completed");
    expect(rec.result?.files_changed).toEqual(["src/x.ts"]);
    expect((rec.envelope.metadata.run as { branch?: string }).branch).toBe("agent/T-1-backend-engineer");
  });

  it("workspace-write: fails cleanly when the source is not a git repo", async () => {
    // repo exists (from beforeEach) but has no .git dir
    writeTask(writeRecord());

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("not a git repository");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("workspace-write: fails cleanly when worktree creation throws", async () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockImplementation(() => { throw new Error("git worktree add failed: boom"); });

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("git worktree add failed");
    expect(runAgent).not.toHaveBeenCalled();
  });
```

(`mkdirSync` and `join` are already imported in the test file; the existing `repo` temp dir is created in `beforeEach`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run runner/run-task.test.ts`
Expected: FAIL — `runTask` doesn't branch on sandbox (no worktree path; runs read-only).

- [ ] **Step 3: Update `runner/run-task.ts`**

Add the imports (line 9 area):

```ts
import { createWorktree, commitAndDiff } from "./worktree";
```

Replace the inner block (the part from building `systemPrompt`/`prompt` through the inner try/finally — currently lines 71-85) with the mode-aware version:

```ts
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const mode = rec.envelope.sandbox === "workspace-write" ? "workspace-write" : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode);
    const prompt = buildUserPrompt(rec.envelope);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      if (mode === "workspace-write") {
        if (!existsSync(join(cwd, ".git"))) {
          throw new Error(`not a git repository: ${cwd}`);
        }
        const { branch, worktreePath } = createWorktree(cwd, rec.envelope.id, rec.envelope.agent);
        const { text, costUsd, tokens } = await runAgent(
          { cwd: worktreePath, systemPrompt, prompt, mode: "workspace-write" },
          controller.signal,
        );
        const { filesChanged, diffstat, committed } = commitAndDiff(
          worktreePath,
          `agent ${rec.envelope.id}: ${rec.envelope.title}`.slice(0, 72),
        );
        writeLog({ task_id: rec.envelope.id, mode, branch, worktree_path: worktreePath, committed, diffstat, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, branch, worktree_path: worktreePath, diffstat, committed, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath, filesChanged);
        finish(result.status, result);
      } else {
        const { text, costUsd, tokens } = await runAgent({ cwd, systemPrompt, prompt, mode: "read-only" }, controller.signal);
        writeLog({ task_id: rec.envelope.id, mode, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath);
        finish(result.status, result);
      }
    } finally {
      clearTimeout(timeout);
    }
```

(The outer try/catch already turns any thrown error — including the not-a-git-repo error, a `createWorktree` throw, or a `commitAndDiff` throw — into `finished`/`failed` + blocker. The read-only branch is the prior behavior, now passing `mode: "read-only"` explicitly.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run runner/run-task.test.ts`
Expected: PASS (the existing 5 + 3 new = 8). Then `pnpm exec tsc --noEmit` — no errors. Then full suite `pnpm exec vitest run` — all pass.

- [ ] **Step 5: Commit**

```bash
git add runner/run-task.ts runner/run-task.test.ts
git commit -m "feat(runner): workspace-write branch (worktree + commit + diffstat)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Mode toggle in the dispatch UI

**Files:** Modify `dashboard/src/ui/api.ts`, `dashboard/src/ui/components/NewTaskForm.tsx`, `dashboard/src/ui/components/NewTaskForm.test.tsx`.

- [ ] **Step 1: Update `dashboard/src/ui/api.ts`** — `createTask` accepts an optional `sandbox`

Change the `createTask` signature's body type to include `sandbox?: string`:

```ts
export async function createTask(body: {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
}): Promise<{ id: string }> {
```

(The function body — fetch POST with `JSON.stringify(body)` — is unchanged; it now forwards `sandbox`.)

- [ ] **Step 2: Add a failing test to `dashboard/src/ui/components/NewTaskForm.test.tsx`** (inside `describe("NewTaskForm", ...)`)

```ts
  it("dispatches workspace-write when the Implementar mode is selected", async () => {
    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Modo"), { target: { value: "workspace-write" } });
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "Implement X." } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).sandbox).toBe("workspace-write");
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: FAIL — no `Modo` control / `sandbox` not in the POST body.

- [ ] **Step 4: Update `dashboard/src/ui/components/NewTaskForm.tsx`**

Add a `mode` state next to the others:

```tsx
  const [mode, setMode] = useState("read-only");
```

Include it in the dispatch call (the `createTask` call in `onSubmit`):

```tsx
      const { id } = await createTask({ project, agent, instructions, sandbox: mode });
```

Add a mode `<select>` inside the same row as the project/agent selects (after the agent select):

```tsx
        <select aria-label="Modo" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="read-only">Analizar (read-only)</option>
          <option value="workspace-write">Implementar (workspace-write)</option>
        </select>
```

(Everything else — the okMsg/error banners, busy guard, textarea — stays the same.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: PASS (the existing 2 + 1 new = 3). Then full suite `pnpm exec vitest run` — all pass. Then `pnpm build` — compiles.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/ui/api.ts dashboard/src/ui/components/NewTaskForm.tsx dashboard/src/ui/components/NewTaskForm.test.tsx
git commit -m "feat(dashboard): mode toggle (Analizar/Implementar) in NewTaskForm" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: README note + full verification

**Files:** Modify `README.md`.

- [ ] **Step 1: Extend the "### Dispatch (read-only)" subsection in `README.md`**

Append this paragraph right after that subsection's existing content:

```markdown
**Workspace-write (implement):** In **Nueva tarea**, choosing **Implementar** runs the agent in
workspace-write mode: it edits files **in an isolated git worktree** (`../surtec-worktrees/...`) on
a branch `agent/<task>-<agent>`, and the control plane commits the edits to that branch. The agent
still cannot run shell commands, merge, deploy, or push. Review the branch in VS Code and run the
tests; the changed files + diffstat are recorded on the task. Worktrees are not auto-removed.
Design: `docs/superpowers/specs/2026-05-29-workspace-write-design.md`.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all PASS. Report the count (the prior 45 + the new worktree/mode/sandbox/UI tests).

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: Vite builds `dashboard/dist` without errors.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document workspace-write dispatch mode" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** worktree helper (Task 1), mode-aware toolset + read-only preserved (Task 2), mode prompt (Task 3), filesChanged result (Task 4), createTask sandbox (Task 5), run-task workspace-write branch incl. worktree/commit/diffstat/failure paths (Task 6), UI mode toggle (Task 7), README + verification (Task 8). All spec sections map to a task.
- **Placeholder scan:** none — every step has complete code or an exact edit + command.
- **Type consistency:** `RunMode`, `runAgent` (renamed), `buildQueryOptions` (now returns `disallowedTools`), `WRITE_TOOLS`, `buildSystemPrompt(…, mode)`, `toAgentResult(…, filesChanged)`, `createWorktree`/`commitAndDiff` (`WorktreeInfo`/`CommitResult`), `createTask` `sandbox`, `metadata.run.{mode,branch,worktree_path,diffstat,committed}` are used consistently across tasks. The rename is made atomic with its consumers in Task 2 so the suite stays green at every task boundary.
- **Read-only preserved:** Task 2's tests assert workspace-write still denies Bash; the read-only path is unchanged behavior (now passing `mode:"read-only"` explicitly).
```
