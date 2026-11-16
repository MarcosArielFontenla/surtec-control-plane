import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexExecutor } from "./codex-executor";
import { validateTerminalUsageEvidence } from "./terminal-usage-evidence";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { WorkflowBudget, WorkflowRoleOutput } from "../lib/workflows/types";
import type { AgentExecutor } from "./agent-executor";
import { listTasks, readTask, updateTask, writeTask } from "../lib/state/store";
import { readIssueDocument } from "../lib/state/issues";
import * as issueState from "../lib/state/issues";
import { mutateWorkflowDocument, readWorkflowDocument } from "../lib/state/workflows";
import { createIssueService } from "../dashboard/src/server/issue-service";
import { WorkflowOrchestrator, workflowExecutionOwner } from "./workflow-orchestrator";
import { BudgetExecutionScaffold, budgetExecutionOwner, TaskOrchestrator } from "./task-orchestrator";
import { runTask } from "./run-task";
import { createWorkflowService } from "../dashboard/src/server/workflow-service";
import { createTask, createWorkflowTask, prepareTaskBudgetAdmission } from "../dashboard/src/server/dispatch";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTestingEvidence, sealTestingEvidence } from "../lib/context/testing-evidence";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import { createCorrectionProgressEmitter, type CorrectionProgressStage, type CorrectionProgressLane, type CorrectionProgressOperation, type CorrectionProgressEdge } from "../scripts/diagnostics/correction-progress";
import type { Tracer } from "../lib/observability/tracing";
import { createWorktree, commitAndDiff } from "./worktree";
import { captureVerification } from "./verify";
import { mutateBudgetLedger, readBudgetLedger } from "../lib/state/budgets";
import { commitTaskBudget, reserveTaskBudget } from "../lib/budgets/reservations";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../lib/budgets/types";
import { readBudgetPolicy, type BudgetPolicySource } from "../lib/budgets/policy";
import { createPlannerFailureCapture, createPlannerFsObserver, createPlannerPhaseRecorder, createPlannerSpanCapture, createPlannerWaitCapture, createPlannerContinuityCapture, type PlannerSpanObserver, type PlannerWaitObserver, type PlannerContinuityObserver } from "../scripts/profile-maintenance";
import { assertQueuedStageSelection, assertReadOnlyCompletionCheckpoint, createAuthorizedWorkflowIssue,
  createWorkflowFixtureRoot, materializeWorkflowFixtureInputs, output, roles as workflowFixtureRoles, selectQueuedStage, workflowFixtureProjectRules,
  type FirstReadOnlyBinding, type WorkflowFixtureTemplate } from "./testing/workflow-orchestrator-fixture";
import { createGitFixtureBaselines } from "./testing/git-fixture";

let root: string, state: string, issueId: string, baseIssueId: string | undefined, worker: TaskOrchestrator | undefined;
type PlannerTrace = ReturnType<typeof createPlannerPhaseRecorder>;
let plannerTrace: PlannerTrace | undefined;
type PlannerFsTrace = ReturnType<typeof createPlannerFsObserver>;
let plannerFsTrace: PlannerFsTrace | undefined;
type CorrectionProgress = ReturnType<typeof createCorrectionProgressEmitter>;
let correctionProgress: CorrectionProgress | undefined;
let correctionCaseId = "";
const plannerFailureCapture = createPlannerFailureCapture();
const plannerSpanCapture = createPlannerSpanCapture();
const plannerWaitCapture = createPlannerWaitCapture();
const plannerContinuityCapture = createPlannerContinuityCapture({ timers: vi });
const plannerOriginalVi = vi;
type PlannerWaitApi = Pick<typeof vi, "waitFor">;
function plannerPollVi(continuity?: PlannerContinuityObserver): PlannerWaitApi {
  if (!continuity) return plannerOriginalVi;
  // Only this local facade wraps the original synchronous callback. The public
  // wait API, its receiver/options and the historical callback remain unchanged.
  return { waitFor: ((...args: Parameters<PlannerWaitApi["waitFor"]>) => Reflect.apply(plannerOriginalVi.waitFor, plannerOriginalVi,
    [() => continuity.observePoll(args[0]), ...args.slice(1)])) as PlannerWaitApi["waitFor"] };
}
const roles = workflowFixtureRoles;
const correctionGitBaselines = createGitFixtureBaselines();

afterAll(() => correctionGitBaselines.dispose());

beforeEach((context) => {
  correctionCaseId = "";
  try {
    const taskId = context.task.id;
    if (typeof taskId === "string" && taskId.length > 0) correctionCaseId = createHash("sha256").update(taskId).digest("hex");
  } catch { /* Missing diagnostic identity never replaces original fixture setup. */ }
  try { plannerSpanCapture.prepare(context); }
  catch { /* Diagnostic preparation never replaces the original fixture setup. */ }
  try { plannerWaitCapture.prepare(context); }
  catch { /* The additional observer remains inert outside its exact flag binding. */ }
  try { plannerContinuityCapture.prepare(context); }
  catch { /* The private P12 handle cannot replace original fixture setup. */ }
  issueId = ""; baseIssueId = undefined; plannerTrace = undefined; plannerFsTrace = undefined;
  ({ root, state } = createWorkflowFixtureRoot());
});
afterEach(async (context) => {
  const correction = correctionProgress; correctionProgress = undefined;
  correctionCaseId = "";
  correction?.seal();
  try { plannerSpanCapture.capture(context); }
  catch { /* The historical observation cannot replace test or cleanup errors. */ }
  try { plannerFailureCapture.capture(context); }
  catch { /* Early diagnostic evidence never replaces original test or cleanup errors. */ }
  try { plannerWaitCapture.capture(context); }
  catch { /* The immutable pre-stop observation never replaces cleanup errors. */ }
  try { plannerContinuityCapture.capture(context); }
  catch { /* P12 seals after historical captures, before the original stop. */ }
  const fsTrace = plannerFsTrace;
  fsTrace?.finish();
  const trace = plannerTrace, stopCleanup = trace?.begin("cleanup");
  try { await worker?.stop(); worker = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
  finally {
    stopCleanup?.();
    if (trace) {
      try { process.stdout.write(`PLANNER_PHASE_PROFILE ${JSON.stringify(trace.receipt())}\n`); }
      catch { /* Diagnostic output cannot replace an original test or cleanup error. */ }
    }
    if (fsTrace) {
      try { process.stdout.write(`PLANNER_FS_PROFILE ${JSON.stringify(fsTrace.receipt())}\n`); }
      catch { /* Diagnostic output cannot replace an original test or cleanup error. */ }
    }
  }
});
describe("workflow fixture input isolation", () => {
  function inventory(directory: string, prefix = ""): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? inventory(join(directory, entry.name), path) : [path];
    }).sort();
  }
  it("materializes public inputs with byte-equivalent files and exact path inventory", () => {
    const copyRoot = join(root, "input-isolation-copy"), paths = materializeWorkflowFixtureInputs(copyRoot);
    expect(inventory(copyRoot)).toEqual([...paths].sort());
    expect(paths.filter((path) => path.startsWith("registry/")).sort()).toEqual(["registry/agent-roles.yml", "registry/agents.yml", "registry/context-policy.yml", "registry/workflow-policy.yml"]);
    for (const path of paths) {
      const target = join(copyRoot, path), info = lstatSync(target), original = readFileSync(path);
      expect(info.isFile()).toBe(true); expect(info.isSymbolicLink()).toBe(false);
      expect(readFileSync(target).equals(original)).toBe(true);
      expect(readFileSync(join(root, path)).equals(original)).toBe(true);
    }
    expect(worker).toBeUndefined(); expect(existsSync(state)).toBe(false);
  });
  it("keeps case copies and the cached inputs independent after a local mutation", () => {
    const siblingRoot = join(root, "input-isolation-sibling"), paths = materializeWorkflowFixtureInputs(siblingRoot);
    const changedPath = "registry/agent-roles.yml", original = readFileSync(changedPath);
    writeFileSync(join(root, changedPath), "Synthetic case-local mutation; no authority.\n");
    const laterRoot = join(root, "input-isolation-later"), laterPaths = materializeWorkflowFixtureInputs(laterRoot);
    expect(readFileSync(join(root, changedPath)).equals(original)).toBe(false);
    expect(laterPaths).toEqual(paths);
    for (const path of paths) {
      const bytes = readFileSync(path);
      expect(readFileSync(join(siblingRoot, path)).equals(bytes)).toBe(true);
      expect(readFileSync(join(laterRoot, path)).equals(bytes)).toBe(true);
    }
    expect(readFileSync(changedPath).equals(original)).toBe(true);
    expect(worker).toBeUndefined(); expect(existsSync(state)).toBe(false);
  });
});
function ensureBaseIssue(trace?: PlannerTrace, span?: PlannerSpanObserver) {
  baseIssueId ??= createAuthorizedWorkflowIssue(root, trace, span);
  issueId = baseIssueId;
}
function fixture(template: WorkflowFixtureTemplate = "analysis", value: unknown = output(), usage = true, budget?: WorkflowBudget, trace?: PlannerTrace, fsTrace?: PlannerFsTrace, span?: PlannerSpanObserver, wait?: PlannerWaitObserver, continuity?: PlannerContinuityObserver) {
  ensureBaseIssue(trace, span);
  const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async () => {
    wait?.checkpoint("executor-enter");
    try {
      const result = { finalText: "Never copy this raw fallback", structuredOutput: value, threadId: "synthetic-thread", turnId: "synthetic-turn",
        usage: usage ? { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } : null };
      wait?.checkpoint("executor-body-return"); return result;
    } catch (error) { wait?.checkpoint("executor-body-throw"); throw error; }
  }) };
  const attemptRoot = root;
  const historicalWait = wait;
  if (historicalWait && continuity) wait = {
    checkpoint: (name) => historicalWait.checkpoint(name), bindFixture: (binding) => historicalWait.bindFixture(binding), beginRead: () => historicalWait.beginRead(),
    observeAttempt: (binding, invoke) => continuity.observeAttempt({ ...binding, controller }, () => historicalWait.observeAttempt(binding, invoke)),
  };
  let boundWorker: TaskOrchestrator;
  boundWorker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1,
    ...(wait ? { runAttempt: (taskId: string, runOptions: Parameters<typeof runTask>[3]) => wait.observeAttempt({ taskId, root: attemptRoot, executor, worker: boundWorker, options: runOptions! }, () => runTask(taskId, attemptRoot, executor, { ...runOptions, tracer: undefined })) } : {}) });
  worker = boundWorker;
  const selected = template === "analysis" ? ["portfolio-analyst"] : template === "operations-investigation" ? ["operations-observer"] : template === "implementation" ? ["planner", "software-engineer", "reviewer"] : ["software-engineer", "reviewer"];
  const request = { template_id: template, template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
    selected_agents: Object.fromEntries(selected.map((role) => [role, roles[role as keyof typeof roles]])), ...(budget ? { budget } : {}) };
  let preview: ReturnType<typeof controller.service.preview>, started: ReturnType<typeof controller.service.start>;
  const stopPreview = trace?.begin("preview");
  const stopSpanPreview = span?.begin("preview");
  try { preview = controller.service.preview(request); expect(preview.allowed).toBe(true); }
  finally { stopSpanPreview?.(); stopPreview?.(); }
  const stopAdmission = trace?.begin("admission");
  const stopFsAdmission = fsTrace?.begin("admission");
  const stopSpanAdmission = span?.begin("admission");
  try { started = controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" }); }
  finally { stopSpanAdmission?.(); stopFsAdmission?.(); stopAdmission?.(); }
  wait?.bindFixture({ taskId: started.stages[0]!.task_id!, root: attemptRoot, executor, worker: boundWorker });
  continuity?.bindFixture({ taskId: started.stages[0]!.task_id!, root: attemptRoot, executor, worker: boundWorker, controller });
  return { controller, executor, taskId: started.stages[0]!.task_id!, id: started.workflow.id, stageId: started.stages[0]!.id, request };
}
async function complete(taskId: string, trace?: PlannerTrace, fsTrace?: PlannerFsTrace, span?: PlannerSpanObserver, wait?: PlannerWaitObserver, continuity?: PlannerContinuityObserver) {
  const vi = plannerPollVi(continuity);
  const stopDispatch = trace?.begin("dispatch");
  const stopFsDispatch = fsTrace?.begin("dispatch");
  const stopSpanDispatch = span?.begin("dispatch");
  try { expect(await worker!.runOnce()).toBe(1); }
  finally { stopSpanDispatch?.(); stopFsDispatch?.(); stopDispatch?.(); }
  const stopTerminal = trace?.begin("terminal-observation");
  const stopSpanTerminal = span?.begin("terminal-observation");
  wait?.checkpoint("wait-enter");
  continuity?.checkpoint("wait-enter");
  try {
    await vi.waitFor(wait ? () => {
      const read = wait.beginRead(); let lifecycle: NonNullable<ReturnType<typeof readTask>>["lifecycle"] | undefined;
      try { lifecycle = readTask(taskId)?.lifecycle; } catch (error) { read.threw(); throw error; }
      read.returned(lifecycle); expect(lifecycle).toBe("finished");
    } : () => expect(readTask(taskId)?.lifecycle).toBe("finished"), { timeout: 5000 });
    wait?.checkpoint("wait-return");
    continuity?.checkpoint("wait-return");
  } catch (error) { wait?.checkpoint("wait-reject"); continuity?.checkpoint("wait-reject"); throw error; }
  finally { stopSpanTerminal?.(); stopTerminal?.(); }
}
async function completeFirstReadOnlyStage(binding: FirstReadOnlyBinding) {
  expect(await worker!.runOnce()).toBe(1);
  await vi.waitFor(() => assertReadOnlyCompletionCheckpoint(binding, readTask(binding.taskId), readWorkflowDocument()), { timeout: 5000 });
}
function claim(f: ReturnType<typeof fixture>) {
  const runId = "synthetic-owned-run", at = new Date().toISOString();
  updateTask(f.taskId, (task) => {
    task.lifecycle = "running"; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: runId, worker_id: worker!.workerId, acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60000).toISOString() };
  });
  return { proof: f.controller.claimRun(f.taskId, runId), runId };
}

describe("T006 independent workflow budget scaffold", () => {
  function bind(f: ReturnType<typeof fixture>) {
    const source: BudgetPolicySource = { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
      rules: [{ id: "synthetic-company", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
        limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
    const draft = readTask(f.taskId)!, admission = draft.envelope.context_admission!;
    if (admission.schema_version !== 2) throw new Error("Synthetic workflow lost its exact binding");
    const prepared = prepareTaskBudgetAdmission(draft, { source, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"],
      issue_id: issueId, role_id: admission.role_id, execution_id: f.taskId } });
    const path = join(state, "budgets/budgets.json");
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source }), path, prepared.admission.created_at);
    writeTask(prepared.task);
    mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: prepared.admission, persisted_admission: readTask(f.taskId)!.envelope.budget_admission }), path, prepared.admission.created_at);
    return { source, path };
  }
  it("a stored admission cannot activate default workflow claim or reconciliation", async () => {
    const f = fixture(), bound = bind(f), taskBytes = readFileSync(join(state, `tasks/${f.taskId}.json`)), workflowBytes = readFileSync(join(state, "workflows/workflows.json")), ledgerBytes = readFileSync(bound.path);
    expect(() => f.controller.canClaim(readTask(f.taskId)!)).toThrow(/independent private/);
    f.controller.reconcile(); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled();
    expect(readFileSync(join(state, `tasks/${f.taskId}.json`)).equals(taskBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true); expect(readFileSync(bound.path).equals(ledgerBytes)).toBe(true);
  });
  it("an exact task lease cannot replace the independent budget proof", () => {
    const f = fixture(), bound = bind(f), at = new Date().toISOString();
    updateTask(f.taskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: "without-budget-proof", worker_id: worker!.workerId,
      acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60000).toISOString() }; });
    const before = readFileSync(join(state, "workflows/workflows.json")), ledgerBytes = readFileSync(bound.path);
    expect(() => f.controller.claimRun(f.taskId, "without-budget-proof", {})).toThrow(/independent private/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(before)).toBe(true); expect(readFileSync(bound.path).equals(ledgerBytes)).toBe(true); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("requires both private identities, accounts once, and never creates a P successor from a fixture completion", async () => {
    const f = fixture(), bound = bind(f); await worker!.stop();
    const controller = new WorkflowOrchestrator(root), budgets = new BudgetExecutionScaffold({ filePath: bound.path, resolve: () => ({ source: bound.source }) });
    const run = vi.fn(async (taskId: string, options: Parameters<typeof runTask>[3]) => {
      expect(workflowExecutionOwner(options!.workflowExecution, taskId, options!.runId!)).toBe(controller);
      expect(budgetExecutionOwner(options!.budgetExecution, taskId, options!.runId!)).toBe(budgets);
      expect(budgetExecutionOwner(options!.workflowExecution, taskId, options!.runId!)).toBeNull();
      expect(workflowExecutionOwner(options!.budgetExecution, taskId, options!.runId!)).toBeNull();
      return runTask(taskId, root, f.executor, options);
    });
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, budgets, runAttempt: run }); await complete(f.taskId);
    expect(readTask(f.taskId)?.outcome).toBe("completed"); expect(f.executor.run).toHaveBeenCalledOnce();
    const detail = controller.service.detail(f.id); expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true });
    const ledger = readBudgetLedger(bound.path)!; expect(Object.values(ledger.charges)).toMatchObject([{ attempts: 1, observed_total_tokens: 3, status: "terminal" }]);
    expect(Object.values(ledger.reservations)[0]!.status).toBe("settled");
    controller.reconcile(); new WorkflowOrchestrator(root).reconcile(); expect(listTasks()).toHaveLength(1); expect(detail.decisions).toEqual([]); expect(detail.handoffs).toEqual([]); expect(await worker!.runOnce()).toBe(0);
  });
  it("bound expired history never becomes an owned workflow retry or inferred known-zero usage", () => {
    const f = fixture(), bound = bind(f), at = new Date(Date.now() - 10000).toISOString();
    updateTask(f.taskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: "expired-bound", worker_id: "old",
      acquired_at: at, heartbeat_at: at, expires_at: at }; });
    const taskBytes = readFileSync(join(state, `tasks/${f.taskId}.json`)), before = readFileSync(join(state, "workflows/workflows.json")), ledgerBytes = readFileSync(bound.path);
    expect(f.controller.recoverExpired(readTask(f.taskId)!)).toBe(false); expect(worker!.recoverExpiredLeases()).toBe(0); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, `tasks/${f.taskId}.json`)).equals(taskBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(before)).toBe(true); expect(readFileSync(bound.path).equals(ledgerBytes)).toBe(true); expect(f.executor.run).not.toHaveBeenCalled();
  });
});
describe("read-only completion checkpoint", () => {
  function facts() {
    const binding = fixture(), task = readTask(binding.taskId)!, document = readWorkflowDocument();
    task.lifecycle = "finished"; document.stages[binding.stageId]!.status = "completed"; document.workflows[binding.id]!.status = "waiting-human";
    return { binding, task, document };
  }
  it("accepts only the exact finished task, completed stage and reconciled human gate", () => {
    const f = facts(), dispatch = vi.spyOn(worker!, "runOnce");
    expect(() => assertReadOnlyCompletionCheckpoint(f.binding, f.task, f.document)).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled(); expect(f.binding.executor.run).not.toHaveBeenCalled();
  });
  it("rejects a finished task while its workflow remains running", () => {
    const f = facts(), dispatch = vi.spyOn(worker!, "runOnce"); f.document.workflows[f.binding.id]!.status = "running";
    expect(() => assertReadOnlyCompletionCheckpoint(f.binding, f.task, f.document)).toThrow(/reconciled human gate/);
    expect(dispatch).not.toHaveBeenCalled(); expect(f.binding.executor.run).not.toHaveBeenCalled();
  });
  it.each(["task", "workflow", "current-stage", "stage-owner", "stage-task", "stage-status"] as const)("rejects a mismatched %s checkpoint without dispatch", (mismatch) => {
    const f = facts(), dispatch = vi.spyOn(worker!, "runOnce"), stage = f.document.stages[f.binding.stageId]!;
    if (mismatch === "task") f.task.envelope.id = "synthetic-other-task";
    else if (mismatch === "workflow") delete f.document.workflows[f.binding.id];
    else if (mismatch === "current-stage") f.document.workflows[f.binding.id]!.current_stage_id = "synthetic-other-stage";
    else if (mismatch === "stage-owner") stage.workflow_id = "synthetic-other-workflow";
    else if (mismatch === "stage-task") stage.task_id = "synthetic-other-task";
    else stage.status = "running";
    expect(() => assertReadOnlyCompletionCheckpoint(f.binding, f.task, f.document)).toThrow(/read-only checkpoint/);
    expect(dispatch).not.toHaveBeenCalled(); expect(f.binding.executor.run).not.toHaveBeenCalled();
  });
  it("uses one real dispatch and one unchanged wait without completion effects", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8"), start = source.indexOf("async function completeFirstReadOnlyStage("), helper = source.slice(start, source.indexOf("\n}", start) + 2);
    expect(helper.match(/await /g)).toHaveLength(2); expect(helper.match(/worker!\.runOnce\(\)/g)).toHaveLength(1);
    expect(helper).toContain('expect(await worker!.runOnce()).toBe(1);');
    expect(helper).toContain('await vi.waitFor(() => assertReadOnlyCompletionCheckpoint(binding, readTask(binding.taskId), readWorkflowDocument()), { timeout: 5000 });');
    expect(helper).not.toMatch(/reconcile|setTimeout|setInterval|Promise\.race|\.start\(|\.stop\(|interval:/);
  });
});
describe("queued-stage selection", () => {
  it("reads the validated current stage without constructing a public detail projection or dispatching", () => {
    const f = fixture(), document = readWorkflowDocument(), stage = document.stages[f.stageId]!, detail = vi.spyOn(f.controller.service, "detail"), dispatch = vi.spyOn(worker!, "runOnce");
    expect(selectQueuedStage(f.id, stage.kind)).toEqual(stage);
    expect(detail).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it.each(["workflow", "current-stage", "stage-owner", "last-stage", "kind", "status", "task"] as const)("rejects a mismatched %s before dispatch", (mismatch) => {
    const f = fixture(), document = readWorkflowDocument(), stage = document.stages[f.stageId]!, kind = stage.kind, dispatch = vi.spyOn(worker!, "runOnce");
    if (mismatch === "workflow") delete document.workflows[f.id];
    else if (mismatch === "current-stage") document.workflows[f.id]!.current_stage_id = "synthetic-missing-stage";
    else if (mismatch === "stage-owner") stage.workflow_id = "synthetic-other-workflow";
    else if (mismatch === "last-stage") document.stages["synthetic-later-stage"] = { ...stage, id: "synthetic-later-stage" };
    else if (mismatch === "kind") stage.kind = "correction";
    else if (mismatch === "status") stage.status = "running";
    else stage.task_id = null;
    expect(() => assertQueuedStageSelection(document, f.id, kind)).toThrow(/queued-stage selection/);
    expect(dispatch).not.toHaveBeenCalled(); expect(f.executor.run).not.toHaveBeenCalled();
  });
});
describe("finite workflow controller integration", () => {
  describe.each([["analysis", "analysis"], ["implementation", "plan"], ["operations-investigation", "operations"]] as const)("first-stage fixture %s", (template, kind) => {
    const prepare = () => {
      const span = template === "implementation" ? plannerSpanCapture.beginCallback() : undefined;
      const wait = template === "implementation" ? plannerWaitCapture.beginCallback() : undefined;
      const continuity = template === "implementation" ? plannerContinuityCapture.beginCallback() : undefined;
      const wantsTrace = template === "implementation" && process.env.SURTEC_TEST_PLANNER_PROFILE === "1";
      const wantsFsTrace = template === "implementation" && process.env.SURTEC_TEST_PLANNER_FS_PROFILE === "1";
      const trace = wantsTrace && !wantsFsTrace ? createPlannerPhaseRecorder() : undefined;
      const fsTrace = wantsFsTrace && !wantsTrace ? createPlannerFsObserver() : undefined;
      plannerTrace = trace; plannerFsTrace = fsTrace;
      const f = fixture(template, output(kind), true, undefined, trace, fsTrace, span, wait, continuity), issueBefore = readIssueDocument();
      return { f, issueBefore, trace, fsTrace, span, wait, continuity };
    };
    let prepared: ReturnType<typeof prepare>;
    beforeEach(() => { prepared = prepare(); }, 5000);

    it(`runs only the exact first read-only ${template} stage and retains a human gate`, async () => {
      const { f, issueBefore, trace, fsTrace, span, wait, continuity } = prepared;
      if (trace || fsTrace || span || wait || continuity) await complete(f.taskId, trace, fsTrace, span, wait, continuity);
      else await completeFirstReadOnlyStage(f);
      let bytes: Buffer;
      const stopAssertions = trace?.begin("assertions");
      const stopSpanAssertions = span?.begin("assertions");
      try {
        expect(readTask(f.taskId)?.outcome).toBe("completed");
        const detail = f.controller.service.detail(f.id); expect(detail.workflow.status).toBe("waiting-human"); expect(detail.stages[0]!.status).toBe("completed");
        expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true }); expect(detail.accounting[0]!.usage_complete).toBe(true);
        expect(detail.decisions[0]!.kind).toBe(kind === "plan" ? "plan-approval" : "proposal-acknowledgement");
        expect(f.executor.run).toHaveBeenCalledOnce(); const [run] = vi.mocked(f.executor.run).mock.calls[0]!;
        expect(run.mode).toBe("read-only"); expect(run.verifyCommands).toEqual([]); expect(run.threadId).toBeUndefined(); expect(JSON.stringify(run.outputSchema)).toContain(`"${kind}"`);
        expect(readIssueDocument()).toEqual(issueBefore); expect(detail.handoffs).toEqual([]); expect(detail.review_receipts).toEqual([]);
        expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
        bytes = readFileSync(join(state, "workflows/workflows.json"));
      } finally { stopSpanAssertions?.(); stopAssertions?.(); }
      const stopReconcile = trace?.begin("probe-reconcile");
      const stopSpanReconcile = span?.begin("probe-reconcile");
      try { f.controller.reconcile(); } finally { stopSpanReconcile?.(); stopReconcile?.(); }
      const stopTick = trace?.begin("probe-worker-tick");
      const stopSpanTick = span?.begin("probe-worker-tick");
      try { await worker!.runOnce(); } finally { stopSpanTick?.(); stopTick?.(); }
      const stopRestart = trace?.begin("probe-restart-reconcile");
      const stopSpanRestart = span?.begin("probe-restart-reconcile");
      try { new WorkflowOrchestrator(root).reconcile(); } finally { stopSpanRestart?.(); stopRestart?.(); }
      const stopProbeAssertions = trace?.begin("probe-assertions");
      const stopSpanProbeAssertions = span?.begin("probe-assertions");
      try { expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(listTasks()).toHaveLength(1); }
      finally { stopSpanProbeAssertions?.(); stopProbeAssertions?.(); }
    });
  });
  it("admits only the exact consented Engineer stage while leaving correction disabled", () => {
    const f = fixture("trivial-change"), document = readWorkflowDocument(), task = readTask(f.taskId)!;
    expect(document.stages[f.stageId]!.kind).toBe("implementation");
    expect(document.grants[document.workflows[f.id]!.current_grant_id]!.correction.enabled).toBe(false);
    expect(f.controller.canClaim(task)).toBe(true); expect(task.orchestration?.attempts).toBe(0); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("plan approval admits only the exact Engineer successor with a sealed handoff", async () => {
    const f = fixture("implementation", output("plan")); await complete(f.taskId);
    const detail = f.controller.service.detail(f.id), decision = detail.decisions[0]!;
    f.controller.service.decide(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-plan-human", rationale: "Exact bounded plan", confirm: true });
    f.controller.reconcile();
    const admitted = f.controller.service.detail(f.id);
    expect(admitted.workflow.status).toBe("running"); expect(admitted.stages.at(-1)).toMatchObject({ kind: "implementation", status: "queued", predecessor_stage_id: f.stageId });
    expect(admitted.handoffs).toHaveLength(1); expect(admitted.handoffs[0]!.from_role_id).toBe("planner");
    expect(listTasks()).toHaveLength(2); expect(readTask(admitted.stages.at(-1)!.task_id!)?.orchestration?.attempts).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15_000);
  it.each(["success", "late-usage"])("native synthetic Planner keeps exact human gate and restart accounting for %s", async (scenario) => {
    const f = fixture("implementation", output("plan"));
    await worker!.stop();
    const controller = new WorkflowOrchestrator(root);
    const closed: Promise<void>[] = [];
    const spawned = vi.fn(() => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/codex-app-server-terminal.mjs", import.meta.url)), scenario, "planner"],
        { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: {} });
      closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
      return child;
    });
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor: new CodexExecutor(spawned), maxConcurrent: 1 });
    try {
      await complete(f.taskId);
      const detail = controller.service.detail(f.id), task = readTask(f.taskId)!;
      expect(spawned).toHaveBeenCalledOnce();
      expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: scenario === "success" ? 15 : 25,
        accounting_complete: scenario === "success" });
      expect(detail.accounting[0]!.usage_complete).toBe(scenario === "success");
      const metadata = task.envelope.metadata.run as Record<string, unknown>;
      if (scenario === "success") {
        expect(task.outcome).toBe("completed"); expect(detail.workflow.status).toBe("waiting-human");
        expect(detail.decisions).toHaveLength(1); expect(detail.decisions[0]!.kind).toBe("plan-approval");
        expect(validateTerminalUsageEvidence(metadata.terminal_usage_evidence, { taskId: f.taskId, executionId: detail.accounting[0]!.execution_id,
          contextFingerprint: metadata.context_fingerprint as string, threadId: "thread-1", turnId: "turn-1", usage: metadata.usage as import("./agent-executor").AgentUsage })).not.toBeNull();
      } else {
        expect(task.outcome).toBe("needs-review"); expect(detail.workflow.status).toBe("needs-decision");
        expect(detail.decisions).toEqual([]); expect(metadata).not.toHaveProperty("terminal_usage_evidence");
        expect(() => worker!.retry(f.taskId)).toThrow(/controller/);
      }
      const taskBytes = readFileSync(join(state, "tasks", `${f.taskId}.json`));
      const workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
      controller.reconcile(); expect(await worker!.runOnce()).toBe(0);
      new WorkflowOrchestrator(root).reconcile();
      expect(readFileSync(join(state, "tasks", `${f.taskId}.json`)).equals(taskBytes)).toBe(true);
      expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
      expect(listTasks()).toHaveLength(1); expect(spawned).toHaveBeenCalledOnce();
      expect(detail.handoffs).toEqual([]); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
    } finally { await worker!.stop(); await Promise.all(closed); }
  }, 15_000);
  it.each([null, { schema_version: 99 }, { ...output(), evidence_ids: ["unowned"] }, { ...output(), kind: "operations", proposed_issue: null }])("rejects malformed/unowned output without promoting raw fallback %#", async (value) => {
    const f = fixture("analysis", value); await complete(f.taskId); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision"); expect(JSON.stringify(readTask(f.taskId))).not.toContain("raw fallback");
  });
  it("missing final usage is unknown and cannot be recovered as zero or retried", async () => {
    const f = fixture("analysis", output(), false); await complete(f.taskId); const detail = f.controller.service.detail(f.id);
    expect(detail.workflow.counters.accounting_complete).toBe(false); expect(detail.workflow.status).toBe("needs-decision");
    expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(readIssueDocument().issues[issueId]!.status).toBe("needs-decision");
    expect(readIssueDocument().events.at(-1)).toMatchObject({ type: "authorization-stale", payload: { workflow_id: f.id, task_id: f.taskId,
      budget_exhaustion: { denials: expect.arrayContaining([expect.objectContaining({ code: "budget-accounting-unavailable", dimension: "accounting" })]) } } });
    expect(() => worker!.retry(f.taskId)).toThrow(/controller/); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
    expect(() => f.controller.service.recover(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/provable/);
  });
  it("an interrupted provider cannot persist raw exceptions or trigger a generic automatic retry", async () => {
    const f = fixture(); vi.mocked(f.executor.run).mockRejectedValue(new Error("Synthetic private exception C:\\private\\auth.json"));
    await complete(f.taskId); const task = readTask(f.taskId)!;
    expect(task.outcome).toBe("needs-review"); expect(task.orchestration?.retry_at).toBeNull();
    expect(f.controller.service.detail(f.id).workflow.counters.accounting_complete).toBe(false);
    expect(JSON.stringify(task)).not.toContain("Synthetic private exception"); expect(readFileSync(join(root, task.logs_path!), "utf8")).not.toContain("Synthetic private exception");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("source drift during the turn retains usage but cannot capture output or create a human approval", async () => {
    const f = fixture(); vi.mocked(f.executor.run).mockImplementation(async () => {
      writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed during the synthetic turn");
      return { finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
    });
    await complete(f.taskId); const detail = f.controller.service.detail(f.id);
    expect(readTask(f.taskId)?.outcome).toBe("needs-review"); expect(detail.stages[0]!.output).toBeNull(); expect(detail.decisions).toEqual([]);
    expect(detail.workflow.counters).toMatchObject({ total_tokens: 3, accounting_complete: true }); expect(detail.workflow.status).toBe("needs-decision");
  });
  it("source drift and an uncommitted intent never reach the model", async () => {
    const f = fixture(); writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed rules require new authority");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled(); expect(readTask(f.taskId)?.orchestration?.attempts).toBe(0);
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision");
  });
  it("caller-shaped proof cannot turn a standalone task lease into controller authority", async () => {
    const f = fixture(); expect(workflowExecutionOwner({}, f.taskId, "forged")).toBeNull();
    await runTask(f.taskId, root, f.executor, { workflowExecution: {} }); expect(f.executor.run).not.toHaveBeenCalled(); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(readWorkflowDocument().accounting).toEqual({});
  });
  it("durable stop precedes queued cancellation and survives a new controller", async () => {
    const f = fixture(), detail = f.controller.service.detail(f.id), issueBefore = readIssueDocument();
    f.controller.service.cancel(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    expect(readTask(f.taskId)?.outcome).toBe("cancelled"); expect(f.controller.service.detail(f.id).workflow.stop_requested_at).not.toBeNull();
    new WorkflowOrchestrator(root).reconcile(); expect(f.controller.service.detail(f.id).workflow.status).toBe("cancelled");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled(); expect(readIssueDocument()).toEqual(issueBefore);
  });
  it("durable stop precedes an in-flight abort and retains interrupted accounting on restart", async () => {
    const f = fixture(), issueBytes = readFileSync(join(state, "issues/issues.json"));
    let abortSawDurableStop = false;
    vi.mocked(f.executor.run).mockImplementation(async (_input, _events, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => {
        abortSawDurableStop = !!f.controller.service.detail(f.id).workflow.stop_requested_at;
        const error = new Error("synthetic interrupted provider"); error.name = "AbortError"; reject(error);
      }, { once: true });
    }));
    expect(await worker!.runOnce()).toBe(1); await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce());
    const detail = f.controller.service.detail(f.id);
    f.controller.service.cancel(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    await vi.waitFor(() => expect(readTask(f.taskId)?.lifecycle).toBe("finished"));
    new WorkflowOrchestrator(root).reconcile();
    const stopped = f.controller.service.detail(f.id);
    expect(abortSawDurableStop).toBe(true); expect(stopped.workflow.status).toBe("cancelled"); expect(stopped.stages[0]!.status).toBe("cancelled");
    expect(readTask(f.taskId)).toMatchObject({ outcome: "cancelled", result: { status: "cancelled" }, orchestration: { lease: null } });
    expect(stopped.events.some((entry) => entry.type === "budget-stopped")).toBe(false);
    expect(stopped.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, accounting_complete: false }); expect(stopped.accounting[0]!.usage_complete).toBe(false);
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce(); expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true);
  });
  it("deduplicates per-run observations, keeps maxima and never rewrites final usage", () => {
    const f = fixture(), { proof, runId } = claim(f);
    f.controller.observe(proof, 3, 100); f.controller.observe(proof, 3, 100); f.controller.observe(proof, 1, 90);
    expect(f.controller.service.detail(f.id).workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, runtime_ms: 100 });
    f.controller.settle(proof, 3, 150, true);
    const bytes = readFileSync(join(state, "workflows/workflows.json")); f.controller.observe(proof, 10, 500, true);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(readWorkflowDocument().accounting[runId]!.usage_complete).toBe(true);
    expect(() => f.controller.claimRun(f.taskId, runId)).toThrow(/already charged/);
    expect(Object.keys(readWorkflowDocument().accounting)).toEqual([runId]);
  });
  it.each(["tokens", "runtime"] as const)("retains aggregate %s exhaustion without admitting another attempt or successor", (kind) => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 1000, max_total_tokens: 10 }), { proof } = claim(f);
    expect(f.controller.observe(proof, kind === "tokens" ? 10 : 3, kind === "runtime" ? 1000 : 100)).toBe(true);
    const detail = f.controller.service.detail(f.id); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.workflow.blocked_reason).toContain("budget");
    expect(detail.workflow.counters.attempts).toBe(1); expect(f.controller.canClaim(readTask(f.taskId)!)).toBe(false); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("actual usage events and final usage charge the same run once", async () => {
    const f = fixture();
    vi.mocked(f.executor.run).mockImplementation(async (_input, events) => {
      const usage = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 };
      const event = { type: "usage" as const, at: new Date().toISOString(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage };
      await events(event); await events(event);
      return { finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage };
    });
    await complete(f.taskId); expect(f.controller.service.detail(f.id).workflow.counters.total_tokens).toBe(3); expect(readTask(f.taskId)?.orchestration?.cumulative_tokens).toBe(3);
  });
  it("an actual turn reaching its root token cap cannot publish a completed proposal or successor", async () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 3 }); await complete(f.taskId);
    const detail = f.controller.service.detail(f.id);
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true });
    expect(detail.stages[0]!.output).toBeNull(); expect(detail.decisions).toEqual([]); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("reconstructs completed owned facts after a lost terminal callback exactly once", async () => {
    const f = fixture(), callback = vi.spyOn(f.controller, "reconcile").mockImplementation(() => {}); await complete(f.taskId);
    expect(f.controller.service.detail(f.id).workflow.status).toBe("running"); callback.mockRestore();
    const restarted = new WorkflowOrchestrator(root); restarted.reconcile();
    const bytes = readFileSync(join(state, "workflows/workflows.json")); restarted.reconcile();
    expect(restarted.service.detail(f.id).workflow.status).toBe("waiting-human"); expect(restarted.service.detail(f.id).decisions).toHaveLength(1);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("two workers share existing scheduler capacity and cannot charge or execute one stage twice", async () => {
    const f = fixture(), other = new TaskOrchestrator({ repoRoot: root, workflows: new WorkflowOrchestrator(root), executor: f.executor, maxConcurrent: 1 });
    let resolveRun!: (value: Awaited<ReturnType<AgentExecutor["run"]>>) => void;
    vi.mocked(f.executor.run).mockImplementation(async () => new Promise((resolve) => { resolveRun = resolve; }));
    try {
      expect(await worker!.runOnce()).toBe(1); await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce());
      expect(await other.runOnce()).toBe(0); expect(f.controller.service.detail(f.id).accounting).toHaveLength(1);
      resolveRun({ finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } });
      await vi.waitFor(() => expect(readTask(f.taskId)?.lifecycle).toBe("finished")); expect(await other.runOnce()).toBe(0);
      expect(f.controller.service.detail(f.id).workflow.counters.attempts).toBe(1); expect(f.executor.run).toHaveBeenCalledOnce();
    } finally { await other.stop(); }
  });
  it("different workflow issues share one project writer while an independent read-only role uses spare capacity", async () => {
    const first = fixture("trivial-change"); await worker!.stop();
    const controller = new WorkflowOrchestrator(root), issues = createIssueService(root);
    const start = () => {
      const proposed = issues.create({ project_id: "alpha", title: "Synthetic trivial-change concurrency", expected_outcome: "Observable synthetic result",
        acceptance_criteria: ["Observable acceptance"], assigned_role_id: "backend-engineer", plan: ["Existing plan"],
        authorized_scope: { expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
      const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-concurrent-scope-human");
      const request = { template_id: "trivial-change", template_version: 1, project_id: "alpha", issue_id: issue.id, expected_revision: issue.revision,
        selected_agents: { "software-engineer": roles["software-engineer"], reviewer: roles.reviewer } };
      const preview = controller.service.preview(request); expect(preview.allowed, preview.blocked_reasons.join("; ")).toBe(true);
      return controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-concurrent-root-human" });
    };
    const runAttempt = vi.fn(async (taskId: string, options: Parameters<typeof runTask>[3]) => {
      const task = readTask(taskId)!;
      expect(options?.runId).toBe(task.orchestration!.lease!.run_id);
      if (task.envelope.context_admission!.schema_version === 2) expect(workflowExecutionOwner(options?.workflowExecution, taskId, options!.runId!)).not.toBeNull();
      else expect(options?.workflowExecution).toBeUndefined();
      return new Promise<null>((resolve) => {
        if (options!.signal!.aborted) resolve(null);
        else options!.signal!.addEventListener("abort", () => resolve(null), { once: true });
      });
    });
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor: first.executor, maxConcurrent: 3, runAttempt });
    const second = start(), context = createContextService(root), request = { kind: "analysis", project: "alpha", agent: roles["portfolio-analyst"], role_id: "portfolio-analyst", instructions: "Inspect synthetic bounded concurrency." };
    const preview = context.preview(request), advisory = createTask({ project: request.project, agent: request.agent, role_id: request.role_id, instructions: request.instructions, preview_fingerprint: preview.fingerprint }, root, undefined, { context });
    const other = new TaskOrchestrator({ repoRoot: root, workflows: new WorkflowOrchestrator(root), executor: first.executor, maxConcurrent: 3, runAttempt });
    try {
      expect(await worker.runOnce()).toBe(2); await vi.waitFor(() => expect(runAttempt).toHaveBeenCalledTimes(2));
      const tasks = listTasks(), running = tasks.filter((task) => task.lifecycle === "running"), waiting = tasks.filter((task) => task.lifecycle === "queued");
      expect(running.filter((task) => task.envelope.sandbox === "workspace-write")).toHaveLength(1);
      expect(running.filter((task) => task.envelope.sandbox === "read-only").map((task) => task.envelope.id)).toEqual([advisory.id]);
      expect(waiting).toHaveLength(1); expect([first.taskId, second.stages[0]!.task_id]).toContain(waiting[0]!.envelope.id);
      expect(waiting[0]!.orchestration).toMatchObject({ attempts: 0, lease: null });
      const waitingAdmission = waiting[0]!.envelope.context_admission!; expect(waitingAdmission.schema_version).toBe(2);
      if (waitingAdmission.schema_version !== 2) throw new Error("Synthetic waiting task lost its governed admission");
      expect(controller.service.detail(waitingAdmission.workflow_id).workflow.counters).toMatchObject({ tasks: 1, attempts: 0, total_tokens: 0, runtime_ms: 0, accounting_complete: true });
      expect(await other.runOnce()).toBe(0); expect(runAttempt).toHaveBeenCalledTimes(2);
      expect(Object.values(readWorkflowDocument().accounting)).toHaveLength(1); expect(first.executor.run).not.toHaveBeenCalled();
      expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false); expect(listTasks()).toHaveLength(3);
    } finally { await other.stop(); await worker.stop(); }
  });
  it("stale proof cannot observe usage or publish role output after lease replacement", () => {
    const f = fixture(), { proof } = claim(f), prepared = f.controller.prepare(proof);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.run_id = "synthetic-replacement"; });
    const bytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(() => f.controller.observe(proof, 3, 100)).toThrow(/lease/); expect(() => f.controller.captureOutput(proof, prepared, output(), "reports/synthetic")).toThrow(/lease/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("explicit recovery commits only an existing unstarted task/link gap without redispatch or refund", () => {
    ensureBaseIssue();
    const notify = vi.fn(), makeTask = vi.fn((...args: Parameters<typeof createWorkflowTask>) => { createWorkflowTask(...args); throw new Error("synthetic crash after task persistence"); });
    const service = createWorkflowService(root, { createTask: makeTask, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    const document = readWorkflowDocument(), owner = Object.values(document.workflows)[0]!, task = listTasks()[0]!, issueBefore = readIssueDocument();
    const recovered = service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision });
    expect(recovered.admission_intents[0]!.status).toBe("committed"); expect(recovered.stages[0]!.task_id).toBe(task.envelope.id); expect(recovered.workflow.counters).toEqual(owner.counters);
    expect(readTask(task.envelope.id)).toEqual(task); expect(readIssueDocument()).toEqual(issueBefore); expect(makeTask).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledExactlyOnceWith(task.envelope.id);
    const bytes = readFileSync(join(state, "workflows/workflows.json")); expect(() => service.recover(owner.id, { expected_revision: recovered.workflow.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision })).toThrow(/provable/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true);
  });
  it("missing reserved task and source drift stay unrecoverable with retained bytes", () => {
    ensureBaseIssue();
    const service = createWorkflowService(root, { createTask: () => { throw new Error("synthetic crash before task persistence"); }, execution: { available: () => true, notify: vi.fn(), cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    const owner = Object.values(readWorkflowDocument().workflows)[0]!, path = join(state, "workflows/workflows.json"), bytes = readFileSync(path);
    writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed synthetic source");
    expect(() => service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/missing/);
    expect(readFileSync(path).equals(bytes)).toBe(true); expect(listTasks()).toEqual([]);
  });
  it("changed sources prevent recovery even when the reserved task and link survived", () => {
    ensureBaseIssue();
    const notify = vi.fn(), service = createWorkflowService(root, { createTask: (...args) => { createWorkflowTask(...args); throw new Error("synthetic task-persistence gap"); }, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed after the persisted reservation");
    const owner = Object.values(readWorkflowDocument().workflows)[0]!, bytes = readFileSync(join(state, "workflows/workflows.json")), task = listTasks()[0]!;
    expect(() => service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(readTask(task.envelope.id)).toEqual(task); expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])("runs Reviewer on an exact real candidate, blocking seals/QA or tree drift mutate=%s", async (mutate) => {
    ensureBaseIssue();
    const repo = join(root, "projects/alpha"), git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" }).toString();
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "base\n"); writeFileSync(join(repo, "verify.mjs"), "process.exit(0)\n"); git("add", "-A"); git("commit", "-m", "synthetic base");
    const context = createContextService(root), issues = createIssueService(root, { context }), issue = issues.get(issueId).issue;
    const input = { kind: "issue" as const, project: "alpha", issue_id: issueId, expected_revision: issue.revision, role_id: "software-engineer", agent: "backend-engineer" }, preview = context.preview(input);
    const engineerTaskId = issues.dispatch(issueId, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint }).taskId, runId = "synthetic-engineer-run", at = new Date().toISOString();
    updateTask(engineerTaskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: runId, worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60000).toISOString() }; });
    const tree = createWorktree(repo, engineerTaskId, "backend-engineer"); writeFileSync(join(tree.worktreePath, "src/value.txt"), "candidate\n"); const committed = commitAndDiff(tree.worktreePath, "synthetic candidate");
    const candidate = issues.recordCandidate({ issueId, taskId: engineerTaskId, executionId: runId, repositoryId: "alpha", scopeRevision: issue.scope_revision, baseRevision: committed.baseRevision!, candidateRevision: committed.candidateRevision!, changedPaths: committed.filesChanged });
    const plan = { mode: "functional" as const, runners: [{ stage: "functional" as const, command: "node verify.mjs" }] }, receipt = createTestingEvidence(readTask(engineerTaskId)!, runId, plan);
    receipt.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
    receipt.implementation = { started_at: at, finished_at: at, thread_id: "synthetic-engineer-thread", turn_id: "synthetic-engineer-turn" };
    const captured = await captureVerification(tree.worktreePath, plan.runners, { controlPlaneRoot: root, expectedRevision: candidate.candidate_revision, signal: new AbortController().signal, deadline: Date.now() + 10000,
      ownsAttempt: () => readTask(engineerTaskId)?.orchestration?.lease?.run_id === runId, authorizeCommand: (command) => command === "node verify.mjs" });
    expect(captured.report.status).toBe("passed"); receipt.observations = captured.observations; const { fingerprint: _fingerprint, ...unsigned } = receipt; updateTask(engineerTaskId, (task) => { task.testing_evidence = sealTestingEvidence(unsigned); });
    issues.recordVerification({ issueId, taskId: engineerTaskId, executionId: runId, candidateId: candidate.id, status: "passed", label: "Real fixture verification", reference: "One passing captured command" });
    mkdirSync(join(root, "reports")); const diffPath = `reports/${engineerTaskId}-${runId}.diff`; writeFileSync(join(root, diffPath), committed.patch);
    updateTask(engineerTaskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); task.orchestration!.lease = null;
      task.envelope.metadata.run = { branch: tree.branch, worktree_path: tree.worktreePath, committed: true, diff_path: diffPath, diff_truncated: false }; });
    const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async (input) => {
      expect(input.cwd).toBe(tree.worktreePath); expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]); expect(input.threadId).toBeUndefined();
      if (mutate) writeFileSync(join(tree.worktreePath, "src/value.txt"), "Mutated during read-only review\n");
      const { recommendations: _recommendations, ...base } = output() as Extract<WorkflowRoleOutput, { kind: "analysis" }>;
      return { finalText: "", structuredOutput: { ...base, kind: "review", verdict: "approve", findings: [] }, threadId: "synthetic-review-thread", turnId: "synthetic-review-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
    }) };
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor });
    const request = { template_id: "quality-review", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: issues.get(issueId).issue.revision, selected_agents: { reviewer: roles.reviewer, "qa-evaluator": roles["qa-evaluator"] }, candidate_id: candidate.id }, proposed = controller.service.preview(request);
    expect(proposed.allowed).toBe(true); const started = controller.service.start({ request, preview_fingerprint: proposed.fingerprint, confirm: true, approval_id: "synthetic-quality-human" });
    const issueBefore = readIssueDocument(); await complete(started.stages[0]!.task_id!); const detail = controller.service.detail(started.workflow.id);
    expect(detail.workflow.status).toBe(mutate ? "needs-decision" : "running"); expect(detail.stages[0]!.output?.kind ?? null).toBe(mutate ? null : "review");
    expect(detail.handoffs).toHaveLength(mutate ? 0 : 1); expect(detail.review_receipts).toHaveLength(mutate ? 0 : 1);
    expect(detail.workflow.counters).toMatchObject({ tasks: mutate ? 1 : 2, attempts: 1, total_tokens: 3, accounting_complete: true });
    if (mutate) expect(await worker.runOnce()).toBe(0); expect(executor.run).toHaveBeenCalledOnce();
    if (mutate) expect(readIssueDocument()).toEqual(issueBefore);
    else {
      const reviewTask = readTask(detail.stages.at(-1)!.task_id!)!;
      expect(detail.stages.at(-1)!.kind).toBe("qa"); expect(reviewTask.lifecycle).toBe("queued");
      expect(issues.get(issueId).issue.evidence_ids.map((id) => readIssueDocument().evidence[id]!.kind)).toContain("review");
    }
    expect(issues.get(issueId).issue.status).toBe("ready-for-review"); expect(git("rev-parse", "HEAD").trim()).toBe(candidate.base_revision); expect(existsSync(tree.worktreePath)).toBe(true);
  }, 20000);
  it("expired/replaced lease retains unknown usage and never replays the role", async () => {
    const f = fixture(); let now = new Date(); const leaseId = "synthetic-lost-run";
    updateTask(f.taskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: leaseId, worker_id: worker!.workerId, acquired_at: now.toISOString(), heartbeat_at: now.toISOString(), expires_at: new Date(now.getTime() + 60000).toISOString() }; });
    f.controller.claimRun(f.taskId, leaseId); now = new Date(now.getTime() - 1000);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = now.toISOString(); });
    expect(worker!.recoverExpiredLeases()).toBe(1); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(f.controller.service.detail(f.id).workflow.counters.accounting_complete).toBe(false); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("a stale recovery snapshot cannot terminalize or block the renewed owning lease", () => {
    const f = fixture(); claim(f);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() - 1000).toISOString(); }); const expired = readTask(f.taskId)!;
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() + 60000).toISOString(); });
    const taskBytes = readFileSync(join(state, `tasks/${f.taskId}.json`)), workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(f.controller.recoverExpired(expired)).toBe(false); expect(readFileSync(join(state, `tasks/${f.taskId}.json`)).equals(taskBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
  });
  it("corrupt workflow bytes fail closed without repair or effects", async () => {
    const f = fixture(), path = join(state, "workflows/workflows.json"), corrupt = '{"schema_version":99}'; writeFileSync(path, corrupt);
    await expect(worker!.runOnce()).rejects.toThrow(); expect(readFileSync(path, "utf8")).toBe(corrupt); expect(f.executor.run).not.toHaveBeenCalled();
  });
});

describe("T007 exact budget exhaustion integration", () => {
  it.each(["tokens", "runtime"] as const)("records exact authorized exhaustion for %s, retaining excess once and refusing all successors", (kind) => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 1000, max_total_tokens: 10 }), { proof, runId } = claim(f);
    expect(f.controller.observe(proof, kind === "tokens" ? 12 : 3, kind === "runtime" ? 1100 : 100)).toBe(true);
    const issues = readIssueDocument(), owner = f.controller.service.detail(f.id), event = issues.events.at(-1)!;
    expect(issues.issues[issueId]!.status).toBe("needs-decision"); expect(event.type).toBe("authorization-stale");
    expect(event.payload).toMatchObject({ workflow_id: f.id, stage_id: f.stageId, task_id: f.taskId, execution_id: runId,
      grant_id: owner.workflow.current_grant_id, scope_revision: 1, budget_exhaustion: { operation: "observe" } });
    expect(owner.events.at(-1)).toMatchObject({ type: "budget-stopped", stage_id: f.stageId, execution_id: runId });
    expect(owner.accounting).toHaveLength(1); expect(owner.workflow.counters).toMatchObject({ attempts: 1, total_tokens: kind === "tokens" ? 12 : 3, runtime_ms: kind === "runtime" ? 1100 : 100 });
    const evidence = issues.evidence[issues.issues[issueId]!.evidence_ids.at(-1)!]!;
    expect(evidence).toMatchObject({ kind: "task", status: "gap", task_id: f.taskId, execution_id: runId });
    const issueBytes = readFileSync(join(state, "issues/issues.json")), workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
    f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
    expect(f.controller.canClaim(readTask(f.taskId)!)).toBe(false); expect(listTasks()).toHaveLength(1); expect(f.executor.run).not.toHaveBeenCalled();
  });

  it.each([["analysis", "authorized", "authorization-stale"], ["trivial-change", "working", "decision-required"]] as const)("keeps %s canClaim read-only, then stops exhausted queued admission with the %s edge", (template, from, eventType) => {
    const f = fixture(template, output(), true, { max_tasks: template === "analysis" ? 1 : 2, max_attempts: template === "analysis" ? 1 : 2, max_runtime_ms: 10000, max_total_tokens: 10 });
    mutateWorkflowDocument((document) => { const owner = document.workflows[f.id]!; owner.counters.attempts = owner.budget.max_attempts; owner.revision++; });
    const taskBytes = readFileSync(join(state, `tasks/${f.taskId}.json`)), beforeIssues = readFileSync(join(state, "issues/issues.json")), beforeWorkflow = readFileSync(join(state, "workflows/workflows.json"));
    expect(readIssueDocument().issues[issueId]!.status).toBe(from); expect(f.controller.canClaim(readTask(f.taskId)!)).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json")).equals(beforeIssues)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(beforeWorkflow)).toBe(true);
    f.controller.reconcile(); const issues = readIssueDocument(), stopped = f.controller.service.detail(f.id);
    expect(issues.issues[issueId]!.status).toBe("needs-decision"); expect(issues.events.at(-1)!.type).toBe(eventType);
    expect(issues.events.at(-1)!.payload).toMatchObject({ workflow_id: f.id, stage_id: f.stageId, task_id: f.taskId, execution_id: null, budget_exhaustion: { operation: "claim" } });
    expect(stopped.workflow.status).toBe("needs-decision"); expect(stopped.accounting).toEqual([]); expect(readFileSync(join(state, `tasks/${f.taskId}.json`)).equals(taskBytes)).toBe(true);
    expect(listTasks()).toHaveLength(1); expect(f.executor.run).not.toHaveBeenCalled(); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
  });

  it("allows the final already-admitted task and charged attempt to finish below runtime/token caps", async () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10 }); await complete(f.taskId);
    const detail = f.controller.service.detail(f.id);
    expect(detail.workflow.status).toBe("waiting-human"); expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true });
    expect(detail.events.some((event) => event.type === "budget-stopped")).toBe(false); expect(readIssueDocument().issues[issueId]!.status).toBe("authorized");
    expect(detail.budget_consumption!.root.canonical.total_tokens).toBe(3); expect(detail.budget_consumption!.review.counters.total_tokens).toBe(0);
    expect(f.executor.run).toHaveBeenCalledOnce(); expect(listTasks()).toHaveLength(1);
  });

  it("retains workflow stop before an issue write fault and retries only its original evidence once", () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 10000, max_total_tokens: 10 }), { proof, runId } = claim(f);
    const issueBytes = readFileSync(join(state, "issues/issues.json"));
    const fault = vi.spyOn(issueState, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic issue persistence interruption"); });
    expect(() => f.controller.observe(proof, 10, 100)).toThrow(/Synthetic issue/); fault.mockRestore();
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision"); expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true);
    new WorkflowOrchestrator(root).reconcile(); const issues = readIssueDocument();
    expect(issues.issues[issueId]!.status).toBe("needs-decision"); expect(issues.events.filter((event) => event.payload.execution_id === runId && event.type === "authorization-stale")).toHaveLength(1);
    const after = readFileSync(join(state, "issues/issues.json"));
    expect(f.controller.observe(proof, 11, 150, true)).toBe(true);
    expect(readFileSync(join(state, "issues/issues.json")).equals(after)).toBe(true); expect(f.controller.service.detail(f.id).workflow.counters.total_tokens).toBe(11);
    f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile(); expect(readFileSync(join(state, "issues/issues.json")).equals(after)).toBe(true);
    expect(f.executor.run).not.toHaveBeenCalled(); expect(listTasks()).toHaveLength(1);
  });

  it("does not rewind an explicitly human-resumed issue after recording its exact exhaustion", () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 10000, max_total_tokens: 10 }), { proof } = claim(f);
    f.controller.observe(proof, 10, 100); const issues = createIssueService(root), stopped = readIssueDocument().issues[issueId]!;
    issues.resolveDecision(issueId, stopped.revision, "synthetic-human-reconsideration", "Inspect the retained exact scope without reviving the stopped workflow");
    const bytes = readFileSync(join(state, "issues/issues.json"));
    new WorkflowOrchestrator(root).reconcile(); f.controller.reconcile();
    expect(readFileSync(join(state, "issues/issues.json")).equals(bytes)).toBe(true); expect(readIssueDocument().issues[issueId]!.status).toBe("authorized");
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision"); expect(f.executor.run).not.toHaveBeenCalled();
  });

  it("preserves stopped workflow bytes when scope facts change before a faulted issue write can be retried", () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 10000, max_total_tokens: 10 }), { proof } = claim(f);
    const fault = vi.spyOn(issueState, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic issue persistence interruption"); });
    expect(() => f.controller.observe(proof, 10, 100)).toThrow(/Synthetic issue/); fault.mockRestore();
    issueState.mutateIssueDocument((document) => { document.issues[issueId]!.authorized_scope.allowed_path_patterns.push("other/**"); });
    const issueBytes = readFileSync(join(state, "issues/issues.json")), workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
    f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
    expect(f.executor.run).not.toHaveBeenCalled(); expect(listTasks()).toHaveLength(1);
  });

  it("stops a real candidate's Reviewer at its root token limit with the exact checking decision and no QA admission", async () => {
    const f = await correctionFixture({ rootTokenCap: 9, stopBeforeReview: true }), detail = await f.advance("review");
    const stage = detail.stages.at(-1)!, issues = readIssueDocument(), event = issues.events.at(-1)!;
    expect(stage.kind).toBe("review"); expect(detail.workflow.status).toBe("needs-decision"); expect(issues.issues[issueId]!.status).toBe("needs-decision");
    expect(event.type).toBe("verification-needs-decision"); expect(event.payload).toMatchObject({ workflow_id: f.workflowId, stage_id: stage.id, task_id: stage.task_id,
      execution_id: stage.execution_id, candidate_id: f.original.candidate_id });
    expect(detail.budget_consumption!.root.canonical.total_tokens).toBe(9); expect(detail.budget_consumption!.review.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3 });
    expect(detail.lineage!.corrections_consumed).toBe(0); expect(detail.workflow.candidate).toEqual(f.original);
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(3); expect(listTasks()).toHaveLength(3);
    expect(detail.stages.some((entry) => entry.kind === "qa" || entry.kind === "correction")).toBe(false);
  }, 90000);

  it.each(["review", "qa"] as const)("stops %s at its independent P review token cap below O root without another role or correction", async (kind) => {
    const f = await correctionFixture({ stopBeforeReview: kind === "review" }); await worker!.stop();
    const stage = f.checkpoint().stages.at(-1)!; expect(stage.kind).toBe(kind);
    cpSync("registry/budget-policy.yml", join(root, "registry/budget-policy.yml"));
    const configured = parse(readFileSync(join(root, "registry/budget-policy.yml"), "utf8"));
    configured.rules[0].limits.review_total_tokens = { status: "configured", hard_cap: 3 };
    writeFileSync(join(root, "registry/budget-policy.yml"), JSON.stringify(configured));
    const source = readBudgetPolicy(root), task = readTask(stage.task_id!)!, admission = task.envelope.context_admission!;
    if (admission.schema_version !== 2) throw new Error("Synthetic review lost its exact workflow binding");
    const prepared = prepareTaskBudgetAdmission(task, { source, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"],
      issue_id: issueId, role_id: admission.role_id, execution_id: task.envelope.id } });
    const path = join(state, "budgets/budgets.json");
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source }), path, prepared.admission.created_at);
    writeTask(prepared.task); mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: prepared.admission, persisted_admission: readTask(task.envelope.id)!.envelope.budget_admission }), path, prepared.admission.created_at);
    const budgets = new BudgetExecutionScaffold({ resolve: () => ({ source }) }), controller = new WorkflowOrchestrator(root);
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, budgets, executor: f.executor, maxConcurrent: 1 });
    expect(await worker.runOnce()).toBe(1);
    await vi.waitFor(() => expect(readTask(task.envelope.id)!.lifecycle).toBe("finished"), { timeout: 15000 });
    const detail = controller.service.detail(f.workflowId), issues = readIssueDocument(), event = issues.events.at(-1)!;
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.workflow.counters.total_tokens).toBeLessThan(detail.workflow.budget.max_total_tokens);
    expect(issues.issues[issueId]!.status).toBe("needs-decision"); expect(event.type).toBe("verification-needs-decision");
    expect(event.payload).toMatchObject({ workflow_id: f.workflowId, stage_id: stage.id, task_id: task.envelope.id, candidate_id: f.original.candidate_id,
      independent_budget_exhaustion: { denials: expect.arrayContaining([expect.objectContaining({ dimension: "review_total_tokens", cap: 3, proven_consumed: 3 })]) } });
    const ledger = readBudgetLedger(path)!; expect(Object.values(ledger.charges)).toHaveLength(1);
    expect(Object.values(ledger.charges)[0]).toMatchObject({ review: true, observed_total_tokens: 3 });
    expect(detail.budget_consumption!.review.counters.total_tokens).toBe(kind === "review" ? 3 : 6); expect(detail.lineage!.corrections_consumed).toBe(0);
    const issueBytes = readFileSync(join(state, "issues/issues.json")), workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
    new WorkflowOrchestrator(root).reconcile(); controller.reconcile();
    expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true); expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
    expect(await worker.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(kind === "review" ? 3 : 4); expect(listTasks()).toHaveLength(kind === "review" ? 3 : 4);
  }, 90000);
});

type CorrectionCheckpoint = Pick<ReturnType<ReturnType<typeof createWorkflowService>["detail"]>, "workflow" | "stages" | "decisions" | "review_receipts" | "lineage">;
type CorrectionPosition = { ordinal: number; stage: CorrectionProgressStage };
function observeCorrection<T>(progress: CorrectionProgress | undefined, position: CorrectionPosition, operation: CorrectionProgressOperation, action: () => T, lane: CorrectionProgressLane = "fixture"): T {
  if (!progress) return action();
  progress.record(lane, position.ordinal, position.stage, operation, "begin");
  try { const result = action(); progress.record(lane, position.ordinal, position.stage, operation, "return"); return result; }
  catch (error) { progress.record(lane, position.ordinal, position.stage, operation, "throw"); throw error; }
}
function observeCorrectionAsync<T>(progress: CorrectionProgress | undefined, position: CorrectionPosition, operation: CorrectionProgressOperation, action: () => Promise<T>): Promise<T> {
  if (!progress) return action();
  progress.record("fixture", position.ordinal, position.stage, operation, "begin");
  let pending: Promise<T>;
  try { pending = action(); } catch (error) { progress.record("fixture", position.ordinal, position.stage, operation, "throw"); throw error; }
  return pending.then((result) => { progress.record("fixture", position.ordinal, position.stage, operation, "return"); return result; },
    (error) => { progress.record("fixture", position.ordinal, position.stage, operation, "throw"); throw error; });
}
function readCorrectionCheckpoint(workflowId: string, read: () => ReturnType<typeof readWorkflowDocument> = readWorkflowDocument): CorrectionCheckpoint {
  const document = read(), workflow = document.workflows[workflowId];
  if (!workflow || workflow.id !== workflowId) throw new Error("Synthetic correction checkpoint workflow is unavailable");
  return { workflow, stages: Object.values(document.stages).filter((entry) => entry.workflow_id === workflowId),
    decisions: Object.values(document.decisions).filter((entry) => entry.workflow_id === workflowId),
    review_receipts: Object.values(document.review_receipts).filter((entry) => entry.workflow_id === workflowId),
    lineage: workflow.lineage_id ? document.lineages[workflow.lineage_id] : null };
}
const correctionBaseFiles = Object.freeze({
  "AGENTS.md": workflowFixtureProjectRules,
  "src/value.txt": "base\n",
  "verify.mjs": "import {readFileSync} from 'node:fs'; process.exit(readFileSync('src/value.txt','utf8').includes('broken') ? 1 : 0)\n",
});

async function correctionFixture(options: { enabled?: boolean; findingPath?: string; repeatFinding?: boolean; protectedEdit?: boolean; failedVerification?: boolean; correctionTokenCap?: number; qaFinding?: boolean; rootTokenCap?: number; stopBeforeReview?: boolean; checkpointSetup?: boolean } = {}, progress?: CorrectionProgress) {
  let position: CorrectionPosition = { ordinal: 0, stage: "setup" }, advances = 0;
  const observe = <T,>(operation: CorrectionProgressOperation, action: () => T) => observeCorrection(progress, position, operation, action);
  const observeAsync = <T,>(operation: CorrectionProgressOperation, action: () => Promise<T>) => observeCorrectionAsync(progress, position, operation, action);
  const mark = (operation: CorrectionProgressOperation, edge: CorrectionProgressEdge) => progress?.record("fixture", position.ordinal, position.stage, operation, edge);
  const taskPositions = new Map<string, CorrectionPosition>();
  const tracer: Tracer = { startSpan: (name, attributes) => {
    const taskId = attributes?.task_id, bound = typeof taskId === "string" ? taskPositions.get(taskId) : undefined;
    if (!progress || name !== "task.attempt" || !bound) return { context: null, addEvent: () => {}, end: () => {} };
    progress.record("attempt", bound.ordinal, bound.stage, "task-attempt", "begin");
    let ended = false;
    return { context: null, addEvent: (event) => {
      if (ended) return;
      if (event === "task.started" || event === "policy.evaluated" || event === "worktree.created" || event === "git.diff" || event === "verification.finished" || event === "task.finished")
        progress.record("attempt", bound.ordinal, bound.stage, event, "milestone");
    }, end: () => { if (!ended) { ended = true; progress.record("attempt", bound.ordinal, bound.stage, "task-attempt", "return"); } } };
  } };
  const repo = join(root, "projects/alpha");
  const runGit = (repository: string, controlRoot: string, args: string[]) =>
    execFileSync("git", managedGitArgs(["-C", repository, ...args], controlRoot), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" });
  const git = (...args: string[]) => observe("drift-git", () => runGit(repo, root, args).toString().trim());
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/value.txt"), correctionBaseFiles["src/value.txt"], { flag: "wx", mode: 0o644 });
  writeFileSync(join(repo, "verify.mjs"), correctionBaseFiles["verify.mjs"], { flag: "wx", mode: 0o644 });
  observe("setup-git", () => correctionGitBaselines.attach({
    caseRoot: root, repository: repo, key: "workflow-correction-main", files: correctionBaseFiles,
    initialize: ({ repository, root: seedRoot }) => {
      runGit(repository, seedRoot, ["init", "-b", "main"]);
      runGit(repository, seedRoot, ["config", "user.email", "fixture@example.invalid"]);
      runGit(repository, seedRoot, ["config", "user.name", "Synthetic fixture"]);
      runGit(repository, seedRoot, ["add", "-A"]);
      runGit(repository, seedRoot, ["commit", "-m", "synthetic correction base"]);
    },
  }));
  if (options.correctionTokenCap) {
    const path = join(root, "registry/workflow-policy.yml"), policy = parse(readFileSync(path, "utf8"));
    policy.correction_budget.max_total_tokens = options.correctionTokenCap; writeFileSync(path, JSON.stringify(policy));
  }
  const issues = createIssueService(root), proposed = observe("issue-create", () => issues.create({ project_id: "alpha", title: "Synthetic correction workflow", expected_outcome: "Observable synthetic result",
    acceptance_criteria: ["Observable acceptance", "Retain the exact authorized scope"], assigned_role_id: "backend-engineer", plan: ["Change only authorized paths"], next_action: "Review the exact candidate", criticality: "high", classification_inputs: { requires_migration: true },
    authorized_scope: { expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance", "Retain the exact authorized scope"], allowed_path_patterns: ["**"], excluded_path_patterns: ["outside/**"], allowed_change_categories: ["implementation", "migration"], explicit_exclusions: [] } }));
  issueId = proposed.id; observe("issue-authorize", () => issues.authorize(issueId, proposed.revision, "synthetic-correction-scope-human"));
  let workflowId = "";
  const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async (input) => {
    const bound = [...taskPositions.values()].at(-1) ?? position;
    return observeCorrection(progress, bound, "executor", () => {
    const document = readWorkflowDocument(), owner = document.workflows[workflowId]!, stage = document.stages[owner.current_stage_id!]!;
    const base = { schema_version: 1 as const, status: "completed" as const, summary: `Synthetic ${stage.kind}`, evidence_ids: [] as string[], unresolved_questions: [], risks: [], recommended_next_action: "Inspect the exact next gate", requested_decision: null };
    let structuredOutput: unknown;
    expect(input.threadId).toBeUndefined();
    if (stage.kind === "planning") structuredOutput = { ...base, kind: "plan", plan: ["Change the bounded value"], scope_change_required: false };
    else if (stage.kind === "implementation" || stage.kind === "correction") {
      if (stage.kind === "correction") {
        expect(readFileSync(join(input.cwd, "src/value.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("candidate\n");
        expect(existsSync(join(input.cwd, "source-only.txt"))).toBe(false);
        expect(owner.candidate).toEqual(stage.candidate); expect(document.lineages[owner.lineage_id!]!.corrections_consumed).toBe(1);
        const issueBytes = readFileSync(join(state, "issues/issues.json"));
        expect(() => issues.recordCandidate({ issueId, taskId: stage.task_id!, executionId: stage.execution_id!, repositoryId: "alpha", scopeRevision: 1,
          baseRevision: "f".repeat(40), candidateRevision: "e".repeat(40), changedPaths: ["src/value.txt"] })).toThrow(/exact prior candidate/);
        expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true);
      }
      writeFileSync(join(input.cwd, "src/value.txt"), stage.kind === "implementation" ? "candidate\n" : options.failedVerification ? "broken\n" : "corrected\n");
      if (stage.kind === "correction" && options.protectedEdit) { mkdirSync(join(input.cwd, "schemas")); writeFileSync(join(input.cwd, "schemas/changed.json"), "{}\n"); }
      structuredOutput = { status: "completed", summary: "Synthetic bounded writer", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
    } else {
      const facts = readIssueDocument(), evidence = facts.issues[issueId]!.evidence_ids.map((id) => facts.evidence[id]!)
        .find((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === owner.candidate!.candidate_id)!;
      expect(evidence).toBeDefined(); expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]);
      const correct = (stage.kind === "review" && !options.qaFinding || stage.kind === "qa" && options.qaFinding) && (stage.ordinal <= 4 || options.repeatFinding);
      const findings = correct ? [{ id: `finding-${stage.ordinal}`, severity: "blocking", summary: "Correct the exact bounded behavior", path: options.findingPath ?? "src/value.txt", evidence_ids: [evidence.id], scope_change_required: false }] : [];
      structuredOutput = { ...base, kind: stage.kind, evidence_ids: [evidence.id], verdict: correct ? "correction-required" : "approve", findings,
        ...(stage.kind === "qa" ? { criteria: facts.issues[issueId]!.acceptance_criteria.map((criterion) => ({ criterion, status: correct ? "contradictory" : "supported", evidence_ids: [evidence.id] })) } : {}) };
    }
    return { finalText: "Never promote raw fallback", structuredOutput, threadId: `synthetic-${stage.id}`, turnId: `synthetic-${stage.id}-turn`,
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
    }, "attempt");
  }) };
  worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1, ...(progress ? { tracer } : {}) });
  const request = { template_id: "implementation", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
    selected_agents: { planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" }, correction_enabled: options.enabled ?? true,
    ...(options.rootTokenCap ? { budget: { ...parse(readFileSync(join(root, "registry/workflow-policy.yml"), "utf8")).default_budget, max_total_tokens: options.rootTokenCap } } : {}) };
  const preview = observe("preview", () => controller.service.preview(request)); expect(preview.allowed, preview.blocked_reasons.join("; ")).toBe(true);
  const started = observe("start", () => controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-correction-human" })); workflowId = started.workflow.id;
  const profileDetails = process.env.SURTEC_TEST_DETAIL_PROFILE === "1";
  let detailCalls = 0;
  const detail = () => { if (profileDetails) detailCalls++; return controller.service.detail(workflowId); };
  const checkpoint = () => observe("checkpoint", () => readCorrectionCheckpoint(workflowId));
  let initialCheckpoint: CorrectionCheckpoint | undefined, initialCheckpointBytes: string | undefined;
  if (options.checkpointSetup) {
    mark("checkpoint-contract", "begin");
    const read = vi.fn(() => readWorkflowDocument()), projected = readCorrectionCheckpoint(workflowId, read);
    expect(read).toHaveBeenCalledOnce();
    expect(Object.keys(projected)).toEqual(["workflow", "stages", "decisions", "review_receipts", "lineage"]);
    expect(projected).toEqual({ workflow: started.workflow, stages: started.stages, decisions: started.decisions, review_receipts: started.review_receipts, lineage: started.lineage });
    expect(() => readCorrectionCheckpoint("synthetic-checkpoint-missing", () => read.mock.results[0]!.value)).toThrow("Synthetic correction checkpoint workflow is unavailable");
    initialCheckpoint = projected; initialCheckpointBytes = JSON.stringify(projected);
    const discarded = checkpoint(); expect(discarded).toEqual(projected); expect(discarded.workflow).not.toBe(projected.workflow);
    discarded.workflow.next_action = "Synthetic discarded observation mutation";
    expect(checkpoint()).toEqual(projected); expect(JSON.stringify(projected)).toBe(initialCheckpointBytes);
    mark("checkpoint-contract", "return");
  }
  const advanceWithCheckpoint = async <T,>(kind: Exclude<CorrectionProgressStage, "setup">, readCheckpoint: () => T): Promise<T> => {
    position = { ordinal: ++advances, stage: kind };
    const stage = observe("select-stage", () => { const selected = selectQueuedStage(workflowId, kind); expect(selected.kind).toBe(kind); expect(selected.status).toBe("queued"); return selected; });
    position = { ordinal: stage.ordinal, stage: kind }; if (progress) taskPositions.set(stage.task_id!, position);
    expect(await observeAsync("run-once", () => worker!.runOnce())).toBe(1);
    await observeAsync("wait-terminal", () => vi.waitFor(() => {
      // The attempt finalizer releases ownership and reconciles synchronously before the next observation.
      if (worker!.activeCount !== 0) throw new Error("Synthetic workflow attempt is still active");
      expect(readTask(stage.task_id!)?.lifecycle).toBe("finished");
    }, { timeout: 15000 }));
    return readCheckpoint();
  };
  type StageKind = Exclude<CorrectionProgressStage, "setup">;
  const advance = (kind: StageKind) => advanceWithCheckpoint(kind, detail);
  const advanceCheckpoint = (kind: StageKind) => advanceWithCheckpoint(kind, checkpoint);
  const advanceStage = (kind: StageKind) => advanceWithCheckpoint(kind, () => {});
  const planned = await advanceCheckpoint("planning"), plan = planned.decisions[0]!;
  if (options.checkpointSetup) {
    expect(JSON.stringify(initialCheckpoint)).toBe(initialCheckpointBytes);
    const current = checkpoint(); expect(current).toEqual(planned);
    expect(current.workflow.revision).toBeGreaterThan(initialCheckpoint!.workflow.revision); expect(current.workflow).not.toBe(initialCheckpoint!.workflow);
  }
  observe("plan-decision", () => controller.service.decide(workflowId, { expected_revision: planned.workflow.revision, expected_issue_revision: plan.expected_issue_revision, decision_id: plan.id,
    resource_fingerprint: plan.resource_fingerprint, decision: "approve", approval_id: "synthetic-plan-human", rationale: "Exact unchanged bounded plan", confirm: true })); observe("reconcile", () => controller.reconcile());
  const implemented = await advanceCheckpoint("implementation"); expect(implemented.workflow.status, implemented.workflow.blocked_reason ?? "").toBe("running");
  const original = implemented.workflow.candidate!;
  if (!options.stopBeforeReview) { const reviewed = await advanceCheckpoint("review"); expect(reviewed.stages.at(-1)!.kind).toBe("qa"); expect(reviewed.lineage!.corrections_consumed).toBe(0); }
  return { controller, executor, workflowId, original, advance, checkpoint, advanceCheckpoint, advanceStage, observe, observeAsync, mark, git, repo, get detailCalls() { return detailCalls; } };
}

describe("T010 one bounded correction under existing authority", () => {
  it.each([false, true])("consumes once before queueing, uses the prior candidate and requires fresh verification and both reviews QA-request=%s", async (qaFinding) => {
    const progress = createCorrectionProgressEmitter(qaFinding ? "qa-true" : "qa-false", (line) => { console.log(line); }, correctionCaseId);
    correctionProgress = progress; progress.record("fixture", 0, "setup", "case", "begin");
    const f = await correctionFixture({ qaFinding, checkpointSetup: true }, progress), reserved = await f.advanceCheckpoint("qa"), stage = reserved.stages.at(-1)!;
    f.mark("assertions", "begin");
    expect(reserved.workflow.status, reserved.workflow.blocked_reason ?? "").toBe("running"); expect(stage.kind).toBe("correction");
    expect(reserved.lineage).toMatchObject({ corrections_consumed: 1, consumed_stage_id: stage.id });
    const issueCheckpoint = readIssueDocument();
    expect(issueCheckpoint.issues[issueId]!.status).toBe("working"); expect(issueCheckpoint.candidates[f.original.candidate_id]!.invalidated_at).toBeNull();
    const bytes = readFileSync(join(state, "workflows/workflows.json")); f.observe("idempotence", () => { f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile(); });
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); expect(listTasks()).toHaveLength(5);
    writeFileSync(join(f.repo, "source-only.txt"), "unrelated HEAD\n"); f.git("add", "-A"); f.git("commit", "-m", "synthetic source HEAD drift");
    f.mark("assertions", "return");
    const correctedFacts = await f.advanceCheckpoint("correction"); expect(correctedFacts.workflow.status, correctedFacts.workflow.blocked_reason ?? "").toBe("running"); const corrected = correctedFacts.workflow.candidate!;
    f.mark("assertions", "begin");
    expect(corrected.base_revision).toBe(f.original.candidate_revision); expect(corrected.task_id).not.toBe(f.original.task_id);
    expect(corrected.candidate_id).not.toBe(f.original.candidate_id); expect(corrected.testing_evidence_fingerprint).not.toBe(f.original.testing_evidence_fingerprint);
    expect(readIssueDocument().candidates[f.original.candidate_id]!.invalidated_at).not.toBeNull();
    expect(correctedFacts.lineage!.candidate_ids).toEqual([f.original.candidate_id, corrected.candidate_id]);
    expect(correctedFacts.review_receipts.every((receipt) => receipt.candidate.candidate_id === f.original.candidate_id)).toBe(true);
    f.mark("assertions", "return");
    await f.advanceStage("review"); const reviewed = await f.advanceCheckpoint("qa");
    f.mark("assertions", "begin");
    expect(reviewed.workflow.status, reviewed.workflow.blocked_reason ?? "").toBe("waiting-human");
    expect(reviewed.review_receipts.filter((receipt) => receipt.candidate.candidate_id === corrected.candidate_id).map((receipt) => receipt.role_id)).toEqual(["reviewer", "qa-evaluator"]);
    expect(readIssueDocument().issues[issueId]!.status).toBe("ready-for-review"); expect(reviewed.decisions.at(-1)!.kind).toBe("candidate-acceptance");
    expect(reviewed.workflow.counters).toMatchObject({ tasks: 7, attempts: 7, total_tokens: 21, accounting_complete: true });
    expect(f.executor.run).toHaveBeenCalledTimes(7); expect(listTasks()).toHaveLength(7);
    const finalBytes = readFileSync(join(state, "workflows/workflows.json")); f.observe("idempotence", () => new WorkflowOrchestrator(root).reconcile());
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(finalBytes)).toBe(true); expect(await f.observeAsync("run-once", () => worker!.runOnce())).toBe(0);
    f.mark("assertions", "return");
    const current = f.checkpoint(), decision = current.decisions.at(-1)!;
    f.observe("final-decision", () => f.controller.service.decide(f.workflowId, { expected_revision: current.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-final-human", rationale: "All exact current criteria reviewed", confirmed_criteria: ["Observable acceptance", "Retain the exact authorized scope"], confirm: true }));
    const accepted = f.checkpoint(); expect(accepted.workflow.status).toBe("completed"); expect(accepted.lineage!.corrections_consumed).toBe(1);
    if (process.env.SURTEC_TEST_DETAIL_PROFILE === "1") console.info(`WORKFLOW_DETAIL_PROFILE ${JSON.stringify({
      variant: qaFinding ? "qa-true" : "qa-false", phase: "after-final-assertions", test_owned_detail_calls: f.detailCalls,
    })}`);
    progress.record("fixture", 0, "setup", "case", "return");
  }, 90000);

  it.each([{ enabled: false }, { findingPath: "schemas/authority.json" }, { findingPath: "outside/value.txt" }])("denies unavailable correction authority without a new task %#", async (options) => {
    const f = await correctionFixture({ ...options, checkpointSetup: true }), detail = await f.advanceCheckpoint("qa");
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.lineage!.corrections_consumed).toBe(0);
    expect(detail.workflow.candidate).toEqual(f.original); expect(readIssueDocument().issues[issueId]!.status).toBe("checking");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(4); expect(listTasks()).toHaveLength(4);
  }, 90000);

  it.each([{ protectedEdit: true }, { failedVerification: true }, { repeatFinding: true }, { correctionTokenCap: 3 }])("retains consumption and stops after unsuccessful correction %#", async (options) => {
    const f = await correctionFixture({ ...options, checkpointSetup: true });
    await f.advanceStage("qa");
    if (options.repeatFinding) await f.advanceStage("correction");
    const detail = await f.advanceCheckpoint(options.repeatFinding ? "review" : "correction");
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.lineage!.corrections_consumed).toBe(1);
    if (options.correctionTokenCap) {
      expect(detail.workflow.counters.total_tokens).toBeLessThan(detail.workflow.budget.max_total_tokens);
      expect(detail.workflow.blocked_reason).toContain("budget");
      expect(detail.workflow.candidate).toEqual(f.original);
    }
    expect(detail.workflow.counters.tasks).toBe(options.repeatFinding ? 6 : 5); expect(await worker!.runOnce()).toBe(0);
    expect(() => worker!.retry(detail.stages.at(-1)!.task_id!)).toThrow(/controller/);
    const bytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(() => mutateWorkflowDocument((document) => { document.lineages[detail.workflow.lineage_id!]!.corrections_consumed = 0; })).toThrow();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(bytes)).toBe(true); new WorkflowOrchestrator(root).reconcile();
    expect(f.checkpoint().lineage!.corrections_consumed).toBe(1);
  }, 90000);

  it("retains consumption through partial admission, durable cancellation and reconstruction", async () => {
    const f = await correctionFixture();
    const notify = vi.fn(), makeTask = vi.fn(() => { throw new Error("synthetic failure before task persistence"); });
    const service = createWorkflowService(root, { createTask: makeTask, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    vi.spyOn(f.controller.service, "admitCorrection").mockImplementation(service.admitCorrection);
    const detail = await f.advanceCheckpoint("qa"); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.lineage!.corrections_consumed).toBe(1);
    expect(detail.stages.at(-1)!.status).toBe("reserved"); expect(listTasks()).toHaveLength(4); expect(makeTask).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    service.cancel(f.workflowId, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    new WorkflowOrchestrator(root).reconcile(); const cancelled = f.checkpoint(); expect(cancelled.workflow.status).toBe("cancelled"); expect(cancelled.lineage!.corrections_consumed).toBe(1);
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(4);
  }, 90000);
});

describe("T013 correction completion and exhausted-authority recovery", () => {
  it("seals a completed correction after a lost callback and reserves its exact review successor only once across restart", async () => {
    const f = await correctionFixture(), reserved = await f.advanceCheckpoint("qa");
    const correction = reserved.stages.at(-1)!, callback = vi.spyOn(f.controller, "reconcile").mockImplementation(() => {});
    await f.advanceStage("correction"); callback.mockRestore();
    const unreconciled = f.checkpoint(); expect(unreconciled.stages.at(-1)!.status).toBe("running"); expect(unreconciled.workflow.candidate).toEqual(f.original);
    const terminal = readTask(correction.task_id!)!; expect(terminal).toMatchObject({ lifecycle: "finished", outcome: "completed" });
    expect(terminal.orchestration!.lease).toBeNull(); expect(terminal.testing_evidence!.candidate!.base_revision).toBe(f.original.candidate_revision);
    const restarted = new WorkflowOrchestrator(root); restarted.reconcile();
    const reconciled = restarted.service.detail(f.workflowId), corrected = reconciled.workflow.candidate!;
    expect(corrected.candidate_id).toBe(terminal.testing_evidence!.candidate!.id); expect(corrected.task_id).toBe(correction.task_id);
    expect(corrected.base_revision).toBe(f.original.candidate_revision); expect(corrected.candidate_id).not.toBe(f.original.candidate_id);
    expect(reconciled.lineage).toMatchObject({ corrections_consumed: 1, consumed_stage_id: correction.id, candidate_ids: [f.original.candidate_id, corrected.candidate_id] });
    expect(reconciled.stages.at(-1)).toMatchObject({ kind: "review", status: "queued", predecessor_stage_id: correction.id, candidate: corrected });
    expect(reconciled.workflow.counters).toMatchObject({ tasks: 6, attempts: 5, total_tokens: 15, accounting_complete: true });
    expect(reconciled.accounting).toHaveLength(5); expect(reconciled.accounting.every((charge) => charge.usage_complete)).toBe(true);
    const workflowBytes = readFileSync(join(state, "workflows/workflows.json")), issueBytes = readFileSync(join(state, "issues/issues.json")), identities = listTasks().map((task) => task.envelope.id).sort();
    for (const duplicate of [f.controller, restarted, new WorkflowOrchestrator(root)]) duplicate.reconcile();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true); expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true);
    expect(listTasks().map((task) => task.envelope.id).sort()).toEqual(identities); expect(f.executor.run).toHaveBeenCalledTimes(5);
    expect(() => restarted.service.admitCorrection(f.workflowId)).toThrow(/current/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true);
    await f.advanceStage("review"); const reviewed = await f.advanceCheckpoint("qa");
    expect(reviewed.workflow.status).toBe("waiting-human"); expect(reviewed.decisions.at(-1)!.kind).toBe("candidate-acceptance");
    expect(reviewed.workflow.counters).toMatchObject({ tasks: 7, attempts: 7, total_tokens: 21, accounting_complete: true });
    expect(f.executor.run).toHaveBeenCalledTimes(7);
  }, 90000);

  it("does not replay an exhausted second correction request through duplicate ticks, a fresh worker or explicit recovery", async () => {
    const f = await correctionFixture({ repeatFinding: true });
    await f.advanceStage("qa"); await f.advanceStage("correction"); const exhausted = await f.advance("review");
    const current = exhausted.stages.at(-1)!;
    expect(exhausted.workflow.status).toBe("needs-decision"); expect(exhausted.workflow.blocked_reason).toContain("single correction");
    expect(exhausted.lineage!.corrections_consumed).toBe(1); expect(exhausted.workflow.counters).toMatchObject({ tasks: 6, attempts: 6, total_tokens: 18, accounting_complete: true });
    const workflowBytes = readFileSync(join(state, "workflows/workflows.json")), issueBytes = readFileSync(join(state, "issues/issues.json")), identities = listTasks().map((task) => task.envelope.id).sort();
    await worker!.stop();
    const restarted = new WorkflowOrchestrator(root); worker = new TaskOrchestrator({ repoRoot: root, workflows: restarted, executor: f.executor, maxConcurrent: 1 });
    for (const duplicate of [f.controller, restarted, new WorkflowOrchestrator(root)]) duplicate.reconcile();
    expect(await worker.runOnce()).toBe(0); expect(() => worker!.retry(current.task_id!)).toThrow(/controller/);
    expect(() => restarted.service.admitCorrection(f.workflowId)).toThrow(/current/);
    const recoveryFacts = restarted.service.detail(f.workflowId);
    expect(() => restarted.service.recover(f.workflowId, { expected_revision: recoveryFacts.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/provable/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflowBytes)).toBe(true); expect(readFileSync(join(state, "issues/issues.json")).equals(issueBytes)).toBe(true);
    expect(listTasks().map((task) => task.envelope.id).sort()).toEqual(identities); expect(f.executor.run).toHaveBeenCalledTimes(6);
    const retained = restarted.service.detail(f.workflowId);
    expect(retained.workflow.candidate).toEqual(exhausted.workflow.candidate);
    expect(retained.review_receipts).toEqual(exhausted.review_receipts); expect(retained.accounting).toEqual(exhausted.accounting);
  }, 90000);
});
