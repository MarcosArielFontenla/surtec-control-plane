import { contextHash } from "../../../lib/context/assemble";
import type { ExecutionBudget } from "../../../lib/context/types";
import { readBudgetPolicy, resolveBudgetPolicy, type BudgetCorrectionLineage, type BudgetPolicySource, type ExistingBudgetConstraint, type ResolvedBudgetPolicy } from "../../../lib/budgets/policy";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetAttribution, type BudgetDimension, type BudgetLedger, type BudgetPolicyBinding } from "../../../lib/budgets/types";
import { readBudgetLedger } from "../../../lib/state/budgets";
import type { SandboxMode } from "../../../lib/state/types";
import type { WorkflowStageKind } from "../../../lib/workflows/types";
import { types as nodeTypes } from "node:util";

export const BUDGET_PREVIEW_LIMITATION = "Informational preview only; no capacity is reserved and no execution authority is granted. Balances are not instruction sources. Current availability and exact immutable admission must be validated atomically before effects after the separately confirmed Phase P cutover.";
export interface BudgetServiceDependencies {
  readBudgetPolicy?: () => BudgetPolicySource;
  readBudgetLedger?: () => BudgetLedger | null;
  clock?: () => Date;
}
export interface BudgetPreviewInput {
  attribution: BudgetAttribution;
  base_caps: BudgetAmounts;
  constraints?: ExistingBudgetConstraint[];
  correction_lineages?: BudgetCorrectionLineage[];
  require_currency?: boolean;
}
export interface BudgetPreview {
  schema_version: 1;
  observed_at: string | null;
  status: "available" | "exhausted" | "unavailable";
  can_admit: boolean;
  executable: false;
  reserves_capacity: false;
  ledger: { status: "absent" | "available" | "unavailable"; revision: number | null; updated_at: string | null };
  // Static ceilings/source identity only, never an actual allocation or ownership proof.
  binding: { attribution: BudgetAttribution; cap_fingerprint: string; policy_bindings: BudgetPolicyBinding[]; ceilings: BudgetAmounts } | null;
  resolution: ResolvedBudgetPolicy | null;
  prospective_hold: BudgetAmounts | null;
  denials: Array<ResolvedBudgetPolicy["denials"][number] | { code: "budget-reservation-insufficient"; dimension: BudgetDimension; source_ids: string[] } | { code: "budget-policy-unavailable" | "budget-ledger-unavailable" | "budget-preview-unavailable"; source_ids: string[] }>;
  limitation: string;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function unavailableBudgetPreview(): BudgetPreview {
  return freeze({ schema_version: 1, observed_at: null, status: "unavailable", can_admit: false, executable: false, reserves_capacity: false,
    ledger: { status: "unavailable", revision: null, updated_at: null }, binding: null, resolution: null, prospective_hold: null,
    denials: [{ code: "budget-preview-unavailable", source_ids: ["preview:unavailable"] }], limitation: BUDGET_PREVIEW_LIMITATION });
}

/** Code-owned conversion of finite existing leaf ceilings, not a request authority. */
export function budgetAmounts(budget: ExecutionBudget, sandbox: SandboxMode, kind?: WorkflowStageKind): BudgetAmounts {
  if (!budget || Object.keys(budget).length !== 3 || !["max_attempts", "max_runtime_ms", "max_total_tokens"].every((key) => Object.hasOwn(budget, key) && Number.isSafeInteger(budget[key as keyof ExecutionBudget]) && budget[key as keyof ExecutionBudget] > 0)
    || !["read-only", "workspace-write"].includes(sandbox) || kind !== undefined && !["analysis", "planning", "implementation", "correction", "review", "qa", "operations"].includes(kind)) throw new Error("Invalid finite preview ceilings");
  const review = kind === "review" || kind === "qa";
  return { attempts: budget.max_attempts, runtime_ms: budget.max_runtime_ms, total_tokens: budget.max_total_tokens,
    concurrent_reads: sandbox === "read-only" ? 1 : 0, concurrent_writes: sandbox === "workspace-write" ? 1 : 0,
    review_attempts: review ? budget.max_attempts : 0, review_runtime_ms: review ? budget.max_runtime_ms : 0, review_total_tokens: review ? budget.max_total_tokens : 0, corrections: kind === "correction" ? 1 : 0 };
}

/** Availability is separate from source identity. Never hash balances or receipt histories. */
export function existingBudgetConstraint(input: {
  id: string; kind: ExistingBudgetConstraint["kind"]; revision: number; fingerprint: string;
  caps: BudgetAmounts; availability?: Partial<Record<BudgetDimension, number | null>>;
}): ExistingBudgetConstraint {
  const limits = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "configured" as const, hard_cap: input.caps[dimension] }])) as ExistingBudgetConstraint["limits"];
  const availability = input.availability === undefined ? undefined : Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => {
    const value = Object.hasOwn(input.availability!, dimension) ? input.availability![dimension] : input.caps[dimension];
    return [dimension, value === null ? { status: "unavailable" as const } : { status: "known" as const, remaining: value! }];
  })) as ExistingBudgetConstraint["availability"];
  return { id: input.id, kind: input.kind, revision: input.revision, fingerprint: input.fingerprint, limits, ...(availability === undefined ? {} : { availability }) };
}

// No mutation helpers, lock, mkdir, task/controller proof or self-exclusion path.
export function createBudgetService(repoRoot: string, dependencies: BudgetServiceDependencies = {}) {
  const policyReader = dependencies.readBudgetPolicy ?? (() => readBudgetPolicy(repoRoot));
  const ledgerReader = dependencies.readBudgetLedger ?? readBudgetLedger;
  return {
    preview(input: BudgetPreviewInput): BudgetPreview {
      const result: BudgetPreview = { schema_version: 1, observed_at: null, status: "unavailable", can_admit: false, executable: false, reserves_capacity: false,
        ledger: { status: "unavailable", revision: null, updated_at: null }, binding: null, resolution: null, prospective_hold: null, denials: [], limitation: BUDGET_PREVIEW_LIMITATION };
      let phase: "clock" | "policy" | "input" | "ledger" = "clock";
      try {
        const at = (dependencies.clock?.() ?? new Date()).toISOString(); result.observed_at = at;
        phase = "policy"; const source = policyReader();
        phase = "input";
        const required = ["attribution", "base_caps"], keys = [...required, "constraints", "correction_lineages", "require_currency"];
        if (!input || typeof input !== "object" || Array.isArray(input) || nodeTypes.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
          || required.some((key) => !Object.hasOwn(input, key)) || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !keys.includes(key)
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, "value") || !Object.getOwnPropertyDescriptor(input, key)!.enumerable)) throw new Error("Invalid preview input");
        // Validates exact bounded data before a ledger read. This projection is
        // used ONLY for its static binding; its assumed-empty balances never escape.
        const staticResolution = resolveBudgetPolicy({ ...input, source, at });
        const requested = input.base_caps, reviewRequested = requested.review_attempts > 0 || requested.review_runtime_ms > 0 || requested.review_total_tokens > 0;
        if (requested.attempts < 1 || requested.runtime_ms < 1 || requested.total_tokens < 1 || requested.corrections > 1
          || !(requested.concurrent_reads === 1 && requested.concurrent_writes === 0 || requested.concurrent_reads === 0 && requested.concurrent_writes === 1)
          || reviewRequested && !(requested.review_attempts > 0 && requested.review_runtime_ms > 0 && requested.review_total_tokens > 0
            && requested.review_attempts <= requested.attempts && requested.review_runtime_ms <= requested.runtime_ms && requested.review_total_tokens <= requested.total_tokens)) throw new Error("Invalid prospective task ceilings");
        result.binding = { attribution: copy(input.attribution), cap_fingerprint: staticResolution.cap_fingerprint, policy_bindings: copy(staticResolution.policy_bindings), ceilings: copy(staticResolution.ceilings) };
        phase = "ledger"; const ledger = ledgerReader();
        const resolution = resolveBudgetPolicy({ ...input, source, at, ...(ledger === null ? {} : { ledger }) });
        result.ledger = ledger === null ? { status: "absent", revision: null, updated_at: null } : { status: "available", revision: ledger.revision, updated_at: ledger.updated_at };
        result.resolution = copy(resolution); result.denials = copy(resolution.denials);
        const caps = resolution.ceilings, review = input.base_caps.review_attempts > 0 || input.base_caps.review_runtime_ms > 0 || input.base_caps.review_total_tokens > 0;
        const runtime = review ? Math.min(caps.runtime_ms, caps.review_runtime_ms) : caps.runtime_ms, tokens = review ? Math.min(caps.total_tokens, caps.review_total_tokens) : caps.total_tokens;
        // A positive remaining amount is not necessarily sufficient to reserve
        // the prospective ceiling-sized first slice. Forecast the same overlap
        // as T003 without creating or excluding any actual reservation.
        result.prospective_hold = { attempts: 1, runtime_ms: runtime, total_tokens: tokens, concurrent_reads: caps.concurrent_reads, concurrent_writes: caps.concurrent_writes,
          review_attempts: review ? 1 : 0, review_runtime_ms: review ? runtime : 0, review_total_tokens: review ? tokens : 0, corrections: caps.corrections };
        for (const dimension of BUDGET_DIMENSIONS) {
          const view = resolution.dimensions[dimension];
          if (view.remaining !== null && view.remaining > 0 && result.prospective_hold[dimension] > view.remaining) result.denials.push({ code: "budget-reservation-insufficient", dimension, source_ids: [...view.limiting_sources] });
        }
        result.can_admit = result.denials.length === 0;
        result.status = result.can_admit ? "available" : result.denials.some((entry) => !["budget-exhausted", "budget-reservation-insufficient"].includes(entry.code)) ? "unavailable" : "exhausted";
      } catch {
        // Do not leak YAML/JSON/provider excerpts, private paths or arbitrary errors.
        // Unavailable accounting is not an empty ledger or known zero balance.
        result.denials = [{ code: phase === "policy" ? "budget-policy-unavailable" : phase === "ledger" ? "budget-ledger-unavailable" : "budget-preview-unavailable", source_ids: [phase === "policy" ? "policy:unavailable" : phase === "ledger" ? "ledger:unavailable" : "preview:unavailable"] }];
      }
      return freeze(result);
    },
  };
}
export type BudgetService = ReturnType<typeof createBudgetService>;

/** Preview has no future task/run identity; do not invent an exact execution binding. */
export function previewBudgetExecutionId(project: string, role: string, issueId: string | null): string {
  return `preview-${contextHash(JSON.stringify([project, role, issueId]))}`;
}
