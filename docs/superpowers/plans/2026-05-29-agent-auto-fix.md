# Agent Auto-Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `self_verify` workspace-write task gives the agent a strictly allowlisted Bash tool (only the project's exact verify commands) so it can run tests/typecheck during its turn and fix failures before finishing; the runner's post-commit verification (slice 6) stays the ground-truth record.

**Architecture:** A third internal `RunMode` `"workspace-write-verify"` in `runner/claude.ts` adds Bash to the toolset but `canUseTool` permits a Bash call only when the command exactly equals a registry verify command. Opt-in via a new `TaskEnvelope.self_verify` flag set at dispatch; `run-task` derives the mode and threads the verify commands. read-only and plain workspace-write are unchanged (no Bash).

**Tech Stack:** TypeScript ESM, Claude Agent SDK (`canUseTool`/`allowedTools`), Hono, React, Vitest + Testing Library/jsdom, yaml, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-29-agent-auto-fix-design.md`

---

## File Structure

- `lib/state/types.ts` (modify) — `TaskEnvelope.self_verify?: boolean`.
- `schemas/task-envelope.schema.json` (modify) — mirror the optional `self_verify` boolean.
- `runner/claude.ts` (modify) — third `RunMode`, `VERIFY_TOOLS`, `RunOptions.verifyCommands?`, exact-match Bash gating, verify maxTurns.
- `runner/claude.test.ts` (modify) — policy + gating tests.
- `runner/agent-prompt.ts` (modify) — verify-mode system-prompt branch.
- `runner/agent-prompt.test.ts` (modify) — verify-prompt test.
- `dashboard/src/server/dispatch.ts` (modify) — `self_verify` input + validation + envelope.
- `dashboard/src/server/dispatch.test.ts` (modify) — validation tests.
- `dashboard/src/server/index.ts` (modify) — widen the `createTask` body cast.
- `runner/run-task.ts` (modify) — derive mode, load verify commands once, thread to runAgent + slice-6 verify.
- `runner/run-task.test.ts` (modify) — mode-derivation tests.
- `dashboard/src/ui/api.ts` (modify) — `createTask` body gains `self_verify?`.
- `dashboard/src/ui/components/NewTaskForm.tsx` (modify) — third mode option.
- `dashboard/src/ui/components/NewTaskForm.test.tsx` (modify) — dispatch-body test.
- `README.md` (modify) — document the auto-fix loop.

---

## Task 1: `self_verify` envelope flag + schema

**Files:**
- Modify: `lib/state/types.ts`
- Modify: `schemas/task-envelope.schema.json`

- [ ] **Step 1: Add the field to the type**

In `lib/state/types.ts`, in `export interface TaskEnvelope { ... }`, add after `metadata: Record<string, unknown>;`:

```ts
  self_verify?: boolean;
```

- [ ] **Step 2: Mirror it in the JSON schema**

In `schemas/task-envelope.schema.json`, add a property to the `properties` object (do NOT add it to `required`). Add this entry (place it after the existing `metadata` property, adjusting commas so the JSON stays valid):

```json
    "self_verify": {
      "type": "boolean"
    }
```

- [ ] **Step 3: Validate JSON + type-check**

Run: `node -e "JSON.parse(require('fs').readFileSync('schemas/task-envelope.schema.json','utf8')); console.log('ok')"`
Expected: `ok`

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/state/types.ts schemas/task-envelope.schema.json
git commit -m "feat(state): add self_verify flag to TaskEnvelope"
```

---

## Task 2: Verify run mode + exact-match Bash gating (claude.ts)

**Files:**
- Modify: `runner/claude.ts`
- Test: `runner/claude.test.ts`

Read `runner/claude.ts` first. Current: `RunMode = "read-only" | "workspace-write"`, `READ_ONLY_TOOLS`, `WRITE_TOOLS`, `EXEC_TOOLS`, `WRITE_TOOLS_DISALLOWED_IN_READONLY`, a pure `buildQueryOptions(o)`, and `runAgent`.

- [ ] **Step 1: Write the failing tests**

Add to `runner/claude.test.ts` (match the file's existing import of `buildQueryOptions`):

```ts
const baseVerify = {
  cwd: "/w", systemPrompt: "s", prompt: "p",
  mode: "workspace-write-verify" as const,
  verifyCommands: ["pnpm install", "pnpm test"],
};

it("verify mode allows Bash/BashOutput/KillBash and denies only NotebookEdit", () => {
  const q = buildQueryOptions(baseVerify);
  expect(q.allowedTools).toEqual(expect.arrayContaining(["Bash", "BashOutput", "KillBash", "Edit", "Write"]));
  expect(q.disallowedTools).toContain("NotebookEdit");
  expect(q.disallowedTools).not.toContain("Bash");
});

it("verify mode: canUseTool allows an exact allowlisted command (trimmed)", async () => {
  const q = buildQueryOptions(baseVerify);
  expect((await q.canUseTool("Bash", { command: "pnpm test" })).behavior).toBe("allow");
  expect((await q.canUseTool("Bash", { command: "  pnpm install  " })).behavior).toBe("allow");
});

it("verify mode: canUseTool denies non-listed, arg-extended, or chained commands", async () => {
  const q = buildQueryOptions(baseVerify);
  expect((await q.canUseTool("Bash", { command: "rm -rf /" })).behavior).toBe("deny");
  expect((await q.canUseTool("Bash", { command: "pnpm test --watch" })).behavior).toBe("deny");
  expect((await q.canUseTool("Bash", { command: "pnpm test && rm -rf ." })).behavior).toBe("deny");
  expect((await q.canUseTool("Bash", {})).behavior).toBe("deny");
});

it("verify mode: denies tools outside VERIFY_TOOLS", async () => {
  const q = buildQueryOptions(baseVerify);
  expect((await q.canUseTool("NotebookEdit", {})).behavior).toBe("deny");
  expect((await q.canUseTool("WebFetch", {})).behavior).toBe("deny");
});

it("verify mode bumps default maxTurns to 20", () => {
  expect(buildQueryOptions(baseVerify).maxTurns).toBe(20);
});

it("plain workspace-write still denies Bash entirely", async () => {
  const q = buildQueryOptions({ cwd: "/w", systemPrompt: "s", prompt: "p", mode: "workspace-write" });
  expect(q.allowedTools).not.toContain("Bash");
  expect(q.disallowedTools).toContain("Bash");
  expect((await q.canUseTool("Bash", { command: "pnpm test" })).behavior).toBe("deny");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/claude.test.ts`
Expected: FAIL (verify mode not handled; `verifyCommands` not on type).

- [ ] **Step 3: Implement the changes in `runner/claude.ts`**

Change the `RunMode` type:
```ts
export type RunMode = "read-only" | "workspace-write" | "workspace-write-verify";
```

Add the verify toolset constant after `WRITE_TOOLS`:
```ts
// Verify mode = write tools + a STRICTLY allowlisted shell (gated in canUseTool).
export const VERIFY_TOOLS = [...WRITE_TOOLS, "Bash", "BashOutput", "KillBash"] as const;
```

Add `verifyCommands` to `RunOptions` (after `maxTurns?: number;`):
```ts
  verifyCommands?: string[];
```

Replace the body of `buildQueryOptions` with mode-aware allow/deny + Bash gating:
```ts
  const allowed = (
    o.mode === "workspace-write-verify"
      ? VERIFY_TOOLS
      : o.mode === "workspace-write"
        ? WRITE_TOOLS
        : READ_ONLY_TOOLS
  ) as readonly string[];
  const disallowed =
    o.mode === "read-only"
      ? [...EXEC_TOOLS, ...WRITE_TOOLS_DISALLOWED_IN_READONLY]
      : o.mode === "workspace-write"
        ? [...EXEC_TOOLS]
        : ["NotebookEdit"]; // workspace-write-verify: Bash/BashOutput/KillBash allowed; NotebookEdit denied
  const verifySet = new Set(o.verifyCommands ?? []);
  return {
    cwd: o.cwd,
    systemPrompt: o.systemPrompt,
    model: o.model ?? "claude-sonnet-4-6",
    maxTurns: o.maxTurns ?? (o.mode === "workspace-write-verify" ? 20 : 12),
    allowedTools: [...allowed],
    disallowedTools: disallowed,
    canUseTool: async (toolName, input) => {
      if (o.mode === "workspace-write-verify" && toolName === "Bash") {
        const cmd = typeof input.command === "string" ? input.command.trim() : "";
        return verifySet.has(cmd)
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: `runner (verify): Bash command not allowlisted: ${cmd}` };
      }
      return allowed.includes(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `runner (${o.mode}): tool '${toolName}' is not permitted` };
    },
  };
```

(`runAgent` needs no change — it already feeds the whole `o` to `buildQueryOptions`, whose `canUseTool` closure captures `verifySet`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/claude.test.ts`
Expected: PASS (existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add runner/claude.ts runner/claude.test.ts
git commit -m "feat(runner): workspace-write-verify mode with exact-match Bash allowlist"
```

---

## Task 3: Verify-mode system prompt (agent-prompt.ts)

**Files:**
- Modify: `runner/agent-prompt.ts`
- Test: `runner/agent-prompt.test.ts`

Current signature: `buildSystemPrompt(agent, agentsMd, mode: RunMode = "read-only")` with a `modeLines` ternary for the two existing modes.

- [ ] **Step 1: Write the failing test**

Add to `runner/agent-prompt.test.ts` (reuse the file's existing `RegistryAgent` fixture; the assertions are the goal):

```ts
it("verify mode lists the exact allowed commands and the ONLY-these instruction", () => {
  const agent = { id: "be", name: "Backend", description: "impl", allowed_task_types: ["bugfix"] };
  const p = buildSystemPrompt(agent as any, "RULES", "workspace-write-verify", ["pnpm install", "pnpm test"]);
  expect(p).toContain("WORKSPACE-WRITE mode with VERIFICATION");
  expect(p).toMatch(/ONLY these exact commands/i);
  expect(p).toContain("pnpm install");
  expect(p).toContain("pnpm test");
});

it("workspace-write (non-verify) prompt does not mention Bash verification", () => {
  const agent = { id: "be", name: "Backend", description: "impl", allowed_task_types: ["bugfix"] };
  const p = buildSystemPrompt(agent as any, "RULES", "workspace-write");
  expect(p).not.toMatch(/VERIFICATION/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run runner/agent-prompt.test.ts`
Expected: FAIL (verify branch not present; 4th param ignored).

- [ ] **Step 3: Implement in `runner/agent-prompt.ts`**

Change the signature to accept the commands:
```ts
export function buildSystemPrompt(
  agent: RegistryAgent,
  agentsMd: string,
  mode: RunMode = "read-only",
  verifyCommands: string[] = [],
): string {
```

Replace the `modeLines` assignment with a three-way branch (keep the existing read-only and workspace-write text; add the verify branch):
```ts
  const modeLines =
    mode === "workspace-write-verify"
      ? [
          "You are running in WORKSPACE-WRITE mode with VERIFICATION. You MAY use Read, Grep, and Glob",
          "to inspect the repository AND edit files with Edit, Write, and MultiEdit. You MAY ALSO run",
          "ONLY these exact commands via Bash to verify your work:",
          ...verifyCommands.map((c) => `  - ${c}`),
          "Run them; if they fail, fix your edits and re-run until they pass. Any other shell command is",
          "denied. You must NOT merge, deploy, or push. The control plane commits your edits to a branch",
          "for human review.",
        ]
      : mode === "workspace-write"
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run runner/agent-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runner/agent-prompt.ts runner/agent-prompt.test.ts
git commit -m "feat(runner): verify-mode system prompt lists the allowed commands"
```

---

## Task 4: Dispatch validation + flag (dispatch.ts, index.ts)

**Files:**
- Modify: `dashboard/src/server/dispatch.ts`
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/dispatch.test.ts`

Read `dashboard/src/server/dispatch.ts` and `dispatch.test.ts` first.

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/src/server/dispatch.test.ts` (reuse the file's temp-registry setup, `createTask`, `readTask`, and the project/agent ids it already uses — substitute the placeholders with the file's existing valid project/agent):

```ts
it("rejects self_verify on a read-only task", () => {
  expect(() =>
    createTask({ project: PROJECT, agent: AGENT, instructions: "x", sandbox: "read-only", self_verify: true }, root),
  ).toThrow(/self_verify requires/i);
});

it("sets self_verify on a workspace-write envelope", () => {
  const { id } = createTask({ project: PROJECT, agent: AGENT, instructions: "x", sandbox: "workspace-write", self_verify: true }, root);
  expect(readTask(id)!.envelope.self_verify).toBe(true);
});

it("defaults self_verify to false when omitted", () => {
  const { id } = createTask({ project: PROJECT, agent: AGENT, instructions: "x", sandbox: "workspace-write" }, root);
  expect(readTask(id)!.envelope.self_verify).toBe(false);
});
```

(Use the existing valid `PROJECT`/`AGENT` constants/values from the test file; `stock-control` + `backend-engineer` are valid in the real registry if the test uses it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run dashboard/src/server/dispatch.test.ts`
Expected: FAIL (`self_verify` not handled).

- [ ] **Step 3: Implement in `dashboard/src/server/dispatch.ts`**

Add to `CreateTaskInput`:
```ts
  self_verify?: boolean;
```

In `createTask`, after the `sandbox` validation block, add:
```ts
  const selfVerify = input?.self_verify === true;
  if (selfVerify && sandbox !== "workspace-write") {
    throw new ValidationError("self_verify requires sandbox workspace-write");
  }
```

In the `envelope` object literal, add (after `metadata: { created_by: "dashboard" },` — or wherever fields end; keep valid commas):
```ts
    self_verify: selfVerify && sandbox === "workspace-write",
```

- [ ] **Step 4: Widen the body cast in `dashboard/src/server/index.ts`**

In the `POST /api/tasks` handler, change:
```ts
      const { id } = createTask(body as { project: string; agent: string; instructions: string }, repoRoot);
```
to:
```ts
      const { id } = createTask(
        body as { project: string; agent: string; instructions: string; sandbox?: string; self_verify?: boolean },
        repoRoot,
      );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run dashboard/src/server/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/dispatch.ts dashboard/src/server/index.ts dashboard/src/server/dispatch.test.ts
git commit -m "feat(dashboard): accept and validate self_verify at dispatch"
```

---

## Task 5: Wire the mode in run-task (run-task.ts)

**Files:**
- Modify: `runner/run-task.ts`
- Test: `runner/run-task.test.ts`

Read `runner/run-task.ts` and `runner/run-task.test.ts` first. `run-task.test.ts` already mocks `./claude`, `./worktree`, `./verify`, `./registry-project` (with `loadProjectVerifyCommands` defaulting to `["pnpm test"]`).

- [ ] **Step 1: Write the failing tests**

Add to `runner/run-task.test.ts` (reuse `writeRecord()` for workspace-write and `queuedRecord()` for read-only):

```ts
it("self_verify workspace-write → runAgent in workspace-write-verify mode with verifyCommands", async () => {
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = writeRecord(); r.envelope.self_verify = true; writeTask(r);
  vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath: join(repo, "..", "wt") });
  vi.mocked(runAgent).mockResolvedValue({ text: '```json\n{ "summary": "ok", "status": "completed" }\n```', costUsd: 0, tokens: 0 });
  vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["a.ts"], diffstat: "x", committed: true });
  vi.mocked(loadProjectVerifyCommands).mockReturnValue(["pnpm test"]);

  await runTask("T-1", root);

  const arg = vi.mocked(runAgent).mock.calls[0][0];
  expect(arg.mode).toBe("workspace-write-verify");
  expect(arg.verifyCommands).toEqual(["pnpm test"]);
});

it("workspace-write WITHOUT self_verify → runAgent in workspace-write mode", async () => {
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeTask(writeRecord());
  vi.mocked(createWorktree).mockReturnValue({ branch: "b", worktreePath: join(repo, "..", "wt") });
  vi.mocked(runAgent).mockResolvedValue({ text: '```json\n{ "summary": "ok", "status": "completed" }\n```', costUsd: 0, tokens: 0 });
  vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["a.ts"], diffstat: "x", committed: true });

  await runTask("T-1", root);

  expect(vi.mocked(runAgent).mock.calls[0][0].mode).toBe("workspace-write");
});

it("self_verify but no verify commands → falls back to workspace-write", async () => {
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = writeRecord(); r.envelope.self_verify = true; writeTask(r);
  vi.mocked(createWorktree).mockReturnValue({ branch: "b", worktreePath: join(repo, "..", "wt") });
  vi.mocked(runAgent).mockResolvedValue({ text: '```json\n{ "summary": "ok", "status": "completed" }\n```', costUsd: 0, tokens: 0 });
  vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: ["a.ts"], diffstat: "x", committed: true });
  vi.mocked(loadProjectVerifyCommands).mockReturnValue([]);

  await runTask("T-1", root);

  expect(vi.mocked(runAgent).mock.calls[0][0].mode).toBe("workspace-write");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run runner/run-task.test.ts`
Expected: FAIL (mode is always "workspace-write"; `verifyCommands` not passed to runAgent).

- [ ] **Step 3: Implement in `runner/run-task.ts`**

Replace the current mode/systemPrompt derivation:
```ts
    const mode = rec.envelope.sandbox === "workspace-write" ? "workspace-write" : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode);
    const prompt = buildUserPrompt(rec.envelope);
```
with:
```ts
    const verifyCommands =
      rec.envelope.sandbox === "workspace-write" ? loadProjectVerifyCommands(repoRoot, rec.envelope.project) : [];
    const wantsVerify = rec.envelope.self_verify === true && verifyCommands.length > 0;
    const mode = wantsVerify
      ? "workspace-write-verify"
      : rec.envelope.sandbox === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode, verifyCommands);
    const prompt = buildUserPrompt(rec.envelope);
```

Change the workspace-write branch guard from `if (mode === "workspace-write")` to:
```ts
      if (rec.envelope.sandbox === "workspace-write") {
```

Inside that branch, pass `mode` and `verifyCommands` to `runAgent`:
```ts
        const { text, costUsd, tokens } = await runAgent(
          { cwd: worktreePath, systemPrompt, prompt, mode, verifyCommands },
          controller.signal,
        );
```

And change the slice-6 verification line to reuse the already-loaded `verifyCommands` (remove the inline `loadProjectVerifyCommands` call there):
```ts
        const verification = committed ? runVerification(worktreePath, verifyCommands) : null;
```

(The read-only `else` branch is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run runner/run-task.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add runner/run-task.ts runner/run-task.test.ts
git commit -m "feat(runner): derive workspace-write-verify mode from self_verify"
```

---

## Task 6: Dispatch UI third option (NewTaskForm.tsx, api.ts)

**Files:**
- Modify: `dashboard/src/ui/api.ts`
- Modify: `dashboard/src/ui/components/NewTaskForm.tsx`
- Test: `dashboard/src/ui/components/NewTaskForm.test.tsx`

Read `NewTaskForm.tsx` and `NewTaskForm.test.tsx` first.

- [ ] **Step 1: Add `self_verify` to the api type**

In `dashboard/src/ui/api.ts`, extend the `createTask` body type:
```ts
export async function createTask(body: {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
  self_verify?: boolean;
}): Promise<{ id: string }> {
```
(No other change in `api.ts`; it already JSON-stringifies the whole body.)

- [ ] **Step 2: Write the failing test**

Add to `dashboard/src/ui/components/NewTaskForm.test.tsx` (reuse the file's existing fetch stubbing / render setup; adapt selectors to how the file already drives the form):

```ts
it("dispatches self_verify when the auto-fix mode is selected", async () => {
  render(<NewTaskForm />);
  // wait for options to load, then choose project/agent as the existing tests do
  await screen.findByLabelText("Modo");
  fireEvent.change(screen.getByLabelText("Modo"), { target: { value: "workspace-write-verify" } });
  fireEvent.change(screen.getByPlaceholderText(/Instrucciones/i), { target: { value: "fix the bug" } });
  fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

  await waitFor(() => {
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const post = calls.find((c) => String(c[0]) === "/api/tasks");
    expect(post).toBeTruthy();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body.sandbox).toBe("workspace-write");
    expect(body.self_verify).toBe(true);
  });
});
```

> Adapt this to the file's existing setup (it already stubs `fetch` for `/api/dispatch-options` and `/api/tasks`). If the existing tests use a helper to pick project/agent, reuse it. The goal: selecting the third mode posts `sandbox:"workspace-write"` + `self_verify:true`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: FAIL (no third option / `self_verify` not sent).

- [ ] **Step 4: Implement in `NewTaskForm.tsx`**

Add the third `<option>` to the mode select:
```tsx
        <select aria-label="Modo" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="read-only">Analizar (read-only)</option>
          <option value="workspace-write">Implementar (workspace-write)</option>
          <option value="workspace-write-verify">Implementar + auto-fix (verify)</option>
        </select>
```

Change `onSubmit` to map the UI mode to the API body:
```ts
      const body =
        mode === "workspace-write-verify"
          ? { project, agent, instructions, sandbox: "workspace-write", self_verify: true }
          : { project, agent, instructions, sandbox: mode };
      const { id } = await createTask(body);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: PASS (existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/ui/api.ts dashboard/src/ui/components/NewTaskForm.tsx dashboard/src/ui/components/NewTaskForm.test.tsx
git commit -m "feat(dashboard): auto-fix (verify) dispatch option"
```

---

## Task 7: Document + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README section**

Add near the self-verify / workspace-write docs (match the README heading style):

```markdown
### Auto-fix loop (opt-in)

A workspace-write task can be dispatched in "Implementar + auto-fix (verify)" mode. In this mode the
agent is given a Bash tool restricted by an exact-match allowlist: it may run ONLY the project's
declared verify commands (from `registry/projects.yml`), so it can run tests/typecheck during its turn,
see failures, and fix its edits before finishing. Any other shell command is denied by the runner's
`canUseTool` policy. This is the one place the "agent never runs shell" rule is relaxed, and only under
this explicit per-task opt-in. read-only and plain workspace-write tasks never get shell. The runner
still runs verification after the commit (see Self-verify) as the authoritative pass/fail record.
```

- [ ] **Step 2: Full suite**

Run: `pnpm test`
Expected: all tests pass (prior 107 + the new claude/agent-prompt/dispatch/run-task/NewTaskForm tests).

- [ ] **Step 3: Type-check + build**

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the agent auto-fix loop"
```

---

## Self-Review (plan vs. spec)

**Spec coverage:**
- §5 `self_verify` type + schema → Task 1. `claude.ts` (3rd mode, VERIFY_TOOLS, verifyCommands, gating,
  maxTurns) → Task 2. `agent-prompt.ts` verify branch → Task 3. `dispatch.ts` + `index.ts` → Task 4.
  `run-task.ts` derivation → Task 5. `api.ts` + `NewTaskForm.tsx` → Task 6. README → Task 7. ✅
- §9 testing → claude (gating), dispatch (validation), agent-prompt (verify prompt), run-task
  (derivation), NewTaskForm (dispatch body) all have tasks. ✅
- §7 safety → exact-match gating (Task 2), opt-in only (Tasks 4/5), read-only & plain write unchanged
  (Task 2 test asserts plain write still denies Bash). ✅

**Type consistency:** `RunMode` value `"workspace-write-verify"` is identical across Tasks 2/3/5.
`RunOptions.verifyCommands?: string[]` (Task 2) matches the run-task call (Task 5) and tests.
`buildSystemPrompt(agent, agentsMd, mode, verifyCommands)` signature (Task 3) matches the run-task call
(Task 5). `TaskEnvelope.self_verify?: boolean` (Task 1) matches dispatch (Task 4) and run-task (Task 5).
`createTask` body `self_verify?` (Task 4 server, Task 6 client) consistent. ✅

**Placeholder scan:** No TBD/TODO; every code step has full code. The dispatch/NewTaskForm test steps say
"reuse the existing setup/constants" because they extend existing test files — concrete assertions and
bodies are provided; the implementer adapts to the file's fixtures. ✅
