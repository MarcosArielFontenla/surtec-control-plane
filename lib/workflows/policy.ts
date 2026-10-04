import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { evidenceHash, testingEvidenceStatus, type TestingEvidence } from "../context/testing-evidence";
import type { ExecutionBudget } from "../context/types";
import type { WorkIssue } from "../issues/types";
import { redactText } from "../security/redaction";
import { assertResolvedWorkflowReviewPolicy } from "./review-policy";
import type { GovernedWorkflow, ReviewReceipt, WorkflowBudget, WorkflowCandidateBinding, WorkflowCandidateLineage, WorkflowCorrection, WorkflowCounters, WorkflowGrant, WorkflowPolicy, WorkflowRoleOutput } from "./types";
import { assertReviewReceipt, assertWorkflowCandidateLineage, assertWorkflowGrant, assertWorkflowPolicy, assertWorkflowRecord, assertWorkflowRoleOutput, WorkflowContractError } from "./validation";

export const WORKFLOW_BUDGET_CEILINGS: Readonly<WorkflowBudget> = Object.freeze({ max_tasks: 7, max_attempts: 14, max_runtime_ms: 1800000, max_total_tokens: 300000 });
export const CORRECTION_BUDGET_CEILINGS: Readonly<WorkflowBudget> = Object.freeze({ max_tasks: 3, max_attempts: 4, max_runtime_ms: 300000, max_total_tokens: 40000 });
// These are a code-owned floor for automated correction, not a new restriction
// on ordinary human-authorized implementation. Trusted source/probe paths add
// project-specific protections and cannot be waived by a model finding.
export const CORRECTION_PROTECTED_PATTERNS: readonly string[] = Object.freeze([
  "AGENTS.md", ".agents/**", ".codex/**", "registry/**", "schemas/**", "lib/policy/**", "lib/security/**", "lib/context/**", "lib/workflows/**", "runner/**",
  "dashboard/src/server/dispatch.ts", "dashboard/src/server/issue-service.ts", "dashboard/src/server/workflow*.ts", "dashboard/src/server/index.ts", "dashboard/src/server/serve.ts",
]);
const budgetKeys = ["max_tasks", "max_attempts", "max_runtime_ms", "max_total_tokens"] as const;
const counterKeys = ["tasks", "attempts", "runtime_ms", "total_tokens"] as const;
function requirePolicy(ok: boolean, message: string): void { if (!ok) throw new WorkflowContractError(message); }
function assertBudget(value: WorkflowBudget, ceiling: Readonly<WorkflowBudget> = WORKFLOW_BUDGET_CEILINGS): void {
  requirePolicy(!!value && Object.keys(value).length === budgetKeys.length && budgetKeys.every((key) => Object.hasOwn(value, key)
    && Number.isSafeInteger(value[key]) && value[key] >= 1 && value[key] <= ceiling[key]), "Invalid or excessive workflow budget");
}
function assertCounters(value: WorkflowCounters): void {
  requirePolicy(!!value && Object.keys(value).length === 5 && counterKeys.every((key) => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]) && value[key] >= 0)
    && Object.hasOwn(value, "accounting_complete") && typeof value.accounting_complete === "boolean", "Invalid workflow accounting");
}
function assertPolicy(value: WorkflowPolicy): void {
  assertWorkflowPolicy(value);
  requirePolicy(CORRECTION_PROTECTED_PATTERNS.every((pattern) => value.protected_path_patterns.includes(pattern)), "Workflow policy removed required correction protections");
}
export function readWorkflowPolicy(root: string): WorkflowPolicy {
  let value: unknown;
  try {
    let path = root;
    if (lstatSync(path).isSymbolicLink()) throw new Error("linked root");
    for (const part of ["registry", "workflow-policy.yml"]) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) throw new Error("linked configuration");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("configuration bounds");
    value = parse(readFileSync(path, "utf8"));
  } catch { throw new WorkflowContractError("Workflow policy is missing, unsafe or unreadable"); }
  assertPolicy(value as WorkflowPolicy);
  return value as WorkflowPolicy;
}
export function resolveWorkflowBudget(policy: WorkflowPolicy, requested?: WorkflowBudget): WorkflowBudget {
  assertPolicy(policy);
  const budget = requested ?? policy.default_budget;
  assertBudget(budget);
  requirePolicy(budgetKeys.every((key) => budget[key] <= policy.default_budget[key]), "Requested budget exceeds current workflow policy");
  return { ...budget };
}
export function resolveWorkflowCorrection(policy: WorkflowPolicy, root: WorkflowBudget, enabled = false): WorkflowCorrection {
  resolveWorkflowBudget(policy, root);
  requirePolicy(typeof enabled === "boolean", "Invalid correction opt-in");
  if (!enabled) return { enabled: false, max_corrections: 0, budget: null };
  const budget = Object.fromEntries(budgetKeys.map((key) => [key, Math.min(policy.correction_budget[key], root[key])])) as unknown as WorkflowBudget;
  return { enabled: true, max_corrections: 1, budget };
}
export interface BudgetAvailability { remaining: WorkflowBudget | null; can_admit: boolean; reasons: string[] }
export function remainingWorkflowBudget(budget: WorkflowBudget, counters: WorkflowCounters): BudgetAvailability {
  assertBudget(budget); assertCounters(counters);
  if (!counters.accounting_complete) return { remaining: null, can_admit: false, reasons: ["Interrupted or incomplete usage requires a human accounting decision"] };
  const remaining = Object.fromEntries(budgetKeys.map((key, index) => [key, Math.max(0, budget[key] - counters[counterKeys[index]!])])) as unknown as WorkflowBudget;
  const reasons = budgetKeys.filter((key) => remaining[key] === 0).map((key) => `Workflow ${key} is exhausted`);
  return { remaining, can_admit: reasons.length === 0, reasons };
}
export function resolveWorkflowStageBudget(input: {
  root: WorkflowBudget; counters: WorkflowCounters; role: ExecutionBudget; project: ExecutionBudget; worker: ExecutionBudget;
  correction?: { budget: WorkflowBudget; counters: WorkflowCounters };
}): { budget: ExecutionBudget | null; reasons: string[] } {
  const availability = remainingWorkflowBudget(input.root, input.counters);
  const correction = input.correction ? remainingWorkflowBudget(input.correction.budget, input.correction.counters) : null;
  if (input.correction) assertBudget(input.correction.budget, CORRECTION_BUDGET_CEILINGS);
  for (const cap of [input.role, input.project, input.worker]) requirePolicy(!!cap && Object.keys(cap).length === 3
    && budgetKeys.slice(1).every((key) => Object.hasOwn(cap, key) && Number.isSafeInteger(cap[key as keyof ExecutionBudget]) && cap[key as keyof ExecutionBudget] >= 1), "Missing or invalid current stage budget constraint");
  const reasons = [...availability.reasons, ...(correction?.reasons ?? [])];
  if (!availability.can_admit || correction && !correction.can_admit) return { budget: null, reasons };
  const caps = [availability.remaining!, input.role, input.project, input.worker, ...(correction ? [correction.remaining!] : [])];
  return { budget: { max_attempts: Math.min(...caps.map((cap) => cap.max_attempts)), max_runtime_ms: Math.min(...caps.map((cap) => cap.max_runtime_ms)), max_total_tokens: Math.min(...caps.map((cap) => cap.max_total_tokens)) }, reasons };
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\\:\x00-\x1f\x7f]/.test(value)
    && !value.startsWith("/") && value.split("/").every((part) => !!part && part !== "." && part !== "..") && redactText(value) === value;
}
// Same *, ** and ? semantics as the canonical issue-service scope guard. No
// filesystem paths or brace/extglob/negation authority is interpreted here.
function matches(path: string, pattern: string, protectCaseVariants = false): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  // Scope remains case-sensitive like the canonical guard; protections are
  // additionally conservative on case-insensitive Windows filesystems.
  return new RegExp(`${source}$`, protectCaseVariants ? "i" : "").test(path);
}
export function correctionPathReasons(input: {
  paths: string[]; scope: WorkIssue["authorized_scope"]; policy: WorkflowPolicy; trusted_source_paths: string[]; verification_probe_paths: string[];
}): string[] {
  assertPolicy(input.policy);
  const scope = input.scope;
  requirePolicy(!!scope && [input.paths, scope.allowed_path_patterns, scope.excluded_path_patterns, input.trusted_source_paths, input.verification_probe_paths].every((paths) => Array.isArray(paths)
    && paths.length <= 1000 && paths.every(safePath)) && scope.allowed_path_patterns.length > 0, "Invalid correction scope or protected paths");
  const reasons: string[] = [];
  if (!input.paths.length) reasons.push("Correction has no concrete proposed paths");
  if (input.paths.some((path) => !scope.allowed_path_patterns.some((pattern) => matches(path, pattern)) || scope.excluded_path_patterns.some((pattern) => matches(path, pattern)))) reasons.push("Correction paths exceed the exact authorized scope");
  const protectedPatterns = [...CORRECTION_PROTECTED_PATTERNS, ...input.policy.protected_path_patterns];
  if (input.paths.some((path) => protectedPatterns.some((pattern) => matches(path, pattern, true)) || input.trusted_source_paths.some((source) => path.toLowerCase() === source.toLowerCase()))) reasons.push("Correction would change protected policy, Harness or approval sources");
  if (input.paths.some((path) => input.verification_probe_paths.some((probe) => path.toLowerCase() === probe.toLowerCase()))) reasons.push("Correction would change trusted verification probes");
  return reasons;
}
export function hasConcreteCorrectionFinding(output: WorkflowRoleOutput | null | undefined): output is Extract<WorkflowRoleOutput, { kind: "review" | "qa" }> {
  if (!output || (output.kind !== "review" && output.kind !== "qa")) return false;
  const blocking = output.findings.filter((finding) => finding.severity === "blocking");
  return output.status === "completed" && output.verdict === "correction-required" && output.requested_decision === null
    && output.unresolved_questions.length === 0 && blocking.length > 0
    && output.findings.every((finding) => !finding.scope_change_required
      && (finding.severity !== "blocking" || finding.path !== null && finding.evidence_ids.length > 0));
}
export interface CorrectionEligibilityInput {
  workflow: GovernedWorkflow;
  grant: WorkflowGrant;
  lineage: WorkflowCandidateLineage;
  issue: Pick<WorkIssue, "id" | "project_id" | "status" | "scope_revision" | "authorized_scope" | "assigned_role_id">;
  candidate: WorkflowCandidateBinding | null;
  testing_evidence: TestingEvidence | null;
  // The grant hashes all roles' testing policies; a captured writer receipt
  // hashes only its runnable verification requirements. They are not equal.
  current_testing_policy_fingerprint: string;
  review_output: WorkflowRoleOutput;
  review_receipt: ReviewReceipt;
  policy: WorkflowPolicy;
  correction_counters: WorkflowCounters;
  original_engineer_id: string;
  selected_engineer_id: string;
  // These facts must be computed from current application ownership/policy,
  // sealed review evidence and the actual tree; no public request may supply
  // them. This pure predicate performs no Git/lease/grant effects itself.
  grant_current: boolean;
  candidate_current: boolean;
  review_current: boolean;
  implementation_lease_active: boolean;
  trusted_source_paths: string[];
  verification_probe_paths: string[];
  proposed_paths: string[];
}
export function evaluateCorrectionEligibility(input: CorrectionEligibilityInput): { eligible: boolean; reasons: string[]; remaining_budget: WorkflowBudget | null } {
  assertWorkflowRecord(input.workflow); assertWorkflowGrant(input.grant); assertWorkflowCandidateLineage(input.lineage);
  assertWorkflowRoleOutput(input.review_output); assertReviewReceipt(input.review_receipt); assertPolicy(input.policy);
  const { workflow, grant, issue, lineage, candidate, review_output: output, review_receipt: review } = input;
  const reasons: string[] = [];
  if (!["implementation", "trivial-change"].includes(workflow.template_id) || workflow.template_id !== grant.template_id) reasons.push("Template cannot automate correction");
  if (workflow.status !== "running" || workflow.stop_requested_at !== null || issue.status !== "checking") reasons.push("Correction requires an active workflow and checking issue");
  if (input.grant_current !== true || workflow.current_grant_id !== grant.id || workflow.id !== grant.workflow_id || workflow.authority_revision !== grant.authority_revision
    || workflow.issue_id !== issue.id || grant.issue_id !== issue.id || workflow.project_id !== issue.project_id || grant.project_id !== issue.project_id
    || workflow.scope_revision !== issue.scope_revision || grant.scope_revision !== issue.scope_revision || JSON.stringify(grant.authorized_scope) !== JSON.stringify(issue.authorized_scope)
    || JSON.stringify(workflow.budget) !== JSON.stringify(grant.budget)) reasons.push("Correction grant, authority or exact scope is stale");
  if (!grant.correction.enabled || grant.correction.max_corrections !== 1 || !grant.permitted_stage_kinds.includes("correction") || !grant.correction.budget) reasons.push("Correction was not explicitly opted in");
  if (!workflow.review_policy || workflow.review_policy.effective_depth !== "full" && (grant.minimum_review_depth === "full" || input.policy.minimum_review_depth === "full")) reasons.push("Correction cannot lower the current grant or workflow review floor");
  const requiredReviews = workflow.review_policy?.qa_required ? ["reviewer", "qa-evaluator"] as const : ["reviewer"] as const;
  if (!grant.permitted_stage_kinds.includes("review") || workflow.review_policy?.qa_required && !grant.permitted_stage_kinds.includes("qa")
    || requiredReviews.some((id) => !grant.role_assignments.some((role) => role.role_id === id))) reasons.push("Correction has no granted path through all required fresh reviews");
  if (workflow.lineage_id !== lineage.id || lineage.project_id !== issue.project_id || lineage.issue_id !== issue.id || lineage.scope_revision !== issue.scope_revision
    || !lineage.workflow_ids.includes(workflow.id) || lineage.correction_limit !== 1 || lineage.corrections_consumed !== 0) reasons.push("Candidate lineage correction allowance is unavailable or consumed");
  const engineer = grant.role_assignments.find((role) => role.role_id === "software-engineer");
  if (!input.original_engineer_id || input.selected_engineer_id !== input.original_engineer_id || engineer?.agent_id !== input.original_engineer_id || issue.assigned_role_id !== input.original_engineer_id) reasons.push("Correction cannot substitute the original authorized engineer");
  if (input.candidate_current !== true || !candidate || JSON.stringify(candidate) !== JSON.stringify(workflow.candidate)
    || candidate.issue_id !== issue.id || candidate.repository_id !== issue.project_id || candidate.scope_revision !== issue.scope_revision
    || candidate.task_id !== lineage.origin_task_id || !lineage.candidate_ids.includes(candidate.candidate_id)) reasons.push("Correction candidate or lineage binding is missing or stale");
  if (input.implementation_lease_active !== false) reasons.push("Correction cannot start with an active or unknown implementation lease");
  let passed = false;
  try {
    const receipt = input.testing_evidence;
    passed = !!receipt && !!candidate && testingEvidenceStatus(receipt) === "passed" && receipt.fingerprint === candidate.testing_evidence_fingerprint
      && input.current_testing_policy_fingerprint === grant.testing_policy_fingerprint && receipt.mode === grant.testing_mode && receipt.task_id === candidate.task_id && receipt.execution_id === candidate.execution_id
      && receipt.project_id === issue.project_id && receipt.issue_id === issue.id && receipt.scope_revision === issue.scope_revision
      && receipt.scope_fingerprint === evidenceHash(JSON.stringify(issue.authorized_scope)) && receipt.candidate?.id === candidate.candidate_id
      && receipt.candidate.base_revision === candidate.base_revision && receipt.candidate.candidate_revision === candidate.candidate_revision && receipt.candidate.diff_fingerprint === candidate.diff_fingerprint;
  } catch { /* Malformed/forged captured evidence is not a passed check. */ }
  if (!passed) reasons.push("Correction requires current passed infrastructure verification, never model claims");
  if (input.review_current !== true || review.workflow_id !== workflow.id || review.grant_id !== grant.id || review.authority_revision !== grant.authority_revision
    || review.issue_id !== issue.id || review.scope_revision !== issue.scope_revision || JSON.stringify(review.candidate) !== JSON.stringify(candidate)
    || !workflow.review_policy || review.review_policy_fingerprint !== workflow.review_policy.fingerprint
    || review.output_fingerprint !== evidenceHash(JSON.stringify(output))) reasons.push("Correction review evidence is stale or unbound");
  if (workflow.review_policy) assertResolvedWorkflowReviewPolicy(workflow.review_policy);
  const reviewOutput = output.kind === "review" || output.kind === "qa";
  if (!reviewOutput || review.role_id !== (output.kind === "qa" ? "qa-evaluator" : "reviewer")
    || grant.role_assignments.find((role) => role.role_id === review.role_id)?.agent_id !== review.agent_id) reasons.push("Correction review role or registered adapter differs");
  if (!reviewOutput || output.status !== "completed" || output.verdict !== "correction-required" || review.verdict !== "correction-required"
    || JSON.stringify(review.findings) !== JSON.stringify(reviewOutput ? output.findings : []) || output.requested_decision !== null || output.unresolved_questions.length !== 0
    || !(reviewOutput && output.findings.some((finding) => finding.severity === "blocking" && finding.path !== null && finding.evidence_ids.length > 0))
    || reviewOutput && output.findings.some((finding) => finding.scope_change_required || finding.severity === "blocking" && (finding.path === null || finding.evidence_ids.length === 0))) reasons.push("Correction needs concrete bounded findings with no unresolved human decision");
  const findingPaths = reviewOutput ? output.findings.flatMap((finding) => finding.path ? [finding.path] : []) : [];
  reasons.push(...correctionPathReasons({ paths: [...new Set([...input.proposed_paths, ...findingPaths, ...(candidate?.changed_paths ?? [])])], scope: issue.authorized_scope, policy: input.policy,
    trusted_source_paths: input.trusted_source_paths, verification_probe_paths: input.verification_probe_paths }));
  const root = remainingWorkflowBudget(workflow.budget, workflow.counters);
  const correction = grant.correction.budget ? remainingWorkflowBudget(grant.correction.budget, input.correction_counters) : null;
  reasons.push(...root.reasons, ...(correction?.reasons ?? []));
  const remaining = root.remaining && correction?.remaining ? Object.fromEntries(budgetKeys.map((key) => [key, Math.min(root.remaining![key], correction.remaining![key], input.policy.correction_budget[key])])) as unknown as WorkflowBudget : null;
  // Reserve enough root/correction tasks and attempts for the correction and
  // all required fresh reviews, rather than knowingly admitting a dead end.
  const requiredTasks = workflow.review_policy?.qa_required ? 3 : 2;
  if (!remaining || remaining.max_tasks < requiredTasks || remaining.max_attempts < requiredTasks || remaining.max_runtime_ms < 1 || remaining.max_total_tokens < 1) reasons.push("Correction and fresh required reviews do not fit remaining root/sub-budget");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], remaining_budget: remaining };
}
