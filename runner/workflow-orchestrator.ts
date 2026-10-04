import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readTask, updateTask } from "../lib/state/store";
import { readIssueDocument } from "../lib/state/issues";
import { mutateWorkflowDocument, readWorkflowDocument } from "../lib/state/workflows";
import type { TaskRecord } from "../lib/state/types";
import type { GovernedWorkflow, WorkflowDocument } from "../lib/workflows/types";
import { applicableWorkflowReviews, assertOwnedWorkflowIssueProgress, assertTerminalWorkflowTask, hasCurrentRiskAcknowledgement, sealWorkflowReviewReceipt, workflowReviewAllowsContinuation } from "../lib/workflows/review-evidence";
import { contextHash } from "../lib/context/assemble";
import { ContextContractError } from "../lib/context/validation";
import { failureResult } from "./result";
import type { TaskControl } from "./task-orchestrator";
import { createWorkflowService } from "../dashboard/src/server/workflow-service";
import { createIssueService } from "../dashboard/src/server/issue-service";
import { createWorkflowContextService } from "../dashboard/src/server/workflow-context-service";
import { resolveWorkflowTemplate } from "../lib/workflows/templates";
import { hasConcreteCorrectionFinding } from "../lib/workflows/policy";
import { prepareWorkflowStage, validateWorkflowStageOutput } from "./workflow-stage";

// Process-local identity, never persisted, accepted from JSON or inferred from
// a live task lease alone. Durable authority is rechecked independently.
const executions = new WeakMap<object, { owner: WorkflowOrchestrator; taskId: string; runId: string }>();
export function workflowExecutionOwner(proof: unknown, taskId: string, runId: string): WorkflowOrchestrator | null {
  const entry = proof && typeof proof === "object" ? executions.get(proof) : undefined;
  return entry?.taskId === taskId && entry.runId === runId ? entry.owner : null;
}
const terminal = (workflow: GovernedWorkflow) => ["completed", "cancelled"].includes(workflow.status);
const hash = (value: unknown) => contextHash(JSON.stringify(value));
function change(document: WorkflowDocument, workflow: GovernedWorkflow, at: string, type: WorkflowDocument["events"][number]["type"], summary: string) {
  workflow.revision++; workflow.updated_at = at;
  document.events.push({ schema_version: 1, id: `WE-${randomUUID()}`, workflow_id: workflow.id, stage_id: workflow.current_stage_id,
    execution_id: null, revision: workflow.revision, type, summary, at });
}

/** Finite state reconciliation only. TaskOrchestrator remains the sole worker. */
export class WorkflowOrchestrator {
  readonly service: ReturnType<typeof createWorkflowService>;
  private readonly context: ReturnType<typeof createWorkflowContextService>;
  private control: Pick<TaskControl, "cancel" | "enqueue"> | null = null;
  private workerId: string | null = null;
  private reconciling = false;
  constructor(readonly repoRoot = process.cwd(), private readonly now: () => Date = () => new Date()) {
    this.context = createWorkflowContextService(repoRoot);
    this.service = createWorkflowService(repoRoot, { context: this.context, now,
      execution: { notify: (id) => this.control?.enqueue(id), cancelTask: (id) => {
        if (!this.control) throw new ContextContractError("Workflow worker is unavailable; durable stop is retained");
        const task = readTask(id); if (task && task.lifecycle !== "finished") this.control.cancel(id);
      }, available: () => this.control !== null } });
  }
  connect(control: Pick<TaskControl, "cancel" | "enqueue">, workerId: string): void {
    if (this.control && (this.control !== control || this.workerId !== workerId)) throw new ContextContractError("Workflow controller already has an owning worker");
    this.control = control; this.workerId = workerId;
  }
  private facts(task: TaskRecord) {
    const admission = task.envelope.context_admission;
    if (admission?.schema_version !== 2) throw new ContextContractError("A workflow admission is required");
    const document = readWorkflowDocument(), workflow = document.workflows[admission.workflow_id], stage = document.stages[admission.stage_id];
    const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === admission.stage_id && entry.task_id === task.envelope.id);
    if (!workflow || !stage || terminal(workflow) || workflow.current_stage_id !== stage.id || stage.task_id !== task.envelope.id
      || stage.generation !== admission.stage_generation || workflow.current_grant_id !== admission.grant_id || stage.grant_id !== admission.grant_id
      || workflow.authority_revision !== admission.authority_revision || intent?.status !== "committed"
      || intent.context_fingerprint !== admission.manifest_fingerprint) throw new ContextContractError("Current workflow intent or authority differs");
    return { document, workflow, stage, admission };
  }
  canClaim(task: TaskRecord): boolean {
    const { workflow, stage } = this.facts(task);
    const supportedStages = ["analysis", "planning", "implementation", "review", "qa", "operations", "correction"];
    if (workflow.status !== "running" || workflow.stop_requested_at || workflow.pending_decision_id || workflow.recovery_state !== "none"
      || !workflow.counters.accounting_complete || workflow.counters.attempts >= workflow.budget.max_attempts
      || workflow.counters.runtime_ms >= workflow.budget.max_runtime_ms || workflow.counters.total_tokens >= workflow.budget.max_total_tokens
      || !supportedStages.includes(stage.kind) || (["implementation", "correction"].includes(stage.kind)) !== (stage.sandbox === "workspace-write")
      || !["queued", "running"].includes(stage.status)) return false;
    this.context.revalidateTask(task);
    return true;
  }
  claimRun(taskId: string, runId: string): object {
    const task = readTask(taskId);
    if (!task || task.lifecycle !== "running" || task.orchestration?.lease?.run_id !== runId || task.orchestration.lease.worker_id !== this.workerId
      || Date.parse(task.orchestration.lease.expires_at) <= this.now().getTime() || task.orchestration.cancel_requested_at || !this.canClaim(task)) throw new ContextContractError("Workflow controller cannot claim this attempt");
    const { document: snapshot, workflow, stage } = this.facts(task), at = this.now().toISOString();
    if (stage.execution_id && !snapshot.accounting[stage.execution_id]?.usage_complete) throw new ContextContractError("Previous attempt usage is unknown; execution is blocked");
    mutateWorkflowDocument((document) => {
      if (!isDeepStrictEqual(document, snapshot) || !isDeepStrictEqual(readTask(taskId), task)) throw new ContextContractError("Authority changed before run accounting");
      const owner = document.workflows[workflow.id]!, current = document.stages[stage.id]!;
      if (document.accounting[runId]) throw new ContextContractError("Run was already charged; no execution replay is allowed");
      owner.counters.attempts++;
      current.status = "running"; current.execution_id = runId; current.updated_at = at;
      document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: owner.id, stage_id: current.id, task_id: taskId,
        execution_id: runId, attempt: task.orchestration!.attempts, attempt_charged: true, active_runtime_ms: 0, observed_tokens: 0, usage_complete: false, captured_at: at };
      change(document, owner, at, "stage-started", "Exact owned attempt durably charged before execution.");
    });
    const proof = Object.freeze({}); executions.set(proof, { owner: this, taskId, runId }); return proof;
  }
  private live(proof: object) {
    const entry = executions.get(proof);
    if (!entry || entry.owner !== this) throw new ContextContractError("Unrecognized workflow execution identity");
    const task = readTask(entry.taskId);
    if (!task || task.lifecycle !== "running" || task.orchestration?.lease?.run_id !== entry.runId || task.orchestration.lease.worker_id !== this.workerId
      || Date.parse(task.orchestration.lease.expires_at) <= this.now().getTime()) throw new ContextContractError("Workflow execution lease was lost");
    return { ...entry, task, ...this.facts(task) };
  }
  prepare(proof: object) {
    const live = this.live(proof);
    return prepareWorkflowStage(live.taskId, live.runId, this.repoRoot, { context: this.context, now: () => this.now().getTime() });
  }
  observe(proof: object, tokens: number, elapsed: number, complete = false): boolean {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(elapsed) || elapsed < 0) throw new ContextContractError("Invalid bounded workflow usage observation");
    const live = this.live(proof), at = this.now().toISOString();
    let stopped = false;
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[live.workflow.id]!, stage = document.stages[live.stage.id]!, charge = document.accounting[live.runId];
      if (terminal(owner) || stage.execution_id !== live.runId || !charge || !isDeepStrictEqual(readTask(live.taskId), live.task)) throw new ContextContractError("Workflow usage lost its owner");
      if (charge.usage_complete) return;
      const nextTokens = Math.max(charge.observed_tokens, tokens), nextElapsed = Math.max(charge.active_runtime_ms, elapsed);
      if (nextTokens === charge.observed_tokens && nextElapsed === charge.active_runtime_ms && !complete) return;
      owner.counters.total_tokens += nextTokens - charge.observed_tokens; owner.counters.runtime_ms += nextElapsed - charge.active_runtime_ms;
      charge.observed_tokens = nextTokens; charge.active_runtime_ms = nextElapsed; charge.usage_complete = complete; charge.captured_at = at;
      stopped = owner.counters.total_tokens >= owner.budget.max_total_tokens || owner.counters.runtime_ms >= owner.budget.max_runtime_ms;
      const lineage = owner.lineage_id ? document.lineages[owner.lineage_id] : null;
      const correction = lineage?.consumed_stage_id ? document.stages[lineage.consumed_stage_id] : null;
      const cap = document.grants[owner.current_grant_id]!.correction.budget;
      if (correction && cap && stage.ordinal >= correction.ordinal) {
        const branch = Object.values(document.accounting).filter((entry) => entry.workflow_id === owner.id && document.stages[entry.stage_id]!.ordinal >= correction.ordinal);
        stopped ||= branch.reduce((sum, entry) => sum + entry.observed_tokens, 0) >= cap.max_total_tokens
          || branch.reduce((sum, entry) => sum + entry.active_runtime_ms, 0) >= cap.max_runtime_ms;
      }
      if (stopped) { owner.status = "needs-decision"; owner.blocked_reason = "Aggregate or correction token or active-runtime budget is exhausted."; owner.next_action = "Inspect retained accounting; no successor is admitted."; }
      change(document, owner, at, stopped ? "budget-stopped" : "reconciled", "Monotonic usage retained for the exact owned run.");
    });
    return stopped;
  }
  captureOutput(proof: object, prepared: ReturnType<typeof prepareWorkflowStage>, value: unknown, logsPath: string) {
    const live = this.live(proof), normalized = validateWorkflowStageOutput(prepared, value, logsPath, this.repoRoot, { context: this.context, now: () => this.now().getTime() });
    if (normalized.output) {
      const snapshot = readWorkflowDocument(), at = this.now().toISOString();
      mutateWorkflowDocument((document) => {
        if (!isDeepStrictEqual(document, snapshot) || !isDeepStrictEqual(readTask(live.taskId), live.task)) throw new ContextContractError("Role output lost its current owner");
        const stage = document.stages[live.stage.id]!;
        stage.output = normalized.output; stage.output_fingerprint = normalized.fingerprint; stage.updated_at = at;
        change(document, document.workflows[live.workflow.id]!, at, "reconciled", "Bounded role output captured; no handoff or review receipt is sealed.");
      });
    }
    return normalized.result;
  }
  settle(proof: object, tokens: number, elapsed: number, complete: boolean): void {
    this.observe(proof, tokens, elapsed, complete);
    if (!complete) this.block(this.live(proof).workflow.id, "Interrupted or unreported usage is unknown; human recovery is required.", true);
  }
  release(proof: object): void { executions.delete(proof); }
  block(id: string, reason: string, unknown = false): void {
    const at = this.now().toISOString();
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[id]; if (!owner || terminal(owner)) return;
      if (owner.status === "needs-decision" && owner.blocked_reason === reason && (!unknown || !owner.counters.accounting_complete)) return;
      owner.status = "needs-decision"; owner.recovery_state = "awaiting-human"; owner.blocked_reason = reason;
      owner.next_action = "Inspect retained evidence and current authority; stop or explicitly recover only provable admission gaps.";
      if (unknown) owner.counters.accounting_complete = false;
      change(document, owner, at, "recovery-required", reason);
    });
  }
  recoverExpired(task: TaskRecord): boolean {
    const admission = task.envelope.context_admission;
    if (admission?.schema_version !== 2 || task.lifecycle !== "running" || (task.orchestration?.lease && Date.parse(task.orchestration.lease.expires_at) > this.now().getTime())) return false;
    const runId = task.orchestration?.lease?.run_id, at = this.now().toISOString();
    let recovered = false;
    // Never rerun a write or treat interrupted unknown usage as zero.
    updateTask(task.envelope.id, (current) => {
      if (!isDeepStrictEqual(current, task)) return false;
      current.lifecycle = "finished"; current.outcome = "needs-review"; current.finished_at = at; current.updated_at = at;
      current.orchestration!.lease = null; current.orchestration!.retry_at = null;
      current.orchestration!.last_failure = { kind: "terminal", message: "Workflow lease expired; retained facts require human recovery", at, run_id: runId ?? "unknown-run" };
      current.result = failureResult(current.envelope, "Workflow lease expired; no replacement attempt was started", current.logs_path ?? ""); current.result.status = "needs-review";
      recovered = true;
    });
    if (!recovered) return false;
    this.block(admission.workflow_id, "Workflow lease expired; no automatic replacement attempt is authorized.", !runId || !readWorkflowDocument().accounting[runId]?.usage_complete);
    return true;
  }
  private grantCurrent(owner: GovernedWorkflow, stage?: WorkflowDocument["stages"][string]): boolean {
    const grant = readWorkflowDocument().grants[owner.current_grant_id]!, issue = readIssueDocument().issues[owner.issue_id];
    if (!issue || issue.scope_revision !== grant.scope_revision || !isDeepStrictEqual(issue.authorized_scope, grant.authorized_scope)) return false;
    const preview = this.context.preview({ template_id: grant.template_id, template_version: 1, project_id: grant.project_id, issue_id: grant.issue_id, expected_revision: issue.revision,
      selected_agents: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.agent_id])),
      client_context_categories: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.client_context_categories])), budget: grant.budget, correction_enabled: grant.correction.enabled,
      ...(grant.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id } : {}), ...(grant.template_id === "quality-review" ? { candidate_id: owner.candidate?.candidate_id } : {}) });
    const writer = !!stage && ["implementation", "correction"].includes(stage.kind) && stage.sandbox === "workspace-write";
    const compatibleIssueState = writer ? ["working", "checking"].includes(issue.status)
      : ["working", "checking", "ready-for-review"].includes(issue.status) && (!!owner.candidate || issue.status !== "ready-for-review");
    return preview.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner"
      || compatibleIssueState && reason === "Write workflow requires the current exact-scope issue authorization")
      && preview.scope_fingerprint === hash(grant.authorized_scope)
      && isDeepStrictEqual(preview.source_fingerprints, grant.source_fingerprints) && preview.policy_fingerprint === grant.policy_fingerprint
      && preview.testing_policy_fingerprint === grant.testing_policy_fingerprint;
  }
  private requestReviewDecision(id: string, kind: "risk-acknowledgement" | "candidate-acceptance", reviewFingerprint: string, receiptIds: string[]): void {
    const snapshot = readWorkflowDocument(), owner = snapshot.workflows[id], issueFacts = readIssueDocument();
    if (!owner || owner.status !== "running" || owner.stop_requested_at || owner.pending_decision_id || !owner.candidate) throw new ContextContractError("Candidate decision is no longer available");
    const issue = issueFacts.issues[owner.issue_id];
    const reviews = applicableWorkflowReviews(snapshot, owner, issueFacts, readTask);
    const ids = reviews.receipts.map((entry) => entry.id);
    if (!issue || reviews.fingerprint !== reviewFingerprint || !isDeepStrictEqual(ids, receiptIds)
      || kind === "risk-acknowledgement" && (!reviews.risks || hasCurrentRiskAcknowledgement(snapshot, owner, reviews.fingerprint, ids))
      || kind === "candidate-acceptance" && reviews.risks && !hasCurrentRiskAcknowledgement(snapshot, owner, reviews.fingerprint, ids)) {
      throw new ContextContractError("Current receipt or risk decision binding changed");
    }
    const at = this.now().toISOString(), decisionId = `WD-${randomUUID()}`;
    mutateWorkflowDocument((document) => {
      if (!isDeepStrictEqual(document, snapshot) || !isDeepStrictEqual(readIssueDocument(), issueFacts)) throw new ContextContractError("Candidate decision facts changed before persistence");
      const current = document.workflows[id]!;
      document.decisions[decisionId] = { schema_version: 1, id: decisionId, workflow_id: id, kind, status: "pending",
        expected_workflow_revision: current.revision + 1, expected_issue_revision: issue.revision, resource_fingerprint: reviews.fingerprint,
        candidate_id: owner.candidate!.candidate_id, review_receipt_ids: ids,
        summary: kind === "risk-acknowledgement" ? "Acknowledge only these exact advisory candidate risks; required checks remain mandatory."
          : "Accept this exact verified candidate after confirming every acceptance criterion.",
        approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
      current.status = "waiting-human"; current.pending_decision_id = decisionId;
      current.next_action = kind === "risk-acknowledgement" ? "Review and acknowledge these bound advisory risks before candidate acceptance."
        : "Review the exact candidate and confirm every current acceptance criterion.";
      change(document, current, at, "decision-requested", kind === "risk-acknowledgement" ? "Candidate-bound advisory risk acknowledgement requested." : "Current candidate acceptance requested after all required reviews.");
    });
  }
  private finishCandidateReview(id: string): void {
    const snapshot = readWorkflowDocument(), owner = snapshot.workflows[id], issues = createIssueService(this.repoRoot);
    if (!owner || owner.status !== "running" || !owner.candidate) throw new ContextContractError("Candidate review gate is not current");
    const facts = issues.inspectWorkflowCandidate(id), reviews = applicableWorkflowReviews(facts.workflows, facts.workflow, facts.document, readTask);
    const ready = facts.issue.status === "checking" ? issues.markWorkflowReady(id) : facts.issue;
    if (ready.status !== "ready-for-review" || !isDeepStrictEqual(readWorkflowDocument(), snapshot)) throw new ContextContractError("Required reviews or current candidate could not enter the human acceptance gate");
    const ids = reviews.receipts.map((entry) => entry.id);
    if (reviews.risks && !hasCurrentRiskAcknowledgement(snapshot, owner, reviews.fingerprint, ids)) {
      this.requestReviewDecision(id, "risk-acknowledgement", reviews.fingerprint, ids);
      return;
    }
    this.requestReviewDecision(id, "candidate-acceptance", reviews.fingerprint, ids);
  }
  private advanceCompletedStage(id: string): void {
    const document = readWorkflowDocument(), owner = document.workflows[id], stage = owner?.current_stage_id ? document.stages[owner.current_stage_id] : null;
    if (!owner || owner.status !== "running" || !stage || stage.status !== "completed" || !stage.task_id) return;
    const task = readTask(stage.task_id), issues = readIssueDocument(), issue = issues.issues[owner.issue_id], admission = task?.envelope.context_admission;
    assertTerminalWorkflowTask(document, stage, task);
    if (!issue || admission?.schema_version !== 2) throw new ContextContractError("Completed stage lost its issue admission");
    assertOwnedWorkflowIssueProgress(document, owner, issues, admission.issue_revision);
    const evidenceIssues = createIssueService(this.repoRoot, { now: () => this.now() });
    if (stage.kind === "implementation" || stage.kind === "correction") evidenceIssues.inspectWorkflowCandidate(id);
    const grant = document.grants[owner.current_grant_id]!, plan = resolveWorkflowTemplate({ template_id: owner.template_id, template_version: 1, work_scale: owner.work_scale,
      correction_enabled: grant.correction.enabled, review_policy: owner.review_policy!, ...(owner.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id as "planner" | "portfolio-analyst" } : {}) });
    const next = stage.ordinal < plan.stages.length ? plan.stages[stage.ordinal]
      : stage.ordinal > plan.stages.length ? plan.correction_stages[stage.ordinal - plan.stages.length] : undefined;
    if (stage.kind === "review" || stage.kind === "qa") {
      evidenceIssues.recordWorkflowReview(id, stage.id);
      if (!workflowReviewAllowsContinuation(stage.output)) {
        if (stage.ordinal <= plan.stages.length && hasConcreteCorrectionFinding(stage.output)) {
          if (!next) { this.service.admitCorrection(id); return; }
          if (next.kind !== "qa") throw new ContextContractError("Correction findings cannot skip a required review");
        } else {
          this.block(id, stage.ordinal > plan.stages.length
            ? "The single correction did not clear required review findings; its allowance remains consumed and a human must decide."
            : "Sealed review has a blocking, incomplete, inconclusive or requested human finding.");
          return;
        }
      }
    }
    if (stage.kind === "planning") {
      if (stage.output?.kind !== "plan" || stage.output.status !== "completed" || stage.output.scope_change_required) {
        this.block(id, "Planner output is incomplete or requests an unapproved scope change; human direction is required.");
        return;
      }
      if (owner.approved_plan?.stage_id === stage.id && owner.approved_plan.output_fingerprint === stage.output_fingerprint) {
        if (next) { this.service.admitSuccessor(id); return; }
        throw new ContextContractError("Approved Planner stage has no finite ordinary successor");
      }
      if (owner.approved_plan) throw new ContextContractError("Planner approval is bound to a different stage or output");
      const at = this.now().toISOString(), decisionId = `WD-${randomUUID()}`;
      mutateWorkflowDocument((current) => {
        if (!isDeepStrictEqual(current, document) || !isDeepStrictEqual(readIssueDocument(), issues)) throw new ContextContractError("Planner facts changed during human-gate creation");
        const workflow = current.workflows[id]!;
        workflow.status = "waiting-human"; workflow.pending_decision_id = decisionId;
        workflow.next_action = "Approve or reject this exact Planner proposal before any Engineer stage is admitted.";
        current.decisions[decisionId] = { schema_version: 1, id: decisionId, workflow_id: id, kind: "plan-approval", status: "pending",
          expected_workflow_revision: workflow.revision + 1, expected_issue_revision: issue.revision, resource_fingerprint: stage.output_fingerprint!, candidate_id: null, review_receipt_ids: [],
          summary: "Inspect and explicitly approve this exact bounded plan; approval cannot change the authorized issue scope.", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
        change(current, workflow, at, "decision-requested", "Exact Planner proposal awaits human approval.");
      });
      return;
    }
    if (next) { this.service.admitSuccessor(id); return; }
    if (stage.kind === "review" || stage.kind === "qa") {
      // QA approval does not erase a preceding Reviewer's correction request.
      if (issue.status === "checking" && stage.ordinal === plan.stages.length && ["implementation", "trivial-change"].includes(owner.template_id)
        && this.service.admitCorrection(id).handled) return;
      this.finishCandidateReview(id); return;
    }
    if (stage.kind === "analysis" || stage.kind === "operations") {
      const previewCurrent = this.grantCurrent(owner);
      if (!previewCurrent || !stage.output || stage.output.status !== "completed" || hash(stage.output) !== stage.output_fingerprint) throw new ContextContractError("Current bounded proposal or source policy changed");
      const at = this.now().toISOString(), decisionId = `WD-${randomUUID()}`;
      mutateWorkflowDocument((current) => {
        if (!isDeepStrictEqual(current, document) || !isDeepStrictEqual(readIssueDocument(), issues)) throw new ContextContractError("Proposal facts changed during human-gate creation");
        const workflow = current.workflows[id]!;
        workflow.status = "waiting-human"; workflow.pending_decision_id = decisionId;
        workflow.next_action = "Acknowledge this exact proposal; it does not authorize or alter the linked issue.";
        current.decisions[decisionId] = { schema_version: 1, id: decisionId, workflow_id: id, kind: "proposal-acknowledgement", status: "pending",
          expected_workflow_revision: workflow.revision + 1, expected_issue_revision: issue.revision, resource_fingerprint: stage.output_fingerprint!, candidate_id: null, review_receipt_ids: [],
          summary: "Inspect this exact advisory proposal; no issue or provider action is included.", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
        change(current, workflow, at, "decision-requested", "Exact advisory proposal awaits explicit human acknowledgement.");
      });
      return;
    }
    throw new ContextContractError("Completed workflow stage has no approved successor or final human gate");
  }
  reconcile(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const initial of Object.values(readWorkflowDocument().workflows)) {
        if (terminal(initial)) continue;
        const snapshot = readWorkflowDocument(), owner = snapshot.workflows[initial.id]!, stage = owner.current_stage_id ? snapshot.stages[owner.current_stage_id] : null;
        if (!stage?.task_id) continue;
        try {
          const task = readTask(stage.task_id);
          if (owner.stop_requested_at) {
            if (task && task.lifecycle !== "finished") { this.control?.cancel(task.envelope.id); continue; }
            const at = this.now().toISOString();
            mutateWorkflowDocument((document) => {
              if (!isDeepStrictEqual(document, snapshot)) return;
              const current = document.workflows[owner.id]!;
              for (const entry of Object.values(document.stages).filter((entry) => entry.workflow_id === owner.id)) {
                if (["pending", "reserved", "queued", "running"].includes(entry.status)) { entry.status = "cancelled"; entry.updated_at = at; }
              }
              if (Object.values(document.accounting).some((entry) => entry.workflow_id === owner.id && !entry.usage_complete)) current.counters.accounting_complete = false;
              current.status = "cancelled"; current.completed_at = at; current.current_stage_id = null;
              current.next_action = "Stopped workflow retained; issue state and candidate trees were not changed.";
              change(document, current, at, "cancelled", "Durable stop reconciled after its task stopped; evidence and charges retained.");
            }); continue;
          }
          if (owner.status === "waiting-human") {
            const decision = owner.pending_decision_id ? snapshot.decisions[owner.pending_decision_id] : null;
            if (decision?.kind === "candidate-acceptance" && decision.status === "pending") this.service.reconcileAcceptance(owner.id);
            continue;
          }
          if (owner.status !== "running") continue;
          if (stage.status === "completed") { this.advanceCompletedStage(owner.id); continue; }
          const intent = Object.values(snapshot.admission_intents).find((entry) => entry.stage_id === stage.id);
          if (intent?.status === "reserved") { this.service.reconcileAdmission(owner.id); continue; }
          if (!task) { this.block(owner.id, "Reserved task is unavailable; its identity cannot be replaced."); continue; }
          if (task.lifecycle !== "finished") continue;
          const charge = stage.execution_id ? snapshot.accounting[stage.execution_id] : null, admission = task.envelope.context_admission;
          if (admission?.schema_version !== 2 || !charge?.usage_complete || !owner.counters.accounting_complete) { this.block(owner.id, "Terminal attempt accounting is unknown; no successor can start.", true); continue; }
          const writer = stage.kind === "implementation" || stage.kind === "correction";
          const outputValid = writer ? stage.output === null && stage.output_fingerprint === null
            : !!stage.output && stage.output.status === "completed" && hash(stage.output) === stage.output_fingerprint;
          if (task.outcome !== "completed" || !outputValid
            || task.orchestration?.last_failure || task.orchestration?.cancel_requested_at || task.orchestration?.lease || charge.attempt !== task.orchestration?.attempts) {
            this.block(owner.id, "Role completion is incomplete or invalid; current human direction is required."); continue;
          }
          const issueFacts = readIssueDocument();
          const issue = issueFacts.issues[owner.issue_id];
          if (!issue || !writer && issue.revision !== admission.issue_revision || !this.grantCurrent(owner, stage)) {
            this.block(owner.id, "Scope, sources or policy changed after the owned attempt; new human authority is required."); continue;
          }
          if (writer) {
            const candidate = createIssueService(this.repoRoot, { now: () => this.now() }).captureWorkflowCandidate(owner.id, stage.id);
            const at = this.now().toISOString();
            mutateWorkflowDocument((document) => {
              if (!isDeepStrictEqual(document, snapshot) || !isDeepStrictEqual(readTask(task.envelope.id), task) || !isDeepStrictEqual(readIssueDocument(), issueFacts)) throw new ContextContractError("Writer candidate facts changed before sealing");
              const current = document.workflows[owner.id]!, completed = document.stages[stage.id]!;
              const prior = current.candidate;
              if (stage.kind === "correction") {
                const lineage = current.lineage_id ? document.lineages[current.lineage_id] : null;
                if (!prior || !isDeepStrictEqual(stage.candidate, prior) || candidate.base_revision !== prior.candidate_revision
                  || candidate.candidate_id === prior.candidate_id || lineage?.corrections_consumed !== 1 || lineage.consumed_stage_id !== stage.id) {
                  throw new ContextContractError("Correction replacement differs from its consumed lineage and exact prior candidate base");
                }
              } else if (prior) throw new ContextContractError("Workflow already has a candidate; replacement is outside this stage");
              completed.candidate = structuredClone(candidate); completed.output = null; completed.output_fingerprint = hash(candidate); completed.status = "completed"; completed.updated_at = at;
              current.candidate = structuredClone(candidate);
              const lineage = current.lineage_id ? document.lineages[current.lineage_id] : null;
              if (!lineage || lineage.issue_id !== issue.id || lineage.scope_revision !== issue.scope_revision) throw new ContextContractError("Exact writer lineage is unavailable");
              if (!lineage.candidate_ids.includes(candidate.candidate_id)) lineage.candidate_ids.push(candidate.candidate_id);
              change(document, current, at, "stage-finished", "Exact managed candidate and fresh passing captured verification sealed for the current writer stage.");
            });
            this.advanceCompletedStage(owner.id); continue;
          }
          const at = this.now().toISOString();
          mutateWorkflowDocument((document) => {
            if (!isDeepStrictEqual(document, snapshot) || !isDeepStrictEqual(readTask(task.envelope.id), task) || !isDeepStrictEqual(readIssueDocument(), issueFacts)) throw new ContextContractError("Terminal facts changed during reconciliation");
            const current = document.workflows[owner.id]!, completed = document.stages[stage.id]!;
            completed.status = "completed"; completed.updated_at = at;
            if (stage.kind === "review" || stage.kind === "qa") {
              const receipt = sealWorkflowReviewReceipt(document, completed, issueFacts, `WR-${randomUUID()}`, at);
              document.review_receipts[receipt.id] = receipt;
              change(document, current, at, "review-sealed", "Exact candidate, context and role output bound into an immutable review receipt.");
            } else {
              change(document, current, at, "stage-finished", "Terminal read-only role output and complete accounting reconciled once.");
            }
          });
          this.advanceCompletedStage(owner.id);
        } catch { this.block(owner.id, "Workflow facts or sources are unavailable; reconciliation cannot infer authority."); }
      }
    } finally { this.reconciling = false; }
  }
}
