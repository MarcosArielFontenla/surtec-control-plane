import { throws } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ContextPreviewError, createContextService } from "../dashboard/src/server/context-service";
import { createTask } from "../dashboard/src/server/dispatch";
import { PolicyError, PolicyService } from "../lib/policy/service";
import { readTaskEvents } from "../lib/state/events";
import { listTasks, readTask } from "../lib/state/store";
import type { AgentExecutor } from "../runner/agent-executor";
import { codexExecutor } from "../runner/codex-executor";
import { runTask } from "../runner/run-task";
import { captureVerification, runVerification } from "../runner/verify";
import { commitAndDiff, createWorktree } from "../runner/worktree";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const { forbiddenEffect } = vi.hoisted(() => ({
  forbiddenEffect: () => { throw new Error("Unexpected execution effect in the role EVAL."); },
}));
vi.mock("../runner/codex-executor", () => ({ codexExecutor: { run: vi.fn(forbiddenEffect) } }));
vi.mock("../runner/worktree", async (original) => ({
  ...await original<typeof import("../runner/worktree")>(),
  createWorktree: vi.fn(forbiddenEffect),
  commitAndDiff: vi.fn(forbiddenEffect),
}));
vi.mock("../runner/verify", async (original) => ({
  ...await original<typeof import("../runner/verify")>(),
  runVerification: vi.fn(forbiddenEffect),
  captureVerification: vi.fn(forbiddenEffect),
}));

const analysis = {
  project: roleFixtureProject,
  agent: roleFixtureAgent,
  instructions: "Inspect the synthetic project.",
};
const roleId = roleFixtureRole;
const selection = { project: analysis.project, agent: analysis.agent, roleId, taskKind: "analysis", sandbox: "read-only", selfVerify: false } as const;
let fixture: ReturnType<typeof createRolePolicyFixture> | undefined;
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  fixture = createRolePolicyFixture();
  root = fixture.root;
  for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const owned = fixture;
  fixture = undefined;
  owned?.dispose();
});

function queueAnalysis() {
  const context = createContextService(root);
  const request = { ...analysis, role_id: roleId };
  const preview = context.preview({ ...request, kind: "analysis" });
  expect(preview).toMatchObject({ allowed: true, manifest: { role_id: roleId, sandbox: "read-only" } });
  const { id } = createTask({ ...request, preview_fingerprint: preview.fingerprint }, root, undefined, { context });
  const task = readTask(id);
  expect(task).toMatchObject({
    lifecycle: "queued",
    envelope: {
      context_manifest: { fingerprint: preview.fingerprint, role_id: roleId, agent_id: analysis.agent },
      context_admission: { schema_version: 1, kind: "analysis", manifest_fingerprint: preview.fingerprint },
    },
  });
  if (!task) throw new Error("Queued role EVAL task is missing.");
  return task;
}

function fakeExecutor() {
  const report = {
    status: "completed", summary: "Synthetic analysis completed.",
    commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [],
  };
  return { run: vi.fn<AgentExecutor["run"]>().mockResolvedValue({
    finalText: JSON.stringify(report),
    structuredOutput: report,
    threadId: "fixture-thread",
    turnId: "fixture-turn",
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 },
  }) };
}

function expectNoExternalEffects() {
  for (const effect of [codexExecutor.run, createWorktree, commitAndDiff, runVerification, captureVerification]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

function isDisallowedRole(error: unknown): boolean {
  return error instanceof PolicyError && error.code === "denied" && error.message === "Role does not permit this agent or task kind";
}

describe("org.execution.permitted-role", () => {
  it("runs an admitted permitted role once through the read-only fake executor", async () => {
    const task = queueAnalysis();
    const executor = fakeExecutor();
    expect(await runTask(task.envelope.id, root, executor)).toMatchObject({ outcome: "completed", retryable: false, stale: false });
    expect(executor.run).toHaveBeenCalledOnce();
    expect(executor.run.mock.calls[0][0]).toMatchObject({ mode: "read-only", verifyCommands: [] });
    expect(readTask(task.envelope.id)).toMatchObject({ lifecycle: "finished", outcome: "completed" });
    expectNoExternalEffects();
  });

  it("rejects an omitted logical role before task admission", () => {
    const context = createContextService(root);
    throws(() => context.preview({ ...analysis, kind: "analysis" }),
      (error: unknown) => error instanceof ContextPreviewError && error.status === 400 && error.message === "Invalid context preview identity");
    expect(listTasks()).toEqual([]);
    expectNoExternalEffects();
  });

  it("denies an unknown logical role before task admission", () => {
    const context = createContextService(root);
    throws(() => context.preview({ ...analysis, kind: "analysis", role_id: "unknown-fixture-role" }),
      (error: unknown) => error instanceof PolicyError && error.code === "denied" && error.message === "Unknown logical role");
    expect(listTasks()).toEqual([]);
    expectNoExternalEffects();
  });

  it("stops a queued task when the current role no longer permits its agent", async () => {
    const task = queueAnalysis();
    const taskId = task.envelope.id;
    if (!fixture) throw new Error("The owned role fixture is missing.");
    const roles = fixture.readRoles();
    const role = roles.roles.find((entry) => entry.id === roleId);
    if (!role || !role.agent_ids.includes(analysis.agent)) throw new Error("Role fixture cannot revoke the admitted agent.");
    role.agent_ids = role.agent_ids.filter((agent) => agent !== analysis.agent);
    writeFileSync(fixture.rolesPath, stringify(roles));

    const policy = new PolicyService(root);
    expect(policy.authorizeDispatch(selection)).toMatchObject({ project: { id: analysis.project }, agent: { id: analysis.agent } });
    throws(() => policy.authorizeRole(selection), isDisallowedRole);
    const authorizeRole = vi.spyOn(PolicyService.prototype, "authorizeRole");
    const executor = fakeExecutor();

    expect(await runTask(taskId, root, executor)).toMatchObject({
      outcome: "needs-review", retryable: false, stale: false,
      reason: "Governed execution context is missing, changed or no longer authorized; a new confirmed task is required",
    });
    expect(authorizeRole).toHaveBeenCalledWith(selection);
    expect(authorizeRole.mock.results).toEqual([expect.objectContaining({ type: "throw" })]);
    expect(isDisallowedRole(authorizeRole.mock.results[0].value)).toBe(true);
    expect(executor.run).not.toHaveBeenCalled();
    expectNoExternalEffects();
    const saved = readTask(taskId);
    expect(saved).toMatchObject({
      lifecycle: "finished", outcome: "needs-review", result: { status: "needs-review" },
      orchestration: { lease: null, last_failure: { kind: "terminal" } },
      envelope: { context_manifest: task.envelope.context_manifest, context_admission: task.envelope.context_admission },
    });
    const runMetadata = saved?.envelope.metadata.run ?? {};
    for (const key of ["thread_id", "turn_id", "worktree_path"]) expect(runMetadata).not.toHaveProperty(key);
    expect(readTaskEvents(taskId).at(-1)?.type).toBe("needs-review");
  });
});
