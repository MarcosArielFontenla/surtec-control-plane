import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTask, updateTask, writeTask } from "../../../lib/state/store";
import { assembleContext, contextHash } from "../../../lib/context/assemble";
import { createTestingEvidence, sealTestingEvidence } from "../../../lib/context/testing-evidence";
import type { ReviewCandidate } from "../../../lib/issues/types";
import { defaultTaskOrchestration } from "../../../lib/state/orchestration";
import { readIssueDocument } from "../../../lib/state/issues";
import type { TaskRecord } from "../../../lib/state/types";
import type { IssueCreateInput } from "../../../lib/issues/types";
import type { WorkflowDocument } from "../../../lib/workflows/types";
import { createIssueService, IssueScopeViolationError, pathsOutsideScope, projectWorkflowIssueLink } from "./issue-service";
import { createTask } from "./dispatch";
import type { CreateTaskInput, TrustedIssueTaskContext } from "./dispatch";

let root: string;
let state: string;
let fakeCreateTask: typeof createTask;

const input = (overrides: Partial<IssueCreateInput> = {}): IssueCreateInput => ({
  project_id: "alpha",
  title: "Keep the preferences save action in scope",
  expected_outcome: "The profile settings save and reload correctly.",
  acceptance_criteria: ["The save action persists the settings.", "Reload shows the saved settings."],
  authorized_scope: {
    expected_outcome: "The profile settings save and reload correctly.",
    acceptance_criteria: ["The save action persists the settings.", "Reload shows the saved settings."],
    allowed_path_patterns: ["dashboard/src/**"],
    excluded_path_patterns: ["dashboard/src/secrets/**"],
    allowed_change_categories: ["ui", "test"],
    explicit_exclusions: ["Do not change provider credentials."],
  },
  assigned_role_id: "frontend-engineer",
  ...overrides,
});

function service() {
  return createIssueService(root, { projectIds: () => ["alpha"], createTask: fakeCreateTask });
}

function activateTask(taskId: string, runId: string, attempt = 1): void {
  const at = new Date().toISOString();
  updateTask(taskId, (task) => {
    const orchestration = defaultTaskOrchestration();
    orchestration.attempts = attempt;
    orchestration.lease = { run_id: runId, worker_id: "issue-test", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() };
    task.lifecycle = "running";
    task.started_at ??= at;
    task.orchestration = orchestration;
  });
}

function finishTask(taskId: string, outcome: "completed" | "partial" | "needs-review" = "completed"): void {
  updateTask(taskId, (task) => {
    task.lifecycle = "finished";
    task.outcome = outcome;
    task.finished_at = new Date().toISOString();
    task.orchestration!.lease = null;
  });
}
function governTask(taskId: string, issueRevision: number) {
  updateTask(taskId, (task) => {
    const budget = task.orchestration!;
    task.envelope.self_verify = true;
    task.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: task.envelope.project, role_id: "software-engineer", agent_id: task.envelope.agent, task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope", "verify-configured"], approval_rules: ["publication"], budget: { max_attempts: budget.max_attempts, max_runtime_ms: budget.max_runtime_ms, max_total_tokens: budget.max_total_tokens }, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [],
      routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic gate fixture"], delegation: { admitted: false, executable: false, reasons: ["No delegation"] } }, testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: ["node verify.mjs"], reasons: ["Trusted functional policy"], requires_red_evidence: false } },
    [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic mandatory safety", reason: "Fixture", sensitivity: "public" }]).manifest;
    task.envelope.context_admission = { schema_version: 1, kind: "issue", manifest_fingerprint: task.envelope.context_manifest.fingerprint, instructions_length: task.envelope.instructions.length, instructions_hash: contextHash(task.envelope.instructions), issue_id: task.envelope.metadata.issue_id as string, issue_revision: issueRevision, issue_status: "authorized" };
  });
}
function attachReceipt(taskId: string, candidate: ReviewCandidate) {
  const task = readTask(taskId)!;
  const receipt = createTestingEvidence(task, candidate.execution_id, { mode: "functional", runners: [{ stage: "functional", command: "node verify.mjs" }] });
  receipt.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
  receipt.implementation = { started_at: "2026-09-30T10:00:00.000Z", finished_at: "2026-09-30T10:00:01.000Z", thread_id: "synthetic-thread", turn_id: "synthetic-turn" };
  receipt.observations = [{ stage: "functional", command_fingerprint: receipt.requirements[0]!.command_fingerprint, probe_fingerprint: null, assertions: [], outcome: "passed", exit_code: 0, started_at: "2026-09-30T10:00:02.000Z", finished_at: "2026-09-30T10:00:03.000Z", revision: candidate.candidate_revision, before_fingerprint: contextHash("clean"), after_fingerprint: contextHash("clean") }];
  const { fingerprint: _fingerprint, ...unsigned } = receipt;
  updateTask(taskId, (record) => { record.testing_evidence = sealTestingEvidence(unsigned); });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-issues-"));
  state = join(root, "state");
  process.env.SURTEC_STATE_DIR = state;
  fakeCreateTask = vi.fn((task: CreateTaskInput, _repoRoot: string = process.cwd(), trusted?: TrustedIssueTaskContext) => {
    const at = new Date().toISOString();
    const record: TaskRecord = {
      envelope: { id: trusted!.taskId, source: "dashboard", project: task.project, task_type: "implementation", agent: task.agent, title: "Local issue task", instructions: task.instructions, repo_path: "/synthetic/alpha", branch: `agent/${trusted!.taskId}`, sandbox: "workspace-write", expected_outputs: [], requires_human_approval: true, metadata: { issue_id: trusted!.issueId, issue_scope_revision: trusted!.scopeRevision, issue_authorized_scope: trusted!.authorizedScope } },
      lifecycle: "queued", outcome: null, created_at: at, started_at: null, updated_at: at, finished_at: null, result: null, logs_path: null,
    };
    writeTask(record);
    return { id: trusted!.taskId };
  }) as typeof createTask;
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("local issue service", () => {
  it.each(["valid", "opt-out", "unconsumed", "engineer", "candidate", "missing-findings"])("links a correction only through the exact consumed checking authority: %s", (change) => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
    const taskId = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer").taskId;
    activateTask(taskId, "original-run");
    const candidate = issues.recordCandidate({ issueId: proposed.id, taskId, executionId: "original-run", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/value.ts"], scopeRevision: 1 });
    finishTask(taskId);
    const document = readIssueDocument(), before = structuredClone(document), issue = document.issues[proposed.id]!, at = new Date().toISOString();
    const bound = { ...candidate, candidate_id: candidate.id };
    const workflow = { id: "WF-correction", current_stage_id: "WS-correction", stage_ids: ["WS-review", "WS-correction"], current_grant_id: "WG-correction", issue_id: issue.id, project_id: "alpha", authority_revision: 1,
      status: "running", stop_requested_at: null, pending_decision_id: null, recovery_state: "none", candidate: bound, lineage_id: "WL-correction" };
    const stage = { id: "WS-correction", workflow_id: workflow.id, grant_id: workflow.current_grant_id, authority_revision: 1, kind: "correction", sandbox: "workspace-write",
      role_id: "software-engineer", agent_id: "frontend-engineer", task_id: null, status: "reserved", candidate: bound, predecessor_stage_id: "WS-review" };
    const grant = { id: workflow.current_grant_id, authority_revision: 1, scope_revision: 1, authorized_scope: issue.authorized_scope, correction: { enabled: true } };
    const lineage = { corrections_consumed: 1, consumed_stage_id: stage.id };
    const review = { kind: "review", ordinal: 4, candidate: bound, output: { kind: "review", verdict: "correction-required", findings: [{ severity: "blocking", path: "dashboard/src/value.ts", summary: "Correct the bounded value" }] } };
    const workflows = { workflows: { [workflow.id]: workflow }, stages: { [stage.id]: stage, [stage.predecessor_stage_id]: review }, grants: { [grant.id]: grant }, lineages: { [workflow.lineage_id]: lineage } } as unknown as WorkflowDocument;
    if (change === "opt-out") grant.correction.enabled = false;
    if (change === "unconsumed") lineage.corrections_consumed = 0;
    if (change === "engineer") stage.agent_id = "backend-engineer";
    if (change === "candidate") issue.candidate_ids = [];
    if (change === "missing-findings") review.output.findings = [];
    const unchanged = structuredClone(document);
    if (change !== "valid") {
      expect(() => projectWorkflowIssueLink(document, workflows, stage.id, "T-correction", issue.revision, at)).toThrow();
      // The projection is discarded on any denial; normal stored state remains untouched.
      expect(readIssueDocument()).toEqual(before); expect(document).toEqual(unchanged);
      return;
    }
    const linked = projectWorkflowIssueLink(document, workflows, stage.id, "T-correction", issue.revision, at);
    expect(linked.status).toBe("working"); expect(linked.task_ids.at(-1)).toBe("T-correction"); expect(linked.candidate_ids.at(-1)).toBe(candidate.id);
    expect(document.candidates[candidate.id]!.invalidated_at).toBeNull();
    expect(document.events.at(-1)).toMatchObject({ type: "bounded-correction-authorized", payload: { workflow_id: workflow.id, stage_id: stage.id, task_id: "T-correction", candidate_id: candidate.id } });
    expect(readIssueDocument()).toEqual(before);
  });
  it("fails closed on malformed/future workflow ownership instead of manually dispatching", () => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "Synthetic approval");
    const directory = join(state, "workflows");
    mkdirSync(directory, { recursive: true }); const bytes = '{"schema_version":99}'; writeFileSync(join(directory, "workflows.json"), bytes);
    const issueBytes = readFileSync(join(state, "issues/issues.json"));
    expect(() => issues.dispatch(proposed.id, authorized.revision, "frontend-engineer")).toThrow();
    expect(fakeCreateTask).not.toHaveBeenCalled(); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes); expect(readFileSync(join(directory, "workflows.json"), "utf8")).toBe(bytes);
  });
  it("internal issue linkage cannot create authority for a nonexistent stage", () => {
    const issues = service(), before = readIssueDocument(); expect(() => issues.linkWorkflowTask("forged-stage")).toThrow(/not reserved/);
    expect(readIssueDocument()).toEqual(before); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  function governedCandidate() {
    const issues = service(), proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "Synthetic approval");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer"); activateTask(admitted.taskId, "run-captured"); governTask(admitted.taskId, authorized.revision);
    const candidate = issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-captured", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1 });
    return { issues, issue: proposed, taskId: admitted.taskId, candidate };
  }
  it("derives governed verification from the authoritative receipt, not caller status", () => {
    const { issues, issue, taskId, candidate } = governedCandidate(); attachReceipt(taskId, candidate);
    issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-captured", candidateId: candidate.id, status: "failed", label: "Caller status is not authority", reference: "Captured infrastructure receipt" });
    const ready = issues.get(issue.id); expect(ready.issue.status).toBe("ready-for-review");
    expect(ready.evidence.find((entry) => entry.kind === "verification")?.testing_evidence_fingerprint).toBe(readTask(taskId)!.testing_evidence!.fingerprint);
    finishTask(taskId);
    expect(issues.acceptCandidate(issue.id, { expectedRevision: ready.issue.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "Synthetic review", rationale: "Exact candidate receipt confirmed", confirmedCriteria: input().acceptance_criteria }).status).toBe("done");
  });
  it("refuses model/caller success without a captured receipt and routes the missing evidence to a decision", () => {
    const { issues, issue, taskId, candidate } = governedCandidate();
    issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-captured", candidateId: candidate.id, status: "passed", label: "Model said completed", reference: "No infrastructure receipt" });
    expect(issues.get(issue.id).issue.status).toBe("needs-decision"); expect(issues.get(issue.id).evidence.find((entry) => entry.kind === "verification")?.status).toBe("informational");
  });
  it.each(["run", "owner", "candidate", "project"])("rejects stale or cross-bound governed verification %s without issue mutation", (change) => {
    const { issues, issue, taskId, candidate } = governedCandidate(); attachReceipt(taskId, candidate);
    const path = join(state, "issues/issues.json"), before = readFileSync(path);
    if (change === "owner") activateTask(taskId, "replacement-run", 2);
    if (change === "candidate") updateTask(taskId, (record) => { const { fingerprint: _fp, ...unsigned } = record.testing_evidence!; unsigned.candidate!.candidate_revision = "c".repeat(40); record.testing_evidence = sealTestingEvidence(unsigned); });
    if (change === "project") {
      const document = JSON.parse(before.toString()); document.candidates[candidate.id].repository_id = "other"; writeFileSync(path, JSON.stringify(document));
    }
    const exactBefore = readFileSync(path);
    expect(() => issues.recordVerification({ issueId: issue.id, taskId, executionId: change === "run" ? "different-run" : "run-captured", candidateId: candidate.id, status: "passed", label: "Forged passing classification", reference: "Untrusted caller" })).toThrow(/stale|does not match/);
    expect(readFileSync(path)).toEqual(exactBefore);
  });
  it("cannot waive missing or replaced governed receipt evidence during human acceptance", () => {
    const { issues, issue, taskId, candidate } = governedCandidate(); attachReceipt(taskId, candidate);
    issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-captured", candidateId: candidate.id, status: "passed", label: "Captured check", reference: "Receipt" });
    finishTask(taskId); const ready = issues.get(issue.id).issue;
    updateTask(taskId, (record) => { delete record.testing_evidence; });
    expect(() => issues.acceptCandidate(issue.id, { expectedRevision: ready.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "Synthetic review", rationale: "Try historical gap bypass", confirmedCriteria: input().acceptance_criteria, acknowledgeEvidenceGaps: true })).toThrow(/cannot waive/);
    expect(issues.get(issue.id).issue.status).toBe("ready-for-review");
  });
  it("preserves the verified candidate receipt through lease recovery without promoting a new run", () => {
    const { issues, issue, taskId, candidate } = governedCandidate(); attachReceipt(taskId, candidate);
    issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-captured", candidateId: candidate.id, status: "passed", label: "Captured verification", reference: "Receipt" });
    activateTask(taskId, "run-recovered", 2);
    expect(issues.executionGate({ issueId: issue.id, taskId, executionId: "run-recovered", scopeRevision: 1 })).toBe("candidate-ready");
    expect(() => issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-recovered", candidateId: candidate.id, status: "passed", label: "Recovery claim", reference: "No new checks" })).toThrow(/stale/);
    finishTask(taskId, "needs-review"); const ready = issues.get(issue.id).issue;
    expect(issues.acceptCandidate(issue.id, { expectedRevision: ready.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "Synthetic recovered review", rationale: "Accept original immutable candidate evidence", confirmedCriteria: input().acceptance_criteria }).status).toBe("done");
  });
  it("cannot promote captured passing evidence after cancellation intent is persisted", () => {
    const { issues, issue, taskId, candidate } = governedCandidate(); attachReceipt(taskId, candidate);
    updateTask(taskId, (record) => { record.orchestration!.cancel_requested_at = new Date().toISOString(); });
    issues.recordVerification({ issueId: issue.id, taskId, executionId: "run-captured", candidateId: candidate.id, status: "passed", label: "Late verification", reference: "Cancelled attempt" });
    expect(issues.get(issue.id).issue.status).toBe("needs-decision"); expect(issues.get(issue.id).evidence.find((entry) => entry.kind === "verification")?.status).toBe("failed");
  });
  it("classifies scope deterministically and requires plan inputs for substantial work", () => {
    const created = service().create(input({ classification_inputs: { security_impact: true }, plan: ["Inspect policy", "Implement and verify"], next_action: "Inspect the existing policy." }));
    expect(created.work_scale).toBe("substantial");
    expect(created.classification_rationale).toContain("security-sensitive change");
    expect(() => service().create(input({ criticality: "high" }))).toThrow(/substantial work requires/i);
  });

  it("rejects unsafe paths and applies exclusions before allowed patterns", () => {
    const scope = input().authorized_scope;
    expect(pathsOutsideScope(["dashboard/src/views/profile.tsx", "dashboard/src/secrets/key.json", "../outside.ts"], scope))
      .toEqual(["dashboard/src/secrets/key.json", "../outside.ts"]);
  });

  it("rejects credential-looking issue content before any local persistence", () => {
    const secret = `ghp_${"a".repeat(32)}`;
    expect(() => service().create(input({ title: `Investigate ${secret}` }))).toThrow(/credential/i);
    expect(() => service().create(input({ external_references: [{ provider: "github", url: `https://example.test/${secret}`, reference: "#1" }] }))).toThrow(/credential/i);
    expect(() => readIssueDocument()).not.toThrow();
    expect(() => readFileSync(join(state, "issues", "issues.json"), "utf8")).toThrow();
  });

  it("rejects cyclic parent and blocker relationships when reading persisted state", () => {
    const issues = service();
    const parent = issues.create(input({ title: "Parent issue" }));
    const child = issues.create(input({ title: "Child issue", parent_issue_id: parent.id }));
    const path = join(state, "issues", "issues.json");
    const parentCycle = JSON.parse(readFileSync(path, "utf8")) as { issues: Record<string, Record<string, unknown>> };
    parentCycle.issues[parent.id]!.parent_issue_id = child.id;
    writeFileSync(path, JSON.stringify(parentCycle), "utf8");
    expect(() => readIssueDocument()).toThrow(/ancestry contains a cycle/i);
    parentCycle.issues[parent.id]!.parent_issue_id = null;
    parentCycle.issues[parent.id]!.blocked_by_issue_ids = [child.id];
    parentCycle.issues[child.id]!.blocked_by_issue_ids = [parent.id];
    writeFileSync(path, JSON.stringify(parentCycle), "utf8");
    expect(() => readIssueDocument()).toThrow(/blocker graph contains a cycle/i);
  });

  it("requires explicit scope authorization and prevents duplicate issue task ownership", () => {
    const issues = service();
    const issue = issues.create(input());
    expect(() => issues.dispatch(issue.id, issue.revision, "frontend-engineer")).toThrow(/authorization/i);
    const authorized = issues.authorize(issue.id, issue.revision, "local-approval-1");
    const admitted = issues.dispatch(issue.id, authorized.revision, "frontend-engineer");
    expect(admitted.issue.status).toBe("working");
    expect(admitted.issue.task_ids).toEqual([admitted.taskId]);
    expect(fakeCreateTask).toHaveBeenCalledWith(expect.objectContaining({ sandbox: "workspace-write", self_verify: true }), root, expect.objectContaining({ issueId: issue.id, scopeRevision: 1, expectedRevision: authorized.revision }), expect.any(Object));
    expect(() => issues.dispatch(issue.id, admitted.issue.revision, "frontend-engineer")).toThrow(/authorization|rework/i);
  });

  it("records out-of-scope discovery without granting permission and increments scope only on approval", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    activateTask(admitted.taskId, "run-1");
    expect(() => issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-1", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["registry/projects.yml"], scopeRevision: 1 })).toThrow(IssueScopeViolationError);
    issues.recordScopeFinding(proposed.id, admitted.taskId, ["registry/projects.yml"]);
    const decision = issues.get(proposed.id).issue;
    expect(decision.status).toBe("needs-decision");
    expect(decision.scope_revision).toBe(1);
    expect(decision.scope_change_proposal?.proposed_scope.allowed_path_patterns).toContain("registry/projects.yml");
    const revised = issues.approveScopeRevision(proposed.id, decision.revision, decision.scope_change_proposal!.id, "approval-2");
    expect(revised.status).toBe("authorized");
    expect(revised.scope_revision).toBe(2);
    expect(revised.scope_change_approval_id).toBe("approval-2");
  });

  it("binds verification, exact criteria review, and completion to the immutable candidate", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    activateTask(admitted.taskId, "run-2");
    const candidate = issues.recordCandidate({
      issueId: proposed.id, taskId: admitted.taskId, executionId: "run-2", repositoryId: "alpha",
      baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1,
    });
    issues.recordVerification({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-2", candidateId: candidate.id, status: "passed", label: "Focused verification", reference: "1 configured command passed." });
    finishTask(admitted.taskId);
    const ready = issues.get(proposed.id).issue;
    expect(ready.status).toBe("ready-for-review");
    expect(() => issues.acceptCandidate(proposed.id, { expectedRevision: ready.revision, candidateId: candidate.id, fingerprint: "0".repeat(64), approvalId: "review-1", rationale: "Reviewed", confirmedCriteria: input().acceptance_criteria })).toThrow(/stale/i);
    expect(() => issues.acceptCandidate(proposed.id, { expectedRevision: ready.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "review-1", rationale: "Reviewed", confirmedCriteria: [input().acceptance_criteria[0]!] })).toThrow(/all acceptance criteria/i);
    const done = issues.acceptCandidate(proposed.id, { expectedRevision: ready.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "review-1", rationale: "Both criteria passed on the exact candidate.", confirmedCriteria: input().acceptance_criteria });
    expect(done.status).toBe("done");
    expect(issues.get(proposed.id).evidence_gaps).toEqual([]);
    expect(issues.get(proposed.id).tasks.flatMap((task) => task.executions).map((execution) => execution.run_id)).toEqual([]);
  });

  it("invalidates a candidate when bounded rework is requested", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    activateTask(admitted.taskId, "run-3");
    const candidate = issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-3", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1 });
    issues.recordVerification({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-3", candidateId: candidate.id, status: "passed", label: "Focused verification", reference: "passed" });
    finishTask(admitted.taskId);
    const ready = issues.get(proposed.id).issue;
    const working = issues.requestRework(proposed.id, ready.revision, candidate.id, candidate.diff_fingerprint, "Fix the observed layout regression.");
    expect(working.status).toBe("working");
    expect(issues.get(proposed.id).candidates.find((entry) => entry.id === candidate.id)?.invalidated_at).not.toBeNull();
    expect(() => issues.acceptCandidate(proposed.id, { expectedRevision: working.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "review-2", rationale: "stale", confirmedCriteria: input().acceptance_criteria })).toThrow(/stale/i);
  });

  it("keeps lease-recovered attempts on the same scope and stops when a candidate is already review-ready", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    activateTask(admitted.taskId, "run-before-crash");
    const staleCandidate = issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-before-crash", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1 });

    activateTask(admitted.taskId, "run-recovered", 2);
    expect(issues.executionGate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-recovered", scopeRevision: 1 })).toBe("allowed");
    const recoveredCandidate = issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-recovered", repositoryId: "alpha", baseRevision: "b".repeat(40), candidateRevision: "c".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1 });
    expect(issues.get(proposed.id).candidates.find((candidate) => candidate.id === staleCandidate.id)?.invalidated_at).not.toBeNull();
    issues.recordVerification({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-recovered", candidateId: recoveredCandidate.id, status: "passed", label: "Recovered-attempt verification", reference: "The recovered candidate passed." });

    activateTask(admitted.taskId, "run-after-ready", 3);
    expect(issues.executionGate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-after-ready", scopeRevision: 1 })).toBe("candidate-ready");
    finishTask(admitted.taskId, "needs-review");
    const ready = issues.get(proposed.id).issue;
    expect(issues.acceptCandidate(proposed.id, { expectedRevision: ready.revision, candidateId: recoveredCandidate.id, fingerprint: recoveredCandidate.diff_fingerprint, approvalId: "review-after-recovery", rationale: "The verified candidate was recovered without another write attempt.", confirmedCriteria: input().acceptance_criteria }).status).toBe("done");
  });

  it("routes skipped or failed verification to an explicit same-scope decision", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    activateTask(admitted.taskId, "run-no-verify");
    const candidate = issues.recordCandidate({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-no-verify", repositoryId: "alpha", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/views/profile.tsx"], scopeRevision: 1 });
    issues.recordVerification({ issueId: proposed.id, taskId: admitted.taskId, executionId: "run-no-verify", candidateId: candidate.id, status: "informational", label: "Verification skipped", reference: "No verification command is configured." });
    finishTask(admitted.taskId, "needs-review");
    const decision = issues.get(proposed.id).issue;
    expect(decision.status).toBe("needs-decision");
    expect(() => issues.acceptCandidate(proposed.id, { expectedRevision: decision.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "review-no-test", rationale: "not verified", confirmedCriteria: input().acceptance_criteria, acknowledgeEvidenceGaps: true })).toThrow(/ready for review/i);
    const resumed = issues.resolveDecision(proposed.id, decision.revision, "approval-2", "Add a verifier before retrying.");
    expect(resumed.status).toBe("authorized");
    expect(issues.get(proposed.id).candidates.find((entry) => entry.id === candidate.id)?.invalidated_at).not.toBeNull();
  });

  it("requires an explicit human resume after a blocked execution", () => {
    const issues = service();
    const proposed = issues.create(input());
    const authorized = issues.authorize(proposed.id, proposed.revision, "approval-1");
    const admitted = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    issues.markBlocked(proposed.id, admitted.taskId, "Verifier unavailable.");
    const blocked = issues.get(proposed.id).issue;
    expect(blocked.status).toBe("blocked");
    expect(issues.resumeBlocked(proposed.id, blocked.revision, "Verifier has been restored.").status).toBe("authorized");
  });
});
