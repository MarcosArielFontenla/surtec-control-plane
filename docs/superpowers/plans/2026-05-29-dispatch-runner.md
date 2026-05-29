# Dispatch Runner (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch read-only Claude agent tasks from the dashboard: a `POST /api/tasks` records a task and fires an in-process runner that executes it via the Claude Agent SDK (read-only) and writes lifecycle + `AgentResult` to the existing store, so the dashboard shows real live progress.

**Architecture:** A dependency-free isolated `runner/` module (`runTask`, a read-only Agent SDK wrapper confined to `runner/claude.ts`, a system-prompt builder derived from the registry + AGENTS.md, an `AgentResult` builder, startup reconciliation). The Hono server gains `POST /api/tasks` (validate → record `queued` → fire the runner async via an injectable hook) and `GET /api/dispatch-options`; a `NewTaskForm` drives it from the UI. No new store states — a failure is `lifecycle:finished` + `outcome:failed`.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk` (`query()`), Hono, Vite/React, `yaml`, Vitest. Auth via `ANTHROPIC_API_KEY`.

**Conventions:**
- Commands run from repo root `E:\product-projects\surtec-control-plane`. Branch: `feat/dispatch-runner`.
- Relative imports are extensionless. Every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Spec: `docs/superpowers/specs/2026-05-29-dispatch-runner-design.md`.

**Note on the SDK boundary:** `runner/claude.ts` is the ONLY file importing `@anthropic-ai/claude-agent-sdk`. Its exact option/permission typings can vary by SDK version — the implementer adapts the `query()` call to the installed types (a localized cast at the call site is acceptable). The read-only guarantee does NOT depend on a specific `permissionMode` value: it is enforced by `allowedTools: ["Read","Grep","Glob"]` plus a `canUseTool` callback that hard-denies everything else. The pure `buildQueryOptions()` (tested without the SDK) encodes that policy.

---

## File Structure

```
package.json                                  # MODIFY: add @anthropic-ai/claude-agent-sdk
docker/paperclip/.env.example  OR  .env.example# MODIFY/CREATE: document ANTHROPIC_API_KEY
lib/state/derive.ts                           # MODIFY: extend RegistryProject (optional allowed_agents, repo_path)

runner/
  registry-agents.ts                          # CREATE: RegistryAgent type + loadRegistryAgents()
  registry-agents.test.ts                     # CREATE
  agent-prompt.ts                             # CREATE: buildSystemPrompt(), buildUserPrompt()
  agent-prompt.test.ts                        # CREATE
  result.ts                                   # CREATE: toAgentResult(), failureResult()
  result.test.ts                              # CREATE
  claude.ts                                   # CREATE: buildQueryOptions() (pure) + runReadOnlyAgent() (SDK)
  claude.test.ts                              # CREATE (tests buildQueryOptions only)
  run-task.ts                                 # CREATE: runTask() orchestration
  run-task.test.ts                            # CREATE (mocks ./claude)
  reconcile.ts                                # CREATE: reconcileRunning()
  reconcile.test.ts                           # CREATE

dashboard/src/server/registry.ts              # MODIFY: loadRegistryProjects returns allowed_agents + repo_path
dashboard/src/server/registry.test.ts         # MODIFY: expect the new fields
dashboard/src/server/dispatch.ts              # CREATE: createTask() + ValidationError
dashboard/src/server/dispatch.test.ts         # CREATE
dashboard/src/server/index.ts                 # MODIFY: POST /api/tasks, GET /api/dispatch-options, reconcile, hook
dashboard/src/server/index.test.ts            # MODIFY: add POST + options tests (no-op hook)

dashboard/src/ui/api.ts                        # MODIFY: fetchDispatchOptions(), createTask()
dashboard/src/ui/components/NewTaskForm.tsx    # CREATE
dashboard/src/ui/components/NewTaskForm.test.tsx # CREATE
dashboard/src/ui/App.tsx                       # MODIFY: render <NewTaskForm/>

README.md                                      # MODIFY: dispatch usage note
```

---

## Task 1: Add the Agent SDK dependency + document the API key

**Files:**
- Modify: `package.json`
- Create: `.env.example`

- [ ] **Step 1: Add the dependency to `package.json`**

Add `"@anthropic-ai/claude-agent-sdk": "^0.1.0"` to `dependencies` (keep it alphabetical-ish; exact latest version will be resolved by pnpm — if `^0.1.0` does not exist, install the latest with the next step and let the lockfile record the real version):

```jsonc
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@hono/node-server": "^1.13.7",
    "hono": "^4.6.14",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "yaml": "^2.6.1"
  },
```

- [ ] **Step 2: Install (resolves the real latest version)**

Run: `pnpm add @anthropic-ai/claude-agent-sdk`
Expected: installs the package, updates `package.json` + `pnpm-lock.yaml`. If it prompts to approve build scripts, run `pnpm approve-builds @anthropic-ai/claude-agent-sdk` if needed.

- [ ] **Step 3: Create `.env.example`**

```bash
# Surtec Control Plane — local dashboard / dispatch runner
# The dispatch runner uses the Claude Agent SDK, which authenticates with this key.
# Copy to .env (gitignored) and set your real key. Never commit real secrets.
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "chore: add Claude Agent SDK dependency + document ANTHROPIC_API_KEY" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Registry agents loader (`runner/registry-agents.ts`)

**Files:**
- Create: `runner/registry-agents.ts`, `runner/registry-agents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// runner/registry-agents.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistryAgents } from "./registry-agents";

describe("loadRegistryAgents", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-agents-"));
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(
      join(root, "registry", "agents.yml"),
      [
        "agents:",
        "  - id: backend-engineer",
        "    name: Backend Engineer",
        "    description: Implements backend services.",
        "    allowed_task_types:",
        "      - backend-implementation",
        "      - bugfix",
        "  - id: qa-reviewer",
        "    name: QA Reviewer",
        "    description: Builds test plans.",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps agents to id/name/description/allowed_task_types with defaults", () => {
    expect(loadRegistryAgents(root)).toEqual([
      {
        id: "backend-engineer",
        name: "Backend Engineer",
        description: "Implements backend services.",
        allowed_task_types: ["backend-implementation", "bugfix"],
      },
      {
        id: "qa-reviewer",
        name: "QA Reviewer",
        description: "Builds test plans.",
        allowed_task_types: [],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/registry-agents.test.ts`
Expected: FAIL — cannot find module `./registry-agents`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/registry-agents.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface RegistryAgent {
  id: string;
  name: string;
  description: string;
  allowed_task_types: string[];
}

interface AgentsDoc {
  agents?: Array<{
    id: string;
    name?: string;
    description?: string;
    allowed_task_types?: string[];
  }>;
}

export function loadRegistryAgents(repoRoot: string = process.cwd()): RegistryAgent[] {
  const raw = readFileSync(join(repoRoot, "registry", "agents.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as AgentsDoc;
  return (doc.agents ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    description: a.description ?? "",
    allowed_task_types: a.allowed_task_types ?? [],
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/registry-agents.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add runner/registry-agents.ts runner/registry-agents.test.ts
git commit -m "feat(runner): load agent roles from registry/agents.yml" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: System/user prompt builders (`runner/agent-prompt.ts`)

**Files:**
- Create: `runner/agent-prompt.ts`, `runner/agent-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// runner/agent-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";

const agent: RegistryAgent = {
  id: "backend-engineer",
  name: "Backend Engineer",
  description: "Implements backend services.",
  allowed_task_types: ["bugfix"],
};

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
  agent: "backend-engineer", title: "Analyze auth", instructions: "Review the auth module.",
  repo_path: "~/dev/x", branch: "agent/T-1", sandbox: "read-only",
  expected_outputs: [], requires_human_approval: true, metadata: {},
};

describe("buildSystemPrompt", () => {
  it("includes role, read-only constraint, AGENTS.md, and the json-report instruction", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.");
    expect(p).toContain("Backend Engineer");
    expect(p).toContain("Implements backend services.");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("RULE: do not deploy.");
    expect(p).toContain("```json");
    expect(p).toContain('"status"');
  });
});

describe("buildUserPrompt", () => {
  it("includes the task title, project and instructions", () => {
    const p = buildUserPrompt(envelope);
    expect(p).toContain("T-1");
    expect(p).toContain("Analyze auth");
    expect(p).toContain("stock-control");
    expect(p).toContain("Review the auth module.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/agent-prompt.test.ts`
Expected: FAIL — cannot find module `./agent-prompt`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/agent-prompt.ts
import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";

export function buildSystemPrompt(agent: RegistryAgent, agentsMd: string): string {
  return [
    `You are the Surtec "${agent.name}" agent (id: ${agent.id}).`,
    `Role: ${agent.description}`,
    `Allowed task types: ${agent.allowed_task_types.join(", ") || "(unspecified)"}.`,
    "",
    "You are running in READ-ONLY mode. You may read and inspect the repository",
    "(Read, Grep, Glob). You must NOT modify files, run commands, merge, deploy, or push.",
    "",
    "Repository rules (AGENTS.md):",
    agentsMd.trim(),
    "",
    "When you finish, end your reply with a single fenced ```json block containing exactly:",
    '{ "summary": string, "risks": string[], "blockers": string[], "next_steps": string[], "status": "completed"|"partial"|"blocked"|"failed"|"needs-review" }',
  ].join("\n");
}

export function buildUserPrompt(envelope: TaskEnvelope): string {
  return [
    `Task ${envelope.id}: ${envelope.title}`,
    `Project: ${envelope.project}`,
    "",
    "Instructions:",
    envelope.instructions,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/agent-prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/agent-prompt.ts runner/agent-prompt.test.ts
git commit -m "feat(runner): build read-only system/user prompts from registry + AGENTS.md" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AgentResult builder (`runner/result.ts`)

**Files:**
- Create: `runner/result.ts`, `runner/result.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// runner/result.test.ts
import { describe, it, expect } from "vitest";
import { toAgentResult, failureResult } from "./result";
import type { TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
  agent: "backend-engineer", title: "t", instructions: "i", repo_path: "~/x",
  branch: "agent/T-1", sandbox: "read-only", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

describe("toAgentResult", () => {
  it("parses a trailing json block into the AgentResult", () => {
    const text = [
      "Here is my analysis.",
      "```json",
      '{ "summary": "looks ok", "risks": ["no rate limit"], "blockers": [], "next_steps": ["add tests"], "status": "needs-review" }',
      "```",
    ].join("\n");
    const r = toAgentResult(envelope, text, "reports/T-1.jsonl");
    expect(r.status).toBe("needs-review");
    expect(r.summary).toBe("looks ok");
    expect(r.risks).toEqual(["no rate limit"]);
    expect(r.next_steps).toEqual(["add tests"]);
    expect(r.files_changed).toEqual([]);
    expect(r.commands_run).toEqual([]);
    expect(r.logs_path).toBe("reports/T-1.jsonl");
    expect(r.task_id).toBe("T-1");
    expect(r.agent).toBe("backend-engineer");
  });

  it("defaults an invalid status to completed", () => {
    const text = '```json\n{ "summary": "x", "status": "weird" }\n```';
    expect(toAgentResult(envelope, text, "l").status).toBe("completed");
  });

  it("falls back to summary=text with empty arrays when there is no json block", () => {
    const r = toAgentResult(envelope, "just prose, no json", "l");
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("just prose, no json");
    expect(r.risks).toEqual([]);
    expect(r.blockers).toEqual([]);
    expect(r.next_steps).toEqual([]);
  });
});

describe("failureResult", () => {
  it("produces a failed result with the reason as a blocker", () => {
    const r = failureResult(envelope, "timeout (5m)", "reports/T-1.jsonl");
    expect(r.status).toBe("failed");
    expect(r.blockers).toEqual(["timeout (5m)"]);
    expect(r.summary).toContain("timeout (5m)");
    expect(r.logs_path).toBe("reports/T-1.jsonl");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/result.test.ts`
Expected: FAIL — cannot find module `./result`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/result.ts
import type { AgentResult, AgentOutcome, TaskEnvelope } from "../lib/state/types";

const OUTCOMES: AgentOutcome[] = ["completed", "partial", "blocked", "failed", "needs-review"];

interface ParsedReport {
  summary?: string;
  risks?: string[];
  blockers?: string[];
  next_steps?: string[];
  status?: string;
}

function parseTrailingJson(text: string): ParsedReport | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]) as ParsedReport;
  } catch {
    return null;
  }
}

export function toAgentResult(envelope: TaskEnvelope, text: string, logsPath: string): AgentResult {
  const parsed = parseTrailingJson(text);
  const status: AgentOutcome =
    parsed && OUTCOMES.includes(parsed.status as AgentOutcome)
      ? (parsed.status as AgentOutcome)
      : "completed";
  return {
    task_id: envelope.id,
    agent: envelope.agent,
    status,
    summary: parsed?.summary ?? text.trim(),
    files_changed: [],
    commands_run: [],
    tests_run: [],
    risks: parsed?.risks ?? [],
    blockers: parsed?.blockers ?? [],
    next_steps: parsed?.next_steps ?? [],
    artifacts: [],
    logs_path: logsPath,
  };
}

export function failureResult(envelope: TaskEnvelope, reason: string, logsPath: string): AgentResult {
  return {
    task_id: envelope.id,
    agent: envelope.agent,
    status: "failed",
    summary: `Run failed: ${reason}`,
    files_changed: [],
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [reason],
    next_steps: [],
    artifacts: [],
    logs_path: logsPath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/result.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/result.ts runner/result.test.ts
git commit -m "feat(runner): build AgentResult from agent output (parse + fallback)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Read-only Agent SDK wrapper (`runner/claude.ts`)

The pure `buildQueryOptions()` encodes the read-only policy and is fully tested. `runReadOnlyAgent()` calls the SDK and is covered indirectly (mocked in Task 6).

**Files:**
- Create: `runner/claude.ts`, `runner/claude.test.ts`

- [ ] **Step 1: Write the failing test (pure options builder only)**

```ts
// runner/claude.test.ts
import { describe, it, expect } from "vitest";
import { buildQueryOptions, READ_ONLY_TOOLS } from "./claude";

describe("buildQueryOptions", () => {
  it("allows only Read/Grep/Glob and passes through cwd/systemPrompt", () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p" });
    expect(o.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toBe("sp");
    expect(o.maxTurns).toBe(12);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("canUseTool allows read tools and denies write/edit/bash", async () => {
    const o = buildQueryOptions({ cwd: "/repo", systemPrompt: "sp", prompt: "p" });
    const allow = await o.canUseTool("Read", { file: "x" });
    expect(allow.behavior).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      const deny = await o.canUseTool(tool, {});
      expect(deny.behavior).toBe("deny");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/claude.test.ts`
Expected: FAIL — cannot find module `./claude`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/claude.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface RunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
}

export interface RunResult {
  text: string;
  costUsd: number;
  tokens: number;
}

interface PermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

// Pure read-only policy. Tested without the SDK.
export function buildQueryOptions(o: RunOptions): {
  cwd: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
} {
  const readOnly = READ_ONLY_TOOLS as readonly string[];
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? 12,
    allowedTools: [...READ_ONLY_TOOLS],
    canUseTool: async (toolName, input) =>
      readOnly.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `read-only runner: tool '${toolName}' is not permitted` },
  };
}

export async function runReadOnlyAgent(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  // NOTE: the installed SDK's Options type may be stricter than our policy object;
  // adapt/cast here against the real @anthropic-ai/claude-agent-sdk types if needed.
  const options = { ...buildQueryOptions(o), abortController: controller };

  let text = "";
  let costUsd = 0;
  let tokens = 0;
  for await (const message of query({ prompt: o.prompt, options } as Parameters<typeof query>[0])) {
    const m = message as { type: string; result?: string; total_cost_usd?: number; usage?: { output_tokens?: number } };
    if (m.type === "result") {
      text = m.result ?? "";
      costUsd = m.total_cost_usd ?? 0;
      tokens = m.usage?.output_tokens ?? 0;
    }
  }
  return { text, costUsd, tokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/claude.test.ts`
Expected: PASS (2 tests). (If `tsc`/vitest complains about the SDK `query` typings at the call site, adjust the cast — the test itself does not invoke `query`.)

- [ ] **Step 5: Commit**

```bash
git add runner/claude.ts runner/claude.test.ts
git commit -m "feat(runner): read-only Agent SDK wrapper with deny-by-default canUseTool" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Orchestration (`runner/run-task.ts`)

**Files:**
- Create: `runner/run-task.ts`, `runner/run-task.test.ts`

- [ ] **Step 1: Write the failing test (mocks `./claude`)**

```ts
// runner/run-task.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";

vi.mock("./claude", () => ({ runReadOnlyAgent: vi.fn() }));
import { runReadOnlyAgent } from "./claude";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";

let root: string;
let repo: string;

function queuedRecord(): TaskRecord {
  return {
    envelope: {
      id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
      agent: "backend-engineer", title: "Analyze", instructions: "Review auth.",
      repo_path: repo, branch: "agent/T-1", sandbox: "read-only",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-runtask-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    description: Implements backend.\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  vi.mocked(runReadOnlyAgent).mockReset();
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

describe("runTask", () => {
  it("transitions queued -> finished with the parsed AgentResult", async () => {
    writeTask(queuedRecord());
    vi.mocked(runReadOnlyAgent).mockResolvedValue({
      text: '```json\n{ "summary": "ok", "risks": ["r"], "blockers": [], "next_steps": [], "status": "completed" }\n```',
      costUsd: 0.01,
      tokens: 42,
    });

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("completed");
    expect(rec.result?.summary).toBe("ok");
    expect(rec.result?.risks).toEqual(["r"]);
    expect(rec.started_at).not.toBeNull();
    expect(rec.finished_at).not.toBeNull();
  });

  it("marks failed with a blocker when the agent throws", async () => {
    writeTask(queuedRecord());
    vi.mocked(runReadOnlyAgent).mockRejectedValue(new Error("api exploded"));

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers).toEqual(["api exploded"]);
  });

  it("fails cleanly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    writeTask(queuedRecord());

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("ANTHROPIC_API_KEY");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/run-task.test.ts`
Expected: FAIL — cannot find module `./run-task`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/run-task.ts
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOutcome, AgentResult } from "../lib/state/types";
import { readTask, writeTask } from "../lib/state/store";
import { runReadOnlyAgent } from "./claude";
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import { loadRegistryAgents } from "./registry-agents";
import { toAgentResult, failureResult } from "./result";

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? process.env.USERPROFILE ?? p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return join(home, p.slice(2));
  }
  return p;
}

export async function runTask(taskId: string, repoRoot: string = process.cwd()): Promise<void> {
  const rec = readTask(taskId);
  if (!rec) return;

  const start = new Date().toISOString();
  rec.lifecycle = "running";
  rec.started_at = start;
  rec.updated_at = start;
  writeTask(rec);

  mkdirSync(join(repoRoot, "reports"), { recursive: true });
  const logsPath = join("reports", `${rec.envelope.id}-${rec.envelope.agent}-${start.replace(/[:.]/g, "")}.jsonl`);
  const absLogsPath = join(repoRoot, logsPath);

  const finish = (outcome: AgentOutcome, result: AgentResult): void => {
    const end = new Date().toISOString();
    rec.lifecycle = "finished";
    rec.finished_at = end;
    rec.updated_at = end;
    rec.outcome = outcome;
    rec.result = result;
    rec.logs_path = logsPath;
    writeTask(rec);
  };

  const writeLog = (obj: unknown): void => {
    try {
      writeFileSync(absLogsPath, JSON.stringify(obj) + "\n", "utf8");
    } catch {
      /* logging must never break the run */
    }
  };

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      writeLog({ error: "missing ANTHROPIC_API_KEY" });
      finish("failed", failureResult(rec.envelope, "missing ANTHROPIC_API_KEY", logsPath));
      return;
    }
    const cwd = expandHome(rec.envelope.repo_path);
    if (!existsSync(cwd)) {
      const reason = `repo not found at ${cwd}`;
      writeLog({ error: reason });
      finish("failed", failureResult(rec.envelope, reason, logsPath));
      return;
    }
    const agent = loadRegistryAgents(repoRoot).find((a) => a.id === rec.envelope.agent);
    if (!agent) {
      const reason = `unknown agent: ${rec.envelope.agent}`;
      writeLog({ error: reason });
      finish("failed", failureResult(rec.envelope, reason, logsPath));
      return;
    }
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const systemPrompt = buildSystemPrompt(agent, agentsMd);
    const prompt = buildUserPrompt(rec.envelope);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const { text, costUsd, tokens } = await runReadOnlyAgent({ cwd, systemPrompt, prompt }, controller.signal);
      writeLog({ task_id: rec.envelope.id, cost_usd: costUsd, tokens, text });
      rec.envelope.metadata.run = { cost_usd: costUsd, tokens };
      const result = toAgentResult(rec.envelope, text, logsPath);
      finish(result.status, result);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const reason = (err as Error)?.name === "AbortError" ? "timeout (5m)" : (err as Error)?.message ?? "unknown error";
    writeLog({ error: reason });
    finish("failed", failureResult(rec.envelope, reason, logsPath));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/run-task.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/run-task.ts runner/run-task.test.ts
git commit -m "feat(runner): orchestrate task run with state transitions + failure handling" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Startup reconciliation (`runner/reconcile.ts`)

**Files:**
- Create: `runner/reconcile.ts`, `runner/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// runner/reconcile.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import { writeTask, readTask } from "../lib/state/store";
import { reconcileRunning } from "./reconcile";

function record(id: string, lifecycle: TaskRecord["lifecycle"]): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "p", task_type: "analysis", agent: "a",
      title: "t", instructions: "i", repo_path: "~/x", branch: "b",
      sandbox: "read-only", expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle, outcome: null, created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-reconcile-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("reconcileRunning", () => {
  it("marks orphaned running tasks as finished/failed and leaves others alone", () => {
    writeTask(record("R-1", "running"));
    writeTask(record("Q-1", "queued"));

    const n = reconcileRunning();

    expect(n).toBe(1);
    const r = readTask("R-1")!;
    expect(r.lifecycle).toBe("finished");
    expect(r.outcome).toBe("failed");
    expect(r.result?.blockers[0]).toContain("interrupted");
    expect(readTask("Q-1")!.lifecycle).toBe("queued");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run runner/reconcile.test.ts`
Expected: FAIL — cannot find module `./reconcile`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runner/reconcile.ts
import { listTasks, writeTask } from "../lib/state/store";
import { failureResult } from "./result";

export function reconcileRunning(): number {
  let n = 0;
  for (const rec of listTasks()) {
    if (rec.lifecycle !== "running") continue;
    const end = new Date().toISOString();
    rec.lifecycle = "finished";
    rec.finished_at = end;
    rec.updated_at = end;
    rec.outcome = "failed";
    rec.result = failureResult(rec.envelope, "interrupted by server restart", rec.logs_path ?? "");
    writeTask(rec);
    n++;
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run runner/reconcile.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add runner/reconcile.ts runner/reconcile.test.ts
git commit -m "feat(runner): reconcile orphaned running tasks on startup" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Extend the registry loader (projects → allowed_agents + repo_path)

**Files:**
- Modify: `lib/state/derive.ts` (extend `RegistryProject` type with optional fields)
- Modify: `dashboard/src/server/registry.ts`
- Modify: `dashboard/src/server/registry.test.ts`

- [ ] **Step 1: Extend the `RegistryProject` type in `lib/state/derive.ts`**

Find the existing interface and add two OPTIONAL fields (optional so `buildOverview` and its tests, which construct `{id,status,repo}`, keep compiling):

```ts
export interface RegistryProject {
  id: string;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  repo_path?: string | null;
}
```

- [ ] **Step 2: Update the failing test in `dashboard/src/server/registry.test.ts`**

Replace the existing fixture write + expectation so the YAML includes `allowed_agents` and `local_path`, and the expected output includes the new fields:

```ts
// in beforeEach, the projects.yml content becomes:
    writeFileSync(
      join(root, "registry", "projects.yml"),
      [
        "projects:",
        "  stock-control:",
        "    repo: git@github.com:surtec/stock-control.git",
        "    local_path: ~/dev/surtec/stock-control",
        "    status: active",
        "    allowed_agents:",
        "      - backend-engineer",
        "      - qa-reviewer",
        "  portfolio-site:",
        "    status: planned",
        "",
      ].join("\n"),
      "utf8",
    );

// the assertion becomes:
  it("maps projects to id/status/repo/allowed_agents/repo_path", () => {
    expect(loadRegistryProjects(root)).toEqual([
      {
        id: "stock-control",
        status: "active",
        repo: "git@github.com:surtec/stock-control.git",
        allowed_agents: ["backend-engineer", "qa-reviewer"],
        repo_path: "~/dev/surtec/stock-control",
      },
      {
        id: "portfolio-site",
        status: "planned",
        repo: null,
        allowed_agents: [],
        repo_path: null,
      },
    ]);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: FAIL — the loader still returns only `{id,status,repo}`.

- [ ] **Step 4: Update `dashboard/src/server/registry.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RegistryProject } from "../../../lib/state/derive";

interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    local_path?: string;
    allowed_agents?: string[];
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
  }));
}
```

- [ ] **Step 5: Run test to verify it passes, and the full suite stays green**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: PASS (1 test).
Run: `pnpm exec vitest run`
Expected: all PASS (the overview/api tests ignore the new fields).

- [ ] **Step 6: Commit**

```bash
git add lib/state/derive.ts dashboard/src/server/registry.ts dashboard/src/server/registry.test.ts
git commit -m "feat(dashboard): expose allowed_agents + repo_path from the registry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Task creation + validation (`dashboard/src/server/dispatch.ts`)

**Files:**
- Create: `dashboard/src/server/dispatch.ts`, `dashboard/src/server/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/server/dispatch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, ValidationError } from "./dispatch";
import { listTasks } from "../../../lib/state/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-dispatch-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "projects.yml"),
    [
      "projects:",
      "  stock-control:",
      "    local_path: ~/dev/surtec/stock-control",
      "    status: active",
      "    allowed_agents:",
      "      - backend-engineer",
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("createTask", () => {
  it("records a queued read-only task with a built envelope", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Review the auth module." },
      root,
    );
    expect(id).toMatch(/^T-/);
    const tasks = listTasks();
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.lifecycle).toBe("queued");
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.requires_human_approval).toBe(true);
    expect(t.envelope.project).toBe("stock-control");
    expect(t.envelope.agent).toBe("backend-engineer");
    expect(t.envelope.repo_path).toBe("~/dev/surtec/stock-control");
    expect(t.envelope.source).toBe("dashboard");
  });

  it("rejects unknown project", () => {
    expect(() => createTask({ project: "nope", agent: "backend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects an agent not allowed for the project", () => {
    expect(() => createTask({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects empty instructions", () => {
    expect(() => createTask({ project: "stock-control", agent: "backend-engineer", instructions: "   " }, root)).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/dispatch.test.ts`
Expected: FAIL — cannot find module `./dispatch`.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/server/dispatch.ts
import { randomUUID } from "node:crypto";
import type { TaskEnvelope, TaskRecord } from "../../../lib/state/types";
import { writeTask } from "../../../lib/state/store";
import { loadRegistryProjects } from "./registry";

export class ValidationError extends Error {}

export interface CreateTaskInput {
  project: string;
  agent: string;
  instructions: string;
}

export function createTask(input: CreateTaskInput, repoRoot: string = process.cwd()): { id: string } {
  const project = String(input?.project ?? "");
  const agent = String(input?.agent ?? "");
  const instructions = String(input?.instructions ?? "").trim();

  if (!instructions) throw new ValidationError("instructions are required");

  const rp = loadRegistryProjects(repoRoot).find((p) => p.id === project);
  if (!rp) throw new ValidationError(`unknown project: ${project}`);
  if (!(rp.allowed_agents ?? []).includes(agent)) {
    throw new ValidationError(`agent '${agent}' is not allowed for project '${project}'`);
  }

  const id = `T-${randomUUID().slice(0, 8)}`;
  const envelope: TaskEnvelope = {
    id,
    source: "dashboard",
    project,
    task_type: "analysis",
    agent,
    title: instructions.slice(0, 80),
    instructions,
    repo_path: rp.repo_path ?? `~/dev/surtec/${project}`,
    branch: `agent/${id}-${agent}`,
    sandbox: "read-only",
    expected_outputs: ["summary", "risks", "next_steps"],
    requires_human_approval: true,
    metadata: { created_by: "dashboard" },
  };

  const ts = new Date().toISOString();
  const record: TaskRecord = {
    envelope,
    lifecycle: "queued",
    outcome: null,
    created_at: ts,
    started_at: null,
    updated_at: ts,
    finished_at: null,
    result: null,
    logs_path: null,
  };
  writeTask(record);
  return { id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/dispatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/dispatch.ts dashboard/src/server/dispatch.test.ts
git commit -m "feat(dashboard): createTask with registry validation (read-only envelope)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: API endpoints + startup reconcile (`dashboard/src/server/index.ts`)

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Modify: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Add failing tests to `dashboard/src/server/index.test.ts`**

The existing `beforeEach` writes a `registry/projects.yml` with only `status: active`. Update it to include `allowed_agents` so dispatch validation passes, then add the POST/options tests. Change the projects.yml write to:

```ts
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    status: active\n    allowed_agents:\n      - backend-engineer\n",
    "utf8",
  );
```

Add these tests inside the existing `describe("api", ...)` block. `createApp`'s second argument is an injectable runner hook; pass a no-op so no real agent runs:

```ts
  it("GET /api/dispatch-options returns projects with their allowed agents", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/dispatch-options");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([{ project: "stock-control", agents: ["backend-engineer"] }]);
  });

  it("POST /api/tasks creates a queued task and returns 201 {id}", async () => {
    const fired: string[] = [];
    const app = createApp(root, (id: string) => { fired.push(id); });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "stock-control", agent: "backend-engineer", instructions: "Analyze auth." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^T-/);
    expect(fired).toEqual([body.id]); // runner hook was fired with the new id
  });

  it("POST /api/tasks returns 400 for a disallowed agent", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }),
    });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — `createApp` does not accept a hook / routes `/api/dispatch-options` and POST `/api/tasks` do not exist.

- [ ] **Step 3: Update `dashboard/src/server/index.ts`**

```ts
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { listTasks, listProjectOverrides, readTask } from "../../../lib/state/store";
import { buildOverview } from "../../../lib/state/derive";
import { loadRegistryProjects } from "./registry";
import { createTask, ValidationError } from "./dispatch";
import { runTask } from "../../../runner/run-task";
import { reconcileRunning } from "../../../runner/reconcile";

export function createApp(
  repoRoot: string = process.cwd(),
  onTaskCreated: (id: string) => void = (id) => { void runTask(id, repoRoot); },
): Hono {
  const app = new Hono();

  app.get("/api/overview", (c) => {
    try {
      const overview = buildOverview(
        loadRegistryProjects(repoRoot),
        listTasks(),
        listProjectOverrides(),
      );
      return c.json(overview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const rec = readTask(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  app.get("/api/dispatch-options", (c) => {
    const projects = loadRegistryProjects(repoRoot).map((p) => ({
      project: p.id,
      agents: p.allowed_agents ?? [],
    }));
    return c.json({ projects });
  });

  app.post("/api/tasks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const { id } = createTask(body as { project: string; agent: string; instructions: string }, repoRoot);
      onTaskCreated(id);
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}

// Entrypoint: only runs when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  reconcileRunning();
  const app = createApp();
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));
  const port = Number(process.env.PORT ?? 4317);
  serve({ fetch: app.fetch, port });
  console.log(`Surtec Control Plane dashboard on http://localhost:${port}`);
}
```

- [ ] **Step 4: Run tests to verify they pass + full suite**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS (the original 3 + 3 new = 6).
Run: `pnpm exec vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(dashboard): POST /api/tasks + GET /api/dispatch-options + startup reconcile" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Dispatch form in the UI

**Files:**
- Modify: `dashboard/src/ui/api.ts`
- Create: `dashboard/src/ui/components/NewTaskForm.tsx`, `dashboard/src/ui/components/NewTaskForm.test.tsx`
- Modify: `dashboard/src/ui/App.tsx`

- [ ] **Step 1: Extend `dashboard/src/ui/api.ts`** (append these exports; keep the existing `fetchOverview`/`useOverview`)

```ts
export interface DispatchOptions {
  projects: { project: string; agents: string[] }[];
}

export async function fetchDispatchOptions(): Promise<DispatchOptions> {
  const res = await fetch("/api/dispatch-options");
  if (!res.ok) throw new Error(`dispatch-options failed: ${res.status}`);
  return (await res.json()) as DispatchOptions;
}

export async function createTask(body: {
  project: string;
  agent: string;
  instructions: string;
}): Promise<{ id: string }> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `dispatch failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}
```

- [ ] **Step 2: Write the failing test `dashboard/src/ui/components/NewTaskForm.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NewTaskForm } from "./NewTaskForm";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => ({ projects: [{ project: "stock-control", agents: ["backend-engineer"] }] }) } as Response;
    }
    // POST /api/tasks
    return { ok: true, status: 201, json: async () => ({ id: "T-abc" }) } as Response;
  }) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("NewTaskForm", () => {
  it("loads options and dispatches a task with the entered instructions", async () => {
    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    const textarea = screen.getByPlaceholderText(/instrucciones/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Analyze the auth module." } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        project: "stock-control",
        agent: "backend-engineer",
        instructions: "Analyze the auth module.",
      });
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: FAIL — cannot find module `./NewTaskForm`.

- [ ] **Step 4: Write `dashboard/src/ui/components/NewTaskForm.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchDispatchOptions, createTask, type DispatchOptions } from "../api";

export function NewTaskForm() {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchDispatchOptions()
      .then((o) => {
        if (!active) return;
        setOptions(o.projects);
        if (o.projects[0]) {
          setProject(o.projects[0].project);
          setAgent(o.projects[0].agents[0] ?? "");
        }
      })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const agents = options.find((p) => p.project === project)?.agents ?? [];

  const onProjectChange = (value: string) => {
    setProject(value);
    const next = options.find((p) => p.project === value)?.agents ?? [];
    setAgent(next[0] ?? "");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createTask({ project, agent, instructions });
      setInstructions(""); // polling will surface the new task
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 24 }}>
      <h4 style={{ marginTop: 0 }}>Nueva tarea</h4>
      {error && <div style={{ background: "#f8d7da", padding: 6, borderRadius: 6, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <select aria-label="Proyecto" value={project} onChange={(e) => onProjectChange(e.target.value)}>
          {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
        </select>
        <select aria-label="Agente" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <textarea
        placeholder="Instrucciones para el agente…"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
      />
      <button type="submit" disabled={busy || !project || !agent || !instructions.trim()}>
        {busy ? "Despachando…" : "Despachar"}
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 6: Render it in `dashboard/src/ui/App.tsx`**

Add the import and render `<NewTaskForm/>` just inside `<main>`, above the `<h2>Estado vivo</h2>` (or right under it). Add:

```tsx
import { NewTaskForm } from "./components/NewTaskForm";
```

and place `<NewTaskForm />` as the first child of `<main>`:

```tsx
      <main style={{ flex: 1, padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>Estado vivo</h2>
        <NewTaskForm />
        {error && (
```

- [ ] **Step 7: Verify the App test + full suite still pass**

Run: `pnpm exec vitest run`
Expected: all PASS. (The existing `App.test.tsx` stubs `fetch` to always return the overview; `NewTaskForm`'s `fetchDispatchOptions` call will receive that overview shape and fail its `.catch`, setting a harmless error inside the form — the App test only asserts overview content, so it still passes. If the App test becomes flaky, extend its fetch stub to also handle `/api/dispatch-options`.)

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/ui/api.ts dashboard/src/ui/components/NewTaskForm.tsx dashboard/src/ui/components/NewTaskForm.test.tsx dashboard/src/ui/App.tsx
git commit -m "feat(dashboard): add NewTaskForm to dispatch tasks from the UI" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: README note + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Extend the "## Dashboard (local)" section in `README.md`**

Append this paragraph to that section:

```markdown
### Dispatch (read-only)

Set `ANTHROPIC_API_KEY` (copy `.env.example` to `.env`). From the dashboard, use
**Nueva tarea** to pick a project + agent and write instructions; the control plane
runs a **read-only** Claude agent (Agent SDK) against the project repo and writes its
lifecycle and result to the store, which the dashboard shows live. Read-only means the
agent can inspect the repo but cannot modify files, run commands, merge, deploy, or push.
Design: `docs/superpowers/specs/2026-05-29-dispatch-runner-design.md`.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all PASS. Report the count (the v1 20 + the new runner/dispatch/form tests).

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (If the SDK `query()` call site in `runner/claude.ts` errors on option typings, adjust the cast there per the SDK's installed types — see the SDK-boundary note at the top.)

- [ ] **Step 4: Production build smoke test**

Run: `pnpm build`
Expected: Vite builds `dashboard/dist` without errors.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document read-only dispatch in README" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** runner module incl. SDK wrapper (Tasks 5,6), read-only enforcement (Task 5 `buildQueryOptions` + canUseTool), agent prompt from registry+AGENTS.md (Tasks 2,3), AgentResult build incl. parse+fallback+status validation (Task 4), state transitions + failure handling (Task 6), reconciliation (Task 7), `POST /api/tasks` + `GET /api/dispatch-options` + injectable hook + startup reconcile (Tasks 9,10), registry allowed_agents/repo_path (Task 8), NewTaskForm (Task 11), `ANTHROPIC_API_KEY` doc (Task 1), README (Task 12). All spec sections map to a task.
- **Placeholders:** none — every code step has complete code; the SDK-typing caveat is an explicit, bounded instruction, not a TODO.
- **Type consistency:** `RegistryAgent`, `RunOptions`/`RunResult`, `buildQueryOptions`/`runReadOnlyAgent`, `toAgentResult`/`failureResult`, `RegistryProject` (extended), `createTask`/`ValidationError`, `createApp(repoRoot, onTaskCreated)`, `runTask(taskId, repoRoot)`, `reconcileRunning()`, `fetchDispatchOptions`/`createTask` are used consistently across tasks.
- **Known caveats (documented, non-blocking):** exact Agent SDK option/permission typings are adapted in `runner/claude.ts` against the installed version; read-only is guaranteed by `allowedTools` + `canUseTool` regardless.
```
