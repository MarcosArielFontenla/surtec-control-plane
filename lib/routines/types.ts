import type { BudgetAttribution, BudgetPolicyBinding } from "../budgets/types";

/** Strict data only; no record, hash or persisted owner grants execution authority. */
export const ROUTINE_ACTIONS = ["refresh-evidence", "evaluate-signals", "propose-issues", "generate-local-report"] as const;
export type RoutineAction = typeof ROUTINE_ACTIONS[number];
export const ROUTINE_LIMITS = { documentBytes: 16 * 1024 * 1024, records: 10000, projects: 25, objectiveDepth: 8,
  bindings: 64, nesting: 32, minimumMinutes: 15, maximumMinutes: 10080, runtimeMs: 60000 } as const;
export type RoutineScope = { kind: "company"; id: "surtec" } | { kind: "objective" | "project"; id: string };
export type RoutineConcurrency = "skip" | "coalesce";
export type RoutineCatchUp = "skip-missed" | "run-once";
export interface RoutinePolicyReference { revision: number; fingerprint: string; policy_ids: string[] }
export interface RoutineExecutionLimits {
  max_projects: number; max_attempts: 1; max_runtime_ms: number; max_concurrent_occurrences: 1;
}
/** One immutable configuration revision, retained even after a newer revision exists. */
export interface RoutineRecord {
  schema_version: 1; id: string; revision: number; action: RoutineAction; scope: RoutineScope; enabled: boolean;
  schedule: string | null; schedule_anchor_at: string | null; concurrency: RoutineConcurrency; catch_up: RoutineCatchUp;
  policy: RoutinePolicyReference; limits: RoutineExecutionLimits; created_at: string; updated_at: string;
}
/** Evaluated/skipped slots are high-water, not evidence of execution. One pending slot at most. */
export interface RoutineScheduleCursor {
  schema_version: 1; routine_id: string; routine_revision: number; evaluated_at: string;
  last_slot: string | null; pending_slot: string | null;
}
export type RoutineOccurrenceStatus = "reserved" | "running" | "completed" | "partial" | "failed" | "cancelled" | "needs-review";
export interface RoutineBudgetReference {
  subject_id: string; reservation_id: string; intent_id: string; cap_fingerprint: string;
  admitted_runtime_ms: number; policy_bindings: BudgetPolicyBinding[];
}
export const ROUTINE_EVIDENCE_KINDS = ["git", "ci", "deployment", "dependencies", "health", "organization", "issues", "sessions", "harness", "signals"] as const;
export interface RoutineEvidenceFact {
  kind: typeof ROUTINE_EVIDENCE_KINDS[number]; project_id: string | null;
  state: "fresh" | "stale" | "unavailable"; observed_at: string | null; fingerprint: string | null;
}
export type RoutineFailureCode = "budget-denied" | "budget-exhausted" | "accounting-unavailable" | "ownership-unavailable"
  | "source-unavailable" | "scope-too-large" | "state-invalid" | "action-failed" | "cancelled" | "deadline-exceeded";
export type RoutineNextAction = "none" | "inspect-evidence" | "review-proposals" | "inspect-budget" | "resolve-ownership" | "run-new-occurrence";
export interface RoutineProposalReceipt { key: string; fingerprint: string; issue_id: string | null }
/** No text payloads, commands, URLs, paths, private notes, credentials or raw provider output. */
export interface RoutineReceipt {
  schema_version: 1; occurrence_id: string; occurrence_key: string; routine_id: string; routine_revision: number;
  slot: string; action: RoutineAction; scope: RoutineScope; policy_fingerprint: string; cap_fingerprint: string;
  project_ids: string[]; started_at: string | null; finished_at: string | null; captured_at: string;
  freshness: "fresh" | "partial" | "stale" | "unavailable"; sources: RoutineEvidenceFact[];
  counts: { projects_selected: number; facts_total: number; facts_fresh: number; facts_unavailable: number;
    signals_evaluated: number; proposals_created: number; reports_written: 0 | 1 };
  consumption: { attempts: 0 | 1 | null; runtime_ms: number | null; runtime_state: "complete" | "unknown";
    model_calls: 0; total_tokens: 0; workspace_writes: 0 };
  budget_outcome: "within-limit" | "exhausted" | "denied" | "unknown";
  proposals: RoutineProposalReceipt[]; failure_code: RoutineFailureCode | null; next_action: RoutineNextAction;
}
export interface RoutineOccurrence {
  schema_version: 1; id: string; revision: number; routine_id: string; routine_revision: number; occurrence_key: string;
  definition: RoutineRecord; slot: string; trigger: "scheduled" | "manual" | "catch-up" | "coalesced";
  project_ids: string[]; attribution: BudgetAttribution; budget: RoutineBudgetReference;
  status: RoutineOccurrenceStatus;
  /** Inventory only; live execution additionally requires private process-local ownership. */
  owner: { run_id: string; worker_id: string; claimed_at: string } | null;
  started_at: string | null; finished_at: string | null; cancel_requested_at: string | null;
  receipt: RoutineReceipt | null; created_at: string; updated_at: string;
}
export interface RoutineDocument {
  schema_version: 1; revision: number; created_at: string; updated_at: string;
  routines: Record<string, RoutineRecord>;
  /** Keys are routineRevisionKey(id, revision), not caller-defined history aliases. */
  definitions: Record<string, RoutineRecord>;
  occurrences: Record<string, RoutineOccurrence>;
  cursors: Record<string, RoutineScheduleCursor>;
}
