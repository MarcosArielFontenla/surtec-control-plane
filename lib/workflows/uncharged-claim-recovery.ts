import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { IssueDocument } from "../issues/types";
import type { TaskEvent, TaskRecord } from "../state/types";
import type { GovernedWorkflow, UnchargedClaimRecovery, WorkflowDocument } from "./types";
import { assertPlannerRecoveryPlainData, approvedPlannerRecovery } from "./planner-recovery";

export const claimRecoveryHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const claimRecoveryBytesHash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fail = (): never => { throw new Error("Uncharged claim recovery evidence is unavailable, changed or ineligible"); };
function requireClaim(ok: unknown): asserts ok { if (!ok) fail(); }
const equal = isDeepStrictEqual;
export const CLAIM_FAILURE = "Workflow attempt requires retained-fact review" as const;
export interface UnchargedClaimRecoveryRequest {
  workflowId: string;
  expectedRevision: number;
  expectedIssueRevision: number;
  expectedTaskRevision: number;
  packageFingerprint: string;
  runtimeRoot: string;
  archiveRoot: string;
  approvalId: string;
  confirm: true;
}
export const CLAIM_PRODUCER_PATHS = ["runner/task-orchestrator.ts", "runner/workflow-orchestrator.ts", "runner/run-task.ts", "lib/state/workflows.ts", "lib/workflows/validation.ts"] as const;
// Exact reviewed charge-before-run/finalizer/immutable-ledger producer; hashes
// contain no project paths, source bodies or private runtime identities.
const retainedProducer = [
  "1a945ccb03918823d0dc3e2940c54f66b13bf1d9bc5f45a63f20531cedb87f91",
  "dd6179e5fb58cc72419758d82818294f46292ac55507675530948340c692fb4c",
  "90d0903debdc20f541fd80efaefa1e30a36ab80b11fb43c3bbb120737ab7c662",
  "0c05418bbc8639f6a9f1b22457b803f0d520c399ab73aa22056f1801d1ad57bf",
  "ff537e17e592c3bd5846183cddf8b2d47152373151b7634901d71c92d36aba19",
];
const retainedOperator = "cecd33b1b0af3ce0914f78b2e09071f9fccd3639f383666ef6dc6f73506ec94b";
// Qualified current source profile. Filesystem changes never repin themselves;
// both historical and current operator/producer pairs must match exactly.
const currentProducer = [
  "ae285ae07a36e27343cfc1aacbee496cab6ebcf995a942711e3d2c6a72dcfac6",
  "d995c6b5924194ac989feec9c272cae298b29f936c5240e914aca199fdc22f81",
  "90d0903debdc20f541fd80efaefa1e30a36ab80b11fb43c3bbb120737ab7c662",
  "9e1bf920f34ca39147ed104e2ca7f872be7e08f98c49001c9e6bd4665f817748",
  "a9054f75be6a1adea004809d9525d33900d3caec5c7d321d34145500056b32ec",
];
const currentFixtureOperator = "fd744851a4dad07f0f2b2bf4872974b48d6fc3b33dee5311a0ebc1fb8122540f";
// Reviewed context-profile delta: charge ordering and both prior pairs stay intact.
// These are static public-source pins, never adopted from the live filesystem.
const contextProducer = [
  "ae285ae07a36e27343cfc1aacbee496cab6ebcf995a942711e3d2c6a72dcfac6",
  "d995c6b5924194ac989feec9c272cae298b29f936c5240e914aca199fdc22f81",
  "566703080806f778d57f0bc7cd41dbf29b964c529b9ec97d6c64ae983a0c5079",
  "9e1bf920f34ca39147ed104e2ca7f872be7e08f98c49001c9e6bd4665f817748",
  "a9054f75be6a1adea004809d9525d33900d3caec5c7d321d34145500056b32ec",
];
const contextFixtureOperator = "5324c4da653e7b03bcaee81c8e91cabeb69b84cd900196fbc85ad7cae008585a";

/** Pure evidence classification only; it cannot construct the opaque package proof. */
export function isReviewedClaimProducer(sources: readonly string[], operator: string): boolean {
  return equal(sources, retainedProducer) && operator === retainedOperator
    || equal(sources, currentProducer) && operator === currentFixtureOperator
    || equal(sources, contextProducer) && operator === contextFixtureOperator;
}

/** Synchronous bounded observation: no handle survives a return or an error. */
export function readClaimRecoveryFile(path: string, limit = 16 * 1024 * 1024): string {
  const absolute = resolve(path), drive = parse(absolute).root;
  let current = drive;
  const parts = absolute.slice(drive.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireClaim(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()));
  }
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    requireClaim(before.isFile() && before.nlink === 1 && before.size <= limit);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    requireClaim(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
function sourceHashes(root: string): string[] { return CLAIM_PRODUCER_PATHS.map((path) => claimRecoveryBytesHash(readClaimRecoveryFile(join(root, path), 262144))); }
export interface ClaimRecoveryPackage {
  document: WorkflowDocument;
  task: TaskRecord;
  events: TaskEvent[];
  events_text: string;
  issues: IssueDocument;
  source_fingerprint: string;
  archive_fingerprint: string;
  native_fingerprint: string;
  native_pid: number;
  native_result: Record<string, unknown>;
}
const packages = new WeakMap<object, ClaimRecoveryPackage>();
/** Filesystem qualification, never a JSON flag or caller-selected expected hash. */
export function inspectUnchargedClaimPackage(input: { runtimeRoot: string; archiveRoot: string }): object {
  assertPlannerRecoveryPlainData(input);
  requireClaim(Object.keys(input).length === 2 && Reflect.ownKeys(input).length === 2 && typeof input.runtimeRoot === "string" && typeof input.archiveRoot === "string");
  const sources = sourceHashes(input.runtimeRoot);
  const names = ["workflows.json", "task.json", "events.jsonl", "issues.json", "native.json", "operator.mjs"];
  const raw = names.map((name) => readClaimRecoveryFile(join(input.archiveRoot, name), name === "native.json" ? 262144 : 16 * 1024 * 1024));
  const operator = claimRecoveryBytesHash(raw[5]!);
  requireClaim(isReviewedClaimProducer(sources, operator));
  const native = JSON.parse(raw[4]!) as Record<string, unknown>;
  requireClaim(Number.isSafeInteger(native.pid) && Number(native.pid) > 0 && Number.isSafeInteger(native.native_exit)
    && [0, 1, 2].includes(native.native_exit as number) && native.native_signal === null
    && native.root_exit_observed === true && native.stdout_eof === true && native.stderr_eof === true
    && native.timed_out === false && native.capture_truncated === false && native.spawn_error === null
    && native.stream_error === null && native.termination_requested === false
    && Number.isSafeInteger(native.elapsed_ms) && Number(native.elapsed_ms) > 0 && Number(native.elapsed_ms) <= 900000
    && typeof native.stdout === "string" && Buffer.byteLength(native.stdout) <= 65536
    && typeof native.stderr === "string" && Buffer.byteLength(native.stderr) <= 65536);
  const lines = (native.stdout as string).trim().split(/\r?\n/);
  requireClaim(lines.length > 0);
  const terminal = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  requireClaim(terminal.status === "BLOCKED" && terminal.worker_stopped === true && terminal.active_tasks === 0 && terminal.plan_approved === true);
  const proof = Object.freeze({});
  packages.set(proof, { document: JSON.parse(raw[0]!), task: JSON.parse(raw[1]!), events: raw[2]!.trim().split(/\r?\n/).map((line) => JSON.parse(line)),
    events_text: raw[2]!, issues: JSON.parse(raw[3]!), source_fingerprint: claimRecoveryHash(sources),
    archive_fingerprint: claimRecoveryHash(names.map((name, index) => ({ name, sha256: claimRecoveryBytesHash(raw[index]!) }))),
    native_fingerprint: claimRecoveryBytesHash(raw[4]!), native_pid: Number(native.pid), native_result: terminal });
  return proof;
}
export function unchargedClaimPackage(proof: object): ClaimRecoveryPackage {
  const value = packages.get(proof); requireClaim(value);
  return structuredClone(value);
}
export function assertUnchargedClaimFacts(proof: object): ClaimRecoveryPackage {
  const p = unchargedClaimPackage(proof), d = p.document, t = p.task;
  assertPlannerRecoveryPlainData(d); assertPlannerRecoveryPlainData(t); assertPlannerRecoveryPlainData(p.issues);
  const admission = t.envelope.context_admission;
  requireClaim(admission?.schema_version === 2 && !Object.hasOwn(t.envelope, "budget_admission"));
  const w = d.workflows[admission.workflow_id], s = d.stages[admission.stage_id], issue = w && p.issues.issues[w.issue_id];
  const g = w && d.grants[w.current_grant_id], o = t.orchestration, failure = o?.last_failure;
  requireClaim(w && s && g && issue && o && failure && w.template_id === "implementation" && w.status === "needs-decision"
    && w.recovery_state === "awaiting-human" && !w.uncharged_claim_recovery && !w.stop_requested_at && !w.pending_decision_id
    && !w.candidate && !!w.approved_plan && !g.correction.enabled && w.stage_ids.length === 2 && w.current_stage_id === s.id
    && s.kind === "implementation" && s.ordinal === 2 && s.generation === 1 && s.status === "queued" && s.sandbox === "workspace-write"
    && s.phase === "execution" && !s.supersedes_stage_id && s.task_id === t.envelope.id && s.execution_id === null
    && s.output === null && s.output_fingerprint === null && s.candidate === null
    && g.id === s.grant_id && g.authority_revision === w.authority_revision && s.authority_revision === w.authority_revision
    && issue.project_id === w.project_id && issue.scope_revision === w.scope_revision && ["authorized", "working"].includes(issue.status)
    && issue.task_ids.includes(t.envelope.id) && issue.revision === admission.issue_revision
    && t.envelope.project === w.project_id && t.envelope.agent === s.agent_id && t.envelope.sandbox === "workspace-write"
    && admission.task_id === t.envelope.id && admission.grant_id === g.id && admission.authority_revision === g.authority_revision
    && admission.stage_generation === 1 && admission.stage_kind === "implementation" && admission.role_id === "software-engineer"
    && admission.issue_id === w.issue_id && admission.scope_revision === w.scope_revision
    && admission.manifest_fingerprint === s.context_fingerprint && t.envelope.context_manifest?.fingerprint === s.context_fingerprint
    && t.lifecycle === "finished" && t.outcome === "needs-review" && t.revision === 3 && o.attempts === 1
    && !o.lease && !o.retry_at && !o.cancel_requested_at && o.cumulative_tokens === 0 && o.max_attempts > 1
    && !Object.hasOwn(t.envelope.metadata, "run") && !Object.hasOwn(t, "testing_evidence") && t.logs_path === null
    && failure.kind === "terminal" && failure.message === CLAIM_FAILURE && !!failure.run_id && !!t.started_at && !!t.finished_at
    && t.result?.status === "needs-review" && t.result.summary === "Run failed: " + CLAIM_FAILURE
    && equal(t.result.blockers, [CLAIM_FAILURE]) && t.result.verification === null && t.result.logs_path === ""
    && [t.result.files_changed, t.result.commands_run, t.result.tests_run, t.result.risks, t.result.artifacts, t.result.next_steps].every((rows) => rows.length === 0));
  requireClaim(p.events.length === 3 && p.events.every((e) => e.task_id === t.envelope.id));
  const [policy, queued, claimed] = p.events;
  requireClaim(policy?.type === "policy-evaluated" && policy.revision === 1 && policy.run_id === null && policy.at === t.created_at
    && queued?.type === "queued" && queued.revision === 1 && queued.run_id === null && queued.at === t.created_at
    && claimed?.type === "claimed" && claimed.revision === 2 && claimed.at === t.started_at && claimed.run_id === failure.run_id && claimed.attempt === 1
    && typeof claimed.payload.worker_id === "string" && claimed.payload.worker_id.startsWith("worker-" + p.native_pid + "-")
    && Date.parse(t.finished_at!) >= Date.parse(t.started_at!) && failure.at === t.finished_at);
  const intent = Object.values(d.admission_intents).filter((entry) => entry.stage_id === s.id);
  requireClaim(intent.length === 1 && intent[0]!.status === "committed" && intent[0]!.task_id === t.envelope.id
    && intent[0]!.grant_id === g.id && intent[0]!.authority_revision === w.authority_revision
    && intent[0]!.context_fingerprint === s.context_fingerprint && intent[0]!.expected_issue_revision === issue.revision
    && queued.payload.intent_id === intent[0]!.id && policy.payload.allowed === true && policy.payload.workflow_id === w.id);
  const planner = d.stages[w.stage_ids[0]!], decision = d.decisions[w.approved_plan!.decision_id];
  requireClaim(planner && planner.kind === "planning" && s.predecessor_stage_id === planner.id
    && (planner.status === "completed" || !!approvedPlannerRecovery(d, planner))
    && w.approved_plan!.stage_id === planner.id && decision?.status === "approved" && decision.decided_by === "human" && !!decision.approval_id);
  requireClaim(Object.values(d.stages).filter((entry) => entry.workflow_id === w.id).length === 2
    && !Object.values(d.accounting).some((entry) => entry.task_id === t.envelope.id || entry.stage_id === s.id || entry.execution_id === failure.run_id)
    && !d.events.some((entry) => entry.execution_id === failure.run_id || entry.stage_id === s.id && ["stage-started", "stage-finished", "review-sealed"].includes(entry.type)));
  const charges = Object.values(d.accounting).filter((entry) => entry.workflow_id === w.id);
  requireClaim(charges.length === 1 && charges[0]!.stage_id === planner.id && charges[0]!.usage_complete
    && w.counters.tasks === 2 && w.counters.attempts === 1 && w.counters.runtime_ms === charges[0]!.active_runtime_ms
    && w.counters.total_tokens === charges[0]!.observed_tokens && !w.counters.accounting_complete);
  requireClaim(p.native_result.workflow_id === w.id && p.native_result.workflow_revision === w.revision && p.native_result.workflow_status === w.status
    && equal(p.native_result.counters, w.counters) && equal(p.native_result.budget, w.budget));
  return p;
}
export function requeuedClaimTask(task: TaskRecord, at: string): TaskRecord {
  const next = structuredClone(task);
  requireClaim(next.orchestration && Number.isSafeInteger(next.revision));
  next.revision = next.revision! + 1; next.lifecycle = "queued"; next.outcome = null;
  next.updated_at = at; next.finished_at = null; next.result = null;
  next.orchestration.last_failure = null;
  return next;
}
export function claimRecoveryProvenance(r: UnchargedClaimRecovery) {
  const { fingerprint: _fingerprint, phase: _phase, event_id: _event, event_fingerprint: _eventFingerprint, ...body } = r;
  return body;
}
export const claimRecoveryFingerprint = (r: UnchargedClaimRecovery): string => claimRecoveryHash(claimRecoveryProvenance(r));
export function prepareUnchargedClaimRecovery(proof: object, at: string, approvalId: string): UnchargedClaimRecovery {
  const p = assertUnchargedClaimFacts(proof), t = p.task, a = t.envelope.context_admission!;
  requireClaim(a.schema_version === 2 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(approvalId) && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(t.finished_at!));
  const w = p.document.workflows[a.workflow_id]!, s = p.document.stages[a.stage_id]!;
  const intent = Object.values(p.document.admission_intents).find((entry) => entry.stage_id === s.id)!;
  const next = requeuedClaimTask(t, at);
  const r: UnchargedClaimRecovery = { schema_version: 1, id: "UCR-" + randomUUID(), workflow_id: w.id, workflow_revision: w.revision,
    project_id: w.project_id, issue_id: w.issue_id, issue_revision: p.issues.issues[w.issue_id]!.revision, scope_revision: w.scope_revision,
    stage_id: s.id, task_id: t.envelope.id, original_run_id: t.orchestration!.last_failure!.run_id, task_revision: t.revision!,
    grant_id: s.grant_id, authority_revision: s.authority_revision, context_fingerprint: s.context_fingerprint!,
    approved_plan_fingerprint: claimRecoveryHash(w.approved_plan), intent_fingerprint: claimRecoveryHash(intent),
    grant_fingerprint: claimRecoveryHash(p.document.grants[s.grant_id]), issue_fingerprint: claimRecoveryHash(p.issues),
    task_fingerprint: claimRecoveryHash(t), events_fingerprint: claimRecoveryBytesHash(p.events_text),
    source_fingerprint: p.source_fingerprint, archive_fingerprint: p.archive_fingerprint, native_fingerprint: p.native_fingerprint,
    original_failure: structuredClone(t.orchestration!.last_failure!) as UnchargedClaimRecovery["original_failure"],
    original_started_at: t.started_at!, original_finished_at: t.finished_at!, original_counters: structuredClone(w.counters),
    requeued_task_revision: next.revision!, requeued_task_fingerprint: claimRecoveryHash(next),
    requested_by: "human", approval_id: approvalId, created_at: at, fingerprint: "", phase: "prepared", event_id: null, event_fingerprint: null };
  r.fingerprint = claimRecoveryFingerprint(r); return r;
}
export function claimRecoveryEventPayload(r: UnchargedClaimRecovery): Record<string, unknown> {
  return { boundary: "uncharged-claim-recovery", recovery_id: r.id, original_task_fingerprint: r.task_fingerprint,
    original_run_id: r.original_run_id, original_outcome: "needs-review", original_failure: structuredClone(r.original_failure),
    requeued_task_fingerprint: r.requeued_task_fingerprint };
}
/** Persisted structural provenance, never live recovery/execution authority. */
export function assertUnchargedClaimRecovery(document: WorkflowDocument, owner: GovernedWorkflow): void {
  const r = owner.uncharged_claim_recovery; if (!r) return;
  assertPlannerRecoveryPlainData(r);
  const s = document.stages[r.stage_id], grant = document.grants[r.grant_id];
  requireClaim(r.fingerprint === claimRecoveryFingerprint(r) && r.workflow_id === owner.id && r.project_id === owner.project_id
    && r.issue_id === owner.issue_id && r.requested_by === "human" && r.requeued_task_revision === r.task_revision + 1
    && r.original_failure.run_id === r.original_run_id && Date.parse(r.created_at) >= Date.parse(r.original_finished_at)
    && Date.parse(r.original_finished_at) >= Date.parse(r.original_started_at) && r.original_failure.at === r.original_finished_at
    && s?.workflow_id === owner.id && s.kind === "implementation" && s.ordinal === 2 && s.generation === 1 && s.task_id === r.task_id
    && s.context_fingerprint === r.context_fingerprint && s.grant_id === r.grant_id && s.authority_revision === r.authority_revision
    && grant && claimRecoveryHash(grant) === r.grant_fingerprint && claimRecoveryHash(owner.approved_plan) === r.approved_plan_fingerprint
    && !Object.values(document.accounting).some((entry) => entry.execution_id === r.original_run_id));
  for (const key of ["tasks", "attempts", "runtime_ms", "total_tokens"] as const) requireClaim(owner.counters[key] >= r.original_counters[key]);
  if (r.phase !== "ready") requireClaim(["needs-decision", "cancelled"].includes(owner.status) && !owner.counters.accounting_complete
    && owner.counters.tasks === r.original_counters.tasks && owner.counters.attempts === r.original_counters.attempts
    && owner.counters.runtime_ms === r.original_counters.runtime_ms && owner.counters.total_tokens === r.original_counters.total_tokens);
}
export function assertUnchargedClaimRecoveryMutation(before: WorkflowDocument, after: WorkflowDocument, owner: GovernedWorkflow): void {
  requireClaim(after.workflows[owner.id] === owner);
  const old = before.workflows[owner.id]?.uncharged_claim_recovery, r = owner.uncharged_claim_recovery;
  if (!old && !r) return;
  requireClaim(r);
  const previous = before.workflows[owner.id]!;
  if (!old) {
    requireClaim(previous.status === "needs-decision" && previous.recovery_state === "awaiting-human" && !previous.stop_requested_at
      && !previous.pending_decision_id && !previous.candidate && !!previous.approved_plan && r.phase === "prepared"
      && r.workflow_revision === previous.revision && equal(previous.counters, owner.counters) && equal(r.original_counters, previous.counters)
      && owner.status === "needs-decision" && owner.recovery_state === "awaiting-human");
    return;
  }
  requireClaim(equal(claimRecoveryProvenance(old), claimRecoveryProvenance(r)) && old.fingerprint === r.fingerprint);
  if (old.phase === r.phase) { requireClaim(equal(old, r)); return; }
  requireClaim(!previous.stop_requested_at && !owner.stop_requested_at && !previous.pending_decision_id && !owner.pending_decision_id
    && previous.status === "needs-decision" && previous.current_stage_id === r.stage_id && owner.current_stage_id === r.stage_id);
  if (old.phase === "prepared" && r.phase === "task-requeued") requireClaim(!!r.event_id && !!r.event_fingerprint
    && owner.status === "needs-decision" && equal(previous.counters, owner.counters));
  else if (old.phase === "task-requeued" && r.phase === "ready") {
    requireClaim(r.event_id === old.event_id && r.event_fingerprint === old.event_fingerprint && owner.status === "running"
      && owner.recovery_state === "none" && owner.counters.accounting_complete && !previous.counters.accounting_complete);
    for (const key of ["tasks", "attempts", "runtime_ms", "total_tokens"] as const) requireClaim(previous.counters[key] === owner.counters[key]);
  } else fail();
}
