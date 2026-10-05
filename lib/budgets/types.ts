/** Data contracts only. A validated record is never execution or controller authority. */
export const BUDGET_DIMENSIONS = ["attempts", "runtime_ms", "total_tokens", "concurrent_reads", "concurrent_writes", "review_attempts", "review_runtime_ms", "review_total_tokens", "corrections"] as const;
export type BudgetDimension = typeof BUDGET_DIMENSIONS[number];
export const BUDGET_LIMITS = { documentBytes: 16 * 1024 * 1024, records: 10000, projects: 25, objectiveDepth: 8, bindings: 64 } as const;
export type BudgetAmounts = Record<BudgetDimension, number>;
export type BudgetLimit = { status: "unconfigured" } | { status: "configured"; hard_cap: number };
export type BudgetLimits = Record<BudgetDimension, BudgetLimit>;
export type BudgetPeriod = "none" | "utc-day" | "utc-month";
export interface BudgetScope { kind: "company" | "objective" | "project" | "issue" | "role" | "execution"; id: string }
export interface BudgetPolicyRule {
  id: string; revision: number; scope: BudgetScope; period: BudgetPeriod;
  warning_percent: number; limits: BudgetLimits;
}
export interface BudgetPolicy {
  schema_version: 1; revision: number; rules: BudgetPolicyRule[];
  pricing: { status: "unavailable"; reason: "no-versioned-source" };
}
/** Immutable policy/source snapshot; balances are deliberately absent. */
export interface BudgetPolicyBinding {
  policy_id: string; policy_revision: number; policy_fingerprint: string;
  scope: BudgetScope; period: BudgetPeriod; bucket: string; limits: BudgetLimits;
}
export interface BudgetWorkflowBinding { workflow_id: string; stage_id: string; stage_generation: number; grant_id: string }
export interface BudgetAttribution {
  company_id: "surtec"; objective_ids: string[]; project_ids: string[];
  issue_id: string | null; role_id: string | null; execution_id: string;
}
export interface BudgetTaskSubject {
  id: string; kind: "task"; task_id: string; project_id: string; role_id: string; agent_id: string;
  issue_id: string | null; workflow: BudgetWorkflowBinding | null; attribution: BudgetAttribution;
}
export interface BudgetOccurrenceSubject {
  id: string; kind: "occurrence"; occurrence_id: string; routine_id: string; routine_revision: number;
  slot: string; project_ids: string[]; attribution: BudgetAttribution;
}
export type BudgetSubject = BudgetTaskSubject | BudgetOccurrenceSubject;
/** Independent v1 contract, even when the bound context admission is v2. */
export interface BudgetAdmission {
  schema_version: 1; id: string; subject_id: string; task_id: string; project_id: string; role_id: string; agent_id: string;
  issue_id: string | null; scope_revision: number | null; scope_fingerprint: string | null;
  context_admission_version: 1 | 2; workflow: BudgetWorkflowBinding | null;
  attribution: BudgetAttribution;
  execution_mode: "read" | "write"; manifest_fingerprint: string; admitted_cap_fingerprint: string;
  reservation_id: string; intent_id: string; created_at: string;
  policy_bindings: BudgetPolicyBinding[]; caps: BudgetAmounts;
}
export interface BudgetAdmissionIntent {
  id: string; subject_id: string; reservation_id: string; admission_id: string | null;
  status: "pending" | "committed" | "unknown"; created_at: string; updated_at: string;
}
export interface BudgetReservation {
  id: string; revision: number; subject_id: string; intent_id: string;
  status: "pending" | "committed" | "active" | "settled" | "unknown";
  policy_bindings: BudgetPolicyBinding[]; held: BudgetAmounts; uncertain_dimensions: BudgetDimension[];
  run_ids: string[]; created_at: string; updated_at: string;
}
/** One canonical subject/run charge. Review/correction are overlapping labels, not extra charges. */
export interface BudgetRunCharge {
  id: string; subject_id: string; reservation_id: string; run_id: string;
  attempts: 1; runtime_ms: number; observed_total_tokens: number | null;
  runtime_state: "complete" | "unknown"; usage_state: "complete" | "unknown";
  status: "running" | "terminal"; review: boolean; correction: boolean;
  created_at: string; updated_at: string;
}
export interface BudgetLedger {
  schema_version: 1; revision: number; created_at: string; updated_at: string;
  subjects: Record<string, BudgetSubject>; reservations: Record<string, BudgetReservation>;
  admission_intents: Record<string, BudgetAdmissionIntent>; charges: Record<string, BudgetRunCharge>;
}
