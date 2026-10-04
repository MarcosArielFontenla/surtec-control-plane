import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import recordSchema from "../../schemas/workflow-record.schema.json";
import grantSchema from "../../schemas/workflow-grant.schema.json";
import handoffSchema from "../../schemas/role-handoff.schema.json";
import receiptSchema from "../../schemas/review-receipt.schema.json";
import outputSchema from "../../schemas/workflow-role-output.schema.json";
import policySchema from "../../schemas/workflow-policy.schema.json";
import documentSchema from "../../schemas/workflow-document.schema.json";
import issueSchema from "../../schemas/work-issue.schema.json";
import {
  WORKFLOW_LIMITS, type GovernedWorkflow, type RoleHandoff, type ReviewReceipt,
  type WorkflowAdmissionIntent, type WorkflowCandidateBinding, type WorkflowCandidateLineage,
  type WorkflowDecision, type WorkflowDocument, type WorkflowFinding, type WorkflowGrant,
  type WorkflowPolicy, type WorkflowRoleOutput, type WorkflowRunAccounting, type WorkflowStage,
} from "./types";

// Validation is pure: it checks data, not actual human approval, current policy,
// cross-store evidence, lease ownership or authority to execute a task.
export class WorkflowContractError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowContractError"; }
}
function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new WorkflowContractError(message);
}
function timestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! && hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value));
}
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addFormat("date-time", { type: "string", validate: timestamp });
for (const schema of [issueSchema, recordSchema, grantSchema, handoffSchema, receiptSchema, outputSchema, policySchema, documentSchema]) ajv.addSchema(schema);
const check = (id: string) => ajv.getSchema(`https://surtec.dev/schemas/${id}.schema.json`)!;
const validators = {
  record: check("workflow-record"), grant: check("workflow-grant"), handoff: check("role-handoff"),
  receipt: check("review-receipt"), output: check("workflow-role-output"), policy: check("workflow-policy"), document: check("workflow-document"),
  stage: ajv.compile({ $ref: `${recordSchema.$id}#/$defs/stage` }),
  decision: ajv.compile({ $ref: `${recordSchema.$id}#/$defs/decision` }),
  intent: ajv.compile({ $ref: `${recordSchema.$id}#/$defs/intent` }),
  accounting: ajv.compile({ $ref: `${recordSchema.$id}#/$defs/accounting` }),
  lineage: ajv.compile({ $ref: `${recordSchema.$id}#/$defs/lineage` }),
};
function shape<T>(validate: ValidateFunction, value: unknown, label: string, limit = WORKFLOW_LIMITS.documentBytes): T {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new WorkflowContractError(`Invalid ${label} serialization`); }
  invariant(encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= limit, `${label} exceeds serialized byte limit`);
  invariant(validate(value), `Invalid or unsupported ${label}`);
  return value as T;
}
function unique(values: string[], label: string): void { invariant(new Set(values).size === values.length, `${label} contains duplicate identities`); }
function ordered(created: string, updated: string): void { invariant(Date.parse(created) <= Date.parse(updated), "Reversed workflow timestamps"); }
function relative(path: string): boolean {
  return !!path && !/[\\:\x00-\x1f\x7f]/.test(path) && !path.startsWith("/") && path.split("/").every((part) => !!part && part !== "." && part !== "..");
}
function candidateBinding(candidate: WorkflowCandidateBinding, issueId: string, scopeRevision: number, projectId?: string): void {
  invariant(candidate.issue_id === issueId && candidate.scope_revision === scopeRevision && (!projectId || candidate.repository_id === projectId), "Candidate identity or scope binding differs");
  invariant(candidate.changed_paths.every(relative), "Unsafe candidate path");
}
function findingsValid(findings: WorkflowFinding[], verdict: string): void {
  unique(findings.map((finding) => finding.id), "findings");
  invariant(findings.every((finding) => finding.path === null || relative(finding.path)), "Unsafe review finding path");
  if (verdict === "approve") invariant(findings.every((finding) => finding.severity !== "blocking" && !finding.scope_change_required), "Approved review contradicts blocking or material-scope findings");
  if (verdict === "correction-required") invariant(findings.some((finding) => finding.severity === "blocking" && finding.evidence_ids.length > 0), "Correction requires a concrete evidence-linked blocking finding");
}
export function assertWorkflowRoleOutput(value: unknown): asserts value is WorkflowRoleOutput {
  const output = shape<WorkflowRoleOutput>(validators.output, value, "workflow role output", WORKFLOW_LIMITS.outputBytes);
  if (output.kind === "operations" && output.proposed_issue) invariant(output.proposed_issue.allowed_path_patterns.every(relative), "Unsafe proposed issue path pattern");
  if (output.kind === "review" || output.kind === "qa") {
    findingsValid(output.findings, output.verdict);
    invariant(output.verdict !== "approve" || output.status === "completed", "Uncompleted role cannot approve a review");
    if (output.kind === "qa") {
      unique(output.criteria.map((criterion) => criterion.criterion), "QA criteria");
      invariant(output.criteria.every((criterion) => criterion.status !== "supported" || criterion.evidence_ids.length > 0), "Supported QA criterion requires evidence references");
      invariant(output.verdict !== "approve" || output.criteria.every((criterion) => criterion.status === "supported"), "Approved QA contradicts missing or conflicting criteria");
    }
  }
}
export function assertRoleHandoff(value: unknown): asserts value is RoleHandoff { shape<RoleHandoff>(validators.handoff, value, "role handoff", WORKFLOW_LIMITS.outputBytes); }
export function assertReviewReceipt(value: unknown): asserts value is ReviewReceipt {
  const receipt = shape<ReviewReceipt>(validators.receipt, value, "review receipt");
  candidateBinding(receipt.candidate, receipt.issue_id, receipt.scope_revision);
  invariant(receipt.task_id !== receipt.candidate.task_id, "Review must use a separate task from implementation");
  findingsValid(receipt.findings, receipt.verdict);
}
export function assertWorkflowGrant(value: unknown): asserts value is WorkflowGrant {
  const grant = shape<WorkflowGrant>(validators.grant, value, "workflow grant");
  unique(grant.role_assignments.map((assignment) => assignment.role_id), "grant roles");
  unique(grant.source_fingerprints.map((source) => source.id), "grant sources");
  invariant(grant.source_fingerprints.every((source) => relative(source.id)), "Unsafe source identity");
  invariant([...grant.authorized_scope.allowed_path_patterns, ...grant.authorized_scope.excluded_path_patterns].every(relative), "Unsafe authorized path pattern");
  invariant(grant.role_assignments.every((assignment) => assignment.sandbox === (assignment.role_id === "software-engineer" ? "workspace-write" : "read-only")), "Role exceeds its workflow sandbox boundary");
  const writes = ["implementation", "trivial-change"].includes(grant.template_id);
  const permitsCorrection = grant.permitted_stage_kinds.includes("correction");
  invariant(writes || grant.role_assignments.every((assignment) => assignment.sandbox === "read-only"), "Read-only template cannot grant a writer");
  invariant(writes || grant.permitted_stage_kinds.every((kind) => kind !== "implementation" && kind !== "correction"), "Read-only template cannot permit write stages");
  invariant(grant.correction.enabled === (grant.correction.max_corrections === 1 && grant.correction.budget !== null), "Contradictory correction allowance");
  invariant(grant.correction.enabled || (grant.correction.max_corrections === 0 && grant.correction.budget === null), "Disabled correction cannot carry authority");
  invariant(grant.correction.enabled || !permitsCorrection, "Disabled correction cannot permit a correction stage");
  if (grant.correction.enabled) {
    invariant(writes, "Read-only workflow cannot automate correction");
    for (const key of ["max_tasks", "max_attempts", "max_runtime_ms", "max_total_tokens"] as const) invariant(grant.correction.budget![key] <= grant.budget[key], "Correction exceeds root budget");
  }
}
export function assertWorkflowRecord(value: unknown): asserts value is GovernedWorkflow {
  const workflow = shape<GovernedWorkflow>(validators.record, value, "workflow record");
  ordered(workflow.created_at, workflow.updated_at);
  if (workflow.candidate) candidateBinding(workflow.candidate, workflow.issue_id, workflow.scope_revision, workflow.project_id);
  if (workflow.review_policy) {
    const policy = workflow.review_policy;
    invariant(policy.effective_depth === "full" || (policy.intrinsic_depth !== "full" && policy.minimum_depth !== "full"), "Review depth silently downgraded");
    invariant(policy.effective_depth !== "full" || policy.qa_required, "Full review requires QA");
  }
  invariant(workflow.counters.tasks <= workflow.budget.max_tasks && workflow.counters.attempts <= workflow.budget.max_attempts, "Workflow admitted beyond task or attempt caps");
  const terminal = ["completed", "cancelled"].includes(workflow.status);
  invariant(terminal === (workflow.completed_at !== null), "Terminal workflow timestamp differs");
  if (workflow.completed_at) { ordered(workflow.created_at, workflow.completed_at); ordered(workflow.completed_at, workflow.updated_at); }
  if (workflow.stop_requested_at) { ordered(workflow.created_at, workflow.stop_requested_at); ordered(workflow.stop_requested_at, workflow.updated_at); }
  invariant(workflow.status !== "waiting-human" || workflow.pending_decision_id !== null, "Human gate requires a pending decision");
  invariant(workflow.status !== "needs-decision" || workflow.blocked_reason !== null, "Blocked workflow requires an explicit reason");
  const exhausted = !workflow.counters.accounting_complete || workflow.counters.runtime_ms > workflow.budget.max_runtime_ms || workflow.counters.total_tokens > workflow.budget.max_total_tokens;
  invariant(!exhausted || workflow.status === "needs-decision" || workflow.status === "cancelled" || workflow.stop_requested_at !== null, "Unknown or exhausted accounting requires a visible stop");
  invariant(workflow.status !== "completed" || (!exhausted && workflow.stop_requested_at === null), "Stopped or uncertain workflow cannot claim completion");
  invariant(workflow.status !== "cancelled" || workflow.stop_requested_at !== null, "Cancelled workflow requires durable stop intent");
}
export function assertWorkflowStage(value: unknown): asserts value is WorkflowStage {
  const stage = shape<WorkflowStage>(validators.stage, value, "workflow stage");
  ordered(stage.created_at, stage.updated_at);
  const writer = stage.kind === "implementation" || stage.kind === "correction";
  const roles: Record<WorkflowStage["kind"], string[]> = { analysis: ["portfolio-analyst", "planner"], planning: ["planner"], implementation: ["software-engineer"], correction: ["software-engineer"], review: ["reviewer"], qa: ["qa-evaluator"], operations: ["operations-observer"] };
  invariant(roles[stage.kind].includes(stage.role_id) && stage.sandbox === (writer ? "workspace-write" : "read-only"), "Stage role or sandbox binding differs");
  invariant(stage.phase !== "verification" || writer, "Read-only stage cannot run verification");
  if (["reserved", "queued", "running", "completed"].includes(stage.status)) invariant(stage.task_id !== null && stage.context_fingerprint !== null, "Admitted stage requires task and context bindings");
  if (["reserved", "queued", "running", "completed"].includes(stage.status) && ["review", "qa"].includes(stage.kind)) invariant(stage.candidate !== null, "Admitted review requires a candidate binding");
  if (stage.candidate) invariant(stage.candidate.changed_paths.every(relative), "Unsafe stage candidate path");
  if (["running", "completed"].includes(stage.status)) invariant(stage.execution_id !== null, "Executed stage requires run identity");
  invariant(stage.status !== "completed" || (stage.output_fingerprint !== null && (writer || stage.output?.status === "completed")), "Completed stage requires validated output evidence");
  invariant(stage.predecessor_stage_id !== stage.id && stage.supersedes_stage_id !== stage.id, "Stage cannot reference itself");
  if (stage.output) {
    assertWorkflowRoleOutput(stage.output);
    const expected = { analysis: "analysis", planning: "plan", review: "review", qa: "qa", operations: "operations" };
    invariant(stage.kind in expected && stage.output.kind === expected[stage.kind as keyof typeof expected] && stage.output_fingerprint !== null, "Stage role output binding differs");
  }
}
export function assertWorkflowDecision(value: unknown): asserts value is WorkflowDecision {
  const decision = shape<WorkflowDecision>(validators.decision, value, "workflow decision");
  const pending = decision.status === "pending";
  invariant(pending ? decision.approval_id === null && decision.decided_by === null && decision.rationale === null && decision.decided_at === null
    : decision.approval_id !== null && decision.decided_by === "human" && decision.rationale !== null && decision.decided_at !== null, "Decision is missing or fabricating human acknowledgement");
  if (decision.decided_at) ordered(decision.created_at, decision.decided_at);
}
export function assertWorkflowAdmissionIntent(value: unknown): asserts value is WorkflowAdmissionIntent {
  const intent = shape<WorkflowAdmissionIntent>(validators.intent, value, "workflow admission intent");
  ordered(intent.created_at, intent.updated_at);
  invariant(intent.status !== "blocked" || intent.blocked_reason !== null, "Blocked admission requires a reason");
}
export function assertWorkflowRunAccounting(value: unknown): asserts value is WorkflowRunAccounting { shape<WorkflowRunAccounting>(validators.accounting, value, "workflow run accounting"); }
export function assertWorkflowCandidateLineage(value: unknown): asserts value is WorkflowCandidateLineage {
  const lineage = shape<WorkflowCandidateLineage>(validators.lineage, value, "workflow candidate lineage");
  invariant(lineage.corrections_consumed <= lineage.correction_limit, "Correction exceeds lineage allowance");
  invariant(lineage.corrections_consumed === 1 ? lineage.consumed_stage_id !== null && lineage.consumed_at !== null
    : lineage.consumed_stage_id === null && lineage.consumed_at === null, "Correction consumption binding differs");
}
export function assertWorkflowPolicy(value: unknown): asserts value is WorkflowPolicy {
  const policy = shape<WorkflowPolicy>(validators.policy, value, "workflow policy");
  invariant(policy.protected_path_patterns.every(relative), "Unsafe protected path pattern");
  for (const key of ["max_tasks", "max_attempts", "max_runtime_ms", "max_total_tokens"] as const) invariant(policy.correction_budget[key] <= policy.default_budget[key], "Correction exceeds default root budget");
}
export function assertWorkflowDocument(value: unknown): asserts value is WorkflowDocument {
  const document = shape<WorkflowDocument>(validators.document, value, "workflow document");
  const maps = [document.workflows, document.stages, document.grants, document.decisions, document.handoffs, document.review_receipts, document.admission_intents, document.accounting, document.lineages];
  for (const records of maps) for (const [key, record] of Object.entries(records)) invariant(key === record.id, "Workflow map key differs from record identity");
  for (const workflow of Object.values(document.workflows)) assertWorkflowRecord(workflow);
  for (const grant of Object.values(document.grants)) assertWorkflowGrant(grant);
  for (const stage of Object.values(document.stages)) assertWorkflowStage(stage);
  for (const decision of Object.values(document.decisions)) assertWorkflowDecision(decision);
  for (const handoff of Object.values(document.handoffs)) assertRoleHandoff(handoff);
  for (const receipt of Object.values(document.review_receipts)) assertReviewReceipt(receipt);
  for (const intent of Object.values(document.admission_intents)) assertWorkflowAdmissionIntent(intent);
  for (const accounting of Object.values(document.accounting)) assertWorkflowRunAccounting(accounting);
  for (const lineage of Object.values(document.lineages)) assertWorkflowCandidateLineage(lineage);
  unique(document.events.map((event) => event.id), "workflow events");
  const activeIssues = Object.values(document.workflows).filter((workflow) => !["completed", "cancelled"].includes(workflow.status)).map((workflow) => workflow.issue_id);
  unique(activeIssues, "active issue owners");
  relationships(document);
}

const terminalWorkflow = (value: GovernedWorkflow) => ["completed", "cancelled"].includes(value.status);
const terminalStage = (value: WorkflowStage) => ["completed", "needs-review", "failed", "cancelled"].includes(value.status);
const same = isDeepStrictEqual;
function own<T>(records: Record<string, T>, id: string, label: string): T {
  invariant(Object.hasOwn(records, id), `Missing ${label} reference`);
  return records[id]!;
}
function relationships(d: WorkflowDocument): void {
  const taskIds: string[] = [], runIds: string[] = [], intentStages: string[] = [], receiptRuns: string[] = [], handoffIds: string[] = [];
  const stagesByOwner = new Map<string, WorkflowStage[]>(), accountsByOwner = new Map<string, WorkflowRunAccounting[]>(), accountsByRun = new Map<string, WorkflowRunAccounting>();
  for (const s of Object.values(d.stages)) { const entries = stagesByOwner.get(s.workflow_id) ?? []; entries.push(s); stagesByOwner.set(s.workflow_id, entries); }
  for (const a of Object.values(d.accounting)) { const entries = accountsByOwner.get(a.workflow_id) ?? []; entries.push(a); accountsByOwner.set(a.workflow_id, entries); accountsByRun.set(a.execution_id, a); }
  const candidates = new Map<string, WorkflowCandidateBinding>();
  const indexCandidate = (candidate: WorkflowCandidateBinding, workflow: GovernedWorkflow, scope: number) => {
    candidateBinding(candidate, workflow.issue_id, scope, workflow.project_id);
    const previous = candidates.get(candidate.candidate_id);
    invariant(!previous || same(previous, candidate), "Candidate identity has conflicting sealed bindings");
    candidates.set(candidate.candidate_id, candidate);
  };
  const authorities: string[] = [];
  for (const grant of Object.values(d.grants)) {
    const w = own(d.workflows, grant.workflow_id, "grant owner");
    invariant(grant.project_id === w.project_id && grant.issue_id === w.issue_id && grant.template_id === w.template_id && grant.template_version === w.template_version && grant.authority_revision <= w.authority_revision, "Grant ownership or authority binding differs");
    authorities.push(`${w.id}:${grant.authority_revision}`);
  }
  unique(authorities, "workflow grant authority revisions");
  for (const w of Object.values(d.workflows)) {
    const grant = own(d.grants, w.current_grant_id, "current grant");
    invariant(grant.workflow_id === w.id && grant.authority_revision === w.authority_revision && grant.scope_revision === w.scope_revision && same(grant.budget, w.budget), "Current grant binding differs");
    if (w.candidate) indexCandidate(w.candidate, w, w.scope_revision);
    const slots = w.stage_ids.map((id) => own(d.stages, id, "workflow stage"));
    invariant(slots.every((s) => s.workflow_id === w.id), "Workflow stage ownership differs");
    unique(slots.map((s) => String(s.ordinal)), "workflow stage slots");
    invariant(slots.every((s, i) => i === 0 || slots[i - 1]!.ordinal < s.ordinal), "Workflow stage slots are unordered");
    invariant(w.current_stage_id === null || w.stage_ids.includes(w.current_stage_id), "Current stage is not indexed");
    if (w.pending_decision_id) {
      const decision = own(d.decisions, w.pending_decision_id, "pending decision");
      invariant(decision.workflow_id === w.id && decision.status === "pending", "Pending decision ownership or status differs");
    }
    if (w.lineage_id) {
      const lineage = own(d.lineages, w.lineage_id, "workflow lineage");
      invariant(lineage.workflow_ids.includes(w.id) && lineage.issue_id === w.issue_id && lineage.project_id === w.project_id && lineage.scope_revision === w.scope_revision, "Workflow lineage ownership differs");
      invariant(!w.candidate || lineage.candidate_ids.includes(w.candidate.candidate_id), "Candidate is missing from lineage");
    }
    if (w.approved_plan) {
      const s = own(d.stages, w.approved_plan.stage_id, "approved plan stage");
      const decision = own(d.decisions, w.approved_plan.decision_id, "approved plan decision");
      invariant(s.workflow_id === w.id && s.kind === "planning" && s.status === "completed" && s.output_fingerprint === w.approved_plan.output_fingerprint && s.output?.kind === "plan" && !s.output.scope_change_required
        && decision.workflow_id === w.id && decision.kind === "plan-approval" && decision.status === "approved" && decision.resource_fingerprint === s.output_fingerprint, "Approved plan binding differs");
    }
    // stage_ids indexes the current <=7 slots. Superseded generations remain
    // in the aggregate and must be reachable, not deleted to reset counters.
    const indexed = new Set<string>();
    for (const slot of slots) {
      let s: WorkflowStage | undefined = slot;
      while (s) {
        invariant(!indexed.has(s.id), "Stage supersession cycle or shared generation");
        indexed.add(s.id);
        s = s.supersedes_stage_id ? own(d.stages, s.supersedes_stage_id, "superseded stage") : undefined;
      }
    }
    const stages = stagesByOwner.get(w.id) ?? [];
    invariant(stages.every((s) => indexed.has(s.id)), "Orphan workflow stage generation");
    const chargedTasks = stages.filter((s) => s.task_id !== null).length;
    const accounts = accountsByOwner.get(w.id) ?? [];
    invariant(w.counters.tasks >= chargedTasks && w.counters.attempts >= accounts.length && w.counters.runtime_ms >= accounts.reduce((n, a) => n + a.active_runtime_ms, 0) && w.counters.total_tokens >= accounts.reduce((n, a) => n + a.observed_tokens, 0), "Workflow counters underreport durable charges");
    // A currently running record may still be receiving usage. Interrupted or
    // finished incomplete runs cannot be represented as complete/zero usage.
    invariant(!accounts.some((a) => !a.usage_complete && !(d.stages[a.stage_id]?.status === "running" && d.stages[a.stage_id]?.execution_id === a.execution_id)) || !w.counters.accounting_complete, "Unknown run usage is not complete accounting");
    invariant(w.status !== "completed" || (w.pending_decision_id === null && w.current_stage_id === null && slots.every((s) => s.status === "completed")), "Completed workflow retains an unfinished stage or decision");
  }
  for (const s of Object.values(d.stages)) {
    const w = own(d.workflows, s.workflow_id, "stage owner"), grant = own(d.grants, s.grant_id, "stage grant");
    const assignment = grant.role_assignments.find((a) => a.role_id === s.role_id);
    invariant(grant.workflow_id === w.id && grant.authority_revision === s.authority_revision && grant.permitted_stage_kinds.includes(s.kind) && assignment?.agent_id === s.agent_id && assignment.sandbox === s.sandbox, "Stage grant or role binding differs");
    if (s.task_id) taskIds.push(s.task_id);
    if (s.candidate) indexCandidate(s.candidate, w, grant.scope_revision);
    if (s.predecessor_stage_id) {
      const predecessor = own(d.stages, s.predecessor_stage_id, "predecessor stage");
      invariant(predecessor.workflow_id === w.id && predecessor.ordinal < s.ordinal, "Predecessor ownership or order differs");
    }
    if (s.supersedes_stage_id) {
      const previous = own(d.stages, s.supersedes_stage_id, "superseded stage");
      invariant(previous.workflow_id === w.id && previous.ordinal === s.ordinal && previous.kind === s.kind && previous.role_id === s.role_id && previous.generation + 1 === s.generation && terminalStage(previous), "Stage supersession binding differs");
    } else invariant(s.generation === 1, "Stage generation has no predecessor");
    if (s.handoff_id) {
      handoffIds.push(s.handoff_id);
      const h = own(d.handoffs, s.handoff_id, "stage handoff");
      const predecessor = s.predecessor_stage_id ? own(d.stages, s.predecessor_stage_id, "handoff producer") : null;
      invariant(h.issue_id === w.issue_id && h.to_role_id === s.role_id && predecessor?.role_id === h.from_role_id && predecessor.execution_id === h.execution_id && terminalStage(predecessor) && predecessor.output_fingerprint !== null, "Handoff producer or recipient binding differs");
    }
    if (s.kind === "correction" && s.task_id) {
      const l = w.lineage_id ? own(d.lineages, w.lineage_id, "correction lineage") : null;
      invariant(grant.correction.enabled && l?.corrections_consumed === 1 && l.consumed_stage_id === s.id, "Correction task has no durable lineage consumption");
    }
  }
  unique(taskIds, "workflow task owners"); unique(handoffIds, "handoff owners");
  const ownedHandoffs = new Set(handoffIds);
  invariant(Object.keys(d.handoffs).every((id) => ownedHandoffs.has(id)), "Orphan handoff");
  for (const receipt of Object.values(d.review_receipts)) {
    const s = own(d.stages, receipt.stage_id, "review stage"), w = own(d.workflows, receipt.workflow_id, "review owner");
    invariant(s.workflow_id === w.id && terminalStage(s) && s.task_id === receipt.task_id && s.execution_id === receipt.execution_id && s.role_id === receipt.role_id && s.agent_id === receipt.agent_id && s.grant_id === receipt.grant_id && s.authority_revision === receipt.authority_revision && s.context_fingerprint === receipt.context_fingerprint && s.output_fingerprint === receipt.output_fingerprint && same(s.candidate, receipt.candidate), "Review receipt stage binding differs");
    invariant((s.output?.kind === "review" || s.output?.kind === "qa") && s.output.verdict === receipt.verdict && same(s.output.findings, receipt.findings), "Review receipt output binding differs");
    indexCandidate(receipt.candidate, w, receipt.scope_revision);
    receiptRuns.push(receipt.execution_id);
  }
  unique(receiptRuns, "sealed review runs");
  for (const decision of Object.values(d.decisions)) {
    const w = own(d.workflows, decision.workflow_id, "decision owner");
    invariant(decision.expected_workflow_revision <= w.revision, "Decision references a future workflow revision");
    if (decision.candidate_id) {
      const candidate = candidates.get(decision.candidate_id);
      invariant(!!candidate && candidate.issue_id === w.issue_id && candidate.repository_id === w.project_id, "Decision candidate ownership differs");
    }
    for (const id of decision.review_receipt_ids) {
      const r = own(d.review_receipts, id, "decision receipt");
      invariant(r.workflow_id === w.id && r.candidate.candidate_id === decision.candidate_id, "Decision receipt ownership differs");
    }
  }
  for (const intent of Object.values(d.admission_intents)) {
    const s = own(d.stages, intent.stage_id, "admission stage"), w = own(d.workflows, intent.workflow_id, "admission owner");
    invariant(s.workflow_id === w.id && s.task_id === intent.task_id && s.grant_id === intent.grant_id && s.authority_revision === intent.authority_revision && s.context_fingerprint === intent.context_fingerprint && intent.expected_workflow_revision <= w.revision, "Admission intent stage binding differs");
    invariant(intent.status !== "committed" || s.status !== "pending" && s.status !== "reserved", "Committed intent has no admitted stage");
    intentStages.push(intent.stage_id);
  }
  unique(intentStages, "admission stage reservations");
  const attempts: string[] = [];
  for (const a of Object.values(d.accounting)) {
    const s = own(d.stages, a.stage_id, "accounting stage");
    invariant(s.workflow_id === a.workflow_id && s.task_id === a.task_id, "Accounting owner or task binding differs");
    attempts.push(`${a.task_id}:${a.attempt}`); runIds.push(a.execution_id);
  }
  unique(attempts, "charged task attempts"); unique(runIds, "charged runs");
  for (const s of Object.values(d.stages)) if (s.execution_id) {
    const a = accountsByRun.get(s.execution_id);
    invariant(a?.stage_id === s.id, "Stage run has no owned accounting record");
  }
  const lineageOrigins: string[] = [], candidateLineages = new Map<string, string>();
  for (const l of Object.values(d.lineages)) {
    lineageOrigins.push(`${l.project_id}:${l.issue_id}:${l.scope_revision}:${l.origin_task_id}`);
    for (const id of l.workflow_ids) {
      const w = own(d.workflows, id, "lineage workflow");
      invariant(w.lineage_id === l.id && w.issue_id === l.issue_id && w.project_id === l.project_id && w.scope_revision === l.scope_revision, "Lineage workflow ownership differs");
    }
    for (const id of l.candidate_ids) {
      const c = candidates.get(id);
      invariant(!!c && c.issue_id === l.issue_id && c.repository_id === l.project_id && c.scope_revision === l.scope_revision, "Lineage candidate ownership differs");
      invariant(!candidateLineages.has(id), "Candidate cannot reset allowance in another lineage"); candidateLineages.set(id, l.id);
    }
    invariant(l.candidate_ids.length === 0 || candidates.get(l.candidate_ids[0]!)?.task_id === l.origin_task_id, "Lineage origin task binding differs");
    if (l.consumed_stage_id) {
      const s = own(d.stages, l.consumed_stage_id, "consumed correction stage");
      invariant(l.workflow_ids.includes(s.workflow_id) && s.kind === "correction" && own(d.grants, s.grant_id, "correction grant").correction.enabled, "Consumed correction stage binding differs");
    }
  }
  unique(lineageOrigins, "candidate lineage origins");
  for (const w of Object.values(d.workflows)) if (w.candidate && candidateLineages.has(w.candidate.candidate_id)) invariant(w.lineage_id === candidateLineages.get(w.candidate.candidate_id), "Workflow cannot detach from existing candidate lineage");
  const revisions = new Map<string, number>(), eventTimes = new Map<string, number>();
  for (const event of d.events) {
    const w = own(d.workflows, event.workflow_id, "event owner");
    invariant(event.revision <= w.revision && event.revision >= (revisions.get(w.id) ?? 1), "Event workflow revision order differs");
    revisions.set(w.id, event.revision);
    const time = Date.parse(event.at);
    invariant(time >= (eventTimes.get(w.id) ?? Date.parse(w.created_at)) && time <= Date.parse(w.updated_at), "Event workflow timestamp order differs"); eventTimes.set(w.id, time);
    if (event.stage_id) invariant(own(d.stages, event.stage_id, "event stage").workflow_id === w.id, "Event stage ownership differs");
    if (event.execution_id) { const a = accountsByRun.get(event.execution_id); invariant(a?.workflow_id === w.id && (!event.stage_id || a.stage_id === event.stage_id), "Event run ownership differs"); }
  }
}

function unchangedFields<T extends object>(before: T, after: T, keys: Array<keyof T>, label: string): void {
  invariant(keys.every((key) => same(before[key], after[key])), `${label} immutable binding changed`);
}
function retained<T>(before: T[], after: T[], label: string): void {
  invariant(after.length >= before.length && before.every((item, i) => same(item, after[i])), `${label} history was removed or rewritten`);
}
// A correction's admission keeps its input candidate in the immutable task
// binding. Only its exact terminal seal may replace the stage's input with
// the output candidate. This checks relationships, not actual Git/verification
// evidence or human authority; those remain service/controller prerequisites.
function correctionCandidateSeal(before: WorkflowDocument, after: WorkflowDocument, old: WorkflowStage, stage: WorkflowStage): boolean {
  const prior = old.candidate, candidate = stage.candidate;
  const owner = before.workflows[old.workflow_id]!, current = after.workflows[old.workflow_id]!;
  const grant = before.grants[old.grant_id]!;
  const lineage = owner.lineage_id ? before.lineages[owner.lineage_id] : null;
  const retainedLineage = current.lineage_id ? after.lineages[current.lineage_id] : null;
  const predecessor = old.predecessor_stage_id ? before.stages[old.predecessor_stage_id] : null;
  const charge = Object.values(before.accounting).find((entry) => entry.execution_id === old.execution_id);
  const intent = Object.values(before.admission_intents).find((entry) => entry.stage_id === old.id);
  return old.kind === "correction" && old.status === "running" && stage.status === "completed" && !!prior && !!candidate
    && owner.status === "running" && current.status === "running" && owner.current_stage_id === old.id && current.current_stage_id === old.id
    && !owner.stop_requested_at && !current.stop_requested_at && !owner.pending_decision_id && !current.pending_decision_id
    && owner.recovery_state === "none" && current.recovery_state === "none" && owner.counters.accounting_complete && same(owner.counters, current.counters)
    && owner.current_grant_id === old.grant_id && current.current_grant_id === old.grant_id && grant.correction.enabled
    && owner.authority_revision === old.authority_revision && current.authority_revision === old.authority_revision
    && owner.scope_revision === current.scope_revision && owner.lineage_id === current.lineage_id
    && !!lineage && !!retainedLineage && lineage.corrections_consumed === 1 && retainedLineage.corrections_consumed === 1
    && lineage.consumed_stage_id === old.id && retainedLineage.consumed_stage_id === old.id
    && prior.task_id === lineage.origin_task_id && same(prior, owner.candidate) && same(candidate, current.candidate)
    && !!predecessor && predecessor.status === "completed" && ["review", "qa"].includes(predecessor.kind) && same(predecessor.candidate, prior)
    && candidate.candidate_id !== prior.candidate_id && !lineage.candidate_ids.includes(candidate.candidate_id)
    && same(retainedLineage.candidate_ids, [...lineage.candidate_ids, candidate.candidate_id])
    && candidate.base_revision === prior.candidate_revision && candidate.candidate_revision !== prior.candidate_revision
    && candidate.task_id === old.task_id && candidate.execution_id === old.execution_id && candidate.task_id !== prior.task_id
    && candidate.testing_evidence_fingerprint !== prior.testing_evidence_fingerprint && candidate.diff_fingerprint !== prior.diff_fingerprint
    && old.output === null && stage.output === null && old.output_fingerprint === null
    && stage.output_fingerprint === createHash("sha256").update(JSON.stringify(candidate)).digest("hex")
    && !!charge && charge.stage_id === old.id && charge.task_id === old.task_id && charge.usage_complete
    && same(charge, after.accounting[charge.id]) && intent?.status === "committed" && intent.task_id === old.task_id;
}
// Pure mutation fence; callers still need current human authority, issue/task
// revisions, ownership, policy and evidence guards. No cross-store transaction.
export function assertWorkflowDocumentMutation(before: WorkflowDocument, after: unknown): asserts after is WorkflowDocument {
  assertWorkflowDocument(before); assertWorkflowDocument(after);
  for (const name of ["workflows", "stages", "grants", "decisions", "handoffs", "review_receipts", "admission_intents", "accounting", "lineages"] as const) {
    for (const id of Object.keys(before[name])) invariant(Object.hasOwn(after[name], id), "Workflow history cannot be deleted");
  }
  retained(before.events, after.events, "Event");
  for (const name of ["grants", "handoffs", "review_receipts"] as const) for (const [id, record] of Object.entries(before[name])) invariant(same(record, after[name][id]), "Sealed workflow record is immutable");
  const changedOwners = new Set<string>();
  for (const name of ["stages", "grants", "decisions", "review_receipts", "admission_intents", "accounting"] as const) for (const [id, record] of Object.entries(after[name])) if (!same(record, before[name][id])) changedOwners.add(record.workflow_id);
  for (const event of after.events.slice(before.events.length)) changedOwners.add(event.workflow_id);
  for (const [id, l] of Object.entries(after.lineages)) if (!same(l, before.lineages[id])) {
    // Linking a replacement must not rewrite its already terminal predecessor.
    for (const owner of l.workflow_ids) if (!before.lineages[id]?.workflow_ids.includes(owner)) changedOwners.add(owner);
    if (l.corrections_consumed !== before.lineages[id]?.corrections_consumed && l.consumed_stage_id) changedOwners.add(after.stages[l.consumed_stage_id]!.workflow_id);
  }
  for (const [id, w] of Object.entries(after.workflows)) {
    const old = before.workflows[id];
    if (!old) { invariant(w.revision === 1, "New workflow must start at revision one"); continue; }
    const changed = !same(old, w) || changedOwners.has(id);
    invariant(w.revision === old.revision + Number(changed), "Workflow mutation has a stale or skipped revision");
    invariant(!terminalWorkflow(old) || !changed, "Terminal workflow cannot be reopened or rewritten");
    unchangedFields(old, w, ["id", "project_id", "issue_id", "template_id", "template_version", "created_at", "budget", "work_scale"], "Workflow");
    invariant(Date.parse(w.updated_at) >= Date.parse(old.updated_at), "Workflow timestamp regressed");
    invariant(w.scope_revision >= old.scope_revision && w.authority_revision >= old.authority_revision, "Workflow authority regressed");
    invariant(old.current_grant_id === w.current_grant_id || w.authority_revision > old.authority_revision, "New grant requires a new authority revision");
    invariant(old.scope_revision === w.scope_revision || w.current_grant_id !== old.current_grant_id, "New scope requires a new grant");
    invariant(!old.stop_requested_at || old.stop_requested_at === w.stop_requested_at, "Durable stop cannot be cleared or rewritten");
    for (const key of ["tasks", "attempts", "runtime_ms", "total_tokens"] as const) invariant(w.counters[key] >= old.counters[key], "Workflow counters cannot regress");
  }
  for (const [id, old] of Object.entries(before.stages)) {
    const s = after.stages[id]!;
    unchangedFields(old, s, ["id", "workflow_id", "grant_id", "authority_revision", "generation", "ordinal", "kind", "role_id", "agent_id", "sandbox", "predecessor_stage_id", "supersedes_stage_id", "created_at"], "Stage");
    invariant(!terminalStage(old) || same(old, s), "Terminal stage evidence is immutable; replace its generation");
    for (const key of ["task_id", "context_fingerprint", "handoff_id", "output", "output_fingerprint", "candidate"] as const) {
      invariant(old[key] === null || same(old[key], s[key]) || key === "candidate" && correctionCandidateSeal(before, after, old, s), "Bound stage evidence cannot be rewritten");
    }
    invariant(Date.parse(s.updated_at) >= Date.parse(old.updated_at), "Stage timestamp regressed");
    const transitions: Record<WorkflowStage["status"], WorkflowStage["status"][]> = {
      pending: ["pending", "reserved", "cancelled"], reserved: ["reserved", "queued", "failed", "cancelled"], queued: ["queued", "running", "failed", "cancelled"],
      running: ["running", "queued", "completed", "needs-review", "failed", "cancelled"], completed: ["completed"], "needs-review": ["needs-review"], failed: ["failed"], cancelled: ["cancelled"],
    };
    invariant(transitions[old.status].includes(s.status), "Illegal stage transition");
    invariant(old.phase !== "verification" || s.phase === "verification", "Verification phase cannot regress");
  }
  for (const [id, old] of Object.entries(before.decisions)) {
    const decision = after.decisions[id]!;
    unchangedFields(old, decision, ["id", "workflow_id", "kind", "expected_workflow_revision", "expected_issue_revision", "resource_fingerprint", "candidate_id", "review_receipt_ids", "summary", "created_at"], "Decision");
    invariant(old.status === "pending" || same(old, decision), "Resolved decision is immutable");
  }
  for (const [id, old] of Object.entries(before.admission_intents)) {
    const intent = after.admission_intents[id]!;
    unchangedFields(old, intent, ["id", "workflow_id", "stage_id", "grant_id", "authority_revision", "task_id", "expected_issue_revision", "expected_workflow_revision", "context_fingerprint", "created_at"], "Intent");
    invariant(intent.status === old.status || old.status === "reserved", "Resolved admission cannot be reopened");
    invariant(Date.parse(intent.updated_at) >= Date.parse(old.updated_at), "Intent timestamp regressed");
  }
  for (const [id, old] of Object.entries(before.accounting)) {
    const a = after.accounting[id]!;
    unchangedFields(old, a, ["id", "workflow_id", "stage_id", "task_id", "execution_id", "attempt", "attempt_charged"], "Accounting");
    invariant(a.active_runtime_ms >= old.active_runtime_ms && a.observed_tokens >= old.observed_tokens && Date.parse(a.captured_at) >= Date.parse(old.captured_at), "Run accounting cannot regress");
    invariant(!old.usage_complete || same(old, a), "Final run accounting is immutable");
  }
  for (const [id, old] of Object.entries(before.lineages)) {
    const l = after.lineages[id]!;
    unchangedFields(old, l, ["id", "project_id", "issue_id", "scope_revision", "origin_task_id", "correction_limit"], "Lineage");
    retained(old.workflow_ids, l.workflow_ids, "Lineage workflow"); retained(old.candidate_ids, l.candidate_ids, "Lineage candidate");
    invariant(l.corrections_consumed >= old.corrections_consumed, "Correction consumption cannot reset");
    if (old.corrections_consumed) unchangedFields(old, l, ["consumed_stage_id", "consumed_at"], "Consumed correction");
  }
}
