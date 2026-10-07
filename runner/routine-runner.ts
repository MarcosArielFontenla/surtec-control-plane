import { resolve } from "node:path";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { resolveBudgetPolicy, type BudgetPolicySource, type ExistingBudgetConstraint } from "../lib/budgets/policy";
import { budgetOccurrenceIntentId, claimOccurrenceBudget, commitOccurrenceBudget, markBudgetUnknown,
  observeBudgetRun, reserveOccurrenceBudget, settleBudgetReservation, BudgetReservationError } from "../lib/budgets/reservations";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetAttribution, type BudgetOccurrenceSubject } from "../lib/budgets/types";
import { assertBudgetLedger } from "../lib/budgets/validation";
import { assertRoutineActionBudget, executeRoutineAction, RoutineActionError, type RoutineActionDependencies } from "../lib/routines/actions";
import { planRoutineSchedule, routineRevisionKey, routineTimestampEpoch, type RoutineSchedulePlan } from "../lib/routines/schedule";
import type { RoutineFailureCode, RoutineOccurrence, RoutineReceipt, RoutineRecord } from "../lib/routines/types";
import { assertRoutineOccurrence, assertRoutineRecord, assertRoutineReceipt } from "../lib/routines/validation";
import { mutateBudgetLedger, readBudgetLedger, readBudgetTransaction } from "../lib/state/budgets";
import { budgetStatePath, routineStatePath, stateDir } from "../lib/state/paths";
import { assertRoutineOwnership, claimRoutineOccurrence, finishRoutineOccurrence, mutateRoutineDocument,
  readRoutineDocument, readRoutineTransaction, revokeRoutineOwnership, updateRoutineTransaction, type RoutineOwnership } from "../lib/state/routines";

export interface RoutineExecutionPolicy {
  source: BudgetPolicySource; constraints?: ExistingBudgetConstraint[]; attribution: BudgetAttribution;
}
/** Trusted application wiring only. No configuration, request or environment switch supplies this object. */
export interface RoutineExecutionComposition extends Omit<RoutineActionDependencies, "state_root" | "clock"> {
  resolve: (definition: Readonly<RoutineRecord>, executionId: string) => RoutineExecutionPolicy;
}
export interface RoutineRunnerOptions { stateRoot?: string; now?: () => Date; execution?: RoutineExecutionComposition }
interface ActiveRoutine {
  occurrence: Readonly<RoutineOccurrence>; ownership: RoutineOwnership; controller: AbortController; promise: Promise<void>;
}
const runners = new WeakSet<object>();
export function isRoutineRunner(value: unknown): value is RoutineRunner {
  return !!value && typeof value === "object" && !nodeTypes.isProxy(value) && runners.has(value);
}
const zero = (): BudgetAmounts => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 0])) as BudgetAmounts;
const caps = (runtime: number): BudgetAmounts => ({ ...zero(), attempts: 1, runtime_ms: runtime, concurrent_reads: 1 });
function refuse(code: RoutineFailureCode = "state-invalid"): never { throw new RoutineActionError(code); }
function fields(value: unknown, required: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || ![...required, ...optional].includes(key) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) refuse();
}
function callback(value: unknown): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function" || nodeTypes.isProxy(value) || nodeTypes.isAsyncFunction(value) || nodeTypes.isGeneratorFunction(value)) refuse();
}
function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value) || value.includes("..")
    || ["constructor", "prototype", "__proto__"].includes(value)) refuse();
}
type Terminal = Exclude<RoutineOccurrence["status"], "reserved" | "running">;
function terminal(receipt: RoutineReceipt): Terminal {
  if (receipt.failure_code === "cancelled") return "cancelled";
  if (receipt.budget_outcome === "unknown" || receipt.failure_code === "ownership-unavailable") return "needs-review";
  if (receipt.freshness === "fresh") return "completed";
  return receipt.failure_code === "source-unavailable" ? "partial" : "failed";
}
function deniedReceipt(occurrence: RoutineOccurrence, at: string): RoutineReceipt {
  return { schema_version: 1, occurrence_id: occurrence.id, occurrence_key: occurrence.occurrence_key,
    routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
    action: occurrence.definition.action, scope: structuredClone(occurrence.definition.scope),
    policy_fingerprint: occurrence.definition.policy.fingerprint, cap_fingerprint: occurrence.budget.cap_fingerprint,
    project_ids: [...occurrence.project_ids], started_at: null, finished_at: at, captured_at: at,
    freshness: "unavailable", sources: [], counts: { projects_selected: occurrence.project_ids.length, facts_total: 0,
      facts_fresh: 0, facts_unavailable: 0, signals_evaluated: 0, proposals_created: 0, reports_written: 0 },
    consumption: { attempts: 0, runtime_ms: 0, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: "denied", proposals: [], failure_code: "budget-denied", next_action: "inspect-budget" };
}

/** Finite hook owned by the existing worker; no timer, task envelope, automatic recovery or production cutover. */
export class RoutineRunner {
  private readonly root: string;
  private readonly path: string;
  private readonly ledgerPath: string;
  private readonly now: () => Date;
  private readonly execution?: RoutineExecutionComposition;
  private readonly observed = new Set<string>();
  private active: ActiveRoutine | null = null;
  private stopping = false;
  private dispatching = false;
  private fault: RoutineFailureCode | null = null;
  private cursorIndex = 0;
  constructor(options: RoutineRunnerOptions = {}) {
    fields(options, [], ["stateRoot", "now", "execution"]);
    if (options.stateRoot !== undefined && typeof options.stateRoot !== "string") refuse();
    if (options.now !== undefined) callback(options.now);
    if (options.execution !== undefined) {
      fields(options.execution, ["resolve", "assert_current", "read_evidence"], ["propose_issue", "assert_report_privacy", "monotonic"]);
      callback(options.execution.resolve); callback(options.execution.assert_current);
      if (typeof options.execution.read_evidence !== "function" || nodeTypes.isProxy(options.execution.read_evidence)
        || nodeTypes.isGeneratorFunction(options.execution.read_evidence)) refuse();
      for (const key of ["propose_issue", "assert_report_privacy", "monotonic"] as const) if (options.execution[key] !== undefined) callback(options.execution[key]);
      this.execution = Object.freeze({ ...options.execution });
    }
    this.root = resolve(options.stateRoot ?? stateDir()); this.path = routineStatePath(this.root); this.ledgerPath = budgetStatePath(this.root);
    this.now = options.now ?? (() => new Date()); runners.add(this);
  }
  get activeCount(): 0 | 1 { return this.active === null ? 0 : 1; }
  get lastFailure(): RoutineFailureCode | null { return this.fault; }
  start(): void { this.stopping = false; }
  private stamp(): string { const at = this.now().toISOString(); routineTimestampEpoch(at); return at; }
  private policy(definition: Readonly<RoutineRecord>, id: string, at: string, runtime = definition.limits.max_runtime_ms) {
    assertRoutineRecord(definition); safeId(id);
    if (!this.execution || Object.hasOwn(Object.prototype, "toJSON") || Object.hasOwn(Array.prototype, "toJSON")) refuse();
    const policy = this.execution.resolve(definition, id); fields(policy, ["source", "attribution"], ["constraints"]);
    const resolved = resolveBudgetPolicy({ ...policy, at, base_caps: caps(runtime) });
    if (policy.source.fingerprint !== definition.policy.fingerprint || policy.source.policy.revision !== definition.policy.revision
      || !isDeepStrictEqual(resolved.policy_bindings.map((entry) => entry.policy_id).sort(), [...definition.policy.policy_ids].sort())
      || policy.attribution.execution_id !== id || policy.attribution.issue_id !== null || policy.attribution.role_id !== null
      || policy.attribution.project_ids.length > definition.limits.max_projects
      || definition.scope.kind === "project" && !isDeepStrictEqual(policy.attribution.project_ids, [definition.scope.id])
      || definition.scope.kind === "objective" && policy.attribution.objective_ids[0] !== definition.scope.id) refuse("state-invalid");
    return { policy: structuredClone(policy), resolved };
  }
  private current(occurrence: Readonly<RoutineOccurrence>): void {
    if (!this.active || this.active.occurrence.id !== occurrence.id || this.stopping || this.active.controller.signal.aborted) refuse("cancelled");
    assertRoutineOwnership(this.active.ownership, this.path); assertRoutineActionBudget(occurrence, this.root);
    const { policy, resolved } = this.policy(occurrence.definition, occurrence.id, occurrence.created_at, occurrence.budget.admitted_runtime_ms);
    if (!isDeepStrictEqual(policy.attribution, occurrence.attribution) || resolved.cap_fingerprint !== occurrence.budget.cap_fingerprint
      || !isDeepStrictEqual(resolved.policy_bindings, occurrence.budget.policy_bindings)) refuse("budget-denied");
    const ledger = readBudgetLedger(this.ledgerPath); if (!ledger) refuse("accounting-unavailable");
    const projection = structuredClone(ledger), own = projection.reservations[occurrence.budget.reservation_id]!;
    const held = structuredClone(own.held); own.held = zero(); assertBudgetLedger(projection);
    for (const at of [occurrence.created_at, this.stamp()]) {
      const view = resolveBudgetPolicy({ ...policy, at, base_caps: caps(occurrence.budget.admitted_runtime_ms), ledger: projection });
      for (const dimension of BUDGET_DIMENSIONS) if (held[dimension] > 0 && (view.dimensions[dimension].remaining === null
        || held[dimension] > view.dimensions[dimension].remaining!)) refuse("budget-exhausted");
    }
  }
  private unknown(occurrence: Readonly<RoutineOccurrence>): void {
    try { mutateBudgetLedger((tx) => markBudgetUnknown(tx, { reservation_id: occurrence.budget.reservation_id }), this.ledgerPath, this.stamp()); }
    catch { /* Existing durable holds remain; no refund, lock takeover or replay. */ }
  }
  private fence(active: ActiveRoutine): void {
    const current = readRoutineDocument(this.path)?.occurrences[active.occurrence.id];
    if (!current || current.status !== "running" || !isDeepStrictEqual(current.owner, active.occurrence.owner)) refuse("ownership-unavailable");
    if (current.cancel_requested_at !== null) { active.controller.abort(); return; }
    try { this.current(assertRoutineOwnership(active.ownership, this.path)); }
    catch (error) { this.fault = error instanceof RoutineActionError ? error.code : "ownership-unavailable"; active.controller.abort(); }
  }
  /** Called after ordinary claims. Returns immediately; at most one promise owns the action. */
  tick(workerId: string, availableReads: number): void { this.dispatch(workerId, availableReads); }
  /** Internal protected-service boundary; the exact current revision is mandatory. */
  runManual(id: string, expectedRevision: number, workerId: string, availableReads: number): void {
    safeId(id); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) refuse();
    this.dispatch(workerId, availableReads, { id, revision: expectedRevision });
  }
  private dispatch(workerId: string, availableReads: number, manual?: { id: string; revision: number }): void {
    if (!this.execution || this.stopping || this.dispatching) return;
    this.dispatching = true;
    try {
      safeId(workerId); if (!Number.isSafeInteger(availableReads) || availableReads < 0) refuse();
      if (this.active) this.fence(this.active);
      const document = readRoutineDocument(this.path); if (!document) return;
      if (manual && document.routines[manual.id]?.revision !== manual.revision) refuse();
      const at = this.stamp();
      const inventory = Object.values(document.occurrences).map(({ routine_id, routine_revision, slot, status }) => ({ routine_id, routine_revision, slot, status }));
      const foreign = Object.values(document.occurrences).some((entry) => ["reserved", "running"].includes(entry.status) && entry.id !== this.active?.occurrence.id);
      const ledger = readBudgetLedger(this.ledgerPath);
      const orphanHold = Object.values(ledger?.reservations ?? {}).some((entry) => entry.status !== "settled"
        && ledger?.subjects[entry.subject_id]?.kind === "occurrence" && entry.id !== this.active?.occurrence.budget.reservation_id);
      const definitions = Object.values(document.routines).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (definitions.length === 0) return;
      // One bounded definition per tick, not a burst of up to 10000 locked writes.
      const selected = manual ? document.routines[manual.id]! : definitions[this.cursorIndex % definitions.length]!;
      this.cursorIndex = (this.cursorIndex + 1) % definitions.length;
      for (const definition of [selected]) {
        const key = routineRevisionKey(definition.id, definition.revision), restarting = !this.observed.has(key);
        const plan = planRoutineSchedule({ routine: { id: definition.id, revision: definition.revision, enabled: definition.enabled,
          schedule: definition.schedule, schedule_anchor_at: definition.schedule_anchor_at, concurrency: definition.concurrency, catch_up: definition.catch_up },
          now: at, cursor: document.cursors[key] ?? null, occurrences: inventory,
          occupancy: foreign || orphanHold ? "ambiguous" : this.active || availableReads === 0 ? "busy" : "idle",
          trigger: manual ? "manual" : restarting ? "restart" : "tick" });
        if (plan.kind === "needs-review") { this.fault = "ownership-unavailable"; continue; }
        if (plan.kind === "admit") { this.admit(definition, plan, workerId, at); this.observed.add(key); break; }
        if (manual || definition.enabled && definition.schedule !== null) this.cursor(definition, plan, at);
        this.observed.add(key);
      }
    } catch (error) {
      this.fault = error instanceof RoutineActionError ? error.code : "state-invalid";
      this.active?.controller.abort();
    } finally { this.dispatching = false; }
  }
  private cursor(definition: RoutineRecord, plan: RoutineSchedulePlan, at: string): void {
    const key = routineRevisionKey(definition.id, definition.revision);
    const document = readRoutineDocument(this.path)!;
    if (isDeepStrictEqual(document.cursors[key], plan.cursor)) return;
    mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (draft) => {
      if (!isDeepStrictEqual(draft.routines[definition.id], definition) || draft.revision !== document.revision) refuse();
      draft.cursors[key] = structuredClone(plan.cursor);
    }), this.path, at);
  }
  private admit(definition: RoutineRecord, plan: Extract<RoutineSchedulePlan, { kind: "admit" | "coalesce" }>, workerId: string, at: string): void {
    const id = `occurrence-${plan.occurrence_key}`, reservationId = `reservation-${plan.occurrence_key}`;
    const first = this.policy(definition, id, at);
    const runtime = Math.min(definition.limits.max_runtime_ms, first.resolved.ceilings.runtime_ms);
    if (runtime <= 0 || first.resolved.ceilings.attempts < 1 || first.resolved.ceilings.concurrent_reads < 1) {
      // A zero static cap cannot have a valid positive occurrence-intent binding.
      // Retain only considered-slot high-water and visible denial, never fabricate an admission.
      this.cursor(definition, plan, at); refuse("budget-denied");
    }
    const { policy, resolved } = this.policy(definition, id, at, runtime);
    const subject: BudgetOccurrenceSubject = { id: `subject-${plan.occurrence_key}`, kind: "occurrence", occurrence_id: id,
      routine_id: definition.id, routine_revision: definition.revision, slot: plan.slot, project_ids: [...policy.attribution.project_ids], attribution: policy.attribution };
    const intent = budgetOccurrenceIntentId({ subject, reservation_id: reservationId, policy_bindings: resolved.policy_bindings,
      cap_fingerprint: resolved.cap_fingerprint, runtime_ms: runtime, created_at: at });
    const occurrence: RoutineOccurrence = { schema_version: 1, id, revision: 1, routine_id: definition.id, routine_revision: definition.revision,
      occurrence_key: plan.occurrence_key, definition: structuredClone(definition), slot: plan.slot, trigger: plan.trigger,
      project_ids: [...subject.project_ids], attribution: structuredClone(subject.attribution),
      budget: { subject_id: subject.id, reservation_id: reservationId, intent_id: intent, cap_fingerprint: resolved.cap_fingerprint,
        admitted_runtime_ms: runtime, policy_bindings: structuredClone(resolved.policy_bindings) }, status: "reserved", owner: null,
      started_at: null, finished_at: null, cancel_requested_at: null, receipt: null, created_at: at, updated_at: at };
    assertRoutineOccurrence(occurrence);
    let ownership: RoutineOwnership | undefined;
    try {
      try {
        mutateBudgetLedger((tx) => reserveOccurrenceBudget(tx, { subject, reservation_id: reservationId, intent_id: intent, runtime_ms: runtime,
          source: policy.source, ...(policy.constraints === undefined ? {} : { constraints: policy.constraints }) }), this.ledgerPath, at);
      } catch (error) {
        if (!(error instanceof BudgetReservationError) || error.code !== "budget-unavailable"
          || readBudgetLedger(this.ledgerPath)?.reservations[reservationId]) throw error;
        occurrence.status = "failed"; occurrence.finished_at = at; occurrence.receipt = deniedReceipt(occurrence, at);
        mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (draft) => {
          if (!isDeepStrictEqual(draft.routines[definition.id], definition)) refuse();
          draft.occurrences[id] = structuredClone(occurrence); draft.cursors[routineRevisionKey(definition.id, definition.revision)] = structuredClone(plan.cursor);
        }), this.path, at);
        this.fault = "budget-denied"; return;
      }
      mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (draft) => {
        if (!isDeepStrictEqual(draft.routines[definition.id], definition)) refuse();
        draft.occurrences[id] = structuredClone(occurrence); draft.cursors[routineRevisionKey(definition.id, definition.revision)] = structuredClone(plan.cursor);
      }), this.path, at);
      if (!isDeepStrictEqual(readRoutineDocument(this.path)?.occurrences[id], occurrence)) refuse();
      mutateBudgetLedger((tx) => commitOccurrenceBudget(tx, { subject_id: subject.id, reservation_id: reservationId, intent_id: intent }), this.ledgerPath, this.stamp());
      ownership = mutateRoutineDocument((tx) => claimRoutineOccurrence(tx, id, 1, workerId), this.path, this.stamp());
      const claimed = assertRoutineOwnership(ownership, this.path), fresh = this.policy(definition, id, at, runtime);
      if (!isDeepStrictEqual(fresh.policy.attribution, policy.attribution) || fresh.resolved.cap_fingerprint !== resolved.cap_fingerprint) refuse("budget-denied");
      mutateBudgetLedger((tx) => claimOccurrenceBudget(tx, { reservation_id: reservationId, run_id: claimed.owner!.run_id,
        source: fresh.policy.source, ...(fresh.policy.constraints === undefined ? {} : { constraints: fresh.policy.constraints }) }), this.ledgerPath, this.stamp());
      const active: ActiveRoutine = { occurrence: claimed, ownership, controller: new AbortController(), promise: Promise.resolve() };
      this.active = active; this.fault = null;
      active.promise = Promise.resolve().then(() => this.execute(active)).catch(() => {
        this.fault = "accounting-unavailable"; this.unknown(claimed);
      }).finally(() => { revokeRoutineOwnership(active.ownership); if (this.active === active) this.active = null; });
    } catch (error) {
      if (readBudgetLedger(this.ledgerPath)?.reservations[reservationId]) this.unknown(occurrence);
      if (ownership) revokeRoutineOwnership(ownership);
      throw error;
    }
  }
  private async execute(active: ActiveRoutine): Promise<void> {
    const wiring = this.execution!;
    const entry = readRoutineDocument(this.path)?.occurrences[active.occurrence.id];
    const cancelledBeforeEntry = active.controller.signal.aborted
      && entry !== undefined && entry.cancel_requested_at !== null;
    let receipt: RoutineReceipt;
    if (cancelledBeforeEntry) {
      const at = this.stamp(), runtime = Math.max(0, routineTimestampEpoch(at) - routineTimestampEpoch(active.occurrence.started_at!));
      receipt = { ...deniedReceipt(structuredClone(active.occurrence), at), started_at: active.occurrence.started_at,
        consumption: { attempts: 1, runtime_ms: runtime, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
        budget_outcome: runtime > active.occurrence.budget.admitted_runtime_ms ? "exhausted" : "within-limit",
        failure_code: "cancelled", next_action: "run-new-occurrence" };
    } else receipt = await executeRoutineAction({ ownership: active.ownership, signal: active.controller.signal }, {
      state_root: this.root, clock: this.now, read_evidence: wiring.read_evidence,
      assert_current: (occurrence, boundary) => {
        this.current(occurrence); const result: unknown = wiring.assert_current(occurrence, boundary); if (result !== undefined) refuse();
        this.current(occurrence);
      }, ...(wiring.propose_issue === undefined ? {} : { propose_issue: wiring.propose_issue }),
      ...(wiring.assert_report_privacy === undefined ? {} : { assert_report_privacy: wiring.assert_report_privacy }),
      ...(wiring.monotonic === undefined ? {} : { monotonic: wiring.monotonic }),
    });
    const current = readRoutineDocument(this.path)?.occurrences[active.occurrence.id];
    if (!current || current.status !== "running" || !isDeepStrictEqual(current.owner, active.occurrence.owner)) refuse("ownership-unavailable");
    const result = structuredClone(receipt);
    if (result.failure_code === "cancelled" && current.cancel_requested_at === null) {
      // Configuration/policy fences are not a fabricated human cancellation.
      result.failure_code = this.fault ?? "ownership-unavailable"; result.next_action = result.counts.proposals_created ? "review-proposals" : "resolve-ownership";
    }
    assertRoutineReceipt(result);
    assertRoutineOccurrence({ ...structuredClone(current), revision: current.revision + 1, updated_at: this.stamp(),
      finished_at: result.finished_at, status: terminal(result), receipt: result });
    // Cancellation may advance revision, never the private claim's immutable bindings.
    for (const key of ["id", "definition", "routine_id", "routine_revision", "occurrence_key", "slot", "trigger", "project_ids",
      "attribution", "budget", "owner", "started_at", "created_at"] as const) {
      if (!isDeepStrictEqual(current[key], active.occurrence[key])) refuse("ownership-unavailable");
    }
    assertRoutineActionBudget(current, this.root);
    const before = readBudgetLedger(this.ledgerPath)!;
    const binding = (ledger: typeof before) => [ledger.subjects[current.budget.subject_id], ledger.reservations[current.budget.reservation_id],
      ledger.admission_intents[current.budget.intent_id], Object.values(ledger.charges).filter((entry) => entry.reservation_id === current.budget.reservation_id)];
    mutateBudgetLedger((tx) => {
      if (!isDeepStrictEqual(binding(readBudgetTransaction(tx).ledger), binding(before))
        || !isDeepStrictEqual(readRoutineDocument(this.path)?.occurrences[current.id], current)) refuse("accounting-unavailable");
      const usage = { reservation_id: current.budget.reservation_id, run_id: current.owner!.run_id,
        runtime_ms: result.consumption.runtime_state === "complete" ? result.consumption.runtime_ms : null, total_tokens: 0 };
      if (result.budget_outcome === "unknown") {
        observeBudgetRun(tx, { ...usage, terminal: false }); markBudgetUnknown(tx, { reservation_id: current.budget.reservation_id });
      }
      observeBudgetRun(tx, { ...usage, terminal: true });
    }, this.ledgerPath, this.stamp());
    mutateRoutineDocument((tx) => {
      const exact = readRoutineTransaction(tx).document.occurrences[current.id];
      if (!isDeepStrictEqual(exact, current)) refuse("ownership-unavailable");
      finishRoutineOccurrence(tx, active.ownership, current.revision, result, terminal(result));
    }, this.path, this.stamp());
    const finished = readRoutineDocument(this.path)?.occurrences[current.id];
    if (!finished || !isDeepStrictEqual(finished.receipt, result) || finished.status !== terminal(result)) refuse("accounting-unavailable");
    if (result.budget_outcome !== "unknown") {
      const accounted = readBudgetLedger(this.ledgerPath)!;
      mutateBudgetLedger((tx) => {
        if (!isDeepStrictEqual(binding(readBudgetTransaction(tx).ledger), binding(accounted))
          || !isDeepStrictEqual(readRoutineDocument(this.path)?.occurrences[current.id], finished)) refuse("accounting-unavailable");
        settleBudgetReservation(tx, { reservation_id: current.budget.reservation_id });
      }, this.ledgerPath, this.stamp());
    }
    this.fault = result.failure_code;
  }
  /** Only this process's active occurrence can receive a durable cancellation. */
  cancel(): void {
    const active = this.active; if (!active) return;
    const at = this.stamp();
    mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (draft) => {
      const entry = draft.occurrences[active.occurrence.id];
      if (!entry || entry.status !== "running" || !isDeepStrictEqual(entry.owner, active.occurrence.owner)) refuse("ownership-unavailable");
      if (entry.cancel_requested_at === null) { entry.cancel_requested_at = at; entry.revision++; entry.updated_at = at; }
    }), this.path, at);
    active.controller.abort();
  }
  async idle(): Promise<void> { await this.active?.promise; }
  async stop(): Promise<void> {
    this.stopping = true;
    try { this.cancel(); } catch { this.fault = "ownership-unavailable"; this.active?.controller.abort(); }
    await this.idle();
  }
}
