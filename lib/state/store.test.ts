import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeTask, readTask, listTasks, upsertProjectOverride, listProjectOverrides, updateTask, withStateLock, StateLockConflictError } from "./store";
import type { TaskRecord } from "./types";
import { assembleContext, contextHash } from "../context/assemble";
import { defaultTaskOrchestration } from "./orchestration";
import { createTestingEvidence, sealTestingEvidence } from "../context/testing-evidence";
import type { ContextAdmissionV2 } from "../context/types";
import { assertTaskBudgetAdmissionBinding, budgetAdmissionVersion, contextAdmissionVersion, taskBudgetReadiness, validateTaskRecord } from "./validation";
import { BUDGET_DIMENSIONS, type BudgetAdmission, type BudgetLimits } from "../budgets/types";
import { budgetTaskIntentId } from "../budgets/reservations";

function makeRecord(id: string): TaskRecord {
  return {
    envelope: {
      id, source: "cli", project: "stock-control", task_type: "bugfix",
      agent: "backend-engineer", title: `Task ${id}`, instructions: "do it",
      repo_path: "~/dev/surtec/stock-control", branch: `agent/${id}`,
      sandbox: "workspace-write", expected_outputs: ["summary"],
      requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-28T10:00:00Z", started_at: null,
    updated_at: "2026-05-28T10:00:00Z", finished_at: null,
    result: null, logs_path: null,
  };
}
function governedRecord(id: string, analysis = false): TaskRecord {
  const record = makeRecord(id);
  if (analysis) { record.envelope.task_type = "analysis"; record.envelope.sandbox = "read-only"; }
  const budget = { max_attempts: 2, max_runtime_ms: 60_000, max_total_tokens: 10_000 };
  record.orchestration = { ...defaultTaskOrchestration(), ...budget };
  record.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: record.envelope.project, agent_id: record.envelope.agent, task_kind: record.envelope.task_type, role_id: "software-engineer", sandbox: record.envelope.sandbox,
    tools: analysis ? ["inspect"] : ["inspect", "edit-authorized-scope"], approval_rules: ["publication"], budget, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic bounded fixture"], delegation: { admitted: false, executable: false, reasons: ["No delegated execution"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Default functional policy"], requires_red_evidence: false } },
  [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic policy body never persisted.", reason: "Mandatory fixture", sensitivity: "public" }]).manifest;
  return record;
}
function workflowRecord(id = "WORKFLOW-TASK", kind: ContextAdmissionV2["stage_kind"] = "review", template: ContextAdmissionV2["template_id"] = "quality-review", selectedRole?: ContextAdmissionV2["role_id"]): TaskRecord {
  const writer = kind === "implementation" || kind === "correction";
  const record = governedRecord(id, !writer);
  record.envelope.task_type = writer ? "implementation" : "analysis";
  const role: Record<ContextAdmissionV2["stage_kind"], ContextAdmissionV2["role_id"]> = { analysis: "portfolio-analyst", planning: "planner", implementation: "software-engineer", correction: "software-engineer", review: "reviewer", qa: "qa-evaluator", operations: "operations-observer" };
  const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
  const roleId = selectedRole ?? role[kind];
  const manifest = { ...unsigned, role_id: roleId, task_kind: record.envelope.task_type };
  record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
  const predecessor = (writer && template === "implementation") || kind === "correction";
  record.envelope.context_admission = {
    schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: kind, task_id: id,
    template_id: template, template_version: 1, grant_id: "grant-1", authority_revision: 1, role_id: roleId, issue_id: "issue-1", issue_revision: 3,
    scope_revision: 2, scope_fingerprint: contextHash("Synthetic authorized scope"), approved_plan: writer && template === "implementation" ? { stage_id: "plan-1", output_fingerprint: "a".repeat(64), decision_id: "decision-1" } : null,
    predecessor_stage_id: predecessor ? "predecessor-1" : null, handoff_id: predecessor ? "handoff-1" : null,
    candidate: template === "quality-review" || kind === "correction" || (["review", "qa"].includes(kind) && ["implementation", "trivial-change"].includes(template)) ? {
      candidate_id: "candidate-1", issue_id: "issue-1", repository_id: record.envelope.project, task_id: "engineer-task-1", execution_id: "engineer-run-1", scope_revision: 2,
      base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), changed_paths: ["src/fixture.ts"], diff_fingerprint: "c".repeat(64), content_fingerprint: "d".repeat(64), testing_evidence_fingerprint: "e".repeat(64),
    } : null,
    manifest_fingerprint: record.envelope.context_manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions),
  };
  return record;
}
function budgetRecord(id = "BUDGET-TASK", kind: "analysis" | "issue" | "workflow" | "correction" = "analysis"): TaskRecord {
  const record = kind === "workflow" || kind === "correction" ? workflowRecord(id, kind === "correction" ? "correction" : "review", "trivial-change") : governedRecord(id, kind === "analysis");
  if (kind === "issue") {
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, task_kind: "implementation" }; record.envelope.task_type = "implementation";
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    Object.assign(record.envelope.metadata, { issue_id: "issue-1", issue_scope_revision: 2, issue_authorized_scope: { allowed_paths: ["src/fixture.ts"], excluded_paths: ["src/private.ts"] } });
  }
  const manifest = record.envelope.context_manifest!;
  if (!record.envelope.context_admission) record.envelope.context_admission = kind === "issue"
    ? { schema_version: 1, kind: "issue", issue_id: "issue-1", issue_revision: 3, issue_status: "authorized", manifest_fingerprint: manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) }
    : { schema_version: 1, kind: "analysis", manifest_fingerprint: manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) };
  const context = record.envelope.context_admission, review = kind === "workflow", writer = record.envelope.sandbox === "workspace-write";
  const budget: BudgetAdmission = {
    schema_version: 1, id: `budget-${id}`, subject_id: `subject-${id}`, task_id: id, project_id: record.envelope.project,
    role_id: manifest.role_id, agent_id: record.envelope.agent, issue_id: context.issue_id ?? null,
    scope_revision: context.schema_version === 2 ? context.scope_revision : kind === "issue" ? 2 : null,
    scope_fingerprint: context.schema_version === 2 ? context.scope_fingerprint : kind === "issue" ? contextHash(JSON.stringify(record.envelope.metadata.issue_authorized_scope)) : null,
    context_admission_version: context.schema_version,
    workflow: context.schema_version === 2 ? { workflow_id: context.workflow_id, stage_id: context.stage_id, stage_generation: context.stage_generation, grant_id: context.grant_id } : null,
    attribution: { company_id: "surtec", objective_ids: [], project_ids: [record.envelope.project], issue_id: context.issue_id ?? null, role_id: manifest.role_id, execution_id: id },
    execution_mode: writer ? "write" : "read", manifest_fingerprint: manifest.fingerprint, admitted_cap_fingerprint: "a".repeat(64),
    reservation_id: `reservation-${id}`, intent_id: `intent-${id}`, created_at: "2026-10-05T12:00:00.000Z",
    policy_bindings: [{ policy_id: "company", policy_revision: 1, policy_fingerprint: "b".repeat(64), scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none", limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }],
    caps: { attempts: manifest.budget.max_attempts, runtime_ms: manifest.budget.max_runtime_ms, total_tokens: manifest.budget.max_total_tokens,
      concurrent_reads: writer ? 0 : 1, concurrent_writes: writer ? 1 : 0,
      review_attempts: review ? manifest.budget.max_attempts : 0, review_runtime_ms: review ? manifest.budget.max_runtime_ms : 0,
      review_total_tokens: review ? manifest.budget.max_total_tokens : 0, corrections: kind === "correction" ? 1 : 0 },
  };
  budget.intent_id = budgetTaskIntentId(budget);
  record.envelope.budget_admission = budget;
  return record;
}

describe("store", () => {
  let dir: string;
  let tasks: string;
  let projects: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "surtec-store-"));
    tasks = join(dir, "tasks");
    projects = join(dir, "projects");
  });
  afterEach(() => {
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    expect(dir.split(/[\\/]/).at(-1)).toMatch(/^surtec-store-/);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("roundtrips a task write -> read", () => {
    const rec = makeRecord("STK-1");
    writeTask(rec, tasks);
    expect(readTask("STK-1", tasks)).toEqual(rec);
  });
  it.each(["analysis", "issue", "workflow", "correction"] as const)("roundtrips exact immutable BudgetAdmission v1 with %s context and no effect proof", (kind) => {
    const record = budgetRecord("BUDGET-TASK", kind); writeTask(record, tasks);
    const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    expect(budgetAdmissionVersion(record.envelope.budget_admission)).toBe(1);
    expect(readTask("BUDGET-TASK", tasks)).toEqual(record); expect(readFileSync(path)).toEqual(before);
    const readiness = taskBudgetReadiness(record);
    expect(readiness).toMatchObject({ phase: "scaffold", status: "bound", executable: false, reason: "budget-cutover-unavailable" });
    expect(Object.isFrozen(readiness)).toBe(true);
    const updated = updateTask("BUDGET-TASK", (task) => { task.orchestration!.max_runtime_ms -= 1; }, tasks)!;
    expect(updated.envelope.budget_admission).toEqual(record.envelope.budget_admission);
    expect(updated.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(updated.envelope).not.toHaveProperty("controller_proof");
    expect(existsSync(join(dir, "budgets"))).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("Synthetic policy body");
  });
  it.each(["legacy", "v1", "v2"] as const)("keeps %s historical task bytes readable and explicitly P-non-executable without backfill", (kind) => {
    const record = kind === "legacy" ? makeRecord("HISTORICAL") : kind === "v1" ? budgetRecord("HISTORICAL") : workflowRecord("HISTORICAL");
    delete record.envelope.budget_admission;
    writeTask(record, tasks); const path = join(tasks, "HISTORICAL.json"), before = readFileSync(path);
    const restored = readTask("HISTORICAL", tasks)!;
    expect(taskBudgetReadiness(restored)).toMatchObject({ phase: "scaffold", status: "historical", executable: false, reason: "budget-admission-required" });
    expect(restored.envelope).not.toHaveProperty("budget_admission"); expect(readFileSync(path)).toEqual(before);
    expect(budgetAdmissionVersion(undefined)).toBe("legacy");
  });
  it.each([null, false, 0, "1", [], {}, { schema_version: 2 }, { schema_version: 99 }])("rejects present invalid budget %j before the supported legacy return and preserves raw bytes", (admission) => {
    const original = makeRecord("LEGACY-BUDGET"); writeTask(original, tasks);
    const path = join(tasks, "LEGACY-BUDGET.json"), before = readFileSync(path), invalid = structuredClone(original);
    Object.assign(invalid.envelope, { budget_admission: admission });
    expect(validateTaskRecord(invalid)).toBe(false); expect(() => taskBudgetReadiness(invalid)).toThrow();
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    const serialized = JSON.stringify(invalid, null, 1); writeFileSync(path, serialized);
    expect(() => readTask("LEGACY-BUDGET", tasks)).toThrow(/invalid task record/); expect(readFileSync(path, "utf8")).toBe(serialized);
  });
  it.each([undefined, null, 0, "1", 2, 99])("rejects a present BudgetAdmission version %s without downgrading context v2 or rewriting its source", (version) => {
    const record = budgetRecord("BUDGET-TASK", "workflow"); writeTask(record, tasks); const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); Object.assign(invalid.envelope.budget_admission!, { schema_version: version });
    expect(() => budgetAdmissionVersion(invalid.envelope.budget_admission)).toThrow();
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    const serialized = JSON.stringify(invalid); writeFileSync(path, serialized);
    expect(() => readTask("BUDGET-TASK", tasks)).toThrow(/invalid task record/); expect(readFileSync(path, "utf8")).toBe(serialized);
    expect(invalid.envelope.context_admission!.schema_version).toBe(2);
  });
  it.each(["undefined", "inherited", "inherited-proxy", "getter", "hidden", "proxy", "toJSON", "nested-getter", "sparse", "array-getter", "context-getter", "task-getter"])("rejects budget %s hooks without invoking user code or replacing bytes", (kind) => {
    const record = budgetRecord(); writeTask(record, tasks); const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); let invoked = 0;
    const hook = () => { invoked++; return record.envelope.budget_admission; };
    if (kind === "undefined") invalid.envelope.budget_admission = undefined;
    if (kind === "inherited") { delete invalid.envelope.budget_admission; Object.setPrototypeOf(invalid.envelope, { budget_admission: record.envelope.budget_admission }); }
    if (kind === "inherited-proxy") { delete invalid.envelope.budget_admission; Object.setPrototypeOf(invalid.envelope, new Proxy({}, { has: () => { invoked++; return false; }, get: hook })); }
    if (kind === "getter") Object.defineProperty(invalid.envelope, "budget_admission", { get: hook, enumerable: true });
    if (kind === "hidden") Object.defineProperty(invalid.envelope, "budget_admission", { value: record.envelope.budget_admission, enumerable: false });
    if (kind === "proxy") invalid.envelope.budget_admission = new Proxy(record.envelope.budget_admission!, { get: () => { invoked++; return 1; } });
    if (kind === "toJSON") Object.assign(invalid.envelope.budget_admission!, { toJSON: hook });
    if (kind === "nested-getter") Object.defineProperty(invalid.envelope.budget_admission!.caps, "attempts", { get: () => { invoked++; return 2; }, enumerable: true });
    if (kind === "sparse") invalid.envelope.budget_admission!.attribution.objective_ids = new Array(1) as string[];
    if (kind === "array-getter") { invalid.envelope.budget_admission!.attribution.objective_ids = ["objective-1"]; Object.defineProperty(invalid.envelope.budget_admission!.attribution.objective_ids, "0", { get: () => { invoked++; return "objective-1"; }, enumerable: true }); }
    if (kind === "context-getter") Object.defineProperty(invalid.envelope.context_manifest!, "fingerprint", { get: () => { invoked++; return record.envelope.context_manifest!.fingerprint; }, enumerable: true });
    if (kind === "task-getter") Object.defineProperty(invalid, "orchestration", { get: () => { invoked++; return record.orchestration; }, enumerable: true });
    expect(validateTaskRecord(invalid)).toBe(false); expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/);
    expect(() => assertTaskBudgetAdmissionBinding(invalid)).toThrow(); expect(invoked).toBe(0); expect(readFileSync(path)).toEqual(before);
  });
  it.each(Object.keys(budgetRecord().envelope.budget_admission!))("requires own BudgetAdmission %s without schema defaults or prototype fallback", (key) => {
    const record = budgetRecord(), binding = record.envelope.budget_admission! as unknown as Record<string, unknown>;
    const original = binding[key]; delete binding[key];
    expect(validateTaskRecord(record)).toBe(false); expect(() => assertTaskBudgetAdmissionBinding(record)).toThrow();
    Object.setPrototypeOf(binding, { [key]: original });
    expect(validateTaskRecord(record)).toBe(false); expect(() => assertTaskBudgetAdmissionBinding(record)).toThrow();
  });
  it.each(["admitted_cap_fingerprint", "reservation_id", "subject_id", "created_at", "id"] as const)("rejects immutable %s drift against its original full intent digest without accepting a copied ID as commitment", (field) => {
    const record = budgetRecord(); writeTask(record, tasks); const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record);
    invalid.envelope.budget_admission![field] = field === "admitted_cap_fingerprint" ? "f".repeat(64) : field === "created_at" ? "2026-10-06T12:00:00.000Z" : "different-id";
    expect(() => assertTaskBudgetAdmissionBinding(invalid)).toThrow(/intent fingerprint/);
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    invalid.envelope.budget_admission!.intent_id = budgetTaskIntentId(invalid.envelope.budget_admission!);
    expect(validateTaskRecord(invalid)).toBe(true); // Data consistency is not ledger commitment or execution authority.
    expect(taskBudgetReadiness(invalid).executable).toBe(false);
  });
  const invalidBudget: Array<[string, (record: TaskRecord, budget: BudgetAdmission) => void, "analysis" | "issue" | "workflow" | "correction"]> = [
    ["task", (_task, budget) => { budget.task_id = "other-task"; }, "analysis"],
    ["project", (_task, budget) => { budget.project_id = "other-project"; }, "analysis"],
    ["role", (_task, budget) => { budget.role_id = "other-role"; budget.attribution.role_id = "other-role"; }, "analysis"],
    ["agent", (_task, budget) => { budget.agent_id = "other-agent"; }, "analysis"],
    ["manifest", (_task, budget) => { budget.manifest_fingerprint = "f".repeat(64); }, "analysis"],
    ["context version", (_task, budget) => { budget.context_admission_version = 2; }, "analysis"],
    ["sandbox", (_task, budget) => { budget.execution_mode = "write"; budget.caps.concurrent_reads = 0; budget.caps.concurrent_writes = 1; }, "analysis"],
    ["missing context", (task) => { delete task.envelope.context_admission; }, "analysis"],
    ["missing manifest", (task) => { delete task.envelope.context_manifest; }, "analysis"],
    ["missing counters", (task) => { delete task.orchestration; }, "analysis"],
    ["issue identity", (_task, budget) => { budget.issue_id = "other-issue"; budget.attribution.issue_id = "other-issue"; }, "issue"],
    ["scope revision", (_task, budget) => { budget.scope_revision = 3; }, "issue"],
    ["scope fingerprint", (_task, budget) => { budget.scope_fingerprint = "f".repeat(64); }, "issue"],
    ["changed scope body", (task) => { task.envelope.metadata.issue_authorized_scope = { allowed_paths: ["other.ts"] }; }, "issue"],
    ["missing scope body", (task) => { delete task.envelope.metadata.issue_authorized_scope; }, "issue"],
    ["analysis scope", (task) => { task.envelope.metadata.issue_scope_revision = 1; }, "analysis"],
    ["workflow identity", (_task, budget) => { budget.workflow!.workflow_id = "other-workflow"; }, "workflow"],
    ["stage identity", (_task, budget) => { budget.workflow!.stage_id = "other-stage"; }, "workflow"],
    ["generation", (_task, budget) => { budget.workflow!.stage_generation = 2; }, "workflow"],
    ["grant", (_task, budget) => { budget.workflow!.grant_id = "other-grant"; }, "workflow"],
    ["workflow scope revision", (_task, budget) => { budget.scope_revision = 3; }, "workflow"],
    ["workflow scope fingerprint", (_task, budget) => { budget.scope_fingerprint = "f".repeat(64); }, "workflow"],
    ["workflow issue", (_task, budget) => { budget.issue_id = "other-issue"; budget.attribution.issue_id = "other-issue"; }, "workflow"],
    ["review labels", (_task, budget) => { budget.caps.review_attempts = 0; budget.caps.review_runtime_ms = 0; budget.caps.review_total_tokens = 0; }, "workflow"],
    ["invented review labels", (_task, budget) => { budget.caps.review_attempts = 1; }, "analysis"],
    ["correction labels", (_task, budget) => { budget.caps.corrections = 0; }, "correction"],
    ["invented correction", (_task, budget) => { budget.caps.corrections = 1; }, "workflow"],
    ["caller commitment", (_task, budget) => Object.assign(budget, { committed: true }), "analysis"],
    ["raw instructions", (_task, budget) => Object.assign(budget, { instructions: "Synthetic forbidden body" }), "analysis"],
  ];
  it.each(invalidBudget)("rejects contradictory BudgetAdmission %s and preserves both valid and invalid source bytes", (_name, mutate, kind) => {
    const record = budgetRecord("BUDGET-TASK", kind); writeTask(record, tasks); const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); mutate(invalid, invalid.envelope.budget_admission!);
    try { invalid.envelope.budget_admission!.intent_id = budgetTaskIntentId(invalid.envelope.budget_admission!); } catch { /* Pure schema invalidity is independently rejected. */ }
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    expect(() => assertTaskBudgetAdmissionBinding(invalid)).toThrow();
    writeFileSync(path, JSON.stringify(invalid)); const corrupt = readFileSync(path);
    expect(() => readTask("BUDGET-TASK", tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(corrupt);
  });
  it.each([["attempts", "max_attempts"], ["runtime_ms", "max_runtime_ms"], ["total_tokens", "max_total_tokens"]] as const)("never expands immutable %s caps, allows current tightening and retains the original cap", (dimension, ceiling) => {
    const record = budgetRecord(); writeTask(record, tasks); const path = join(tasks, "BUDGET-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); invalid.envelope.budget_admission!.caps[dimension] += 1;
    invalid.envelope.budget_admission!.intent_id = budgetTaskIntentId(invalid.envelope.budget_admission!);
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    const tighter = structuredClone(record); tighter.orchestration![ceiling] -= 1;
    writeTask(tighter, tasks); expect(readTask("BUDGET-TASK", tasks)!.envelope.budget_admission).toEqual(record.envelope.budget_admission);
    const exceeded = structuredClone(record); exceeded.orchestration![ceiling] += 1;
    expect(() => writeTask(exceeded, tasks)).toThrow(/invalid task record/);
    const restricted = structuredClone(record); restricted.envelope.budget_admission!.caps[dimension] -= 1; restricted.orchestration![ceiling] -= 1;
    restricted.envelope.budget_admission!.intent_id = budgetTaskIntentId(restricted.envelope.budget_admission!);
    writeTask(restricted, tasks); expect(readTask("BUDGET-TASK", tasks)).toEqual(restricted);
  });
  it.each([
    ["analysis", "analysis"], ["planning", "implementation"],
    ["implementation", "implementation"], ["review", "implementation"], ["qa", "implementation"], ["correction", "implementation"],
    ["review", "quality-review"], ["qa", "quality-review"], ["operations", "operations-investigation"],
    ["implementation", "trivial-change"], ["review", "trivial-change"], ["qa", "trivial-change"], ["correction", "trivial-change"],
  ] as const)("roundtrips strict v2 %s/%s references with unchanged manifest v1 and no authority backfill", (kind, template) => {
    const record = workflowRecord("WORKFLOW-TASK", kind, template);
    writeTask(record, tasks); const path = join(tasks, "WORKFLOW-TASK.json"), before = readFileSync(path);
    expect(contextAdmissionVersion(record.envelope.context_admission)).toBe(2);
    expect(readTask("WORKFLOW-TASK", tasks)).toEqual(record);
    expect(readFileSync(path)).toEqual(before);
    const updated = updateTask("WORKFLOW-TASK", (task) => { task.lifecycle = "running"; }, tasks)!;
    expect(updated.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(updated.envelope.context_manifest).toMatchObject({ schema_version: 1, routing: { delegation: { executable: false } } });
    expect(updated.envelope.metadata).not.toHaveProperty("issue_id");
    expect(updated.envelope).not.toHaveProperty("grant");
    expect(readFileSync(path, "utf8")).not.toContain("Synthetic policy body");
  });
  it("admits the code-owned Planner analysis choice without fabricating a planning or review stage", () => {
    const record = workflowRecord("PLANNER-ANALYSIS", "analysis", "analysis", "planner");
    writeTask(record, tasks); expect(readTask("PLANNER-ANALYSIS", tasks)).toEqual(record);
    expect(record.envelope.context_manifest!.tools).toEqual(["inspect"]);
    for (const kind of ["planning", "review"] as const) expect(() => writeTask(workflowRecord("INVALID-ANALYSIS", kind, "analysis"), tasks)).toThrow(/invalid task record/);
  });
  it.each(["implementation", "correction"] as const)("persists additive bound v2 %s receipts without enabling execution or rewriting v1", (kind) => {
    const record = workflowRecord("CAPTURED-V2", kind, "trivial-change");
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, tools: [...unsigned.tools, "verify-configured" as const], testing: { ...unsigned.testing, commands: ["node check.mjs"] } };
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    record.envelope.context_admission!.manifest_fingerprint = record.envelope.context_manifest!.fingerprint; record.envelope.self_verify = true;
    record.testing_evidence = createTestingEvidence(record, "owned-run", { mode: "functional", runners: [{ command: "node check.mjs", stage: "functional" }] });
    writeTask(record, tasks); const path = join(tasks, "CAPTURED-V2.json"), before = readFileSync(path);
    expect(readTask(record.envelope.id, tasks)).toEqual(record); expect(record.testing_evidence.scope_revision).toBe(2);
    expect(record.testing_evidence.scope_fingerprint).toBe((record.envelope.context_admission as ContextAdmissionV2).scope_fingerprint);
    for (const key of ["scope_fingerprint", "scope_revision", "context_fingerprint", "task_id", "issue_id", "issue_revision"] as const) {
      const invalid = structuredClone(record), { fingerprint: _fingerprint, ...receipt } = invalid.testing_evidence!;
      Object.assign(receipt, { [key]: typeof receipt[key] === "number" ? 99 : "unowned" }); invalid.testing_evidence = sealTestingEvidence(receipt);
      expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    }
  });
  it.each([undefined, null, 0, 3, 99, "2", false])("rejects present unknown/malformed admission version %s on write and read while preserving bytes", (version) => {
    const record = workflowRecord(); writeTask(record, tasks);
    const path = join(tasks, "WORKFLOW-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); Object.assign(invalid.envelope.context_admission!, { schema_version: version });
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    const serialized = JSON.stringify(invalid); writeFileSync(path, serialized);
    expect(() => readTask("WORKFLOW-TASK", tasks)).toThrow(/invalid task record/); expect(readFileSync(path, "utf8")).toBe(serialized);
  });
  it.each(["kind", "workflow_id", "stage_id", "stage_generation", "stage_kind", "task_id", "template_id", "template_version", "grant_id", "authority_revision", "role_id", "issue_id", "issue_revision", "scope_revision", "scope_fingerprint", "approved_plan", "predecessor_stage_id", "handoff_id", "candidate", "manifest_fingerprint", "instructions_length", "instructions_hash"])("requires an own v2 %s field without adopting defaults", (key) => {
    const record = workflowRecord(), binding = record.envelope.context_admission!;
    delete (binding as unknown as Record<string, unknown>)[key];
    expect(validateTaskRecord(record)).toBe(false);
    Object.setPrototypeOf(binding, { [key]: (workflowRecord().envelope.context_admission as unknown as Record<string, unknown>)[key] });
    expect(validateTaskRecord(record)).toBe(false);
  });
  const invalidV2: Array<[string, (record: TaskRecord, binding: ContextAdmissionV2) => void]> = [
    ["mixed v1 kind", (_task, binding) => Object.assign(binding, { kind: "issue" })],
    ["mixed v1 status", (_task, binding) => Object.assign(binding, { issue_status: "working" })],
    ["raw source body", (_task, binding) => Object.assign(binding, { instructions: "Synthetic private body" })],
    ["caller authority", (_task, binding) => Object.assign(binding, { approved_by: "human" })],
    ["bad identity", (_task, binding) => { binding.workflow_id = "../escape"; }],
    ["zero generation", (_task, binding) => { binding.stage_generation = 0; }],
    ["unsafe revision", (_task, binding) => { binding.authority_revision = Number.MAX_SAFE_INTEGER + 1; }],
    ["future template", (_task, binding) => Object.assign(binding, { template_version: 2 })],
    ["wrong task owner", (_task, binding) => { binding.task_id = "unowned-task"; }],
    ["wrong role", (_task, binding) => { binding.role_id = "software-engineer"; }],
    ["wrong stage", (_task, binding) => { binding.stage_kind = "implementation"; }],
    ["wrong template", (_task, binding) => { binding.template_id = "operations-investigation"; }],
    ["legacy issue id", (task) => { task.envelope.metadata.issue_id = "issue-1"; }],
    ["legacy scope revision", (task) => { task.envelope.metadata.issue_scope_revision = 2; }],
    ["legacy scope body", (task) => { task.envelope.metadata.issue_authorized_scope = {}; }],
    ["no manifest", (task) => { delete task.envelope.context_manifest; }],
    ["broadened attempt budget", (task) => { task.orchestration!.max_attempts += 1; }],
    ["broadened runtime budget", (task) => { task.orchestration!.max_runtime_ms += 1; }],
    ["broadened token budget", (task) => { task.orchestration!.max_total_tokens += 1; }],
    ["unexpected consent audit", (task) => { task.envelope.metadata.client_context_share = { categories: ["confidential-notes"] }; }],
    ["changed sandbox", (task) => { task.envelope.sandbox = "workspace-write"; }],
    ["read-only verification", (task) => { task.envelope.self_verify = true; }],
    ["bad instruction hash", (_task, binding) => { binding.instructions_hash = "f".repeat(64); }],
    ["wrong manifest", (_task, binding) => { binding.manifest_fingerprint = "f".repeat(64); }],
    ["unadmitted instruction suffix", (task) => { task.envelope.instructions += "unadmitted suffix"; }],
    ["handoff without predecessor", (_task, binding) => { binding.handoff_id = "handoff-1"; }],
    ["predecessor without handoff", (_task, binding) => { binding.predecessor_stage_id = "predecessor-1"; }],
    ["self predecessor", (_task, binding) => { binding.predecessor_stage_id = binding.stage_id; binding.handoff_id = "handoff-1"; }],
    ["self approved plan", (_task, binding) => { binding.approved_plan = { stage_id: binding.stage_id, output_fingerprint: "a".repeat(64), decision_id: "decision-1" }; }],
    ["missing candidate", (_task, binding) => { binding.candidate = null; }],
    ["cross-issue candidate", (_task, binding) => { binding.candidate!.issue_id = "other-issue"; }],
    ["cross-project candidate", (_task, binding) => { binding.candidate!.repository_id = "other-project"; }],
    ["cross-scope candidate", (_task, binding) => { binding.candidate!.scope_revision += 1; }],
    ["self candidate owner", (_task, binding) => { binding.candidate!.task_id = binding.task_id; }],
    ["candidate path traversal", (_task, binding) => { binding.candidate!.changed_paths = ["../escape"]; }],
    ["absolute candidate path", (_task, binding) => { binding.candidate!.changed_paths = ["C:/private"]; }],
    ["duplicate candidate path", (_task, binding) => { binding.candidate!.changed_paths.push(binding.candidate!.changed_paths[0]!); }],
    ["candidate metadata injection", (_task, binding) => Object.assign(binding.candidate!, { worktree_path: "Synthetic forbidden path" })],
    ["plan body injection", (_task, binding) => { binding.approved_plan = { stage_id: "planner", output_fingerprint: "a".repeat(64), decision_id: "decision-1", body: "Synthetic forbidden plan" } as never; }],
    ["fabricated testing receipt", (task) => { task.testing_evidence = createTestingEvidence(governedRecord("UNRELATED"), "fake-run", { mode: "functional", runners: [] }); }],
  ];
  it.each(invalidV2)("rejects v2 %s before replacing any persisted snapshot", (_name, mutate) => {
    const record = workflowRecord(); writeTask(record, tasks); const path = join(tasks, "WORKFLOW-TASK.json"), before = readFileSync(path);
    const invalid = structuredClone(record); mutate(invalid, invalid.envelope.context_admission as ContextAdmissionV2);
    expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    writeFileSync(path, JSON.stringify(invalid)); const corrupt = readFileSync(path);
    expect(() => readTask("WORKFLOW-TASK", tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(corrupt);
  });
  it.each(["plan", "handoff"])("requires implementation %s and does not let schema validity grant write authority", (missing) => {
    const record = workflowRecord("WRITE-1", "implementation", "implementation"), binding = record.envelope.context_admission as ContextAdmissionV2;
    expect(validateTaskRecord(record)).toBe(true);
    if (missing === "plan") binding.approved_plan = null;
    else { binding.handoff_id = null; binding.predecessor_stage_id = null; }
    expect(() => writeTask(record, tasks)).toThrow(/invalid task record/);
  });
  it("allows only explicitly selected context categories while binding the original v2 instructions", () => {
    const record = workflowRecord(), binding = record.envelope.context_admission as ContextAdmissionV2;
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, selected_categories: ["service-context"], excluded_categories: ["confidential-notes"] };
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    binding.manifest_fingerprint = record.envelope.context_manifest.fingerprint;
    record.envelope.metadata.client_context_share = { categories: ["service-context"] };
    record.envelope.instructions += "\n\n---\nSynthetic selected context";
    writeTask(record, tasks); expect(readTask("WORKFLOW-TASK", tasks)).toEqual(record);
    record.envelope.metadata.client_context_share = { categories: ["confidential-notes"] };
    expect(() => writeTask(record, tasks)).toThrow(/invalid task record/);
  });
  it("does not allow an advisory stage to adopt a candidate or a write stage to omit edit capability", () => {
    const advisory = workflowRecord("ADVISORY", "analysis", "analysis");
    (advisory.envelope.context_admission as ContextAdmissionV2).candidate = (workflowRecord().envelope.context_admission as ContextAdmissionV2).candidate;
    expect(() => writeTask(advisory, tasks)).toThrow(/invalid task record/);
    const writer = workflowRecord("WRITER", "implementation", "implementation");
    const { fingerprint: _fingerprint, ...unsigned } = writer.envelope.context_manifest!;
    const manifest = { ...unsigned, tools: ["inspect"] as const };
    writer.envelope.context_manifest = { ...manifest, tools: [...manifest.tools], fingerprint: contextHash(JSON.stringify(manifest)) };
    writer.envelope.context_admission!.manifest_fingerprint = writer.envelope.context_manifest.fingerprint;
    expect(() => writeTask(writer, tasks)).toThrow(/invalid task record/);
  });
  it.each(["authorized", "working"] as const)("keeps v1 issue/%s bindings byte-stable without v2 fields or grants", (status) => {
    const record = governedRecord("V1-ISSUE");
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, task_kind: "implementation" }; record.envelope.task_type = "implementation";
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    record.envelope.metadata.issue_id = "issue-1";
    record.envelope.context_admission = { schema_version: 1, kind: "issue", issue_id: "issue-1", issue_revision: 3, issue_status: status, manifest_fingerprint: record.envelope.context_manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) };
    writeTask(record, tasks); const path = join(tasks, "V1-ISSUE.json"), before = readFileSync(path);
    expect(readTask("V1-ISSUE", tasks)).toEqual(record); expect(readFileSync(path)).toEqual(before);
    expect(contextAdmissionVersion(record.envelope.context_admission)).toBe(1);
    expect(record.envelope.context_admission).not.toHaveProperty("grant_id");
  });
  it("dispatches legacy/v1/v2 explicitly without reinterpreting incomplete v2 as legacy or v1", () => {
    expect(contextAdmissionVersion(undefined)).toBe("legacy");
    const record = governedRecord("V1-1", true);
    record.envelope.context_admission = { schema_version: 1, kind: "analysis", manifest_fingerprint: record.envelope.context_manifest!.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) };
    expect(contextAdmissionVersion(record.envelope.context_admission)).toBe(1);
    writeTask(record, tasks); const path = join(tasks, "V1-1.json"), before = readFileSync(path);
    expect(readTask("V1-1", tasks)).toEqual(record); expect(readFileSync(path)).toEqual(before);
    for (const admission of [null, {}, [], { ...record.envelope.context_admission, schema_version: 2 }, { ...workflowRecord().envelope.context_admission, schema_version: 1 }, Object.create({ schema_version: 2 })]) expect(() => contextAdmissionVersion(admission)).toThrow();
    const legacy = makeRecord("LEGACY"); legacy.envelope.context_admission = undefined;
    expect(validateTaskRecord(legacy)).toBe(false);
    const inherited = makeRecord("INHERITED"); Object.setPrototypeOf(inherited.envelope, { context_admission: workflowRecord().envelope.context_admission });
    expect(validateTaskRecord(inherited)).toBe(false);
  });
  it("strictly roundtrips captured evidence and preserves bytes on malformed or mismatched receipt writes/reads", () => {
    const record = governedRecord("EVIDENCE-1", true);
    record.envelope.context_admission = { schema_version: 1, kind: "analysis", manifest_fingerprint: record.envelope.context_manifest!.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) };
    record.testing_evidence = createTestingEvidence(record, "run-evidence", { mode: "functional", runners: [] });
    writeTask(record, tasks); const path = join(tasks, "EVIDENCE-1.json"), before = readFileSync(path);
    expect(readTask("EVIDENCE-1", tasks)!.testing_evidence).toEqual(record.testing_evidence);
    for (const mutate of [(value: TaskRecord) => { Object.assign(value.testing_evidence!, { schema_version: 99 }); }, (value: TaskRecord) => { Object.assign(value.testing_evidence!, { stdout: "private output" }); }, (value: TaskRecord) => { value.testing_evidence!.execution_id = "tampered"; }, (value: TaskRecord) => {
      const { fingerprint: _fingerprint, ...unsigned } = value.testing_evidence!;
      value.testing_evidence = sealTestingEvidence({ ...unsigned, context_fingerprint: "f".repeat(64) });
    }]) {
      const invalid = structuredClone(record); mutate(invalid);
      expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    }
    const future = JSON.stringify({ ...record, testing_evidence: { ...record.testing_evidence, schema_version: 99 } }); writeFileSync(path, future);
    expect(() => readTask("EVIDENCE-1", tasks)).toThrow(/invalid task record/); expect(readFileSync(path, "utf8")).toBe(future);
    expect(() => writeTask({ ...makeRecord("LEGACY-EVIDENCE"), testing_evidence: record.testing_evidence }, tasks)).toThrow(/invalid task record/);
  });
  it("persists strict minimal admission references and rejects malformed bindings without replacing bytes", () => {
    const record = governedRecord("BOUND-1", true);
    record.envelope.context_admission = { schema_version: 1, kind: "analysis", manifest_fingerprint: record.envelope.context_manifest!.fingerprint,
      instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions) };
    writeTask(record, tasks); const path = join(tasks, "BOUND-1.json"); const before = readFileSync(path);
    expect(readTask("BOUND-1", tasks)!.envelope.context_admission).toEqual(record.envelope.context_admission);
    const cases: Array<(value: TaskRecord) => void> = [
      (value) => { value.envelope.context_admission!.instructions_hash = "f".repeat(64); },
      (value) => { value.envelope.context_admission!.manifest_fingerprint = "f".repeat(64); },
      (value) => { value.envelope.context_admission!.instructions_length += 1; },
      (value) => { Object.assign(value.envelope.context_admission!, { schema_version: 2 }); },
      (value) => { Object.assign(value.envelope.context_admission!, { issue_id: "unexpected" }); },
      (value) => { delete value.envelope.context_manifest; },
      (value) => { value.envelope.instructions += "unadmitted suffix"; },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(record); mutate(invalid);
      expect(() => writeTask(invalid, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    }
  });
  it("roundtrips versioned context without persisting source bodies and preserves it under locked revision updates", () => {
    const record = governedRecord("CTX-1"); writeTask(record, tasks);
    expect(readTask("CTX-1", tasks)).toEqual(record);
    expect(readFileSync(join(tasks, "CTX-1.json"), "utf8")).not.toContain("Synthetic policy body");
    const updated = updateTask("CTX-1", (current) => { current.lifecycle = "running"; }, tasks);
    expect(updated!.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(updated!.revision).toBe(1);
  });
  it("reads named legacy task bytes without rewriting or inventing context evidence", () => {
    mkdirSync(tasks, { recursive: true }); const path = join(tasks, "LEGACY-1.json");
    const original = JSON.stringify(makeRecord("LEGACY-1")); writeFileSync(path, original);
    expect(readTask("LEGACY-1", tasks)!.envelope.context_manifest).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  it.each(["project", "agent", "task_type", "sandbox"] as const)("rejects context/task %s mismatch without changing persisted bytes", (field) => {
    const record = governedRecord("CTX-1"); writeTask(record, tasks); const path = join(tasks, "CTX-1.json"); const before = readFileSync(path);
    Object.assign(record.envelope, { [field]: field === "sandbox" ? "read-only" : "different" });
    expect(() => writeTask(record, tasks)).toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
  });
  it("rejects tampered manifests, unsupported versions, inconsistent consent and broadened execution budgets", () => {
    const cases: Array<(record: TaskRecord) => void> = [
      (record) => { record.envelope.context_manifest!.sources[0]!.reason = "Tampered evidence"; },
      (record) => { Object.assign(record.envelope.context_manifest!, { schema_version: 2 }); },
      (record) => { Object.assign(record.envelope.context_manifest!, { extra: "Unexpected field" }); },
      (record) => { record.envelope.metadata.client_context_share = { categories: ["confidential-notes"] }; },
      (record) => { record.envelope.self_verify = true; },
      (record) => { record.envelope.requires_human_approval = false; },
      (record) => { record.orchestration!.max_total_tokens += 1; },
      (record) => { record.orchestration!.max_attempts += 1; },
      (record) => { record.orchestration!.max_runtime_ms += 1; },
    ];
    for (const mutate of cases) {
      const record = governedRecord("CTX-1"); mutate(record);
      expect(() => writeTask(record, tasks)).toThrow(/invalid task record/);
    }
    const record = governedRecord("CTX-1"); mkdirSync(tasks, { recursive: true });
    Object.assign(record.envelope.context_manifest!, { schema_version: 99 }); const invalid = JSON.stringify(record);
    const path = join(tasks, "CTX-1.json"); writeFileSync(path, invalid);
    expect(() => readTask("CTX-1", tasks)).toThrow(/invalid task record/); expect(readFileSync(path, "utf8")).toBe(invalid);
  });

  it("mutates a task under a lock and increments its revision", () => {
    writeTask(makeRecord("STK-1"), tasks);
    const updated = updateTask("STK-1", (record) => {
      record.lifecycle = "running";
    }, tasks);
    expect(updated?.lifecycle).toBe("running");
    expect(updated?.revision).toBe(1);
    expect(readTask("STK-1", tasks)?.revision).toBe(1);
  });

  it("rejects a concurrent state lock instead of mutating unlocked", () => {
    const locks = join(dir, "locks");
    mkdirSync(locks, { recursive: true });
    const descriptor = openSync(join(locks, "STK-1.lock"), "wx");
    try {
      expect(() => withStateLock("STK-1", () => undefined, locks)).toThrow(StateLockConflictError);
    } finally {
      closeSync(descriptor);
    }
  });

  it("readTask returns null when missing", () => {
    expect(readTask("nope", tasks)).toBeNull();
  });

  it("listTasks returns [] when dir does not exist", () => {
    expect(listTasks(join(dir, "absent"))).toEqual([]);
  });

  it("listTasks skips an unreadable/corrupt file without throwing", () => {
    writeTask(makeRecord("STK-1"), tasks);
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "broken.json"), "{ not json", "utf8");
    const result = listTasks(tasks);
    expect(result.map((r) => r.envelope.id)).toEqual(["STK-1"]);
  });

  it("readTask throws on a corrupt existing file", () => {
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "BAD.json"), "{ not json", "utf8");
    expect(() => readTask("BAD", tasks)).toThrow();
  });

  it("rejects a well-formed JSON task that does not match the persisted schema", () => {
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "BAD.json"), JSON.stringify({ envelope: { id: "BAD" }, lifecycle: "queued" }), "utf8");
    expect(() => readTask("BAD", tasks)).toThrow(/invalid task record/);
    expect(listTasks(tasks)).toEqual([]);
  });

  it("rejects unsafe task identifiers before constructing a path", () => {
    expect(() => readTask("../escape", tasks)).toThrow(/invalid task id/);
    expect(() => writeTask(makeRecord("../escape"), tasks)).toThrow();
  });

  it("upserts and lists project overrides", () => {
    upsertProjectOverride({ id: "stock-control", health: "ok", note: "fine" }, projects);
    expect(listProjectOverrides(projects)).toEqual([
      { id: "stock-control", health: "ok", note: "fine" },
    ]);
  });

  it("validates project overrides before persisting them", () => {
    expect(() => upsertProjectOverride({ id: "../escape", health: "ok" }, projects)).toThrow();
    expect(() => upsertProjectOverride({ id: "alpha", health: "unknown" as never }, projects)).toThrow(/invalid project override/);
  });
});
