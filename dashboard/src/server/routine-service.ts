import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { resolve } from "node:path";
import { readBudgetPolicy, resolveBudgetPolicy, resolveOccurrenceBudgetAttribution, type BudgetPolicySource, type BudgetSourceView } from "../../../lib/budgets/policy";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetAttribution, type BudgetDimension, type BudgetLedger } from "../../../lib/budgets/types";
import { assertBudgetLedger } from "../../../lib/budgets/validation";
import type { OrganizationSnapshot } from "../../../lib/organization";
import { parseRoutineSchedule, routineRevisionKey, routineSlotKey, routineTimestampEpoch } from "../../../lib/routines/schedule";
import { ROUTINE_ACTIONS, ROUTINE_LIMITS, type RoutineAction, type RoutineCatchUp, type RoutineConcurrency, type RoutineDocument, type RoutineOccurrence, type RoutinePolicyReference, type RoutineReceipt, type RoutineRecord, type RoutineScope } from "../../../lib/routines/types";
import { assertRoutineRecord, createRoutineDraft } from "../../../lib/routines/validation";
import { assertRoutineActionBudget } from "../../../lib/routines/actions";
import { readBudgetLedger } from "../../../lib/state/budgets";
import { readOrganizationSnapshot } from "../../../lib/state/organization";
import { budgetStatePath, organizationStatePath, routineStatePath, stateDir } from "../../../lib/state/paths";
import { mutateRoutineDocument, readRoutineDocument, readRoutineTransaction, updateRoutineTransaction } from "../../../lib/state/routines";
import { isRoutineRunner, type RoutineRunner } from "../../../runner/routine-runner";
import { loadRegistryProjects } from "./registry";

export interface RoutineCreateInput { action: RoutineAction; scope: RoutineScope }
export interface RoutineRevisionInput { expected_revision: number }
export interface RoutineConfigureInput extends RoutineCreateInput, RoutineRevisionInput {
  enabled: boolean; schedule: string | null; concurrency: RoutineConcurrency; catch_up: RoutineCatchUp;
}
export interface RoutineOccurrenceSummary {
  id: string; routine_id: string; routine_revision: number; slot: string; trigger: RoutineOccurrence["trigger"];
  status: RoutineOccurrence["status"]; started_at: string | null; finished_at: string | null;
  cancel_requested_at: string | null; receipt: RoutineReceipt | null;
}
export interface RoutineSummary {
  routine: RoutineRecord; last_occurrence: RoutineOccurrenceSummary | null; next_slot: string | null; occurrences_total: number;
}
export interface RoutineDetail extends RoutineSummary {
  occurrences: RoutineOccurrenceSummary[];
  execution: { state: "inactive" | "fixture-enabled"; executable: false };
}
export interface RoutineList {
  schema_version: 1; state: "absent" | "available" | "unavailable"; observed_at: string | null;
  revision: number | null; routines: RoutineSummary[];
}
export interface RoutineRunResult {
  status: "admitted" | "existing"; occurrence: RoutineOccurrenceSummary;
  execution: { state: "fixture-enabled"; executable: false };
}
export type BudgetReadQuery = { project_id?: string; objective_id?: string };
export type PolicyBudgetSourceView = Omit<BudgetSourceView, "dimensions"> & {
  dimensions: Record<BudgetDimension, { status: "configured" | "unconfigured"; cap: number | null;
    proven_consumed: number | null; consumed: number | null; reserved: number | null; remaining: number | null; warning: boolean | null }>;
};
export interface BudgetReadView {
  schema_version: 1; observed_at: string | null; status: "available" | "exhausted" | "unavailable";
  executable: false; reserves_capacity: false;
  ledger: { status: "absent" | "available" | "unavailable"; revision: number | null; updated_at: string | null };
  policy: { revision: number; fingerprint: string } | null; sources: PolicyBudgetSourceView[];
  pricing: { status: "unavailable"; reason: "no-versioned-source" };
  denials: Array<{ code: "budget-exhausted" | "budget-accounting-unavailable" | "budget-policy-unavailable"; dimension?: BudgetDimension; source_ids: string[] }>;
}
export interface RoutineServiceDependencies {
  stateRoot?: string; clock?: () => Date; readBudgetPolicy?: () => BudgetPolicySource;
  readBudgetLedger?: () => BudgetLedger | null; readOrganization?: () => OrganizationSnapshot;
  listProjects?: () => Array<{ id: string }>;
  /** Code-owned fixture composition only; no HTTP/config/environment activation. */
  execution?: { runner: RoutineRunner; worker_id: string; available_reads: () => number };
}
export class RoutineServiceError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
const zero = (): BudgetAmounts => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, 0])) as BudgetAmounts;
function invalid(): never { throw new RoutineServiceError(400, "Invalid routine or budget input."); }
function unavailable(): never { throw new RoutineServiceError(409, "Routine state, scope, policy or execution is unavailable; no run was confirmed."); }
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || ![...required, ...optional].includes(key) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) invalid();
}
function safeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value)
    || value.includes("..") || ["constructor", "prototype", "__proto__"].includes(value)) invalid();
}
function revisionInput(input: unknown): asserts input is RoutineRevisionInput {
  fields(input, ["expected_revision"]);
  if (!Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 1) invalid();
}
function actionScope(input: Record<string, unknown>): asserts input is Record<string, unknown> & RoutineCreateInput {
  if (typeof input.action !== "string" || !ROUTINE_ACTIONS.includes(input.action as RoutineAction)) invalid();
  fields(input.scope, ["kind", "id"]); safeId(input.scope.id);
  if (!["company", "project", "objective"].includes(input.scope.kind as string)
    || input.scope.kind === "company" && input.scope.id !== "surtec") invalid();
}
function configuration(input: unknown): asserts input is RoutineConfigureInput {
  fields(input, ["expected_revision", "action", "scope", "enabled", "schedule", "concurrency", "catch_up"]);
  actionScope(input); revisionInput({ expected_revision: input.expected_revision });
  if (typeof input.enabled !== "boolean" || !["skip", "coalesce"].includes(input.concurrency as string)
    || !["skip-missed", "run-once"].includes(input.catch_up as string)) invalid();
  try { parseRoutineSchedule(input.schedule); } catch { invalid(); }
}
function compact(entry: RoutineOccurrence): RoutineOccurrenceSummary {
  return { id: entry.id, routine_id: entry.routine_id, routine_revision: entry.routine_revision, slot: entry.slot, trigger: entry.trigger,
    status: entry.status, started_at: entry.started_at, finished_at: entry.finished_at, cancel_requested_at: entry.cancel_requested_at,
    receipt: structuredClone(entry.receipt) };
}

export function createRoutineService(repoRoot: string, dependencies: RoutineServiceDependencies = {}) {
  const root = resolve(dependencies.stateRoot ?? stateDir()), path = routineStatePath(root);
  const clock = dependencies.clock ?? (() => new Date());
  const policyReader = dependencies.readBudgetPolicy ?? (() => readBudgetPolicy(repoRoot));
  const ledgerReader = dependencies.readBudgetLedger ?? (() => readBudgetLedger(budgetStatePath(root)));
  const organizationReader = dependencies.readOrganization ?? (() => readOrganizationSnapshot(organizationStatePath(root)));
  const projectsReader = dependencies.listProjects ?? (() => loadRegistryProjects(repoRoot));
  const execution = dependencies.execution;
  if (execution && (!isRoutineRunner(execution.runner) || typeof execution.available_reads !== "function")) unavailable();
  if (execution) safeId(execution.worker_id);
  const stamp = () => { const at = clock().toISOString(); routineTimestampEpoch(at); return at; };
  const document = () => { try { return readRoutineDocument(path); } catch { return unavailable(); } };
  const current = (id: string, expected?: number, doc = document()) => {
    const entry = doc?.routines[id]; if (!entry) throw new RoutineServiceError(404, "Routine not found.");
    if (expected !== undefined && entry.revision !== expected) throw new RoutineServiceError(409, "Routine revision changed; reload before a new explicit action.");
    return entry;
  };
  function selection(scope: RoutineScope, id: string, readOnly = false): BudgetAttribution {
    const organization = organizationReader(); let projects: string[] = [], objectiveId: string | null = null;
    if (scope.kind === "objective") {
      const selected = organization.objectives.find((entry) => entry.id === scope.id);
      if (!selected) throw new RoutineServiceError(404, "Objective not found.");
      objectiveId = selected.id; projects = readOnly ? [] : [...selected.project_ids];
    }
    if (scope.kind === "project" || !readOnly) {
      const inventory = projectsReader().map((entry) => entry.id); inventory.forEach(safeId);
      if (new Set(inventory).size !== inventory.length) unavailable();
      if (scope.kind === "project") {
        if (!inventory.includes(scope.id)) throw new RoutineServiceError(404, "Project not found.");
        projects = [scope.id]; objectiveId = organization.project_objectives[scope.id]?.primary_objective_id ?? null;
      } else if (scope.kind === "company") projects = inventory;
      if (projects.some((project) => !inventory.includes(project))) unavailable();
    }
    if (projects.length > ROUTINE_LIMITS.projects) unavailable();
    return resolveOccurrenceBudgetAttribution({ organization, project_ids: projects, objective_id: objectiveId, execution_id: id });
  }
  function reference(scope: RoutineScope, id: string, at: string): RoutinePolicyReference {
    const source = policyReader(), attribution = selection(scope, id);
    const resolved = resolveBudgetPolicy({ source, attribution, at, base_caps: zero() });
    return { revision: source.policy.revision, fingerprint: source.fingerprint, policy_ids: resolved.policy_bindings.map((entry) => entry.policy_id).sort() };
  }
  const protect = <T>(operation: () => T): T => {
    try { return operation(); } catch (error) { if (error instanceof RoutineServiceError) throw error; return unavailable(); }
  };
  function summary(entry: RoutineRecord, doc: RoutineDocument, at: string): RoutineSummary {
    const occurrences = Object.values(doc.occurrences).filter((occurrence) => occurrence.routine_id === entry.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    let next: string | null = null;
    const schedule = parseRoutineSchedule(entry.schedule);
    if (entry.enabled && schedule.kind === "interval") {
      const anchor = routineTimestampEpoch(entry.schedule_anchor_at), now = routineTimestampEpoch(at);
      if (now >= anchor) next = new Date(anchor + (Math.floor((now - anchor) / schedule.interval_ms) + 1) * schedule.interval_ms).toISOString();
    }
    return { routine: structuredClone(entry), last_occurrence: occurrences[0] ? compact(occurrences[0]) : null,
      next_slot: next, occurrences_total: occurrences.length };
  }
  function detail(id: string): RoutineDetail {
    safeId(id); return protect(() => {
      const doc = document(), entry = current(id, undefined, doc), at = stamp();
      const occurrences = Object.values(doc!.occurrences).filter((value) => value.routine_id === id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, 20).map(compact);
      return { ...summary(entry, doc!, at), occurrences, execution: { state: execution ? "fixture-enabled" : "inactive", executable: false } };
    });
  }
  function publish(entry: RoutineRecord, at: string, expected: number | null): void {
    mutateRoutineDocument((tx) => {
      const snapshot = readRoutineTransaction(tx).document;
      if (expected !== null) current(entry.id, expected, snapshot);
      else if (snapshot.routines[entry.id]) unavailable();
      updateRoutineTransaction(tx, (draft) => { draft.routines[entry.id] = structuredClone(entry);
        draft.definitions[routineRevisionKey(entry.id, entry.revision)] = structuredClone(entry); });
    }, path, at);
  }
  return {
    list(): RoutineList {
      try {
        const doc = readRoutineDocument(path), at = stamp();
        return { schema_version: 1, state: doc ? "available" : "absent", observed_at: at, revision: doc?.revision ?? null,
          routines: doc ? Object.values(doc.routines).sort((a, b) => a.id.localeCompare(b.id)).map((entry) => summary(entry, doc, at)) : [] };
      } catch { return { schema_version: 1, state: "unavailable", observed_at: null, revision: null, routines: [] }; }
    },
    detail,
    create(input: RoutineCreateInput): RoutineDetail {
      fields(input, ["action", "scope"]); actionScope(input);
      return protect(() => {
        document(); const id = `routine-${randomUUID()}`, at = stamp();
        const entry = createRoutineDraft({ id, action: input.action, scope: input.scope, policy: reference(input.scope, id, at), at });
        publish(entry, at, null); return detail(id);
      });
    },
    configure(id: string, input: RoutineConfigureInput): RoutineDetail {
      safeId(id); configuration(input);
      return protect(() => {
        const before = current(id, input.expected_revision), at = stamp();
        const entry: RoutineRecord = { ...structuredClone(before), action: input.action, scope: structuredClone(input.scope), enabled: input.enabled,
          schedule: input.schedule, schedule_anchor_at: input.schedule === null ? null : at, concurrency: input.concurrency, catch_up: input.catch_up,
          policy: reference(input.scope, id, at), revision: before.revision + 1, updated_at: at };
        assertRoutineRecord(entry); publish(entry, at, before.revision); return detail(id);
      });
    },
    disable(id: string, input: RoutineRevisionInput): RoutineDetail {
      safeId(id); revisionInput(input);
      return protect(() => {
        const before = current(id, input.expected_revision), at = stamp();
        const entry = { ...structuredClone(before), enabled: false, schedule_anchor_at: before.schedule === null ? null : at,
          revision: before.revision + 1, updated_at: at };
        assertRoutineRecord(entry); publish(entry, at, before.revision);
        if (execution?.runner.activeCount === 1 && Object.values(document()!.occurrences).some((occurrence) => occurrence.routine_id === id
          && occurrence.status === "running" && occurrence.owner?.worker_id === execution.worker_id)) execution.runner.cancel();
        return detail(id);
      });
    },
    run(id: string, input: RoutineRevisionInput): RoutineRunResult {
      safeId(id); revisionInput(input);
      return protect(() => {
        const before = document(), entry = current(id, input.expected_revision, before), at = stamp();
        if (!entry.enabled || !execution) unavailable();
        if (!isDeepStrictEqual(reference(entry.scope, id, at), entry.policy)) unavailable();
        const key = routineSlotKey(id, entry.revision, at);
        const existing = Object.values(before!.occurrences).find((value) => value.occurrence_key === key && value.trigger === "manual");
        if (existing) return { status: "existing", occurrence: compact(existing), execution: { state: "fixture-enabled", executable: false } };
        const capacity = execution.available_reads();
        if (!Number.isSafeInteger(capacity) || capacity < 1) unavailable();
        execution.runner.runManual(id, input.expected_revision, execution.worker_id, capacity);
        const occurrence = Object.values(document()!.occurrences).find((value) => !Object.hasOwn(before!.occurrences, value.id)
          && value.routine_id === id && value.trigger === "manual" && routineTimestampEpoch(value.slot) >= routineTimestampEpoch(at)
          && isDeepStrictEqual(value.definition, entry) && value.status === "running" && value.owner?.worker_id === execution.worker_id);
        if (!occurrence) unavailable();
        try {
          if (execution.runner.activeCount !== 1 || execution.runner.lastFailure !== null
            || !isDeepStrictEqual(selection(entry.scope, occurrence.id), occurrence.attribution)) unavailable();
          assertRoutineActionBudget(occurrence, root);
        } catch { execution.runner.cancel(); unavailable(); }
        return { status: "admitted", occurrence: compact(occurrence), execution: { state: "fixture-enabled", executable: false } };
      });
    },
    warnings(): string[] {
      const result = this.list();
      if (result.state === "unavailable") return ["Routine state is unavailable; inspect local evidence before any new run."];
      return result.routines.some((entry) => entry.last_occurrence?.status === "needs-review")
        ? ["Routine ownership or accounting requires review; no automatic replay was enabled."] : [];
    },
    budgets(query: BudgetReadQuery = {}): BudgetReadView {
      fields(query, [], ["project_id", "objective_id"]);
      if (query.project_id !== undefined) safeId(query.project_id);
      if (query.objective_id !== undefined) safeId(query.objective_id);
      if (Object.keys(query).length > 1) invalid();
      const scope: RoutineScope = query.project_id !== undefined ? { kind: "project", id: query.project_id }
        : query.objective_id !== undefined ? { kind: "objective", id: query.objective_id } : { kind: "company", id: "surtec" };
      return protect(() => {
        const at = stamp(), attribution = selection(scope, "budget-read", true);
        let ledger: BudgetLedger | null = null, ledgerStatus: BudgetReadView["ledger"]["status"] = "absent";
        try { ledger = ledgerReader(); if (ledger !== null) { assertBudgetLedger(ledger);
          if (Date.parse(ledger.updated_at) > Date.parse(at)) unavailable(); ledgerStatus = "available"; } }
        catch { ledger = null; ledgerStatus = "unavailable"; }
        const result: BudgetReadView = { schema_version: 1, observed_at: at, status: "unavailable", executable: false, reserves_capacity: false,
          ledger: { status: ledgerStatus, revision: ledger?.revision ?? null, updated_at: ledger?.updated_at ?? null }, policy: null,
          sources: [], pricing: { status: "unavailable", reason: "no-versioned-source" }, denials: [] };
        const sources = (values: BudgetSourceView[], accountingKnown: boolean): PolicyBudgetSourceView[] => values
          .filter((value) => value.kind === "policy").map((value) => ({ ...structuredClone(value),
            dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, accountingKnown ? { ...value.dimensions[dimension] }
              : { ...value.dimensions[dimension], proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null }])) as PolicyBudgetSourceView["dimensions"] }));
        try {
          const source = policyReader();
          // Only policy source projections are returned. Zero base caps are not business limits or admission evidence.
          const staticView = resolveBudgetPolicy({ source, attribution, at, base_caps: zero() });
          result.policy = { revision: source.policy.revision, fingerprint: source.fingerprint };
          result.sources = sources(staticView.sources, false);
          const view = ledger ? resolveBudgetPolicy({ source, attribution, at, base_caps: zero(), ledger }) : staticView;
          result.sources = sources(view.sources, ledger !== null);
          result.status = ledger ? "available" : "unavailable";
          for (const dimension of BUDGET_DIMENSIONS) {
            const configured = result.sources.filter((value) => value.dimensions[dimension].status === "configured");
            const unknown = configured.filter((value) => value.dimensions[dimension].consumed === null);
            const exhausted = configured.filter((value) => value.dimensions[dimension].remaining === 0);
            if (unknown.length) { result.status = "unavailable"; result.denials.push({ code: "budget-accounting-unavailable", dimension, source_ids: unknown.map((value) => value.id) }); }
            else if (exhausted.length) { if (result.status !== "unavailable") result.status = "exhausted";
              result.denials.push({ code: "budget-exhausted", dimension, source_ids: exhausted.map((value) => value.id) }); }
          }
          if (!ledger && !result.denials.length) result.denials.push({ code: "budget-accounting-unavailable", source_ids: [] });
        } catch { result.status = "unavailable";
          result.denials = [{ code: result.policy === null ? "budget-policy-unavailable" : "budget-accounting-unavailable", source_ids: [] }]; }
        return result;
      });
    },
  };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
