import { createHash, randomUUID } from "node:crypto";
import { assertTestingEvidenceBinding, testingEvidenceStatus } from "../../../lib/context/testing-evidence";
import type { IssueTransitionEnvelope } from "../../../lib/organization/issue-lifecycle";
import { checkIssueTransition } from "../../../lib/organization/issue-lifecycle";
import type { IssueCreateInput, IssueDocument, IssueEvidenceReference, IssueLineage, ReviewCandidate, WorkIssue } from "../../../lib/issues/types";
import { readIssueDocument, mutateIssueDocument } from "../../../lib/state/issues";
import { readOrganizationSnapshot } from "../../../lib/state/organization";
import { readTaskEvents } from "../../../lib/state/events";
import { listTasks, readTask } from "../../../lib/state/store";
import type { TaskRecord } from "../../../lib/state/types";
import { listWorkSessions } from "../../../lib/state/work-sessions";
import { PolicyService } from "../../../lib/policy/service";
import { redactText } from "../../../lib/security/redaction";
import { createTask } from "./dispatch";
import type { ContextService } from "./context-service";
import { readWorkflowDocument } from "../../../lib/state/workflows";
import type { WorkflowCandidateBinding, WorkflowDocument } from "../../../lib/workflows/types";
import { assertWorkflowDocument } from "../../../lib/workflows/validation";
import { isDeepStrictEqual } from "node:util";
import { applicableWorkflowReviews, assertOwnedWorkflowIssueProgress, assertTerminalWorkflowTask, bindVerifiedWorkflowCandidate, hasCurrentRiskAcknowledgement, workflowEvidenceHash } from "../../../lib/workflows/review-evidence";
import { readContained } from "../../../lib/harness/source";
import { inspectCandidateTree } from "../../../runner/worktree";
import { createWorkflowContextService } from "./workflow-context-service";
import { validateTaskRecord } from "../../../lib/state/validation";

export class IssueServiceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export class IssueScopeViolationError extends Error {
  constructor(readonly issueId: string, readonly taskId: string, readonly paths: string[]) {
    super(`task produced changes outside authorized issue scope: ${paths.slice(0, 20).join(", ")}`);
  }
}

export interface IssueServiceOptions {
  context?: ContextService;
  source?: "dashboard" | "cli";
  createTask?: typeof createTask;
  projectIds?: () => string[];
  now?: () => Date;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new IssueServiceError(`${label} is required and must be at most ${max} characters`);
  const normalized = value.trim();
  if (redactText(normalized) !== normalized) throw new IssueServiceError(`${label} appears to contain a credential; remove it before saving local issue state`);
  return normalized;
}

function labels(value: unknown, label: string, maxItems = 30, maxLength = 1000): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) {
    throw new IssueServiceError(`${label} must contain 1-${maxItems} non-empty items`);
  }
  const result = value.map((item) => text(item, label, maxLength));
  if (new Set(result).size !== result.length) throw new IssueServiceError(`${label} must not contain duplicates`);
  return result;
}

function optionalLabels(value: unknown, label: string, maxItems = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 300)) throw new IssueServiceError(`${label} is invalid`);
  const result = value.map((item) => text(item, label, 300));
  if (new Set(result).size !== result.length) throw new IssueServiceError(`${label} must not contain duplicates`);
  return result;
}

function safePattern(pattern: string): boolean {
  return pattern.length <= 300 && !pattern.includes("\\") && !pattern.startsWith("/") && !/^[A-Za-z]:/.test(pattern)
    && !pattern.split("/").some((part) => part === ".." || part === ".") && !/[\u0000-\u001f]/.test(pattern);
}

function matchesPattern(path: string, pattern: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") { i += 1; source += "(?:.*/)?"; }
      else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(path);
}

export function pathsOutsideScope(paths: string[], scope: WorkIssue["authorized_scope"]): string[] {
  return paths.filter((path) => {
    if (!path || redactText(path) !== path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".")) return true;
    if (scope.excluded_path_patterns.some((pattern) => matchesPattern(path, pattern))) return true;
    return !scope.allowed_path_patterns.some((pattern) => matchesPattern(path, pattern));
  });
}

function scopeFromUnknown(value: unknown): WorkIssue["authorized_scope"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IssueServiceError("authorized scope is required");
  const item = value as Record<string, unknown>;
  const scope = {
    expected_outcome: text(item.expected_outcome, "scope expected outcome", 4000),
    acceptance_criteria: labels(item.acceptance_criteria, "scope acceptance criteria"),
    allowed_path_patterns: labels(item.allowed_path_patterns, "allowed path patterns", 100, 300),
    excluded_path_patterns: optionalLabels(item.excluded_path_patterns, "excluded path patterns", 100),
    allowed_change_categories: labels(item.allowed_change_categories, "allowed change categories", 30, 100),
    explicit_exclusions: optionalLabels(item.explicit_exclusions, "explicit exclusions", 100),
  };
  if (scope.allowed_path_patterns.some((pattern) => !safePattern(pattern)) || scope.excluded_path_patterns.some((pattern) => !safePattern(pattern))) {
    throw new IssueServiceError("scope paths must be safe repository-relative glob patterns");
  }
  return scope;
}

function externalReferences(value: unknown): WorkIssue["external_references"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new IssueServiceError("external_references is invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new IssueServiceError("external reference is invalid");
    const entry = item as Record<string, unknown>;
    const provider = text(entry.provider, "external provider", 50);
    const url = text(entry.url, "external reference URL", 2000);
    const reference = text(entry.reference, "external reference ID", 200);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new IssueServiceError("external reference URL must be an http(s) URL"); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new IssueServiceError("external reference URL must be an http(s) URL");
    return { provider, url, reference };
  });
}

function safeEvidenceText(value: string, max = 2000): string {
  return redactText(value).slice(0, max);
}

function deriveScale(input: IssueCreateInput, domains: string[], migration: boolean, security: boolean, criticality: WorkIssue["criticality"], categories: string[]): { scale: WorkIssue["work_scale"]; rationale: string[] } {
  const rationale: string[] = [];
  if (criticality === "high") rationale.push("high criticality");
  if (migration) rationale.push("state or data migration");
  if (security) rationale.push("security-sensitive change");
  if (domains.length > 2) rationale.push("more than two affected domains");
  if (categories.some((category) => /schema|auth|security|policy|migration/i.test(category))) rationale.push("sensitive change category");
  if (rationale.length) return { scale: "substantial", rationale };
  if (criticality === "medium" || domains.length > 1 || categories.length > 1 || input.acceptance_criteria.length > 2) {
    rationale.push("multiple bounded change or verification factors");
    return { scale: "bounded", rationale };
  }
  rationale.push("low criticality, one domain/category, and narrow acceptance criteria");
  return { scale: "trivial", rationale };
}

function appendEvent(document: IssueDocument, issue: WorkIssue, type: string, payload: Record<string, unknown>, at: string): void {
  if (document.events.length >= 20_000) throw new IssueServiceError("issue audit history reached its bounded capacity", 409);
  document.events.push({ id: randomUUID(), issue_id: issue.id, type, at, scope_revision: issue.scope_revision, payload });
  issue.updated_at = at;
  issue.revision += 1;
}

function transition(document: IssueDocument, issue: WorkIssue, to: WorkIssue["status"], expectedRevision: number, type: string, payload: Record<string, unknown>, at: string): void {
  const envelope: IssueTransitionEnvelope = { event_id: randomUUID(), from: issue.status, to, expected_revision: expectedRevision };
  const check = checkIssueTransition({ status: issue.status, revision: issue.revision, seen_event_ids: new Set(document.events.map((event) => event.id)) }, envelope);
  if (!check.accepted) throw new IssueServiceError(`issue transition rejected: ${check.reason}`, 409);
  issue.status = to;
  appendEvent(document, issue, type, payload, at);
}

function requireIssue(document: IssueDocument, id: string): WorkIssue {
  const issue = document.issues[id];
  if (!issue) throw new IssueServiceError("local issue not found", 404);
  return issue;
}

function addEvidence(document: IssueDocument, issue: WorkIssue, data: Omit<IssueEvidenceReference, "schema_version" | "id" | "issue_id" | "created_at">, at: string): IssueEvidenceReference {
  const evidence: IssueEvidenceReference = { schema_version: 1, id: `E-${randomUUID()}`, issue_id: issue.id, created_at: at, ...data };
  document.evidence[evidence.id] = evidence;
  issue.evidence_ids.push(evidence.id);
  return evidence;
}

function taskIssueId(task: ReturnType<typeof listTasks>[number]): string | null {
  if (task.envelope.context_admission?.schema_version === 2) return task.envelope.context_admission.issue_id;
  const id = task.envelope.metadata.issue_id;
  return typeof id === "string" ? id : null;
}

// State-only projection shared by prospective context preparation and the real
// issue write. V2 linkage never uses legacy implementation metadata. Only a
// writer takes the existing authorized -> working edge; advisory linkage does
// not authorize or complete an issue. No workflow lock is acquired here.
export function projectWorkflowIssueLink(document: IssueDocument, workflows: WorkflowDocument, stageId: string, taskId: string, expectedRevision: number, at: string): WorkIssue {
  const stage = workflows.stages[stageId], workflow = stage && workflows.workflows[stage.workflow_id];
  const grant = workflow && workflows.grants[workflow.current_grant_id];
  if (!stage || !workflow || !grant || workflow.status !== "running" || workflow.stop_requested_at || workflow.pending_decision_id || workflow.recovery_state !== "none"
    || workflow.current_stage_id !== stage.id || stage.grant_id !== grant.id || stage.authority_revision !== grant.authority_revision
    || !["pending", "reserved"].includes(stage.status) || stage.task_id !== null && stage.task_id !== taskId) throw new IssueServiceError("workflow does not own this admission", 409);
  const issue = requireIssue(document, workflow.issue_id);
  if (issue.revision !== expectedRevision || issue.project_id !== workflow.project_id || issue.scope_revision !== grant.scope_revision
    || !isDeepStrictEqual(issue.authorized_scope, grant.authorized_scope) || issue.scope_change_proposal
    || ["done", "cancelled", "blocked", "needs-decision"].includes(issue.status) || issue.task_ids.includes(taskId)
    || issue.task_ids.length >= 100 || issue.blocked_by_issue_ids.some((id) => document.issues[id]?.status !== "done")) throw new IssueServiceError("issue changed before workflow linkage", 409);
  const correction = stage.kind === "correction";
  const currentCandidate = stage.candidate;
  if (stage.sandbox === "workspace-write" && (issue.assigned_role_id !== stage.agent_id
    || (correction ? issue.status !== "checking" : issue.status !== "authorized"))) throw new IssueServiceError("workflow writer requires the existing exact-scope authorization", 409);
  if (correction) {
    const lineage = workflow.lineage_id ? workflows.lineages[workflow.lineage_id] : null;
    const issueCandidate = currentCandidate ? document.candidates[currentCandidate.candidate_id] : null;
    if (!grant.correction.enabled || !currentCandidate || !isDeepStrictEqual(currentCandidate, workflow.candidate) || !lineage
      || lineage.corrections_consumed !== 1 || lineage.consumed_stage_id !== stage.id || issue.candidate_ids.at(-1) !== currentCandidate.candidate_id
      || !issueCandidate || issueCandidate.invalidated_at !== null || issueCandidate.diff_fingerprint !== currentCandidate.diff_fingerprint || !stage.predecessor_stage_id) {
      throw new IssueServiceError("workflow correction candidate or consumed lineage is not current", 409);
    }
  }
  const payload = { workflow_id: workflow.id, stage_id: stage.id, task_id: taskId, role_id: stage.role_id, agent_id: stage.agent_id, scope_revision: issue.scope_revision };
  if (correction) {
    const predecessor = workflows.stages[stage.predecessor_stage_id!]!;
    const requests = workflow.stage_ids.map((id) => workflows.stages[id]!).filter((entry) => entry.ordinal <= predecessor.ordinal
      && entry.candidate?.candidate_id === currentCandidate!.candidate_id && (entry.output?.kind === "review" || entry.output?.kind === "qa") && entry.output.verdict === "correction-required");
    const rationale = requests.flatMap((entry) => entry.output?.kind === "review" || entry.output?.kind === "qa"
      ? entry.output.findings.filter((finding) => finding.severity === "blocking").map((finding) => `${finding.path}: ${finding.summary}`) : []).join("; ").slice(0, 900);
    if (!rationale) throw new IssueServiceError("workflow correction has no concrete sealed review finding", 409);
    issue.task_ids.push(taskId);
    transition(document, issue, "working", expectedRevision, "bounded-correction-authorized", { ...payload, candidate_id: currentCandidate!.candidate_id,
      diff_fingerprint: currentCandidate!.diff_fingerprint, rationale }, at);
  } else {
    issue.task_ids.push(taskId);
    if (stage.sandbox === "workspace-write") transition(document, issue, "working", expectedRevision, "execution-admitted", payload, at);
    else appendEvent(document, issue, "workflow-role-task-linked", payload, at);
  }
  addEvidence(document, issue, { task_id: taskId, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "task", label: "Workflow role task reserved", reference: `/api/tasks/${taskId}`, status: "informational" }, at);
  return issue;
}

function evidenceGaps(issue: WorkIssue, evidence: IssueEvidenceReference[], candidates: ReviewCandidate[]): string[] {
  const currentCandidate = candidates.find((candidate) => candidate.invalidated_at === null && candidate.scope_revision === issue.scope_revision);
  const gaps: string[] = [];
  if (!currentCandidate) gaps.push("No current review candidate is bound to the authorized scope revision.");
  if (!currentCandidate || !evidence.some((entry) => entry.candidate_id === currentCandidate.id && entry.kind === "verification" && entry.status === "passed")) {
    gaps.push("Passing verification evidence is missing for the current candidate.");
  }
  if (!evidence.some((entry) => entry.kind === "review" && entry.status === "passed" && entry.candidate_id === currentCandidate?.id)) {
    gaps.push("Human acceptance evidence is missing for the current candidate.");
  }
  return gaps;
}

export function createIssueService(repoRoot: string = process.cwd(), options: IssueServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const makeTask = options.createTask ?? createTask;
  const projectIds = options.projectIds ?? (() => new PolicyService(repoRoot).listProjects().map((project) => project.id));

  function workflowWriter(task: TaskRecord | null, issue: WorkIssue, runId: string): boolean {
    const admission = task?.envelope.context_admission;
    if (admission?.schema_version !== 2) return false;
    const document = readWorkflowDocument(), owner = document.workflows[admission.workflow_id], stage = document.stages[admission.stage_id];
    const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === stage?.id);
    return !!task && !!owner && !!stage && owner.status === "running" && !owner.stop_requested_at && owner.recovery_state === "none" && !owner.pending_decision_id
      && validateTaskRecord(task) && task.lifecycle === "running" && task.outcome === null && !task.orchestration?.cancel_requested_at
      && task.orchestration?.lease?.run_id === runId && Date.parse(task.orchestration.lease.expires_at) > now().getTime()
      && owner.current_stage_id === stage.id && owner.current_grant_id === admission.grant_id && owner.authority_revision === admission.authority_revision
      && ["implementation", "correction"].includes(stage.kind) && stage.role_id === "software-engineer" && stage.sandbox === "workspace-write" && stage.status === "running"
      && stage.task_id === task.envelope.id && stage.execution_id === runId && stage.generation === admission.stage_generation
      && stage.context_fingerprint === admission.manifest_fingerprint && intent?.status === "committed" && owner.counters.accounting_complete
      && document.accounting[runId]?.attempt_charged === true && document.accounting[runId]?.task_id === task.envelope.id
      && admission.issue_id === issue.id && admission.scope_revision === issue.scope_revision && admission.scope_fingerprint === workflowEvidenceHash(issue.authorized_scope)
      && isDeepStrictEqual(document.grants[owner.current_grant_id]?.authorized_scope, issue.authorized_scope);
  }
  function inspectWorkflowCandidate(workflowId: string) {
    const workflows = readWorkflowDocument(), workflow = workflows.workflows[workflowId], document = readIssueDocument();
    if (!workflow || ["completed", "cancelled"].includes(workflow.status) || workflow.stop_requested_at || !workflow.counters.accounting_complete || !workflow.candidate) throw new IssueServiceError("Workflow candidate authority is not current", 409);
    const issue = requireIssue(document, workflow.issue_id), grant = workflows.grants[workflow.current_grant_id]!;
    const task = readTask(workflow.candidate.task_id), patch = readContained(repoRoot, `reports/${workflow.candidate.task_id}-${workflow.candidate.execution_id}.diff`, 512 * 1024);
    if (!task || !patch) throw new IssueServiceError("Workflow candidate evidence is unavailable", 409);
    const candidate = bindVerifiedWorkflowCandidate(document, issue, task, patch);
    if (!isDeepStrictEqual(candidate, workflow.candidate)) throw new IssueServiceError("Workflow candidate content or testing binding changed", 409);
    const current = createWorkflowContextService(repoRoot).preview({ template_id: grant.template_id, template_version: 1, project_id: grant.project_id, issue_id: grant.issue_id,
      expected_revision: issue.revision, selected_agents: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.agent_id])),
      client_context_categories: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.client_context_categories])), budget: grant.budget, correction_enabled: grant.correction.enabled,
      ...(grant.template_id === "quality-review" ? { candidate_id: candidate.candidate_id } : {}) });
    if (!current.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner"
      || ["checking", "ready-for-review"].includes(issue.status) && reason === "Write workflow requires the current exact-scope issue authorization")
      || !isDeepStrictEqual(current.source_fingerprints, grant.source_fingerprints) || current.policy_fingerprint !== grant.policy_fingerprint
      || current.testing_policy_fingerprint !== grant.testing_policy_fingerprint || !isDeepStrictEqual(current.review_policy, workflow.review_policy)) throw new IssueServiceError("Workflow sources, consent or review policy changed", 409);
    const allowed = new PolicyService(repoRoot).authorizeTask(task.envelope);
    inspectCandidateTree(allowed.project.repo_path!, task, candidate, repoRoot);
    if (!isDeepStrictEqual(readWorkflowDocument(), workflows) || !isDeepStrictEqual(readIssueDocument(), document) || !isDeepStrictEqual(readTask(task.envelope.id), task)) throw new IssueServiceError("Candidate authority changed during inspection", 409);
    return { workflows, workflow, document, issue, candidate, task };
  }
  function captureWorkflowCandidate(workflowId: string, stageId: string): WorkflowCandidateBinding {
    const workflows = readWorkflowDocument(), workflow = workflows.workflows[workflowId], stage = workflows.stages[stageId], document = readIssueDocument();
    if (!workflow || !stage || stage.workflow_id !== workflowId || workflow.status !== "running" || workflow.stop_requested_at
      || workflow.current_stage_id !== stageId || !["implementation", "correction"].includes(stage.kind) || stage.status !== "running" || !stage.task_id
      || !stage.execution_id || !workflow.counters.accounting_complete) throw new IssueServiceError("Workflow writer candidate authority is not current", 409);
    const issue = requireIssue(document, workflow.issue_id), task = readTask(stage.task_id), admission = task?.envelope.context_admission;
    if (!task || issue.status !== "checking" || admission?.schema_version !== 2 || admission.issue_revision < 1
      || admission.issue_id !== issue.id || admission.scope_revision !== issue.scope_revision) throw new IssueServiceError("Workflow writer admission is unavailable", 409);
    assertTerminalWorkflowTask(workflows, stage, task);
    assertOwnedWorkflowIssueProgress(workflows, workflow, document, admission.issue_revision);
    const patch = readContained(repoRoot, `reports/${task.envelope.id}-${stage.execution_id}.diff`, 512 * 1024);
    if (!patch) throw new IssueServiceError("Complete captured workflow diff is unavailable", 409);
    const candidate = bindVerifiedWorkflowCandidate(document, issue, task, patch);
    if (stage.kind === "correction" && (!workflow.candidate || candidate.base_revision !== workflow.candidate.candidate_revision)) {
      throw new IssueServiceError("Correction candidate does not descend from the exact prior candidate commit", 409);
    }
    const grant = workflows.grants[workflow.current_grant_id]!;
    const current = createWorkflowContextService(repoRoot).preview({ template_id: grant.template_id, template_version: 1, project_id: grant.project_id, issue_id: grant.issue_id,
      expected_revision: issue.revision, selected_agents: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.agent_id])),
      client_context_categories: Object.fromEntries(grant.role_assignments.map((role) => [role.role_id, role.client_context_categories])), budget: grant.budget, correction_enabled: grant.correction.enabled });
    if (!current.blocked_reasons.every((reason) => reason === "Issue already has a nonterminal workflow owner"
      || ["working", "checking"].includes(issue.status) && reason === "Write workflow requires the current exact-scope issue authorization")
      || !isDeepStrictEqual(current.source_fingerprints, grant.source_fingerprints) || current.policy_fingerprint !== grant.policy_fingerprint
      || current.testing_policy_fingerprint !== grant.testing_policy_fingerprint || !isDeepStrictEqual(current.review_policy, workflow.review_policy)) {
      throw new IssueServiceError("Workflow sources, scope or testing policy changed before candidate sealing", 409);
    }
    const allowed = new PolicyService(repoRoot).authorizeTask(task.envelope);
    inspectCandidateTree(allowed.project.repo_path!, task, candidate, repoRoot);
    if (!isDeepStrictEqual(readWorkflowDocument(), workflows) || !isDeepStrictEqual(readIssueDocument(), document)
      || !isDeepStrictEqual(readTask(task.envelope.id), task)) throw new IssueServiceError("Writer candidate changed during inspection", 409);
    return candidate;
  }

  return {
    inspectWorkflowCandidate,
    captureWorkflowCandidate,
    recordWorkflowReview(workflowId: string, stageId: string): void {
      const facts = inspectWorkflowCandidate(workflowId), stage = facts.workflows.stages[stageId];
      const receipt = Object.values(facts.workflows.review_receipts).find((entry) => entry.workflow_id === workflowId && entry.stage_id === stageId);
      const task = stage?.task_id ? readTask(stage.task_id) : null;
      if (!stage || !receipt || stage.status !== "completed" || stage.workflow_id !== workflowId) throw new IssueServiceError("Owned sealed review is unavailable", 409);
      assertTerminalWorkflowTask(facts.workflows, stage, task);
      assertOwnedWorkflowIssueProgress(facts.workflows, facts.workflow, facts.document, task!.envelope.context_admission!.issue_revision!);
      mutateIssueDocument((document) => {
        if (!isDeepStrictEqual(document, facts.document) || !isDeepStrictEqual(readWorkflowDocument(), facts.workflows) || !isDeepStrictEqual(readTask(stage.task_id!), task)) throw new IssueServiceError("Review facts changed before issue evidence", 409);
        const issue = requireIssue(document, facts.issue.id), reference = `Review receipt ${receipt.id}; fingerprint ${receipt.fingerprint}`;
        const prior = issue.evidence_ids.map((id) => document.evidence[id]).find((entry) => entry?.reference === reference);
        if (prior) { if (prior.task_id !== task!.envelope.id || prior.candidate_id !== facts.candidate.candidate_id || prior.execution_id !== stage.execution_id) throw new IssueServiceError("Review evidence conflicts", 409); return; }
        addEvidence(document, issue, { task_id: task!.envelope.id, execution_id: stage.execution_id, candidate_id: facts.candidate.candidate_id, candidate_revision: facts.candidate.candidate_revision,
          diff_fingerprint: facts.candidate.diff_fingerprint, scope_revision: issue.scope_revision, kind: "review", label: "Infrastructure-sealed role review (not human acceptance)", reference,
          status: receipt.verdict === "approve" ? "informational" : "gap" }, now().toISOString());
        appendEvent(document, issue, "workflow-review-recorded", { workflow_id: workflowId, stage_id: stage.id, task_id: task!.envelope.id, candidate_id: facts.candidate.candidate_id,
          receipt_id: receipt.id, receipt_fingerprint: receipt.fingerprint }, now().toISOString());
      });
    },
    markWorkflowReady(workflowId: string): WorkIssue {
      const facts = inspectWorkflowCandidate(workflowId), reviews = applicableWorkflowReviews(facts.workflows, facts.workflow, facts.document, readTask);
      const stage = facts.workflows.stages[facts.workflow.current_stage_id!]!, task = stage?.task_id ? readTask(stage.task_id) : null;
      if (!task) throw new IssueServiceError("Current review task is missing", 409);
      assertOwnedWorkflowIssueProgress(facts.workflows, facts.workflow, facts.document, task.envelope.context_admission!.issue_revision!);
      return mutateIssueDocument((document) => {
        if (!isDeepStrictEqual(document, facts.document) || !isDeepStrictEqual(readWorkflowDocument(), facts.workflows)) throw new IssueServiceError("Reviews changed before ready gate", 409);
        const issue = requireIssue(document, facts.issue.id);
        if (issue.status === "ready-for-review") return issue;
        transition(document, issue, "ready-for-review", issue.revision, "verification-passed", { workflow_id: workflowId, task_id: task.envelope.id, candidate_id: facts.candidate.candidate_id,
          candidate_revision: facts.candidate.candidate_revision, diff_fingerprint: facts.candidate.diff_fingerprint, scope_revision: issue.scope_revision, review_fingerprint: reviews.fingerprint,
          review_receipt_ids: reviews.receipts.map((entry) => entry.id) }, now().toISOString());
        return issue;
      });
    },
    list(): WorkIssue[] {
      return Object.values(readIssueDocument().issues).sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
    },

    get(id: string): IssueLineage {
      const document = readIssueDocument();
      const issue = requireIssue(document, id);
      const tasks = listTasks().filter((task) => taskIssueId(task) === id);
      const taskLineage = tasks.map((task) => {
        const events = readTaskEvents(task.envelope.id);
        const executions = [...new Set(events.map((event) => event.run_id).filter((runId): runId is string => Boolean(runId)))].map((runId) => ({
          run_id: runId,
          attempt: events.find((event) => event.run_id === runId)?.attempt ?? 0,
          events: events.filter((event) => event.run_id === runId),
        }));
        return { task, executions };
      });
      const sessions = listWorkSessions().filter((session) => session.related_task_ids.some((taskId) => tasks.some((task) => task.envelope.id === taskId)));
      const candidates = issue.candidate_ids.map((candidateId) => document.candidates[candidateId]).filter((candidate): candidate is ReviewCandidate => Boolean(candidate));
      const evidence = issue.evidence_ids.map((evidenceId) => document.evidence[evidenceId]).filter((entry): entry is IssueEvidenceReference => Boolean(entry));
      const gaps = evidenceGaps(issue, evidence, candidates);
      if (tasks.length === 0) gaps.push("No task execution is linked yet.");
      return { issue, tasks: taskLineage, candidates, evidence, evidence_gaps: gaps, sessions } as IssueLineage;
    },

    create(raw: IssueCreateInput): WorkIssue {
      const projectId = text(raw?.project_id, "project_id", 100);
      if (!projectIds().includes(projectId)) throw new IssueServiceError("project is not registered for local work", 404);
      const title = text(raw.title, "title", 200);
      const expectedOutcome = text(raw.expected_outcome, "expected_outcome", 4000);
      const criteria = labels(raw.acceptance_criteria, "acceptance_criteria");
      const scope = scopeFromUnknown(raw.authorized_scope);
      if (scope.expected_outcome !== expectedOutcome || JSON.stringify(scope.acceptance_criteria) !== JSON.stringify(criteria)) throw new IssueServiceError("authorized scope outcome and criteria must exactly match the issue");
      const criticality = raw.criticality ?? "low";
      if (!["low", "medium", "high"].includes(criticality)) throw new IssueServiceError("criticality is invalid");
      const rawInputs = raw.classification_inputs ?? {};
      const affectedDomains = optionalLabels(rawInputs.affected_domains, "affected_domains", 30);
      const requiresMigration = rawInputs.requires_migration === true;
      const securityImpact = rawInputs.security_impact === true;
      if ((rawInputs.requires_migration !== undefined && typeof rawInputs.requires_migration !== "boolean") || (rawInputs.security_impact !== undefined && typeof rawInputs.security_impact !== "boolean")) throw new IssueServiceError("classification inputs are invalid");
      const classification = deriveScale({ ...raw, acceptance_criteria: criteria }, affectedDomains, requiresMigration, securityImpact, criticality, scope.allowed_change_categories);
      const plan = raw.plan === undefined ? [] : optionalLabels(raw.plan, "plan", 30);
      if (classification.scale === "substantial" && (plan.length === 0 || criteria.length < 2 || !raw.next_action?.trim())) throw new IssueServiceError("substantial work requires a durable plan, at least two acceptance criteria, and a next action");
      const objectiveId = raw.objective_id ?? null;
      if (objectiveId) {
        const organization = readOrganizationSnapshot();
        if (!organization.objectives.some((objective) => objective.id === objectiveId)
          || !organization.project_objectives[projectId]?.objective_ids.includes(objectiveId)) throw new IssueServiceError("objective must exist and be linked to this project", 409);
      }
      const parentId = raw.parent_issue_id ?? null;
      const blockers = optionalLabels(raw.blocked_by_issue_ids, "blocked_by_issue_ids", 100);
      const nowIso = now().toISOString();
      const id = `I-${randomUUID()}`;
      const priority = raw.priority ?? 50;
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) throw new IssueServiceError("priority must be an integer from 0 to 100");
      const issue: WorkIssue = {
        schema_version: 1, id, project_id: projectId, objective_id: objectiveId, parent_issue_id: parentId,
        title, expected_outcome: expectedOutcome, acceptance_criteria: criteria, status: "proposed", work_scale: classification.scale,
        classification_inputs: { affected_domains: affectedDomains, requires_migration: requiresMigration, security_impact: securityImpact },
        classification_rationale: classification.rationale, plan, authorized_scope: scope, scope_revision: 1,
        scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority, criticality,
        blocked_by_issue_ids: blockers, assigned_role_id: raw.assigned_role_id ? text(raw.assigned_role_id, "assigned_role_id", 100) : null,
        related_commitment_ids: optionalLabels(raw.related_commitment_ids, "related_commitment_ids", 100),
        external_references: externalReferences(raw.external_references),
        next_action: raw.next_action === undefined || raw.next_action === null || raw.next_action === "" ? null : text(raw.next_action, "next_action", 1000),
        task_ids: [], evidence_ids: [], candidate_ids: [], created_at: nowIso, updated_at: nowIso, revision: 1,
      };
      mutateIssueDocument((document) => {
        if (Object.keys(document.issues).length >= 500) throw new IssueServiceError("local issue capacity reached", 409);
        for (const referenceId of [parentId, ...blockers].filter((value): value is string => Boolean(value))) {
          const referenced = requireIssue(document, referenceId);
          if (referenced.project_id !== projectId) throw new IssueServiceError("parent and blocker issues must target the same project");
        }
        document.issues[id] = issue;
        appendEvent(document, issue, "issue-proposed", { project_id: projectId, work_scale: issue.work_scale, classification_rationale: issue.classification_rationale }, nowIso);
      });
      return issue;
    },

    authorize(id: string, expectedRevision: number, approvalId: string): WorkIssue {
      const approval = text(approvalId, "approval_id", 100);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        transition(document, issue, "authorized", expectedRevision, "scope-authorization-recorded", { approval_id: approval, scope_revision: issue.scope_revision }, now().toISOString());
        return issue;
      });
    },

    resumeBlocked(id: string, expectedRevision: number, rationale: string): WorkIssue {
      const reason = text(rationale, "resume rationale", 1000);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        transition(document, issue, "authorized", expectedRevision, "blocker-resolved", { rationale: reason }, now().toISOString());
        return issue;
      });
    },

    resolveDecision(id: string, expectedRevision: number, approvalId: string, rationale: string): WorkIssue {
      const approval = text(approvalId, "approval_id", 100);
      const reason = text(rationale, "decision rationale", 1000);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        if (issue.scope_change_proposal) throw new IssueServiceError("a pending scope proposal requires an explicit scope decision", 409);
        for (const candidateId of issue.candidate_ids) {
          const candidate = document.candidates[candidateId];
          if (candidate && candidate.invalidated_at === null) candidate.invalidated_at = now().toISOString();
        }
        transition(document, issue, "authorized", expectedRevision, "decision-recorded", { approval_id: approval, rationale: reason, scope_revision: issue.scope_revision, scope_unchanged: true }, now().toISOString());
        addEvidence(document, issue, { task_id: null, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "review", label: "Human decision to resume under unchanged scope", reference: reason, status: "informational" }, now().toISOString());
        return issue;
      });
    },

    dispatch(id: string, expectedRevision: number, agent: string, admission?: { role_id?: string; preview_fingerprint?: string; client_context_categories?: unknown }): { issue: WorkIssue; taskId: string } {
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        if (issue.revision !== expectedRevision) throw new IssueServiceError("issue changed; refresh before dispatch", 409);
        if (Object.values(readWorkflowDocument().workflows).some((owner) => owner.issue_id === id && !["completed", "cancelled"].includes(owner.status))) throw new IssueServiceError("issue is owned by an active workflow; manual dispatch is denied", 409);
        const isAuthorized = issue.status === "authorized";
        const latestIssueEvent = document.events.filter((event) => event.issue_id === issue.id).at(-1);
        const isApprovedRework = issue.status === "working" && latestIssueEvent?.type === "bounded-correction-authorized";
        if (!isAuthorized && !isApprovedRework) throw new IssueServiceError("issue needs exact-scope authorization or an approved rework decision before dispatch", 409);
        if (issue.assigned_role_id && issue.assigned_role_id !== agent) throw new IssueServiceError("selected role differs from the role authorized on this issue", 409);
        if (issue.blocked_by_issue_ids.some((blockerId) => document.issues[blockerId]?.status !== "done")) throw new IssueServiceError("issue has unresolved blockers", 409);
        const previousActive = listTasks().find((task) => taskIssueId(task) === issue.id && (task.lifecycle === "running" || task.lifecycle === "queued"));
        if (previousActive) throw new IssueServiceError("issue already has an active task owner", 409);
        if (issue.task_ids.length >= 100) throw new IssueServiceError("issue task history limit reached", 409);
        const taskId = `T-${randomUUID().slice(0, 8)}`;
        const scope = issue.authorized_scope;
        const instructions = [
          `Implement the approved local issue: ${issue.title}`,
          `Expected outcome: ${issue.expected_outcome}`,
          "Acceptance criteria:", ...issue.acceptance_criteria.map((criterion) => `- ${criterion}`),
          "Authorized scope (revision " + issue.scope_revision + "):",
          `Allowed paths: ${scope.allowed_path_patterns.join(", ")}`,
          `Excluded paths: ${scope.excluded_path_patterns.join(", ") || "none"}`,
          `Allowed change categories: ${scope.allowed_change_categories.join(", ")}`,
          `Explicit exclusions: ${scope.explicit_exclusions.join("; ") || "none"}`,
          issue.plan.length ? `Approved plan:\n${issue.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}` : "",
          issue.next_action ? `Next action: ${issue.next_action}` : "",
          "Do not modify paths outside the authorized scope. Discovery is not authorization. If necessary work falls outside scope, stop and report it; the Control Plane will record a scope decision. Do not push, publish, or create a provider issue.",
        ].filter(Boolean).join("\n");
        const { id: taskIdCreated } = makeTask({
          project: issue.project_id,
          agent,
          instructions,
          sandbox: "workspace-write",
          self_verify: true,
          role_id: admission?.role_id,
          preview_fingerprint: admission?.preview_fingerprint,
          ...(admission?.client_context_categories !== undefined ? { client_context_categories: admission.client_context_categories } : {}),
        }, repoRoot, { taskId, issueId: issue.id, expectedRevision, scopeRevision: issue.scope_revision, authorizedScope: scope }, { context: options.context, source: options.source });
        issue.task_ids.push(taskIdCreated);
        if (isAuthorized) transition(document, issue, "working", expectedRevision, "execution-admitted", { task_id: taskIdCreated, role_id: agent, scope_revision: issue.scope_revision }, now().toISOString());
        else appendEvent(document, issue, "rework-task-admitted", { task_id: taskIdCreated, role_id: agent, scope_revision: issue.scope_revision }, now().toISOString());
        addEvidence(document, issue, { task_id: taskIdCreated, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "task", label: "Issue task created", reference: `/api/tasks/${taskIdCreated}`, status: "informational" }, now().toISOString());
        return { issue, taskId: taskIdCreated };
      });
    },

    // Internal controller boundary, never wired to a generic request body.
    linkWorkflowTask(stageId: string): WorkIssue {
      const workflows = readWorkflowDocument(); assertWorkflowDocument(workflows);
      const stage = workflows.stages[stageId];
      const intent = Object.values(workflows.admission_intents).find((entry) => entry.stage_id === stageId);
      if (!stage || !intent || intent.status !== "reserved" || stage.status !== "reserved" || intent.task_id !== stage.task_id
        || intent.expected_workflow_revision !== workflows.workflows[stage.workflow_id]?.revision) throw new IssueServiceError("workflow admission is not reserved", 409);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, workflows.workflows[stage.workflow_id]!.issue_id);
        const workflow = workflows.workflows[stage.workflow_id]!, grant = workflows.grants[workflow.current_grant_id]!;
        if (workflow.status !== "running" || workflow.stop_requested_at || workflow.pending_decision_id || workflow.recovery_state !== "none"
          || workflow.current_stage_id !== stageId || issue.scope_revision !== grant.scope_revision || issue.project_id !== grant.project_id
          || !isDeepStrictEqual(issue.authorized_scope, grant.authorized_scope)) throw new IssueServiceError("workflow issue authority changed before linkage", 409);
        const event = document.events.filter((entry) => entry.issue_id === issue.id).at(-1);
        if (issue.task_ids.includes(intent.task_id)) {
          const expectedType = stage.kind === "correction" ? "bounded-correction-authorized" : stage.sandbox === "workspace-write" ? "execution-admitted" : "workflow-role-task-linked";
          if (issue.revision === intent.expected_issue_revision && event?.type === expectedType && event.payload.workflow_id === stage.workflow_id && event.payload.stage_id === stageId && event.payload.task_id === intent.task_id) return issue;
          throw new IssueServiceError("workflow issue linkage cannot be proven", 409);
        }
        if (listTasks().some((task) => task.envelope.id !== intent.task_id && taskIssueId(task) === issue.id && ["queued", "running"].includes(task.lifecycle))) throw new IssueServiceError("issue already has an active task owner", 409);
        return projectWorkflowIssueLink(document, workflows, stageId, intent.task_id, intent.expected_issue_revision - 1, now().toISOString());
      });
    },

    recordScopeFinding(issueId: string, taskId: string, paths: string[]): void {
      const at = now().toISOString();
      mutateIssueDocument((document) => {
        const issue = requireIssue(document, issueId);
        const task = readTask(taskId), admission = task?.envelope.context_admission;
        if (!task || issue.status !== "working" || !issue.task_ids.includes(taskId)
          || admission?.schema_version === 2 && (!workflowWriter(task, issue, task.orchestration?.lease?.run_id ?? "") || admission.issue_id !== issueId)) return;
        const safePaths = [...new Set(paths.map((path) => safeEvidenceText(path, 500)))].slice(0, 200);
        const proposedScope = { ...issue.authorized_scope, allowed_path_patterns: [...new Set([...issue.authorized_scope.allowed_path_patterns, ...safePaths])] };
        issue.scope_change_proposal = { id: randomUUID(), discovered_paths: safePaths, proposed_scope: proposedScope, discovered_at: at, evidence_task_id: taskId };
        transition(document, issue, "needs-decision", issue.revision, "decision-required", { task_id: taskId, discovered_paths: safePaths, scope_revision: issue.scope_revision }, at);
        addEvidence(document, issue, { task_id: taskId, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "work-product", label: "Out-of-scope paths discovered; authorization required", reference: safeEvidenceText(safePaths.join("\n")), status: "gap" }, at);
      });
    },

    approveScopeRevision(id: string, expectedRevision: number, proposalId: string, approvalId: string): WorkIssue {
      const approval = text(approvalId, "approval_id", 100);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        const proposal = issue.scope_change_proposal;
        if (!proposal || proposal.id !== proposalId) throw new IssueServiceError("scope proposal is stale or missing", 409);
        if (issue.revision !== expectedRevision || issue.status !== "needs-decision") throw new IssueServiceError("issue changed; refresh before approving scope", 409);
        issue.authorized_scope = proposal.proposed_scope;
        issue.scope_revision += 1;
        issue.scope_changed_at = now().toISOString();
        issue.scope_change_approval_id = approval;
        issue.scope_change_proposal = null;
        transition(document, issue, "authorized", expectedRevision, "decision-recorded", { approval_id: approval, proposal_id: proposalId, scope_revision: issue.scope_revision }, now().toISOString());
        return issue;
      });
    },

    rejectScopeRevision(id: string, expectedRevision: number, proposalId: string, rationale: string): WorkIssue {
      const reason = text(rationale, "decision rationale", 1000);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        if (issue.revision !== expectedRevision || issue.status !== "needs-decision" || issue.scope_change_proposal?.id !== proposalId) throw new IssueServiceError("scope proposal is stale or missing", 409);
        issue.scope_change_proposal = null;
        transition(document, issue, "cancelled", expectedRevision, "decision-cancelled", { proposal_id: proposalId, rationale: reason }, now().toISOString());
        return issue;
      });
    },

    requestRework(id: string, expectedRevision: number, candidateId: string, fingerprint: string, rationale: string): WorkIssue {
      const reason = text(rationale, "rework rationale", 1000);
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id);
        const candidate = document.candidates[candidateId];
        if (!candidate || candidate.issue_id !== id || candidate.invalidated_at !== null || candidate.scope_revision !== issue.scope_revision || candidate.diff_fingerprint !== fingerprint) throw new IssueServiceError("rework candidate is stale; refresh before deciding", 409);
        candidate.invalidated_at = now().toISOString();
        transition(document, issue, "working", expectedRevision, "bounded-correction-authorized", { candidate_id: candidate.id, diff_fingerprint: candidate.diff_fingerprint, rationale: reason, scope_revision: issue.scope_revision }, now().toISOString());
        addEvidence(document, issue, { task_id: candidate.task_id, execution_id: candidate.execution_id, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "review", label: "Bounded rework requested", reference: reason, status: "informational" }, now().toISOString());
        return issue;
      });
    },

    recordCandidate(input: { issueId: string; taskId: string; executionId: string; repositoryId: string; baseRevision: string; candidateRevision: string; changedPaths: string[]; scopeRevision: number }): ReviewCandidate {
      const at = now().toISOString();
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, input.issueId);
        const activeTask = readTask(input.taskId);
        const ownedWorkflow = workflowWriter(activeTask, issue, input.executionId);
        const admission = activeTask?.envelope.context_admission;
        if (ownedWorkflow && admission?.schema_version === 2 && admission.stage_kind === "correction") {
          const workflows = readWorkflowDocument(), owner = workflows.workflows[admission.workflow_id], stage = workflows.stages[admission.stage_id];
          if (!owner || !stage || stage.kind !== "correction" || stage.id !== owner.current_stage_id || stage.task_id !== input.taskId
            || !owner.candidate || input.baseRevision !== owner.candidate.candidate_revision || admission.candidate?.candidate_revision !== input.baseRevision) {
            throw new IssueServiceError("Correction candidate does not use the exact prior candidate commit as its base", 409);
          }
        }
        if (!issue.task_ids.includes(input.taskId) || (issue.status !== "working" && issue.status !== "checking") || issue.scope_revision !== input.scopeRevision
          || activeTask?.lifecycle !== "running" || activeTask.orchestration?.lease?.run_id !== input.executionId
          || Date.parse(activeTask.orchestration.lease.expires_at) <= now().getTime()
          || (activeTask.envelope.context_admission?.schema_version === 2 ? !ownedWorkflow
            : activeTask.envelope.metadata.issue_id !== issue.id || activeTask.envelope.metadata.issue_scope_revision !== issue.scope_revision)) {
          throw new IssueServiceError("candidate does not match the active authorized issue execution", 409);
        }
        if (input.repositoryId !== issue.project_id || activeTask.envelope.project !== issue.project_id || issue.task_ids.at(-1) !== input.taskId) throw new IssueServiceError("candidate repository or task owner differs", 409);
        const outside = pathsOutsideScope(input.changedPaths, issue.authorized_scope);
        if (outside.length) throw new IssueScopeViolationError(issue.id, input.taskId, outside);
        for (const oldId of issue.candidate_ids) {
          const old = document.candidates[oldId];
          if (old && old.invalidated_at === null) old.invalidated_at = at;
        }
        const fingerprint = createHash("sha256").update(`${input.repositoryId}\0${input.baseRevision}\0${input.candidateRevision}\0${input.changedPaths.join("\0")}`).digest("hex");
        const candidate: ReviewCandidate = {
          schema_version: 1, id: `C-${randomUUID()}`, issue_id: issue.id, task_id: input.taskId,
          execution_id: input.executionId, repository_id: input.repositoryId, base_revision: input.baseRevision,
          candidate_revision: input.candidateRevision, diff_fingerprint: fingerprint,
          changed_paths: [...new Set(input.changedPaths)], scope_revision: issue.scope_revision, created_at: at, invalidated_at: null,
        };
        document.candidates[candidate.id] = candidate;
        issue.candidate_ids.push(candidate.id);
        const candidatePayload = { task_id: input.taskId, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision };
        if (issue.status === "working") transition(document, issue, "checking", issue.revision, "candidate-produced", candidatePayload, at);
        else appendEvent(document, issue, "candidate-replaced-after-lease-recovery", candidatePayload, at);
        addEvidence(document, issue, { task_id: input.taskId, execution_id: input.executionId, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "commit", label: "Immutable review candidate commit", reference: candidate.candidate_revision, status: "informational" }, at);
        addEvidence(document, issue, { task_id: input.taskId, execution_id: input.executionId, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "diff", label: "Candidate diff paths", reference: safeEvidenceText(candidate.changed_paths.join("\n")), status: "informational" }, at);
        return candidate;
      });
    },

    recordVerification(input: { issueId: string; taskId: string; executionId: string; candidateId: string; status: "passed" | "failed" | "informational"; reference: string; label: string }): void {
      const at = now().toISOString();
      mutateIssueDocument((document) => {
        const issue = requireIssue(document, input.issueId);
        const candidate = document.candidates[input.candidateId];
        const task = readTask(input.taskId);
        const ownedWorkflow = workflowWriter(task, issue, input.executionId);
        if (task?.envelope.context_admission?.schema_version === 2 && task.orchestration?.cancel_requested_at) return;
        if (!candidate || candidate.issue_id !== issue.id || candidate.task_id !== input.taskId || candidate.execution_id !== input.executionId || candidate.repository_id !== issue.project_id || candidate.invalidated_at !== null || candidate.scope_revision !== issue.scope_revision
          || !task || task.envelope.project !== issue.project_id || (task.envelope.context_admission?.schema_version === 2 ? !ownedWorkflow
            : task.envelope.metadata.issue_id !== issue.id || task.envelope.metadata.issue_scope_revision !== issue.scope_revision)
          || task.lifecycle !== "running" || task.orchestration?.lease?.run_id !== input.executionId || Date.parse(task.orchestration.lease.expires_at) <= Date.now()
          || issue.task_ids.at(-1) !== input.taskId) throw new IssueServiceError("verification evidence references a stale candidate or execution", 409);
        let status = input.status;
        if (task.envelope.context_manifest) {
          if (issue.status !== "checking" || issue.revision !== (task.envelope.context_admission?.issue_revision ?? -100) + (ownedWorkflow ? 1 : 2) || issue.candidate_ids.at(-1) !== candidate.id) throw new IssueServiceError("verification issue revision or candidate owner changed", 409);
          status = "informational";
          if (task.testing_evidence) {
            try {
              assertTestingEvidenceBinding(task.testing_evidence, task, candidate);
              const workflowAdmission = task.envelope.context_admission?.schema_version === 2 ? task.envelope.context_admission : null;
              if (ownedWorkflow ? workflowAdmission?.scope_fingerprint !== workflowEvidenceHash(issue.authorized_scope)
                : JSON.stringify(task.envelope.metadata.issue_authorized_scope) !== JSON.stringify(issue.authorized_scope)) throw new Error("scope changed");
              const observed = testingEvidenceStatus(task.testing_evidence);
              status = observed === "passed" ? "passed" : observed === "failed" ? "failed" : "informational";
            } catch { throw new IssueServiceError("captured testing evidence does not match the authorized candidate", 409); }
          }
        }
        if (task.orchestration.cancel_requested_at) status = "failed";
        addEvidence(document, issue, { task_id: input.taskId, execution_id: input.executionId, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "verification", label: safeEvidenceText(input.label, 300), reference: safeEvidenceText(input.reference), status, ...(task.testing_evidence ? { testing_evidence_fingerprint: task.testing_evidence.fingerprint } : {}) }, at);
        if (status === "passed" && ownedWorkflow) {
          issue.next_action = "Await exact candidate-bound required role reviews and final human acceptance.";
          appendEvent(document, issue, "workflow-verification-passed", { workflow_id: task.envelope.context_admission!.schema_version === 2 ? task.envelope.context_admission!.workflow_id : null, task_id: task.envelope.id,
            candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision }, at);
        }
        else if (status === "passed" && issue.status === "checking") transition(document, issue, "ready-for-review", issue.revision, "verification-passed", { candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision }, at);
        else if (issue.status === "checking") {
          issue.next_action = "Resolve the verification gap and explicitly authorize a new attempt under the current scope.";
          transition(document, issue, "needs-decision", issue.revision, "verification-needs-decision", { candidate_id: candidate.id, status, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision }, at);
        } else appendEvent(document, issue, "verification-evidence-recorded", { candidate_id: candidate.id, status }, at);
      });
    },

    markBlocked(issueId: string, taskId: string, reason: string): void {
      const at = now().toISOString();
      mutateIssueDocument((document) => {
        const issue = requireIssue(document, issueId);
        if (issue.task_ids.at(-1) !== taskId) return;
        if (issue.status === "checking") {
          const task = readTask(taskId);
          const admission = task?.envelope.context_admission;
          if (!task?.envelope.context_manifest || (admission?.schema_version === 2
            ? !workflowWriter(task, issue, task.orchestration?.lease?.run_id ?? "") || admission.issue_id !== issue.id
            : task.envelope.metadata.issue_id !== issue.id || task.envelope.metadata.issue_scope_revision !== issue.scope_revision)) return;
          issue.next_action = "Resolve the interrupted verification gap and explicitly admit a new task under the current scope.";
          transition(document, issue, "needs-decision", issue.revision, "verification-needs-decision", { task_id: taskId, reason: safeEvidenceText(reason, 500), scope_revision: issue.scope_revision }, at);
          addEvidence(document, issue, { task_id: taskId, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "task", label: "Interrupted verification requires a human decision", reference: safeEvidenceText(reason), status: "gap" }, at);
          return;
        }
        if (issue.status !== "working") return;
        const activeTask = readTask(taskId), admission = activeTask?.envelope.context_admission;
        if (!activeTask) return;
        if (admission?.schema_version === 2) {
          if (!workflowWriter(activeTask, issue, activeTask.orchestration?.lease?.run_id ?? "") || admission.issue_id !== issue.id) return;
        } else if (activeTask.envelope.metadata.issue_id !== issue.id || activeTask.envelope.metadata.issue_scope_revision !== issue.scope_revision) return;
        issue.next_action = safeEvidenceText(reason, 1000);
        transition(document, issue, "blocked", issue.revision, "execution-blocked", { task_id: taskId, reason: reason.slice(0, 500) }, at);
        addEvidence(document, issue, { task_id: taskId, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "task", label: "Execution blocked", reference: safeEvidenceText(reason), status: "gap" }, at);
      });
    },

    acceptCandidate(id: string, input: { expectedRevision: number; candidateId: string; fingerprint: string; approvalId: string; rationale: string; confirmedCriteria: string[]; acknowledgeEvidenceGaps?: boolean }, workflowDecision?: { workflowId: string; decisionId: string; expectedRevision: number; resourceFingerprint: string }): WorkIssue {
      const workflowSnapshot = readWorkflowDocument(), owner = Object.values(workflowSnapshot.workflows).find((entry) => entry.issue_id === id && !["completed", "cancelled"].includes(entry.status));
      if (owner && (!workflowDecision || workflowDecision.workflowId !== owner.id)) throw new IssueServiceError("Use the current explicit workflow candidate decision; direct acceptance cannot bypass it", 409);
      const facts = owner ? inspectWorkflowCandidate(owner.id) : null;
      const reviews = facts ? applicableWorkflowReviews(facts.workflows, facts.workflow, facts.document, readTask) : null;
      const decision = facts && workflowDecision ? facts.workflows.decisions[workflowDecision.decisionId] : null;
      if (facts && (!reviews || facts.workflow.status !== "waiting-human" || facts.workflow.recovery_state !== "none" || facts.workflow.revision !== workflowDecision!.expectedRevision
        || facts.workflow.pending_decision_id !== decision?.id || decision?.kind !== "candidate-acceptance" || decision.status !== "pending"
        || decision.expected_issue_revision !== input.expectedRevision || decision.expected_workflow_revision !== facts.workflow.revision || decision.candidate_id !== input.candidateId
        || decision.resource_fingerprint !== reviews.fingerprint || workflowDecision!.resourceFingerprint !== reviews.fingerprint
        || !isDeepStrictEqual(decision.review_receipt_ids, reviews.receipts.map((entry) => entry.id))
        || reviews.risks && !hasCurrentRiskAcknowledgement(facts.workflows, facts.workflow, reviews.fingerprint, decision.review_receipt_ids))) throw new IssueServiceError("Workflow acceptance or risk acknowledgement is stale or incomplete", 409);
      return mutateIssueDocument((document) => {
        if (!isDeepStrictEqual(readWorkflowDocument(), facts?.workflows ?? workflowSnapshot) || facts && !isDeepStrictEqual(document, facts.document)) throw new IssueServiceError("Workflow authority changed before human acceptance", 409);
        const issue = requireIssue(document, id);
        const candidate = document.candidates[input.candidateId];
        if (!candidate || candidate.issue_id !== issue.id || candidate.invalidated_at !== null || candidate.scope_revision !== issue.scope_revision
          || candidate.diff_fingerprint !== input.fingerprint) throw new IssueServiceError("review candidate changed or is stale; reload before accepting", 409);
        if (issue.status !== "ready-for-review" || issue.revision !== input.expectedRevision) throw new IssueServiceError("issue is not ready for review or has changed", 409);
        const acceptedTask = readTask(candidate.task_id);
        if (acceptedTask?.envelope.context_admission?.schema_version === 2 && !facts) throw new IssueServiceError("A workflow candidate requires current governed reviews and acceptance authority", 409);
        if (!acceptedTask || acceptedTask.lifecycle !== "finished" || !["completed", "partial", "needs-review"].includes(acceptedTask.outcome ?? "")) {
          throw new IssueServiceError("the linked task attempt has not finished; review cannot race execution", 409);
        }
        if (JSON.stringify([...input.confirmedCriteria].sort()) !== JSON.stringify([...issue.acceptance_criteria].sort())) throw new IssueServiceError("all acceptance criteria must be explicitly confirmed");
        const priorEvidence = issue.evidence_ids.map((evidenceId) => document.evidence[evidenceId]).filter((item): item is IssueEvidenceReference => Boolean(item));
        const hasPassingVerification = priorEvidence.some((item) => item.candidate_id === candidate.id && item.kind === "verification" && item.status === "passed");
        if (acceptedTask.envelope.context_manifest) {
          try {
            if (!acceptedTask.testing_evidence) throw new Error("missing captured receipt");
            assertTestingEvidenceBinding(acceptedTask.testing_evidence, acceptedTask, candidate);
            if (testingEvidenceStatus(acceptedTask.testing_evidence) !== "passed" || (acceptedTask.envelope.context_admission?.schema_version === 2
              ? acceptedTask.envelope.context_admission.scope_fingerprint !== workflowEvidenceHash(issue.authorized_scope) : JSON.stringify(acceptedTask.envelope.metadata.issue_authorized_scope) !== JSON.stringify(issue.authorized_scope))
              || !priorEvidence.some((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidate.id && entry.execution_id === candidate.execution_id && entry.testing_evidence_fingerprint === acceptedTask.testing_evidence!.fingerprint)) throw new Error("missing bound passing evidence");
          } catch { throw new IssueServiceError("governed candidate requires exact captured testing evidence; evidence-gap acknowledgment cannot waive it", 409); }
        }
        if (!hasPassingVerification && input.acknowledgeEvidenceGaps !== true) throw new IssueServiceError("verification evidence is missing; record an explicit evidence-gap acknowledgment", 409);
        const approvalId = text(input.approvalId, "approval_id", 100);
        const rationale = text(input.rationale, "review rationale", 1000);
        if (!hasPassingVerification) addEvidence(document, issue, { task_id: candidate.task_id, execution_id: candidate.execution_id, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "verification", label: "Verification gap explicitly accepted by human reviewer", reference: "No passing automated verification is attached to this candidate.", status: "gap" }, now().toISOString());
        addEvidence(document, issue, { task_id: candidate.task_id, execution_id: candidate.execution_id, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, kind: "review", label: "Local human acceptance", reference: `${approvalId}: ${rationale}`, status: "passed" }, now().toISOString());
        transition(document, issue, "done", input.expectedRevision, "candidate-accepted", { approval_id: approvalId, rationale, candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision, confirmed_criteria: input.confirmedCriteria, evidence_gap_acknowledged: !hasPassingVerification,
          ...(facts && reviews && decision ? { workflow_id: facts.workflow.id, decision_id: decision.id, workflow_revision: facts.workflow.revision, resource_fingerprint: reviews.fingerprint, review_receipt_ids: decision.review_receipt_ids } : {}) }, now().toISOString());
        return issue;
      });
    },

    lineage(id: string): IssueLineage { return this.get(id); },

    executionGate(input: { issueId: string; taskId: string; executionId: string; scopeRevision: number }): "allowed" | "candidate-ready" | "decision-required" {
      const document = readIssueDocument();
      const issue = document.issues[input.issueId];
      const task = readTask(input.taskId);
      if (task?.envelope.context_admission?.schema_version === 2) {
        const admission = task.envelope.context_admission;
        if (!issue || admission.issue_id !== input.issueId || admission.scope_revision !== input.scopeRevision
          || issue.scope_revision !== input.scopeRevision || !issue.task_ids.includes(input.taskId)) return "decision-required";
        return workflowWriter(task, issue, input.executionId) && (issue.status === "working" || issue.status === "checking") ? "allowed" : "decision-required";
      }
      if (!issue || !task || !issue.task_ids.includes(input.taskId)
        || task.envelope.metadata.issue_id !== input.issueId
        || task.envelope.metadata.issue_scope_revision !== input.scopeRevision
        || issue.scope_revision !== input.scopeRevision
        || task.lifecycle !== "running"
        || task.orchestration?.lease?.run_id !== input.executionId) return "decision-required";
      if (issue.status === "working" || issue.status === "checking") return "allowed";
      if (issue.status === "ready-for-review") {
        const readyCandidate = issue.candidate_ids.map((candidateId) => document.candidates[candidateId]).find((candidate) =>
          candidate && candidate.task_id === input.taskId && candidate.execution_id !== input.executionId
          && candidate.invalidated_at === null && candidate.scope_revision === issue.scope_revision
          && issue.evidence_ids.some((evidenceId) => {
            const evidence = document.evidence[evidenceId];
            return evidence?.candidate_id === candidate.id && evidence.kind === "verification" && evidence.status === "passed";
          }));
        if (readyCandidate) return "candidate-ready";
      }
      return "decision-required";
    },
  };
}
