import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createIssueService, createRoutineIssueProposer, IssueScopeViolationError, pathsOutsideScope, projectWorkflowIssueLink } from "./issue-service";
import { createTask, prepareTaskBudgetAdmission } from "./dispatch";
import type { CreateTaskInput, TrustedIssueTaskContext } from "./dispatch";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../lib/budgets/types";
import { resolveBudgetPolicy, type BudgetPolicySource } from "../../../lib/budgets/policy";
import type { BudgetAmounts, BudgetOccurrenceSubject } from "../../../lib/budgets/types";
import { budgetOccurrenceIntentId, claimOccurrenceBudget, commitOccurrenceBudget, reserveOccurrenceBudget } from "../../../lib/budgets/reservations";
import { mutateBudgetLedger } from "../../../lib/state/budgets";
import { assertRoutineOwnership, claimRoutineOccurrence, mutateRoutineDocument, revokeRoutineOwnership, updateRoutineTransaction } from "../../../lib/state/routines";
import { createRoutineDraft, routineProposalKey } from "../../../lib/routines/validation";
import { routineRevisionKey, routineSlotKey } from "../../../lib/routines/schedule";
import { executeRoutineAction, RoutineActionEffectError, routineSignalFingerprint, type RoutineIssueProposal, type RoutineSignalFact } from "../../../lib/routines/actions";
import type { RoutineOccurrence } from "../../../lib/routines/types";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

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
function governQueuedFixture(taskId: string, issueRevision: number): void {
  const task = readTask(taskId)!;
  task.orchestration = defaultTaskOrchestration();
  writeTask(task);
  governTask(taskId, issueRevision);
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
  expect(existsSync(root)).toBe(false);
  vi.restoreAllMocks();
});

describe("local issue service", () => {
  function routineProposal() {
    const slot = "2026-10-06T12:00:00.000Z", started = "2026-10-06T12:00:01.000Z";
    const source: BudgetPolicySource = { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1,
      pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "routine-company", revision: 1,
        scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
        limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
    const path = join(state, "routines/routines.json");
    mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, (draft) => {
        const definition = createRoutineDraft({ id: "routine-proposal", action: "propose-issues", scope: { kind: "project", id: "alpha" },
          policy: { revision: 1, fingerprint: source.fingerprint, policy_ids: ["routine-company"] }, at: slot });
        draft.routines[definition.id] = structuredClone(definition); draft.definitions[routineRevisionKey(definition.id, 1)] = structuredClone(definition);
      });
      updateRoutineTransaction(tx, (draft) => {
        const definition = draft.routines["routine-proposal"]!; definition.revision++; definition.enabled = true;
        draft.definitions[routineRevisionKey(definition.id, 2)] = structuredClone(definition);
      });
    }, path, slot);
    const attribution = { company_id: "surtec" as const, objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: null, execution_id: "occ-proposal" };
    const subject: BudgetOccurrenceSubject = { id: "subject-proposal", kind: "occurrence", occurrence_id: "occ-proposal", routine_id: "routine-proposal",
      routine_revision: 2, slot, project_ids: ["alpha"], attribution };
    const caps = { ...Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])), attempts: 1, runtime_ms: 60000, concurrent_reads: 1 } as BudgetAmounts;
    const resolved = resolveBudgetPolicy({ source, attribution, at: slot, base_caps: caps });
    const intent = budgetOccurrenceIntentId({ subject, reservation_id: "reservation-proposal", policy_bindings: resolved.policy_bindings,
      cap_fingerprint: resolved.cap_fingerprint, runtime_ms: 60000, created_at: slot });
    mutateBudgetLedger((tx) => reserveOccurrenceBudget(tx, { source, subject, reservation_id: "reservation-proposal", intent_id: intent, runtime_ms: 60000 }), join(state, "budgets/budgets.json"), slot);
    mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (draft) => {
      const definition = draft.routines[subject.routine_id]!;
      const occurrence: RoutineOccurrence = { schema_version: 1, id: subject.occurrence_id, revision: 1, routine_id: definition.id, routine_revision: definition.revision,
        occurrence_key: routineSlotKey(definition.id, definition.revision, slot), definition: structuredClone(definition), slot, trigger: "manual",
        project_ids: ["alpha"], attribution, budget: { subject_id: subject.id, reservation_id: "reservation-proposal", intent_id: intent,
          cap_fingerprint: resolved.cap_fingerprint, admitted_runtime_ms: 60000, policy_bindings: resolved.policy_bindings },
        status: "reserved", owner: null, started_at: null, finished_at: null, cancel_requested_at: null, receipt: null, created_at: slot, updated_at: slot };
      draft.occurrences[occurrence.id] = occurrence;
    }), path, slot);
    mutateBudgetLedger((tx) => commitOccurrenceBudget(tx, { subject_id: subject.id, reservation_id: "reservation-proposal", intent_id: intent }), join(state, "budgets/budgets.json"), slot);
    const ownership = mutateRoutineDocument((tx) => claimRoutineOccurrence(tx, subject.occurrence_id, 1, "routine-test"), path, started);
    const occurrence = assertRoutineOwnership(ownership, path);
    mutateBudgetLedger((tx) => claimOccurrenceBudget(tx, { reservation_id: "reservation-proposal", run_id: occurrence.owner!.run_id, source }), join(state, "budgets/budgets.json"), started);
    const projection = { id: "sig_synthetic", project_id: "alpha", source: "ci" as const, severity: "warning" as const, observed_at: started };
    const signal: RoutineSignalFact = { ...projection, fingerprint: routineSignalFingerprint(projection) };
    const proposal: RoutineIssueProposal = { ownership, occurrence, signal, fingerprint: signal.fingerprint, key: routineProposalKey(occurrence.occurrence_key, signal.fingerprint) };
    const gate = vi.fn(() => {}), check = vi.fn(() => {});
    const proposer = () => createRoutineIssueProposer(root, { state_root: state, assert_current: gate, projectIds: () => ["alpha"], now: () => new Date(started) });
    return { proposal, path, gate, check, proposer };
  }
  it("atomically retains a proposal key and only a code-owned proposed issue without execution or private content", () => {
    const fixture = routineProposal(), id = fixture.proposer()(fixture.proposal, fixture.check);
    const document = readIssueDocument(), issue = document.issues[id]!;
    expect(issue.status).toBe("proposed"); expect(issue.assigned_role_id).toBeNull(); expect(issue.task_ids).toEqual([]);
    expect(issue.scope_change_approval_id).toBeNull(); expect(issue.title).toBe("Review routine signal");
    expect(document.events.at(-1)).toMatchObject({ issue_id: id, type: "routine-issue-proposed", payload: { routine_proposal_key: fixture.proposal.key,
      occurrence_id: fixture.proposal.occurrence.id, proposal_fingerprint: fixture.proposal.fingerprint } });
    expect(Object.keys(document.evidence)).toHaveLength(1); expect(fakeCreateTask).not.toHaveBeenCalled();
    expect(existsSync(join(state, "tasks"))).toBe(false); expect(existsSync(join(state, "workflows"))).toBe(false);
    expect(fixture.gate).toHaveBeenCalled(); expect(fixture.check).toHaveBeenCalled();
  });
  it("does not replay, rewrite or rewind a retained proposal across new service instances or later human progression", () => {
    const fixture = routineProposal(), id = fixture.proposer()(fixture.proposal, fixture.check);
    const issue = readIssueDocument().issues[id]!; service().authorize(id, issue.revision, "human-test");
    const before = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    expect(fixture.proposer()(fixture.proposal, fixture.check)).toBe(id);
    expect(readFileSync(join(state, "issues/issues.json")).equals(before)).toBe(true);
    expect(readdirSync(state, { recursive: true })).toEqual(inventory); expect(Object.keys(readIssueDocument().issues)).toEqual([id]);
    expect(readIssueDocument().issues[id]!.status).toBe("authorized"); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it.each(["deadline", "revoked"])("rechecks %s after the trusted proposal gate before any issue effect", (kind) => {
    const fixture = routineProposal(), inventory = readdirSync(state, { recursive: true });
    let elapsed = 0;
    fixture.check.mockImplementation(() => { if (elapsed >= fixture.proposal.occurrence.budget.admitted_runtime_ms) throw new Error("synthetic deadline"); });
    fixture.gate.mockImplementation(() => {
      if (kind === "deadline") elapsed = fixture.proposal.occurrence.budget.admitted_runtime_ms;
      else revokeRoutineOwnership(fixture.proposal.ownership);
    });
    expect(() => fixture.proposer()(fixture.proposal, fixture.check)).toThrow();
    expect(existsSync(join(state, "issues"))).toBe(false); expect(readdirSync(state, { recursive: true })).toEqual(inventory);
    expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it.each(["copy-proof", "revoked", "key", "fingerprint", "project", "action", "payload", "async-check", "async-gate", "gate-fails", "budget-unavailable"])("denies %s proposal before any issue file or dispatch", (kind) => {
    const fixture = routineProposal();
    if (kind === "copy-proof") fixture.proposal.ownership = {} as never;
    if (kind === "revoked") revokeRoutineOwnership(fixture.proposal.ownership);
    if (kind === "key") fixture.proposal.key = "b".repeat(64);
    if (kind === "fingerprint") fixture.proposal.fingerprint = "b".repeat(64);
    if (kind === "project") { const { fingerprint: _fp, ...projection } = fixture.proposal.signal; projection.project_id = "outside"; fixture.proposal.signal = { ...projection, fingerprint: routineSignalFingerprint(projection) }; }
    if (kind === "action") fixture.proposal.occurrence = { ...fixture.proposal.occurrence, definition: { ...fixture.proposal.occurrence.definition, action: "refresh-evidence" } };
    if (kind === "payload") (fixture.proposal.signal as unknown as Record<string, unknown>).title = "private fixture title";
    if (kind === "gate-fails") fixture.gate.mockImplementation(() => { throw new Error("gate denied"); });
    if (kind === "budget-unavailable") writeFileSync(join(state, "budgets/budgets.json"), '{"schema_version":99}');
    const before = readdirSync(state, { recursive: true });
    if (kind === "async-gate") {
      expect(() => createRoutineIssueProposer(root, { state_root: state, assert_current: async () => {}, projectIds: () => ["alpha"] })).toThrow(/synchronous/);
    } else {
      expect(() => fixture.proposer()(fixture.proposal, kind === "async-check" ? async () => {} : fixture.check)).toThrow();
    }
    expect(existsSync(join(state, "issues"))).toBe(false); expect(readdirSync(state, { recursive: true })).toEqual(before); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it("retains corrupt future issue bytes and refuses to repair or fabricate empty history", () => {
    const fixture = routineProposal(); mkdirSync(join(state, "issues")); const bytes = '{"schema_version":99,"private":"kept"}';
    writeFileSync(join(state, "issues/issues.json"), bytes);
    expect(() => fixture.proposer()(fixture.proposal, fixture.check)).toThrow();
    expect(readFileSync(join(state, "issues/issues.json"), "utf8")).toBe(bytes); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it("rejects conflicting retained proposal provenance instead of creating a duplicate", () => {
    const fixture = routineProposal(), id = fixture.proposer()(fixture.proposal, fixture.check), path = join(state, "issues/issues.json");
    const value = JSON.parse(readFileSync(path, "utf8")); value.events[0].payload.occurrence_id = "different-occurrence";
    writeFileSync(path, JSON.stringify(value)); const before = readFileSync(path);
    expect(() => fixture.proposer()(fixture.proposal, fixture.check)).toThrow(/history conflicts/);
    expect(readFileSync(path).equals(before)).toBe(true); expect(Object.keys(readIssueDocument().issues)).toEqual([id]);
  });
  it.each(["invalid-utf8", "hardlink", "redirected", "oversized"])("rejects %s issue evidence before proposal effects", (kind) => {
    const fixture = routineProposal(), issue = service().create(input()), path = join(state, "issues/issues.json");
    if (kind === "invalid-utf8") {
      const bytes = readFileSync(path), index = bytes.indexOf(Buffer.from(issue.title));
      bytes[index] = 0xff; writeFileSync(path, bytes);
    }
    if (kind === "hardlink") linkSync(path, join(root, "retained-issue.json"));
    if (kind === "redirected") {
      const directory = join(state, "issues"), target = join(root, "retained-issues");
      renameSync(directory, target); symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
    }
    if (kind === "oversized") writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const before = readFileSync(path), inventory = readdirSync(state, { recursive: true });
    expect(() => fixture.proposer()(fixture.proposal, fixture.check)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true); expect(readdirSync(state, { recursive: true })).toEqual(inventory);
    expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it("refuses aggregate growth beyond the exact formatted byte ceiling without changing the old bytes", () => {
    const fixture = routineProposal(); service().create(input()); const path = join(state, "issues/issues.json");
    const value = JSON.parse(readFileSync(path, "utf8")); value.events[0].payload.padding = "";
    const overhead = Buffer.byteLength(JSON.stringify(value, null, 2));
    value.events[0].payload.padding = "x".repeat(16 * 1024 * 1024 - overhead - 100);
    const bytes = Buffer.from(JSON.stringify(value, null, 2)); writeFileSync(path, bytes);
    expect(bytes.length).toBe(16 * 1024 * 1024 - 100);
    expect(() => fixture.proposer()(fixture.proposal, fixture.check)).toThrow(/capacity reached/);
    expect(readFileSync(path).equals(bytes)).toBe(true); expect(Object.keys(readIssueDocument().issues)).toHaveLength(1);
    expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it.each(["before-rename", "after-rename"])("retains exact effect evidence at %s without replay or claimed rollback", async (kind) => {
    const fixture = routineProposal(), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      if (kind === "after-rename") actual.renameSync(source, destination);
      throw new Error("synthetic publication fault");
    });
    let failure: unknown;
    try { fixture.proposer()(fixture.proposal, fixture.check); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(fakeCreateTask).not.toHaveBeenCalled();
    const document = readIssueDocument();
    if (kind === "before-rename") { expect(Object.keys(document.issues)).toEqual([]); expect(existsSync(join(state, "issues/issues.json"))).toBe(false); }
    else {
      expect(failure).toBeInstanceOf(RoutineActionEffectError);
      const id = (failure as RoutineActionEffectError).committed_proposal!.issue_id!, bytes = readFileSync(join(state, "issues/issues.json"));
      expect(Object.keys(document.issues)).toEqual([id]); expect(document.issues[id]!.status).toBe("proposed");
      expect(fixture.proposer()(fixture.proposal, fixture.check)).toBe(id); expect(readFileSync(join(state, "issues/issues.json")).equals(bytes)).toBe(true);
    }
  });
  it.each(["accessor", "proxy", "symbol", "extra"])("refuses %s proposal metadata without invoking a hook or writing state", (kind) => {
    const fixture = routineProposal(), getter = vi.fn(), proposal: unknown = kind === "proxy" ? new Proxy({}, { getPrototypeOf: getter }) : { ...fixture.proposal };
    if (kind === "accessor") Object.defineProperty(proposal, "signal", { enumerable: true, get: getter });
    if (kind === "symbol") Object.defineProperty(proposal, Symbol("instruction"), { value: true, enumerable: true });
    if (kind === "extra") Object.defineProperty(proposal, "command", { value: "never run", enumerable: true });
    expect(() => fixture.proposer()(proposal as RoutineIssueProposal, fixture.check)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(existsSync(join(state, "issues"))).toBe(false); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
  it.each(["completed", "ambiguous-publish"])("composes the real owned action and proposal writer: %s", async (kind) => {
    const fixture = routineProposal(), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const before = readFileSync(join(state, "budgets/budgets.json"));
    if (kind === "ambiguous-publish") vi.mocked(renameSync).mockImplementationOnce((source, destination) => {
      actual.renameSync(source, destination); throw new Error("synthetic post-publication gap");
    });
    const receipt = await executeRoutineAction({ ownership: fixture.proposal.ownership }, {
      state_root: state, assert_current: fixture.gate, propose_issue: fixture.proposer(),
      read_evidence: async (_occurrence, options) => { options.check(); return {
        sources: [{ kind: "ci", project_id: "alpha", state: "fresh", observed_at: fixture.proposal.signal.observed_at, fingerprint: "a".repeat(64) }],
        signals: [fixture.proposal.signal] }; },
      clock: () => new Date("2026-10-06T12:00:01.010Z"), monotonic: () => 0,
    });
    const id = receipt.proposals[0]!.issue_id!;
    expect(receipt.counts.proposals_created).toBe(1); expect(receipt.next_action).toBe("review-proposals");
    expect(readIssueDocument().issues[id]!.status).toBe("proposed"); expect(fakeCreateTask).not.toHaveBeenCalled();
    expect(receipt.consumption).toMatchObject({ attempts: 1, model_calls: 0, total_tokens: 0, workspace_writes: 0 });
    expect(receipt.failure_code).toBe(kind === "completed" ? null : "accounting-unavailable");
    expect(receipt.budget_outcome).toBe(kind === "completed" ? "within-limit" : "unknown");
    expect(readFileSync(join(state, "budgets/budgets.json")).equals(before)).toBe(true); // Settlement belongs to T011, never refund this gap.
  });
  it("projects absent workflow consumption as an explicit read-only empty inventory", () => {
    const issues = service(), issue = issues.create(input()), before = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    expect(issues.get(issue.id).budget_consumption).toEqual({ availability: "available", workflows: [] });
    expect(issues.lineage(issue.id).budget_consumption).toEqual({ availability: "available", workflows: [] });
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before); expect(readdirSync(state, { recursive: true })).toEqual(inventory);
    expect(existsSync(join(state, "workflows"))).toBe(false); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it.each(["malformed", "future"])("keeps %s workflow consumption unavailable without repairing bytes or changing issue state", (kind) => {
    const issues = service(), issue = issues.create(input()), before = readFileSync(join(state, "issues/issues.json"));
    mkdirSync(join(state, "workflows")); const path = join(state, "workflows/workflows.json"), bytes = kind === "malformed" ? "{" : '{"schema_version":99}';
    writeFileSync(path, bytes); const inventory = readdirSync(state, { recursive: true });
    expect(issues.get(issue.id).budget_consumption).toEqual({ availability: "unavailable", workflows: [] });
    expect(issues.lineage(issue.id).budget_consumption).toEqual({ availability: "unavailable", workflows: [] });
    expect(readFileSync(path, "utf8")).toBe(bytes); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before);
    expect(readdirSync(state, { recursive: true })).toEqual(inventory); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it.each(["budget_admission", "budget", "reservation_id", "reservation", "intent_id", "budget_cutover", "cutover", "execution_enabled"])("rejects caller %s before issue mutation or task admission", (key) => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
    const bytes = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    expect(() => issues.dispatch(proposed.id, authorized.revision, "frontend-engineer", { role_id: "software-engineer", preview_fingerprint: "a".repeat(64), [key]: {} })).toThrow(/dispatch admission fields/);
    expect(fakeCreateTask).not.toHaveBeenCalled(); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(bytes);
    expect(readdirSync(state, { recursive: true })).toEqual(inventory); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it("rejects inherited, symbolic, hidden and accessor admission fields before any lock or getter", () => {
    const issues = service(), getter = vi.fn(), inputs = [Object.create({ role_id: "software-engineer" }), { [Symbol("budget")]: true }, Object.defineProperty({}, "role_id", { value: "software-engineer" }), Object.defineProperty({}, "role_id", { enumerable: true, get: getter }), new Proxy({}, { getPrototypeOf: getter }), null, []];
    for (const admission of inputs) expect(() => issues.dispatch("missing", 1, "frontend-engineer", admission as never)).toThrow(/dispatch admission fields/);
    expect(getter).not.toHaveBeenCalled(); expect(fakeCreateTask).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });
  it.each(["legacy", "context-v1"])("reads %s task lineage as a P-only historical scaffold without changing O semantics or bytes", (kind) => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
    const { taskId } = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    if (kind === "context-v1") governQueuedFixture(taskId, authorized.revision);
    const taskPath = join(state, `tasks/${taskId}.json`), taskBytes = readFileSync(taskPath), issueBytes = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    const expected = [{ task_id: taskId, availability: "available", readiness: { phase: "scaffold", executable: false, status: "historical", reason: "budget-admission-required", next_action: expect.any(String) } }];
    expect(issues.get(proposed.id).budget_readiness).toEqual(expected); expect(issues.lineage(proposed.id).budget_readiness).toEqual(expected);
    expect(issues.get(proposed.id).issue.status).toBe("working"); expect(readTask(taskId)!.envelope).not.toHaveProperty("budget_admission");
    expect(readFileSync(taskPath)).toEqual(taskBytes); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes);
    expect(readdirSync(state, { recursive: true })).toEqual(inventory); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it("inspects a valid synthetic bound task as non-executable P data without creating a reservation", () => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
    const { taskId } = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer"); governQueuedFixture(taskId, authorized.revision);
    const source: BudgetPolicySource = { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "synthetic-company", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
    // Test-owned retained shape only, never a production queue retrofit.
    const prepared = prepareTaskBudgetAdmission(readTask(taskId)!, { source, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: proposed.id, role_id: "software-engineer", execution_id: taskId } });
    writeTask(prepared.task); const bytes = readFileSync(join(state, `tasks/${taskId}.json`));
    expect(issues.get(proposed.id).budget_readiness[0]!.readiness).toMatchObject({ phase: "scaffold", executable: false, status: "bound", reason: "budget-cutover-unavailable" });
    expect(readFileSync(join(state, `tasks/${taskId}.json`))).toEqual(bytes); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it.each(["missing", "malformed", "future-budget"])("keeps %s referenced task readiness unavailable without repair or invented admission", (kind) => {
    const issues = service(), proposed = issues.create(input()), authorized = issues.authorize(proposed.id, proposed.revision, "synthetic-human"), { taskId } = issues.dispatch(proposed.id, authorized.revision, "frontend-engineer");
    const path = join(state, `tasks/${taskId}.json`);
    if (kind === "missing") rmSync(path);
    else if (kind === "malformed") writeFileSync(path, "{");
    else { const task = JSON.parse(readFileSync(path, "utf8")); task.envelope.budget_admission = { schema_version: 99 }; writeFileSync(path, JSON.stringify(task)); }
    const bytes = existsSync(path) ? readFileSync(path) : null, issueBytes = readFileSync(join(state, "issues/issues.json")), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(issues.get(proposed.id).budget_readiness).toEqual([{ task_id: taskId, availability: "unavailable", readiness: null }]);
    expect(issues.get(proposed.id).issue.status).toBe("working"); expect(existsSync(path) ? readFileSync(path) : null).toEqual(bytes);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes); expect(existsSync(join(state, "budgets"))).toBe(false); warn.mockRestore();
  });
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
