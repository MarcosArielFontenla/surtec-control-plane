import type { WorkScale } from "../organization/issue-lifecycle";
import type { ReviewDepth, RoutingDecision } from "./types";

export interface RoutingInput {
  sandbox: "read-only" | "workspace-write";
  workScale: WorkScale; criticality: "low" | "medium" | "high"; securityImpact: boolean;
  requiresMigration: boolean; affectedDomains: string[]; allowedPathPatterns: string[];
  roleId: string; minimumReview: ReviewDepth; testingMode: "functional" | "strict-tdd";
  authorizationCurrent: boolean; requiredContextValid: boolean; budgetRemaining: boolean;
  availableConcurrency: number; activeProjectWriter: boolean;
  independentAcceptance: boolean; isolationBenefit: "none" | "independent-review" | "independent-qa" | "read-only-exploration" | "non-overlapping-domains";
}
export function routeWork(input: RoutingInput): RoutingDecision {
  const reasons: string[] = [];
  const domains = [...new Set(input.affectedDomains)].sort();
  const risk = input.securityImpact || input.requiresMigration || input.criticality === "high";
  const full = risk || input.workScale === "substantial" || input.minimumReview === "full";
  let action: RoutingDecision["action"] = "direct";
  if (!input.authorizationCurrent) reasons.push("Exact issue/task authorization is missing or stale");
  if (!input.requiredContextValid) reasons.push("Required context is invalid or unavailable");
  if (!input.budgetRemaining) reasons.push("Execution budget is exhausted");
  if (input.availableConcurrency < 1) reasons.push("No execution capacity is currently available; preview reserves none");
  if (input.activeProjectWriter && input.sandbox === "workspace-write") reasons.push("A project writer is active; another write is not admitted");
  if (reasons.length) action = "needs-decision";
  else if (input.roleId === "reviewer") action = "review";
  else if (input.roleId === "qa-evaluator") action = "qa";
  else if (input.roleId === "planner" || input.workScale === "substantial" || input.requiresMigration || domains.length > 1) action = "planning";
  reasons.push(`${input.workScale} work; ${input.criticality} criticality; ${domains.join(", ") || "no declared domain"}`);
  reasons.push(`${full ? "Full" : "Focused"} review required by effective risk/policy; testing mode ${input.testingMode}`);
  if (!input.allowedPathPatterns.length) reasons.push("No write paths are authorized; this decision grants no path authority");
  const delegationReasons: string[] = [];
  if (input.workScale === "trivial") delegationReasons.push("Trivial work does not justify delegation");
  if (!input.independentAcceptance) delegationReasons.push("Independent observable acceptance is unavailable");
  if (input.isolationBenefit === "none") delegationReasons.push("No concrete isolation or verification benefit");
  if (input.availableConcurrency < 2 || !input.budgetRemaining) delegationReasons.push("Insufficient independent capacity or budget");
  if (input.activeProjectWriter && input.isolationBenefit === "non-overlapping-domains") delegationReasons.push("Active write ownership cannot be shared");
  if (action === "needs-decision") delegationReasons.push("Primary work admission requires a human decision");
  const admitted = delegationReasons.length === 0;
  if (admitted) delegationReasons.push(`Independent ${input.isolationBenefit} benefit and acceptance permit a proposal`);
  delegationReasons.push("Delegated execution is unavailable until the separately authorized workflow phase");
  return { work_scale: input.workScale, action, review_depth: full ? "full" : "focused", qa_required: full || input.roleId === "qa-evaluator", reasons, delegation: { admitted, executable: false, reasons: delegationReasons } };
}
