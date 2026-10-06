import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cpSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask as governedCreateTask, createWorkflowTask, prepareTaskBudgetAdmission, ValidationError, type CreateTaskInput } from "./dispatch";
import { createWorkflowContextService } from "./workflow-context-service";
import { createContextService, type ContextService } from "./context-service";
import { createIssueService } from "./issue-service";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import type { TaskRecord } from "../../../lib/state/types";
import type { BudgetAmounts, BudgetAttribution, BudgetLimits } from "../../../lib/budgets/types";
import { BUDGET_DIMENSIONS } from "../../../lib/budgets/types";
import { budgetTaskIntentId, commitTaskBudget, reserveTaskBudget } from "../../../lib/budgets/reservations";
import { mutateBudgetLedger, readBudgetLedger } from "../../../lib/state/budgets";
import { budgetStatePath } from "../../../lib/state/paths";
import { assembleContext, contextHash } from "../../../lib/context/assemble";
import { defaultTaskOrchestration } from "../../../lib/state/orchestration";
import { taskBudgetReadiness, validateTaskRecord } from "../../../lib/state/validation";
import type { BudgetPolicySource, ExistingBudgetConstraint } from "../../../lib/budgets/policy";

let context: ContextService;
let trustedIssue = {
  taskId: "ISSUE-TASK-1",
  issueId: "ISSUE-1",
  scopeRevision: 1,
  expectedRevision: 1,
  authorizedScope: {} as never,
};
import { listTasks, readTask, writeTask } from "../../../lib/state/store";
import { readTaskEvents } from "../../../lib/state/events";
import { runRecord, runSetStatus } from "../../../cli/surtec-state";

let root: string;
// Each positive test explicitly requests and confirms a preview; production never does this automatically.
function createTask(input: CreateTaskInput & { client_context?: import("./client-portfolio-service").ClientTaskContext }, repoRoot = root, trusted?: typeof trustedIssue) {
  const client = input.client_context;
  const service = client ? createContextService(root, { buildClientContext: () => client }) : context;
  const { client_context: _unused, ...draft } = input;
  const request = { kind: trusted ? "issue" : "analysis", project: draft.project, agent: draft.agent, role_id: "software-engineer", ...(trusted ? { issue_id: trusted.issueId, expected_revision: trusted.expectedRevision } : { instructions: draft.instructions }), client_context_categories: client?.audit.categories ?? [] };
  const preview = service.preview(request);
  return governedCreateTask({ ...draft, role_id: "software-engineer", preview_fingerprint: preview.fingerprint, client_context_categories: request.client_context_categories }, repoRoot, trusted, { context: service });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-dispatch-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  const projectsRoot = join(root, "projects");
  mkdirSync(join(projectsRoot, "stock-control", ".git"), { recursive: true });
  process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements code.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    [
      "projects:",
      "  stock-control:",
      "    local_path: ~/dev/surtec/stock-control",
      "    status: active",
      "    allowed_agents:",
      "      - backend-engineer",
      "    sandbox:",
      "      default: workspace-write",
      "    commands:",
      "      test: pnpm test",
      "",
    ].join("\n"),
    "utf8",
  );
  process.env.SURTEC_STATE_DIR = join(root, "state");
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) cpSync(join("registry", name), join(root, "registry", name));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
  }
  context = createContextService(root);
  const issues = createIssueService(root, { projectIds: () => ["stock-control"] });
  const proposed = issues.create({ project_id: "stock-control", title: "Synthetic fix", expected_outcome: "Bounded result", acceptance_criteria: ["Verified result"], assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Bounded result", acceptance_criteria: ["Verified result"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
  trustedIssue = { ...trustedIssue, issueId: issue.id, expectedRevision: issue.revision, scopeRevision: issue.scope_revision, authorizedScope: issue.authorized_scope as never };
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// New in-memory application drafts only: these fixtures never retrofit an
// already persisted queue or use normal state/project/model/provider effects.
const draftAt = "2026-10-05T12:00:00.000Z";
const draftBudget = { max_attempts: 2, max_runtime_ms: 2000, max_total_tokens: 100 };
function budgetSource(caps: Partial<BudgetAmounts> = {}): BudgetPolicySource {
  return { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [
    { id: "company-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period: "utc-day", warning_percent: 80,
      limits: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, caps[key] === undefined ? { status: "unconfigured" } : { status: "configured", hard_cap: caps[key] }])) as BudgetLimits },
  ] } };
}
function newBudgetDraft(kind: "analysis" | "issue" | "workflow" | "review" = "analysis", id = "T-draft-1"): TaskRecord {
  const role = kind === "review" ? "reviewer" : kind === "workflow" ? "planner" : kind === "issue" ? "software-engineer" : "portfolio-analyst";
  const sandbox = kind === "issue" ? "workspace-write" : "read-only", instructions = "Inspect synthetic evidence";
  const manifest = assembleContext({ schema_version: 1, project_id: "synthetic", agent_id: "backend-engineer", role_id: role,
    task_kind: kind === "issue" ? "implementation" : "analysis", sandbox, tools: kind === "issue" ? ["inspect", "edit-authorized-scope", "verify-configured"] : ["inspect"],
    approval_rules: [], budget: draftBudget, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic"], delegation: { admitted: false, executable: false, reasons: ["No execution"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Fixture"], requires_red_evidence: false } },
  [{ id: "runtime/safety", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
  const base = { manifest_fingerprint: manifest.fingerprint, instructions_hash: contextHash(instructions), instructions_length: instructions.length };
  const scope = { expected_outcome: "Bounded fixture", acceptance_criteria: ["Verified"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] };
  const record: TaskRecord = { envelope: { id, source: "dashboard", project: "synthetic", agent: "backend-engineer", task_type: manifest.task_kind, sandbox,
    title: instructions, instructions, repo_path: "/synthetic", branch: `agent/${id}`, expected_outputs: [], requires_human_approval: true,
    metadata: kind === "issue" ? { issue_id: "issue-1", issue_scope_revision: 1, issue_authorized_scope: scope } : {}, context_manifest: manifest,
    context_admission: kind === "workflow" ? { schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: "analysis", task_id: id,
      template_id: "analysis", template_version: 1, grant_id: "grant-1", authority_revision: 1, role_id: role, issue_id: "issue-1", issue_revision: 1, scope_revision: 1,
      scope_fingerprint: contextHash(JSON.stringify(scope)), approved_plan: null, predecessor_stage_id: null, handoff_id: null, candidate: null, ...base }
      : { schema_version: 1, kind: kind === "issue" ? "issue" : "analysis", ...(kind === "issue" ? { issue_id: "issue-1", issue_revision: 1, issue_status: "authorized" as const } : {}), ...base },
    self_verify: kind === "issue" }, lifecycle: "queued", outcome: null, created_at: draftAt, updated_at: draftAt, started_at: null, finished_at: null, result: null, logs_path: null,
    revision: 1, orchestration: { ...defaultTaskOrchestration(), ...draftBudget } };
  expect(validateTaskRecord(record)).toBe(true); return record;
}
function budgetOptions(task: TaskRecord, source = budgetSource()) {
  const context = task.envelope.context_admission!, attribution: BudgetAttribution = { company_id: "surtec", objective_ids: [], project_ids: [task.envelope.project],
    issue_id: context.schema_version === 2 || context.kind === "issue" ? context.issue_id! : null, role_id: task.envelope.context_manifest!.role_id, execution_id: task.envelope.id };
  return { source, attribution };
}

describe("createTask", () => {
  it("does not accept workflow authority through the generic task path", () => {
    for (const key of ["workflow_id", "stage_id", "grant", "context_admission", "task_id", "metadata"]) expect(() => governedCreateTask({ project: "stock-control", agent: "backend-engineer", instructions: "Inspect", [key]: {} } as never, root)).toThrow(/fields/);
    expect(listTasks()).toEqual([]);
  });
  it("internal workflow dispatch requires a durable reservation before context or task effects", () => {
    const context = createWorkflowContextService(root);
    expect(() => createWorkflowTask({ workflow_id: "missing-workflow", stage_id: "missing-stage", expected_workflow_revision: 1, expected_issue_revision: 1 }, root, { context })).toThrow(/reserved intent/);
    expect(listTasks()).toEqual([]); expect(existsSync(join(root, "state/workflows"))).toBe(false); expect(existsSync(join(root, "state/events"))).toBe(false);
  });
  it("strict internal references reject identities, revisions and caller task/manifest fields", () => {
    const context = createWorkflowContextService(root), input = { workflow_id: "workflow-1", stage_id: "stage-1", expected_workflow_revision: 1, expected_issue_revision: 1 };
    for (const value of [Object.create(input), { ...input, task_id: "forged" }, { ...input, context_manifest: {} }, { ...input, workflow_id: "../private" }, { ...input, expected_workflow_revision: 0 }, { ...input, expected_issue_revision: "1" }]) expect(() => createWorkflowTask(value as never, root, { context })).toThrow(/references/);
    expect(listTasks()).toEqual([]);
  });
  it("records a queued read-only task with a built envelope", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Review the auth module." },
      root,
    );
    expect(id).toMatch(/^T-/);
    const tasks = listTasks();
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.lifecycle).toBe("queued");
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.requires_human_approval).toBe(true);
    expect(t.envelope.project).toBe("stock-control");
    expect(t.envelope.agent).toBe("backend-engineer");
    expect(t.envelope.repo_path).toBe(join(root, "projects", "stock-control"));
    expect(t.envelope.source).toBe("dashboard");
    expect(t.envelope.context_admission).toMatchObject({ schema_version: 1, kind: "analysis", manifest_fingerprint: t.envelope.context_manifest!.fingerprint, instructions_length: "Review the auth module.".length });
    expect(t.revision).toBe(1);
    expect(t.orchestration).toMatchObject({ attempts: 0, max_attempts: 3, lease: null });
    expect(readTaskEvents(id)).toMatchObject([
      { task_id: id, type: "policy-evaluated", revision: 1, payload: { boundary: "dispatch", allowed: true } },
      { task_id: id, type: "queued", revision: 1 },
    ]);
  });

  it("rejects unknown project", () => {
    expect(() => governedCreateTask({ project: "nope", agent: "backend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects an agent not allowed for the project", () => {
    expect(() => governedCreateTask({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }, root)).toThrow(ValidationError);
  });

  it("rejects empty instructions", () => {
    expect(() => governedCreateTask({ project: "stock-control", agent: "backend-engineer", instructions: "   " }, root)).toThrow(ValidationError);
  });

  it("records a trusted issue-linked workspace-write task with task_type implementation", () => {
    const { id } = createTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Implement X.", sandbox: "workspace-write" },
      root,
      trustedIssue,
    );
    expect(id).toBe("ISSUE-TASK-1");
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("workspace-write");
    expect(t.envelope.task_type).toBe("implementation");
    expect(t.envelope.metadata).toMatchObject({ issue_id: trustedIssue.issueId, issue_scope_revision: 1 });
  });

  it("rejects workspace-write tasks without trusted issue context", () => {
    expect(() => governedCreateTask(
      { project: "stock-control", agent: "backend-engineer", instructions: "Implement X.", sandbox: "workspace-write" },
      root,
    )).toThrow(/trusted, authorized local issue/i);
  });

  it("defaults to read-only / analysis when sandbox is absent", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "Look." }, root);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.sandbox).toBe("read-only");
    expect(t.envelope.task_type).toBe("analysis");
  });

  it("rejects an invalid sandbox value", () => {
    expect(() =>
      governedCreateTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "danger" } as never, root),
    ).toThrow(ValidationError);
  });

  it("rejects self_verify on a read-only task", () => {
    expect(() =>
      governedCreateTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "read-only", self_verify: true }, root),
    ).toThrow(/self_verify requires/i);
  });

  it("sets self_verify on a workspace-write envelope", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "workspace-write", self_verify: true }, root, trustedIssue);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.self_verify).toBe(true);
  });

  it("keeps task titles free of server-appended client context", () => {
    const { id } = createTask({
      project: "stock-control",
      agent: "backend-engineer",
      instructions: "Review the release.",
      client_context: {
        instructions: "Explicitly selected local client context. Confidential note: synthetic-only.",
        audit: { client_id: "client-fictional", categories: ["confidential-notes"], shared_at: "2026-09-28T12:00:00.000Z" },
      },
    }, root);
    const task = listTasks().find((item) => item.envelope.id === id)!;
    expect(task.envelope.title).toBe("Review the release.");
    expect(task.envelope.instructions).toContain("synthetic-only");
    expect(task.envelope.metadata.client_context_share).toMatchObject({ categories: ["confidential-notes"] });
  });

  it("enforces admitted issue verification even when the caller omits it", () => {
    const { id } = createTask({ project: "stock-control", agent: "backend-engineer", instructions: "x", sandbox: "workspace-write" }, root, trustedIssue);
    const t = listTasks().find((x) => x.envelope.id === id)!;
    expect(t.envelope.self_verify).toBe(true);
  });
  it("requires an issued unchanged preview and rejects raw manifests without creating tasks", () => {
    const request = { kind: "analysis", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect synthetic source" };
    const preview = context.preview(request);
    const input = { project: request.project, agent: request.agent, instructions: request.instructions, role_id: request.role_id, preview_fingerprint: preview.fingerprint };
    expect(() => governedCreateTask({ ...input, preview_fingerprint: undefined }, root, undefined, { context })).toThrow(/preview/);
    expect(() => governedCreateTask(input, root)).toThrow(/not issued/);
    expect(() => governedCreateTask({ ...input, instructions: "Changed" }, root, undefined, { context })).toThrow(/changed/);
    expect(() => governedCreateTask({ ...input, context_manifest: preview.manifest } as never, root, undefined, { context })).toThrow(/fields/);
    writeFileSync(join(root, "projects/stock-control/AGENTS.md"), "New source");
    expect(() => governedCreateTask(input, root, undefined, { context })).toThrow(/changed/);
    expect(listTasks()).toEqual([]); expect(existsSync(join(root, "state/events"))).toBe(false);
  });
  it("rejects expired preview without saving a task or altering the issue", () => {
    let time = Date.now(); const expiring = createContextService(root, { clock: () => new Date(time) });
    const value = { kind: "analysis", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect" };
    const preview = expiring.preview(value); time += 6 * 60_000;
    const bytes = readFileSync(join(root, "state/issues/issues.json"));
    expect(() => governedCreateTask({ project: value.project, agent: value.agent, instructions: value.instructions, role_id: value.role_id, preview_fingerprint: preview.fingerprint }, root, undefined, { context: expiring })).toThrow(/expired/);
    expect(readFileSync(join(root, "state/issues/issues.json"))).toEqual(bytes); expect(listTasks()).toEqual([]);
  });
  it("requires common admission inside the real issue lock and preserves historical agent assignment", () => {
    const issues = createIssueService(root, { context, projectIds: () => ["stock-control"] });
    const value = { kind: "issue", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", issue_id: trustedIssue.issueId, expected_revision: trustedIssue.expectedRevision };
    const preview = context.preview(value); const bytes = readFileSync(join(root, "state/issues/issues.json"));
    expect(() => issues.dispatch(trustedIssue.issueId, trustedIssue.expectedRevision, "backend-engineer")).toThrow(/preview|context/i);
    expect(readFileSync(join(root, "state/issues/issues.json"))).toEqual(bytes); expect(listTasks()).toEqual([]);
    const admitted = issues.dispatch(trustedIssue.issueId, trustedIssue.expectedRevision, "backend-engineer", { role_id: value.role_id, preview_fingerprint: preview.fingerprint });
    expect(admitted.issue.assigned_role_id).toBe("backend-engineer");
    expect(listTasks()[0].envelope.context_manifest).toMatchObject({ role_id: value.role_id, sandbox: "workspace-write" });
    expect(() => issues.dispatch(trustedIssue.issueId, trustedIssue.expectedRevision, "backend-engineer", { role_id: value.role_id, preview_fingerprint: preview.fingerprint })).toThrow(/changed/);
    expect(listTasks()).toHaveLength(1);
  });
  it("CLI confirms a safe preview, rechecks after confirmation and cannot import raw envelopes", async () => {
    const file = join(root, "request.json");
    const value = { kind: "analysis", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Synthetic analysis" };
    writeFileSync(file, JSON.stringify(value));
    await expect(runRecord(file, { repoRoot: root, context, confirm: async () => "cancel" })).rejects.toThrow(/not confirmed/);
    await expect(runRecord(file, { repoRoot: root, context, confirm: async (preview) => { writeFileSync(join(root, "projects/stock-control/AGENTS.md"), "Changed during confirmation"); return preview.fingerprint; } })).rejects.toThrow(/changed/);
    expect(listTasks()).toEqual([]);
    const id = await runRecord(file, { repoRoot: root, context, confirm: async (preview) => preview.fingerprint });
    expect(listTasks()[0].envelope).toMatchObject({ source: "cli", context_manifest: { role_id: value.role_id } });
    expect(() => runSetStatus(id, "running")).toThrow(/leased worker/);
    const raw = JSON.stringify(listTasks()[0].envelope); writeFileSync(file, raw);
    await expect(runRecord(file, { repoRoot: root, context, confirm: async (preview) => preview.fingerprint })).rejects.toThrow();
    expect(listTasks()).toHaveLength(1);
  });
});

describe("T005 data-only BudgetAdmission scaffolding", () => {
  it.each(["analysis", "issue", "workflow", "review"] as const)("binds a new %s draft without a reservation, persistence or legacy hash change", (kind) => {
    const original = newBudgetDraft(kind), before = JSON.stringify(original), options = budgetOptions(original);
    const prepared = prepareTaskBudgetAdmission(original, options), admission = prepared.admission;
    expect(JSON.stringify(original)).toBe(before);
    expect(prepared).toMatchObject({ phase: "scaffold", executable: false, reserves_capacity: false });
    expect(validateTaskRecord(prepared.task)).toBe(true);
    expect(prepared.task.envelope.context_manifest).toEqual(original.envelope.context_manifest);
    expect(prepared.task.envelope.context_admission).toEqual(original.envelope.context_admission);
    expect(prepared.task.envelope.instructions).toBe(original.envelope.instructions);
    expect(admission).toMatchObject({ schema_version: 1, task_id: original.envelope.id, project_id: "synthetic", role_id: original.envelope.context_manifest!.role_id,
      agent_id: "backend-engineer", attribution: { execution_id: original.envelope.id }, manifest_fingerprint: original.envelope.context_manifest!.fingerprint,
      policy_bindings: [{ period: "utc-day", bucket: "2026-10-05" }] });
    expect(admission.intent_id).toBe(budgetTaskIntentId(admission));
    expect(admission.context_admission_version).toBe(kind === "workflow" ? 2 : 1);
    expect(admission.workflow).toEqual(kind === "workflow" ? { workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, grant_id: "grant-1" } : null);
    expect(admission.caps.review_total_tokens).toBe(kind === "review" ? 100 : 0);
    expect(Object.isFrozen(prepared.task.envelope.budget_admission)).toBe(true); expect(Object.isFrozen(admission.policy_bindings[0]!.limits)).toBe(true);
    expect(existsSync(budgetStatePath())).toBe(false); expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/events"))).toBe(false);
    options.attribution.project_ids[0] = "other-project"; expect(admission.attribution.project_ids).toEqual(["synthetic"]);
    expect(taskBudgetReadiness(prepared.task)).toMatchObject({ phase: "scaffold", executable: false, status: "bound", reason: "budget-cutover-unavailable" });
  });
  it("tightens only the detached new draft and recomputes the exact final-cap T003 binding", () => {
    const original = newBudgetDraft(), source = budgetSource({ runtime_ms: 1000, total_tokens: 80 });
    const prepared = prepareTaskBudgetAdmission(original, budgetOptions(original, source));
    expect(prepared.admission.caps).toMatchObject({ attempts: 2, runtime_ms: 1000, total_tokens: 80, concurrent_reads: 1, concurrent_writes: 0 });
    expect(prepared.task.orchestration).toMatchObject({ max_attempts: 2, max_runtime_ms: 1000, max_total_tokens: 80 });
    expect(original.orchestration).toMatchObject(draftBudget);
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source }), budgetStatePath(), draftAt);
    expect(readBudgetLedger()!.reservations[prepared.admission.reservation_id]!.held).toMatchObject({ attempts: 1, runtime_ms: 1000, total_tokens: 80, concurrent_reads: 1 });
  });
  it("refuses caps below the existing TaskRecord runtime minimum rather than changing its schema or inventing an upward cap", () => {
    const draft = newBudgetDraft(), before = JSON.stringify(draft);
    expect(() => prepareTaskBudgetAdmission(draft, budgetOptions(draft, budgetSource({ runtime_ms: 700 })))).toThrow(/draft/);
    expect(JSON.stringify(draft)).toBe(before); expect(existsSync(budgetStatePath())).toBe(false); expect(existsSync(join(root, "state/tasks"))).toBe(false);
  });
  it.each(["analysis", "issue", "workflow", "review"] as const)("proves real synthetic reserve-persist-read-commit for %s, never authority from a digest", (kind) => {
    const source = budgetSource(), prepared = prepareTaskBudgetAdmission(newBudgetDraft(kind), budgetOptions(newBudgetDraft(kind), source)), path = budgetStatePath();
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source }), path, draftAt);
    expect(readBudgetLedger(path)!.admission_intents[prepared.admission.intent_id]).toMatchObject({ status: "pending", admission_id: null });
    // File effects are fixture-only and outside the short budget lock callback.
    writeTask(prepared.task);
    const persisted = readTask(prepared.task.envelope.id)!; expect(persisted.envelope.budget_admission).toEqual(prepared.admission);
    mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: prepared.admission, persisted_admission: persisted.envelope.budget_admission }), path, draftAt);
    expect(readBudgetLedger(path)!.reservations[prepared.admission.reservation_id]).toMatchObject({ status: "committed", run_ids: [] });
    expect(readBudgetLedger(path)!.admission_intents[prepared.admission.intent_id]).toMatchObject({ status: "committed", admission_id: prepared.admission.id });
    expect(taskBudgetReadiness(persisted).executable).toBe(false); expect(existsSync(join(root, "state/events"))).toBe(false);
    expect(readdirSync(join(root, "state/locks"))).toEqual([]);
  });
  it("retains pending holds across a missing persistence gap and refuses borrowed persisted bindings", () => {
    const source = budgetSource(), first = prepareTaskBudgetAdmission(newBudgetDraft(), budgetOptions(newBudgetDraft(), source));
    const secondDraft = newBudgetDraft("analysis", "T-draft-2"), second = prepareTaskBudgetAdmission(secondDraft, budgetOptions(secondDraft, source));
    const path = budgetStatePath(); mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: first.admission, source }), path, draftAt);
    const before = readFileSync(path);
    expect(readTask(first.admission.task_id)).toBeNull();
    for (const persisted_admission of [null, undefined, second.admission]) expect(() => mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: first.admission, persisted_admission }), path, draftAt)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true); expect(readBudgetLedger(path)!.reservations[first.admission.reservation_id]!.status).toBe("pending");
    writeTask(first.task); const taskBytes = readFileSync(join(root, `state/tasks/${first.admission.task_id}.json`));
    expect(() => mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: second.admission, persisted_admission: readTask(first.admission.task_id)!.envelope.budget_admission }), path, draftAt)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true); expect(readFileSync(join(root, `state/tasks/${first.admission.task_id}.json`)).equals(taskBytes)).toBe(true);
  });
  it("refuses the final shared slot atomically without creating a second task or partial reservation", () => {
    const source = budgetSource({ concurrent_reads: 1 }), first = newBudgetDraft(), second = newBudgetDraft("analysis", "T-draft-2");
    const one = prepareTaskBudgetAdmission(first, budgetOptions(first, source)), two = prepareTaskBudgetAdmission(second, budgetOptions(second, source)), path = budgetStatePath();
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: one.admission, source }), path, draftAt); const before = readFileSync(path);
    expect(() => mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: two.admission, source }), path, draftAt)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true); expect(Object.keys(readBudgetLedger(path)!.subjects)).toEqual([one.admission.subject_id]);
    expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/events"))).toBe(false);
  });
  it("keeps mutable existing availability outside immutable draft digests and cannot hide a denied hold", () => {
    const draft = newBudgetDraft(), source = budgetSource();
    const constraint: ExistingBudgetConstraint = { id: "worker", kind: "worker", revision: 1, fingerprint: "b".repeat(64),
      limits: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, key === "concurrent_reads" ? { status: "configured", hard_cap: 1 } : { status: "unconfigured" }])) as BudgetLimits,
      availability: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, { status: "known", remaining: key === "concurrent_reads" ? 1 : 0 }])) as ExistingBudgetConstraint["availability"] };
    const prepared = prepareTaskBudgetAdmission(draft, { ...budgetOptions(draft, source), constraints: [constraint] });
    constraint.availability!.concurrent_reads = { status: "unavailable" };
    const unavailable = prepareTaskBudgetAdmission(draft, { ...budgetOptions(draft, source), constraints: [constraint] });
    expect(unavailable.admission).toEqual(prepared.admission);
    expect(() => mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: unavailable.admission, source, constraints: [constraint] }), budgetStatePath(), draftAt)).toThrow();
    expect(existsSync(budgetStatePath())).toBe(false); expect(existsSync(join(root, "state/tasks"))).toBe(false);
  });
  it.each(["ledger", "reservation_id", "intent_id", "admission_id", "exclude_reservation", "cutover", "executable", "clock"])("rejects caller-supplied %s instead of activating P or substituting a proof", (key) => {
    const draft = newBudgetDraft(); expect(() => prepareTaskBudgetAdmission(draft, { ...budgetOptions(draft), [key]: true } as never)).toThrow(/draft/);
    expect(existsSync(budgetStatePath())).toBe(false); expect(existsSync(join(root, "state/tasks"))).toBe(false);
  });
  it.each(["running", "finished", "retried", "legacy", "bound", "thread", "testing"])("refuses %s records as new draft construction without backfill", (kind) => {
    const draft = newBudgetDraft();
    if (kind === "running") { draft.lifecycle = "running"; draft.started_at = draftAt; }
    if (kind === "finished") { draft.lifecycle = "finished"; draft.finished_at = draftAt; draft.outcome = "completed"; }
    if (kind === "retried") draft.orchestration!.attempts = 1;
    if (kind === "legacy") { delete draft.envelope.context_manifest; delete draft.envelope.context_admission; }
    if (kind === "bound") Object.assign(draft, prepareTaskBudgetAdmission(draft, budgetOptions(draft)).task);
    if (kind === "thread") draft.envelope.metadata.execution = { thread_id: "existing-thread" };
    if (kind === "testing") draft.testing_evidence = {} as never;
    expect(() => prepareTaskBudgetAdmission(draft, { source: budgetSource(), attribution: { company_id: "surtec", project_ids: ["synthetic"], objective_ids: [], execution_id: draft.envelope.id, role_id: "portfolio-analyst", issue_id: null } })).toThrow(/draft/);
    expect(existsSync(budgetStatePath())).toBe(false); expect(existsSync(join(root, "state/tasks"))).toBe(false);
  });
  it("refuses request/option hooks before context or persistence and ignores no environment activation", () => {
    const admit = vi.fn(), service = { admit } as unknown as ContextService, input = { project: "stock-control", agent: "backend-engineer", instructions: "Inspect" };
    const hook = vi.fn(() => true), accessor = Object.defineProperty({ ...input }, "budget_admission", { enumerable: true, get: hook });
    const hidden = Object.defineProperty({ ...input }, "cutover", { value: true }), symbol = { ...input, [Symbol("cutover")]: true };
    for (const value of [Object.create(input), accessor, hidden, symbol, new Proxy(input, {})]) expect(() => governedCreateTask(value, root, undefined, { context: service })).toThrow(/fields/);
    expect(() => governedCreateTask(input, root, undefined, { context: service, budget_admission: {} } as never)).toThrow(/fields/);
    expect(hook).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled(); expect(listTasks()).toEqual([]);
    for (const key of ["SURTEC_BUDGET_CUTOVER", "SURTEC_BUDGET_ADMISSION", "SURTEC_PHASE_P_ENABLED"]) vi.stubEnv(key, "1");
    const created = createTask(input); expect(readTask(created.id)!.envelope).not.toHaveProperty("budget_admission"); expect(existsSync(budgetStatePath())).toBe(false);
  });
  it("refuses nested constructor hooks and sanitizes unavailable policies before serialization", () => {
    const draft = newBudgetDraft(), getter = vi.fn(() => draft.envelope.context_manifest);
    Object.defineProperty(draft.envelope, "context_manifest", { enumerable: true, get: getter });
    expect(() => prepareTaskBudgetAdmission(draft, budgetOptions(newBudgetDraft()))).toThrow(/draft/); expect(getter).not.toHaveBeenCalled();
    const source = budgetSource(); Object.defineProperty(source.policy, "toJSON", { value: vi.fn(() => ({ private: "do-not-surface" })) });
    expect(() => prepareTaskBudgetAdmission(newBudgetDraft(), budgetOptions(newBudgetDraft(), source))).toThrow("Budget admission draft is invalid or unavailable (draft); no capacity was reserved and no task was persisted");
    expect(existsSync(budgetStatePath())).toBe(false);
  });
});
