import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createContextService, type ContextPreviewRequest, RUNTIME_READ_LIMITATION } from "./context-service";
import { createIssueService } from "./issue-service";
import { emptyProjectProfile } from "../../../lib/portfolio-profile";
import type { AgentRoleRegistry, ContextConfig } from "../../../lib/context/types";
import type { IssueDocument, WorkIssue } from "../../../lib/issues/types";
import type { HarnessSource } from "../../../lib/harness/types";
import type { TaskRecord } from "../../../lib/state/types";
import { createTask } from "./dispatch";
import { readTask } from "../../../lib/state/store";

let root: string;
let project: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-context-service-"));
  project = join(root, "projects/alpha"); state = join(root, "state");
  mkdirSync(join(project, ".git"), { recursive: true }); mkdirSync(join(root, "registry"));
  cpSync("registry/agents.yml", join(root, "registry/agents.yml"));
  cpSync("registry/agent-roles.yml", join(root, "registry/agent-roles.yml"));
  cpSync("registry/context-policy.yml", join(root, "registry/context-policy.yml"));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
  }
  writeFileSync(join(root, "registry/projects.yml"), "projects:\n  alpha:\n    allowed_agents: [tech-lead, backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n");
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const request = (): ContextPreviewRequest => ({ kind: "analysis", project: "alpha", agent: "tech-lead", role_id: "planner", instructions: "Inspect the synthetic project." });
function issueFixture(): WorkIssue {
  const service = createIssueService(root, { projectIds: () => ["alpha"] });
  const issue = service.create({ project_id: "alpha", title: "Synthetic bounded fix", expected_outcome: "Synthetic result", acceptance_criteria: ["Fixture result is verified"], criticality: "low", assigned_role_id: "backend-engineer",
    authorized_scope: { expected_outcome: "Synthetic result", acceptance_criteria: ["Fixture result is verified"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  return service.authorize(issue.id, issue.revision, "synthetic-human-approval");
}
const issueRequest = (issue: WorkIssue): ContextPreviewRequest => ({ kind: "issue", project: "alpha", agent: "backend-engineer", role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision });

describe("trusted no-effect context previews", () => {
  it("shares issue sources with workflow read-only roles without the v1 writer guard or verification capability", () => {
    const issue = issueFixture(), service = createContextService(root);
    const input = { kind: "issue", project: "alpha", agent: "tech-lead", role_id: "planner", issue_id: issue.id, expected_revision: issue.revision };
    expect(() => service.preview(input)).toThrow(/Role does not permit this agent or task kind/);
    const before = readFileSync(join(state, "issues/issues.json"), "utf8");
    const result = service.assembleWorkflowRole(input, "planning");
    expect(result.preview.allowed).toBe(true); expect(result.preview.manifest.sandbox).toBe("read-only"); expect(result.preview.manifest.tools).toEqual(["inspect"]);
    expect(result.testingPlan.runners).toEqual([]); expect(result.requiredTestingPlan!.runners.length).toBeGreaterThan(0);
    expect(result.preview.manifest.sources.some((entry) => entry.id === "issue/authorized-work")).toBe(true);
    expect(readFileSync(join(state, "issues/issues.json"), "utf8")).toBe(before);
    expect(() => service.assembleWorkflowRole(input, "implementation")).toThrow(/logical role/);
    expect(() => service.preview({ ...input, kind: "workflow-stage" })).toThrow(/request/);
  });
  it("retains strict TDD requirements as captured-evidence data for workflow read-only roles, never runnable commands", () => {
    const issue = issueFixture(), config = parse(readFileSync("registry/context-policy.yml", "utf8")) as ContextConfig;
    const probe = { sources: [{ path: "test/probe.mjs", sha256: "a".repeat(64) }], assertion_ids: ["assertion-1"] };
    config.runners = { red: { command: "node verify.mjs", stage: "red", probe }, green: { command: "node verify.mjs", stage: "green", probe } };
    config.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] }; config.testing.no_refactor_justification = "Synthetic immutable fixture needs no refactor";
    const result = createContextService(root, { readConfig: () => config }).assembleWorkflowRole({ kind: "issue", project: "alpha", agent: "tech-lead", role_id: "planner", issue_id: issue.id, expected_revision: issue.revision }, "planning");
    expect(result.preview.allowed).toBe(true); expect(result.preview.manifest.testing.mode).toBe("strict-tdd"); expect(result.preview.manifest.tools).toEqual(["inspect"]);
    expect(result.testingPlan.runners).toEqual([]); expect(result.requiredTestingPlan!.runners.map((runner) => runner.stage).sort()).toEqual(["green", "red"]);
  });
  it("refuses strict TDD without observable assertion configuration before dispatch effects", () => {
    const config = parse(readFileSync("registry/context-policy.yml", "utf8")) as ContextConfig;
    config.runners = { red: { command: "node verify.mjs", stage: "red" }, green: { command: "node verify.mjs", stage: "green" } };
    config.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] };
    expect(() => createContextService(root, { readConfig: () => config }).preview(request())).toThrow(/observable/);
    const probe = { sources: [{ path: "test/probe.mjs", sha256: "a".repeat(64) }], assertion_ids: ["behavior"] };
    config.runners.red!.probe = probe; config.runners.green!.probe = probe; config.testing.no_refactor_justification = "No structural change in the trusted bounded fixture.";
    const service = createContextService(root, { readConfig: () => config }), preview = service.preview(request());
    expect(preview.allowed).toBe(false); expect(preview.blocked_reasons).toContain("Strict TDD requires authorized worktree verification capability");
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/not issued/);
    expect(existsSync(state)).toBe(false);
  });
  function admittedAnalysis(service: ReturnType<typeof createContextService>, input = request()): TaskRecord {
    const preview = service.preview(input);
    const { id } = createTask({ project: input.project, agent: input.agent, role_id: input.role_id, instructions: input.instructions!, preview_fingerprint: preview.fingerprint, client_context_categories: input.client_context_categories }, root, undefined, { context: service });
    return readTask(id)!;
  }
  it("reconstructs admitted analysis after service restart without reissuing preview or inventing evidence", () => {
    writeFileSync(join(project, "AGENTS.md"), "Selected project rules");
    const record = admittedAnalysis(createContextService(root));
    expect(createContextService(root).revalidateTask(record).rendered).toContain("Selected project rules");
    delete record.envelope.context_admission;
    expect(() => createContextService(root).revalidateTask(record)).toThrow(/binding/);
  });
  it("rejects changed sources, role policy, consent bodies and exhausted budgets at execution", () => {
    let body = "Original selected confidential fixture";
    const client = (_project: string, categories: string[]) => ({ instructions: body, audit: { client_id: "synthetic-client", categories: categories as ["confidential-notes"], shared_at: new Date().toISOString() } });
    const service = createContextService(root, { buildClientContext: client });
    const record = admittedAnalysis(service, { ...request(), client_context_categories: ["confidential-notes"] });
    expect(service.revalidateTask(record).clientContext!.instructions).toBe(body);
    body = "Changed selected confidential fixture";
    expect(() => service.revalidateTask(record)).toThrow(/changed/);
    body = "Original selected confidential fixture";
    record.orchestration!.cumulative_tokens = record.orchestration!.max_total_tokens;
    expect(() => service.revalidateTask(record)).toThrow(/budget/);
    record.orchestration!.cumulative_tokens = 0;
    writeFileSync(join(project, "AGENTS.md"), "New project rules");
    expect(() => service.revalidateTask(record)).toThrow(/changed/);
  });
  it("accepts only the exact post-admission issue revision and live task ownership", () => {
    const issue = issueFixture(); const context = createContextService(root);
    const preview = context.preview(issueRequest(issue));
    const dispatched = createIssueService(root, { projectIds: () => ["alpha"], context }).dispatch(issue.id, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    const record = readTask(dispatched.taskId)!;
    expect(createContextService(root).revalidateTask(record).preview.fingerprint).toBe(preview.fingerprint);
    const document = JSON.parse(readFileSync(join(state, "issues/issues.json"), "utf8")) as IssueDocument;
    document.issues[issue.id]!.status = "blocked";
    expect(() => createContextService(root, { readIssues: () => document }).revalidateTask(record)).toThrow(/authorization/);
    document.issues[issue.id]!.status = "working"; document.issues[issue.id]!.revision += 1;
    expect(() => createContextService(root, { readIssues: () => document }).revalidateTask(record)).toThrow(/authorization/);
  });
  it("returns attributable bounded evidence without source bodies, paths, state writes or client reads", () => {
    writeFileSync(join(project, "AGENTS.md"), "Synthetic private source body");
    const client = vi.fn(); const service = createContextService(root, { buildClientContext: client });
    const preview = service.preview(request());
    expect(preview.allowed).toBe(true); expect(preview.runtime_read_limitation).toBe(RUNTIME_READ_LIMITATION);
    expect(preview.manifest.tools).toEqual(["inspect"]); expect(preview.manifest.selected_categories).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("Synthetic private source body"); expect(JSON.stringify(preview)).not.toContain(project);
    expect(client).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
    expect(service.admit(request(), preview.fingerprint).rendered).toContain(RUNTIME_READ_LIMITATION);
    expect(existsSync(state)).toBe(false);
  });
  it("rejects stale instructions, source, consent, role and technical policy bindings before effects", () => {
    writeFileSync(join(project, "AGENTS.md"), "Original source");
    const service = createContextService(root); const preview = service.preview(request());
    expect(() => service.admit({ ...request(), instructions: "Changed request" }, preview.fingerprint)).toThrow(/changed/);
    expect(() => service.admit({ ...request(), role_id: "reviewer" }, preview.fingerprint)).toThrow(/changed/);
    writeFileSync(join(project, "AGENTS.md"), "Changed source");
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/changed/);
    const refreshed = service.preview(request());
    writeFileSync(join(root, "registry/projects.yml"), "projects:\n  alpha:\n    allowed_agents: [tech-lead]\n    sandbox: { default: read-only }\n");
    expect(() => service.admit(request(), refreshed.fingerprint)).toThrow(/changed/);
    expect(existsSync(state)).toBe(false);
  });
  it("fingerprints required evaluation contents rather than only their paths", () => {
    const service = createContextService(root); const preview = service.preview(request());
    const path = join(root, "evals/v2/cases/implementation-plan.json");
    const evidence = JSON.parse(readFileSync(path, "utf8")); evidence.description = "Synthetic reviewed amendment";
    writeFileSync(path, JSON.stringify(evidence));
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/changed/);
  });
  it("includes only explicitly selected server-resolved client categories without leaking bodies or timestamps", () => {
    let body = "Synthetic confidential body";
    const client = vi.fn((_project: string, categories: string[]) => ({ instructions: body, audit: { client_id: "synthetic-client", categories: categories as ["confidential-notes"], shared_at: new Date().toISOString() } }));
    const service = createContextService(root, { buildClientContext: client });
    const consent = { ...request(), client_context_categories: ["confidential-notes"] };
    const preview = service.preview(consent);
    expect(client).toHaveBeenCalledWith("alpha", ["confidential-notes"]); expect(preview.manifest.selected_categories).toEqual(["confidential-notes"]);
    expect(JSON.stringify(preview)).not.toContain(body); expect(JSON.stringify(preview)).not.toContain("synthetic-client");
    expect(service.admit(consent, preview.fingerprint).rendered).toContain(body);
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/changed/);
    body = "Changed confidential body"; expect(() => service.admit(consent, preview.fingerprint)).toThrow(/changed/);
    expect(existsSync(state)).toBe(false);
  });
  it("refuses mismatched consent, arbitrary manifests and request-supplied issue instructions", () => {
    const service = createContextService(root, { buildClientContext: () => null });
    expect(() => service.preview({ ...request(), client_context_categories: ["confidential-notes"] })).toThrow(/unavailable/);
    expect(() => service.preview({ ...request(), context_manifest: {} })).toThrow(/Invalid/);
    expect(() => service.preview({ ...request(), client_context_categories: ["confidential-notes", "confidential-notes"] })).toThrow(/categories/);
    expect(() => service.preview({ ...request(), sandbox: "workspace-write" })).toThrow(/Invalid/);
    expect(() => service.admit(request(), "forged")).toThrow(/preview is required/);
    expect(() => service.preview({ ...issueRequest(issueFixture()), instructions: "Override scope" })).toThrow(/server-owned/);
  });
  it("omits client-linked outcomes without consent and never silently migrates legacy profile state", () => {
    mkdirSync(join(state, "portfolio"), { recursive: true });
    const profile = { ...emptyProjectProfile("alpha"), kind: "client-product", client_id: "synthetic-client", current_goal: "Synthetic private client goal", next_action: "Synthetic private next action" };
    const path = join(state, "portfolio/projects.json");
    writeFileSync(path, JSON.stringify({ schema_version: 2, projects: { alpha: profile } }));
    const service = createContextService(root); expect(service.assemble(request()).rendered).not.toContain("Synthetic private");
    const legacy = JSON.stringify({ schema_version: 1, projects: {} }); writeFileSync(path, legacy);
    expect(() => service.preview(request())).toThrow(/migration/); expect(readFileSync(path, "utf8")).toBe(legacy);
    expect(existsSync(join(state, "backups"))).toBe(false); expect(existsSync(join(state, "locks"))).toBe(false);
  });
  it("retains exact issue agent assignments, revisions and scope without preview writes", () => {
    const issue = issueFixture(); const service = createContextService(root); const input = issueRequest(issue);
    const path = join(state, "issues/issues.json"); const before = readFileSync(path);
    const preview = service.preview(input); expect(preview.allowed).toBe(true); expect(preview.manifest.sandbox).toBe("workspace-write");
    expect(preview.manifest.tools).toContain("edit-authorized-scope");
    expect(service.admit(input, preview.fingerprint).issue!.authorized_scope).toEqual(issue.authorized_scope);
    expect(service.preview({ ...input, agent: "tech-lead" }).blocked_reasons).toContain("Selected agent differs from the issue's authorized assignment");
    expect(() => service.preview({ ...input, expected_revision: issue.revision - 1 })).toThrow(/refresh/);
    expect(() => service.preview({ ...input, role_id: "planner", agent: "tech-lead" })).toThrow(/Role does not permit/);
    expect(readFileSync(path)).toEqual(before); expect(existsSync(join(state, "tasks"))).toBe(false);
  });
  it("shows missing authorization and unresolved blockers as blocked, not permission to dispatch", () => {
    const issue = issueFixture(); const document = JSON.parse(readFileSync(join(state, "issues/issues.json"), "utf8")) as IssueDocument;
    const blocker = { ...issue, id: "synthetic-blocker", status: "proposed" as const };
    document.issues[blocker.id] = blocker; document.issues[issue.id]!.blocked_by_issue_ids = [blocker.id]; document.issues[issue.id]!.status = "proposed";
    const service = createContextService(root, { readIssues: () => document });
    const preview = service.preview(issueRequest(issue)); expect(preview.allowed).toBe(false);
    expect(preview.blocked_reasons).toContain("Issue has unresolved blockers");
    expect(() => service.admit(issueRequest(issue), preview.fingerprint)).toThrow(/not issued|blocked/);
  });
  it("refuses oversized mandatory context and prevents role/project allowlist expansion", () => {
    const config = parse(readFileSync("registry/context-policy.yml", "utf8")) as ContextConfig; config.limits.max_bytes = 10;
    expect(() => createContextService(root, { readConfig: () => config }).preview(request())).toThrow(/budget/);
    const roles = createContextService(root).roles("alpha"); expect(roles.every((role) => role.agents.every((agent) => ["tech-lead", "backend-engineer"].includes(agent)))).toBe(true);
    expect(() => createContextService(root).preview({ ...request(), agent: "product-manager" })).toThrow(/not allowed/);
    expect(existsSync(state)).toBe(false);
  });
  it("retains trusted Harness testing/review constraints and refuses unsupported strict evidence or unauthorized runners", () => {
    const harness: HarnessSource = { status: "trusted", fingerprint: "a".repeat(64), reason: null, manifest: null,
      registry: { schema_version: 1, source: { id: "synthetic", root: ".", manifest: "registry/synthetic.json", manifest_sha256: "a".repeat(64) }, runners: {}, projects: {
        alpha: { ownership: [], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: null },
      } } };
    const service = createContextService(root, { readHarnessSource: () => harness });
    expect(service.preview(request()).manifest.testing.minimum_review_depth).toBe("full");
    harness.registry!.projects.alpha!.testing_policy.mode = "strict-tdd";
    harness.registry!.projects.alpha!.testing_policy.requires_red_evidence = true;
    expect(() => service.preview(request())).toThrow(/RED and GREEN/);
    harness.registry!.projects.alpha!.testing_policy.mode = "functional";
    harness.registry!.projects.alpha!.testing_policy.runner_id = "unauthorized";
    harness.registry!.runners.unauthorized = { command: "node unauthorized.mjs" };
    expect(() => service.preview(request())).toThrow(/not authorized/);
  });
  it("blocks admission when no capacity is available without reserving or creating tasks", () => {
    const active = { lifecycle: "running", envelope: { project: "alpha", sandbox: "workspace-write", metadata: {} } } as TaskRecord;
    const service = createContextService(root, { readTasks: () => [active], maxConcurrent: () => 1 });
    const preview = service.preview(request()); expect(preview.allowed).toBe(false);
    expect(preview.manifest.routing.action).toBe("needs-decision");
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/not issued|blocked/);
    expect(existsSync(state)).toBe(false);
  });
  it("requires a genuinely issued non-expired preview and invalidates it across service restart", () => {
    let time = Date.parse("2026-09-30T12:00:00Z");
    const service = createContextService(root, { clock: () => new Date(time) });
    const forged = service.assemble(request()).preview.fingerprint;
    expect(() => service.admit(request(), forged)).toThrow(/not issued/);
    const preview = service.preview(request()); expect(() => service.admit(request(), preview.fingerprint)).not.toThrow();
    expect(() => createContextService(root).admit(request(), preview.fingerprint)).toThrow(/not issued/);
    time += 5 * 60_000; expect(() => service.admit(request(), preview.fingerprint)).toThrow(/expired/);
    const renewed = service.preview(request()); expect(() => service.admit(request(), renewed.fingerprint)).not.toThrow();
    expect(existsSync(state)).toBe(false);
  });
});
