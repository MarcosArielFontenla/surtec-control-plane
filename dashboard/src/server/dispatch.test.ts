import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask as governedCreateTask, createWorkflowTask, ValidationError, type CreateTaskInput } from "./dispatch";
import { createWorkflowContextService } from "./workflow-context-service";
import { createContextService, type ContextService } from "./context-service";
import { createIssueService } from "./issue-service";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";

let context: ContextService;
let trustedIssue = {
  taskId: "ISSUE-TASK-1",
  issueId: "ISSUE-1",
  scopeRevision: 1,
  expectedRevision: 1,
  authorizedScope: {} as never,
};
import { listTasks } from "../../../lib/state/store";
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
});

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
