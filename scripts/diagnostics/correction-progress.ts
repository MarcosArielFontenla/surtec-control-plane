import { types } from "node:util";

export const CORRECTION_PROGRESS_PREFIX = "T008_CORRECTION_PROGRESS ";
export const CORRECTION_PROGRESS_LIMITS = Object.freeze({ variants: 2, events: 256, lane_depth: 4, frame_bytes: 512, snapshot_bytes: 3072 });
const variants = ["qa-false", "qa-true"] as const;
const lanes = ["fixture", "attempt"] as const;
const stages = ["setup", "planning", "implementation", "review", "qa", "correction"] as const;
const operations = ["case", "setup-git", "issue-create", "issue-authorize", "preview", "start", "checkpoint-contract", "select-stage", "run-once", "wait-terminal", "reconcile", "checkpoint", "executor", "plan-decision", "drift-git", "idempotence", "final-decision", "assertions", "task-attempt", "task.started", "policy.evaluated", "worktree.created", "git.diff", "verification.finished", "task.finished"] as const;
const milestones: readonly string[] = ["task.started", "policy.evaluated", "worktree.created", "git.diff", "verification.finished", "task.finished"];
const edges = ["begin", "return", "throw", "milestone", "seal"] as const;
const ordinalStages = ["setup", "planning", "implementation", "review", "qa", "correction", "review", "qa"] as const;
export type CorrectionProgressVariant = typeof variants[number];
export type CorrectionProgressLane = typeof lanes[number];
export type CorrectionProgressStage = typeof stages[number];
export type CorrectionProgressOperation = typeof operations[number];
export type CorrectionProgressEdge = typeof edges[number];
type ProgressFields = { variant: CorrectionProgressVariant; sequence: number; lane: CorrectionProgressLane; ordinal: number; stage: CorrectionProgressStage; operation: CorrectionProgressOperation; edge: CorrectionProgressEdge };
type ProgressEvent = ProgressFields & ({ schema_version: 1 } | { schema_version: 2; case_id: string });
type ProgressFrame = Pick<ProgressEvent, "sequence" | "ordinal" | "stage" | "operation">;
type ClosedFrame = ProgressFrame & Pick<ProgressEvent, "lane" | "edge">;
type Reason = "invalid-frame" | "invalid-channel" | "invalid-binding" | "variant-binding" | "event-order" | "lane-capacity" | "unmatched-return" | "event-capacity" | "snapshot-capacity";
type BindingStatus = "pending" | "confirmed" | "invalid";
type VariantState = { variant: CorrectionProgressVariant; case_id: string; sequence: number; sealed: boolean; reason: Reason | null; open: Record<CorrectionProgressLane, ProgressFrame[]>; last_closed: ClosedFrame | null; last_milestone: ClosedFrame | null; binding_status?: BindingStatus };
const keys = ["schema_version", "variant", "sequence", "lane", "ordinal", "stage", "operation", "edge"];
const member = (list: readonly string[], value: unknown): value is string => typeof value === "string" && list.includes(value);
const validCaseId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function isCorrectionProgressEvent(value: unknown): value is ProgressEvent {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    const version = descriptors.schema_version && Object.hasOwn(descriptors.schema_version, "value") ? descriptors.schema_version.value : null;
    if (version !== 1 && version !== 2) return false;
    const eventKeys = version === 2 ? [...keys, "case_id"] : keys;
    if (names.length !== eventKeys.length || names.some((name) => typeof name !== "string" || !eventKeys.includes(name) || !Object.hasOwn(descriptors[name]!, "value") || !descriptors[name]!.enumerable)) return false;
    const event = Object.fromEntries(eventKeys.map((key) => [key, descriptors[key]!.value]));
    if (version === 2 && !validCaseId(event.case_id) || !member(variants, event.variant) || !member(lanes, event.lane) || !member(stages, event.stage) || !member(operations, event.operation) || !member(edges, event.edge)) return false;
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > CORRECTION_PROGRESS_LIMITS.events || !Number.isSafeInteger(event.ordinal) || event.ordinal < 0 || event.ordinal > 7 || event.stage !== ordinalStages[event.ordinal as number]) return false;
    if (event.edge === "milestone") return event.lane === "attempt" && event.ordinal > 0 && milestones.includes(event.operation);
    if (milestones.includes(event.operation)) return false;
    if (event.operation === "case") return event.lane === "fixture" && event.ordinal === 0 && event.stage === "setup";
    return event.edge !== "seal";
  } catch { return false; }
}

/** Pure observation only: sinks cannot replace a test error or change execution. */
export function createCorrectionProgressEmitter(variant: CorrectionProgressVariant, sink: (line: string) => void, caseId?: string) {
  let sequence = 0, sealed = false, unavailable = false;
  const record = (lane: CorrectionProgressLane, ordinal: number, stage: CorrectionProgressStage, operation: CorrectionProgressOperation, edge: CorrectionProgressEdge): void => {
    if (sealed || unavailable || sequence >= CORRECTION_PROGRESS_LIMITS.events) return;
    const fields: ProgressFields = { variant, sequence: sequence + 1, lane, ordinal, stage, operation, edge };
    const event: ProgressEvent = caseId === undefined ? { schema_version: 1, ...fields } : { schema_version: 2, ...fields, case_id: caseId };
    if (!isCorrectionProgressEvent(event)) { unavailable = true; return; }
    try { sink(CORRECTION_PROGRESS_PREFIX + JSON.stringify(event)); sequence++; }
    catch { unavailable = true; }
  };
  return { record, seal() { if (sealed) return; record("fixture", 0, "setup", "case", "seal"); sealed = true; } };
}

/** An interval without a return is an observation gap, never a cause or grant. */
export function createCorrectionProgressCollector() {
  const states = new Map<CorrectionProgressVariant, VariantState>();
  let schemaVersion: 1 | 2 | null = null;
  let reason: Reason | null = null;
  const unknown = (failure: Reason, state?: VariantState) => {
    reason ??= failure;
    if (state) {
      state.reason ??= failure;
      if (state.binding_status !== undefined && (failure === "invalid-binding" || failure === "variant-binding")) state.binding_status = "invalid";
    }
  };
  function accept(channel: string, jsonText: string, caseId: string | null): void {
    if (channel !== "stdout") { unknown("invalid-channel"); return; }
    if (typeof jsonText !== "string" || Buffer.byteLength(jsonText) > CORRECTION_PROGRESS_LIMITS.frame_bytes) { unknown("invalid-frame"); return; }
    let event: unknown;
    try { event = JSON.parse(jsonText); } catch { unknown("invalid-frame"); return; }
    if (!isCorrectionProgressEvent(event)) { unknown("invalid-frame"); return; }
    if (schemaVersion !== null && schemaVersion !== event.schema_version) { unknown("invalid-binding", states.get(event.variant)); return; }
    schemaVersion = event.schema_version;
    const existing = states.get(event.variant);
    // Legacy frames keep their immediate-binding and sealed-row behavior.
    if (event.schema_version === 1 && existing?.sealed) return;
    const boundCaseId = event.schema_version === 2 ? event.case_id : caseId;
    if (!validCaseId(boundCaseId)) { unknown("invalid-binding", existing); return; }
    if (existing && existing.case_id !== boundCaseId || [...states.values()].some((state) => state.variant !== event.variant && state.case_id === boundCaseId)) { unknown("variant-binding", existing); return; }
    if (existing?.sealed) return;
    const state: VariantState = existing ?? { variant: event.variant, case_id: boundCaseId, sequence: 0, sealed: false, reason: null, open: { fixture: [], attempt: [] }, last_closed: null, last_milestone: null, ...(event.schema_version === 2 ? { binding_status: "pending" as const } : {}) };
    if (!existing) states.set(event.variant, state);
    if (state.reason) return;
    if (event.sequence !== state.sequence + 1) { unknown("event-order", state); return; }
    if (state.sequence === 0 && (event.operation !== "case" || event.edge !== "begin")) { unknown("event-order", state); return; }
    if (event.sequence === CORRECTION_PROGRESS_LIMITS.events) { unknown("event-capacity", state); return; }
    const frame: ProgressFrame = { sequence: event.sequence, ordinal: event.ordinal, stage: event.stage, operation: event.operation };
    const stack = state.open[event.lane];
    if (event.edge === "begin") {
      if (stack.length >= CORRECTION_PROGRESS_LIMITS.lane_depth) { unknown("lane-capacity", state); return; }
      stack.push(frame);
    } else if (event.edge === "return" || event.edge === "throw") {
      const current = stack.at(-1);
      if (!current || current.ordinal !== event.ordinal || current.stage !== event.stage || current.operation !== event.operation) { unknown("unmatched-return", state); return; }
      stack.pop(); state.last_closed = { ...frame, lane: event.lane, edge: event.edge };
    } else if (event.edge === "milestone") state.last_milestone = { ...frame, lane: event.lane, edge: event.edge };
    else state.sealed = true;
    state.sequence = event.sequence;
  }
  function reconcileBindings(resolve: (caseId: string) => BindingStatus): void {
    for (const state of states.values()) {
      if (state.binding_status === undefined || state.binding_status === "invalid") continue;
      let binding: BindingStatus;
      try { binding = resolve(state.case_id); } catch { binding = "invalid"; }
      if (binding === "confirmed") state.binding_status = "confirmed";
      else if (binding !== "pending" || state.binding_status === "confirmed") {
        state.binding_status = "invalid"; unknown("invalid-binding", state);
      }
    }
  }
  function snapshot() {
    const rows = [...states.values()].map((state) => ({ ...state, open: { fixture: state.open.fixture.map((frame) => ({ ...frame })), attempt: state.open.attempt.map((frame) => ({ ...frame })) }, last_closed: state.last_closed && { ...state.last_closed }, last_milestone: state.last_milestone && { ...state.last_milestone } }));
    const pending = rows.some((state) => state.binding_status === "pending");
    const result = { diagnostic_only: true, status: reason || pending ? "unknown" as const : rows.length ? "observed" as const : "unavailable" as const, reason: reason ?? (pending ? "unconfirmed-binding" : rows.length ? "captured" : "not-observed"), variants: rows };
    if (Buffer.byteLength(JSON.stringify(result)) <= CORRECTION_PROGRESS_LIMITS.snapshot_bytes) return result;
    return { diagnostic_only: true, status: "unknown" as const, reason: "snapshot-capacity", variants: rows.map((state) => ({ variant: state.variant, case_id: state.case_id, sequence: state.sequence, sealed: state.sealed, reason: state.reason, open: { fixture: [], attempt: [] }, last_closed: null, last_milestone: null, ...(state.binding_status === undefined ? {} : { binding_status: state.binding_status }) })) };
  }
  return { accept, reconcileBindings, snapshot };
}
