import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AuthorizedScope } from "../issues/types";
import { isSafeIdentifier } from "../security/identifiers";
import { validateTaskEvent, validateTaskRecord, validateWorkIssue } from "../state/validation";
import { digest, isDigest, inspectAdoptionReport, parseAdoptionJson, readAdoptionFile, record, requireAdoption } from "./sealed-adoption";

export interface HistoricalProfile {
  id: "gear-list-f5";
  sealSha: string;
  acceptanceSha: string;
}

export const gearListHistoricalProfileId = "gear-list-f5";

type Data = Record<string, unknown>;
const maxDocumentBytes = 16 * 1024 * 1024;
const criteriaIds = Array.from({ length: 8 }, (_, i) => "F3-0" + (i + 1));
const gitId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function object(value: unknown): Data {
  const data = record(value);
  requireAdoption(data, "HISTORICAL_EVIDENCE_INVALID", "UNKNOWN");
  return data;
}
function versionOne(value: unknown): Data {
  const data = object(value);
  requireAdoption(data.schema_version === 1, "HISTORICAL_EVIDENCE_VERSION", "UNKNOWN");
  return data;
}
function string(value: unknown): string {
  requireAdoption(typeof value === "string" && value.length > 0 && value.length <= 4096, "HISTORICAL_EVIDENCE_INVALID", "UNKNOWN");
  return value;
}
function oid(value: unknown): string {
  requireAdoption(gitId(value), "HISTORICAL_GIT_BINDING");
  return value;
}
export function historicalPathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}
function absolute(value: unknown): string {
  const path = string(value);
  requireAdoption(isAbsolute(path), "HISTORICAL_PATH_BINDING");
  return resolve(path);
}
function safeRelative(path: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..");
}
function pathList(value: unknown): string[] {
  requireAdoption(Array.isArray(value) && value.length > 0 && value.length <= 300
    && value.every((p) => typeof p === "string" && safeRelative(p)) && new Set(value).size === value.length, "HISTORICAL_SCOPE_MISMATCH");
  return value as string[];
}
function samePaths(left: string[], right: string[]): boolean {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}
function historicalOidPair(data: unknown, commit: string, tree: string): boolean {
  const id = record(data);
  return id?.commit === commit && id.tree === tree;
}

export function checkHistoricalNative(value: unknown): void {
  const native = record(value);
  requireAdoption(native?.native_exit === 0 && native.native_signal === null && native.root_exit_observed === true
    && native.stdout_eof === true && native.stderr_eof === true && native.timed_out === false
    && native.capture_truncated === false && native.termination_requested === false
    && native.spawn_error === null && native.stream_error === null, "HISTORICAL_VERIFICATION_INCOMPLETE", "UNKNOWN");
}

export function inspectHistoricalDecision(acceptance: Data, reviewer: Data, identity: { commit: string; tree: string; sealSha: string; reportSha: string }) {
  const { commit, tree, sealSha, reportSha } = identity;
  const evidence = object(acceptance.evidence), review = object(reviewer.evidence), qa = object(evidence.qa);
  const phases = object(acceptance.phases), integration = object(acceptance.integration);
  requireAdoption(acceptance.project === "Gear List" && acceptance.status === "ACCEPTED_LOCALLY" && acceptance.canonical_g3_created === false
    && historicalOidPair(acceptance.candidate, commit, tree) && object(evidence.dossier).sha256 === sealSha
    && evidence.verification_report_sha256 === reportSha && phases.F3 === "closed" && phases.F5 === "closed"
    && integration.status === "not_performed" && integration.f4_n11 === "not_applicable", "HISTORICAL_ACCEPTANCE_MISMATCH");
  requireAdoption(reviewer.decision === "approved" && Array.isArray(reviewer.observations) && !reviewer.observations.length
    && historicalOidPair(reviewer.candidate, commit, tree) && object(review.dossier_seal).sha256 === sealSha
    && review.verification_report_sha256 === reportSha && object(evidence.reviewer).decision === "approved"
    && qa.technical_verdict === "favorable" && qa.owner_decision === "confirmed", "HISTORICAL_REVIEW_MISMATCH");
  requireAdoption(Array.isArray(acceptance.criteria) && acceptance.criteria.length === criteriaIds.length, "HISTORICAL_CRITERIA_MISMATCH");
  const criteria = acceptance.criteria.map(object);
  requireAdoption(criteria.every((entry, i) => entry.id === criteriaIds[i] && entry.decision === "accepted"), "HISTORICAL_CRITERIA_MISMATCH");
  const recorded_at_utc = string(acceptance.recorded_at_utc);
  requireAdoption(Number.isFinite(Date.parse(recorded_at_utc)), "HISTORICAL_ACCEPTANCE_MISMATCH");
  return { status: "ACCEPTED_LOCALLY" as const, recorded_at_utc, criteria: criteriaIds.map((id) => ({ id, decision: "accepted" as const })),
    phases: { F3: "closed", F5: "closed" }, integration: { status: "not_performed", f4_n11: "not_applicable" } };
}

export interface HistoricalCandidate {
  worktree: string;
  commit: string;
  tree: string;
  dossierSha: string;
  reportSha: string;
  report: Buffer;
}
export interface HistoricalEvidence {
  id: HistoricalProfile["id"];
  source: string;
  commonDir: string;
  worktreeParent: string;
  git: { executable: string; sha256: string };
  base: string;
  original: { worktree: string; branch: string; indexSha: string; taskId: string; agent: string };
  project: string;
  issueId: string;
  workflowId: string;
  runId: string;
  scope: AuthorizedScope;
  paths: string[];
  correctionPaths: string[];
  prior: HistoricalCandidate;
  corrected: HistoricalCandidate;
  verification: { frontend: number; backend: number; verifierSha: string };
  acceptanceSha: string;
  acceptance: ReturnType<typeof inspectHistoricalDecision>;
  evidenceSha: string;
}

export function readHistoricalEvidence(root: string, profile: HistoricalProfile): HistoricalEvidence {
  const priorRoot = join(root, "tmp", "f3-adopt"), finalRoot = join(root, "tmp", "f3-fix");
  const g2Root = join(root, "tmp", "f3-live-g2-binding"), liveRoot = join(root, "tmp", "f3-live");
  const reportRoot = join(root, "tmp", "f3-p3", "r"), priorVerifierRoot = join(root, "tmp", "f3-p3", "v");
  const fingerprint = new Map<string, string>();
  // Fixed paths and paths carried by already anchored records only.
  const read = (path: string, expected: unknown, code = "HISTORICAL_EVIDENCE_SHA256_MISMATCH") => {
    const bytes = readAdoptionFile(path, maxDocumentBytes);
    const sha = digest(bytes);
    requireAdoption(isDigest(expected) && sha === expected, code);
    fingerprint.set(path, sha);
    return bytes;
  };
  const readJson = (path: string, expected: unknown, code?: string) => versionOne(parseAdoptionJson(read(path, expected, code)));
  const fixedFile = (directory: string, path: unknown) => {
    const relativeName = string(path);
    requireAdoption(safeRelative(relativeName), "HISTORICAL_PATH_BINDING");
    return join(directory, relativeName);
  };
  const reference = (directory: string, value: unknown, name: string) => {
    const ref = object(value);
    requireAdoption(ref.path === name && isDigest(ref.sha256), "HISTORICAL_EVIDENCE_REFERENCE");
    return read(fixedFile(directory, ref.path), ref.sha256);
  };
  const validateManifest = (directory: string, list: unknown) => {
    requireAdoption(Array.isArray(list) && list.length > 0 && list.length <= 32, "HISTORICAL_EVIDENCE_INVALID", "UNKNOWN");
    const rows = new Map<string, Buffer>();
    for (const raw of list) {
      const entry = object(raw), name = string(entry.path);
      requireAdoption(!rows.has(name), "HISTORICAL_EVIDENCE_REFERENCE");
      rows.set(name, read(fixedFile(directory, name), entry.sha256));
    }
    return rows;
  };
  const manifestJson = (manifest: Map<string, Buffer>, name: string) => {
    const value = manifest.get(name);
    requireAdoption(value, "HISTORICAL_EVIDENCE_REFERENCE", "UNKNOWN");
    return versionOne(parseAdoptionJson(value));
  };
  const pins = (directory: string, value: unknown) => {
    const entries = object(value);
    requireAdoption(Object.keys(entries).length <= 32, "HISTORICAL_EVIDENCE_INVALID", "UNKNOWN");
    const files = new Map<string, Buffer>();
    for (const [name, sha] of Object.entries(entries)) files.set(name, read(fixedFile(directory, name), sha));
    return files;
  };
  const finalSeal = readJson(join(finalRoot, "seal.json"), profile.sealSha, "HISTORICAL_SEAL_SHA256_MISMATCH");
  const acceptance = readJson(join(finalRoot, "local-acceptance.json"), profile.acceptanceSha, "HISTORICAL_ACCEPTANCE_SHA256_MISMATCH");
  const priorSealSha = string(finalSeal.previous_dossier_sha256);
  const priorSeal = readJson(join(priorRoot, "seal.json"), priorSealSha, "HISTORICAL_SEAL_SHA256_MISMATCH");
  const oldFiles = validateManifest(priorRoot, priorSeal.files);
  const newFiles = validateManifest(finalRoot, finalSeal.files);
  const oldCandidate = manifestJson(oldFiles, "candidate.json"), newCandidate = manifestJson(newFiles, "candidate.json");
  const approved = manifestJson(oldFiles, "adoption-issued.json");
  const prepared = manifestJson(newFiles, "preparation.json");
  const g2Files = pins(g2Root, approved.retained_g2_pins);
  pins(liveRoot, approved.retained_g1_pins);
  const result = manifestJson(g2Files, "G2-result.json"), binding = manifestJson(g2Files, "plan-patch-binding.json");
  const originalApproval = manifestJson(g2Files, "G2-approval.json");
  const issued = manifestJson(g2Files, "G2-issued.json");
  requireAdoption(issued.gate_sha256 === digest(g2Files.get("G2-approval.json")!)
    && issued.binding_sha256 === digest(g2Files.get("plan-patch-binding.json")!)
    && issued.seal_sha256 === digest(g2Files.get("seal.json")!) && originalApproval.schema_version === 1,
  "HISTORICAL_ISSUED_MISMATCH");

  const base = oid(oldCandidate.base), priorCommit = oid(priorSeal.commit), priorTree = oid(priorSeal.tree);
  const finalCommit = oid(finalSeal.commit), finalTree = oid(finalSeal.tree), patch = object(binding.patch);
  const paths = pathList(oldCandidate.paths), correctionPaths = pathList(newCandidate.correction_paths);
  requireAdoption(historicalOidPair(oldCandidate, priorCommit, priorTree) && historicalOidPair(newCandidate, finalCommit, finalTree)
    && newCandidate.base === base && newCandidate.parent === priorCommit && newCandidate.previous_dossier_sha256 === priorSealSha
    && prepared.candidate_parent === priorCommit && prepared.previous_seal_sha256 === priorSealSha
    && patch.base_revision === base && patch.expected_tree === priorTree && approved.tree === priorTree && approved.base === base
    && patch.sha256 === oldCandidate.patch_sha256 && patch.sha256 === approved.patch_sha256
    && samePaths(paths, pathList(patch.paths)) && samePaths(paths, pathList(newCandidate.paths))
    && correctionPaths.every((path) => paths.includes(path)), "HISTORICAL_LINEAGE_MISMATCH");
  const patchBytes = read(join(root, "tmp", "f3-diff", "rehearsal.diff"), patch.sha256);
  requireAdoption(patchBytes.length === patch.bytes && approved.source === "actual-user-chat"
    && approved.origin === "human-authorized adoption of the retained staged tree" && approved.model_calls_authorized === 0
    && approved.isolated_commit_authorized === true && approved.verifier_invocations_authorized === 1
    && approved.publication_authorized === false && isDeepStrictEqual(approved.approved_criteria_delta, ["F3-01", "F3-07"]),
  "HISTORICAL_ADOPTION_APPROVAL_MISMATCH");

  const state = object(result.state_after);
  const readState = (name: string) => read(fixedFile(join(liveRoot, "s"), name), state[name], "HISTORICAL_STOPPED_STATE_CHANGED");
  // These exact bytes belong to an archive, which may contain workflow facets
  // from another product revision. Validate the named records and their links.
  const workflows = versionOne(parseAdoptionJson(readState("workflows/workflows.json")));
  const issues = object(versionOne(parseAdoptionJson(readState("issues/issues.json"))).issues);
  const issueId = string(oldCandidate.source_issue), workflowId = string(oldCandidate.source_workflow);
  const taskId = string(oldCandidate.source_attempt), runId = string(oldCandidate.source_execution_id);
  requireAdoption(isSafeIdentifier(taskId), "HISTORICAL_EXECUTION_MISMATCH");
  const task = parseAdoptionJson(readState("tasks/" + taskId + ".json"));
  const workflow = versionOne(object(workflows.workflows)[workflowId]);
  // Intake idempotency is unrelated to adoption. Project only the issue fields
  // shared across supported readers, after authenticating the full archive.
  const issue = { ...versionOne(issues[issueId]) };
  delete issue.intake_receipt;
  requireAdoption(validateTaskRecord(task) && validateWorkIssue(issue), "HISTORICAL_STOPPED_STATE_UNAVAILABLE", "UNKNOWN");
  const stage = versionOne(object(workflows.stages)[string(workflow.current_stage_id)]);
  const charge = versionOne(object(workflows.accounting)[runId]);
  const plan = object(workflow.approved_plan), admission = task.envelope.context_admission, orchestration = task.orchestration;
  const decision = versionOne(object(workflows.decisions)[string(plan.decision_id)]);
  const run = object(task.envelope.metadata.run);
  requireAdoption(result.worker_stopped === true && result.status === "STOPPED_FOR_REVIEW" && result.workflow_id === workflowId
    && result.workflow_status === "needs-decision" && workflow.status === "needs-decision" && workflow.candidate === null
    && workflow.pending_decision_id === null && workflow.id === workflowId && workflow.issue_id === issueId
    && issue.id === issueId && issue.status === "needs-decision" && issue.task_ids.includes(taskId)
    && issue.project_id === "gear-list-app" && task.envelope.project === issue.project_id && workflow.project_id === issue.project_id
    && task.lifecycle === "finished" && orchestration?.lease === null && orchestration.retry_at === null
    && task.outcome === "failed" && task.outcome === oldCandidate.source_attempt_outcome && orchestration.last_failure?.kind === "budget"
    && orchestration.last_failure.run_id === runId && task.envelope.id === taskId && task.envelope.sandbox === "workspace-write",
  "HISTORICAL_OWNER_NOT_INACTIVE", "UNKNOWN");
  requireAdoption(stage.id === workflow.current_stage_id && stage.workflow_id === workflowId && stage.kind === "implementation"
    && stage.task_id === taskId && stage.execution_id === runId && charge.execution_id === runId
    && charge.task_id === taskId && charge.workflow_id === workflowId && charge.stage_id === stage.id && charge.attempt_charged === true
    && charge.observed_tokens === oldCandidate.source_tokens_observed && charge.usage_complete === false && oldCandidate.source_usage_complete === false
    && isDeepStrictEqual(workflow.counters, oldCandidate.counters) && isDeepStrictEqual(workflow.counters, result.counters)
    && admission?.schema_version === 2 && admission.workflow_id === workflowId && admission.stage_id === stage.id
    && admission.issue_id === issueId && admission.task_id === taskId && admission.scope_revision === issue.scope_revision
    && admission.scope_fingerprint === binding.scope_sha256 && isDeepStrictEqual(admission.approved_plan, plan)
    && binding.issue_id === issueId && binding.workflow_id === workflowId && binding.scope_revision === issue.scope_revision
    && digest(JSON.stringify(issue.authorized_scope)) === binding.scope_sha256 && oldCandidate.source_scope_sha256 === binding.scope_sha256
    && plan?.output_fingerprint === oldCandidate.source_plan_fingerprint && plan?.output_fingerprint === object(binding.planner).output_fingerprint
    && decision.workflow_id === workflowId && decision.kind === "plan-approval" && decision.status === "approved"
    && decision.decided_by === "human" && decision.id === plan.decision_id && decision.id === object(binding.decision).id,
  "HISTORICAL_EXECUTION_MISMATCH");
  const events = new TextDecoder("utf-8", { fatal: true }).decode(readState("events/" + taskId + ".jsonl"))
    .split(/\r?\n/).filter(Boolean).map((line) => parseAdoptionJson(Buffer.from(line)));
  requireAdoption(events.every((event) => validateTaskEvent(event)) && events.some((event) => event.task_id === taskId && event.run_id === runId && event.type === "worktree-created"),
    "HISTORICAL_EVENTS_MISMATCH");

  const report = (seal: Data, rows: Map<string, Buffer>, commit: string, tree: string, previous: boolean) => {
    const ref = object(seal.verification_report), receipt = manifestJson(rows, "verification.json");
    const offer = manifestJson(rows, "verification-issued.json");
    const path = absolute(ref.path);
    requireAdoption(historicalPathWithin(reportRoot, path) && receipt.report === ref.path
      && receipt.report_sha256 === ref.sha256 && receipt.tree === tree && (previous ? receipt.candidate : receipt.commit) === commit
      && receipt.status === "READY_FOR_HUMAN_REVIEW" && receipt.outcome === "PASS" && receipt.verifier_invocations === 1
      && offer.commit === commit && offer.candidate_sha256 === digest(rows.get("candidate.json")!),
    "HISTORICAL_VERIFICATION_MISMATCH");
    checkHistoricalNative(receipt.native);
    return { bytes: read(path, ref.sha256, "HISTORICAL_REPORT_SHA256_MISMATCH"), sha: string(ref.sha256), receipt, offer };
  };
  const firstReport = report(priorSeal, oldFiles, priorCommit, priorTree, true);
  const finalReport = report(finalSeal, newFiles, finalCommit, finalTree, false);
  const verifierSha = string(newCandidate.verifier_pins_sha256);
  const verifier = manifestJson(newFiles, "v/verifier-pins.json");
  const verifierRoot = join(finalRoot, "v");
  const priorManifest = readJson(join(priorVerifierRoot, "verifier-pins.json"), firstReport.offer.verifier_pins_sha256);
  read(join(priorVerifierRoot, "verification-contract.json"), priorManifest.contract_sha256);
  requireAdoption(digest(newFiles.get("v/verifier-pins.json")!) === verifierSha && verifierSha === finalReport.receipt.verifier_pins_sha256
    && verifierSha === finalReport.offer.verifier_pins_sha256 && prepared.previous_verifier_sha256 === firstReport.offer.verifier_pins_sha256,
  "HISTORICAL_VERIFIER_MISMATCH");
  const contract = readJson(join(verifierRoot, "verification-contract.json"), verifier.contract_sha256);
  const repo = absolute(task.envelope.repo_path), parent = absolute(contract.worktree_parent), commonDir = absolute(contract.git_common_dir);
  const git = absolute(object(object(contract.tools).git).executable);
  const oldWorktree = absolute(oldCandidate.worktree), finalWorktree = absolute(newCandidate.worktree), originalWorktree = absolute(run.worktree_path);
  requireAdoption(repo === absolute(contract.pilot_root) && contract.baseline_commit === base && samePaths(paths, pathList(contract.allowlist))
    && oldWorktree === absolute(approved.target) && finalWorktree === absolute(prepared.worktree)
    && originalWorktree === absolute(result.candidate_worktree) && new Set([oldWorktree, finalWorktree, originalWorktree]).size === 3
    && [oldWorktree, finalWorktree, originalWorktree].every((path) => historicalPathWithin(parent, path)), "HISTORICAL_WORKTREE_BINDING");
  const frontend = contract.required_frontend_tests, backend = contract.required_backend_tests;
  requireAdoption(Number.isSafeInteger(frontend) && Number(frontend) > 0 && Number.isSafeInteger(backend) && Number(backend) > 0
    && Array.isArray(verifier.files) && verifier.files.length <= 128, "HISTORICAL_VERIFIER_MISMATCH");
  const gitPins = verifier.files.map(object).filter((file) => typeof file.path === "string" && resolve(file.path) === git);
  requireAdoption(gitPins.length === 1 && isDigest(gitPins[0]?.sha256) && isDigest(approved.retained_index_sha256), "HISTORICAL_VERIFIER_MISMATCH");

  const evidence = object(acceptance.evidence);
  requireAdoption(object(evidence.dossier).path === "seal.json", "HISTORICAL_EVIDENCE_REFERENCE");
  const reviewer = versionOne(parseAdoptionJson(reference(finalRoot, evidence.reviewer, "reviewer-approval.json")));
  reference(finalRoot, evidence.qa, "qa-local-acceptance-brief.md");
  const approvalEvidence = object(reviewer.evidence);
  requireAdoption(object(approvalEvidence.dossier_seal).path === "seal.json"
    && object(approvalEvidence.verification_receipt).sha256 === digest(newFiles.get("verification.json")!),
  "HISTORICAL_REVIEW_MISMATCH");
  reference(finalRoot, approvalEvidence.reviewer_brief, "reviewer-decision-brief.md");
  const human = inspectHistoricalDecision(acceptance, reviewer, { commit: finalCommit, tree: finalTree, sealSha: profile.sealSha, reportSha: finalReport.sha });

  return { id: profile.id, source: repo, commonDir, worktreeParent: parent, git: { executable: git, sha256: gitPins[0].sha256 },
    base, original: { worktree: originalWorktree, branch: string(run.branch), indexSha: approved.retained_index_sha256, taskId, agent: task.envelope.agent },
    project: issue.project_id, issueId, workflowId, runId, scope: issue.authorized_scope, paths, correctionPaths,
    prior: { worktree: oldWorktree, commit: priorCommit, tree: priorTree, dossierSha: priorSealSha, reportSha: firstReport.sha, report: firstReport.bytes },
    corrected: { worktree: finalWorktree, commit: finalCommit, tree: finalTree, dossierSha: profile.sealSha, reportSha: finalReport.sha, report: finalReport.bytes },
    verification: { frontend: Number(frontend), backend: Number(backend), verifierSha },
    acceptanceSha: profile.acceptanceSha, acceptance: human, evidenceSha: digest(JSON.stringify([...fingerprint])) };
}

export function verifyHistoricalReport(candidate: HistoricalCandidate, contentSha: string, verification: HistoricalEvidence["verification"]): void {
  inspectAdoptionReport(candidate.report, { commit: candidate.commit, tree: candidate.tree, report_sha256: candidate.reportSha }, contentSha, verification);
}
