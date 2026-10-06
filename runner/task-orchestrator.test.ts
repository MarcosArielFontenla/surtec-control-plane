import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode, TaskRecord } from "../lib/state/types";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { readTask, updateTask, writeTask } from "../lib/state/store";
import * as taskStore from "../lib/state/store";
import { readTaskEvents } from "../lib/state/events";
import { assertTaskOutsideActiveWorkflow, BudgetExecutionScaffold, budgetExecutionOwner, TaskControlError, TaskOrchestrator } from "./task-orchestrator";
import type { TaskRunCompletion, TaskRunOptions } from "./run-task";
import type { AgentExecutor } from "./agent-executor";
import { assembleContext, contextHash } from "../lib/context/assemble";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { mutateWorkflowDocument } from "../lib/state/workflows";
import { prepareTaskBudgetAdmission } from "../dashboard/src/server/dispatch";
import { mutateBudgetLedger, readBudgetLedger } from "../lib/state/budgets";
import { commitTaskBudget, reserveTaskBudget } from "../lib/budgets/reservations";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../lib/budgets/types";
import type { BudgetPolicySource } from "../lib/budgets/policy";

function record(id: string, sandbox: SandboxMode = "read-only", project = "p", order = 0): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project, task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
      agent: "agent", title: id, instructions: "work", repo_path: "C:/repo", branch: `agent/${id}`,
      sandbox, expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: `2026-09-21T10:00:0${order}Z`, started_at: null,
    updated_at: `2026-09-21T10:00:0${order}Z`, finished_at: null,
    result: null, logs_path: null, revision: 1, orchestration: defaultTaskOrchestration(),
  };
}

function admittedRecord(id: string, workflow = false): TaskRecord {
  const task = record(id), budget = task.orchestration!;
  task.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: "p", agent_id: "agent", role_id: "planner", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: [],
    budget: { max_attempts: budget.max_attempts, max_runtime_ms: budget.max_runtime_ms, max_total_tokens: budget.max_total_tokens }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["Unavailable"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional fixture"], requires_red_evidence: false } },
  [{ id: "runtime/safety", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
  const binding = { manifest_fingerprint: task.envelope.context_manifest.fingerprint, instructions_length: 4, instructions_hash: contextHash("work") };
  task.envelope.context_admission = workflow ? { ...binding, schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: "analysis", task_id: id, template_id: "analysis", template_version: 1,
    grant_id: "grant-1", authority_revision: 1, role_id: "planner", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, scope_fingerprint: "a".repeat(64), approved_plan: null, predecessor_stage_id: null, handoff_id: null, candidate: null }
    : { ...binding, schema_version: 1, kind: "analysis" };
  return task;
}

function retainTask(taskId: string): void {
  const at = "2026-10-04T00:00:00Z", hash = "a".repeat(64), budget = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
  mutateWorkflowDocument((d) => {
    d.grants["grant-1"] = { schema_version: 1, id: "grant-1", workflow_id: "workflow-1", project_id: "p", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "analysis", template_version: 1,
      authorized_scope: { expected_outcome: "Inspect synthetic evidence", acceptance_criteria: ["Evidence retained"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] }, role_assignments: [{ role_id: "planner", agent_id: "agent", sandbox: "read-only", client_context_categories: [] }], permitted_stage_kinds: ["analysis"], source_fingerprints: [{ id: "safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional", budget, correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: "synthetic-only", approved_at: at };
    d.workflows["workflow-1"] = { schema_version: 1, id: "workflow-1", revision: 1, project_id: "p", issue_id: "issue-1", scope_revision: 1, template_id: "analysis", template_version: 1, status: "running", work_scale: "bounded", current_grant_id: "grant-1", authority_revision: 1, stage_ids: ["stage-1"], current_stage_id: "stage-1", pending_decision_id: null, lineage_id: null, candidate: null, approved_plan: null, review_policy: null, budget, counters: { tasks: 1, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Inspect retained evidence", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null };
    d.stages["stage-1"] = { schema_version: 1, id: "stage-1", workflow_id: "workflow-1", grant_id: "grant-1", authority_revision: 1, generation: 1, ordinal: 1, kind: "analysis", role_id: "planner", agent_id: "agent", sandbox: "read-only", status: "reserved", phase: "execution", task_id: taskId, execution_id: null, predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output: null, output_fingerprint: null, candidate: null, context_fingerprint: hash, created_at: at, updated_at: at };
    d.admission_intents["intent-1"] = { schema_version: 1, id: "intent-1", workflow_id: "workflow-1", stage_id: "stage-1", grant_id: "grant-1", authority_revision: 1, task_id: taskId, status: "reserved", expected_issue_revision: 1, expected_workflow_revision: 1, context_fingerprint: hash, blocked_reason: null, created_at: at, updated_at: at };
  });
}

interface PendingRun {
  id: string;
  options: TaskRunOptions;
  resolve: (completion: TaskRunCompletion) => void;
}

function controlledRunner(): {
  run: ReturnType<typeof vi.fn<(id: string, options: TaskRunOptions) => Promise<TaskRunCompletion>>>;
  pending: PendingRun[];
  finish: (id: string, completion?: TaskRunCompletion) => void;
} {
  const pending: PendingRun[] = [];
  const run = vi.fn((id: string, options: TaskRunOptions) => new Promise<TaskRunCompletion>((resolve) => {
    pending.push({ id, options, resolve });
  }));
  const finish = (id: string, completion: TaskRunCompletion = { outcome: "completed", retryable: false, stale: false }) => {
    const item = pending.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`no pending run: ${id}`);
    updateTask(id, (task) => {
      task.lifecycle = "finished";
      task.outcome = completion.outcome;
      task.finished_at = new Date().toISOString();
      task.orchestration!.lease = null;
    });
    item.resolve(completion);
  };
  return { run, pending, finish };
}

describe("TaskOrchestrator", () => {
  let root: string;
  let nowMs: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-orchestrator-"));
    process.env.SURTEC_STATE_DIR = join(root, "state");
    nowMs = Date.parse("2026-09-21T10:00:00Z");
  });

  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_PROJECTS_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces the global concurrency bound", async () => {
    writeTask(record("T-1", "read-only", "p1", 1));
    writeTask(record("T-2", "read-only", "p2", 2));
    writeTask(record("T-3", "read-only", "p3", 3));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ maxConcurrent: 2, now: () => new Date(nowMs), runAttempt: controlled.run });

    expect(await worker.runOnce()).toBe(2);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["T-1", "T-2"]);
    expect(await worker.runOnce()).toBe(0);

    controlled.finish("T-1");
    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("finished"));
    expect(await worker.runOnce()).toBe(1);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["T-1", "T-2", "T-3"]);
    controlled.finish("T-2");
    controlled.finish("T-3");
  });

  it("serializes writes per project while allowing read-only work", async () => {
    writeTask(record("W-1", "workspace-write", "same", 1));
    writeTask(record("W-2", "workspace-write", "same", 2));
    writeTask(record("R-1", "read-only", "same", 3));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ maxConcurrent: 3, now: () => new Date(nowMs), runAttempt: controlled.run });

    expect(await worker.runOnce()).toBe(2);
    expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["W-1", "R-1"]);
    expect(readTask("W-2")?.lifecycle).toBe("queued");

    controlled.finish("W-1");
    await vi.waitFor(() => expect(readTask("W-1")?.lifecycle).toBe("finished"));
    expect(await worker.runOnce()).toBe(1);
    expect(controlled.run.mock.calls.at(-1)?.[0]).toBe("W-2");
    controlled.finish("R-1");
    controlled.finish("W-2");
  });
  it("adding workflow reconciliation does not add a scheduler or weaken generic project-writer capacity", async () => {
    writeTask(record("W-1", "workspace-write", "same", 1)); writeTask(record("W-2", "workspace-write", "same", 2)); writeTask(record("R-1", "read-only", "same", 3));
    const controlled = controlledRunner(), workflows = new WorkflowOrchestrator(root), worker = new TaskOrchestrator({ repoRoot: root, workflows, maxConcurrent: 2, now: () => new Date(nowMs), runAttempt: controlled.run });
    expect(await worker.runOnce()).toBe(2); expect(controlled.run.mock.calls.map(([id]) => id)).toEqual(["W-1", "R-1"]); expect(await worker.runOnce()).toBe(0);
    controlled.finish("W-1"); controlled.finish("R-1"); await worker.stop();
    expect(await worker.runOnce()).toBe(1); expect(controlled.run.mock.calls.at(-1)?.[0]).toBe("W-2"); controlled.finish("W-2"); await worker.stop();
    expect(existsSync(join(root, "state/workflows/workflows.json"))).toBe(false);
  });

  it("cancels queued work durably without launching it", () => {
    writeTask(record("T-1"));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlled.run });

    const cancelled = worker.cancel("T-1");

    expect(cancelled).toMatchObject({ lifecycle: "finished", outcome: "cancelled", result: { status: "cancelled" } });
    expect(controlled.run).not.toHaveBeenCalled();
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["cancel-requested", "cancelled"]);
  });

  it("persists running cancellation before aborting the active signal", async () => {
    writeTask(record("T-1"));
    const signals: AbortSignal[] = [];
    const run = vi.fn((id: string, options: TaskRunOptions) => new Promise<TaskRunCompletion>((resolve) => {
      signals.push(options.signal!);
      options.signal!.addEventListener("abort", () => {
        updateTask(id, (task) => {
          task.lifecycle = "finished";
          task.outcome = "cancelled";
          task.finished_at = new Date(nowMs).toISOString();
          task.orchestration!.lease = null;
        });
        resolve({ outcome: "cancelled", retryable: false, stale: false });
      }, { once: true });
    }));
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    await worker.runOnce();

    const requested = worker.cancel("T-1");

    expect(requested.orchestration?.cancel_requested_at).toBe("2026-09-21T10:00:00.000Z");
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(readTask("T-1")?.outcome).toBe("cancelled"));
  });

  it("schedules a bounded retry for a transient owned failure", async () => {
    writeTask(record("T-1"));
    const controlled = controlledRunner();
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), retryBaseMs: 100, runAttempt: controlled.run });
    await worker.runOnce();
    const pending = controlled.pending[0];
    updateTask("T-1", (task) => {
      task.lifecycle = "finished";
      task.outcome = "failed";
      task.finished_at = new Date(nowMs).toISOString();
      task.orchestration!.lease = null;
      task.orchestration!.last_failure = { kind: "transient", message: "runtime unavailable", at: new Date(nowMs).toISOString(), run_id: pending.options.runId! };
    });
    pending.resolve({ outcome: "failed", retryable: true, reason: "runtime unavailable", stale: false });

    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("queued"));
    expect(readTask("T-1")?.orchestration?.retry_at).toBe("2026-09-21T10:00:00.100Z");
    expect(await worker.runOnce()).toBe(0);
    nowMs += 100;
    expect(await worker.runOnce()).toBe(1);
    expect(readTask("T-1")?.orchestration?.attempts).toBe(2);
    controlled.finish("T-1");
  });

  it("recovers an expired lease without consuming another attempt", () => {
    const expired = record("T-1");
    expired.lifecycle = "running";
    expired.orchestration!.attempts = 1;
    expired.orchestration!.lease = {
      run_id: "run-old", worker_id: "worker-old",
      acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z",
    };
    writeTask(expired);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(worker.recoverExpiredLeases()).toBe(1);

    expect(readTask("T-1")).toMatchObject({ lifecycle: "queued", orchestration: { attempts: 1, lease: null, last_failure: { kind: "transient", run_id: "run-old" } } });
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["lease-recovered", "retry-scheduled"]);
  });

  it("fails an expired attempt when its attempt budget is exhausted", () => {
    const expired = record("T-1");
    expired.lifecycle = "running";
    expired.orchestration!.attempts = expired.orchestration!.max_attempts;
    expired.orchestration!.lease = {
      run_id: "run-old", worker_id: "worker-old",
      acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z",
    };
    writeTask(expired);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(worker.recoverExpiredLeases()).toBe(1);

    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "failed", orchestration: { last_failure: { kind: "budget" } } });
  });

  it("refuses legacy manual retries without inventing admission or changing persisted state", () => {
    const failed = record("T-1");
    failed.lifecycle = "finished";
    failed.outcome = "failed";
    failed.finished_at = "2026-09-21T09:00:00Z";
    failed.orchestration!.attempts = 1;
    writeTask(failed);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(() => worker.retry("T-1")).toThrow(/admitted context binding/);
    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "failed" });

    updateTask("T-1", (task) => {
      task.lifecycle = "finished";
      task.outcome = "failed";
      task.orchestration!.attempts = task.orchestration!.max_attempts;
    });
    expect(() => worker.retry("T-1")).toThrow(TaskControlError);
  });
  it("retains only a bounded redacted prior summary when manually retrying governed work", () => {
    const failed = record("GOV-1"); const budget = defaultTaskOrchestration();
    failed.envelope.context_manifest = assembleContext({
      schema_version: 1, project_id: "p", agent_id: "agent", role_id: "planner", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: [],
      budget: { max_attempts: budget.max_attempts, max_runtime_ms: budget.max_runtime_ms, max_total_tokens: budget.max_total_tokens },
      limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [],
      routing: { work_scale: "trivial", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["Unavailable"] } },
      testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional default"], requires_red_evidence: false },
    }, [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
    failed.envelope.context_admission = { schema_version: 1, kind: "analysis", manifest_fingerprint: failed.envelope.context_manifest.fingerprint, instructions_length: 4, instructions_hash: contextHash("work") };
    failed.lifecycle = "finished"; failed.outcome = "failed"; failed.orchestration!.attempts = 1;
    failed.result = { task_id: "GOV-1", agent: "agent", status: "failed", summary: "Summary ".repeat(400), files_changed: [], commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [], logs_path: "" };
    writeTask(failed); const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });
    const queued = worker.retry("GOV-1");
    expect(queued.lifecycle).toBe("queued"); expect(queued.result).toBeNull();
    expect((queued.envelope.metadata.run as { prior_summary: string }).prior_summary).toHaveLength(2000);
    updateTask("GOV-1", (task) => { task.lifecycle = "finished"; task.outcome = "failed"; task.orchestration!.cumulative_tokens = task.orchestration!.max_total_tokens; });
    expect(() => worker.retry("GOV-1")).toThrow(/token budget/);
  });

  it("requires issue-linked work to resume through the issue authorization workflow", () => {
    const failed = record("I-TASK-1", "workspace-write", "stock-control");
    failed.envelope.metadata.issue_id = "I-12345678-1234-1234-1234-123456789abc";
    failed.lifecycle = "finished";
    failed.outcome = "needs-review";
    writeTask(failed);
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: controlledRunner().run });

    expect(() => worker.retry("I-TASK-1")).toThrow(/resumed through the local issue workflow/i);
    expect(readTask("I-TASK-1")).toMatchObject({ lifecycle: "finished", outcome: "needs-review" });
  });

  it("denies durable stage ownership despite missing workflow metadata on a v1 task", () => {
    const task = admittedRecord("OWNED-1"); task.lifecycle = "finished"; task.outcome = "failed"; writeTask(task); retainTask("OWNED-1");
    const before = readFileSync(join(root, "state/tasks/OWNED-1.json")), worker = new TaskOrchestrator({ runAttempt: controlledRunner().run });
    expect(() => worker.retry("OWNED-1")).toThrow(/Active workflow/);
    expect(readFileSync(join(root, "state/tasks/OWNED-1.json"))).toEqual(before); expect(readTaskEvents("OWNED-1")).toEqual([]);
  });
  it.each(["queued", "running", "finished"] as const)("cannot claim, recover or manually retry a %s v2 task without a controller", async (lifecycle) => {
    const task = admittedRecord("V2-1", true); task.lifecycle = lifecycle;
    if (lifecycle === "finished") task.outcome = "failed";
    if (lifecycle === "running") { task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: "run-old", worker_id: "worker-old", acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z" }; }
    writeTask(task); const before = readFileSync(join(root, "state/tasks/V2-1.json")), run = controlledRunner().run, worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    expect(() => worker.retry("V2-1")).toThrow(/current controller/); expect(worker.recoverExpiredLeases()).toBe(0); expect(await worker.runOnce()).toBe(0);
    expect(run).not.toHaveBeenCalled(); expect(readFileSync(join(root, "state/tasks/V2-1.json"))).toEqual(before); expect(readTaskEvents("V2-1")).toEqual([]);
    expect(() => assertTaskOutsideActiveWorkflow(task)).toThrow(/ownership cannot be proven/);
  });
  it.each(["queued", "running", "finished"] as const)("does not generically claim/recover/retry retained %s legacy work", async (lifecycle) => {
    const task = record("OWNED-1"); task.lifecycle = lifecycle;
    if (lifecycle === "finished") { task.outcome = "failed"; task.orchestration!.last_failure = { kind: "transient", message: "Synthetic failure", at: new Date(nowMs).toISOString(), run_id: "run-old" }; }
    if (lifecycle === "running") task.orchestration!.lease = { run_id: "run-old", worker_id: "worker-old", acquired_at: "2026-09-21T09:00:00Z", heartbeat_at: "2026-09-21T09:00:00Z", expires_at: "2026-09-21T09:00:30Z" };
    writeTask(task); retainTask("OWNED-1"); const before = readFileSync(join(root, "state/tasks/OWNED-1.json")), run = controlledRunner().run, worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(0); expect(run).not.toHaveBeenCalled(); expect(readFileSync(join(root, "state/tasks/OWNED-1.json"))).toEqual(before); expect(readTaskEvents("OWNED-1")).toEqual([]);
  });
  it("fails closed on corrupt ownership before manual retry or scheduler effects", async () => {
    const task = admittedRecord("FREE-1"); task.lifecycle = "finished"; task.outcome = "failed"; writeTask(task);
    const path = join(root, "state/workflows/workflows.json"); mkdirSync(join(root, "state/workflows"), { recursive: true }); writeFileSync(path, "{");
    const run = controlledRunner().run, worker = new TaskOrchestrator({ runAttempt: run });
    expect(() => worker.retry("FREE-1")).toThrow(/ownership is unavailable/); expect(await worker.runOnce()).toBe(0); expect(run).not.toHaveBeenCalled(); expect(readTaskEvents("FREE-1")).toEqual([]); expect(readFileSync(path, "utf8")).toBe("{");
  });

  it("runs a claimed task through the real runner boundary with a fake executor", async () => {
    const projectsRoot = join(root, "projects");
    const projectPath = join(projectsRoot, "p");
    mkdirSync(join(projectPath, ".git"), { recursive: true });
    mkdirSync(join(root, "registry"), { recursive: true });
    process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
    writeFileSync(join(root, "AGENTS.md"), "Do not deploy.\n", "utf8");
    writeFileSync(join(root, "registry", "agents.yml"), "agents:\n  - id: agent\n    name: Agent\n    type: engineering\n    description: Works.\n    default_sandbox: read-only\n    allowed_task_types: [analysis]\n    requires_human_approval_for: [merge]\n", "utf8");
    writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  p:\n    allowed_agents: [agent]\n    sandbox:\n      default: read-only\n", "utf8");
    const queued = record("T-1");
    queued.envelope.repo_path = projectPath;
    writeTask(queued);
    const executor: AgentExecutor = {
      run: vi.fn().mockResolvedValue({
        finalText: JSON.stringify({ status: "completed", summary: "done", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] }),
        structuredOutput: { status: "completed", summary: "done", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] },
        threadId: "thread-1",
        turnId: "turn-1",
        usage: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 6 },
      }),
    };
    const worker = new TaskOrchestrator({ repoRoot: root, executor, maxConcurrent: 1, now: () => new Date(nowMs) });

    expect(await worker.runOnce()).toBe(1);
    await vi.waitFor(() => expect(readTask("T-1")?.lifecycle).toBe("finished"));

    expect(readTask("T-1")).toMatchObject({
      outcome: "completed",
      result: { summary: "done" },
      orchestration: { attempts: 1, cumulative_tokens: 6, lease: null },
    });
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["claimed", "started", "policy-evaluated", "usage", "completed"]);
  });
});

describe("T006 private budget execution scaffold", () => {
  let root: string, state: string, ledgerPath: string, nowMs: number;
  const source = (limits: Partial<Record<typeof BUDGET_DIMENSIONS[number], number>> = {}): BudgetPolicySource => ({
    fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
      rules: [{ id: "company-cap", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
        limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, limits[dimension] === undefined
          ? { status: "unconfigured" } : { status: "configured", hard_cap: limits[dimension] }])) as BudgetLimits }] } });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-budget-worker-")); state = join(root, "state"); ledgerPath = join(state, "budgets/budgets.json");
    vi.stubEnv("SURTEC_STATE_DIR", state); nowMs = Date.parse("2026-09-21T10:00:00Z");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); });
  function bind(id = "B-1", policy = source(), commit = true, attempts = 2) {
    const task = admittedRecord(id); task.orchestration!.max_runtime_ms = 2000; task.orchestration!.max_total_tokens = 10; task.orchestration!.max_attempts = attempts;
    const prepared = prepareTaskBudgetAdmission(task, { source: policy, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["p"],
      issue_id: null, role_id: "planner", execution_id: id } });
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source: policy }), ledgerPath, prepared.admission.created_at);
    writeTask(prepared.task);
    if (commit) mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: prepared.admission, persisted_admission: readTask(id)!.envelope.budget_admission }), ledgerPath, prepared.admission.created_at);
    return readTask(id)!;
  }
  function controller(policy = source()) { return new BudgetExecutionScaffold({ filePath: ledgerPath, now: () => new Date(nowMs), resolve: () => ({ source: policy }) }); }
  async function terminal(id: string, options: TaskRunOptions, tokens = 3, elapsed = 100, retryable = false) {
    const owner = budgetExecutionOwner(options.budgetExecution, id, options.runId!)!; expect(owner).not.toBeNull();
    const proof = options.budgetExecution!;
    owner.prepare(proof);
    updateTask(id, (task) => { task.orchestration!.cumulative_tokens += tokens; });
    await owner.observe(proof, tokens, elapsed, true);
    updateTask(id, (task) => {
      task.lifecycle = "finished"; task.outcome = retryable ? "failed" : "completed"; task.finished_at = new Date(nowMs).toISOString();
      task.orchestration!.lease = null;
      task.orchestration!.last_failure = retryable ? { kind: "transient", message: "Synthetic known transient", at: new Date(nowMs).toISOString(), run_id: options.runId! } : null;
    });
    const settled = await owner.settle(proof, tokens, elapsed, retryable); expect(settled.complete).toBe(true);
    return { outcome: retryable ? "failed" as const : "completed" as const, retryable, stale: false };
  }
  it.each(["queued", "running", "finished"] as const)("default worker denies bound %s history without rewriting facts", async (lifecycle) => {
    const task = bind(); task.lifecycle = lifecycle;
    if (lifecycle === "finished") { task.outcome = "failed"; task.orchestration!.last_failure = { kind: "transient", message: "Synthetic failure", at: task.created_at, run_id: "old" }; }
    if (lifecycle === "running") { task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: "old", worker_id: "old", acquired_at: task.created_at, heartbeat_at: task.created_at, expires_at: "2026-09-21T09:00:00Z" }; }
    writeTask(task); const bytes = readFileSync(join(state, "tasks/B-1.json")), ledger = readFileSync(ledgerPath), run = vi.fn();
    vi.stubEnv("SURTEC_BUDGET_CUTOVER", "1"); vi.stubEnv("SURTEC_BUDGET_EXECUTION", "1");
    const worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    expect(worker.recoverExpiredLeases()).toBe(0); expect(await worker.runOnce()).toBe(0); expect(() => worker.retry("B-1")).toThrow(/Budget-bound/);
    expect(run).not.toHaveBeenCalled(); expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(bytes); expect(readFileSync(ledgerPath)).toEqual(ledger); expect(readTaskEvents("B-1")).toEqual([]);
  });
  it("rejects caller-shaped controller and proof copies", () => {
    bind(); expect(() => new TaskOrchestrator({ budgets: {} as never })).toThrow(/Unrecognized/);
    expect(() => controller().prepare({})).toThrow(/unavailable/); expect(budgetExecutionOwner({}, "B-1", "fake")).toBeNull();
  });
  it.each(["recovery", "retry", "cancel"] as const)("locked reread refuses a binding inserted after the %s snapshot", (action) => {
    const task = bind(), admission = task.envelope.budget_admission!; delete task.envelope.budget_admission;
    task.lifecycle = action === "retry" ? "finished" : "running"; task.outcome = action === "retry" ? "failed" : null;
    task.orchestration!.attempts = 1; task.orchestration!.lease = action === "retry" ? null : { run_id: "old", worker_id: "old",
      acquired_at: task.created_at, heartbeat_at: task.created_at, expires_at: "2026-09-21T09:00:00Z" };
    writeTask(task); const original = taskStore.updateTask; let replaced = false, boundBytes: Buffer | undefined;
    vi.spyOn(taskStore, "updateTask").mockImplementation((id, mutate, directory) => {
      if (!replaced) { replaced = true; original(id, (current) => { current.envelope.budget_admission = admission; }, directory); boundBytes = readFileSync(join(state, `tasks/${id}.json`)); }
      return original(id, mutate, directory);
    });
    const run = vi.fn(), worker = new TaskOrchestrator({ now: () => new Date(nowMs), runAttempt: run });
    if (action === "recovery") expect(worker.recoverExpiredLeases()).toBe(0);
    else expect(() => action === "retry" ? worker.retry("B-1") : worker.cancel("B-1")).toThrow(/Budget-bound/);
    expect(replaced).toBe(true); expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(boundBytes); expect(readTaskEvents("B-1")).toEqual([]); expect(run).not.toHaveBeenCalled();
  });
  it.each(["accessor", "proxy", "extra"] as const)("refuses %s resolver data without invoking hooks or mutating stores", async (fault) => {
    bind(); const hook = vi.fn(), policy: Record<string, unknown> = { source: source() };
    if (fault === "accessor") Object.defineProperty(policy, "source", { enumerable: true, get: hook });
    if (fault === "extra") policy.cutover = true;
    const returned = fault === "proxy" ? new Proxy(policy, { get: hook, ownKeys: hook }) : policy;
    const budgets = new BudgetExecutionScaffold({ filePath: ledgerPath, now: () => new Date(nowMs), resolve: () => returned as never });
    const taskBytes = readFileSync(join(state, "tasks/B-1.json")), ledgerBytes = readFileSync(ledgerPath), run = vi.fn();
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(0); expect(hook).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(taskBytes); expect(readFileSync(ledgerPath)).toEqual(ledgerBytes);
  });
  it("keeps nonterminal unknown sticky after a valid final sample without releasing holds", async () => {
    bind(); const budgets = controller(), run = vi.fn(async (id: string, options: TaskRunOptions) => {
      const proof = options.budgetExecution!;
      expect(await budgets.observe(proof, null, 20)).toMatchObject({ unknown: true });
      expect(await budgets.observe(proof, 3, 100, true)).toMatchObject({ unknown: true });
      updateTask(id, (task) => { task.lifecycle = "finished"; task.outcome = "needs-review"; task.finished_at = new Date(nowMs).toISOString(); task.orchestration!.lease = null; task.orchestration!.cumulative_tokens = 3; });
      await expect(budgets.settle(proof, 3, 110, false)).rejects.toThrow(/unavailable/);
      return { outcome: "needs-review" as const, retryable: false, stale: false };
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run }); expect(await worker.runOnce()).toBe(1); await worker.stop();
    const ledger = readBudgetLedger(ledgerPath)!; expect(Object.values(ledger.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1, total_tokens: 10 } });
    expect(Object.values(ledger.charges)[0]).toMatchObject({ observed_total_tokens: 3, usage_state: "unknown" });
  });
  it("tightened persisted runtime stops later effects without increasing its admitted slice", async () => {
    bind(); const budgets = controller(), run = vi.fn(async (id: string, options: TaskRunOptions) => {
      const proof = options.budgetExecution!; updateTask(id, (task) => { task.orchestration!.max_runtime_ms = 1000; });
      expect(budgets.prepare(proof).maxRuntimeMs).toBe(1000);
      expect(await budgets.observe(proof, 3, 1500)).toMatchObject({ exhausted: true });
      expect(() => budgets.prepare(proof)).toThrow(/unavailable/);
      updateTask(id, (task) => { task.orchestration!.cumulative_tokens = 3; });
      await budgets.observe(proof, 3, 1510, true);
      updateTask(id, (task) => { task.lifecycle = "finished"; task.outcome = "failed"; task.finished_at = new Date(nowMs).toISOString(); task.orchestration!.lease = null; });
      expect(await budgets.settle(proof, 3, 1600, false)).toEqual({ complete: true, exhausted: true });
      return { outcome: "failed" as const, retryable: false, stale: false };
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run }); expect(await worker.runOnce()).toBe(1); await worker.stop();
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)[0]!.runtime_ms).toBe(1600); expect(run).toHaveBeenCalledOnce();
  });
  it("executes the final permitted attempt with exact private ownership and monotonic canonical usage", async () => {
    const policy = source({ attempts: 1, concurrent_reads: 1 }); bind("B-1", policy, true, 1); const budgets = controller(policy);
    const run = vi.fn(async (id: string, options: TaskRunOptions) => {
      const proof = options.budgetExecution!; expect(budgetExecutionOwner(proof, id, options.runId!)).toBe(budgets);
      expect(budgetExecutionOwner({ ...proof }, id, options.runId!)).toBeNull(); expect(budgetExecutionOwner(proof, "borrowed", options.runId!)).toBeNull();
      expect(budgets.prepare(proof)).toEqual({ maxRuntimeMs: 2000, maxTotalTokens: 10 });
      await budgets.observe(proof, 3, 20); await budgets.observe(proof, 3, 20); await budgets.observe(proof, 1, 10);
      return terminal(id, options, 3, 160);
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), maxConcurrent: 1, runAttempt: run });
    expect(await worker.runOnce()).toBe(1); await worker.stop(); expect(run).toHaveBeenCalledOnce();
    const ledger = readBudgetLedger(ledgerPath)!; expect(Object.values(ledger.charges)).toMatchObject([{ attempts: 1, runtime_ms: 160, observed_total_tokens: 3, status: "terminal" }]);
    expect(Object.values(ledger.reservations)).toMatchObject([{ status: "settled", held: { concurrent_reads: 0, total_tokens: 0 } }]);
    expect(await worker.runOnce()).toBe(0);
  });
  it.each(["pending", "policy-drift"] as const)("denies %s facts before task claim or execution", async (fault) => {
    const task = bind("B-1", source(), fault !== "pending"), bytes = readFileSync(join(state, "tasks/B-1.json")), before = readFileSync(ledgerPath);
    const changed = source(); if (fault === "policy-drift") changed.fingerprint = "b".repeat(64);
    const run = vi.fn(), worker = new TaskOrchestrator({ budgets: controller(changed), now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(0); expect(run).not.toHaveBeenCalled(); expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(bytes);
    expect(readFileSync(ledgerPath)).toEqual(before); expect(readTask(task.envelope.id)!.orchestration!.attempts).toBe(0); expect(readTaskEvents("B-1")).toEqual([]);
  });
  it("retains a charged cross-store revision gap without effects or automatic refund/replay", async () => {
    bind(); let first = true;
    const budgets = new BudgetExecutionScaffold({ filePath: ledgerPath, now: () => new Date(nowMs), resolve: () => {
      expect(existsSync(join(state, "locks/orchestrator-schedule.lock"))).toBe(false); expect(existsSync(join(state, "locks/budgets.lock"))).toBe(false);
      if (first) { first = false; updateTask("B-1", (task) => { task.updated_at = new Date(nowMs).toISOString(); }); }
      return { source: source() };
    } });
    const run = vi.fn(), worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(0); expect(run).not.toHaveBeenCalled(); expect(readTask("B-1")).toMatchObject({ lifecycle: "queued", orchestration: { attempts: 0, lease: null } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)).toMatchObject([{ status: "unknown", held: { concurrent_reads: 1, total_tokens: 10 } }]);
    const bytes = readFileSync(ledgerPath); expect(await worker.runOnce()).toBe(0); expect(readFileSync(ledgerPath)).toEqual(bytes);
  });
  it("two workers cannot spend the final worker slot or charge one task twice", async () => {
    bind(); const budgets = controller(), otherBudgets = controller(); let finish!: () => void;
    const run = vi.fn(async (id: string, options: TaskRunOptions) => { await new Promise<void>((resolve) => { finish = resolve; }); return terminal(id, options); });
    const first = new TaskOrchestrator({ budgets, maxConcurrent: 1, now: () => new Date(nowMs), runAttempt: run });
    const other = new TaskOrchestrator({ budgets: otherBudgets, maxConcurrent: 1, now: () => new Date(nowMs), runAttempt: run });
    try {
      expect(await first.runOnce()).toBe(1); expect(await other.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce(); expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1);
      finish(); await first.stop(); expect(await other.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce();
    } finally { await other.stop(); }
  });
  it.each([null, "foreign-lease", "revision-gap", "settle-lock"] as const)("keeps holds and proven facts on terminal fault %s", async (fault) => {
    bind(); const budgets = controller(); let proof: object | undefined;
    const run = vi.fn(async (id: string, options: TaskRunOptions) => {
      proof = options.budgetExecution!; await budgets.observe(proof, 3, 100);
      if (fault === "foreign-lease") {
        updateTask(id, (task) => { task.orchestration!.lease!.run_id = "foreign"; });
        await expect(budgets.observe(proof, 3, 110, true)).rejects.toThrow(/unavailable/); return null;
      }
      updateTask(id, (task) => { task.orchestration!.cumulative_tokens = 3; });
      await budgets.observe(proof, fault === null ? null : 3, 120, true);
      updateTask(id, (task) => { task.lifecycle = "finished"; task.outcome = "needs-review"; task.finished_at = new Date(nowMs).toISOString(); task.orchestration!.lease = null; });
      if (fault === "revision-gap") updateTask(id, (task) => { task.updated_at = new Date(nowMs).toISOString(); });
      if (fault === "settle-lock") writeFileSync(join(state, "locks/budgets.lock"), "synthetic unknown owner");
      if (fault === null) expect(await budgets.settle(proof, null, 130, false)).toMatchObject({ complete: false });
      else await expect(budgets.settle(proof, 3, 130, false)).rejects.toThrow(/unavailable/);
      return { outcome: "needs-review" as const, retryable: false, stale: false };
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(1); await worker.stop();
    const ledger = readBudgetLedger(ledgerPath)!, reservation = Object.values(ledger.reservations)[0]!;
    expect(reservation.held.concurrent_reads).toBe(1); expect(reservation.status).toBe(fault === "settle-lock" ? "active" : "unknown");
    expect(Object.values(ledger.charges)[0]!.observed_total_tokens).toBe(3); expect(budgetExecutionOwner(proof, "B-1", readTask("B-1")!.orchestration!.last_failure?.run_id ?? "unknown")).toBeNull();
    expect(await worker.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce();
  });
  it.each([false, true])("top-ups known retries without cumulative leaf runtime or duplicate token/slot holds parent=%s", async (parent) => {
    const policy = source(parent ? { runtime_ms: 2000 } : {}); bind("B-1", policy); const budgets = controller(policy), caps: number[] = [];
    const run = vi.fn(async (id: string, options: TaskRunOptions) => {
      caps.push(budgets.prepare(options.budgetExecution!).maxRuntimeMs);
      return terminal(id, options, run.mock.calls.length === 1 ? 2 : 3, run.mock.calls.length === 1 ? 1500 : parent ? 200 : 1500, run.mock.calls.length === 1);
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), retryBaseMs: 100, runAttempt: run });
    expect(await worker.runOnce()).toBe(1); await vi.waitFor(() => expect(readTask("B-1")!.lifecycle).toBe("queued"));
    const retained = Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]!; expect(retained.held).toMatchObject({ total_tokens: 8, concurrent_reads: 1, runtime_ms: 0 });
    nowMs += 100; expect(await worker.runOnce()).toBe(1); await worker.stop();
    expect(caps).toEqual([2000, parent ? 500 : 2000]); expect(readTask("B-1")!.orchestration).toMatchObject({ attempts: 2, cumulative_tokens: 5, max_runtime_ms: 2000 });
    const charges = Object.values(readBudgetLedger(ledgerPath)!.charges); expect(charges).toHaveLength(2); expect(charges.reduce((sum, charge) => sum + charge.runtime_ms, 0)).toBe(parent ? 1700 : 3000);
    expect(charges.reduce((sum, charge) => sum + charge.observed_total_tokens!, 0)).toBe(5); expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]!.status).toBe("settled");
  });
  it.each(["attempts", "tokens"] as const)("denies a known exhausted retry after current %s ceiling tightens without new charges", async (ceiling) => {
    bind(); const budgets = controller();
    const run = vi.fn(async (id: string, options: TaskRunOptions) => terminal(id, options, 2, 100, true));
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), retryBaseMs: 100, runAttempt: run });
    try {
      expect(await worker.runOnce()).toBe(1); await vi.waitFor(() => expect(readTask("B-1")!.lifecycle).toBe("queued"));
      updateTask("B-1", (task) => {
        if (ceiling === "attempts") task.orchestration!.max_attempts = 1;
        else task.orchestration!.max_total_tokens = 2;
      });
      const bytes = readFileSync(join(state, "tasks/B-1.json")), ledger = readFileSync(ledgerPath), events = readTaskEvents("B-1");
      expect(() => budgets.prepareClaim("B-1", "denied-new-run", "synthetic-worker")).toThrow(/unavailable/);
      nowMs += 100; expect(await worker.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce();
      expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(bytes); expect(readFileSync(ledgerPath)).toEqual(ledger);
      expect(readTaskEvents("B-1")).toEqual(events); expect(Object.values(readBudgetLedger(ledgerPath)!.charges)).toHaveLength(1);
      expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]!.status).toBe("active");
    } finally { await worker.stop(); }
  });
  it("retains a proven late receipt on foreign-worker ownership loss without foreign task progress", async () => {
    bind(); const budgets = controller(); let proof!: object, runId!: string, foreignBytes!: Buffer;
    const run = vi.fn(async (id: string, options: TaskRunOptions) => {
      proof = options.budgetExecution!; runId = options.runId!;
      updateTask(id, (task) => { task.orchestration!.lease!.worker_id = "foreign-worker"; });
      foreignBytes = readFileSync(join(state, "tasks/B-1.json"));
      await expect(budgets.observe(proof, 15, 100, true)).rejects.toThrow(/unavailable/);
      expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(foreignBytes);
      expect(budgetExecutionOwner(proof, id, runId)).toBeNull();
      const retained = readFileSync(ledgerPath);
      await expect(budgets.observe(proof, 999, 999, true)).rejects.toThrow(/unavailable/);
      expect(readFileSync(ledgerPath)).toEqual(retained);
      return null;
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(1); await worker.stop();
    expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(foreignBytes);
    expect(readTask("B-1")!.orchestration).toMatchObject({ cumulative_tokens: 0, lease: { worker_id: "foreign-worker", run_id: runId } });
    expect(Object.values(readBudgetLedger(ledgerPath)!.charges)[0]).toMatchObject({ run_id: runId, observed_total_tokens: 15, runtime_ms: 100, status: "running" });
    expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
    expect(await worker.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce();
  });
  it.each(["worker", "attempt"] as const)("unexpected failure and cancellation preserve a same-run foreign %s snapshot", async (changed) => {
    bind(); const budgets = controller(); let foreignBytes!: Buffer;
    const run = vi.fn(async (id: string) => {
      updateTask(id, (task) => {
        if (changed === "worker") task.orchestration!.lease!.worker_id = "foreign-worker";
        else task.orchestration!.attempts += 1;
      });
      foreignBytes = readFileSync(join(state, "tasks/B-1.json"));
      expect(() => worker.cancel(id)).toThrow(/Budget-bound/);
      throw new Error("Synthetic stale executor exception");
    });
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), runAttempt: run });
    expect(await worker.runOnce()).toBe(1); await worker.stop();
    expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(foreignBytes);
    expect(readTask("B-1")!.lifecycle).toBe("running"); expect(readTaskEvents("B-1").map((event) => event.type)).toEqual(["claimed"]);
    expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
  });
  it.each(["worker", "attempt"] as const)("heartbeat denies a same-run foreign %s inserted between its guard and locked mutation", async (changed) => {
    bind(); const budgets = controller(); let signal!: AbortSignal, foreignBytes!: Buffer, replaced = false;
    const run = vi.fn(async (_id: string, options: TaskRunOptions) => new Promise<null>((resolve) => {
      signal = options.signal!; signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), heartbeatMs: 10, runAttempt: run });
    try {
      expect(await worker.runOnce()).toBe(1); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      const original = taskStore.updateTask;
      vi.spyOn(taskStore, "updateTask").mockImplementation((id, mutate, directory) => {
        if (!replaced) {
          replaced = true;
          original(id, (task) => {
            if (changed === "worker") task.orchestration!.lease!.worker_id = "foreign-worker";
            else task.orchestration!.attempts += 1;
          }, directory);
          foreignBytes = readFileSync(join(state, `tasks/${id}.json`));
        }
        return original(id, mutate, directory);
      });
      await vi.waitFor(() => expect(signal.aborted).toBe(true)); await worker.stop();
      expect(replaced).toBe(true); expect(readFileSync(join(state, "tasks/B-1.json"))).toEqual(foreignBytes);
      expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
      expect(readTaskEvents("B-1").map((event) => event.type)).toEqual(["claimed"]);
    } finally { await worker.stop(); }
  });
  it.each(["runtime-tightened", "policy-drift"] as const)("heartbeat aborts owned %s work without renewing/releasing unavailable authority", async (fault) => {
    const activeSource = source(); bind("B-1", activeSource); const budgets = controller(activeSource); let signal!: AbortSignal;
    const run = vi.fn(async (_id: string, options: TaskRunOptions) => new Promise<null>((resolve) => {
      signal = options.signal!; signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    const worker = new TaskOrchestrator({ budgets, now: () => new Date(nowMs), heartbeatMs: 10, runAttempt: run });
    try {
      expect(await worker.runOnce()).toBe(1); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      if (fault === "runtime-tightened") { updateTask("B-1", (task) => { task.orchestration!.max_runtime_ms = 1000; }); nowMs += 1500; }
      else activeSource.fingerprint = "b".repeat(64);
      const lease = readTask("B-1")!.orchestration!.lease;
      await vi.waitFor(() => expect(signal.aborted).toBe(true)); await worker.stop();
      expect(readTask("B-1")!.orchestration!.lease).toEqual(lease); expect(Object.values(readBudgetLedger(ledgerPath)!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
      expect(await worker.runOnce()).toBe(0); expect(run).toHaveBeenCalledOnce();
    } finally { await worker.stop(); }
  });
});
