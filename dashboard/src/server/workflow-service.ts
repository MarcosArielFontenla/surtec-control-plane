import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contextHash, redactContextText } from "../../../lib/context/assemble";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { readIssueDocument } from "../../../lib/state/issues";
import { readTask } from "../../../lib/state/store";
import { validateTaskRecord } from "../../../lib/state/validation";
import { mutateWorkflowDocument, readWorkflowDocument } from "../../../lib/state/workflows";
import type { GovernedWorkflow, WorkflowDocument, WorkflowEvent, WorkflowGrant, WorkflowStage } from "../../../lib/workflows/types";
import { assertWorkflowDocument } from "../../../lib/workflows/validation";
import { createWorkflowTask } from "./dispatch";
import { createIssueService, projectWorkflowIssueLink } from "./issue-service";
import { createWorkflowContextService, type WorkflowContextDependencies, type WorkflowContextService } from "./workflow-context-service";
import { applicableWorkflowReviews, assertOwnedWorkflowIssueProgress, assertTerminalWorkflowTask, sealWorkflowHandoff, sealWorkflowReviewReceipt, workflowReviewAllowsContinuation } from "../../../lib/workflows/review-evidence";
import { resolveWorkflowTemplate } from "../../../lib/workflows/templates";
import { evaluateCorrectionEligibility, hasConcreteCorrectionFinding, readWorkflowPolicy } from "../../../lib/workflows/policy";
import { readContextConfig } from "../../../lib/policy/roles";
import { PolicyService } from "../../../lib/policy/service";

export class WorkflowServiceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 409, readonly workflowId?: string) { super(message); }
}
export interface WorkflowServiceOptions {
  context?: WorkflowContextService;
  contextDependencies?: WorkflowContextDependencies;
  createTask?: typeof createWorkflowTask;
  issues?: Pick<ReturnType<typeof createIssueService>, "linkWorkflowTask">;
  now?: () => Date;
  execution?: { available: () => boolean; notify: (taskId: string) => void; cancelTask: (taskId: string) => void };
}
const hash = (value: unknown) => contextHash(JSON.stringify(value));
function requireCurrent(ok: unknown, message: string): asserts ok { if (!ok) throw new WorkflowServiceError(message); }
function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new WorkflowServiceError("Invalid workflow request fields", 400);
  return value as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string { if (typeof value !== "string" || !isSafeIdentifier(value)) throw new WorkflowServiceError("Invalid workflow identity", 400); }
function revision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new WorkflowServiceError("A current positive revision is required", 400); }
function fingerprint(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new WorkflowServiceError("Invalid workflow fingerprint", 400); }
function humanText(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || redactContextText(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new WorkflowServiceError("Invalid bounded human acknowledgement", 400);
}
function findWorkflow(document: WorkflowDocument, id: unknown): GovernedWorkflow {
  identifier(id); if (!Object.hasOwn(document.workflows, id)) throw new WorkflowServiceError("Workflow not found", 404);
  return document.workflows[id]!;
}
function event(document: WorkflowDocument, workflow: GovernedWorkflow, type: WorkflowEvent["type"], at: string, summary: string, stageId: string | null = null): void {
  document.events.push({ schema_version: 1, id: `WE-${randomUUID()}`, workflow_id: workflow.id, stage_id: stageId, execution_id: null, revision: workflow.revision, type, summary, at });
}
function safeProjection<T>(value: T): T {
  if (typeof value === "string") return redactContextText(value) as T;
  if (Array.isArray(value)) return value.map(safeProjection) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeProjection(item)])) as T;
  return value;
}
function strictConsent(value: unknown): void {
  if (value && typeof value === "object" && Object.hasOwn(value, "client_context_categories")) {
    const categories = (value as Record<string, unknown>).client_context_categories;
    if (categories && typeof categories === "object" && Object.values(categories).some((entry) => !Array.isArray(entry))) throw new WorkflowServiceError("Per-role consent must be an explicit category array", 400);
  }
}

export function createWorkflowService(repoRoot = process.cwd(), options: WorkflowServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const context = options.context ?? createWorkflowContextService(repoRoot, options.contextDependencies);
  const issues = options.issues ?? createIssueService(repoRoot, { now });
  const evidenceIssues = createIssueService(repoRoot, { now });
  const makeTask = options.createTask ?? createWorkflowTask;
  function detail(id: string) {
    const document = readWorkflowDocument(), workflow = findWorkflow(document, id);
    const grant = document.grants[workflow.current_grant_id]!;
    // Never project rendered context, source bodies, task instructions or paths.
    const { authorized_scope: _scope, ...publicGrant } = grant;
    return safeProjection({ schema_version: 1 as const, workflow, grant: publicGrant,
      stages: Object.values(document.stages).filter((entry) => entry.workflow_id === id),
      decisions: Object.values(document.decisions).filter((entry) => entry.workflow_id === id),
      handoffs: Object.values(document.handoffs).filter((entry) => Object.values(document.stages).some((stage) => stage.workflow_id === id && stage.handoff_id === entry.id)),
      review_receipts: Object.values(document.review_receipts).filter((entry) => entry.workflow_id === id),
      admission_intents: Object.values(document.admission_intents).filter((entry) => entry.workflow_id === id),
      accounting: Object.values(document.accounting).filter((entry) => entry.workflow_id === id),
      lineage: workflow.lineage_id ? document.lineages[workflow.lineage_id] : null,
      events: document.events.filter((entry) => entry.workflow_id === id), execution_enabled: options.execution?.available() === true,
      execution_boundary: "Exact evidence-sealed stages may chain under the grant, including at most one opted-in lineage correction; human gates remain required.",
      runtime_read_limitation: "Selected context containment does not guarantee all subsequent runtime reads are project-only." });
  }
  function finishAdmission(workflowId: string, stageId: string, reservedRevision: number) {
    try {
      const linked = issues.linkWorkflowTask(stageId);
      const result = makeTask({ workflow_id: workflowId, stage_id: stageId, expected_workflow_revision: reservedRevision, expected_issue_revision: linked.revision }, repoRoot, { context });
      const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, workflowId), stage = snapshot.stages[stageId]!;
      const intent = Object.values(snapshot.admission_intents).find((entry) => entry.stage_id === stageId)!;
      const task = readTask(result.id), assembled = context.assembleStage({ workflow_id: workflowId, stage_id: stageId, expected_issue_revision: linked.revision });
      requireCurrent(task && validateTaskRecord(task) && result.id === intent.task_id && task.lifecycle === "queued" && task.outcome === null && task.orchestration?.attempts === 0 && !task.orchestration.lease && !task.orchestration.cancel_requested_at
        && isDeepStrictEqual(task.envelope.context_admission, assembled.binding) && isDeepStrictEqual(task.envelope.context_manifest, assembled.preview.manifest)
        && task.envelope.instructions === assembled.instructions && task.envelope.title === assembled.instructions.slice(0, 80), "Reserved workflow task facts do not match");
      requireCurrent(isDeepStrictEqual(readIssueDocument().issues[workflow.issue_id], linked), "Issue changed before intent commitment");
      const at = now().toISOString();
      mutateWorkflowDocument((document) => {
        requireCurrent(isDeepStrictEqual(document, snapshot) && workflow.revision === reservedRevision && workflow.status === "running" && !workflow.stop_requested_at
          && !workflow.pending_decision_id && workflow.recovery_state === "none" && intent.status === "reserved" && stage.status === "reserved", "Workflow changed before intent commitment");
        const owner = document.workflows[workflowId]!; owner.revision++; owner.updated_at = at;
        owner.next_action = options.execution?.available() === true
          ? "Exact bounded stage admitted; current controller authority and evidence gates precede execution."
          : "Stage admitted; governed execution remains disabled until runtime/controller integration.";
        document.stages[stageId]!.status = "queued"; document.stages[stageId]!.updated_at = at;
        document.admission_intents[intent.id]!.status = "committed"; document.admission_intents[intent.id]!.updated_at = at;
        event(document, owner, "stage-admitted", at, "Exact reserved task and issue linkage committed; no execution was started.", stageId);
      });
      options.execution?.notify(result.id);
      return detail(workflowId);
    } catch {
      // Retain the exact reserved identity and all partial external facts. Never
      // roll back history, refund a charge or substitute another task id.
      const at = now().toISOString();
      mutateWorkflowDocument((document) => {
        const owner = findWorkflow(document, workflowId);
        if (owner.revision !== reservedRevision || owner.stop_requested_at || ["completed", "cancelled"].includes(owner.status)) return;
        owner.revision++; owner.updated_at = at; owner.status = "needs-decision"; owner.recovery_state = "awaiting-human";
        owner.blocked_reason = "Admission is incomplete; reserved task and separate issue/task facts require reconciliation.";
        owner.next_action = "Inspect retained admission facts; do not dispatch another task or infer execution authority.";
        event(document, owner, "recovery-required", at, owner.blocked_reason, stageId);
      });
      throw new WorkflowServiceError("Workflow admission incomplete; retained facts require reconciliation", 409, workflowId);
    }
  }
  function reconcileAdmission(id: string) {
    const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), issueDocument = readIssueDocument();
    const stage = workflow.current_stage_id ? snapshot.stages[workflow.current_stage_id] : null;
    const intent = Object.values(snapshot.admission_intents).find((entry) => entry.stage_id === stage?.id);
    requireCurrent(!workflow.stop_requested_at && workflow.counters.accounting_complete && !workflow.pending_decision_id && stage?.status === "reserved" && intent?.status === "reserved", "Only provable unstarted admission gaps can be recovered");
    const task = readTask(intent.task_id), issue = issueDocument.issues[workflow.issue_id];
    requireCurrent(task && validateTaskRecord(task) && task.lifecycle === "queued" && !task.outcome && task.orchestration?.attempts === 0 && !task.orchestration.lease && !task.orchestration.cancel_requested_at
      && issue?.revision === intent.expected_issue_revision && issue.task_ids.includes(task.envelope.id), "Admission task/link facts are missing or have progressed; no identity was replaced");
    const proposed = structuredClone(snapshot), projected = proposed.workflows[id]!;
    projected.status = "running"; projected.recovery_state = "none"; projected.blocked_reason = null;
    const assembled = createWorkflowContextService(repoRoot, { ...options.contextDependencies, readWorkflows: () => proposed, readIssues: () => issueDocument }).assembleStage({ workflow_id: id, stage_id: stage.id, expected_issue_revision: issue.revision });
    requireCurrent(isDeepStrictEqual(task.envelope.context_admission, assembled.binding) && isDeepStrictEqual(task.envelope.context_manifest, assembled.preview.manifest)
      && task.envelope.instructions === assembled.instructions && task.envelope.title === assembled.instructions.slice(0, 80)
      && (!assembled.clientContext || (task.envelope.metadata.client_context_share as { client_id?: string } | undefined)?.client_id === assembled.clientContext.audit.client_id), "Retained task does not match current admitted context");
    const at = now().toISOString();
    mutateWorkflowDocument((document) => {
      requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument) && isDeepStrictEqual(readTask(intent.task_id), task), "Facts changed during admission recovery");
      const owner = document.workflows[id]!; owner.status = "running"; owner.recovery_state = "none"; owner.blocked_reason = null;
      document.stages[stage.id]!.status = "queued"; document.stages[stage.id]!.updated_at = at;
      document.admission_intents[intent.id]!.status = "committed"; document.admission_intents[intent.id]!.updated_at = at;
      owner.revision++; owner.updated_at = at; owner.next_action = "Exact retained admission reconciled; current execution and evidence guards remain required.";
      event(document, owner, "reconciled", at, "Existing unstarted task and issue link reconciled without redispatch or refund.", stage.id);
    });
    options.execution?.notify(task.envelope.id);
    return detail(id);
  }
  function controlRequest(id: string, value: unknown) {
    const input = object(value, ["expected_revision", "expected_issue_revision"]); revision(input.expected_revision); revision(input.expected_issue_revision);
    const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), issues = readIssueDocument();
    requireCurrent(workflow.revision === input.expected_revision && issues.issues[workflow.issue_id]?.revision === input.expected_issue_revision
      && !["completed", "cancelled"].includes(workflow.status), "Workflow or issue revision is stale or terminal");
    requireCurrent(options.execution?.available(), "Workflow controller is unavailable; no control action was inferred");
    return { snapshot, workflow, issues };
  }
  function admitSuccessor(id: string) {
    const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), issueDocument = readIssueDocument();
    const predecessor = snapshot.stages[workflow.current_stage_id!]!, task = predecessor?.task_id ? readTask(predecessor.task_id) : null;
    requireCurrent(workflow.status === "running" && !workflow.stop_requested_at && workflow.recovery_state === "none" && !workflow.pending_decision_id
      && predecessor?.status === "completed" && workflow.counters.tasks < workflow.budget.max_tasks && workflow.counters.attempts < workflow.budget.max_attempts
      && workflow.counters.runtime_ms < workflow.budget.max_runtime_ms && workflow.counters.total_tokens < workflow.budget.max_total_tokens, "No bounded successor admission is available");
    assertTerminalWorkflowTask(snapshot, predecessor, task);
    assertOwnedWorkflowIssueProgress(snapshot, workflow, issueDocument, task!.envelope.context_admission!.issue_revision!);
    requireCurrent(!predecessor.output?.requested_decision || predecessor.kind === "planning", "Predecessor requested a human decision");
    const grant = snapshot.grants[workflow.current_grant_id]!, plan = resolveWorkflowTemplate({ template_id: workflow.template_id, template_version: 1, work_scale: workflow.work_scale,
      correction_enabled: grant.correction.enabled, review_policy: workflow.review_policy!, ...(workflow.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id as "planner" | "portfolio-analyst" } : {}) });
    const next = predecessor.ordinal < plan.stages.length ? plan.stages[predecessor.ordinal]
      : predecessor.ordinal > plan.stages.length ? plan.correction_stages[predecessor.ordinal - plan.stages.length] : undefined;
    const completingCorrectionReviews = predecessor.ordinal < plan.stages.length && predecessor.kind === "review" && next?.kind === "qa" && hasConcreteCorrectionFinding(predecessor.output);
    requireCurrent(predecessor.kind !== "review" && predecessor.kind !== "qa" || workflowReviewAllowsContinuation(predecessor.output) || completingCorrectionReviews,
      "Predecessor review evidence requires a human decision");
    requireCurrent(!predecessor.output?.unresolved_questions.length, "Predecessor evidence requires a decision");
    requireCurrent(next, "No ordinary successor exists; correction admission is evaluated separately");
    if (next.before_human_gates.includes("plan-approval")) requireCurrent(workflow.approved_plan?.stage_id === predecessor.id, "Exact current Planner approval is required");
    if (workflow.candidate) evidenceIssues.inspectWorkflowCandidate(id);
    const at = now().toISOString(), stageId = `WS-${randomUUID()}`, taskId = `T-${randomUUID().slice(0, 8)}`, handoffId = `WH-${randomUUID()}`, assignment = grant.role_assignments.find((entry) => entry.role_id === next.role_id)!;
    const proposed = structuredClone(snapshot), owner = proposed.workflows[id]!;
    const stage: WorkflowStage = { schema_version: 1, id: stageId, workflow_id: id, grant_id: grant.id, authority_revision: grant.authority_revision, generation: 1, ordinal: predecessor.ordinal + 1,
      kind: next.kind, role_id: next.role_id, agent_id: assignment.agent_id, sandbox: next.sandbox, status: "pending", phase: "execution", task_id: null, execution_id: null,
      predecessor_stage_id: predecessor.id, supersedes_stage_id: null, handoff_id: handoffId, output: null, output_fingerprint: null, candidate: next.requires_candidate ? owner.candidate : null,
      context_fingerprint: null, created_at: at, updated_at: at };
    proposed.stages[stageId] = stage; proposed.handoffs[handoffId] = sealWorkflowHandoff(proposed, predecessor, stage, issueDocument, handoffId, at);
    owner.stage_ids.push(stageId); owner.current_stage_id = stageId; owner.revision++; owner.updated_at = at;
    if (next.sandbox === "workspace-write" && !owner.lineage_id) {
      const lineageId = `WL-${randomUUID()}`; owner.lineage_id = lineageId;
      proposed.lineages[lineageId] = { schema_version: 1, id: lineageId, project_id: owner.project_id, issue_id: owner.issue_id, scope_revision: owner.scope_revision,
        origin_task_id: taskId, workflow_ids: [id], candidate_ids: [], correction_limit: grant.correction.max_corrections, corrections_consumed: 0, consumed_stage_id: null, consumed_at: null };
    }
    const projectedIssues = structuredClone(issueDocument), issue = issueDocument.issues[workflow.issue_id]!;
    const linked = projectWorkflowIssueLink(projectedIssues, proposed, stageId, taskId, issue.revision, at);
    const prepared = createWorkflowContextService(repoRoot, { ...options.contextDependencies, readWorkflows: () => proposed, readIssues: () => projectedIssues })
      .prepareStage({ workflow_id: id, stage_id: stageId, expected_issue_revision: linked.revision }, taskId);
    stage.status = "reserved"; stage.task_id = taskId; stage.context_fingerprint = prepared.binding.manifest_fingerprint; owner.counters.tasks++;
    const intentId = `WI-${randomUUID()}`;
    proposed.admission_intents[intentId] = { schema_version: 1, id: intentId, workflow_id: id, stage_id: stageId, grant_id: grant.id, authority_revision: grant.authority_revision,
      task_id: taskId, status: "reserved", expected_issue_revision: linked.revision, expected_workflow_revision: owner.revision, context_fingerprint: stage.context_fingerprint, blocked_reason: null, created_at: at, updated_at: at };
    owner.next_action = "Complete the exact sealed successor admission before execution.";
    event(proposed, owner, "handoff-sealed", at, "Immutable owned predecessor handoff sealed for the finite next role.", stageId);
    event(proposed, owner, "stage-reserved", at, "Exact successor identity and bounded context reserved once.", stageId);
    assertWorkflowDocument(proposed);
    mutateWorkflowDocument((document) => {
      requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument) && isDeepStrictEqual(readTask(task!.envelope.id), task), "Successor authority changed before reservation");
      Object.assign(document, proposed);
    });
    return finishAdmission(id, stageId, owner.revision);
  }
  function admitCorrection(id: string): { handled: boolean; admitted: boolean } {
    const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), issueDocument = readIssueDocument();
    const grant = snapshot.grants[workflow.current_grant_id]!, lineage = workflow.lineage_id ? snapshot.lineages[workflow.lineage_id] : null;
    const predecessor = workflow.current_stage_id ? snapshot.stages[workflow.current_stage_id] : null;
    if (!predecessor || workflow.status !== "running" || workflow.stop_requested_at || workflow.pending_decision_id || workflow.recovery_state !== "none"
      || !workflow.counters.accounting_complete || predecessor.status !== "completed" || predecessor.kind !== "review" && predecessor.kind !== "qa") {
      throw new WorkflowServiceError("Correction review gate is not current");
    }
    const plan = resolveWorkflowTemplate({ template_id: workflow.template_id, template_version: 1, work_scale: workflow.work_scale,
      correction_enabled: grant.correction.enabled, review_policy: workflow.review_policy!, ...(workflow.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id as "planner" | "portfolio-analyst" } : {}) });
    const issue = issueDocument.issues[workflow.issue_id];
    requireCurrent(predecessor.ordinal === plan.stages.length && issue?.status === "checking" && !!workflow.candidate && !!lineage,
      "Correction requires every ordinary stage and required review to complete on the current checking candidate");
    const predecessorTask = predecessor.task_id ? readTask(predecessor.task_id) : null;
    assertTerminalWorkflowTask(snapshot, predecessor, predecessorTask);
    assertOwnedWorkflowIssueProgress(snapshot, workflow, issueDocument, predecessorTask.envelope.context_admission!.issue_revision!);
    const candidateFacts = evidenceIssues.inspectWorkflowCandidate(id);
    requireCurrent(isDeepStrictEqual(readWorkflowDocument(), snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument)
      && isDeepStrictEqual(candidateFacts.candidate, workflow.candidate), "Candidate changed before correction evaluation");
    const requiredRoles = workflow.review_policy!.qa_required || workflow.template_id === "quality-review" ? ["reviewer", "qa-evaluator"] : ["reviewer"];
    const currentReviews = requiredRoles.map((roleId) => {
      const matches = Object.values(snapshot.review_receipts).filter((receipt) => receipt.workflow_id === id && receipt.role_id === roleId
        && receipt.candidate.candidate_id === workflow.candidate!.candidate_id && workflow.stage_ids.includes(receipt.stage_id)
        && snapshot.stages[receipt.stage_id]!.ordinal <= plan.stages.length);
      requireCurrent(matches.length === 1, "Every required current Reviewer/QA receipt must be unique before correction");
      const receipt = matches[0]!, stage = snapshot.stages[receipt.stage_id]!, task = readTask(receipt.task_id);
      assertTerminalWorkflowTask(snapshot, stage, task);
      const { fingerprint: receiptFingerprint, ...unsigned } = receipt;
      requireCurrent(receiptFingerprint === hash(unsigned) && isDeepStrictEqual(sealWorkflowReviewReceipt(snapshot, stage, issueDocument, receipt.id, receipt.created_at), receipt)
        && receipt.grant_id === grant.id && receipt.authority_revision === grant.authority_revision && receipt.review_policy_fingerprint === workflow.review_policy!.fingerprint
        && isDeepStrictEqual(receipt.candidate, workflow.candidate) && stage.output_fingerprint === hash(stage.output), "Current review receipt or stage binding is stale");
      return { receipt, stage, task, output: stage.output! };
    });
    const requested = currentReviews.filter((entry) => hasConcreteCorrectionFinding(entry.output));
    const invalid = currentReviews.filter((entry) => !workflowReviewAllowsContinuation(entry.output) && !hasConcreteCorrectionFinding(entry.output));
    if (!requested.length && !invalid.length) return { handled: false, admitted: false };
    const deny = (reasons: string[]) => {
      const at = now().toISOString(), reason = `Bounded correction requires a human decision: ${[...new Set(reasons)].join("; ")}`.slice(0, 1000);
      mutateWorkflowDocument((document) => {
        requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument), "Correction decision facts changed before retention");
        const owner = document.workflows[id]!; owner.status = "needs-decision"; owner.recovery_state = "awaiting-human"; owner.blocked_reason = reason;
        owner.next_action = "Inspect the retained candidate and review findings; a human must decide the next action.";
        owner.revision++; owner.updated_at = at; event(document, owner, "recovery-required", at, reason, predecessor.id);
      });
      return { handled: true, admitted: false };
    };
    if (invalid.length) return deny(["A required Reviewer/QA receipt is inconclusive, incomplete or requests a human decision"]);
    const correctionStagePlan = plan.correction_stages[0];
    if (!correctionStagePlan || !lineage) return deny(["Correction was not explicitly opted in or its lineage is unavailable"]);
    const candidateTask = readTask(workflow.candidate!.task_id);
    if (!candidateTask?.testing_evidence || !candidateTask.envelope.context_manifest || !candidateFacts.task || !candidateFacts.candidate) {
      return deny(["The exact passed candidate verification receipt is unavailable"]);
    }
    const current = context.preview({ template_id: grant.template_id, template_version: grant.template_version, project_id: grant.project_id, issue_id: grant.issue_id,
      expected_revision: issue!.revision, selected_agents: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.agent_id])),
      client_context_categories: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.client_context_categories])), budget: grant.budget,
      correction_enabled: grant.correction.enabled, ...(grant.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id } : {}) });
    const grantCurrent = current.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner"
      || issue!.status === "checking" && reason === "Write workflow requires the current exact-scope issue authorization")
      && current.scope_fingerprint === hash(grant.authorized_scope) && isDeepStrictEqual(current.source_fingerprints, grant.source_fingerprints)
      && current.policy_fingerprint === grant.policy_fingerprint && current.testing_policy_fingerprint === grant.testing_policy_fingerprint
      && isDeepStrictEqual(current.review_policy, workflow.review_policy) && isDeepStrictEqual(current.plan, plan);
    const activeWriter = workflow.stage_ids.map((stageId) => snapshot.stages[stageId]!).filter((stage) => ["implementation", "correction"].includes(stage.kind))
      .some((stage) => { const task = stage.task_id ? readTask(stage.task_id) : null; return !!task && (task.lifecycle !== "finished" || !!task.orchestration?.lease); });
    const config = options.contextDependencies?.readConfig?.() ?? readContextConfig(repoRoot);
    const verificationCommands = new Set(candidateTask.envelope.context_manifest.testing.commands);
    const verificationProbePaths = Object.values(config.runners).filter((runner) => verificationCommands.has(runner.command))
      .flatMap((runner) => runner.probe?.sources.map((source) => source.path) ?? []);
    const engineer = grant.role_assignments.find((entry) => entry.role_id === "software-engineer");
    const role = engineer ? new PolicyService(repoRoot).authorizeRole({ project: grant.project_id, agent: engineer.agent_id, roleId: "software-engineer", taskKind: "implementation", sandbox: "workspace-write", selfVerify: true }).role : null;
    const trustedSourcePaths = ["AGENTS.md", ...(role?.required_evaluation_ids ?? [])];
    const correctionStages = Object.values(snapshot.stages).filter((stage) => stage.workflow_id === id && stage.ordinal > plan.stages.length);
    const correctionCharges = Object.values(snapshot.accounting).filter((charge) => correctionStages.some((stage) => stage.id === charge.stage_id));
    const correctionCounters = { tasks: correctionStages.filter((stage) => !!stage.task_id).length, attempts: correctionCharges.length,
      runtime_ms: correctionCharges.reduce((total, charge) => total + charge.active_runtime_ms, 0), total_tokens: correctionCharges.reduce((total, charge) => total + charge.observed_tokens, 0),
      accounting_complete: correctionCharges.every((charge) => charge.usage_complete) };
    const proposedPaths = currentReviews.flatMap((entry) => entry.output.kind === "review" || entry.output.kind === "qa"
      ? entry.output.findings.flatMap((finding) => finding.path ? [finding.path] : []) : []);
    const evaluations = requested.map(({ receipt, output }) => evaluateCorrectionEligibility({ workflow, grant, lineage: lineage!, issue: issue!, candidate: candidateFacts.candidate,
      testing_evidence: candidateTask.testing_evidence!, current_testing_policy_fingerprint: current.testing_policy_fingerprint, review_output: output, review_receipt: receipt, policy: options.contextDependencies?.readWorkflowPolicy?.() ?? readWorkflowPolicy(repoRoot),
      correction_counters: correctionCounters, original_engineer_id: engineer?.agent_id ?? "", selected_engineer_id: correctionStagePlan.role_id === "software-engineer" ? engineer?.agent_id ?? "" : "",
      grant_current: grantCurrent, candidate_current: isDeepStrictEqual(candidateFacts.candidate, workflow.candidate), review_current: true, implementation_lease_active: activeWriter,
      trusted_source_paths: trustedSourcePaths, verification_probe_paths: [...new Set(verificationProbePaths)], proposed_paths: [...new Set(proposedPaths)] }));
    const failures = evaluations.flatMap((entry) => entry.eligible ? [] : entry.reasons);
    if (failures.length) return deny(failures);
    requireCurrent(predecessorTask && isDeepStrictEqual(readWorkflowDocument(), snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument)
      && !activeWriter && grantCurrent, "Correction authority changed before durable consumption");
    const at = now().toISOString(), stageId = `WS-${randomUUID()}`, taskId = `T-${randomUUID().slice(0, 8)}`, handoffId = `WH-${randomUUID()}`;
    const assignment = grant.role_assignments.find((entry) => entry.role_id === correctionStagePlan.role_id)!;
    const stage: WorkflowStage = { schema_version: 1, id: stageId, workflow_id: id, grant_id: grant.id, authority_revision: grant.authority_revision, generation: 1,
      ordinal: predecessor.ordinal + 1, kind: correctionStagePlan.kind, role_id: correctionStagePlan.role_id, agent_id: assignment.agent_id, sandbox: correctionStagePlan.sandbox,
      status: "pending", phase: "execution", task_id: null, execution_id: null, predecessor_stage_id: predecessor.id, supersedes_stage_id: null, handoff_id: handoffId,
      output: null, output_fingerprint: null, candidate: structuredClone(workflow.candidate), context_fingerprint: null, created_at: at, updated_at: at };
    const proposed = structuredClone(snapshot), owner = proposed.workflows[id]!, consumed = proposed.lineages[owner.lineage_id!]!;
    proposed.stages[stageId] = stage; owner.stage_ids.push(stageId); owner.current_stage_id = stageId;
    consumed.corrections_consumed = 1; consumed.consumed_stage_id = stageId; consumed.consumed_at = at;
    const findings = requested.flatMap(({ output }) => output.kind === "review" || output.kind === "qa"
      ? output.findings.filter((finding) => finding.severity === "blocking").map((finding) => `${finding.path}: ${finding.summary}`) : []);
    const handoff = sealWorkflowHandoff(proposed, predecessor, stage, issueDocument, handoffId, at);
    handoff.outcome_summary = redactContextText(`Bounded correction requested by current review evidence: ${findings.join("; ")}`).slice(0, 900);
    handoff.recommended_next_action = "Correct only the exact in-scope, evidence-linked blocking findings; preserve the authorized scope and protected policy/probe files.";
    proposed.handoffs[handoffId] = handoff;
    const projectedIssues = structuredClone(issueDocument), linked = projectWorkflowIssueLink(projectedIssues, proposed, stageId, taskId, issue!.revision, at);
    const prepared = createWorkflowContextService(repoRoot, { ...options.contextDependencies, readWorkflows: () => proposed, readIssues: () => projectedIssues })
      .prepareStage({ workflow_id: id, stage_id: stageId, expected_issue_revision: linked.revision }, taskId);
    stage.status = "reserved"; stage.task_id = taskId; stage.context_fingerprint = prepared.binding.manifest_fingerprint; owner.counters.tasks++;
    owner.revision++; owner.updated_at = at; owner.next_action = "The single lineage correction is durably consumed; complete its exact task admission before execution.";
    const intentId = `WI-${randomUUID()}`;
    proposed.admission_intents[intentId] = { schema_version: 1, id: intentId, workflow_id: id, stage_id: stageId, grant_id: grant.id, authority_revision: grant.authority_revision,
      task_id: taskId, status: "reserved", expected_issue_revision: linked.revision, expected_workflow_revision: owner.revision, context_fingerprint: stage.context_fingerprint,
      blocked_reason: null, created_at: at, updated_at: at };
    event(proposed, owner, "correction-consumed", at, "One opt-in correction allowance consumed for the exact current candidate lineage.", stageId);
    event(proposed, owner, "handoff-sealed", at, "Current required review findings sealed to the original authorized Engineer.", stageId);
    event(proposed, owner, "stage-reserved", at, "Exact correction task and candidate base reserved once before task admission.", stageId);
    assertWorkflowDocument(proposed);
    const taskFacts = [candidateTask, ...currentReviews.map((entry) => entry.task), predecessorTask];
    mutateWorkflowDocument((document) => {
      requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument)
        && taskFacts.every((task) => !!task && isDeepStrictEqual(readTask(task.envelope.id), task)), "Correction candidate, review or accounting facts changed before consumption");
      Object.assign(document, proposed);
    });
    finishAdmission(id, stageId, owner.revision);
    return { handled: true, admitted: true };
  }
  function reconcileAcceptance(id: string) {
    const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), issueDocument = readIssueDocument(), issue = issueDocument.issues[workflow.issue_id];
    if (workflow.status !== "waiting-human" || workflow.stop_requested_at || !workflow.pending_decision_id || issue?.status !== "done") return detail(id);
    const decision = snapshot.decisions[workflow.pending_decision_id]!, accepted = issueDocument.events.filter((entry) => entry.issue_id === issue.id).at(-1);
    requireCurrent(decision.kind === "candidate-acceptance" && decision.status === "pending" && decision.expected_workflow_revision === workflow.revision
      && issue.revision === decision.expected_issue_revision + 1 && accepted?.type === "candidate-accepted" && accepted.payload.workflow_id === id
      && accepted.payload.decision_id === decision.id && accepted.payload.workflow_revision === workflow.revision && accepted.payload.resource_fingerprint === decision.resource_fingerprint
      && accepted.payload.candidate_id === decision.candidate_id && isDeepStrictEqual(accepted.payload.review_receipt_ids, decision.review_receipt_ids)
      && issue.scope_revision === workflow.scope_revision, "Human acceptance has no exact retained workflow decision binding");
    humanText(accepted.payload.approval_id, 100); humanText(accepted.payload.rationale, 1000);
    const at = now().toISOString();
    mutateWorkflowDocument((document) => {
      requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueDocument), "Human acceptance facts changed during reconciliation");
      const owner = document.workflows[id]!, resolved = document.decisions[decision.id]!;
      resolved.status = "approved"; resolved.approval_id = accepted.payload.approval_id as string; resolved.rationale = accepted.payload.rationale as string; resolved.decided_by = "human"; resolved.decided_at = at;
      owner.status = "completed"; owner.current_stage_id = null; owner.pending_decision_id = null; owner.completed_at = at; owner.revision++; owner.updated_at = at;
      owner.next_action = "Exact candidate accepted locally by human; publication remains separately authorized.";
      event(document, owner, "decision-resolved", at, "Retained exact human candidate acceptance reconciled."); event(document, owner, "completed", at, "Workflow completed without publication.");
    }); return detail(id);
  }
  return {
    preview: (value: unknown) => { strictConsent(value); return context.preview(value); },
    list(value: unknown = {}) {
      const input = object(value, ["issue_id", "project_id"], []);
      if (input.issue_id !== undefined) identifier(input.issue_id); if (input.project_id !== undefined) identifier(input.project_id);
      return safeProjection(Object.values(readWorkflowDocument().workflows).filter((entry) => (!input.issue_id || entry.issue_id === input.issue_id) && (!input.project_id || entry.project_id === input.project_id)));
    },
    detail,
    reconcileAdmission,
    admitSuccessor,
    admitCorrection,
    reconcileAcceptance,
    cancel(id: string, value: unknown) {
      const { snapshot, workflow, issues: issueFacts } = controlRequest(id, value), at = now().toISOString();
      mutateWorkflowDocument((document) => {
        requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueFacts), "Authority changed before durable stop");
        const owner = document.workflows[id]!;
        if (owner.stop_requested_at) return;
        owner.stop_requested_at = at; owner.status = "needs-decision"; owner.blocked_reason = "Workflow stop requested by human.";
        owner.next_action = "Abort the owned task and reconcile stop; retain issue state, evidence and candidate trees.";
        owner.revision++; owner.updated_at = at; event(document, owner, "cancel-requested", at, owner.blocked_reason);
      });
      const taskId = workflow.current_stage_id ? snapshot.stages[workflow.current_stage_id]?.task_id : null;
      if (taskId) { try { options.execution!.cancelTask(taskId); } catch { /* durable stop remains authoritative */ } options.execution!.notify(taskId); }
      return detail(id);
    },
    recover(id: string, value: unknown) {
      controlRequest(id, value);
      return reconcileAdmission(id);
    },
    start(value: unknown) {
      const input = object(value, ["request", "preview_fingerprint", "approval_id", "confirm"]);
      fingerprint(input.preview_fingerprint); humanText(input.approval_id, 100);
      if (input.confirm !== true) throw new WorkflowServiceError("Explicit human workflow confirmation is required", 400);
      strictConsent(input.request);
      const confirmed = context.revalidatePreview(input.request, input.preview_fingerprint), preview = confirmed.preview;
      const before = readWorkflowDocument(), issueDocument = readIssueDocument();
      requireCurrent(isDeepStrictEqual(issueDocument.issues[confirmed.issue.id], confirmed.issue), "Issue changed before root reservation");
      requireCurrent(!Object.values(before.workflows).some((entry) => entry.issue_id === confirmed.issue.id && !["completed", "cancelled"].includes(entry.status)), "Issue already has an active workflow");
      const at = now().toISOString(), id = `WF-${randomUUID()}`, grantId = `WG-${randomUUID()}`, stageId = `WS-${randomUUID()}`, taskId = `T-${randomUUID().slice(0, 8)}`;
      const grant: WorkflowGrant = { schema_version: 1, id: grantId, workflow_id: id, project_id: confirmed.issue.project_id, issue_id: confirmed.issue.id, issue_revision: confirmed.issue.revision,
        scope_revision: confirmed.issue.scope_revision, authority_revision: 1, template_id: preview.request.template_id, template_version: 1, authorized_scope: structuredClone(confirmed.issue.authorized_scope),
        role_assignments: preview.role_assignments, permitted_stage_kinds: [...new Set([...preview.plan.stages, ...preview.plan.correction_stages].map((entry) => entry.kind))], ...confirmed.grantContext,
        preview_fingerprint: preview.fingerprint, budget: preview.budget, correction: preview.correction, approved_by: "human", approval_id: input.approval_id, approved_at: at };
      const first = preview.plan.stages[0]!, assignment = grant.role_assignments.find((entry) => entry.role_id === first.role_id)!;
      const workflow: GovernedWorkflow = { schema_version: 1, id, revision: 1, project_id: grant.project_id, issue_id: grant.issue_id, scope_revision: grant.scope_revision, template_id: grant.template_id, template_version: 1,
        status: "running", work_scale: confirmed.issue.work_scale, current_grant_id: grantId, authority_revision: 1, stage_ids: [stageId], current_stage_id: stageId, pending_decision_id: null,
        lineage_id: null, candidate: preview.candidate, approved_plan: null, review_policy: preview.review_policy, budget: grant.budget,
        counters: { tasks: 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Reserve the first bounded stage.", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null };
      const stage: WorkflowStage = { schema_version: 1, id: stageId, workflow_id: id, grant_id: grantId, authority_revision: 1, generation: 1, ordinal: 1, kind: first.kind, role_id: first.role_id,
        agent_id: assignment.agent_id, sandbox: first.sandbox, status: "pending", phase: "execution", task_id: null, execution_id: null, predecessor_stage_id: null, supersedes_stage_id: null,
        handoff_id: null, output: null, output_fingerprint: null, candidate: first.requires_candidate ? preview.candidate : null, context_fingerprint: null, created_at: at, updated_at: at };
      const proposed = structuredClone(before); proposed.workflows[id] = workflow; proposed.grants[grantId] = grant; proposed.stages[stageId] = stage;
      // Quality review retains an existing lineage; no new id resets allowance.
      const lineage = preview.candidate && Object.values(proposed.lineages).find((entry) => entry.candidate_ids.includes(preview.candidate!.candidate_id));
      if (lineage) { workflow.lineage_id = lineage.id; lineage.workflow_ids.push(id); }
      const projectedIssues = structuredClone(issueDocument);
      const linked = projectWorkflowIssueLink(projectedIssues, proposed, stageId, taskId, confirmed.issue.revision, at);
      const prospective = createWorkflowContextService(repoRoot, { ...options.contextDependencies, readWorkflows: () => proposed, readIssues: () => projectedIssues });
      const prepared = prospective.prepareStage({ workflow_id: id, stage_id: stageId, expected_issue_revision: linked.revision }, taskId);
      stage.status = "reserved"; stage.task_id = taskId; stage.context_fingerprint = prepared.binding.manifest_fingerprint; workflow.counters.tasks = 1;
      if (first.sandbox === "workspace-write") {
        const lineageId = `WL-${randomUUID()}`; workflow.lineage_id = lineageId;
        proposed.lineages[lineageId] = { schema_version: 1, id: lineageId, project_id: grant.project_id, issue_id: grant.issue_id, scope_revision: grant.scope_revision,
          origin_task_id: taskId, workflow_ids: [id], candidate_ids: [], correction_limit: grant.correction.max_corrections, corrections_consumed: 0, consumed_stage_id: null, consumed_at: null };
      }
      const intentId = `WI-${randomUUID()}`;
      proposed.admission_intents[intentId] = { schema_version: 1, id: intentId, workflow_id: id, stage_id: stageId, grant_id: grantId, authority_revision: 1, task_id: taskId, status: "reserved",
        expected_issue_revision: linked.revision, expected_workflow_revision: 1, context_fingerprint: stage.context_fingerprint, blocked_reason: null, created_at: at, updated_at: at };
      workflow.next_action = "Complete the exact reserved task/issue admission before any execution.";
      event(proposed, workflow, "created", at, "Finite workflow created by explicit issued-preview confirmation.");
      event(proposed, workflow, "grant-approved", at, "Exact root scope, roles, consent, sources and finite budget approved.");
      event(proposed, workflow, "stage-reserved", at, "First stage/task identity and context reserved durably.", stageId);
      assertWorkflowDocument(proposed);
      requireCurrent(isDeepStrictEqual(readIssueDocument(), issueDocument), "Issue state changed before root reservation");
      mutateWorkflowDocument((document) => { requireCurrent(isDeepStrictEqual(document, before), "Workflow state changed before root reservation"); Object.assign(document, proposed); });
      return finishAdmission(id, stageId, 1);
    },
    decide(id: string, value: unknown) {
      const decisionKeys = ["expected_revision", "expected_issue_revision", "decision_id", "resource_fingerprint", "decision", "approval_id", "rationale", "confirm"];
      const input = object(value, [...decisionKeys, "confirmed_criteria"], decisionKeys);
      revision(input.expected_revision); revision(input.expected_issue_revision); identifier(input.decision_id); fingerprint(input.resource_fingerprint); humanText(input.approval_id, 100); humanText(input.rationale, 1000);
      if (input.confirm !== true || !["approve", "reject"].includes(String(input.decision))) throw new WorkflowServiceError("Explicit approve/reject confirmation is required", 400);
      const snapshot = readWorkflowDocument(), workflow = findWorkflow(snapshot, id), decision = snapshot.decisions[input.decision_id];
      const issue = readIssueDocument().issues[workflow.issue_id], grant = snapshot.grants[workflow.current_grant_id]!;
      requireCurrent(workflow.status === "waiting-human" && !workflow.stop_requested_at && workflow.recovery_state === "none" && workflow.revision === input.expected_revision
        && workflow.pending_decision_id === input.decision_id && decision?.status === "pending" && decision.workflow_id === id
        && decision.expected_workflow_revision === workflow.revision && decision.expected_issue_revision === input.expected_issue_revision && issue?.revision === input.expected_issue_revision
        && decision.resource_fingerprint === input.resource_fingerprint, "Workflow decision is missing, stale or already resolved");
      requireCurrent(input.confirmed_criteria === undefined || decision.kind === "candidate-acceptance", "Criteria are only accepted for the final candidate decision");
      if (decision.kind !== "plan-approval") {
        requireCurrent(["proposal-acknowledgement", "candidate-acceptance", "risk-acknowledgement"].includes(decision.kind), "This workflow decision kind is not implemented; no mutation was performed");
        const stage = snapshot.stages[workflow.current_stage_id!]!, task = stage?.task_id ? readTask(stage.task_id) : null;
        assertTerminalWorkflowTask(snapshot, stage, task); assertOwnedWorkflowIssueProgress(snapshot, workflow, readIssueDocument(), task!.envelope.context_admission!.issue_revision!);
        let reviews: ReturnType<typeof applicableWorkflowReviews> | null = null;
        if (decision.kind === "proposal-acknowledgement") {
          requireCurrent((stage.kind === "analysis" || stage.kind === "operations") && stage.output?.status === "completed" && hash(stage.output) === decision.resource_fingerprint, "Exact terminal proposal is unavailable");
          const current = context.preview({ template_id: grant.template_id, template_version: 1, project_id: grant.project_id, issue_id: grant.issue_id, expected_revision: issue.revision,
            selected_agents: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.agent_id])), client_context_categories: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.client_context_categories])),
            budget: grant.budget, correction_enabled: false, ...(grant.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id } : {}) });
          requireCurrent(current.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner") && isDeepStrictEqual(current.source_fingerprints, grant.source_fingerprints)
            && current.policy_fingerprint === grant.policy_fingerprint && current.testing_policy_fingerprint === grant.testing_policy_fingerprint, "Proposal sources or policy changed");
        } else {
          evidenceIssues.inspectWorkflowCandidate(id); reviews = applicableWorkflowReviews(snapshot, workflow, readIssueDocument(), readTask);
          requireCurrent(decision.candidate_id === workflow.candidate?.candidate_id && decision.resource_fingerprint === reviews.fingerprint && isDeepStrictEqual(decision.review_receipt_ids, reviews.receipts.map((entry) => entry.id)), "Current review decision binding differs");
          if (decision.kind === "candidate-acceptance" && input.decision === "approve") {
            requireCurrent(Array.isArray(input.confirmed_criteria) && input.confirmed_criteria.every((entry) => typeof entry === "string")
              && isDeepStrictEqual([...input.confirmed_criteria].sort(), [...issue.acceptance_criteria].sort()), "Every exact acceptance criterion must be confirmed");
            evidenceIssues.acceptCandidate(issue.id, { expectedRevision: issue.revision, candidateId: workflow.candidate!.candidate_id, fingerprint: workflow.candidate!.diff_fingerprint,
              approvalId: input.approval_id as string, rationale: input.rationale as string, confirmedCriteria: input.confirmed_criteria as string[] },
            { workflowId: id, decisionId: decision.id, expectedRevision: workflow.revision, resourceFingerprint: reviews.fingerprint });
            return reconcileAcceptance(id);
          }
        }
        const issueFacts = readIssueDocument(), at = now().toISOString();
        requireCurrent(isDeepStrictEqual(issueFacts.issues[issue.id], issue), "Issue changed before human evidence decision");
        mutateWorkflowDocument((document) => {
          requireCurrent(isDeepStrictEqual(document, snapshot) && isDeepStrictEqual(readIssueDocument(), issueFacts) && isDeepStrictEqual(readTask(task!.envelope.id), task), "Evidence decision facts changed");
          const owner = document.workflows[id]!, resolved = document.decisions[decision.id]!;
          resolved.status = input.decision === "approve" ? "approved" : "rejected"; resolved.approval_id = input.approval_id as string; resolved.rationale = input.rationale as string; resolved.decided_by = "human"; resolved.decided_at = at;
          owner.revision++; owner.updated_at = at; owner.pending_decision_id = null;
          if (input.decision === "reject") { owner.status = "needs-decision"; owner.recovery_state = "awaiting-human"; owner.blocked_reason = "Human rejected the current evidence decision."; owner.next_action = "Inspect retained evidence; no successor or publication was admitted."; }
          else if (decision.kind === "proposal-acknowledgement") { owner.status = "completed"; owner.current_stage_id = null; owner.completed_at = at; owner.next_action = "Proposal acknowledged; no issue or provider action was taken."; }
          else { owner.status = "running"; owner.next_action = "Candidate-bound advisory risks acknowledged; final candidate acceptance remains required."; }
          event(document, owner, "decision-resolved", at, "Exact human evidence decision retained.", stage.id);
        });
        return detail(id);
      }
      const planner = workflow.stage_ids.map((stageId) => snapshot.stages[stageId]!).find((stage) => stage.kind === "planning" && stage.output_fingerprint === decision.resource_fingerprint);
      const task = planner?.task_id ? readTask(planner.task_id) : null;
      requireCurrent(planner?.status === "completed" && planner.grant_id === grant.id && planner.output?.kind === "plan" && planner.output.status === "completed" && !planner.output.scope_change_required
        && hash(planner.output) === planner.output_fingerprint && isDeepStrictEqual(safeProjection(planner.output), planner.output) && task && validateTaskRecord(task) && task.lifecycle === "finished" && task.outcome === "completed" && !task.orchestration?.lease && !task.orchestration?.cancel_requested_at
        && task.envelope.context_admission?.schema_version === 2 && task.envelope.context_admission.workflow_id === id && task.envelope.context_admission.stage_id === planner.id
        && task.envelope.context_admission.grant_id === grant.id && task.envelope.context_admission.authority_revision === grant.authority_revision && task.envelope.context_admission.stage_generation === planner.generation
        && task.envelope.context_manifest?.fingerprint === planner.context_fingerprint && issue.task_ids.includes(task.envelope.id) && task.orchestration?.last_failure === null, "Exact terminal Planner proposal is not available under current authority");
      const issueFacts = readIssueDocument();
      requireCurrent(planner.output.evidence_ids.every((id) => { const entry = issueFacts.evidence[id]; return issue.evidence_ids.includes(id) && entry?.issue_id === issue.id && entry.task_id === task.envelope.id && entry.execution_id === planner.execution_id; }), "Planner evidence references are unrelated or missing");
      const charge = Object.values(snapshot.accounting).find((entry) => entry.stage_id === planner.id && entry.execution_id === planner.execution_id);
      requireCurrent(charge?.usage_complete && charge.attempt === task.orchestration!.attempts && workflow.counters.accounting_complete, "Planner accounting is incomplete");
      const current = context.preview({ template_id: grant.template_id, template_version: 1, project_id: grant.project_id, issue_id: grant.issue_id, expected_revision: issue.revision,
        selected_agents: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.agent_id])), client_context_categories: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.client_context_categories])), budget: grant.budget, correction_enabled: grant.correction.enabled });
      requireCurrent(current.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner") && isDeepStrictEqual(current.source_fingerprints, grant.source_fingerprints)
        && current.policy_fingerprint === grant.policy_fingerprint && current.testing_policy_fingerprint === grant.testing_policy_fingerprint && current.scope_fingerprint === hash(grant.authorized_scope), "Sources, scope, consent or policy changed before plan approval");
      const at = now().toISOString();
      requireCurrent(isDeepStrictEqual(readIssueDocument().issues[workflow.issue_id], issue), "Issue changed before decision persistence");
      mutateWorkflowDocument((document) => {
        requireCurrent(isDeepStrictEqual(document, snapshot), "Workflow changed before decision persistence");
        const owner = document.workflows[id]!, resolved = document.decisions[decision.id]!;
        resolved.status = input.decision === "approve" ? "approved" : "rejected"; resolved.approval_id = input.approval_id as string; resolved.decided_by = "human"; resolved.rationale = input.rationale as string; resolved.decided_at = at;
        owner.revision++; owner.updated_at = at; owner.pending_decision_id = null;
        if (input.decision === "approve") { owner.approved_plan = { stage_id: planner.id, output_fingerprint: planner.output_fingerprint!, decision_id: decision.id }; owner.status = "running"; owner.next_action = "Await governed successor reconciliation; plan approval never edits issue scope or plan."; }
        else { owner.status = "needs-decision"; owner.blocked_reason = "The exact Planner proposal was rejected; new human direction is required."; owner.recovery_state = "awaiting-human"; owner.next_action = "Inspect the retained proposal; no successor was admitted."; }
        event(document, owner, "decision-resolved", at, "Human decision recorded for the exact current Planner proposal.", planner.id);
      });
      return detail(id);
    },
    unsupported(id: string, value: unknown) {
      const input = object(value, ["expected_revision", "expected_issue_revision"], ["expected_revision", "expected_issue_revision"]);
      revision(input.expected_revision); revision(input.expected_issue_revision); findWorkflow(readWorkflowDocument(), id);
      throw new WorkflowServiceError("Workflow stop/recovery is not implemented in this slice; no mutation was performed");
    },
  };
}
export type WorkflowService = ReturnType<typeof createWorkflowService>;
