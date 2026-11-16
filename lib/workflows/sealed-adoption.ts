import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { IssueDocument, WorkIssue } from "../issues/types";
import { isSafeIdentifier } from "../security/identifiers";
import type { TaskRecord } from "../state/types";
import { workflowEvidenceHash } from "./review-evidence";
import { assertResolvedWorkflowReviewPolicy } from "./review-policy";
import type { WorkflowDocument } from "./types";

export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isOid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const isId = (value: unknown): value is string => typeof value === "string" && isSafeIdentifier(value);
export const isIssueId = (value: unknown): value is string => typeof value === "string" && /^I-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export class AdoptionError extends Error {
  constructor(readonly outcome: "REFUSED" | "UNKNOWN", readonly code: string) { super(code); }
}
export function requireAdoption(condition: unknown, code: string, outcome: AdoptionError["outcome"] = "REFUSED"): asserts condition {
  if (!condition) throw new AdoptionError(outcome, code);
}

/** Check every component. Dossier paths are formed from a fixed root and names. */
export function physicalPath(path: string, directory: boolean, installedGit = false): Stats {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  let stat = lstatSync(root);
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    stat = lstatSync(current);
    requireAdoption(!stat.isSymbolicLink(), "UNSAFE_PATH");
    const file = index === parts.length - 1 && !directory;
    requireAdoption(file ? stat.isFile() && (installedGit || stat.nlink === 1) : stat.isDirectory(), "UNSAFE_PATH");
  }
  requireAdoption((directory ? stat.isDirectory() : stat.isFile()) && resolve(realpathSync.native(absolute)) === absolute, "UNSAFE_PATH");
  return stat;
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export function readAdoptionFile(path: string, limit = 64 * 1024): Buffer {
  const original = physicalPath(path, false);
  requireAdoption(original.size <= limit, "INPUT_LIMIT", "UNKNOWN");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireAdoption(sameFile(original, opened), "INPUT_CHANGED", "UNKNOWN");
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    requireAdoption(offset === opened.size && sameFile(opened, fstatSync(fd)) && sameFile(opened, physicalPath(path, false)), "INPUT_CHANGED", "UNKNOWN");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

export function hashAdoptionFile(path: string, limit: number, installedGit = false): string {
  const original = physicalPath(path, false, installedGit);
  requireAdoption(original.size <= limit, "INPUT_LIMIT", "UNKNOWN");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireAdoption(sameFile(original, opened), "INPUT_CHANGED", "UNKNOWN");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      requireAdoption(count > 0, "INPUT_CHANGED", "UNKNOWN");
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    requireAdoption(sameFile(opened, fstatSync(fd)) && sameFile(opened, physicalPath(path, false, installedGit)), "INPUT_CHANGED", "UNKNOWN");
    return hash.digest("hex");
  } finally { closeSync(fd); }
}


export function parseAdoptionJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AdoptionError("UNKNOWN", "INVALID_JSON"); }
}
export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const sealKeys = [
  "schema_version", "project_id", "issue_id", "issue_revision", "scope_revision", "scope_sha256",
  "workflow_id", "stage_id", "task_id", "run_id", "plan_sha256", "review_policy_sha256", "testing_policy_sha256",
  "base", "commit", "tree", "report_sha256", "verifier_pins_sha256",
] as const;
type SealKey = typeof sealKeys[number];
export type AdoptionSeal = { [K in SealKey]: K extends "schema_version" ? 1 : K extends "issue_revision" | "scope_revision" ? number : string };

export function readAdoptionSeal(bytes: Buffer, anchor: string): AdoptionSeal {
  requireAdoption(isDigest(anchor) && digest(bytes) === anchor, "SEAL_SHA256_MISMATCH");
  const seal = record(parseAdoptionJson(bytes));
  requireAdoption(seal && exact(seal, sealKeys) && seal.schema_version === 1 && isIssueId(seal.issue_id)
    && isRevision(seal.issue_revision) && isRevision(seal.scope_revision)
    && ["project_id", "workflow_id", "stage_id", "task_id", "run_id"].every((key) => isId(seal[key]))
    && ["base", "commit", "tree"].every((key) => isOid(seal[key])) && seal.base !== seal.commit
    && sealKeys.filter((key) => key.endsWith("_sha256")).every((key) => isDigest(seal[key])), "UNSUPPORTED_SEAL", "UNKNOWN");
  return seal as AdoptionSeal;
}

export interface AdoptionOwner {
  issue: WorkIssue;
  agent: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  requiredQa: boolean;
  stateFingerprint: string;
}

export function bindAdoptionOwner(input: { issues: IssueDocument; workflows: WorkflowDocument; tasks: TaskRecord[] }, seal: AdoptionSeal): AdoptionOwner {
  const { issues, workflows, tasks } = input;
  const issue = issues.issues[seal.issue_id], workflow = workflows.workflows[seal.workflow_id];
  requireAdoption(issue && workflow, "OWNER_UNAVAILABLE", "UNKNOWN");
  requireAdoption(issue.status === "needs-decision" && issue.revision === seal.issue_revision && issue.project_id === seal.project_id
    && issue.scope_revision === seal.scope_revision && !issue.scope_change_proposal
    && workflowEvidenceHash(issue.authorized_scope) === seal.scope_sha256
    && isDeepStrictEqual(issue.acceptance_criteria, issue.authorized_scope.acceptance_criteria), "ISSUE_BINDING_MISMATCH");
  requireAdoption(workflow.status === "needs-decision" && workflow.recovery_state === "awaiting-human"
    && workflow.issue_id === issue.id && workflow.project_id === issue.project_id && workflow.scope_revision === issue.scope_revision
    && workflow.current_stage_id === seal.stage_id && !workflow.pending_decision_id, "WORKFLOW_BINDING_MISMATCH");
  const stage = workflows.stages[seal.stage_id], grant = workflows.grants[workflow.current_grant_id];
  const task = tasks.find(({ envelope }) => envelope.id === seal.task_id);
  const charge = workflows.accounting[seal.run_id];
  const intent = Object.values(workflows.admission_intents).find((entry) => entry.stage_id === seal.stage_id);
  requireAdoption(stage && grant && task && charge && intent, "OWNER_UNAVAILABLE", "UNKNOWN");
  const admission = task.envelope.context_admission, orchestration = task.orchestration;
  const run = record(task.envelope.metadata.run);
  requireAdoption(task.lifecycle === "finished" && orchestration?.lease === null && orchestration.retry_at === null
    && ["needs-review", "failed", "cancelled"].includes(stage.status), "OWNER_NOT_INACTIVE", "UNKNOWN");
  requireAdoption(stage.workflow_id === workflow.id && stage.sandbox === "workspace-write"
    && (stage.kind === "implementation" || stage.kind === "correction") && stage.task_id === seal.task_id
    && stage.execution_id === seal.run_id && stage.grant_id === grant.id && stage.authority_revision === workflow.authority_revision
    && grant.workflow_id === workflow.id && grant.issue_id === issue.id && grant.project_id === issue.project_id
    && grant.scope_revision === issue.scope_revision && grant.authority_revision === workflow.authority_revision && grant.approved_by === "human"
    && isDeepStrictEqual(grant.authorized_scope, issue.authorized_scope)
    && intent.status === "committed" && intent.workflow_id === workflow.id && intent.grant_id === grant.id
    && intent.task_id === seal.task_id && intent.authority_revision === workflow.authority_revision
    && intent.context_fingerprint === stage.context_fingerprint
    && charge.execution_id === seal.run_id && charge.workflow_id === workflow.id && charge.stage_id === stage.id
    && charge.task_id === seal.task_id && charge.attempt_charged && charge.attempt === orchestration.attempts
    && orchestration.last_failure?.run_id === seal.run_id, "EXECUTION_BINDING_MISMATCH");
  requireAdoption(task.envelope.project === issue.project_id && task.envelope.agent === stage.agent_id && task.envelope.sandbox === "workspace-write"
    && issue.task_ids.at(-1) === task.envelope.id && admission?.schema_version === 2 && admission.task_id === task.envelope.id
    && admission.workflow_id === workflow.id && admission.stage_id === stage.id && admission.stage_kind === stage.kind
    && admission.stage_generation === stage.generation && admission.grant_id === grant.id && admission.authority_revision === workflow.authority_revision
    && admission.issue_id === issue.id && admission.scope_revision === issue.scope_revision && admission.scope_fingerprint === seal.scope_sha256
    && admission.role_id === stage.role_id && admission.manifest_fingerprint === stage.context_fingerprint
    && task.envelope.context_manifest?.fingerprint === stage.context_fingerprint
    && run && typeof run.worktree_path === "string" && isAbsolute(run.worktree_path) && typeof run.branch === "string"
    && typeof task.envelope.repo_path === "string" && isAbsolute(task.envelope.repo_path), "EXECUTION_BINDING_MISMATCH");
  const plan = workflow.approved_plan;
  const decision = plan && workflows.decisions[plan.decision_id];
  requireAdoption(plan && plan.output_fingerprint === seal.plan_sha256 && isDeepStrictEqual(admission.approved_plan, plan)
    && decision?.workflow_id === workflow.id && decision.kind === "plan-approval" && decision.status === "approved"
    && decision.decided_by === "human" && !!decision.approval_id, "PLAN_BINDING_MISMATCH");
  const review = workflow.review_policy;
  requireAdoption(review && review.fingerprint === seal.review_policy_sha256 && grant.testing_policy_fingerprint === seal.testing_policy_sha256
    && grant.testing_mode === "functional" && (grant.minimum_review_depth !== "full" || review.effective_depth === "full"),
  "POLICY_BINDING_MISMATCH");
  assertResolvedWorkflowReviewPolicy(review);
  requireAdoption(stage.kind !== "correction" || admission.candidate?.candidate_revision === seal.base, "BASE_BINDING_MISMATCH");

  const activeCandidate = issue.candidate_ids.at(-1);
  const latest = activeCandidate && issues.candidates[activeCandidate];
  requireAdoption(!activeCandidate || latest, "CANDIDATE_UNAVAILABLE", "UNKNOWN");
  const candidateMatches = (candidate: { task_id: string; execution_id: string; base_revision: string; scope_revision: number; candidate_revision: string }) =>
    candidate.task_id === seal.task_id && candidate.execution_id === seal.run_id && candidate.base_revision === seal.base
    && candidate.scope_revision === seal.scope_revision && candidate.candidate_revision === seal.commit;
  requireAdoption((!latest || (latest.invalidated_at === null && candidateMatches(latest)))
    && (!workflow.candidate || candidateMatches(workflow.candidate)), "SUPERSEDED_CANDIDATE");
  const competingWorkflow = Object.values(workflows.workflows).some((other) => other.id !== workflow.id && other.project_id === issue.project_id
    && !["completed", "cancelled"].includes(other.status)
    && other.stage_ids.some((id) => workflows.stages[id]?.sandbox === "workspace-write"));
  requireAdoption(!competingWorkflow && !tasks.some((entry) => entry.envelope.project === issue.project_id && entry.envelope.sandbox === "workspace-write"
    && (entry.lifecycle !== "finished" || !!entry.orchestration?.lease)), "PROJECT_WRITER_ACTIVE", "UNKNOWN");
  requireAdoption(!issue.task_ids.some((id) => !tasks.some(({ envelope }) => envelope.id === id)), "OWNER_UNAVAILABLE", "UNKNOWN");
  return { issue, agent: task.envelope.agent, repoPath: task.envelope.repo_path, worktreePath: run.worktree_path, branch: run.branch,
    requiredQa: review.qa_required || grant.role_assignments.some((role) => role.role_id === "qa-evaluator"),
    stateFingerprint: workflowEvidenceHash({ issue, workflow, stage, grant, intent, charge, task, decision, latest }) };
}

const stageOrder = ["V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08"];
const sessionIds = ["id", "containerId", "database", "workspace", "apiPid", "frontendPid", "browserPid", "apiPort", "frontendPort", "browserPort", "profile"];
const sessionFacts = ["registration", "list", "item", "persistence", "purchased", "archive", "unauthenticated", "isolation", "noMocks", "dbConfirmed", "ownedClosure"];

export function inspectAdoptionReport(bytes: Buffer, seal: Pick<AdoptionSeal, "commit" | "tree" | "report_sha256">, contentFingerprint: string, counts: { frontend: number; backend: number }): void {
  requireAdoption(digest(bytes) === seal.report_sha256, "REPORT_SHA256_MISMATCH");
  const report = record(parseAdoptionJson(bytes));
  requireAdoption(report?.schema_version === 1, "UNSUPPORTED_REPORT", "UNKNOWN");
  requireAdoption(report.outcome !== "FAIL", "VERIFICATION_FAILED");
  requireAdoption(report.outcome === "PASS" && report.reason === null && report.real_model_calls === false
    && Array.isArray(report.observation_errors) && !report.observation_errors.length
    && Array.isArray(report.successors_not_run) && !report.successors_not_run.length, "REPORT_INCOMPLETE", "UNKNOWN");
  const candidate = record(report.candidate);
  requireAdoption(candidate?.commit === seal.commit && candidate.tree === seal.tree && candidate.fingerprint === contentFingerprint, "REPORT_CANDIDATE_MISMATCH");
  requireAdoption(candidate.sealed === true && Array.isArray(report.stages) && report.stages.length === stageOrder.length, "REPORT_INCOMPLETE", "UNKNOWN");
  for (const [index, id] of stageOrder.entries()) {
    const stage = record(report.stages[index]);
    requireAdoption(stage?.id === id && stage.outcome === "PASS", "REPORT_INCOMPLETE", "UNKNOWN");
    if (id === "V08") {
      requireAdoption(stage.sealed === true, "REPORT_INCOMPLETE", "UNKNOWN");
      continue;
    }
    const native = record(stage.native);
    requireAdoption(stage.reason === null && native?.native_exit === 0 && native.native_signal === null
      && ["root_exit_observed", "stdout_eof", "stderr_eof"].every((field) => native[field] === true)
      && ["timed_out", "capture_truncated", "termination_requested"].every((field) => native[field] === false)
      && native.spawn_error === null && native.stream_error === null, "REPORT_NATIVE_INCOMPLETE", "UNKNOWN");
    if (id === "V01" || id === "V02" || id === "V06") {
      const coverage = record(stage.coverage);
      const count = id === "V01" ? coverage?.tests : id === "V02" ? counts.frontend : counts.backend;
      requireAdoption(isRevision(count) && coverage?.tests === count && coverage.passed === count && coverage.failed === 0
        && (id !== "V01" || (coverage.skipped === 0 && coverage.cancelled === 0 && coverage.todo === 0))
        && (id !== "V02" || coverage.pending === 0), "REPORT_COVERAGE_INCOMPLETE", "UNKNOWN");
    }
  }
  requireAdoption(Array.isArray(report.sessions) && report.sessions.length === 2, "REPORT_SESSIONS_INCOMPLETE", "UNKNOWN");
  const left = record(report.sessions[0]), right = record(report.sessions[1]);
  requireAdoption(left && right, "REPORT_SESSIONS_INCOMPLETE", "UNKNOWN");
  for (const key of sessionIds) {
    const valid = (value: unknown) => key.endsWith("Pid") || key.endsWith("Port") ? isRevision(value) : typeof value === "string" && !!value.trim();
    requireAdoption(valid(left[key]) && valid(right[key]) && left[key] !== right[key], "REPORT_SESSIONS_INCOMPLETE", "UNKNOWN");
  }
  for (const session of [left, right]) {
    const facts = record(session.facts);
    requireAdoption(session.origin === "operator-observed-v1" && facts && sessionFacts.every((key) => facts[key] === true),
      "REPORT_SESSIONS_INCOMPLETE", "UNKNOWN");
  }
}
