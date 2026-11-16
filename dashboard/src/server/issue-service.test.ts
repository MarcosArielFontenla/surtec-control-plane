import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { readTask, updateTask, writeTask } from "../../../lib/state/store";
import { assembleContext, contextHash } from "../../../lib/context/assemble";
import { createTestingEvidence, sealTestingEvidence } from "../../../lib/context/testing-evidence";
import type { ReviewCandidate } from "../../../lib/issues/types";
import { defaultTaskOrchestration } from "../../../lib/state/orchestration";
import { mutateIssueDocument, readIssueDocument } from "../../../lib/state/issues";
import * as issueStore from "../../../lib/state/issues";
import { validateIssueDocument } from "../../../lib/state/validation";
import type { TaskRecord } from "../../../lib/state/types";
import type { DeliveryObservation, IssueCreateInput, IssueDocument, RecordDeliveryObservationInput, WorkIssue } from "../../../lib/issues/types";
import { mutateClientPortfolio } from "../../../lib/state/client-portfolio";
import { setProjectObjectives, upsertObjective } from "../../../lib/state/organization";
import * as workflowStore from "../../../lib/state/workflows";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import { createContextService } from "./context-service";
import type { WorkflowDocument } from "../../../lib/workflows/types";
import { createIssueService, createRoutineIssueProposer, IssueServiceError, IssueScopeViolationError, pathsOutsideScope, projectWorkflowIssueLink } from "./issue-service";
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

describe("operator-entered delivery observations", () => {
  const recordedAt = "2026-10-16T12:00:00.000Z";
  const observation = (overrides: Partial<DeliveryObservation> = {}): DeliveryObservation => ({
    schema_version: 1, kind: "readiness-reviewed", origin: "operator-entered", commitment_id: null,
    occurred_at: "2026-10-15T10:00:00.000Z", summary: "Synthetic private delivery fact",
    source_reference: "delivery-note-1", next_action: "Synthetic private follow-up", ...overrides,
  });
  function deliveryService() {
    return createIssueService(root, { projectIds: () => ["alpha", "beta"], createTask: fakeCreateTask, now: () => new Date(recordedAt) });
  }
  const request = (issue: WorkIssue, overrides: Partial<RecordDeliveryObservationInput> = {}): RecordDeliveryObservationInput => ({
    project_id: issue.project_id, expected_revision: issue.revision, scope_revision: issue.scope_revision,
    candidate_id: null, candidate_revision: null, diff_fingerprint: null, delivery_observation: observation(), confirm: true, ...overrides,
  });
  const issueBytes = () => readFileSync(join(state, "issues/issues.json"));
  function seedCommitment(projectId = "alpha", id = "commitment-1") {
    mutateClientPortfolio((document) => { document.commitments[id] = { id, project_id: projectId, client_id: null,
      title: "Synthetic commitment", expected_outcome: "Inspect a fictional delivery", due_date: null, priority: 1,
      criticality: "low", state: "planned", issue_numbers: [], pull_request_numbers: [], task_ids: [], session_ids: [],
      next_action: "Review independently", created_at: recordedAt, updated_at: recordedAt }; });
  }
  function candidateFixture() {
    const issues = deliveryService(), issue = issues.create(input());
    const authorized = issues.authorize(issue.id, issue.revision, "synthetic-human");
    const taskId = issues.dispatch(issue.id, authorized.revision, "frontend-engineer").taskId;
    activateTask(taskId, "delivery-run");
    updateTask(taskId, (task) => { task.orchestration!.lease!.expires_at = new Date(Math.max(Date.now(), Date.parse(recordedAt)) + 60_000).toISOString(); });
    const candidate = issues.recordCandidate({ issueId: issue.id, taskId, executionId: "delivery-run", repositoryId: "alpha",
      baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["dashboard/src/value.ts"], scopeRevision: 1 });
    finishTask(taskId);
    return { issues, issue: readIssueDocument().issues[issue.id]!, taskId, candidate };
  }

  it.each<DeliveryObservation["kind"]>(["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"])("records %s as private informational evidence only", (kind) => {
    const issues = deliveryService(), issue = issues.create(input()), before = readIssueDocument();
    const result = issues.recordDeliveryObservation(issue.id, request(issue, { delivery_observation: observation({ kind, source_reference: "https://delivery.example.test/release/1" }) }));
    const document = readIssueDocument(), { delivery_observation: facet, ...outer } = result.evidence;
    expect(facet).toEqual(observation({ kind, source_reference: "https://delivery.example.test/release/1" }));
    expect(outer).toMatchObject({ kind: "work-product", status: "informational", task_id: null, execution_id: null, candidate_id: null,
      candidate_revision: null, diff_fingerprint: null, scope_revision: 1, label: "Operator-entered delivery observation",
      reference: `/api/work-issues/${issue.id}`, created_at: recordedAt });
    expect(outer).not.toHaveProperty("testing_evidence_fingerprint");
    expect(JSON.stringify(outer)).not.toContain("Synthetic private");
    expect(document.events.at(-1)).toMatchObject({ type: "delivery-observation-recorded", payload: {
      evidence_id: result.evidence.id, kind, candidate_id: null, commitment_id: null } });
    expect(JSON.stringify(document.events)).not.toContain("Synthetic private");
    expect(result.issue).toEqual({ ...before.issues[issue.id], evidence_ids: [result.evidence.id], revision: issue.revision + 1, updated_at: recordedAt });
    expect(document.candidates).toEqual(before.candidates); expect(fakeCreateTask).not.toHaveBeenCalled();
    expect(existsSync(join(state, "tasks"))).toBe(false); expect(existsSync(join(state, "workflows"))).toBe(false);
    expect(existsSync(join(state, "portfolio"))).toBe(false); expect(existsSync(join(state, "budgets"))).toBe(false);
    const bytes = issueBytes(); expect(deliveryService().get(issue.id).evidence.at(-1)).toEqual(result.evidence); expect(issueBytes()).toEqual(bytes);
    expect(issues.get(issue.id).evidence_gaps.join(" ")).toMatch(/verification|review/i);
  });

  it("preserves absent legacy facets and refuses stale or repeated revisions without another append", () => {
    const { issues, issue, candidate } = candidateFixture(), bytes = issueBytes();
    expect(issues.get(issue.id).evidence.every((entry) => !Object.hasOwn(entry, "delivery_observation"))).toBe(true);
    expect(issueBytes()).toEqual(bytes);
    const body = request(issue, { candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint });
    const result = issues.recordDeliveryObservation(issue.id, body), recorded = issueBytes();
    expect(result.evidence).toMatchObject({ candidate_id: candidate.id, candidate_revision: candidate.candidate_revision,
      diff_fingerprint: candidate.diff_fingerprint, task_id: null, execution_id: null });
    expect(() => issues.recordDeliveryObservation(issue.id, body)).toThrow(/revision|scope changed/);
    expect(issueBytes()).toEqual(recorded); expect(readIssueDocument().issues[issue.id]!.evidence_ids).toHaveLength(issue.evidence_ids.length + 1);
  });

  it("cannot turn manual readiness into verification, local acceptance or dispatched instructions", () => {
    const issues = deliveryService(), issue = issues.create(input());
    const recorded = issues.recordDeliveryObservation(issue.id, request(issue));
    expect(recorded.issue.status).toBe("proposed"); expect(recorded.issue.authorized_scope).toEqual(issue.authorized_scope);
    expect(() => issues.dispatch(issue.id, recorded.issue.revision, "frontend-engineer")).toThrow(/authorization/);
    const authorized = issues.authorize(issue.id, recorded.issue.revision, "synthetic-human");
    issues.dispatch(issue.id, authorized.revision, "frontend-engineer");
    expect(vi.mocked(fakeCreateTask).mock.calls[0]![0].instructions).not.toContain("Synthetic private");
    expect(recorded.evidence.status).toBe("informational"); expect(recorded.evidence.kind).not.toBe("verification");
  });

  it("excludes every private response field from actual issue and workflow context assembly without effects", () => {
    const projectRoot = join(root, "projects"), project = join(projectRoot, "alpha");
    mkdirSync(join(project, ".git"), { recursive: true }); mkdirSync(join(root, "registry"));
    for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "budget-policy.yml"]) cpSync(join("registry", name), join(root, "registry", name));
    const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
    for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
      mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
    }
    writeFileSync(join(root, "registry/projects.yml"), JSON.stringify({ projects: { alpha: {
      allowed_agents: ["tech-lead", "backend-engineer"], sandbox: { default: "workspace-write" }, verify: ["node verify.mjs"],
    } } }));
    const previousProjectsRoot = process.env.SURTEC_PROJECTS_ROOT; process.env.SURTEC_PROJECTS_ROOT = projectRoot;
    try {
      const issues = deliveryService(), proposed = issues.create(input({ assigned_role_id: "backend-engineer" }));
      const privateFields = { summary: "Synthetic confidential response marker", source_reference: "private-response-source-732",
        next_action: "Synthetic confidential next-action marker" };
      const recorded = issues.recordDeliveryObservation(proposed.id, request(proposed, { delivery_observation: observation({
        kind: "client-response-recorded", ...privateFields,
      }) }));
      const issue = issues.authorize(proposed.id, recorded.issue.revision, "synthetic-human"), bytes = issueBytes(), inventory = readdirSync(state, { recursive: true });
      const context = createContextService(root), body = { kind: "issue", project: "alpha", agent: "backend-engineer",
        role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision };
      const preview = context.preview(body), admitted = context.admit(body, preview.fingerprint);
      const planning = context.assembleWorkflowRole({ ...body, agent: "tech-lead", role_id: "planner" }, "planning");
      expect(preview.allowed).toBe(true); expect(planning.preview.allowed).toBe(true);
      expect(admitted.issue!.evidence_ids).toContain(recorded.evidence.id);
      expect(preview.manifest.sources.some((entry) => entry.id === "issue/authorized-work")).toBe(true);
      expect(preview.manifest.selected_categories).toEqual([]); expect(planning.preview.manifest.selected_categories).toEqual([]);
      for (const marker of Object.values(privateFields)) {
        expect(JSON.stringify(preview)).not.toContain(marker); expect(admitted.rendered).not.toContain(marker);
        expect(JSON.stringify(planning.preview)).not.toContain(marker); expect(planning.rendered).not.toContain(marker);
      }
      expect(issueBytes()).toEqual(bytes); expect(readdirSync(state, { recursive: true })).toEqual(inventory);
      expect(fakeCreateTask).not.toHaveBeenCalled(); expect(existsSync(join(state, "tasks"))).toBe(false);
      expect(existsSync(join(state, "workflows"))).toBe(false); expect(existsSync(join(state, "budgets"))).toBe(false);
    } finally {
      if (previousProjectsRoot === undefined) delete process.env.SURTEC_PROJECTS_ROOT; else process.env.SURTEC_PROJECTS_ROOT = previousProjectsRoot;
    }
  });

  it.each([
    ["future facet", { schema_version: 2 }], ["wrong origin", { origin: "runtime-generated" }], ["unknown kind", { kind: "verification-passed" }],
    ["future time", { occurred_at: "2026-10-16T12:00:00.001Z" }], ["invalid calendar", { occurred_at: "2026-02-30T10:00:00.000Z" }],
    ["blank summary", { summary: " " }], ["long summary", { summary: "s".repeat(501) }], ["padded summary", { summary: " padded " }],
    ["long next action", { next_action: "n".repeat(501) }], ["empty next action", { next_action: "" }], ["control text", { next_action: "next\u0000action" }],
    ["credential summary", { summary: "password=synthetic-value" }], ["credential next action", { next_action: "api_key=synthetic-value" }],
    ["credential source", { source_reference: "sk-synthetic0123456789" }], ["unknown property", { approval: true }],
    ["file source", { source_reference: "file:///C:/private/note.txt" }], ["absolute source", { source_reference: "C:\\private\\note.txt" }],
    ["relative source", { source_reference: "../private.txt" }], ["command source", { source_reference: "node verify.mjs" }],
    ["userinfo source", { source_reference: "https://user:pass@example.test/fact" }], ["query source", { source_reference: "https://example.test/fact?secret=x" }],
    ["fragment source", { source_reference: "https://example.test/fact#value" }], ["encoded source", { source_reference: "https://example.test/%2e%2e" }],
    ["long source", { source_reference: "s".repeat(301) }], ["invalid commitment", { commitment_id: "../other" }],
  ])("rejects %s without mutating bytes", (_name, fields) => {
    const issues = deliveryService(), issue = issues.create(input()), bytes = issueBytes();
    const body = request(issue, { delivery_observation: { ...observation(), ...fields } as DeliveryObservation });
    expect(() => issues.recordDeliveryObservation(issue.id, body)).toThrow(); expect(issueBytes()).toEqual(bytes); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it("rejects unconfirmed, unknown, inherited, hidden, symbolic, accessor and proxy request data before getters or persistence", () => {
    const issues = deliveryService(), issue = issues.create(input()), bytes = issueBytes(), getter = vi.fn();
    const body = request(issue), malformed = [null, [], { ...body, confirm: false }, { ...body, expected_revision: 1.5 },
      { ...body, scope_revision: 0 }, { ...body, runtime: true }, { ...body, delivery_observation: null },
      Object.assign(Object.create({ confirm: true }), body), { ...body, [Symbol("authority")]: true },
      Object.defineProperty({ ...body }, "confirm", { enumerable: false, value: true }),
      Object.defineProperty({ ...body }, "confirm", { enumerable: true, get: getter }),
      new Proxy(body, { getPrototypeOf: getter }), { ...body, delivery_observation: new Proxy(observation(), { getPrototypeOf: getter }) },
      { ...body, delivery_observation: Object.defineProperty(observation(), "summary", { enumerable: true, get: getter }) }];
    for (const value of malformed) expect(() => issues.recordDeliveryObservation(issue.id, value as never)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(issueBytes()).toEqual(bytes); expect(fakeCreateTask).not.toHaveBeenCalled();
    expect(readdirSync(join(state, "issues"))).toEqual(["issues.json"]);
  });

  it.each(["project", "scope", "missing-candidate", "cross-issue", "revision", "fingerprint", "invalidated", "not-latest", "partial-binding"])("refuses %s binding without rewriting evidence", (change) => {
    const { issues, issue, candidate } = candidateFixture();
    const other = issues.create(input({ project_id: "beta" }));
    const body = request(issue, { candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint });
    if (change === "project") body.project_id = "beta";
    if (change === "scope") body.scope_revision++;
    if (change === "missing-candidate") body.candidate_id = `C-${randomUUID()}`;
    if (change === "revision") body.candidate_revision = "c".repeat(40);
    if (change === "fingerprint") body.diff_fingerprint = "d".repeat(64);
    if (change === "partial-binding") body.candidate_revision = null;
    if (["cross-issue", "invalidated", "not-latest"].includes(change)) mutateIssueDocument((document) => {
      if (change === "cross-issue") {
        const id = `C-${randomUUID()}`; document.candidates[id] = { ...candidate, id, issue_id: other.id, repository_id: "beta" };
        document.issues[other.id]!.candidate_ids.push(id); body.candidate_id = id;
      }
      if (change === "invalidated") document.candidates[candidate.id]!.invalidated_at = recordedAt;
      if (change === "not-latest") {
        const id = `C-${randomUUID()}`; document.candidates[id] = { ...candidate, id }; document.issues[issue.id]!.candidate_ids.push(id);
      }
    });
    const bytes = issueBytes(); expect(() => issues.recordDeliveryObservation(issue.id, body)).toThrow(); expect(issueBytes()).toEqual(bytes);
  });

  it("retains historical candidate and scope facts after later invalidation without rewriting them", () => {
    const { issues, issue, candidate } = candidateFixture();
    const saved = issues.recordDeliveryObservation(issue.id, request(issue, { candidate_id: candidate.id,
      candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint }));
    mutateIssueDocument((document) => { document.candidates[candidate.id]!.invalidated_at = recordedAt; document.issues[issue.id]!.scope_revision++; });
    const bytes = issueBytes(); expect(deliveryService().get(issue.id).evidence.find((entry) => entry.id === saved.evidence.id)).toEqual(saved.evidence);
    expect(issueBytes()).toEqual(bytes); expect(saved.evidence.scope_revision).toBe(1);
  });

  it("validates an existing same-project commitment without changing its bytes or state", () => {
    const issues = deliveryService(), issue = issues.create(input({ related_commitment_ids: ["commitment-1"] })); seedCommitment();
    const path = join(state, "portfolio/clients.json"), before = readFileSync(path);
    const result = issues.recordDeliveryObservation(issue.id, request(issue, { delivery_observation: observation({ kind: "client-response-recorded", commitment_id: "commitment-1" }) }));
    expect(result.evidence.delivery_observation!.commitment_id).toBe("commitment-1"); expect(readFileSync(path)).toEqual(before);
    expect(JSON.parse(readFileSync(path, "utf8")).commitments["commitment-1"].state).toBe("planned");
    expect(existsSync(join(state, "locks/client-portfolio.lock"))).toBe(false);
  });

  it.each(["unlinked", "missing", "cross-project", "malformed", "future", "hard-linked", "oversized"])("refuses %s commitment source without changing issue or source bytes", (change) => {
    const issues = deliveryService(), issue = issues.create(input({ related_commitment_ids: change === "unlinked" ? [] : ["commitment-1"] }));
    const path = join(state, "portfolio/clients.json");
    if (change !== "missing") seedCommitment(change === "cross-project" ? "beta" : "alpha");
    if (change === "malformed") writeFileSync(path, "{");
    if (change === "future") writeFileSync(path, '{"schema_version":99}');
    if (change === "hard-linked") linkSync(path, join(state, "portfolio/copy.json"));
    if (change === "oversized") writeFileSync(path, " ".repeat(10 * 1024 * 1024 + 1));
    const before = issueBytes(), source = existsSync(path) ? readFileSync(path) : null;
    expect(() => issues.recordDeliveryObservation(issue.id, request(issue, { delivery_observation: observation({ commitment_id: "commitment-1" }) }))).toThrow();
    expect(issueBytes()).toEqual(before);
    const retained = existsSync(path) ? readFileSync(path) : null;
    expect(source === null ? retained === null : retained !== null && retained.equals(source)).toBe(true);
  });

  it.each(["queued", "running", "missing", "malformed"])("refuses %s task ownership without changing task or issue", (change) => {
    const issues = deliveryService(), issue = issues.create(input()), authorized = issues.authorize(issue.id, issue.revision, "synthetic-human");
    const admitted = issues.dispatch(issue.id, authorized.revision, "frontend-engineer"), path = join(state, `tasks/${admitted.taskId}.json`);
    if (change === "running") activateTask(admitted.taskId, "delivery-running");
    if (change === "missing") rmSync(path);
    if (change === "malformed") writeFileSync(path, "{");
    const before = issueBytes(), task = existsSync(path) ? readFileSync(path) : null;
    expect(() => issues.recordDeliveryObservation(issue.id, request(admitted.issue))).toThrow(/owner/);
    expect(issueBytes()).toEqual(before); expect(existsSync(path) ? readFileSync(path) : null).toEqual(task);
  });

  it.each(["proposed", "running", "awaiting-decision", "stopped"])("keeps %s workflow ownership fenced without changing grants or issue", (status) => {
    const issues = deliveryService(), issue = issues.create(input()), before = issueBytes(), document = workflowStore.readWorkflowDocument();
    document.workflows["WF-synthetic"] = { id: "WF-synthetic", issue_id: issue.id, status } as never;
    const snapshot = structuredClone(document); vi.spyOn(workflowStore, "readWorkflowDocument").mockReturnValue(document);
    expect(() => issues.recordDeliveryObservation(issue.id, request(issue))).toThrow(/workflow owner/);
    expect(issueBytes()).toEqual(before); expect(document).toEqual(snapshot); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it.each(["malformed", "future"])("refuses %s workflow source without repairing it", (change) => {
    const issues = deliveryService(), issue = issues.create(input()), before = issueBytes(), path = join(state, "workflows/workflows.json");
    mkdirSync(join(state, "workflows")); const bytes = change === "malformed" ? "{" : '{"schema_version":99}'; writeFileSync(path, bytes);
    expect(() => issues.recordDeliveryObservation(issue.id, request(issue))).toThrow(/ownership is unavailable/);
    expect(issueBytes()).toEqual(before); expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each(["manual", "issue-evidence", "global-evidence", "events"])("refuses %s overflow without evicting history", (limit) => {
    const issues = deliveryService(), issue = issues.create(input());
    const seed = (document: IssueDocument) => {
      const owners = [document.issues[issue.id]!];
      if (limit === "global-evidence") for (let index = 0; index < 10; index++) {
        const id = `I-${randomUUID()}`; document.issues[id] = { ...structuredClone(issue), id, evidence_ids: [] }; owners.push(document.issues[id]!);
      }
      if (limit === "events") while (document.events.length < 20_000) document.events.push({ id: randomUUID(), issue_id: issue.id, type: "synthetic-history", at: recordedAt, scope_revision: 1, payload: {} });
      const count = limit === "manual" ? 64 : limit === "issue-evidence" ? 500 : limit === "global-evidence" ? 5000 : 0;
      for (let index = 0; index < count; index++) {
        const owner = owners[limit === "global-evidence" ? Math.floor((index + 1) / 500) : Math.floor(index / 500)]!, id = `E-${randomUUID()}`;
        document.evidence[id] = { schema_version: 1, id, issue_id: owner.id, task_id: null, execution_id: null, candidate_id: null,
          candidate_revision: null, diff_fingerprint: null, scope_revision: 1, kind: "work-product", label: "Synthetic history", reference: "history",
          status: "informational", created_at: recordedAt, ...(limit === "manual" ? { delivery_observation: observation() } : {}) };
        owner.evidence_ids.push(id);
      }
    };
    let retained: IssueDocument | undefined, snapshot: IssueDocument | undefined;
    if (limit === "manual" || limit === "issue-evidence") mutateIssueDocument(seed);
    else {
      // Exercise the service's aggregate-capacity refusal at its mutation boundary,
      // without repeated filesystem round trips for a maximal synthetic store.
      retained = readIssueDocument(); seed(retained); expect(validateIssueDocument(retained)).toBe(true); snapshot = structuredClone(retained);
      vi.spyOn(issueStore, "mutateIssueDocument").mockImplementationOnce((mutate) => mutate(retained!));
    }
    const bytes = issueBytes(); expect(() => issues.recordDeliveryObservation(issue.id, request(issue))).toThrow(/capacity/); expect(issueBytes()).toEqual(bytes);
    if (retained) expect(retained).toEqual(snapshot);
  });

  it("preserves original bytes and removes only its temporary file after atomic replacement fails", () => {
    const issues = deliveryService(), issue = issues.create(input()), bytes = issueBytes();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic delivery replacement failure"); });
    expect(() => issues.recordDeliveryObservation(issue.id, request(issue))).toThrow(/replacement failure/);
    expect(issueBytes()).toEqual(bytes); expect(readdirSync(join(state, "issues"))).toEqual(["issues.json"]);
    expect(readIssueDocument().events.filter((event) => event.type === "delivery-observation-recorded")).toHaveLength(0);
  });
});

describe("durable manual intake identity in the issue service", () => {
  const issuePath = () => join(state, "issues/issues.json");
  const bytes = () => readFileSync(issuePath());
  const keyedInput = (overrides: Partial<IssueCreateInput> = {}) => input({ request_id: randomUUID(), ...overrides });
  const richInput = () => keyedInput({ plan: ["Inspect the bounded change.", "Implement and verify it."], next_action: "Inspect the existing view.",
    external_references: [{ provider: "github", url: "https://example.invalid/issues/1", reference: "request-1" },
      { provider: "github", url: "https://example.invalid/issues/2", reference: "request-2" }] });
  function expectStatus(action: () => unknown, status: number): void {
    let failure: unknown;
    try { action(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(IssueServiceError);
    expect(failure).toMatchObject({ status });
  }

  it("creates one server receipt and proposal event without authorizing or dispatching work", () => {
    const payload = keyedInput(), created = service().create(payload), document = readIssueDocument();
    expect(created.intake_receipt).toEqual({ schema_version: 1, request_id: payload.request_id, request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(document.issues)).toEqual([created.id]);
    expect(document.events.map((event) => event.type)).toEqual(["issue-proposed"]);
    expect(created.status).toBe("proposed"); expect(created.task_ids).toEqual([]); expect(created.candidate_ids).toEqual([]);
    expect(document.evidence).toEqual({}); expect(fakeCreateTask).not.toHaveBeenCalled();
    expect(existsSync(join(state, "tasks"))).toBe(false); expect(existsSync(join(state, "workflows"))).toBe(false);
  });

  it("retains the unkeyed internal legacy path without adding retrospective receipts", () => {
    const issues = service(), first = issues.create(input()), second = issues.create(input());
    expect(first.id).not.toBe(second.id);
    expect(Object.hasOwn(first, "intake_receipt")).toBe(false); expect(Object.hasOwn(second, "intake_receipt")).toBe(false);
    expect(Object.values(readIssueDocument().issues).every((issue) => !Object.hasOwn(issue, "intake_receipt"))).toBe(true);
  });

  it("treats validated defaults, trimmed text and object-key order as the same original request", () => {
    const payload = keyedInput(), issues = service(), created = issues.create(payload), before = bytes();
    const explicit = { ...payload, title: ` ${payload.title} `, objective_id: null, parent_issue_id: null,
      classification_inputs: { security_impact: false, requires_migration: false, affected_domains: [] }, plan: [], priority: 50, criticality: "low" as const,
      blocked_by_issue_ids: [], related_commitment_ids: [], external_references: [], next_action: null,
      authorized_scope: Object.fromEntries(Object.entries(payload.authorized_scope).reverse()) as unknown as IssueCreateInput["authorized_scope"] };
    const reordered = Object.fromEntries(Object.entries(explicit).reverse()) as unknown as IssueCreateInput;
    vi.mocked(renameSync).mockClear();
    expect(issues.create(reordered)).toEqual(created); expect(bytes()).toEqual(before);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled(); expect(readIssueDocument().events).toHaveLength(1);
  });

  it("normalizes reference object keys while preserving their array order", () => {
    const payload = richInput(), issues = service(), created = issues.create(payload), before = bytes();
    const reordered = { ...payload, external_references: payload.external_references!.map(({ provider, url, reference }) => ({ reference, url, provider })) };
    vi.mocked(renameSync).mockClear();
    expect(issues.create(reordered).id).toBe(created.id); expect(bytes()).toEqual(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("returns current progress after service restart without resetting state or rewriting original bytes", () => {
    const payload = keyedInput(), issues = service(), created = issues.create(payload);
    issues.authorize(created.id, created.revision, "synthetic-intake-scope-review");
    mutateIssueDocument((document) => {
      document.issues[created.id]!.next_action = "Follow the current reviewed action.";
      document.issues[created.id]!.plan = ["Current stored plan note."];
      document.issues[created.id]!.revision++;
    });
    const current = readIssueDocument();
    writeFileSync(issuePath(), `\n${JSON.stringify(current, null, 1)}\n`, "utf8");
    const before = bytes(), restarted = createIssueService(root, { projectIds: () => ["alpha"], createTask: fakeCreateTask, now: () => new Date("2030-01-01T00:00:00Z") });
    vi.mocked(renameSync).mockClear();
    const replay = restarted.create(structuredClone(payload));
    expect(replay).toEqual(current.issues[created.id]); expect(replay.status).toBe("authorized");
    expect(replay.intake_receipt).toEqual(created.intake_receipt); expect(bytes()).toEqual(before);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled(); expect(readIssueDocument().events).toEqual(current.events); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  const changedFields: [string, (payload: IssueCreateInput) => void][] = [
    ["title", (payload) => { payload.title = "A different requested result"; }],
    ["outcome", (payload) => { payload.expected_outcome = "A different expected outcome."; payload.authorized_scope.expected_outcome = payload.expected_outcome; }],
    ["acceptance criteria", (payload) => { payload.acceptance_criteria.push("Another required result."); payload.authorized_scope.acceptance_criteria = [...payload.acceptance_criteria]; }],
    ["allowed paths", (payload) => { payload.authorized_scope.allowed_path_patterns.push("docs/**"); }],
    ["excluded paths", (payload) => { payload.authorized_scope.excluded_path_patterns.push("docs/private/**"); }],
    ["change categories", (payload) => { payload.authorized_scope.allowed_change_categories.push("docs"); }],
    ["explicit exclusions", (payload) => { payload.authorized_scope.explicit_exclusions.push("Keep the existing navigation."); }],
    ["affected domains", (payload) => { payload.classification_inputs = { affected_domains: ["ui"] }; }],
    ["migration classification", (payload) => { payload.classification_inputs = { requires_migration: true }; }],
    ["security classification", (payload) => { payload.classification_inputs = { security_impact: true }; }],
    ["plan", (payload) => { payload.plan = ["A different bounded plan."]; }],
    ["priority", (payload) => { payload.priority = 51; }],
    ["criticality", (payload) => { payload.criticality = "high"; }],
    ["parent", (payload) => { payload.parent_issue_id = `I-${randomUUID()}`; }],
    ["blockers", (payload) => { payload.blocked_by_issue_ids = [`I-${randomUUID()}`]; }],
    ["assignment", (payload) => { payload.assigned_role_id = "backend-engineer"; }],
    ["commitments", (payload) => { payload.related_commitment_ids = ["commitment-other"]; }],
    ["external references", (payload) => { payload.external_references![0]!.reference = "request-other"; }],
    ["next action", (payload) => { payload.next_action = "Review a different next action."; }],
    ["project", (payload) => { payload.project_id = "beta"; }],
    ["objective", (payload) => { payload.objective_id = "objective-not-linked"; }],
  ];
  it.each(changedFields)("rejects the same request identity with changed %s without new state", (_field, change) => {
    const payload = richInput(), issues = createIssueService(root, { projectIds: () => ["alpha", "beta"], createTask: fakeCreateTask });
    const created = issues.create(payload), before = bytes(), changed = structuredClone(payload); change(changed);
    vi.mocked(renameSync).mockClear();
    expectStatus(() => issues.create(changed), 409);
    expect(bytes()).toEqual(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(Object.keys(readIssueDocument().issues)).toEqual([created.id]); expect(readIssueDocument().events).toHaveLength(1); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it.each(["criticality", "migration", "security"])("resolves changed identity before the new-create %s plan requirement", (kind) => {
    const payload = keyedInput(), issues = service(); issues.create(payload); const before = bytes(), changed = structuredClone(payload);
    if (kind === "criticality") changed.criticality = "high";
    if (kind === "migration") changed.classification_inputs = { requires_migration: true };
    if (kind === "security") changed.classification_inputs = { security_impact: true };
    expectStatus(() => issues.create(changed), 409); expect(bytes()).toEqual(before);
  });

  it.each(["criteria", "plan", "categories", "references"])("keeps %s array order significant to the original request", (kind) => {
    const payload = richInput(), issues = service(); issues.create(payload); const before = bytes(), changed = structuredClone(payload);
    if (kind === "criteria") { changed.acceptance_criteria.reverse(); changed.authorized_scope.acceptance_criteria = [...changed.acceptance_criteria]; }
    if (kind === "plan") changed.plan!.reverse();
    if (kind === "categories") changed.authorized_scope.allowed_change_categories.reverse();
    if (kind === "references") changed.external_references!.reverse();
    expectStatus(() => issues.create(changed), 409); expect(bytes()).toEqual(before);
  });

  it("allows distinct request identities for equivalent content", () => {
    const payload = keyedInput(), issues = service(), first = issues.create(payload), second = issues.create({ ...payload, request_id: randomUUID() });
    expect(second.id).not.toBe(first.id); expect(second.intake_receipt!.request_id).not.toBe(first.intake_receipt!.request_id);
    expect(second.intake_receipt!.request_fingerprint).toBe(first.intake_receipt!.request_fingerprint);
    expect(Object.keys(readIssueDocument().issues)).toHaveLength(2); expect(readIssueDocument().events).toHaveLength(2);
  });

  it.each([null, 1, [], "", "not-a-uuid", "A1111111-B222-4333-8444-E55555555555", " a1111111-b222-4333-8444-e55555555555 "])("refuses an invalid supplied request identity before creating state (%#)", (requestId) => {
    expectStatus(() => service().create(input({ request_id: requestId as string })), 400);
    expect(existsSync(issuePath())).toBe(false); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it("rejects a caller-owned intake receipt instead of trusting or overwriting it", () => {
    const payload = { ...keyedInput(), intake_receipt: { schema_version: 1, request_id: randomUUID(), request_fingerprint: "f".repeat(64) } };
    expectStatus(() => service().create(payload), 400); expect(existsSync(issuePath())).toBe(false); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it("resolves replay before the issue capacity check while preserving all retained records", () => {
    const payload = keyedInput(), issues = service(), created = issues.create(payload), legacy = structuredClone(created); delete legacy.intake_receipt;
    const document = readIssueDocument();
    const prefix = created.id.startsWith("I-00000000-0000-4000-8000-") ? "I-11111111-0000-4000-8000-" : "I-00000000-0000-4000-8000-";
    for (let index = 0; index < 499; index++) {
      const id = `${prefix}${index.toString(16).padStart(12, "0")}`;
      document.issues[id] = { ...legacy, id, title: `Synthetic capacity record ${index}` };
    }
    // Seed only the synthetic fixture compactly; both exercised create paths
    // below still use the real locked store and validate all 500 records.
    writeFileSync(issuePath(), JSON.stringify(document), "utf8");
    const before = bytes(); vi.mocked(renameSync).mockClear();
    expect(issues.create(payload).id).toBe(created.id);
    expect(bytes().equals(before), "replay preserves exact state bytes").toBe(true);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expectStatus(() => issues.create({ ...payload, request_id: randomUUID() }), 409);
    expect(Object.keys(readIssueDocument().issues)).toHaveLength(500);
    expect(bytes().equals(before), "capacity rejection preserves exact state bytes").toBe(true);
  });

  it("recovers an original receipt after its objective is legitimately unlinked", () => {
    const objectiveId = "intake-objective";
    upsertObjective({ schema_version: 1, id: objectiveId, company_id: "surtec", title: "Synthetic intake goal", desired_outcome: "Verify request identity.",
      success_criteria: ["Keep one original request."], status: "draft", horizon: "now", priority: 1, target_date: null, parent_objective_id: null,
      project_ids: [], owner: "marcos", last_reviewed_at: null });
    setProjectObjectives("alpha", [objectiveId], objectiveId);
    const payload = keyedInput({ objective_id: objectiveId }), issues = service(), created = issues.create(payload);
    setProjectObjectives("alpha", [], null);
    const before = bytes(); vi.mocked(renameSync).mockClear();
    expect(service().create(payload)).toEqual(created); expect(bytes()).toEqual(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expectStatus(() => issues.create({ ...payload, request_id: randomUUID() }), 409); expect(bytes()).toEqual(before);
  });

  it("returns the current issue before rechecking removed original parent and blocker references", () => {
    const issues = service(), originalParent = issues.create(input({ title: "Synthetic original dependency" }));
    const payload = keyedInput({ parent_issue_id: originalParent.id, blocked_by_issue_ids: [originalParent.id] }), created = issues.create(payload);
    mutateIssueDocument((document) => {
      const current = document.issues[created.id]!; current.parent_issue_id = null; current.blocked_by_issue_ids = []; current.revision++;
      delete document.issues[originalParent.id];
    });
    const expected = readIssueDocument().issues[created.id], before = bytes(); vi.mocked(renameSync).mockClear();
    expect(service().create(payload)).toEqual(expected); expect(bytes()).toEqual(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("retains current project access requirements when a request is replayed", () => {
    const payload = keyedInput(); service().create(payload); const before = bytes();
    const unavailable = createIssueService(root, { projectIds: () => [], createTask: fakeCreateTask });
    expectStatus(() => unavailable.create(payload), 404); expect(bytes()).toEqual(before); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it("refuses a competing locked replay before any issue or task effect", () => {
    const payload = keyedInput(), issues = service(); issues.create(payload); const before = bytes();
    mkdirSync(join(state, "locks"), { recursive: true }); const lockPath = join(state, "locks/issues.lock"), owner = "synthetic-intake-lock-owner\n";
    writeFileSync(lockPath, owner, "utf8");
    expect(() => service().create(payload)).toThrow(/lock is busy/); expect(bytes()).toEqual(before); expect(readFileSync(lockPath, "utf8")).toBe(owner);
    expect(readIssueDocument().events).toHaveLength(1); expect(fakeCreateTask).not.toHaveBeenCalled();
  });

  it("preserves the aggregate after failed replacement and permits one later explicit same-identity retry", () => {
    const issues = service(); issues.create(input({ title: "Retained legacy baseline" })); const payload = keyedInput(), before = bytes();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("Synthetic manual intake replacement failure"); });
    expect(() => issues.create(payload)).toThrow("Synthetic manual intake replacement failure"); expect(bytes()).toEqual(before);
    expect(readdirSync(join(state, "issues"))).toEqual(["issues.json"]);
    const retried = service().create(payload), after = bytes(); vi.mocked(renameSync).mockClear();
    expect(service().create(payload)).toEqual(retried); expect(bytes()).toEqual(after); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(Object.keys(readIssueDocument().issues)).toHaveLength(2); expect(readIssueDocument().events).toHaveLength(2); expect(fakeCreateTask).not.toHaveBeenCalled();
  });
});
