import { createHash, randomUUID } from "node:crypto";
import { assertTestingEvidenceBinding, testingEvidenceStatus } from "../../../lib/context/testing-evidence";
import type { IssueTransitionEnvelope } from "../../../lib/organization/issue-lifecycle";
import { checkIssueTransition } from "../../../lib/organization/issue-lifecycle";
import type { IssueCreateInput, IssueDocument, IssueEvidenceReference, IssueLineage, RecordDeliveryObservationInput, ReviewCandidate, WorkIssue } from "../../../lib/issues/types";
import { readIssueDocument, mutateIssueDocument, mutateIssueDocumentIfChanged } from "../../../lib/state/issues";
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
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { applicableWorkflowReviews, assertOwnedWorkflowIssueProgress, assertTerminalWorkflowTask, bindVerifiedWorkflowCandidate, hasCurrentRiskAcknowledgement, workflowEvidenceHash } from "../../../lib/workflows/review-evidence";
import { readContained } from "../../../lib/harness/source";
import { inspectCandidateTree } from "../../../runner/worktree";
import { createWorkflowContextService } from "./workflow-context-service";
import { assertTaskBudgetAdmissionBinding, taskBudgetReadiness, validateClientPortfolioDocument, validateDeliveryObservation, validateTaskRecord } from "../../../lib/state/validation";
import { evaluateWorkflowBudgetStop, projectWorkflowConsumption, independentWorkflowBudgetStopSummary, INDEPENDENT_WORKFLOW_BUDGET_STOP_PREFIX,
  type IndependentBudgetStopData, type WorkflowBudgetBinding, type WorkflowBudgetStop, type WorkflowBudgetStopOperation, type WorkflowConsumptionView } from "../../../lib/workflows/policy";
import { BUDGET_DIMENSIONS } from "../../../lib/budgets/types";
import { readBudgetLedger } from "../../../lib/state/budgets";
import { budgetStatePath, clientPortfolioPath } from "../../../lib/state/paths";
import { readBudgetPolicy, resolveBudgetPolicy } from "../../../lib/budgets/policy";
import { inspectBudgetStopReceipt } from "../../../runner/task-orchestrator";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { assertRoutineOwnership } from "../../../lib/state/routines";
import { assertRoutineOccurrence, routineProposalKey } from "../../../lib/routines/validation";
import { assertRoutineActionBudget, assertRoutineSignalFact, RoutineActionEffectError, type RoutineIssueProposal } from "../../../lib/routines/actions";
import type { RoutineOccurrence } from "../../../lib/routines/types";
import { isSafeIdentifier } from "../../../lib/security/identifiers";

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

export interface RoutineIssueProposerOptions {
  state_root: string;
  /** Trusted application composition, not a caller field or stored approval. */
  assert_current: (occurrence: Readonly<RoutineOccurrence>, boundary: "proposal") => void;
  projectIds?: () => string[];
  now?: () => Date;
}
const ROUTINE_PROPOSAL_EVENT = "routine-issue-proposed";
function routineIssueBoundary(root: string): void {
  const absolute = resolve(root), drive = parse(absolute).root;
  if (/^[\\/]{2}/.test(root)) throw new IssueServiceError("Routine issue boundary must be local", 409);
  let current = drive;
  for (const part of absolute.slice(drive.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new IssueServiceError("Routine issue boundary is unsafe", 409);
  }
  if (!isAbsolute(root) || absolute === drive || realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new IssueServiceError("Routine issue boundary must be an explicit canonical local root", 409);
  for (const name of ["issues", "locks"]) {
    const directory = join(absolute, name);
    try { const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IssueServiceError("Routine issue boundary is unsafe", 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const stat = lstatSync(join(absolute, "issues/issues.json"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new IssueServiceError("Routine issue evidence is unsafe or oversized", 409);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function routineIssueBytes(root: string): Buffer | null {
  routineIssueBoundary(root); const path = join(root, "issues/issues.json"); let before: Stats;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new IssueServiceError("Routine issue evidence is unavailable", 409); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw new IssueServiceError("Routine issue evidence is unsafe or oversized", 409);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const same = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!same(fstatSync(fd))) throw new Error("changed");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    if (length !== before.size || !same(fstatSync(fd)) || !same(lstatSync(path))) throw new Error("changed");
    routineIssueBoundary(root);
    const bytes = buffer.subarray(0, length);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes); // Reject lossy legacy decoding before any read/modify/write.
    return bytes;
  } catch { throw new IssueServiceError("Routine issue evidence is invalid or unavailable; bytes were preserved", 409); }
  finally { if (fd !== undefined) closeSync(fd); }
}
const sameRoutineIssueBytes = (first: Buffer | null, second: Buffer | null) => first === null ? second === null : second !== null && first.equals(second);
/** Internal-only safe proposal writer. Neither the proposal nor a digest authorizes work. */
export function createRoutineIssueProposer(repoRoot: string, options: RoutineIssueProposerOptions) {
  const root = resolve(options.state_root), issuePath = join(root, "issues/issues.json"), routinePath = join(root, "routines/routines.json");
  const projectIds = options.projectIds ?? (() => new PolicyService(repoRoot).listProjects().map((project) => project.id));
  const now = options.now ?? (() => new Date());
  if (!isAbsolute(options.state_root) || typeof options.assert_current !== "function" || nodeTypes.isAsyncFunction(options.assert_current)
    || nodeTypes.isProxy(options.assert_current)) throw new IssueServiceError("Routine proposal requires trusted synchronous application gates", 409);
  class AlreadyProposed extends Error { constructor(readonly id: string) { super("Routine proposal already retained"); } }
  return (input: RoutineIssueProposal, check: () => void): string => {
    if (!input || typeof input !== "object" || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).sort().join(",") !== "fingerprint,key,occurrence,ownership,signal"
      || Object.values(Object.getOwnPropertyDescriptors(input)).some((item) => !item.enumerable || !Object.hasOwn(item, "value"))) {
      throw new IssueServiceError("Routine proposal data is invalid", 409);
    }
    assertRoutineOccurrence(input.occurrence); assertRoutineSignalFact(input.signal);
    if (typeof check !== "function" || nodeTypes.isProxy(check) || nodeTypes.isAsyncFunction(check)) throw new IssueServiceError("Routine proposal gate must be synchronous", 409);
    const fence = (): Readonly<RoutineOccurrence> => {
      if (check() !== undefined) throw new IssueServiceError("Routine proposal gate must be synchronous", 409);
      routineIssueBoundary(root);
      if (Object.hasOwn(Object.prototype, "toJSON") || Object.hasOwn(Array.prototype, "toJSON")) throw new IssueServiceError("Routine issue serialization boundary is unavailable", 409);
      const occurrence = assertRoutineOwnership(input.ownership, routinePath);
      if (!isDeepStrictEqual(occurrence, input.occurrence) || occurrence.definition.action !== "propose-issues"
        || !occurrence.project_ids.includes(input.signal.project_id) || !isSafeIdentifier(input.signal.project_id)
        || !projectIds().includes(input.signal.project_id) || input.fingerprint !== input.signal.fingerprint
        || input.key !== routineProposalKey(occurrence.occurrence_key, input.fingerprint)) throw new IssueServiceError("Routine proposal has stale scope or occurrence bindings", 409);
      assertRoutineActionBudget(occurrence, root);
      if (options.assert_current(occurrence, "proposal") !== undefined) throw new IssueServiceError("Routine proposal gate must be synchronous", 409);
      if (!isDeepStrictEqual(assertRoutineOwnership(input.ownership, routinePath), occurrence)) throw new IssueServiceError("Routine proposal ownership changed during validation", 409);
      assertRoutineActionBudget(occurrence, root);
      if (check() !== undefined) throw new IssueServiceError("Routine proposal gate must be synchronous", 409);
      return occurrence;
    };
    const occurrence = fence();
    const binding = { routine_proposal_key: input.key, routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision,
      occurrence_id: occurrence.id, occurrence_key: occurrence.occurrence_key, proposal_fingerprint: input.fingerprint,
      project_id: input.signal.project_id, policy_fingerprint: occurrence.definition.policy.fingerprint, cap_fingerprint: occurrence.budget.cap_fingerprint };
    const retained = (document: IssueDocument): string | null => {
      const matches = document.events.filter((event) => event.payload.routine_proposal_key === input.key);
      if (!matches.length) return null;
      const event = matches[0]!, issue = document.issues[event.issue_id];
      if (matches.length !== 1 || event.type !== ROUTINE_PROPOSAL_EVENT || !isDeepStrictEqual(event.payload, binding)
        || !issue || issue.project_id !== input.signal.project_id) throw new IssueServiceError("Routine proposal history conflicts; no replay is allowed", 409);
      return issue.id; // Human progression never reopens or edits this historical proposal.
    };
    const originalBytes = routineIssueBytes(root), original = readIssueDocument(issuePath);
    if (!sameRoutineIssueBytes(originalBytes, routineIssueBytes(root))) throw new IssueServiceError("Routine issue evidence changed before proposal", 409);
    const previous = retained(original);
    if (previous) { fence(); return previous; }
    const at = now().toISOString();
    if (Date.parse(at) < Date.parse(occurrence.started_at!)) throw new IssueServiceError("Routine proposal clock regressed", 409);
    const outcome = "Review the observed routine signal and explicitly decide whether work is needed.";
    const criteria = ["Inspect current evidence before deciding.", "Record a human scope decision before any execution."];
    const issue: WorkIssue = { schema_version: 1, id: `I-${randomUUID()}`, project_id: input.signal.project_id,
      objective_id: null, parent_issue_id: null, title: "Review routine signal", expected_outcome: outcome, acceptance_criteria: criteria,
      status: "proposed", work_scale: "bounded", classification_inputs: { affected_domains: ["operations"], requires_migration: false, security_impact: false },
      classification_rationale: ["Routine evidence requires a human decision, not automatic execution."], plan: [],
      authorized_scope: { expected_outcome: outcome, acceptance_criteria: criteria, allowed_path_patterns: ["**"], excluded_path_patterns: [],
        allowed_change_categories: ["inspection"], explicit_exclusions: ["No execution, publication or configuration change is authorized by this proposal."] },
      scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 50, criticality: "low",
      blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [],
      next_action: "Inspect routine evidence and define an exact scope before human authorization.", task_ids: [], evidence_ids: [], candidate_ids: [],
      created_at: at, updated_at: at, revision: 1 };
    try {
      return mutateIssueDocument((document) => {
        fence(); const existing = retained(document); if (existing) throw new AlreadyProposed(existing);
        if (!sameRoutineIssueBytes(originalBytes, routineIssueBytes(root))) throw new IssueServiceError("Routine issue evidence changed before proposal", 409);
        if (Object.keys(document.issues).length >= 500) throw new IssueServiceError("Local issue capacity reached", 409);
        document.issues[issue.id] = issue;
        addEvidence(document, issue, { task_id: null, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null,
          scope_revision: null, kind: "provider", label: "Routine signal requires human review", reference: `Routine proposal ${input.key}`, status: "informational" }, at);
        appendEvent(document, issue, ROUTINE_PROPOSAL_EVENT, binding, at);
        fence();
        if (Buffer.byteLength(JSON.stringify(document, null, 2)) > 16 * 1024 * 1024) throw new IssueServiceError("Routine issue document capacity reached", 409);
        if (check() !== undefined) throw new IssueServiceError("Routine proposal gate must be synchronous", 409);
        return issue.id;
      }, issuePath);
    } catch (error) {
      if (error instanceof AlreadyProposed) return error.id;
      // Separate stores/lock release are not a transaction. Preserve an exact
      // durable effect after an ambiguous writer fault; do not claim rollback.
      try {
        const bytes = routineIssueBytes(root), current = readIssueDocument(issuePath);
        if (sameRoutineIssueBytes(bytes, routineIssueBytes(root))) {
          const id = retained(current);
          if (id) throw new RoutineActionEffectError({ key: input.key, fingerprint: input.fingerprint, issue_id: id });
        }
      } catch (observed) { if (observed instanceof RoutineActionEffectError) throw observed; }
      throw error;
    }
  };
}

type IssueBudgetReadiness = { task_id: string; availability: "available" | "unavailable"; readiness: ReturnType<typeof taskBudgetReadiness> | null };
type IssueBudgetConsumption = { availability: "available" | "unavailable"; workflows: WorkflowConsumptionView[] };

// A stable operational key, not approval or execution authority. Later proven
// high-water does not authorize a second transition for the same exact run.
export function workflowBudgetStopSummary(stop: WorkflowBudgetStop): string {
  const { workflow_revision: _revision, ...binding } = stop.binding;
  return `Workflow budget exhaustion ${stop.operation}: ${workflowEvidenceHash(binding)}`;
}

// This is a conservative state/evidence guard, never a private runtime proof.
// Callers read all facts before their own short store mutation and fence them
// again inside it; no second store lock or external effect is acquired here.
function inspectBudgetStopFacts(workflows: WorkflowDocument, issues: IssueDocument, workflowId: string, at: number, independent?: IndependentBudgetStopData) {
  const workflow = workflows.workflows[workflowId], stage = workflow?.current_stage_id ? workflows.stages[workflow.current_stage_id] : null;
  const grant = workflow && workflows.grants[workflow.current_grant_id], issue = workflow && issues.issues[workflow.issue_id];
  const task = stage?.task_id ? readTask(stage.task_id) : null, admission = task?.envelope.context_admission;
  const intent = stage && Object.values(workflows.admission_intents).find((entry) => entry.stage_id === stage.id);
  if (!workflow || !stage || !grant || !issue || !task || !validateTaskRecord(task) || admission?.schema_version !== 2
    || stage.workflow_id !== workflow.id || stage.grant_id !== grant.id || stage.authority_revision !== grant.authority_revision
    || workflow.authority_revision !== grant.authority_revision || admission.workflow_id !== workflow.id || admission.stage_id !== stage.id
    || admission.stage_generation !== stage.generation || admission.grant_id !== grant.id || admission.authority_revision !== grant.authority_revision
    || admission.stage_kind !== stage.kind || admission.template_id !== workflow.template_id || admission.template_version !== workflow.template_version
    || stage.kind !== "planning" && !isDeepStrictEqual(admission.approved_plan, workflow.approved_plan)
    || admission.predecessor_stage_id !== stage.predecessor_stage_id || admission.handoff_id !== stage.handoff_id
    || stage.sandbox === "read-only" && !isDeepStrictEqual(admission.candidate, stage.candidate)
    || admission.task_id !== stage.task_id || task.envelope.id !== stage.task_id || admission.role_id !== stage.role_id || task.envelope.agent !== stage.agent_id
    || issue.project_id !== workflow.project_id || grant.issue_id !== issue.id || task.envelope.project !== workflow.project_id || admission.issue_id !== issue.id || admission.scope_revision !== issue.scope_revision
    || admission.scope_fingerprint !== workflowEvidenceHash(issue.authorized_scope) || task.envelope.context_manifest?.fingerprint !== stage.context_fingerprint
    || admission.manifest_fingerprint !== stage.context_fingerprint || intent?.status !== "committed" || intent.task_id !== task.envelope.id
    || intent.grant_id !== grant.id || intent.context_fingerprint !== stage.context_fingerprint || issue.task_ids.at(-1) !== task.envelope.id) {
    throw new IssueServiceError("Workflow budget evidence has stale task, scope or admission bindings", 409);
  }
  assertOwnedWorkflowIssueProgress(workflows, workflow, issues, admission.issue_revision);
  const charge = stage.execution_id ? workflows.accounting[stage.execution_id] : null;
  if (stage.execution_id && (!charge || charge.task_id !== task.envelope.id || charge.stage_id !== stage.id || charge.workflow_id !== workflow.id
    || charge.execution_id !== stage.execution_id || charge.attempt !== task.orchestration?.attempts || !charge.attempt_charged
    || task.orchestration?.last_failure && task.orchestration.last_failure.run_id !== stage.execution_id)) {
    throw new IssueServiceError("Workflow budget evidence has stale run accounting", 409);
  }
  if (task.lifecycle === "running") {
    const lease = task.orchestration?.lease;
    if ((!independent && stage.status !== "running" || independent && !["queued", "running"].includes(stage.status))
      || !lease || lease.run_id !== (independent?.run_id ?? stage.execution_id) || Date.parse(lease.expires_at) <= at || task.orchestration?.cancel_requested_at) {
      throw new IssueServiceError("Workflow budget evidence lost its current run lease", 409);
    }
  } else if (task.lifecycle === "queued") {
    if (stage.execution_id !== null || task.orchestration?.lease || !independent && task.orchestration?.attempts !== 0 || task.orchestration?.cancel_requested_at) {
      throw new IssueServiceError("Workflow budget evidence has progressed queued ownership", 409);
    }
  } else if (!(independent?.run_id ?? stage.execution_id) || task.orchestration?.lease || task.orchestration?.cancel_requested_at || !["completed", "partial", "needs-review", "failed"].includes(task.outcome ?? "")
    || independent && task.orchestration?.last_failure && task.orchestration.last_failure.run_id !== independent.run_id) {
    throw new IssueServiceError("Workflow budget evidence has incomplete terminal ownership", 409);
  }
  let evidenceCandidate: ReviewCandidate | null = null, replacementCandidate: ReviewCandidate | null = null;
  if (workflow.candidate) {
    const binding = workflow.candidate, candidate = issues.candidates[binding.candidate_id];
    if (!candidate || candidate.issue_id !== issue.id || candidate.task_id !== binding.task_id || candidate.execution_id !== binding.execution_id || candidate.repository_id !== binding.repository_id
      || candidate.scope_revision !== binding.scope_revision || candidate.base_revision !== binding.base_revision || candidate.candidate_revision !== binding.candidate_revision
      || candidate.diff_fingerprint !== binding.diff_fingerprint || !isDeepStrictEqual(candidate.changed_paths, binding.changed_paths)) {
      throw new IssueServiceError("Workflow budget evidence has a stale retained candidate", 409);
    }
    evidenceCandidate = candidate;
    if (candidate.invalidated_at !== null || issue.candidate_ids.at(-1) !== candidate.id) {
      const replacement = issues.candidates[issue.candidate_ids.at(-1) ?? ""], lineage = workflow.lineage_id ? workflows.lineages[workflow.lineage_id] : null;
      const produced = issues.events.filter((entry) => entry.issue_id === issue.id && entry.type === "candidate-produced"
        && entry.payload.task_id === task.envelope.id && entry.payload.candidate_id === replacement?.id).at(-1);
      // recordCandidate precedes verification and the workflow's terminal seal.
      // Retain its exact replacement as evidence, never invent passed testing or
      // replace the verified authorization candidate in the workflow binding.
      if (stage.kind !== "correction" || !isDeepStrictEqual(admission.candidate, binding) || !isDeepStrictEqual(stage.candidate, binding)
        || !grant.correction.enabled || !lineage || lineage.project_id !== workflow.project_id || lineage.issue_id !== issue.id
        || lineage.scope_revision !== issue.scope_revision || !lineage.workflow_ids.includes(workflow.id) || !lineage.candidate_ids.includes(candidate.id)
        || lineage.corrections_consumed !== 1 || lineage.consumed_stage_id !== stage.id || !lineage.consumed_at
        || !replacement || replacement.id === candidate.id || replacement.invalidated_at !== null || replacement.issue_id !== issue.id
        || replacement.repository_id !== workflow.project_id || replacement.task_id !== task.envelope.id || replacement.execution_id !== stage.execution_id
        || replacement.scope_revision !== issue.scope_revision || replacement.base_revision !== candidate.candidate_revision
        || replacement.candidate_revision === candidate.candidate_revision || candidate.invalidated_at !== replacement.created_at
        || Date.parse(replacement.created_at) < Date.parse(lineage.consumed_at) || !produced || produced.at !== replacement.created_at
        || produced.scope_revision !== issue.scope_revision || produced.payload.scope_revision !== issue.scope_revision
        || produced.payload.candidate_revision !== replacement.candidate_revision || produced.payload.diff_fingerprint !== replacement.diff_fingerprint
        || pathsOutsideScope(replacement.changed_paths, issue.authorized_scope).length
        || replacement.diff_fingerprint !== createHash("sha256").update(`${replacement.repository_id}\0${replacement.base_revision}\0${replacement.candidate_revision}\0${replacement.changed_paths.join("\0")}`).digest("hex")) {
        throw new IssueServiceError("Workflow budget evidence has a stale retained correction replacement", 409);
      }
      evidenceCandidate = replacement; replacementCandidate = replacement;
    }
  }
  return { workflow, stage, grant, issue, task, evidence_candidate: evidenceCandidate,
    retained_candidate: workflow.candidate, replacement_candidate: replacementCandidate };
}

export function inspectWorkflowBudgetStopFacts(workflows: WorkflowDocument, issues: IssueDocument, workflowId: string, at: number) {
  return inspectBudgetStopFacts(workflows, issues, workflowId, at);
}

/** Strict evidence parser. Neither a summary nor its hash is runtime authority. */
export function parseIndependentWorkflowBudgetStopSummary(summary: string, binding: WorkflowBudgetBinding): IndependentBudgetStopData | null {
  if (typeof summary !== "string" || summary.length > 2000 || !summary.startsWith(INDEPENDENT_WORKFLOW_BUDGET_STOP_PREFIX)) return null;
  try {
    const value = JSON.parse(summary.slice(INDEPENDENT_WORKFLOW_BUDGET_STOP_PREFIX.length));
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "b,d,f,k,p,r,s"
      || [value.k, value.b, value.s, value.f].some((entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/.test(entry))
      || !["before-claim", "run"].includes(value.p) || (value.r === null ? value.p !== "before-claim" : typeof value.r !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.r))
      || !Array.isArray(value.d) || !value.d.length || value.d.length > BUDGET_DIMENSIONS.length + 1) return null;
    const count = (entry: unknown): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0;
    const denials: IndependentBudgetStopData["denials"] = [];
    for (const entry of value.d) {
      if (!Array.isArray(entry) || entry.length !== 5 || ![...BUDGET_DIMENSIONS, "accounting"].includes(entry[0])
        || entry[1] !== null && !count(entry[1]) || !count(entry[2]) || !count(entry[3])
        || !["budget-exhausted", "budget-accounting-unavailable"].includes(entry[4])
        || entry[4] === "budget-exhausted" && entry[1] === null) return null;
      denials.push({ dimension: entry[0], cap: entry[1], proven_consumed: entry[2], required: entry[3], code: entry[4] });
    }
    if (new Set(denials.map((entry) => entry.dimension)).size !== denials.length) return null;
    const data: IndependentBudgetStopData = { admission_fingerprint: value.b, policy_fingerprint: value.s, cap_fingerprint: value.f, run_id: value.r, phase: value.p, denials };
    return independentWorkflowBudgetStopSummary(binding, data) === summary ? data : null;
  } catch { return null; }
}

export function independentWorkflowBudgetStopKey(binding: WorkflowBudgetBinding, data: IndependentBudgetStopData): string {
  const summary = JSON.parse(independentWorkflowBudgetStopSummary(binding, data).slice(INDEPENDENT_WORKFLOW_BUDGET_STOP_PREFIX.length));
  const { d: _denials, ...identity } = summary;
  return `Independent workflow budget evidence ${workflowEvidenceHash(identity)}`;
}

/** Canonical P evidence only. It never adopts a lease or restores private execution authority. */
export function inspectIndependentWorkflowBudgetStopFacts(workflows: WorkflowDocument, issues: IssueDocument, workflowId: string,
  data: IndependentBudgetStopData, at: number, receipt?: unknown, repoRoot = process.cwd()) {
  const owner = workflows.workflows[workflowId], stage = owner?.current_stage_id ? workflows.stages[owner.current_stage_id] : null;
  const task = stage?.task_id ? readTask(stage.task_id) : null;
  if (!task || !validateTaskRecord(task)) throw new IssueServiceError("Independent budget task evidence is unavailable", 409);
  assertTaskBudgetAdmissionBinding(task);
  const admission = task.envelope.budget_admission, ledgerPath = budgetStatePath(), ledger = readBudgetLedger(ledgerPath);
  if (!admission || !ledger || data.admission_fingerprint !== workflowEvidenceHash(admission)
    || admission.workflow?.workflow_id !== workflowId || admission.workflow.stage_id !== stage!.id
    || admission.workflow.stage_generation !== stage!.generation || admission.workflow.grant_id !== owner!.current_grant_id
    || admission.issue_id !== owner!.issue_id || admission.scope_revision !== owner!.scope_revision
    || stage!.execution_id !== null && stage!.execution_id !== data.run_id) throw new IssueServiceError("Independent budget immutable admission is stale", 409);
  const reservation = ledger.reservations[admission.reservation_id], intent = ledger.admission_intents[admission.intent_id];
  const subject = { id: admission.subject_id, kind: "task", task_id: admission.task_id, project_id: admission.project_id,
    role_id: admission.role_id, agent_id: admission.agent_id, issue_id: admission.issue_id, workflow: admission.workflow, attribution: admission.attribution };
  const charges = Object.values(ledger.charges).filter((entry) => entry.reservation_id === admission.reservation_id);
  const charge = data.run_id === null ? null : charges.find((entry) => entry.run_id === data.run_id);
  if (!reservation || !intent || !isDeepStrictEqual(ledger.subjects[admission.subject_id], subject)
    || reservation.subject_id !== admission.subject_id || reservation.intent_id !== admission.intent_id || reservation.created_at !== admission.created_at
    || !isDeepStrictEqual(reservation.policy_bindings, admission.policy_bindings) || !["committed", "unknown"].includes(intent.status) || intent.admission_id !== admission.id
    || intent.subject_id !== admission.subject_id || intent.reservation_id !== reservation.id
    || charges.some((entry) => entry.subject_id !== admission.subject_id || entry.review !== (admission.caps.review_attempts > 0) || entry.correction !== (admission.caps.corrections > 0))
    || data.phase === "run" && (!charge || reservation.run_ids.at(-1) !== data.run_id || charges.length !== task.orchestration?.attempts)
    || data.phase === "before-claim" && (!["queued", "running"].includes(task.lifecycle)
      || task.lifecycle === "queued" && !!task.orchestration?.lease
      || task.lifecycle === "running" && task.orchestration?.lease?.run_id !== data.run_id
      || data.run_id !== null && (!charge || reservation.run_ids.at(-1) !== data.run_id)
      || charges.some((entry) => entry.status === "running" && entry.run_id !== data.run_id))) {
    throw new IssueServiceError("Independent budget canonical ownership is unavailable", 409);
  }
  const currentReceipt = receipt === undefined ? null : inspectBudgetStopReceipt(receipt, task);
  if (receipt !== undefined && !currentReceipt) throw new IssueServiceError("Independent budget private stop receipt is unavailable", 409);
  if (data.phase === "before-claim" && task.lifecycle === "running" && !currentReceipt) throw new IssueServiceError("Independent pre-bind evidence cannot restore a private claim", 409);
  let sourceFingerprint: string | null = null;
  if (currentReceipt) {
    if (currentReceipt.admission_fingerprint !== data.admission_fingerprint || currentReceipt.policy_fingerprint !== data.policy_fingerprint
      || currentReceipt.cap_fingerprint !== data.cap_fingerprint || currentReceipt.run_id !== data.run_id || currentReceipt.phase !== data.phase
      || data.denials.some((denial) => !currentReceipt.denials.some((current) => current.dimension === denial.dimension && current.cap === denial.cap
        && current.required === denial.required && current.code === denial.code && current.proven_consumed >= denial.proven_consumed))) {
      throw new IssueServiceError("Independent budget stop receipt has changed bindings", 409);
    }
  } else {
    // Only a reassemblable trusted static policy can complete a cross-store
    // evidence gap after restart. Unknown dynamic constraints are not guessed.
    const source = readBudgetPolicy(repoRoot), resolved = resolveBudgetPolicy({ source, attribution: admission.attribution,
      at: admission.created_at, base_caps: admission.caps, ledger,
      correction_lineages: Object.values(workflows.lineages).map(({ id, project_id, issue_id, workflow_ids }) => ({ id, project_id, issue_id, workflow_ids })) });
    sourceFingerprint = source.fingerprint;
    if (source.fingerprint !== data.policy_fingerprint || resolved.cap_fingerprint !== data.cap_fingerprint
      || resolved.cap_fingerprint !== admission.admitted_cap_fingerprint || !isDeepStrictEqual(resolved.policy_bindings, admission.policy_bindings)) {
      throw new IssueServiceError("Independent budget current policy cannot reconstruct retained evidence", 409);
    }
    const total = (dimension: IndependentBudgetStopData["denials"][number]["dimension"]) => charges.reduce((sum, entry) => sum
      + (dimension === "attempts" || dimension === "review_attempts" ? 1 : dimension === "runtime_ms" || dimension === "review_runtime_ms" ? entry.runtime_ms
        : dimension === "total_tokens" || dimension === "review_total_tokens" ? entry.observed_total_tokens ?? 0 : dimension === "corrections" ? entry.correction ? 1 : 0 : 0), 0);
    const unknown = reservation.status === "unknown" || reservation.uncertain_dimensions.length > 0
      || charges.some((entry) => entry.runtime_state === "unknown" || entry.usage_state === "unknown");
    for (const denial of data.denials) {
      if (denial.code === "budget-accounting-unavailable") {
        if (!unknown || denial.cap !== null || denial.dimension !== "accounting" || denial.proven_consumed !== 0 || denial.required !== 0) throw new IssueServiceError("Independent budget unknown evidence is no longer exact", 409);
        continue;
      }
      if (denial.dimension === "accounting") throw new IssueServiceError("Independent budget accounting cannot invent a numeric cap", 409);
      const consumed = total(denial.dimension), ceiling = resolved.ceilings[denial.dimension];
      if (data.phase !== "run" || !["runtime_ms", "total_tokens", "review_runtime_ms", "review_total_tokens"].includes(denial.dimension)
        || denial.required !== 0 || denial.cap !== ceiling || consumed < denial.proven_consumed || consumed < ceiling) {
        throw new IssueServiceError("Independent budget exhaustion cannot be reconstructed from canonical evidence", 409);
      }
    }
  }
  const facts = inspectBudgetStopFacts(workflows, issues, workflowId, at, data);
  return { ...facts, ledger, ledgerPath, source_fingerprint: sourceFingerprint, independent_stop: data };
}

function assertDispatchAdmission(value: unknown): void {
  if (value === undefined) return;
  const keys = ["role_id", "preview_fingerprint", "client_context_categories"];
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" || !keys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })) throw new IssueServiceError("Invalid issue dispatch admission fields");
}

function assertDeliveryData(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new IssueServiceError("Invalid delivery observation fields");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key)
    || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) throw new IssueServiceError("Invalid delivery observation fields");
}

/** A stable local read, not a cross-store transaction or authority receipt. */
function assertDeliveryCommitment(projectId: string, commitmentId: string): void {
  const path = resolve(clientPortfolioPath()), directory = resolve(path, ".."), drive = parse(directory).root;
  let fd: number | undefined;
  const boundary = () => {
    if (/^[\\/]{2}/.test(path)) throw new Error("unsafe");
    let current = drive;
    for (const part of directory.slice(drive.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe");
    }
    if (realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error("unsafe");
  };
  try {
    boundary();
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 10 * 1024 * 1024) throw new Error("unsafe");
    const same = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!same(fstatSync(fd))) throw new Error("changed");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length !== before.size || !same(fstatSync(fd)) || !same(lstatSync(path))) throw new Error("changed");
    boundary();
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!validateClientPortfolioDocument(document)
      || Object.entries(document.clients).some(([id, client]) => !isSafeIdentifier(id) || client.id !== id)
      || Object.entries(document.commitments).some(([id, commitment]) => !isSafeIdentifier(id) || commitment.id !== id)
      || document.commitments[commitmentId]?.project_id !== projectId) throw new Error("invalid");
  } catch { throw new IssueServiceError("Delivery commitment reference is missing, unsafe or unavailable; source bytes were preserved", 409); }
  finally { if (fd !== undefined) closeSync(fd); }
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
  if (to === "authorized" && check.rule.event !== type) {
    throw new IssueServiceError("issue transition rejected: transition-not-allowed", 409);
  }
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
    recordIndependentWorkflowBudgetExhaustion(workflowId: string, receipt?: unknown): boolean {
      const workflows = readWorkflowDocument(), workflow = workflows.workflows[workflowId];
      if (!workflow || workflow.status !== "needs-decision" || workflow.stop_requested_at || workflow.pending_decision_id) return false;
      const retained = workflows.events.filter((entry) => entry.workflow_id === workflowId && entry.type === "budget-stopped").at(-1);
      const consumption = projectWorkflowConsumption(workflows, workflowId), data = retained && parseIndependentWorkflowBudgetStopSummary(retained.summary, consumption.binding);
      if (!retained || !data || retained.stage_id !== consumption.binding.stage_id || retained.execution_id !== consumption.binding.execution_id) return false;
      const document = readIssueDocument(), issue = requireIssue(document, workflow.issue_id), key = independentWorkflowBudgetStopKey(consumption.binding, data);
      // The original immutable stop is consumed once, irrespective of later
      // usage high-water, finalized receipts or a human's explicit resume.
      if (document.events.some((entry) => entry.issue_id === issue.id && entry.payload.budget_stop_key === key
        && entry.payload.workflow_id === workflowId && entry.payload.stage_id === consumption.binding.stage_id
        && entry.payload.task_id === consumption.binding.task_id && entry.payload.execution_id === data.run_id)) return false;
      if (!["authorized", "working", "checking"].includes(issue.status)) return false;
      const facts = inspectIndependentWorkflowBudgetStopFacts(workflows, document, workflowId, data, now().getTime(), receipt, repoRoot), at = now().toISOString();
      return mutateIssueDocument((current) => {
        if (!isDeepStrictEqual(current, document) || !isDeepStrictEqual(readWorkflowDocument(), workflows)
          || !isDeepStrictEqual(readTask(facts.task.envelope.id), facts.task) || !isDeepStrictEqual(readBudgetLedger(facts.ledgerPath), facts.ledger)
          || facts.source_fingerprint !== null && readBudgetPolicy(repoRoot).fingerprint !== facts.source_fingerprint) {
          throw new IssueServiceError("Independent budget facts changed before canonical issue transition", 409);
        }
        const target = requireIssue(current, issue.id), candidate = facts.evidence_candidate;
        target.next_action = "Inspect the exact independent budget evidence; retained data cannot restore private execution or authorize another stage.";
        addEvidence(current, target, { task_id: facts.task.envelope.id, execution_id: data.run_id, candidate_id: candidate?.id ?? null,
          candidate_revision: candidate?.candidate_revision ?? null, diff_fingerprint: candidate?.diff_fingerprint ?? null, scope_revision: target.scope_revision,
          kind: "task", label: "Exact independent workflow budget stop requires a human decision", reference: key, status: "gap" }, at);
        const type = target.status === "authorized" ? "authorization-stale" : target.status === "working" ? "decision-required" : "verification-needs-decision";
        transition(current, target, "needs-decision", target.revision, type, { workflow_id: workflowId, stage_id: consumption.binding.stage_id,
          task_id: consumption.binding.task_id, execution_id: data.run_id, candidate_id: candidate?.id ?? null, grant_id: consumption.binding.grant_id,
          authority_revision: consumption.binding.authority_revision, scope_revision: target.scope_revision, budget_stop_key: key,
          retained_candidate: facts.retained_candidate, replacement_candidate: facts.replacement_candidate,
          independent_budget_exhaustion: data, budget_consumption: consumption,
          independent_budget_consumption: { reservation_id: facts.task.envelope.budget_admission!.reservation_id,
            charges: Object.values(facts.ledger.charges).filter((entry) => entry.reservation_id === facts.task.envelope.budget_admission!.reservation_id) } }, at);
        return true;
      });
    },
    recordWorkflowBudgetExhaustion(workflowId: string, operation: WorkflowBudgetStopOperation): boolean {
      const workflows = readWorkflowDocument(), workflow = workflows.workflows[workflowId];
      if (!workflow || workflow.status !== "needs-decision" || workflow.stop_requested_at || workflow.pending_decision_id) return false;
      const stop = evaluateWorkflowBudgetStop(workflows, workflowId, operation);
      if (!stop || !stop.denials.some((denial) => denial.code === "budget-exhausted" || denial.code === "budget-accounting-unavailable")) return false;
      const summary = workflowBudgetStopSummary(stop), retained = workflows.events.filter((entry) => entry.workflow_id === workflowId && entry.type === "budget-stopped").at(-1);
      if (!retained || retained.stage_id !== stop.binding.stage_id || retained.execution_id !== stop.binding.execution_id || retained.summary !== summary) {
        return false; // Unrelated human/recovery stops are not budget evidence.
      }
      const document = readIssueDocument(), issue = requireIssue(document, workflow.issue_id);
      // Check before acquiring the issue lock. The historical event remains
      // consumed even when a human later resumes; growing usage is not replay.
      if (document.events.some((entry) => entry.issue_id === issue.id && entry.payload.budget_stop_key === summary
        && entry.payload.workflow_id === workflowId && entry.payload.stage_id === stop.binding.stage_id
        && entry.payload.task_id === stop.binding.task_id && entry.payload.execution_id === stop.binding.execution_id)) return false;
      if (!["authorized", "working", "checking"].includes(issue.status)) return false;
      const facts = inspectWorkflowBudgetStopFacts(workflows, document, workflowId, now().getTime());
      const consumption = projectWorkflowConsumption(workflows, workflowId), at = now().toISOString();
      return mutateIssueDocument((current) => {
        if (!isDeepStrictEqual(current, document) || !isDeepStrictEqual(readWorkflowDocument(), workflows)
          || !isDeepStrictEqual(readTask(facts.task.envelope.id), facts.task)) throw new IssueServiceError("Workflow budget facts changed before canonical issue transition", 409);
        const target = requireIssue(current, issue.id), candidate = facts.evidence_candidate;
        target.next_action = "Inspect the exact retained budget evidence and explicitly decide the next action under current scope and policy.";
        addEvidence(current, target, { task_id: facts.task.envelope.id, execution_id: stop.binding.execution_id,
          candidate_id: candidate?.id ?? null, candidate_revision: candidate?.candidate_revision ?? null,
          diff_fingerprint: candidate?.diff_fingerprint ?? null, scope_revision: target.scope_revision, kind: "task",
          label: "Exact workflow budget exhaustion requires a human decision", reference: summary, status: "gap" }, at);
        const type = target.status === "authorized" ? "authorization-stale" : target.status === "working" ? "decision-required" : "verification-needs-decision";
        transition(current, target, "needs-decision", target.revision, type, { workflow_id: workflowId, stage_id: stop.binding.stage_id,
          task_id: stop.binding.task_id, execution_id: stop.binding.execution_id, candidate_id: candidate?.id ?? null,
          grant_id: stop.binding.grant_id, authority_revision: stop.binding.authority_revision,
          retained_candidate: facts.retained_candidate, replacement_candidate: facts.replacement_candidate,
          scope_revision: target.scope_revision, budget_stop_key: summary, budget_exhaustion: stop, budget_consumption: consumption }, at);
        return true;
      });
    },
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

    get(id: string): IssueLineage & { budget_readiness: IssueBudgetReadiness[]; budget_consumption?: IssueBudgetConsumption } {
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
      // P-only inspection never backfills envelopes or changes the O execution gate.
      const budget_readiness: IssueBudgetReadiness[] = [...new Set([...issue.task_ids, ...tasks.map((task) => task.envelope.id)])].map((task_id) => {
        try {
          const task = readTask(task_id);
          return { task_id, availability: task ? "available" : "unavailable", readiness: task ? taskBudgetReadiness(task) : null };
        } catch { return { task_id, availability: "unavailable", readiness: null }; }
      });
      let budget_consumption: IssueBudgetConsumption;
      try {
        const workflows = readWorkflowDocument();
        budget_consumption = { availability: "available", workflows: Object.values(workflows.workflows).filter((entry) => entry.issue_id === id)
          .map((entry) => projectWorkflowConsumption(workflows, entry.id)) };
      } catch { budget_consumption = { availability: "unavailable", workflows: [] }; }
      return { issue, tasks: taskLineage, candidates, evidence, evidence_gaps: gaps, sessions, budget_readiness, budget_consumption };
    },

    create(raw: IssueCreateInput): WorkIssue {
      const projectId = text(raw?.project_id, "project_id", 100);
      if (!projectIds().includes(projectId)) throw new IssueServiceError("project is not registered for local work", 404);
      const requestId = raw.request_id;
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))) {
        throw new IssueServiceError("request_id must be a canonical UUID");
      }
      if (Object.hasOwn(raw, "intake_receipt")) throw new IssueServiceError("intake_receipt is server-owned");
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
      const plan = raw.plan === undefined ? [] : optionalLabels(raw.plan, "plan", 30);
      const objectiveId = raw.objective_id ?? null;
      const parentId = raw.parent_issue_id ?? null;
      const blockers = optionalLabels(raw.blocked_by_issue_ids, "blocked_by_issue_ids", 100);
      const priority = raw.priority ?? 50;
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) throw new IssueServiceError("priority must be an integer from 0 to 100");
      // Reconstruct every original input field in a stable order. Source object
      // order and generated issue state must not change the intake binding.
      const normalized = {
        project_id: projectId, objective_id: objectiveId, parent_issue_id: parentId,
        title, expected_outcome: expectedOutcome, acceptance_criteria: criteria, authorized_scope: scope,
        classification_inputs: { affected_domains: affectedDomains, requires_migration: requiresMigration, security_impact: securityImpact },
        plan, priority, criticality,
        blocked_by_issue_ids: blockers, assigned_role_id: raw.assigned_role_id ? text(raw.assigned_role_id, "assigned_role_id", 100) : null,
        related_commitment_ids: optionalLabels(raw.related_commitment_ids, "related_commitment_ids", 100),
        external_references: externalReferences(raw.external_references),
        next_action: raw.next_action === undefined || raw.next_action === null || raw.next_action === "" ? null : text(raw.next_action, "next_action", 1000),
      };
      const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      // Only the keyed manual-intake path can omit a replacement on replay.
      const mutate = requestId === undefined ? mutateIssueDocument : mutateIssueDocumentIfChanged;
      return mutate((document) => {
        if (requestId !== undefined) {
          const existing = Object.values(document.issues).find((entry) => entry.intake_receipt?.request_id === requestId);
          if (existing) {
            if (existing.intake_receipt!.request_fingerprint !== fingerprint) throw new IssueServiceError("request_id is already bound to a different request", 409);
            return existing;
          }
        }
        if (Object.keys(document.issues).length >= 500) throw new IssueServiceError("local issue capacity reached", 409);
        if (objectiveId) {
          const organization = readOrganizationSnapshot();
          if (!organization.objectives.some((objective) => objective.id === objectiveId)
            || !organization.project_objectives[projectId]?.objective_ids.includes(objectiveId)) throw new IssueServiceError("objective must exist and be linked to this project", 409);
        }
        for (const referenceId of [parentId, ...blockers].filter((value): value is string => Boolean(value))) {
          const referenced = requireIssue(document, referenceId);
          if (referenced.project_id !== projectId) throw new IssueServiceError("parent and blocker issues must target the same project");
        }
        const classification = deriveScale(normalized, affectedDomains, requiresMigration, securityImpact, criticality, scope.allowed_change_categories);
        if (classification.scale === "substantial" && (plan.length === 0 || criteria.length < 2 || !normalized.next_action)) throw new IssueServiceError("substantial work requires a durable plan, at least two acceptance criteria, and a next action");
        const nowIso = now().toISOString();
        const issue: WorkIssue = {
          schema_version: 1, id: `I-${randomUUID()}`, ...normalized,
          ...(requestId === undefined ? {} : { intake_receipt: { schema_version: 1 as const, request_id: requestId, request_fingerprint: fingerprint } }),
          status: "proposed", work_scale: classification.scale, classification_rationale: classification.rationale, scope_revision: 1,
          scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null,
          task_ids: [], evidence_ids: [], candidate_ids: [], created_at: nowIso, updated_at: nowIso, revision: 1,
        };
        document.issues[issue.id] = issue;
        appendEvent(document, issue, "issue-proposed", { project_id: projectId, work_scale: issue.work_scale, classification_rationale: issue.classification_rationale }, nowIso);
        return issue;
      });
    },

    recordDeliveryObservation(id: string, raw: RecordDeliveryObservationInput): { issue: WorkIssue; evidence: IssueEvidenceReference } {
      assertDeliveryData(raw, ["project_id", "expected_revision", "scope_revision", "candidate_id", "candidate_revision", "diff_fingerprint", "delivery_observation", "confirm"]);
      assertDeliveryData(raw.delivery_observation, ["schema_version", "kind", "origin", "commitment_id", "occurred_at", "summary", "source_reference", "next_action"]);
      if (typeof id !== "string" || !/^I-[A-Fa-f0-9-]{36}$/.test(id) || !isSafeIdentifier(raw.project_id) || raw.confirm !== true
        || !Number.isSafeInteger(raw.expected_revision) || raw.expected_revision < 1 || !Number.isSafeInteger(raw.scope_revision) || raw.scope_revision < 1
        || !validateDeliveryObservation(raw.delivery_observation)) throw new IssueServiceError("Invalid delivery observation data");
      const observation = { ...raw.delivery_observation };
      if ([observation.summary, observation.source_reference, observation.next_action].some((value) => redactText(value) !== value)) {
        throw new IssueServiceError("Delivery observation appears to contain a credential; remove it before saving");
      }
      const unbound = raw.candidate_id === null && raw.candidate_revision === null && raw.diff_fingerprint === null;
      if (!unbound && (typeof raw.candidate_id !== "string" || !/^C-[A-Fa-f0-9-]{36}$/.test(raw.candidate_id)
        || typeof raw.candidate_revision !== "string" || !/^[a-f0-9]{40,64}$/.test(raw.candidate_revision)
        || typeof raw.diff_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.diff_fingerprint))) throw new IssueServiceError("Delivery candidate binding must be complete or explicitly absent");
      return mutateIssueDocument((document) => {
        const issue = requireIssue(document, id), recordedAt = now();
        if (issue.revision !== raw.expected_revision || issue.project_id !== raw.project_id || issue.scope_revision !== raw.scope_revision
          || !projectIds().includes(issue.project_id)) throw new IssueServiceError("Issue project, revision or scope changed; refresh before recording delivery", 409);
        if (!Number.isFinite(recordedAt.getTime()) || Date.parse(observation.occurred_at) > recordedAt.getTime()) throw new IssueServiceError("Delivery observation time cannot be in the future");
        try {
          if (Object.values(readWorkflowDocument().workflows).some((owner) => owner.issue_id === id && !["completed", "cancelled"].includes(owner.status))) {
            throw new IssueServiceError("Issue has an active workflow owner; record delivery after its terminal decision", 409);
          }
          const linked = issue.task_ids.map((taskId) => readTask(taskId));
          if (linked.some((task) => !task)) throw new IssueServiceError("Issue task ownership is unavailable; delivery was not recorded", 409);
          if ([...linked, ...listTasks().filter((task) => taskIssueId(task) === id)].some((task) => task && ["queued", "running"].includes(task.lifecycle))) {
            throw new IssueServiceError("Issue has an active task owner; delivery was not recorded", 409);
          }
        } catch (error) {
          if (error instanceof IssueServiceError) throw error;
          throw new IssueServiceError("Issue execution ownership is unavailable; delivery was not recorded", 409);
        }
        if (!unbound) {
          const candidate = document.candidates[raw.candidate_id!];
          if (!candidate || candidate.issue_id !== id || candidate.repository_id !== issue.project_id || issue.candidate_ids.at(-1) !== candidate.id
            || candidate.invalidated_at !== null || candidate.scope_revision !== issue.scope_revision
            || candidate.candidate_revision !== raw.candidate_revision || candidate.diff_fingerprint !== raw.diff_fingerprint) {
            throw new IssueServiceError("Delivery candidate reference is missing, stale or belongs to another project", 409);
          }
        }
        if (observation.commitment_id !== null) {
          if (!issue.related_commitment_ids.includes(observation.commitment_id)) throw new IssueServiceError("Delivery commitment must already be linked to this issue", 409);
          assertDeliveryCommitment(issue.project_id, observation.commitment_id);
        }
        if (issue.evidence_ids.filter((evidenceId) => Object.hasOwn(document.evidence[evidenceId]!, "delivery_observation")).length >= 64
          || issue.evidence_ids.length >= 500 || Object.keys(document.evidence).length >= 5000 || document.events.length >= 20_000) {
          throw new IssueServiceError("Delivery evidence capacity reached; existing history was preserved", 409);
        }
        const at = recordedAt.toISOString();
        const evidence = addEvidence(document, issue, { task_id: null, execution_id: null, candidate_id: raw.candidate_id,
          candidate_revision: raw.candidate_revision, diff_fingerprint: raw.diff_fingerprint, scope_revision: issue.scope_revision,
          kind: "work-product", label: "Operator-entered delivery observation", reference: `/api/work-issues/${issue.id}`,
          status: "informational", delivery_observation: observation }, at);
        appendEvent(document, issue, "delivery-observation-recorded", { evidence_id: evidence.id, kind: observation.kind,
          candidate_id: evidence.candidate_id, commitment_id: observation.commitment_id }, at);
        return { issue, evidence };
      });
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
        transition(document, issue, "authorized", expectedRevision, "decision-recorded", { approval_id: approval, rationale: reason, scope_revision: issue.scope_revision, scope_unchanged: true }, now().toISOString());
        for (const candidateId of issue.candidate_ids) {
          const candidate = document.candidates[candidateId];
          if (candidate && candidate.invalidated_at === null) candidate.invalidated_at = now().toISOString();
        }
        addEvidence(document, issue, { task_id: null, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: issue.scope_revision, kind: "review", label: "Human decision to resume under unchanged scope", reference: reason, status: "informational" }, now().toISOString());
        return issue;
      });
    },

    dispatch(id: string, expectedRevision: number, agent: string, admission?: { role_id?: string; preview_fingerprint?: string; client_context_categories?: unknown }): { issue: WorkIssue; taskId: string } {
      // Reject injected authority before the issue lock, preview or task effect.
      assertDispatchAdmission(admission);
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

    lineage(id: string): IssueLineage & { budget_readiness: IssueBudgetReadiness[]; budget_consumption?: IssueBudgetConsumption } { return this.get(id); },

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
