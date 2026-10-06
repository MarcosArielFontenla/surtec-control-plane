import { randomUUID } from "node:crypto";
import type { AgentExecutor } from "./agent-executor";
import type { TaskRecord } from "../lib/state/types";
import { appendTaskEvent } from "../lib/state/events";
import { ensureTaskOrchestration } from "../lib/state/orchestration";
import { listTasks, readTask, StateLockConflictError, updateTask, withStateLock } from "../lib/state/store";
import { cancelledResult, failureResult } from "./result";
import { codexExecutor } from "./codex-executor";
import { runTask, type TaskRunCompletion, type TaskRunOptions } from "./run-task";
import type { Tracer } from "../lib/observability/tracing";
import { redactContextText } from "../lib/context/assemble";
import type { WorkflowOrchestrator } from "./workflow-orchestrator";
import { readWorkflowDocument } from "../lib/state/workflows";
import { canonicalPath } from "../lib/security/paths";
import { expandHome } from "../lib/expand-home";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { assertTaskBudgetAdmissionBinding } from "../lib/state/validation";
import { budgetStatePath } from "../lib/state/paths";
import { mutateBudgetLedger, readBudgetLedger, readBudgetTransaction } from "../lib/state/budgets";
import { claimTaskBudget, markBudgetUnknown, observeBudgetRun, settleBudgetReservation, topUpTaskBudget } from "../lib/budgets/reservations";
import { resolveBudgetPolicy, type BudgetPolicySource, type ExistingBudgetConstraint, type BudgetCorrectionLineage } from "../lib/budgets/policy";
import { BUDGET_DIMENSIONS, type BudgetAdmission, type BudgetAmounts, type BudgetLedger } from "../lib/budgets/types";
import { assertBudgetLedger } from "../lib/budgets/validation";

export interface BudgetExecutionPolicy {
  source: BudgetPolicySource;
  constraints?: ExistingBudgetConstraint[];
  correction_lineages?: BudgetCorrectionLineage[];
}
export interface BudgetExecutionScaffoldOptions {
  filePath?: string;
  now?: () => Date;
  resolve: (task: TaskRecord) => BudgetExecutionPolicy;
}
interface BudgetExecutionIdentity {
  owner: BudgetExecutionScaffold;
  kind: "claim" | "run";
  taskId: string;
  runId: string;
  workerId: string;
  admission: BudgetAdmission;
  snapshot: TaskRecord;
  attempt: number;
  runtimeCap: number;
  tokens: number;
  baseTokens: number;
  terminal?: TaskRecord;
  terminalUnknown?: boolean;
}
const budgetExecutions = new WeakMap<object, BudgetExecutionIdentity>();
const budgetControllers = new WeakSet<object>();
const hasBudgetAdmission = (task: TaskRecord) => Object.getOwnPropertyDescriptor(task.envelope, "budget_admission") !== undefined;
const budgetZero = (): BudgetAmounts => Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as BudgetAmounts;

/** Private application composition only. No production caller enables this scaffold. */
export function budgetExecutionOwner(proof: unknown, taskId: string, runId: string): BudgetExecutionScaffold | null {
  const identity = proof && typeof proof === "object" && !nodeTypes.isProxy(proof) ? budgetExecutions.get(proof) : undefined;
  return identity?.kind === "run" && identity.taskId === taskId && identity.runId === runId ? identity.owner : null;
}
/** A workflow proof cannot substitute for the independent budget identity. */
export function assertBudgetWorkflowExecution(task: TaskRecord, proof?: object): void {
  if (!hasBudgetAdmission(task)) return;
  const identity = proof && !nodeTypes.isProxy(proof) ? budgetExecutions.get(proof) : undefined;
  if (!identity || identity.taskId !== task.envelope.id || !isDeepStrictEqual(identity.admission, task.envelope.budget_admission)
    || identity.kind === "run" && (task.lifecycle !== "running" || task.orchestration?.lease?.run_id !== identity.runId
      || task.orchestration.lease.worker_id !== identity.workerId || task.orchestration.attempts !== identity.attempt)) {
    throw new TaskControlError("Budget-bound workflow requires its independent private controller identity", 409);
  }
}

/** T006 fixtures only: serialized data, a lease and environment flags never mint authority. */
export class BudgetExecutionScaffold {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly resolve: BudgetExecutionScaffoldOptions["resolve"];
  private readonly retries = new Map<string, string>();
  constructor(options: BudgetExecutionScaffoldOptions) {
    const descriptors = options && !nodeTypes.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype ? Object.getOwnPropertyDescriptors(options) : null;
    if (!descriptors || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !["resolve", "filePath", "now"].includes(key)
      || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))
      || typeof descriptors.resolve?.value !== "function" || nodeTypes.isProxy(descriptors.resolve.value)
      || nodeTypes.isAsyncFunction(descriptors.resolve.value) || nodeTypes.isGeneratorFunction(descriptors.resolve.value)) {
      throw new TaskControlError("Budget scaffold requires a synchronous trusted policy resolver", 409);
    }
    this.filePath = options.filePath ?? budgetStatePath();
    this.now = options.now ?? (() => new Date()); this.resolve = options.resolve;
    budgetControllers.add(this);
  }
  private refuse(): never { throw new TaskControlError("Budget execution facts, policy or ownership are unavailable; retained holds require review", 409); }
  private identity(proof: object): BudgetExecutionIdentity {
    const identity = !nodeTypes.isProxy(proof) ? budgetExecutions.get(proof) : undefined;
    if (!identity || identity.owner !== this) this.refuse();
    return identity;
  }
  private policy(task: TaskRecord): BudgetExecutionPolicy {
    const value = this.resolve(structuredClone(task));
    if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) this.refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (!Object.hasOwn(descriptors, "source") || names.some((key) => typeof key !== "string" || !["source", "constraints", "correction_lineages"].includes(key)
      || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) this.refuse();
    // The pure resolver performs strict descriptor/schema/bounds validation.
    const policy = Object.fromEntries(names.map((key) => [key, descriptors[key as string]!.value])) as unknown as BudgetExecutionPolicy;
    resolveBudgetPolicy({ ...policy, attribution: task.envelope.budget_admission!.attribution,
      at: task.envelope.budget_admission!.created_at, base_caps: task.envelope.budget_admission!.caps });
    const detached = structuredClone(policy);
    const freeze = (item: unknown): void => { if (item && typeof item === "object") { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
    freeze(detached); return detached;
  }
  private current(identity: BudgetExecutionIdentity): TaskRecord {
    const task = readTask(identity.taskId); if (!task) this.refuse();
    assertTaskBudgetAdmissionBinding(task);
    if (!isDeepStrictEqual(task.envelope.budget_admission, identity.admission) || task.lifecycle !== "running"
      || task.orchestration?.attempts !== identity.attempt || task.orchestration.lease?.run_id !== identity.runId
      || task.orchestration.lease.worker_id !== identity.workerId || Date.parse(task.orchestration.lease.expires_at) <= this.now().getTime()) this.refuse();
    return task;
  }
  private ledger(identity: BudgetExecutionIdentity): BudgetLedger {
    const ledger = readBudgetLedger(this.filePath), admission = identity.admission;
    const reservation = ledger?.reservations[admission.reservation_id], intent = ledger?.admission_intents[admission.intent_id];
    const charge = ledger && Object.values(ledger.charges).find((entry) => entry.run_id === identity.runId);
    const expectedSubject = { id: admission.subject_id, kind: "task", task_id: admission.task_id, project_id: admission.project_id,
      role_id: admission.role_id, agent_id: admission.agent_id, issue_id: admission.issue_id, workflow: admission.workflow, attribution: admission.attribution };
    if (!ledger || !reservation || !intent || !charge || reservation.status !== "active" || reservation.uncertain_dimensions.length
      || intent.status !== "committed" || intent.admission_id !== admission.id || reservation.intent_id !== admission.intent_id
      || reservation.subject_id !== admission.subject_id || reservation.run_ids.at(-1) !== identity.runId
      || charge.reservation_id !== admission.reservation_id || charge.subject_id !== admission.subject_id
      || charge.runtime_state !== "complete" || charge.usage_state !== "complete"
      || reservation.created_at !== admission.created_at || !isDeepStrictEqual(ledger.subjects[admission.subject_id], expectedSubject)
      || charge.review !== (admission.caps.review_attempts > 0) || charge.correction !== (admission.caps.corrections > 0)
      || !isDeepStrictEqual(reservation.policy_bindings, admission.policy_bindings)) this.refuse();
    return ledger;
  }
  private retainLateObservation(proof: object, totalTokens: number | null, elapsedMs: number): void {
    const identity = budgetExecutions.get(proof);
    if (!identity || identity.owner !== this || identity.kind !== "run" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0
      || totalTokens !== null && (!Number.isSafeInteger(totalTokens) || totalTokens < 0)) return;
    try {
      mutateBudgetLedger((tx) => {
        const { ledger } = readBudgetTransaction(tx), admission = identity.admission, reserve = ledger.reservations[admission.reservation_id];
        const intent = ledger.admission_intents[admission.intent_id], charge = Object.values(ledger.charges).find((entry) => entry.run_id === identity.runId);
        const subject = { id: admission.subject_id, kind: "task", task_id: admission.task_id, project_id: admission.project_id,
          role_id: admission.role_id, agent_id: admission.agent_id, issue_id: admission.issue_id, workflow: admission.workflow, attribution: admission.attribution };
        if (!reserve || !intent || !charge || reserve.subject_id !== admission.subject_id || reserve.intent_id !== admission.intent_id
          || intent.admission_id !== admission.id || intent.reservation_id !== reserve.id || charge.reservation_id !== reserve.id
          || charge.subject_id !== admission.subject_id || !isDeepStrictEqual(ledger.subjects[admission.subject_id], subject)
          || !isDeepStrictEqual(reserve.policy_bindings, admission.policy_bindings)) this.refuse();
        // A provable old-run sample remains a debit, never task progress or a
        // terminal ownership receipt. T003 fences successor runtime slices.
        observeBudgetRun(tx, { reservation_id: reserve.id, run_id: identity.runId, runtime_ms: elapsedMs,
          total_tokens: totalTokens === null ? null : Math.max(identity.tokens, totalTokens), terminal: false });
      }, this.filePath, this.now().toISOString());
    } catch { /* Existing holds remain conservative when the exact debit cannot be persisted. */ }
  }
  prepareClaim(taskId: string, runId: string, workerId: string): object {
    const task = readTask(taskId);
    if (!task || !hasBudgetAdmission(task) || task.lifecycle !== "queued" || task.orchestration?.cancel_requested_at) this.refuse();
    assertTaskBudgetAdmissionBinding(task);
    if (task.orchestration!.attempts >= task.orchestration!.max_attempts
      || task.orchestration!.cumulative_tokens >= task.orchestration!.max_total_tokens) this.refuse();
    const admission = task.envelope.budget_admission!, policy = this.policy(task), at = this.now().toISOString();
    if (task.orchestration!.attempts > 0 && !this.canRetry(task, task.orchestration!.last_failure?.run_id ?? "")) this.refuse();
    if (!readBudgetLedger(this.filePath)) this.refuse();
    let runtimeCap = 0;
    mutateBudgetLedger((tx) => {
      if (task.orchestration!.attempts > 0) topUpTaskBudget(tx, { ...policy, admission, persisted_admission: admission });
      runtimeCap = readBudgetTransaction(tx).ledger.reservations[admission.reservation_id]?.held.runtime_ms ?? 0;
      const result = claimTaskBudget(tx, { ...policy, admission, persisted_admission: admission, run_id: runId });
      if (result.status !== "claimed") this.refuse();
    }, this.filePath, at);
    const proof = Object.freeze({});
    budgetExecutions.set(proof, { owner: this, kind: "claim", taskId, runId, workerId, admission: structuredClone(admission),
      snapshot: structuredClone(task), attempt: task.orchestration!.attempts + 1, runtimeCap, tokens: 0, baseTokens: task.orchestration!.cumulative_tokens });
    if (!isDeepStrictEqual(readTask(taskId), task)) { this.abandon(proof); this.refuse(); }
    return proof;
  }
  claimSnapshot(proof: object): TaskRecord { return structuredClone(this.identity(proof).snapshot); }
  bindClaim(proof: object): void {
    const identity = this.identity(proof), task = this.current(identity);
    if (identity.kind !== "claim" || task.revision !== identity.snapshot.revision! + 1
      || !isDeepStrictEqual(task.envelope, identity.snapshot.envelope)) this.refuse();
    identity.kind = "run"; identity.snapshot = structuredClone(task);
    this.prepare(proof);
  }
  prepare(proof: object): { maxRuntimeMs: number; maxTotalTokens: number } {
    const identity = this.identity(proof); if (identity.kind !== "run") this.refuse();
    const task = this.current(identity); if (task.orchestration!.cancel_requested_at) this.refuse();
    const ledger = this.ledger(identity), policy = this.policy(task), admission = identity.admission;
    const staticPolicy = resolveBudgetPolicy({ ...policy, attribution: admission.attribution, at: admission.created_at, base_caps: admission.caps });
    if (staticPolicy.cap_fingerprint !== admission.admitted_cap_fingerprint || !isDeepStrictEqual(staticPolicy.policy_bindings, admission.policy_bindings)) this.refuse();
    const own = ledger.reservations[admission.reservation_id]!, projection = structuredClone(ledger);
    projection.reservations[own.id]!.held = budgetZero(); assertBudgetLedger(projection);
    for (const at of [admission.created_at, this.now().toISOString()]) {
      const resolved = resolveBudgetPolicy({ ...policy, attribution: admission.attribution, at, base_caps: admission.caps, ledger: projection });
      for (const dimension of BUDGET_DIMENSIONS) if (own.held[dimension] > 0
        && (resolved.dimensions[dimension].remaining === null || own.held[dimension] > resolved.dimensions[dimension].remaining!)) this.refuse();
    }
    const charge = Object.values(ledger.charges).find((entry) => entry.run_id === identity.runId)!;
    if (charge.status !== "running" || charge.runtime_ms >= Math.min(identity.runtimeCap, task.orchestration!.max_runtime_ms)
      || task.orchestration!.cumulative_tokens >= task.orchestration!.max_total_tokens) this.refuse();
    identity.snapshot = structuredClone(task);
    return { maxRuntimeMs: Math.min(identity.runtimeCap, task.orchestration!.max_runtime_ms), maxTotalTokens: task.orchestration!.max_total_tokens };
  }
  async observe(proof: object, totalTokens: number | null, elapsedMs: number, terminal = false): Promise<{ exhausted: boolean; unknown: boolean }> {
    try {
      const identity = this.identity(proof); if (identity.kind !== "run") this.refuse();
      const task = this.current(identity);
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || totalTokens !== null && (!Number.isSafeInteger(totalTokens) || totalTokens < 0)) this.refuse();
      if (totalTokens !== null) identity.tokens = Math.max(identity.tokens, totalTokens);
      const unknown = totalTokens === null;
      const charge = mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: identity.admission.reservation_id, run_id: identity.runId,
        runtime_ms: elapsedMs, total_tokens: unknown ? null : identity.tokens, terminal }), this.filePath, this.now().toISOString());
      if (terminal) { identity.terminal = structuredClone(task); identity.terminalUnknown = unknown; }
      return { unknown: unknown || charge.usage_state === "unknown" || charge.runtime_state === "unknown",
        exhausted: charge.runtime_ms >= Math.min(identity.runtimeCap, task.orchestration!.max_runtime_ms)
          || Math.max(task.orchestration!.cumulative_tokens, identity.baseTokens + identity.tokens) >= task.orchestration!.max_total_tokens };
    } catch { this.retainLateObservation(proof, totalTokens, elapsedMs); this.abandon(proof); this.refuse(); }
  }
  async settle(proof: object, totalTokens: number | null, elapsedMs: number, retryable: boolean): Promise<{ complete: boolean; exhausted: boolean }> {
    try {
    const identity = this.identity(proof), expected = identity.terminal, task = readTask(identity.taskId);
    if (!expected || !task || task.lifecycle !== "finished" || task.orchestration?.lease !== null
      || task.orchestration.attempts !== identity.attempt || task.revision !== expected.revision! + 1
      || !isDeepStrictEqual(task.envelope, expected.envelope) || task.orchestration.cumulative_tokens !== expected.orchestration!.cumulative_tokens
      || task.orchestration.last_failure && task.orchestration.last_failure.run_id !== identity.runId
      || !task.finished_at || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      this.abandon(proof); this.refuse();
    }
    assertTaskBudgetAdmissionBinding(task);
    if (identity.terminalUnknown || totalTokens === null) { this.abandon(proof); return { complete: false, exhausted: false }; }
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) { this.abandon(proof); this.refuse(); }
    const ledger = this.ledger(identity), before = Object.values(ledger.charges).find((entry) => entry.run_id === identity.runId)!;
    const charge = mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: identity.admission.reservation_id,
      run_id: identity.runId, runtime_ms: Math.max(before.runtime_ms, elapsedMs), total_tokens: Math.max(identity.tokens, totalTokens), terminal: true }),
    this.filePath, this.now().toISOString());
    if (charge.status !== "terminal") { this.abandon(proof); this.refuse(); }
    if (task.orchestration.cumulative_tokens !== identity.baseTokens + charge.observed_total_tokens!) { this.abandon(proof); this.refuse(); }
    const exhausted = charge.runtime_ms >= Math.min(identity.runtimeCap, task.orchestration.max_runtime_ms)
      || task.orchestration.cumulative_tokens >= task.orchestration.max_total_tokens;
    if (retryable && !exhausted && task.orchestration.last_failure?.kind === "transient" && !task.orchestration.cancel_requested_at) {
      this.retries.set(identity.taskId, identity.runId);
    } else {
      mutateBudgetLedger((tx) => settleBudgetReservation(tx, { reservation_id: identity.admission.reservation_id }), this.filePath, this.now().toISOString());
      this.retries.delete(identity.taskId);
    }
    return { complete: true, exhausted };
    } catch { this.abandon(proof); this.refuse(); }
  }
  canRetry(task: TaskRecord, runId: string): boolean {
    return this.retries.get(task.envelope.id) === runId && task.orchestration?.last_failure?.run_id === runId
      && task.orchestration.last_failure.kind === "transient";
  }
  abandon(proof: object): void {
    const identity = budgetExecutions.get(proof); if (!identity || identity.owner !== this) return;
    this.retries.delete(identity.taskId);
    try { mutateBudgetLedger((tx) => markBudgetUnknown(tx, { reservation_id: identity.admission.reservation_id }), this.filePath, this.now().toISOString()); }
    catch { /* Preserve the durable charge/hold when even uncertainty persistence is unavailable. */ }
    budgetExecutions.delete(proof);
  }
  release(proof: object): void { if (budgetExecutions.get(proof)?.owner === this) budgetExecutions.delete(proof); }
}

export interface TaskControl {
  enqueue(taskId: string): void;
  cancel(taskId: string): TaskRecord;
  retry(taskId: string): TaskRecord;
}

export class TaskControlError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

// State-only manual-action fence. Durable references, not caller metadata or
// the current stage alone, retain every tree an active workflow may need.
export function assertTaskOutsideActiveWorkflow(record: TaskRecord): void {
  try {
    const document = readWorkflowDocument(), admission = record.envelope.context_admission;
    if (admission?.schema_version === 2) {
      const owner = document.workflows[admission.workflow_id], stage = document.stages[admission.stage_id];
      if (!owner || !stage || stage.workflow_id !== owner.id || stage.task_id !== record.envelope.id
        || stage.generation !== admission.stage_generation || stage.grant_id !== admission.grant_id
        || stage.authority_revision !== admission.authority_revision) {
        throw new TaskControlError("Workflow task ownership cannot be proven; use its current workflow decision", 409);
      }
    }
    const active = Object.values(document.workflows).filter((owner) => !["completed", "cancelled"].includes(owner.status));
    const activeIds = new Set(active.map((owner) => owner.id));
    const protectedTasks = new Set<string>(), protectedTrees = new Set<string>();
    const retainTree = (id: string) => { protectedTasks.add(id); protectedTrees.add(id); };
    for (const owner of active) if (owner.candidate) retainTree(owner.candidate.task_id);
    for (const stage of Object.values(document.stages)) if (activeIds.has(stage.workflow_id)) {
      if (stage.task_id) protectedTasks.add(stage.task_id);
      if (stage.task_id && stage.sandbox === "workspace-write") protectedTrees.add(stage.task_id);
      if (stage.candidate) retainTree(stage.candidate.task_id);
    }
    for (const intent of Object.values(document.admission_intents)) if (activeIds.has(intent.workflow_id)) protectedTasks.add(intent.task_id);
    for (const receipt of Object.values(document.review_receipts)) if (activeIds.has(receipt.workflow_id)) retainTree(receipt.candidate.task_id);
    for (const lineage of Object.values(document.lineages)) if (lineage.workflow_ids.some((id) => activeIds.has(id))) retainTree(lineage.origin_task_id);
    const issueId = admission?.kind === "issue" || admission?.schema_version === 2 ? admission.issue_id : record.envelope.metadata.issue_id;
    if (protectedTasks.has(record.envelope.id) || active.some((owner) => owner.id === (admission?.schema_version === 2 ? admission.workflow_id : null)
      || owner.project_id === record.envelope.project && owner.issue_id === issueId)) {
      throw new TaskControlError("Active workflow ownership denies this task action; use its current decision or stop the workflow first", 409);
    }
    const run = record.envelope.metadata.run as { branch?: string; worktree_path?: string } | undefined;
    if (!run?.branch && !run?.worktree_path) return;
    for (const id of protectedTrees) {
      const task = readTask(id);
      if (!task) throw new TaskControlError("Workflow tree ownership cannot be proven; retained facts require review", 409);
      const owned = task.envelope.metadata.run as { branch?: string; worktree_path?: string } | undefined;
      if (run?.worktree_path && owned?.worktree_path && canonicalPath(expandHome(run.worktree_path)) === canonicalPath(expandHome(owned.worktree_path))
        || run?.branch && run.branch === owned?.branch && canonicalPath(expandHome(record.envelope.repo_path)) === canonicalPath(expandHome(task.envelope.repo_path))) {
        throw new TaskControlError("An active workflow retains this managed tree; publication, retry and cleanup are denied", 409);
      }
    }
  } catch (error) {
    if (error instanceof TaskControlError) throw error;
    throw new TaskControlError("Workflow ownership is unavailable; task action denied without effects", 409);
  }
}

export interface TaskOrchestratorOptions {
  repoRoot?: string;
  executor?: AgentExecutor;
  workerId?: string;
  maxConcurrent?: number;
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  now?: () => Date;
  tracer?: Tracer;
  runAttempt?: (taskId: string, options: TaskRunOptions) => Promise<TaskRunCompletion | null>;
  workflows?: WorkflowOrchestrator;
  /** Trusted test composition only; production does not supply a P controller. */
  budgets?: BudgetExecutionScaffold;
}

interface ActiveAttempt {
  runId: string;
  budgetProof?: object;
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  promise: Promise<void>;
}

function positiveInteger(value: string | undefined, fallback: number, maximum?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function isLeaseCurrent(record: TaskRecord, nowMs: number): boolean {
  const expiry = record.orchestration?.lease?.expires_at;
  return record.lifecycle === "running" && typeof expiry === "string" && Date.parse(expiry) > nowMs;
}

export class TaskOrchestrator implements TaskControl {
  readonly workerId: string;
  readonly maxConcurrent: number;
  private readonly repoRoot: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly runAttempt: (taskId: string, options: TaskRunOptions) => Promise<TaskRunCompletion | null>;
  private readonly active = new Map<string, ActiveAttempt>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = true;
  private readonly workflows?: WorkflowOrchestrator;
  private readonly budgets?: BudgetExecutionScaffold;

  constructor(options: TaskOrchestratorOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    const executor = options.executor ?? codexExecutor;
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.maxConcurrent = options.maxConcurrent ?? positiveInteger(process.env.SURTEC_WORKER_CONCURRENCY, 2, 16);
    this.pollMs = options.pollMs ?? positiveInteger(process.env.SURTEC_WORKER_POLL_MS, 250, 60_000);
    this.leaseMs = options.leaseMs ?? positiveInteger(process.env.SURTEC_WORKER_LEASE_MS, 30_000, 3_600_000);
    this.heartbeatMs = options.heartbeatMs ?? positiveInteger(process.env.SURTEC_WORKER_HEARTBEAT_MS, 5_000, this.leaseMs);
    this.retryBaseMs = options.retryBaseMs ?? positiveInteger(process.env.SURTEC_WORKER_RETRY_BASE_MS, 1_000, 60_000);
    this.now = options.now ?? (() => new Date());
    this.runAttempt = options.runAttempt ?? ((taskId, runOptions) => runTask(taskId, this.repoRoot, executor, { ...runOptions, tracer: options.tracer }));
    this.workflows = options.workflows;
    if (options.budgets && !budgetControllers.has(options.budgets)) throw new TaskControlError("Unrecognized budget controller composition", 409);
    this.budgets = options.budgets;
    this.workflows?.connect(this, this.workerId);
  }

  start(): void {
    if (this.poller) return;
    this.stopped = false;
    this.recoverExpiredLeases();
    this.requestTick();
    this.poller = setInterval(() => this.requestTick(), this.pollMs);
    this.poller.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    const pending = [...this.active.values()].map((attempt) => attempt.promise);
    for (const attempt of this.active.values()) attempt.controller.abort(new Error("worker stopping"));
    await Promise.allSettled(pending);
  }

  enqueue(_taskId: string): void {
    if (!this.stopped) this.requestTick();
  }

  cancel(taskId: string): TaskRecord {
    const snapshot = readTask(taskId), active = this.active.get(taskId);
    const ownsBudget = (task: TaskRecord) => {
      if (!active?.budgetProof || budgetExecutionOwner(active.budgetProof, taskId, active.runId) !== this.budgets
        || task.orchestration?.lease?.run_id !== active.runId || task.orchestration.lease.worker_id !== this.workerId) return false;
      try { assertBudgetWorkflowExecution(task, active.budgetProof); return true; } catch { return false; }
    };
    if (snapshot && hasBudgetAdmission(snapshot) && !ownsBudget(snapshot)) throw new TaskControlError("Budget-bound cancellation lacks this worker's private ownership", 409);
    let found = false;
    let changed = false;
    let queuedCancellation = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      found = true;
      if (hasBudgetAdmission(record) && !ownsBudget(record)) throw new TaskControlError("Budget-bound cancellation lacks private ownership", 409);
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle === "finished") {
        if (record.outcome === "cancelled") return false;
        throw new TaskControlError(`task is already finished: ${taskId}`, 409);
      }
      if (orchestration.cancel_requested_at) return false;
      orchestration.cancel_requested_at = at;
      if (record.lifecycle === "queued") {
        queuedCancellation = true;
        orchestration.lease = null;
        orchestration.retry_at = null;
        orchestration.last_failure = { kind: "cancelled", message: "cancelled before execution", at, run_id: "not-started" };
        record.lifecycle = "finished";
        record.outcome = "cancelled";
        record.finished_at = at;
        record.result = cancelledResult(record.envelope, "cancelled before execution", record.logs_path ?? "");
      }
      record.updated_at = at;
      changed = true;
    });
    if (!found || !updated) throw new TaskControlError(`task not found: ${taskId}`, 404);
    if (changed) {
      appendTaskEvent({ task_id: taskId, type: "cancel-requested", revision: updated.revision!, run_id: updated.orchestration?.lease?.run_id, attempt: updated.orchestration?.attempts || null, payload: { queued: queuedCancellation }, at });
      if (queuedCancellation) appendTaskEvent({ task_id: taskId, type: "cancelled", revision: updated.revision!, attempt: null, payload: { reason: "cancelled before execution" }, at });
    }
    this.active.get(taskId)?.controller.abort(new Error("task cancellation requested"));
    return updated;
  }

  retry(taskId: string): TaskRecord {
    const snapshot = readTask(taskId);
    if (snapshot && hasBudgetAdmission(snapshot)) throw new TaskControlError("Budget-bound manual retry requires fresh admission; scaffold cutover is unavailable", 409);
    let found = false;
    let changed = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      found = true;
      if (hasBudgetAdmission(record)) throw new TaskControlError("Budget-bound manual retry is unavailable", 409);
      if (record.envelope.context_admission?.schema_version === 2) throw new TaskControlError("Workflow task retry requires its current controller; manual retry is denied", 409);
      assertTaskOutsideActiveWorkflow(record);
      const orchestration = ensureTaskOrchestration(record);
      if (typeof record.envelope.metadata.issue_id === "string") {
        throw new TaskControlError(`issue-linked tasks must be resumed through the local issue workflow: ${record.envelope.metadata.issue_id}`, 409);
      }
      if (record.lifecycle !== "finished") throw new TaskControlError(`task is not finished: ${taskId}`, 409);
      if (!record.envelope.context_manifest || !record.envelope.context_admission) throw new TaskControlError("Retry requires an admitted context binding; explicitly dispatch a new governed task", 409);
      if (record.outcome === "completed" || record.outcome === "partial") throw new TaskControlError(`successful task cannot be retried: ${taskId}`, 409);
      if (orchestration.attempts >= orchestration.max_attempts) throw new TaskControlError(`task attempt budget is exhausted: ${taskId}`, 409);
      if (orchestration.cumulative_tokens >= orchestration.max_total_tokens) throw new TaskControlError(`task token budget is exhausted: ${taskId}`, 409);
      orchestration.cancel_requested_at = null;
      orchestration.retry_at = null;
      orchestration.lease = null;
      orchestration.last_failure = null;
      record.lifecycle = "queued";
      record.outcome = null;
      record.finished_at = null;
      const previousRun = record.envelope.metadata.run;
      const run = previousRun && typeof previousRun === "object" && !Array.isArray(previousRun) ? previousRun as Record<string, unknown> : {};
      if (record.result?.summary && record.result.status !== "needs-review") record.envelope.metadata.run = { ...run, prior_summary: redactContextText(record.result.summary).slice(0, 2000) };
      record.result = null;
      record.updated_at = at;
      changed = true;
    });
    if (!found || !updated) throw new TaskControlError(`task not found: ${taskId}`, 404);
    if (changed) appendTaskEvent({ task_id: taskId, type: "queued", revision: updated.revision!, attempt: updated.orchestration?.attempts || null, payload: { manual_retry: true }, at });
    this.enqueue(taskId);
    return updated;
  }

  recoverExpiredLeases(): number {
    const now = this.now();
    let recovered = 0;
    for (const snapshot of listTasks()) {
      if (snapshot.lifecycle !== "running") continue;
      // A durable bound lease alone never recreates this process's private P proof.
      if (hasBudgetAdmission(snapshot)) continue;
      const expiry = snapshot.orchestration?.lease?.expires_at;
      if (expiry && Date.parse(expiry) > now.getTime()) continue;
      if (snapshot.envelope.context_admission?.schema_version === 2) {
        if (this.workflows?.recoverExpired(snapshot)) recovered++;
        continue;
      }
      let disposition: "retry" | "failed" | "cancelled" | null = null;
      let previousRunId: string | null = null;
      try {
        const updated = updateTask(snapshot.envelope.id, (record) => {
          if (record.lifecycle !== "running") return false;
          if (hasBudgetAdmission(record)) return false;
          assertTaskOutsideActiveWorkflow(record);
          const orchestration = ensureTaskOrchestration(record);
          if (orchestration.lease && Date.parse(orchestration.lease.expires_at) > now.getTime()) return false;
          previousRunId = orchestration.lease?.run_id ?? "legacy-run";
          orchestration.lease = null;
          if (orchestration.cancel_requested_at) {
            disposition = "cancelled";
            orchestration.retry_at = null;
            orchestration.last_failure = { kind: "cancelled", message: "cancelled while worker was unavailable", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "finished";
            record.outcome = "cancelled";
            record.finished_at = now.toISOString();
            record.result = cancelledResult(record.envelope, "cancelled while worker was unavailable", record.logs_path ?? "");
          } else if (orchestration.attempts < orchestration.max_attempts && orchestration.cumulative_tokens < orchestration.max_total_tokens) {
            disposition = "retry";
            orchestration.retry_at = now.toISOString();
            orchestration.last_failure = { kind: "transient", message: "worker lease expired", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "queued";
            record.outcome = null;
            record.finished_at = null;
            record.result = null;
          } else {
            disposition = "failed";
            orchestration.retry_at = null;
            orchestration.last_failure = { kind: "budget", message: "worker lease expired and retry budget is exhausted", at: now.toISOString(), run_id: previousRunId };
            record.lifecycle = "finished";
            record.outcome = "failed";
            record.finished_at = now.toISOString();
            record.result = failureResult(record.envelope, "worker lease expired and retry budget is exhausted", record.logs_path ?? "");
          }
          record.updated_at = now.toISOString();
        });
        if (!updated || !disposition) continue;
        recovered += 1;
        appendTaskEvent({ task_id: snapshot.envelope.id, type: "lease-recovered", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { disposition }, at: now.toISOString() });
        if (disposition === "retry") appendTaskEvent({ task_id: snapshot.envelope.id, type: "retry-scheduled", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { retry_at: now.toISOString(), reason: "worker lease expired" }, at: now.toISOString() });
        if (disposition === "cancelled") appendTaskEvent({ task_id: snapshot.envelope.id, type: "cancelled", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { reason: "cancelled while worker was unavailable" }, at: now.toISOString() });
        if (disposition === "failed") appendTaskEvent({ task_id: snapshot.envelope.id, type: "failed", revision: updated.revision!, run_id: previousRunId, attempt: updated.orchestration?.attempts || null, payload: { reason: "retry budget exhausted" }, at: now.toISOString() });
      } catch (error) {
        if (!(error instanceof StateLockConflictError) && !(error instanceof TaskControlError)) throw error;
      }
    }
    return recovered;
  }

  async runOnce(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      // Reconciliation never runs under scheduler/task locks.
      this.recoverExpiredLeases();
      this.schedulePendingRetries();
      this.workflows?.reconcile();
      const launches: TaskRecord[] = [];
      const budgetCandidates: TaskRecord[] = [];
      const denied: string[] = [];
      try {
        const count = withStateLock("orchestrator-schedule", () => {
          const now = this.now();
          const snapshots = listTasks();
          const running = snapshots.filter((record) => isLeaseCurrent(record, now.getTime()));
          let available = Math.max(0, this.maxConcurrent - running.length);
          if (available === 0) return 0;
          const writeProjects = new Set(
            running.filter((record) => record.envelope.sandbox === "workspace-write").map((record) => record.envelope.project),
          );
          let claimed = 0;
          const queued = snapshots
            .filter((record) => record.lifecycle === "queued")
            .sort((left, right) => left.created_at.localeCompare(right.created_at));
          for (const snapshot of queued) {
            if (available === 0) break;
            const orchestration = snapshot.orchestration;
            if (orchestration?.retry_at && Date.parse(orchestration.retry_at) > now.getTime()) continue;
            if (snapshot.envelope.sandbox === "workspace-write" && writeProjects.has(snapshot.envelope.project)) continue;
            if (hasBudgetAdmission(snapshot)) {
              if (this.budgets) budgetCandidates.push(snapshot);
              continue;
            }
            if (snapshot.envelope.context_admission?.schema_version === 2) {
              if (!this.workflows) continue;
              try { if (!this.workflows.canClaim(snapshot)) continue; }
              catch { denied.push(snapshot.envelope.context_admission.workflow_id); continue; }
            }
            try {
              const claim = this.claim(snapshot.envelope.id, now);
              if (!claim) continue;
              claimed += 1;
              available -= 1;
              if (claim.envelope.sandbox === "workspace-write") writeProjects.add(claim.envelope.project);
              launches.push(claim);
            } catch (error) {
              if (!(error instanceof StateLockConflictError) && !(error instanceof TaskControlError)) throw error;
            }
          }
          return claimed;
        });
        for (const id of denied) this.workflows?.block(id, "Current sources, scope or workflow admission changed before claim.");
        for (const record of launches) this.launch(record);
        let budgetCount = 0;
        for (const candidate of budgetCandidates) {
          let proof: object | undefined;
          try {
            // Do not allocate/charge when the worker is already full. Selection
            // is not a reservation: capacity and the exact snapshot are reread.
            const eligible = withStateLock("orchestrator-schedule", () => {
              const running = listTasks().filter((task) => isLeaseCurrent(task, this.now().getTime()));
              return running.length < this.maxConcurrent && !running.some((task) => task.envelope.project === candidate.envelope.project
                && task.envelope.sandbox === "workspace-write" && candidate.envelope.sandbox === "workspace-write");
            });
            if (!eligible) continue;
            const runId = randomUUID();
            proof = this.budgets!.prepareClaim(candidate.envelope.id, runId, this.workerId);
            const expected = this.budgets!.claimSnapshot(proof);
            const claimed = withStateLock("orchestrator-schedule", () => {
              const now = this.now(), running = listTasks().filter((task) => isLeaseCurrent(task, now.getTime()));
              if (running.length >= this.maxConcurrent || running.some((task) => task.envelope.project === expected.envelope.project
                && task.envelope.sandbox === "workspace-write" && expected.envelope.sandbox === "workspace-write")) return null;
              if (expected.envelope.context_admission?.schema_version === 2 && (!this.workflows || !this.workflows.canClaim(expected, proof))) return null;
              return this.claim(expected.envelope.id, now, runId, expected, proof);
            });
            if (!claimed) { this.budgets!.abandon(proof); continue; }
            this.budgets!.bindClaim(proof);
            this.launch(claimed, proof); budgetCount++;
          } catch {
            if (proof) this.budgets!.abandon(proof);
            // Cross-store gaps retain charges/holds; no effects or blind retry.
          }
        }
        return count + budgetCount;
      } catch (error) {
        if (error instanceof StateLockConflictError) return 0;
        throw error;
      }
    } finally {
      this.ticking = false;
    }
  }

  private claim(taskId: string, now: Date, runId = randomUUID(), expected?: TaskRecord, budgetProof?: object): TaskRecord | null {
    let claimed = false;
    const updated = updateTask(taskId, (record) => {
      if (record.lifecycle !== "queued") return false;
      if (expected && !isDeepStrictEqual(record, expected)) return false;
      if (hasBudgetAdmission(record)) {
        if (!this.budgets || !budgetProof) return false;
        assertBudgetWorkflowExecution(record, budgetProof);
      }
      if (record.envelope.context_admission?.schema_version === 2) {
        if (!this.workflows) return false;
      } else assertTaskOutsideActiveWorkflow(record);
      const orchestration = ensureTaskOrchestration(record);
      if (orchestration.cancel_requested_at) return false;
      if (orchestration.retry_at && Date.parse(orchestration.retry_at) > now.getTime()) return false;
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cumulative_tokens >= orchestration.max_total_tokens) return false;
      orchestration.attempts += 1;
      orchestration.retry_at = null;
      orchestration.lease = {
        run_id: runId,
        worker_id: this.workerId,
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      record.lifecycle = "running";
      record.started_at ??= now.toISOString();
      record.updated_at = now.toISOString();
      claimed = true;
    });
    if (!updated || !claimed) return null;
    appendTaskEvent({ task_id: taskId, type: "claimed", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { worker_id: this.workerId }, at: now.toISOString() });
    return updated;
  }

  private launch(record: TaskRecord, budgetProof?: object): void {
    const taskId = record.envelope.id;
    const runId = record.orchestration!.lease!.run_id;
    const controller = new AbortController();
    const heartbeat = setInterval(() => this.heartbeat(taskId, runId, controller), this.heartbeatMs);
    heartbeat.unref?.();
    let proof: object | undefined;
    const promise = Promise.resolve().then(() => {
      if (budgetProof) this.budgets!.prepare(budgetProof);
      if (record.envelope.context_admission?.schema_version === 2 && this.workflows) proof = this.workflows.claimRun(taskId, runId, budgetProof);
      return this.runAttempt(taskId, { signal: controller.signal, runId, workerId: this.workerId, workflowExecution: proof, budgetExecution: budgetProof });
    })
      .then((completion) => {
        if (budgetProof && (!completion || completion.stale)) this.budgets!.abandon(budgetProof);
        if (completion?.retryable && !completion.stale) this.tryScheduleRetry(taskId, runId, completion.reason ?? "transient execution failure");
      })
      .catch((error: unknown) => {
        if (budgetProof) {
          this.budgets!.abandon(budgetProof);
          try { this.finalizeWorkflowFailure(taskId, runId, record); } catch { /* Retain an ambiguous owned snapshot for review. */ }
          if (record.envelope.context_admission?.schema_version === 2) {
            try { this.workflows?.block(record.envelope.context_admission.workflow_id, "Budget attempt completion is unavailable; retained holds require review.", true); } catch { /* No authority repair. */ }
          }
          return;
        }
        if (record.envelope.context_admission?.schema_version === 2 && this.workflows) {
          try {
            this.finalizeWorkflowFailure(taskId, runId);
            this.workflows.block(record.envelope.context_admission.workflow_id, "Workflow attempt failed without provable completion; retained facts require review.", true);
          } catch { /* preserve ambiguous state for the next bounded reconciliation */ }
          return;
        }
        const reason = (error as Error)?.message ?? "unexpected worker failure";
        try {
          this.finalizeUnexpectedFailure(taskId, runId, reason);
          this.tryScheduleRetry(taskId, runId, reason);
        } catch (finalizeError) {
          console.error(`[orchestrator] failed to finalize ${taskId}:`, finalizeError);
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(taskId);
        if (proof) this.workflows?.release(proof);
        if (budgetProof) this.budgets!.release(budgetProof);
        try { this.workflows?.reconcile(); } catch { /* next bounded tick retries retained reconciliation */ }
        if (!this.stopped) this.requestTick();
      });
    this.active.set(taskId, { runId, budgetProof, controller, heartbeat, promise });
  }

  private heartbeat(taskId: string, runId: string, controller: AbortController): void {
    let cancelRequested = false;
    let stillOwned = false;
    const now = this.now();
    const budgetProof = this.active.get(taskId)?.budgetProof;
    if (budgetProof) {
      try {
        const caps = this.budgets!.prepare(budgetProof), current = readTask(taskId);
        if (!current?.orchestration?.lease || now.getTime() - Date.parse(current.orchestration.lease.acquired_at) >= caps.maxRuntimeMs) {
          controller.abort(new Error("owned budget runtime is exhausted")); return;
        }
      } catch { controller.abort(new Error("owned budget facts require review")); return; }
    }
    try {
      updateTask(taskId, (record) => {
        if (hasBudgetAdmission(record)) {
          if (!budgetProof || budgetExecutionOwner(budgetProof, taskId, runId) !== this.budgets) return false;
          // Recheck private lease identity under the task lock, without policy or
          // ledger work: a same-run foreign worker must never receive renewal.
          assertBudgetWorkflowExecution(record, budgetProof);
          if (record.orchestration?.lease?.worker_id !== this.workerId) return false;
        }
        const orchestration = ensureTaskOrchestration(record);
        if (record.lifecycle !== "running" || orchestration.lease?.run_id !== runId) return false;
        orchestration.lease.heartbeat_at = now.toISOString();
        orchestration.lease.expires_at = new Date(now.getTime() + this.leaseMs).toISOString();
        record.updated_at = now.toISOString();
        cancelRequested = orchestration.cancel_requested_at !== null;
        stillOwned = true;
      });
    } catch (error) {
      if (budgetProof && error instanceof TaskControlError) {
        controller.abort(new Error("owned budget lease identity changed")); return;
      }
      if (!(error instanceof StateLockConflictError)) console.error(`[orchestrator] heartbeat failed for ${taskId}:`, error);
      return;
    }
    if ((!stillOwned || cancelRequested) && !controller.signal.aborted) {
      controller.abort(new Error(cancelRequested ? "task cancellation requested" : "attempt lease is no longer current"));
    }
  }

  private finalizeUnexpectedFailure(taskId: string, runId: string, reason: string): void {
    let changed = false;
    const at = this.now().toISOString();
    const updated = updateTask(taskId, (record) => {
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "running" || orchestration.lease?.run_id !== runId) return false;
      orchestration.lease = null;
      orchestration.last_failure = { kind: "transient", message: reason, at, run_id: runId };
      record.lifecycle = "finished";
      record.outcome = "failed";
      record.finished_at = at;
      record.updated_at = at;
      record.result = failureResult(record.envelope, reason, record.logs_path ?? "");
      changed = true;
    });
    if (updated && changed) appendTaskEvent({ task_id: taskId, type: "failed", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { reason, retryable: true }, at });
  }
  private finalizeWorkflowFailure(taskId: string, runId: string, budgetSnapshot?: TaskRecord): void {
    const at = this.now().toISOString();
    updateTask(taskId, (record) => {
      if (record.lifecycle !== "running" || record.orchestration?.lease?.run_id !== runId) return false;
      if (budgetSnapshot && (record.orchestration.lease.worker_id !== budgetSnapshot.orchestration?.lease?.worker_id
        || record.orchestration.attempts !== budgetSnapshot.orchestration?.attempts
        || !isDeepStrictEqual(record.envelope.budget_admission, budgetSnapshot.envelope.budget_admission))) return false;
      record.lifecycle = "finished"; record.outcome = "needs-review"; record.finished_at = at; record.updated_at = at;
      record.orchestration.lease = null; record.orchestration.retry_at = null;
      record.orchestration.last_failure = { kind: "terminal", message: "Workflow attempt requires retained-fact review", at, run_id: runId };
      record.result = failureResult(record.envelope, "Workflow attempt requires retained-fact review", record.logs_path ?? ""); record.result.status = "needs-review";
    });
  }

  private scheduleRetry(taskId: string, runId: string, reason: string): void {
    // Until provable workflow retry reconciliation exists, keep failed v2
    // attempts terminal rather than applying the generic legacy retry path.
    const snapshot = readTask(taskId);
    if (snapshot?.envelope.context_admission?.schema_version === 2) return;
    if (snapshot && hasBudgetAdmission(snapshot) && !this.budgets?.canRetry(snapshot, runId)) return;
    let scheduled = false;
    const now = this.now();
    let retryAt = now.toISOString();
    const updated = updateTask(taskId, (record) => {
      if (record.envelope.context_admission?.schema_version === 2) return false;
      if (hasBudgetAdmission(record) && !this.budgets?.canRetry(record, runId)) return false;
      assertTaskOutsideActiveWorkflow(record);
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "finished" || record.outcome !== "failed") return false;
      if (orchestration.last_failure?.kind !== "transient" || orchestration.last_failure.run_id !== runId) return false;
      if (orchestration.cancel_requested_at) return false;
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cumulative_tokens >= orchestration.max_total_tokens) return false;
      const delay = Math.min(60_000, this.retryBaseMs * (2 ** Math.max(0, orchestration.attempts - 1)));
      retryAt = new Date(now.getTime() + delay).toISOString();
      orchestration.retry_at = retryAt;
      orchestration.lease = null;
      record.lifecycle = "queued";
      record.outcome = null;
      record.finished_at = null;
      record.result = null;
      record.updated_at = now.toISOString();
      scheduled = true;
    });
    if (updated && scheduled) appendTaskEvent({ task_id: taskId, type: "retry-scheduled", revision: updated.revision!, run_id: runId, attempt: updated.orchestration!.attempts, payload: { retry_at: retryAt, reason }, at: now.toISOString() });
  }

  private tryScheduleRetry(taskId: string, runId: string, reason: string): void {
    try {
      this.scheduleRetry(taskId, runId, reason);
    } catch (error) {
      if (!(error instanceof StateLockConflictError) && !(error instanceof TaskControlError)) console.error(`[orchestrator] failed to schedule retry for ${taskId}:`, error);
    }
  }

  private schedulePendingRetries(): void {
    for (const record of listTasks()) {
      const failure = record.orchestration?.last_failure;
      if (record.lifecycle !== "finished" || record.outcome !== "failed" || failure?.kind !== "transient") continue;
      this.tryScheduleRetry(record.envelope.id, failure.run_id, failure.message);
    }
  }

  private requestTick(): void {
    void this.runOnce().catch((error: unknown) => {
      console.error("[orchestrator] scheduler tick failed:", error);
    });
  }
}
