# Self-Verify (runner-run verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After committing a workspace-write agent's edits, the runner runs the project's declared verification commands in the worktree, captures the real exit code, and records it on the task result so the reviewer sees verified work before approving.

**Architecture:** Verification is a new runner-side side effect (`runner/verify.ts`), parallel to `worktree.ts`/`github.ts`. The agent never runs shell. Commands come only from the registry (`runner/registry-project.ts`). `run-task.ts` wires it after `commitAndDiff`. The report is stored on `AgentResult.verification` and surfaced as a badge in the dashboard attention panel.

**Tech Stack:** TypeScript ESM, Node `child_process.spawnSync`, `yaml`, Vitest + Testing Library/jsdom, React, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-29-self-verify-design.md`

---

## File Structure

- `lib/state/types.ts` (modify) — `VerificationCheck`, `VerificationReport`; `AgentResult.verification?`; `AttentionItem.verification?`.
- `runner/verify.ts` (create) — `runVerification(worktreePath, commands)`: runs commands fail-fast, no throw.
- `runner/verify.test.ts` (create) — unit tests with real subprocesses.
- `runner/registry-project.ts` (create) — `loadProjectVerifyCommands(repoRoot, projectId)`: resolves the verify command list from the registry.
- `runner/registry-project.test.ts` (create) — tests with a temp registry.
- `runner/result.ts` (modify) — `toAgentResult` accepts/attaches `verification`; `failureResult` sets `null`.
- `runner/result.test.ts` (modify) — verification attachment tests.
- `lib/state/derive.ts` (modify) — set `verification` on finished-task attention items.
- `lib/state/derive.test.ts` (modify) — attention-item verification test.
- `runner/run-task.ts` (modify) — run verification after commit (workspace-write, when committed).
- `runner/run-task.test.ts` (modify) — wiring tests (mock `./verify` + `./registry-project`).
- `dashboard/src/ui/components/AttentionPanel.tsx` (modify) — verification badge.
- `dashboard/src/ui/components/AttentionPanel.test.tsx` (modify) — badge tests.
- `README.md` (modify) — document self-verify.

---

## Task 1: Verification types

**Files:**
- Modify: `lib/state/types.ts`

- [ ] **Step 1: Add the verification types and fields**

In `lib/state/types.ts`, add the two interfaces just above `export interface ReviewDecision`:

```ts
export interface VerificationCheck {
  command: string;
  ok: boolean;
  output_tail: string; // last ~4000 chars of combined stdout+stderr (full output goes to the jsonl log)
}

export interface VerificationReport {
  status: "passed" | "failed" | "skipped";
  checks: VerificationCheck[];
}
```

In `export interface AgentResult { ... }`, add after `logs_path: string;`:

```ts
  verification?: VerificationReport | null;
```

In `export interface AttentionItem { ... }`, add after `title: string;`:

```ts
  verification?: VerificationReport["status"] | null;
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(state): add VerificationReport types"
```

---

## Task 2: `runVerification` (runner/verify.ts)

**Files:**
- Create: `runner/verify.ts`
- Test: `runner/verify.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `runner/verify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runVerification } from "./verify";

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "process.exit(1)"`;
const BIG = `node -e "for(let i=0;i<5000;i++)process.stdout.write('x')"`;

describe("runVerification", () => {
  it("returns skipped for an empty command list", () => {
    const r = runVerification(process.cwd(), []);
    expect(r.status).toBe("skipped");
    expect(r.checks).toEqual([]);
  });

  it("returns passed when all commands exit 0", () => {
    const r = runVerification(process.cwd(), [PASS, PASS]);
    expect(r.status).toBe("passed");
    expect(r.checks).toHaveLength(2);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails fast: stops at the first failing command", () => {
    const r = runVerification(process.cwd(), [FAIL, PASS]);
    expect(r.status).toBe("failed");
    expect(r.checks).toHaveLength(1); // the second command never ran
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].command).toBe(FAIL);
  });

  it("truncates output_tail to at most 4000 chars", () => {
    const r = runVerification(process.cwd(), [BIG]);
    expect(r.status).toBe("passed");
    expect(r.checks[0].output_tail.length).toBeLessThanOrEqual(4000);
  });

  it("records a spawn error as a failed check (missing binary)", () => {
    const r = runVerification(process.cwd(), ["this-binary-does-not-exist-zzz --nope"]);
    expect(r.status).toBe("failed");
    expect(r.checks[0].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/verify.test.ts`
Expected: FAIL (cannot find module `./verify`).

- [ ] **Step 3: Implement `runner/verify.ts`**

```ts
import { spawnSync } from "node:child_process";
import type { VerificationReport, VerificationCheck } from "../lib/state/types";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 4000;

// Runs the given commands IN ORDER in the worktree, fail-fast. Commands come from the
// trusted registry (never agent input), so shell:true is acceptable and resolves
// pnpm/pnpm.cmd cross-platform. Never throws — a spawn failure is recorded as a failed check.
export function runVerification(worktreePath: string, commands: string[]): VerificationReport {
  if (commands.length === 0) return { status: "skipped", checks: [] };
  const checks: VerificationCheck[] = [];
  for (const command of commands) {
    const r = spawnSync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: "utf8",
      timeout: VERIFY_TIMEOUT_MS,
    });
    const ok = r.status === 0 && !r.error;
    const combined = (r.stdout ?? "") + (r.stderr ?? "") + (r.error ? r.error.message : "");
    checks.push({ command, ok, output_tail: combined.slice(-TAIL_CHARS) });
    if (!ok) return { status: "failed", checks };
  }
  return { status: "passed", checks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/verify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/verify.ts runner/verify.test.ts
git commit -m "feat(runner): runVerification (fail-fast, no throw)"
```

---

## Task 3: `loadProjectVerifyCommands` (runner/registry-project.ts)

**Files:**
- Create: `runner/registry-project.ts`
- Test: `runner/registry-project.test.ts`

Reference the existing loaders for style: `runner/registry-agents.ts` and `dashboard/src/server/registry.ts`.

- [ ] **Step 1: Write the failing tests**

Create `runner/registry-project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectVerifyCommands } from "./registry-project";

let root: string;

function writeRegistry(yml: string): void {
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-regproj-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadProjectVerifyCommands", () => {
  it("returns an explicit verify list verbatim", () => {
    writeRegistry(`projects:\n  p:\n    verify:\n      - pnpm install\n      - pnpm exec tsc --noEmit\n      - pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm install", "pnpm exec tsc --noEmit", "pnpm test"]);
  });

  it("defaults to [install, test] from commands", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      install: pnpm install\n      test: pnpm test\n      build: pnpm build\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm install", "pnpm test"]);
  });

  it("falls back to [test] when there is no install", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm test"]);
  });

  it("returns [] for an unknown project", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "missing")).toEqual([]);
  });

  it("returns [] when the registry file is missing", () => {
    expect(loadProjectVerifyCommands(root, "p")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/registry-project.test.ts`
Expected: FAIL (cannot find module `./registry-project`).

- [ ] **Step 3: Implement `runner/registry-project.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface RegistryDoc {
  projects?: Record<string, {
    verify?: string[];
    commands?: { install?: string; test?: string; build?: string; lint?: string };
  }>;
}

// Resolves the verification command list for a project from the registry (trusted config).
// Never throws — any error (missing file, parse error, unknown project) yields [].
export function loadProjectVerifyCommands(repoRoot: string, projectId: string): string[] {
  let doc: RegistryDoc;
  try {
    const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
    doc = (parse(raw) ?? {}) as RegistryDoc;
  } catch {
    return [];
  }
  const p = doc.projects?.[projectId];
  if (!p) return [];
  if (Array.isArray(p.verify) && p.verify.length > 0) {
    return p.verify.filter((c): c is string => typeof c === "string");
  }
  const cmds = p.commands ?? {};
  if (cmds.install && cmds.test) return [cmds.install, cmds.test];
  if (cmds.test) return [cmds.test];
  return [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/registry-project.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/registry-project.ts runner/registry-project.test.ts
git commit -m "feat(runner): loadProjectVerifyCommands from the registry"
```

---

## Task 4: Attach verification to the result (runner/result.ts)

**Files:**
- Modify: `runner/result.ts`
- Test: `runner/result.test.ts`

The current `toAgentResult` signature is `toAgentResult(envelope, text, logsPath, filesChanged = [])`. Add a fifth optional param.

- [ ] **Step 1: Write the failing tests**

Add these to `runner/result.test.ts` (create the file if it does not exist, using the imports/pattern below):

```ts
import { describe, it, expect } from "vitest";
import { toAgentResult, failureResult } from "./result";
import type { TaskEnvelope, VerificationReport } from "../lib/state/types";

const envelope = {
  id: "T-1", source: "test", project: "p", task_type: "implementation", agent: "a",
  title: "t", instructions: "do it", repo_path: "/tmp/p", branch: "agent/T-1-a",
  sandbox: "workspace-write", expected_outputs: [], requires_human_approval: true, metadata: {},
} as TaskEnvelope;

describe("toAgentResult verification", () => {
  it("attaches the verification report when provided", () => {
    const report: VerificationReport = { status: "passed", checks: [{ command: "pnpm test", ok: true, output_tail: "" }] };
    const r = toAgentResult(envelope, "done\n```json\n{\"status\":\"completed\"}\n```", "log.jsonl", ["a.ts"], report);
    expect(r.verification).toEqual(report);
  });

  it("defaults verification to null", () => {
    const r = toAgentResult(envelope, "done", "log.jsonl");
    expect(r.verification).toBeNull();
  });

  it("failureResult sets verification to null", () => {
    expect(failureResult(envelope, "boom", "log.jsonl").verification).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/result.test.ts`
Expected: FAIL (`verification` is `undefined`, not `null` / not present).

- [ ] **Step 3: Update `runner/result.ts`**

Change the import line to include `VerificationReport`:

```ts
import type { AgentResult, AgentOutcome, TaskEnvelope, VerificationReport } from "../lib/state/types";
```

Change the `toAgentResult` signature and add the field. The new signature:

```ts
export function toAgentResult(
  envelope: TaskEnvelope,
  text: string,
  logsPath: string,
  filesChanged: string[] = [],
  verification: VerificationReport | null = null,
): AgentResult {
```

In the returned object, add after `logs_path: logsPath,`:

```ts
    verification,
```

In `failureResult`, add after `logs_path: logsPath,`:

```ts
    verification: null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/result.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runner/result.ts runner/result.test.ts
git commit -m "feat(runner): attach verification report to AgentResult"
```

---

## Task 5: Surface verification on attention items (lib/state/derive.ts)

**Files:**
- Modify: `lib/state/derive.ts`
- Test: `lib/state/derive.test.ts`

In `buildOverview`, the attention loop pushes `needs-review` and `awaiting-approval` items for finished tasks. Add the verification status to those two pushes.

- [ ] **Step 1: Write the failing test**

Add to `lib/state/derive.test.ts` (follow the existing fixtures/helpers in that file for building a `TaskRecord`; the assertion is what matters):

```ts
it("surfaces verification status on the awaiting-approval attention item", () => {
  const rec = makeFinishedTask({ requiresApproval: true, outcome: "completed" });
  rec.result!.verification = { status: "failed", checks: [{ command: "pnpm test", ok: false, output_tail: "" }] };
  const overview = buildOverview([{ id: "p", status: "active", repo: null }], [rec], []);
  const item = overview.attention.find((a) => a.task_id === rec.envelope.id && a.kind === "awaiting-approval");
  expect(item?.verification).toBe("failed");
});

it("leaves verification null when the result has none", () => {
  const rec = makeFinishedTask({ requiresApproval: true, outcome: "completed" });
  const overview = buildOverview([{ id: "p", status: "active", repo: null }], [rec], []);
  const item = overview.attention.find((a) => a.kind === "awaiting-approval");
  expect(item?.verification ?? null).toBeNull();
});
```

> If the test file has no `makeFinishedTask` helper, build the `TaskRecord` inline matching the project's existing fixtures in `derive.test.ts` (finished lifecycle, `requires_human_approval: true`, `decision: null`, a `result` object). Reuse whatever helper/shape the file already uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/state/derive.test.ts`
Expected: FAIL (`item.verification` is `undefined`).

- [ ] **Step 3: Update `lib/state/derive.ts`**

In the attention loop, update the two task-level pushes to include the verification status. Replace:

```ts
    if (t.lifecycle === "finished" && t.outcome === "needs-review") {
      attention.push({ kind: "needs-review", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title });
    } else if (t.lifecycle === "finished" && t.envelope.requires_human_approval) {
      attention.push({ kind: "awaiting-approval", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title });
    }
```

with:

```ts
    const verification = t.result?.verification?.status ?? null;
    if (t.lifecycle === "finished" && t.outcome === "needs-review") {
      attention.push({ kind: "needs-review", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title, verification });
    } else if (t.lifecycle === "finished" && t.envelope.requires_human_approval) {
      attention.push({ kind: "awaiting-approval", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title, verification });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/state/derive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state/derive.ts lib/state/derive.test.ts
git commit -m "feat(state): surface verification status on attention items"
```

---

## Task 6: Run verification in run-task (runner/run-task.ts)

**Files:**
- Modify: `runner/run-task.ts`
- Test: `runner/run-task.test.ts`

Wire verification into the workspace-write branch, after `commitAndDiff`, only when `committed`.

- [ ] **Step 1: Write the failing tests**

`runner/run-task.test.ts` already mocks the SDK (`./claude`) and `./worktree`. Add mocks for `./verify` and `./registry-project`, then add these cases (adapt to the file's existing mock setup and helpers):

```ts
// at the top with the other vi.mock(...) calls:
vi.mock("./verify", () => ({ runVerification: vi.fn(() => ({ status: "passed", checks: [] })) }));
vi.mock("./registry-project", () => ({ loadProjectVerifyCommands: vi.fn(() => ["pnpm test"]) }));
```

```ts
import { runVerification } from "./verify";
import { loadProjectVerifyCommands } from "./registry-project";

it("runs verification for a workspace-write task with committed edits", async () => {
  // arrange a queued workspace-write task whose commitAndDiff mock returns committed:true
  // (reuse the existing helper that the workspace-write tests use)
  await runTask(taskId, repoRoot);
  expect(loadProjectVerifyCommands).toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalled();
  const rec = readTask(taskId)!;
  expect(rec.result?.verification?.status).toBe("passed");
});

it("does not run verification for a read-only task", async () => {
  vi.clearAllMocks();
  // arrange a queued read-only task
  await runTask(readOnlyTaskId, repoRoot);
  expect(runVerification).not.toHaveBeenCalled();
});
```

> Use the existing test helpers in `run-task.test.ts` to seed the queued task records and to set the `commitAndDiff` mock's `committed` value. The two assertions (verification called for workspace-write+committed; not called for read-only) are the goal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/run-task.test.ts`
Expected: FAIL (`runVerification` not called / `verification` undefined).

- [ ] **Step 3: Update `runner/run-task.ts`**

Add the imports near the other runner imports:

```ts
import { runVerification } from "./verify";
import { loadProjectVerifyCommands } from "./registry-project";
```

In the workspace-write branch, replace this block:

```ts
        const { filesChanged, diffstat, committed } = commitAndDiff(
          worktreePath,
          `agent ${rec.envelope.id}: ${rec.envelope.title}`.slice(0, 72),
        );
        writeLog({ task_id: rec.envelope.id, mode, branch, worktree_path: worktreePath, committed, diffstat, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, branch, worktree_path: worktreePath, diffstat, committed, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath, filesChanged);
        finish(result.status, result);
```

with:

```ts
        const { filesChanged, diffstat, committed } = commitAndDiff(
          worktreePath,
          `agent ${rec.envelope.id}: ${rec.envelope.title}`.slice(0, 72),
        );
        const verification = committed
          ? runVerification(worktreePath, loadProjectVerifyCommands(repoRoot, rec.envelope.project))
          : null;
        writeLog({ task_id: rec.envelope.id, mode, branch, worktree_path: worktreePath, committed, diffstat, verification, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, branch, worktree_path: worktreePath, diffstat, committed, verification, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath, filesChanged, verification);
        finish(result.status, result);
```

(The read-only branch is unchanged — `toAgentResult` is called without a verification report, so it stays `null`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/run-task.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runner/run-task.ts runner/run-task.test.ts
git commit -m "feat(runner): run verification after commit for workspace-write tasks"
```

---

## Task 7: Verification badge in the attention panel (AttentionPanel.tsx)

**Files:**
- Modify: `dashboard/src/ui/components/AttentionPanel.tsx`
- Test: `dashboard/src/ui/components/AttentionPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/ui/components/AttentionPanel.test.tsx` (reuse the file's existing render setup and `AttentionItem` shape):

```ts
it("renders a verification badge per item status", () => {
  render(
    <AttentionPanel
      items={[
        { kind: "awaiting-approval", task_id: "T-1", project: "p", title: "ok", verification: "passed" },
        { kind: "awaiting-approval", task_id: "T-2", project: "p", title: "bad", verification: "failed" },
        { kind: "awaiting-approval", task_id: "T-3", project: "p", title: "none", verification: null },
      ]}
    />,
  );
  expect(screen.getByText(/✓ verificado/)).toBeInTheDocument();
  expect(screen.getByText(/✗ verificación falló/)).toBeInTheDocument();
  expect(screen.getByText(/\(sin verificar\)/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: FAIL (badge text not found).

- [ ] **Step 3: Update `AttentionPanel.tsx`**

Add a badge helper above the component:

```tsx
function verificationBadge(v: AttentionItem["verification"]): string {
  if (v === "passed") return "✓ verificado";
  if (v === "failed") return "✗ verificación falló";
  return "(sin verificar)";
}
```

In the `<li>` for task-kind items, render the badge. Inside the `TASK_KINDS.includes(a.kind) && (...)` block, add a `<small>` before the buttons:

```tsx
              {TASK_KINDS.includes(a.kind) && (
                <>
                  {" "}
                  <small style={{ color: a.verification === "failed" ? "#b02a37" : "#666" }}>
                    {verificationBadge(a.verification)}
                  </small>{" "}
                  <button type="button" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>{" "}
                  <button type="button" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                </>
              )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/components/AttentionPanel.tsx dashboard/src/ui/components/AttentionPanel.test.tsx
git commit -m "feat(dashboard): verification badge in the attention panel"
```

---

## Task 8: Document self-verify + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README paragraph**

Add a short section to `README.md` (near the workspace-write / review-gate docs) describing self-verify:

```markdown
### Self-verify

When a workspace-write task finishes and its edits are committed, the runner runs the project's
declared verification commands (from `registry/projects.yml` — an explicit `verify:` list, or by
default `[install, test]` from `commands`) inside the worktree, captures the real exit codes, and
records the result on the task. The dashboard shows a ✓/✗ badge in the attention panel so you see
verified work before approving. The agent never runs shell — the runner performs verification.
Verification is fail-fast and never crashes a run; it does not block approval (the human decides).
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (prior 87 + the new verify/registry-project/result/derive/run-task/AttentionPanel tests).

- [ ] **Step 3: Type-check and build**

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document self-verify"
```

---

## Self-Review (plan vs. spec)

**Spec coverage:**
- §5 types → Task 1. `runner/verify.ts` → Task 2. `runner/registry-project.ts` → Task 3.
  `result.ts` → Task 4. `derive.ts` → Task 5. `run-task.ts` → Task 6. `AttentionPanel.tsx` → Task 7.
  README → Task 8. ✅ All components mapped.
- §9 testing → every listed test file has a task (verify, registry-project, result, derive, run-task,
  AttentionPanel). ✅
- §7 safety (runner runs commands, registry-only source, commit-before-verify, no throw, fail-fast) →
  Tasks 2 + 6 implement; verify.ts never throws; run-task commits before verifying. ✅

**Type consistency:** `VerificationReport`/`VerificationCheck` defined in Task 1 and used identically in
Tasks 2/4/5/6/7. `runVerification(worktreePath, commands)` and `loadProjectVerifyCommands(repoRoot,
projectId)` signatures match across Tasks 2/3/6. `AttentionItem.verification` (Task 1) matches the
derive push (Task 5) and the badge (Task 7). ✅

**Placeholder scan:** No TBD/TODO; every code step has full code. The derive/run-task/AttentionPanel
test steps note "reuse the existing helper" because they extend existing test files — the concrete
assertions and mock setup are provided; the implementer adapts to the file's existing fixtures. ✅
