import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeed, runRecord, runSetStatus } from "./surtec-state";
import { mutateWorkflowDocument } from "../lib/state/workflows";
import { assembleContext, contextHash } from "../lib/context/assemble";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { validateTaskRecord } from "../lib/state/validation";

function retainWorkflow(taskId: string | null): void {
  const at = "2026-10-04T00:00:00Z", hash = "a".repeat(64), budget = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
  mutateWorkflowDocument((d) => {
    d.grants["grant-1"] = { schema_version: 1, id: "grant-1", workflow_id: "workflow-1", project_id: "synthetic", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "analysis", template_version: 1,
      authorized_scope: { expected_outcome: "Inspect synthetic evidence", acceptance_criteria: ["Evidence retained"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] }, role_assignments: [{ role_id: "planner", agent_id: "backend-engineer", sandbox: "read-only", client_context_categories: [] }], permitted_stage_kinds: ["analysis"], source_fingerprints: [{ id: "safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional", budget, correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: "synthetic-only", approved_at: at };
    d.workflows["workflow-1"] = { schema_version: 1, id: "workflow-1", revision: 1, project_id: "synthetic", issue_id: "issue-1", scope_revision: 1, template_id: "analysis", template_version: 1, status: "running", work_scale: "bounded", current_grant_id: "grant-1", authority_revision: 1, stage_ids: ["stage-1"], current_stage_id: "stage-1", pending_decision_id: null, lineage_id: null, candidate: null, approved_plan: null, review_policy: null, budget, counters: { tasks: taskId ? 1 : 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Inspect retained evidence", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null };
    d.stages["stage-1"] = { schema_version: 1, id: "stage-1", workflow_id: "workflow-1", grant_id: "grant-1", authority_revision: 1, generation: 1, ordinal: 1, kind: "analysis", role_id: "planner", agent_id: "backend-engineer", sandbox: "read-only", status: taskId ? "reserved" : "pending", phase: "execution", task_id: taskId, execution_id: null, predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output: null, output_fingerprint: null, candidate: null, context_fingerprint: taskId ? hash : null, created_at: at, updated_at: at };
    if (taskId) d.admission_intents["intent-1"] = { schema_version: 1, id: "intent-1", workflow_id: "workflow-1", stage_id: "stage-1", grant_id: "grant-1", authority_revision: 1, task_id: taskId, status: "reserved", expected_issue_revision: 1, expected_workflow_revision: 1, context_fingerprint: hash, blocked_reason: null, created_at: at, updated_at: at };
  });
}

describe("cli seed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-cli-"));
    mkdirSync(join(root, "fixtures", "tasks"), { recursive: true });
    mkdirSync(join(root, "fixtures", "projects"), { recursive: true });
    writeFileSync(join(root, "fixtures", "tasks", "T-1.json"), JSON.stringify({
      envelope: { id: "T-1", source: "cli", project: "synthetic", task_type: "analysis", agent: "backend-engineer", title: "Synthetic history", instructions: "Synthetic", repo_path: "/synthetic", branch: "agent/T-1", sandbox: "read-only", expected_outputs: [], requires_human_approval: true, metadata: {} },
      lifecycle: "finished", outcome: "completed", created_at: "2026-09-30T00:00:00Z", started_at: null, updated_at: "2026-09-30T00:00:00Z", finished_at: "2026-09-30T00:00:00Z", result: null, logs_path: null,
    }), "utf8");
    writeFileSync(join(root, "fixtures", "projects", "p.json"), "{}", "utf8");
    process.env.SURTEC_STATE_DIR = join(root, "state");
    process.env.SURTEC_FIXTURES_DIR = join(root, "fixtures");
  });
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_FIXTURES_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("copies fixtures into the state dir", () => {
    const { tasks, projects } = runSeed();
    expect(tasks).toBe(1);
    expect(projects).toBe(1);
    expect(existsSync(join(root, "state", "tasks", "T-1.json"))).toBe(true);
    expect(existsSync(join(root, "state", "projects", "p.json"))).toBe(true);
  });
  it("refuses raw envelopes instead of importing a new ungoverned queued task", async () => {
    const path = join(root, "envelope.json");
    writeFileSync(path, JSON.stringify({ id: "RAW-1", source: "cli", sandbox: "workspace-write", context_manifest: {} }));
    await expect(runRecord(path, { repoRoot: root })).rejects.toThrow();
    expect(existsSync(join(root, "state/tasks/RAW-1.json"))).toBe(false);
  });
  it("preflights all seed tasks and refuses queued work before copying any fixture", () => {
    const path = join(root, "fixtures/tasks/T-1.json");
    const record = JSON.parse(readFileSync(path, "utf8")); record.envelope.id = "T-2"; record.lifecycle = "queued"; record.outcome = null; record.finished_at = null;
    writeFileSync(join(root, "fixtures/tasks/T-2.json"), JSON.stringify(record));
    expect(() => runSeed()).toThrow(/terminal task history/);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("does not overwrite an existing task when importing history", () => {
    runSeed(); const path = join(root, "state/tasks/T-1.json"); const before = readFileSync(path);
    expect(() => runSeed()).toThrow(/replace/); expect(readFileSync(path)).toEqual(before);
  });
  it("does not reopen seeded terminal history as recoverable running work", () => {
    runSeed(); const path = join(root, "state/tasks/T-1.json"); const before = readFileSync(path);
    expect(() => runSetStatus("T-1", "running")).toThrow(/leased worker/);
    expect(readFileSync(path)).toEqual(before);
  });
  it("denies set-status on retained legacy work before reading caller result or replacing evidence", () => {
    runSeed(); retainWorkflow("T-1"); const path = join(root, "state/tasks/T-1.json"), before = readFileSync(path), workflowBefore = readFileSync(join(root, "state/workflows/workflows.json"));
    expect(() => runSetStatus("T-1", "finished", join(root, "missing-result.json"))).toThrow(/Active workflow/);
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(join(root, "state/workflows/workflows.json"))).toEqual(workflowBefore);
  });
  it("cannot seed a reserved workflow identity even if its fixture looks like terminal legacy history", () => {
    retainWorkflow("T-1"); const before = readFileSync(join(root, "state/workflows/workflows.json"));
    expect(() => runSeed()).toThrow(/Active workflow/); expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/projects"))).toBe(false);
    expect(readFileSync(join(root, "state/workflows/workflows.json"))).toEqual(before);
  });
  it("preflights project-context import before any task copy while a workflow owns the project", () => {
    retainWorkflow(null); writeFileSync(join(root, "fixtures/projects/synthetic.json"), "{}");
    expect(() => runSeed()).toThrow(/project context retained/); expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/projects"))).toBe(false);
  });
  it("denies project-context import aliased through a different filename", () => {
    retainWorkflow(null); writeFileSync(join(root, "fixtures/projects/p.json"), JSON.stringify({ id: "synthetic", note: "Synthetic context" }));
    expect(() => runSeed()).toThrow(/project context retained/); expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/projects"))).toBe(false);
  });
  it("does not import syntactically valid v2 terminal authority without its real workflow", () => {
    const path = join(root, "fixtures/tasks/T-1.json"), task = JSON.parse(readFileSync(path, "utf8"));
    const budget = { max_attempts: 2, max_runtime_ms: 60000, max_total_tokens: 10000 };
    task.orchestration = { ...defaultTaskOrchestration(), ...budget };
    task.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: "synthetic", agent_id: "backend-engineer", role_id: "planner", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: [], budget,
      limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [], routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["Unavailable"] } },
      testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional fixture"], requires_red_evidence: false } }, [{ id: "runtime/safety", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
    task.envelope.context_admission = { schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: "analysis", task_id: "T-1", template_id: "analysis", template_version: 1, grant_id: "grant-1", authority_revision: 1, role_id: "planner", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, scope_fingerprint: "a".repeat(64), approved_plan: null, predecessor_stage_id: null, handoff_id: null, candidate: null,
      manifest_fingerprint: task.envelope.context_manifest.fingerprint, instructions_length: 9, instructions_hash: contextHash("Synthetic") };
    expect(validateTaskRecord(task)).toBe(true);
    writeFileSync(path, JSON.stringify(task)); expect(() => runSeed()).toThrow(/cannot import workflow authority/); expect(existsSync(join(root, "state"))).toBe(false);
  });
  it.each(["{", '{"schema_version":2}'])("denies seed and set-status when workflow state is unavailable: %s", (bytes) => {
    runSeed(); const path = join(root, "state/workflows/workflows.json"), taskPath = join(root, "state/tasks/T-1.json"), before = readFileSync(taskPath);
    mkdirSync(join(root, "state/workflows")); writeFileSync(path, bytes);
    expect(() => runSetStatus("T-1", "finished", "missing.json")).toThrow(/ownership is unavailable/); expect(() => runSeed()).toThrow(/ownership is unavailable/);
    expect(readFileSync(path, "utf8")).toBe(bytes); expect(readFileSync(taskPath)).toEqual(before);
  });
});
