import { throws } from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTask } from "../dashboard/src/server/dispatch";
import { assertContextConfig } from "../lib/context/validation";
import { readTaskEvents } from "../lib/state/events";
import { eventsDir, tasksDir } from "../lib/state/paths";
import { readTask } from "../lib/state/store";
import type { AgentEventSink, AgentExecutor, AgentRunResult, AgentUsage } from "../runner/agent-executor";
import { codexExecutor } from "../runner/codex-executor";
import { runTask, type TaskRunCompletion } from "../runner/run-task";
import { TaskControlError, TaskOrchestrator } from "../runner/task-orchestrator";
import { captureVerification, runVerification } from "../runner/verify";
import { commitAndDiff, createWorktree } from "../runner/worktree";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const { forbiddenEffect } = vi.hoisted(() => ({
  forbiddenEffect: () => { throw new Error("Unexpected external effect in the execution budget EVAL."); },
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

const budget = { max_attempts: 2, max_runtime_ms: 1_000, max_total_tokens: 10 };
const threadId = "synthetic-thread";
const turnId = "synthetic-turn";
type Fixture = ReturnType<typeof createRolePolicyFixture>;

function setupTask(fixture: Fixture) {
  const role = fixture.readRoles().roles.find(({ id }) => id === roleFixtureRole);
  if (!role) throw new Error("The fixture logical role is missing.");
  const configPath = join(fixture.root, "registry", "context-policy.yml");
  const config: unknown = parse(readFileSync(configPath, "utf8"));
  assertContextConfig(config);
  config.budgets[role.default_budget_policy_id] = { ...budget };
  writeFileSync(configPath, stringify(config));

  const context = createContextService(fixture.root);
  const request = {
    project: roleFixtureProject, agent: roleFixtureAgent, role_id: roleFixtureRole,
    instructions: "Inspect the synthetic project.",
  };
  const preview = context.preview({ ...request, kind: "analysis" });
  expect(preview).toMatchObject({ allowed: true, manifest: { budget, sandbox: "read-only" } });
  const { id } = createTask({ ...request, preview_fingerprint: preview.fingerprint }, fixture.root, undefined, { context });
  expect(readTask(id)).toMatchObject({
    lifecycle: "queued",
    envelope: {
      context_admission: { schema_version: 1, kind: "analysis", manifest_fingerprint: preview.fingerprint },
      context_manifest: { budget },
    },
    orchestration: { ...budget, attempts: 0, cumulative_tokens: 0, lease: null },
  });
  return id;
}

interface BudgetRun {
  id: string;
  state: string;
  worker: TaskOrchestrator;
  run: ReturnType<typeof vi.fn<AgentExecutor["run"]>>;
  attempts: Array<{ runId: string; completion: Promise<TaskRunCompletion | null> }>;
}

async function withBudgetRun(execute: AgentExecutor["run"], check: (budgetRun: BudgetRun) => Promise<void>) {
  const fixture = createRolePolicyFixture();
  const attempts: BudgetRun["attempts"] = [];
  const run = vi.fn<AgentExecutor["run"]>(execute);
  const worker = new TaskOrchestrator({
    repoRoot: fixture.root,
    runAttempt(taskId, options) {
      if (!options.runId) throw new Error("The scheduler did not supply an owned run ID.");
      const completion = runTask(taskId, fixture.root, { run }, options);
      attempts.push({ runId: options.runId, completion });
      return completion;
    },
  });
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
  try {
    for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
    vi.stubEnv("SURTEC_TASK_MAX_ATTEMPTS", "3");
    vi.stubEnv("SURTEC_TASK_MAX_RUNTIME_MS", "300000");
    vi.stubEnv("SURTEC_TASK_MAX_TOTAL_TOKENS", "200000");
    const inventory = readdirSync(fixture.checkout, { recursive: true }).sort();
    const primerPath = join(fixture.checkout, "AGENTS.md");
    const primer = readFileSync(primerPath);
    const id = setupTask(fixture);

    await check({ id, state: fixture.state, worker, run, attempts });

    expect(readdirSync(fixture.checkout, { recursive: true }).sort()).toEqual(inventory);
    expect(readFileSync(primerPath)).toEqual(primer);
    for (const effect of [codexExecutor.run, createWorktree, commitAndDiff, runVerification, captureVerification]) {
      expect(effect).not.toHaveBeenCalled();
    }
  } finally {
    try {
      await worker.stop();
      expect(worker.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      fixture.dispose();
    }
  }
}

function usage(totalTokens: number): AgentUsage {
  return { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens };
}

function reportUsage(events: AgentEventSink, tokens: number) {
  return events({ type: "usage", at: new Date().toISOString(), threadId, turnId, usage: usage(tokens) });
}

function completed(tokens: number): AgentRunResult {
  const report = {
    status: "completed", summary: "Synthetic analysis completed.",
    commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [],
  };
  return { finalText: JSON.stringify(report), structuredOutput: report, threadId, turnId, usage: usage(tokens) };
}

function abortError(signal: AbortSignal): Error {
  const error = new Error(String(signal.reason));
  error.name = "AbortError";
  return error;
}

async function settleLatest({ worker, attempts }: BudgetRun) {
  const latest = attempts.at(-1);
  if (!latest) throw new Error("The scheduler has not launched an attempt.");
  const result = await latest.completion;
  await worker.stop();
  expect(worker.activeCount).toBe(0);
  return { result, runId: latest.runId };
}

function expectBudgetFailure({ id }: BudgetRun, runId: string, reason: string, tokens: number) {
  expect(readTask(id)).toMatchObject({
    lifecycle: "finished", outcome: "failed", result: { status: "failed", blockers: [reason] },
    orchestration: {
      attempts: 1, cumulative_tokens: tokens, lease: null, retry_at: null,
      last_failure: { kind: "budget", run_id: runId, message: reason },
    },
  });
  const events = readTaskEvents(id);
  expect(events.filter(({ type }) => type === "claimed")).toMatchObject([{ run_id: runId, attempt: 1 }]);
  expect(events.filter(({ type }) => type === "failed")).toMatchObject([
    { run_id: runId, attempt: 1, payload: { outcome: "failed", retryable: false, reason } },
  ]);
  expect(events.some(({ type }) => type === "retry-scheduled")).toBe(false);
}

function expectManualRetryDenied({ id, state, worker }: BudgetRun, dimension: "token" | "attempt") {
  const taskPath = join(tasksDir(state), `${id}.json`);
  const eventPath = join(eventsDir(state), `${id}.jsonl`);
  const taskBytes = readFileSync(taskPath);
  const eventBytes = readFileSync(eventPath);
  throws(() => worker.retry(id), (error: unknown) => error instanceof TaskControlError && error.status === 409
    && error.message === `task ${dimension} budget is exhausted: ${id}`);
  expect(readFileSync(taskPath)).toEqual(taskBytes);
  expect(readFileSync(eventPath)).toEqual(eventBytes);
}

describe("org.execution.budget-overrun", () => {
  it("accepts the exact token cap and debits reported usage once", async () => {
    await withBudgetRun(async (_input, events, signal) => {
      await reportUsage(events, budget.max_total_tokens);
      expect(signal.aborted).toBe(false);
      return completed(budget.max_total_tokens);
    }, async (fixture) => {
      expect(await fixture.worker.runOnce()).toBe(1);
      const { result, runId } = await settleLatest(fixture);
      expect(result).toMatchObject({ outcome: "completed", retryable: false, stale: false });
      expect(fixture.run).toHaveBeenCalledOnce();
      expect(readTask(fixture.id)).toMatchObject({
        lifecycle: "finished", outcome: "completed",
        orchestration: { attempts: 1, cumulative_tokens: 10, lease: null, last_failure: null },
      });
      expect(readTaskEvents(fixture.id).filter(({ type }) => ["claimed", "usage", "completed"].includes(type))).toMatchObject([
        { type: "claimed", run_id: runId, attempt: 1 },
        { type: "usage", run_id: runId, payload: { delta_tokens: 10, cumulative_tokens: 10 } },
        { type: "completed", run_id: runId, attempt: 1 },
      ]);
    });
  });

  it("aborts on token overrun, retains all observed usage and denies retry", async () => {
    await withBudgetRun(async (_input, events, signal) => {
      await reportUsage(events, 9);
      expect(signal.aborted).toBe(false);
      await reportUsage(events, 9);
      expect(signal.aborted).toBe(false);
      await reportUsage(events, 11);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ message: "task token budget exhausted" });
      throw abortError(signal);
    }, async (fixture) => {
      const reason = "token budget exhausted (10)";
      expect(await fixture.worker.runOnce()).toBe(1);
      const { result, runId } = await settleLatest(fixture);
      expect(result).toMatchObject({ outcome: "failed", retryable: false, stale: false, reason });
      expect(await fixture.worker.runOnce()).toBe(0);
      expect(fixture.run).toHaveBeenCalledOnce();
      expectBudgetFailure(fixture, runId, reason, 11);
      expect(readTaskEvents(fixture.id).filter(({ type }) => type === "usage")).toMatchObject([
        { run_id: runId, payload: { delta_tokens: 9, cumulative_tokens: 9 } },
        { run_id: runId, payload: { delta_tokens: 2, cumulative_tokens: 11 } },
      ]);
      expectManualRetryDenied(fixture, "token");
    });
  });

  it("aborts at the runtime deadline without an automatic retry", async () => {
    let executorSignal: AbortSignal | undefined;
    let abortedAt: number | undefined;
    await withBudgetRun((_input, _events, signal) => {
      executorSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortedAt = Date.now();
          reject(abortError(signal));
        }, { once: true });
      });
    }, async (fixture) => {
      const reason = "runtime budget exhausted (1000ms)";
      const start = Date.now();
      expect(await fixture.worker.runOnce()).toBe(1);
      expect(fixture.run).toHaveBeenCalledOnce();
      if (!executorSignal) throw new Error("The fake executor has not started.");
      await vi.advanceTimersByTimeAsync(budget.max_runtime_ms - 1);
      expect(executorSignal.aborted).toBe(false);
      expect(abortedAt).toBeUndefined();
      expect(readTask(fixture.id)?.lifecycle).toBe("running");

      await vi.advanceTimersByTimeAsync(1);
      expect(executorSignal.aborted).toBe(true);
      expect(executorSignal.reason).toMatchObject({ message: "task runtime budget exhausted" });
      expect(abortedAt).toBe(start + budget.max_runtime_ms);
      const { result, runId } = await settleLatest(fixture);
      expect(result).toMatchObject({ outcome: "failed", retryable: false, stale: false, reason });
      expect(await fixture.worker.runOnce()).toBe(0);
      expect(fixture.run).toHaveBeenCalledOnce();
      expectBudgetFailure(fixture, runId, reason, 0);
    });
  });

  it("retries a transient failure once and denies a third attempt", async () => {
    const reason = "Synthetic transient executor failure.";
    await withBudgetRun(async () => { throw new Error(reason); }, async (fixture) => {
      expect(await fixture.worker.runOnce()).toBe(1);
      const first = await settleLatest(fixture);
      expect(first.result).toMatchObject({ outcome: "failed", retryable: true, stale: false, reason });
      const queued = readTask(fixture.id);
      expect(queued).toMatchObject({
        lifecycle: "queued", orchestration: { attempts: 1, lease: null, last_failure: { kind: "transient", run_id: first.runId } },
      });
      const retryAt = queued?.orchestration?.retry_at;
      if (!retryAt) throw new Error("The scheduler did not persist the expected retry time.");
      expect(Date.parse(retryAt)).toBeGreaterThan(Date.now());
      expect(await fixture.worker.runOnce()).toBe(0);
      vi.setSystemTime(new Date(retryAt));

      expect(await fixture.worker.runOnce()).toBe(1);
      const second = await settleLatest(fixture);
      expect(second.result).toMatchObject({ outcome: "failed", retryable: true, stale: false, reason });
      expect(second.runId).not.toBe(first.runId);
      expect(await fixture.worker.runOnce()).toBe(0);
      expect(fixture.run).toHaveBeenCalledTimes(2);
      expect(readTask(fixture.id)).toMatchObject({
        lifecycle: "finished", outcome: "failed",
        orchestration: {
          attempts: budget.max_attempts, cumulative_tokens: 0, lease: null, retry_at: null,
          last_failure: { kind: "transient", message: reason, run_id: second.runId },
        },
      });
      expect(readTaskEvents(fixture.id).filter(({ type }) => ["claimed", "failed", "retry-scheduled"].includes(type))).toMatchObject([
        { type: "claimed", run_id: first.runId, attempt: 1 },
        { type: "failed", run_id: first.runId, attempt: 1, payload: { reason } },
        { type: "retry-scheduled", run_id: first.runId, attempt: 1, payload: { retry_at: retryAt } },
        { type: "claimed", run_id: second.runId, attempt: 2 },
        { type: "failed", run_id: second.runId, attempt: 2, payload: { reason } },
      ]);
      expectManualRetryDenied(fixture, "attempt");
    });
  });
});
