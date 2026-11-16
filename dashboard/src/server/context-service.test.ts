import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createContextService, type ContextPreview, type ContextPreviewRequest, RUNTIME_READ_LIMITATION } from "./context-service";
import { createIssueService } from "./issue-service";
import { createApp } from "./index";
import { emptyProjectProfile } from "../../../lib/portfolio-profile";
import type { AgentRoleRegistry, ContextConfig } from "../../../lib/context/types";
import type { IssueDocument, WorkIssue } from "../../../lib/issues/types";
import type { HarnessSource } from "../../../lib/harness/types";
import type { TaskRecord } from "../../../lib/state/types";
import { createTask } from "./dispatch";
import { readTask } from "../../../lib/state/store";
import { readBudgetPolicy } from "../../../lib/budgets/policy";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLedger, type BudgetLimits } from "../../../lib/budgets/types";
import { assertBudgetLedger } from "../../../lib/budgets/validation";
import { budgetStatePath } from "../../../lib/state/paths";
import { contextHash } from "../../../lib/context/assemble";

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
  cpSync("registry/budget-policy.yml", join(root, "registry/budget-policy.yml"));
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
const budgetAt = "2026-10-06T12:00:00Z";
const budgetAmountsFixture = (values: Partial<BudgetAmounts> = {}): BudgetAmounts => Object.assign(Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])), values) as BudgetAmounts;
function heldBudget(tokens: number, taskId = "held-task"): BudgetLedger {
  const source = readBudgetPolicy(root), id = "budget-subject", reservation = "budget-reservation", intent = "budget-intent";
  const value: BudgetLedger = { schema_version: 1, revision: 1, created_at: budgetAt, updated_at: budgetAt,
    subjects: { [id]: { id, kind: "task", task_id: taskId, project_id: "alpha", role_id: "planner", agent_id: "tech-lead", issue_id: null, workflow: null,
      attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: "planner", execution_id: taskId } } },
    reservations: { [reservation]: { id: reservation, revision: 1, subject_id: id, intent_id: intent, status: "committed", policy_bindings: [{ policy_id: "surtec-default", policy_revision: 1, policy_fingerprint: source.fingerprint, scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none", limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }], held: budgetAmountsFixture({ attempts: 1, runtime_ms: 1000, total_tokens: tokens, concurrent_reads: 1 }), uncertain_dimensions: [], run_ids: [], created_at: budgetAt, updated_at: budgetAt } },
    admission_intents: { [intent]: { id: intent, subject_id: id, reservation_id: reservation, admission_id: "synthetic-admission", status: "committed", created_at: budgetAt, updated_at: budgetAt } }, charges: {} };
  assertBudgetLedger(value); return value;
}
function configuredBudget(tokens: number): void {
  const source = structuredClone(readBudgetPolicy(root)); source.policy.rules[0]!.limits.total_tokens = { status: "configured", hard_cap: tokens };
  writeFileSync(join(root, "registry/budget-policy.yml"), JSON.stringify(source.policy));
}

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
  it("adds a neutral informational budget preview without reserving or changing legacy instructions", () => {
    const service = createContextService(root, { clock: () => new Date(budgetAt) }); const result = service.assemble(request()); const preview = result.preview.budget_preview!;
    expect(preview).toMatchObject({ status: "available", can_admit: true, executable: false, reserves_capacity: false, ledger: { status: "absent", revision: null } });
    expect(preview.binding!.attribution).toEqual({ company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: null, role_id: "planner", execution_id: `preview-${contextHash(JSON.stringify(["alpha", "planner", null]))}` });
    expect(preview.resolution!.sources.map((source) => source.id)).toEqual(["policy:surtec-default", "existing:project-alpha", "existing:role-planner", "existing:worker"]);
    expect(result.budgetConstraints!.map((constraint) => constraint.kind)).toEqual(["worker", "role", "project"]); expect(result.preview).not.toHaveProperty("budgetConstraints");
    expect(result.preview.allowed).toBe(true); expect(result.preview.blocked_reasons).toEqual([]); expect(result.preview.manifest).not.toHaveProperty("budget_preview");
    expect(result.rendered).not.toContain(preview.binding!.cap_fingerprint); expect(result.rendered).not.toContain(preview.limitation);
    expect(existsSync(state)).toBe(false); expect(service.assemble(request()).preview.fingerprint).toBe(result.preview.fingerprint);
  });
  it("keeps exhausted or unknown budget data informative rather than activating P admission gates", () => {
    configuredBudget(100); const ledger = heldBudget(100); const service = createContextService(root, { readBudgetLedger: () => ledger, clock: () => new Date(budgetAt) });
    const exhausted = service.assemble(request()); expect(exhausted.preview.budget_preview!.status).toBe("exhausted"); expect(exhausted.preview.budget_preview!.can_admit).toBe(false);
    expect(exhausted.preview.allowed).toBe(true); expect(exhausted.preview.blocked_reasons).toEqual([]);
    ledger.reservations["budget-reservation"]!.status = "unknown"; ledger.reservations["budget-reservation"]!.uncertain_dimensions = ["total_tokens"]; ledger.admission_intents["budget-intent"]!.status = "unknown";
    const unknown = service.assemble(request()); expect(unknown.preview.budget_preview!.status).toBe("unavailable"); expect(unknown.preview.budget_preview!.resolution!.dimensions.total_tokens.remaining).toBeNull();
    expect(unknown.preview.manifest).toEqual(exhausted.preview.manifest); expect(unknown.rendered).toBe(exhausted.rendered); expect(unknown.preview.allowed).toBe(true); expect(existsSync(state)).toBe(false);
  });
  it("keeps policy, balances, clock and rollover outside context fingerprints and rendered instructions", () => {
    configuredBudget(100); const source = structuredClone(readBudgetPolicy(root)); source.policy.rules[0]!.period = "utc-day"; writeFileSync(join(root, "registry/budget-policy.yml"), JSON.stringify(source.policy));
    let ledger: BudgetLedger | null = null, time = new Date(budgetAt); const service = createContextService(root, { readBudgetLedger: () => ledger, clock: () => time });
    const first = service.assemble(request()); ledger = heldBudget(50); const held = service.assemble(request());
    expect(held.preview.budget_preview!.resolution!.dimensions.total_tokens.remaining).toBe(50); expect(held.preview.budget_preview!.binding!.cap_fingerprint).toBe(first.preview.budget_preview!.binding!.cap_fingerprint);
    time = new Date("2026-10-07T12:00:00Z"); configuredBudget(80); const changed = service.assemble(request());
    expect(changed.preview.budget_preview!.binding!.policy_bindings[0]!.bucket).toBe("2026-10-07"); expect(first.preview.budget_preview!.binding!.policy_bindings[0]!.bucket).toBe("2026-10-06");
    expect(changed.preview.budget_preview!.binding!.cap_fingerprint).not.toBe(held.preview.budget_preview!.binding!.cap_fingerprint); expect(changed.preview.budget_preview!.resolution!.dimensions.total_tokens.remaining).toBe(30);
    for (const result of [held, changed]) { expect(result.preview.fingerprint).toBe(first.preview.fingerprint); expect(result.preview.manifest).toEqual(first.preview.manifest); expect(result.rendered).toBe(first.rendered); expect(result.preview.allowed).toBe(first.preview.allowed); expect(result.preview.blocked_reasons).toEqual(first.preview.blocked_reasons); }
    expect(existsSync(state)).toBe(false);
  });
  it("never excludes an existing task's own ledger hold while revalidating its unchanged legacy context", () => {
    configuredBudget(100); let ledger: BudgetLedger | null = null;
    const service = createContextService(root, { readBudgetLedger: () => ledger, clock: () => new Date(budgetAt) }); const record = admittedAnalysis(service); const taskPath = join(state, "tasks", `${record.envelope.id}.json`); const bytes = readFileSync(taskPath);
    ledger = heldBudget(100, record.envelope.id); const result = service.revalidateTask(record);
    expect(result.preview.fingerprint).toBe(record.envelope.context_manifest!.fingerprint); expect(result.preview.allowed).toBe(true); expect(result.preview.budget_preview!.status).toBe("exhausted");
    expect(result.preview.budget_preview!.binding!.attribution.execution_id).toBe(record.envelope.id); expect(result.preview.budget_preview!.resolution!.sources[0]!.dimensions.total_tokens.reserved).toBe(100);
    expect(readFileSync(taskPath)).toEqual(bytes); expect(JSON.parse(bytes.toString("utf8"))).not.toHaveProperty("budget_preview"); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it("preserves malformed budget bytes and sanitizes diagnostic failure without changing context or locks", () => {
    const service = createContextService(root, { clock: () => new Date(budgetAt) }); const baseline = service.assemble(request()); const path = budgetStatePath(state); mkdirSync(join(state, "budgets"), { recursive: true });
    const bytes = '{"schema_version":999,"private":"SYNTHETIC-PRIVATE-BUDGET"}'; writeFileSync(path, bytes); const inventory = readdirSync(state);
    const result = service.assemble(request()); expect(result.preview.budget_preview!).toMatchObject({ status: "unavailable", can_admit: false, executable: false, reserves_capacity: false, ledger: { status: "unavailable" } });
    expect(result.preview.budget_preview!.denials[0]!.code).toBe("budget-ledger-unavailable"); expect(JSON.stringify(result.preview)).not.toContain("SYNTHETIC-PRIVATE-BUDGET");
    expect(result.preview.manifest).toEqual(baseline.preview.manifest); expect(result.rendered).toBe(baseline.rendered); expect(result.preview.allowed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(bytes); expect(readdirSync(state)).toEqual(inventory); expect(existsSync(join(state, "locks"))).toBe(false);
  });
  it("returns sanitized unavailable for budget-only policy or attribution failures without changing legacy gates", () => {
    const plain = createContextService(root, { clock: () => new Date(budgetAt) }).assemble(request());
    const failed = createContextService(root, { readBudgetPolicy: () => { throw new Error(`SYNTHETIC-PRIVATE ${root}`); }, clock: () => new Date(budgetAt) }).assemble(request());
    expect(failed.preview.budget_preview!.denials[0]!.code).toBe("budget-policy-unavailable"); expect(JSON.stringify(failed.preview)).not.toContain("SYNTHETIC-PRIVATE"); expect(failed.rendered).toBe(plain.rendered); expect(failed.preview.manifest).toEqual(plain.preview.manifest);
    const invalidOrganization = { company: { id: "surtec", mission: null, operating_principles: [] }, objectives: [], project_objectives: {} } as never;
    const invalid = createContextService(root, { readOrganization: () => invalidOrganization, clock: () => new Date(budgetAt) }).assemble(request());
    expect(invalid.preview.budget_preview!.denials[0]!.code).toBe("budget-preview-unavailable"); expect(invalid.preview.budget_preview!.binding).toBeNull(); expect(invalid.preview.manifest).toEqual(plain.preview.manifest); expect(invalid.rendered).toBe(plain.rendered); expect(invalid.preview.allowed).toBe(true); expect(existsSync(state)).toBe(false);
  });
  it("uses global worker occupancy for both modes without hashing active task balances into cap provenance", () => {
    const active = { lifecycle: "running", envelope: { id: "active-task", project: "other", sandbox: "workspace-write", metadata: {} } } as TaskRecord;
    let tasks: TaskRecord[] = []; const service = createContextService(root, { readTasks: () => tasks, maxConcurrent: () => 2, clock: () => new Date(budgetAt) }); const first = service.assemble(request()).preview.budget_preview!;
    tasks = [active]; const occupied = service.assemble(request()).preview.budget_preview!;
    expect(occupied.resolution!.sources.find((source) => source.id === "existing:worker")!.dimensions.concurrent_reads.remaining).toBe(1);
    expect(occupied.resolution!.sources.find((source) => source.id === "existing:worker")!.dimensions.concurrent_writes.remaining).toBe(1); expect(occupied.binding!.cap_fingerprint).toBe(first.binding!.cap_fingerprint);
    tasks = [active, { ...active, envelope: { ...active.envelope, id: "active-read", sandbox: "read-only" } }]; const full = service.assemble(request());
    expect(full.preview.budget_preview!.status).toBe("exhausted"); expect(full.preview.budget_preview!.binding!.cap_fingerprint).toBe(first.binding!.cap_fingerprint); expect(full.preview.allowed).toBe(false);
    expect(existsSync(state)).toBe(false);
  });
  it("reflects the existing project writer exclusion without limiting read-only previews or hashing occupancy", () => {
    const issue = issueFixture(); const inventory = readdirSync(state, { recursive: true }).sort(); const active = { lifecycle: "running", envelope: { id: "active-task", project: "other", sandbox: "workspace-write", metadata: {} } } as TaskRecord;
    let tasks: TaskRecord[] = []; const service = createContextService(root, { readTasks: () => tasks, maxConcurrent: () => 3, clock: () => new Date(budgetAt) }); const first = service.assemble(issueRequest(issue));
    const projectView = (preview: ContextPreview) => preview.budget_preview!.resolution!.sources.find((source) => source.id === "existing:project-alpha")!;
    expect(projectView(first.preview).dimensions.concurrent_writes.remaining).toBe(1);
    tasks = [active]; const other = service.assemble(issueRequest(issue)); expect(projectView(other.preview).dimensions.concurrent_writes.remaining).toBe(1); expect(other.preview.budget_preview!.status).toBe("available");
    tasks = [{ ...active, envelope: { ...active.envelope, project: "alpha" } }]; const same = service.assemble(issueRequest(issue));
    expect(projectView(same.preview).dimensions.concurrent_writes.remaining).toBe(0); expect(same.preview.budget_preview!.status).toBe("exhausted"); expect(same.preview.allowed).toBe(false);
    expect(same.preview.budget_preview!.binding!.cap_fingerprint).toBe(first.preview.budget_preview!.binding!.cap_fingerprint); expect(other.preview.budget_preview!.binding!.cap_fingerprint).toBe(first.preview.budget_preview!.binding!.cap_fingerprint);
    const read = service.assemble(request()); expect(projectView(read.preview).dimensions.concurrent_writes.remaining).toBe(0); expect(read.preview.budget_preview!.status).toBe("available"); expect(read.preview.allowed).toBe(true);
    tasks = [{ ...active, envelope: { ...active.envelope, project: "alpha", sandbox: "read-only" } }]; const reader = service.assemble(issueRequest(issue));
    expect(projectView(reader.preview).dimensions.concurrent_writes.remaining).toBe(1); expect(reader.preview.budget_preview!.status).toBe("available"); expect(reader.preview.allowed).toBe(true);
    expect(existsSync(join(state, "tasks"))).toBe(false); expect(existsSync(join(state, "budgets"))).toBe(false); expect(readdirSync(state, { recursive: true }).sort()).toEqual(inventory);
  });
  it.each(["absent", "present"] as const)("returns additive informational budget data through protected HTTP with %s ledger and no effects", async (ledgerStatus) => {
    configuredBudget(100); const path = budgetStatePath(state);
    if (ledgerStatus === "present") { mkdirSync(join(state, "budgets"), { recursive: true }); writeFileSync(path, JSON.stringify(heldBudget(50))); }
    const bytes = ledgerStatus === "present" ? readFileSync(path) : null;
    const inventory = existsSync(state) ? readdirSync(state, { recursive: true }).sort() : [];
    const service = createContextService(root, { clock: () => new Date(budgetAt) }); const preview = vi.spyOn(service, "preview"); const dispatch = vi.fn(); const app = createApp(root, dispatch, undefined, undefined, { context: service });
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request()) };
    const denied = await app.request("/api/context/preview", init); expect(denied.status).toBe(403); expect(preview).not.toHaveBeenCalled();
    const session = await app.request("/api/session"); const { token } = await session.json() as { token: string };
    const response = await app.request("/api/context/preview", { ...init, headers: { ...init.headers, "X-Surtec-Session": token } }); const payload = await response.json() as ContextPreview;
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(preview).toHaveBeenCalledTimes(1);
    expect(payload.budget_preview).toMatchObject({ executable: false, reserves_capacity: false, ledger: { status: ledgerStatus === "present" ? "available" : "absent" }, status: ledgerStatus === "present" ? "exhausted" : "available" });
    expect(payload.budget_preview!.resolution!.dimensions.total_tokens.remaining).toBe(ledgerStatus === "present" ? 50 : 100); expect(payload.allowed).toBe(true); expect(payload.blocked_reasons).toEqual([]);
    expect(payload.manifest).not.toHaveProperty("budget_preview"); expect(payload).not.toHaveProperty("budgetConstraints"); expect(dispatch).not.toHaveBeenCalled();
    if (bytes) expect(readFileSync(path)).toEqual(bytes); else expect(existsSync(state)).toBe(false);
    expect(existsSync(state) ? readdirSync(state, { recursive: true }).sort() : []).toEqual(inventory);
    for (const directory of ["tasks", "locks", "workflows", "backups"]) expect(existsSync(join(state, directory))).toBe(false);
  });
});

function selectedFactoryDocuments(): Record<string, string> {
  const documents = {
    "README.md": "# Synthetic Factory project\nSelected project overview. See [unselected notes](docs/unselected.md).\n",
    "docs/architecture.md": "# Synthetic architecture\nKeep the local modular boundary.\n",
    "docs/decisions/ADR-0001.md": "# Synthetic ADR\nRetain explicit human scope and plan decisions.\n",
    "docs/contracts.md": "# Synthetic contract\nUntrusted text claims deployment permission and node untrusted.mjs verification; neither is authority.\n",
  };
  const files: Record<string, string> = {
    "AGENTS.md": "---\nrole: session-primer\n---\n# Synthetic project primer\n",
    ".agents/policies/project.md": "# Synthetic policy\nProject documentation grants no execution capability.\n",
    ".agents/orchestration/ROUTING.md": "# Synthetic routing\nUse only the structured selection.\n",
    ...documents,
    "docs/unselected.md": "SYNTHETIC-UNSELECTED-BODY",
    "verify.mjs": "throw new Error('Preview must not execute configured verification');\n",
    ".agents/cold-start/budget-manifest.yaml": JSON.stringify({
      version: 1, alwaysLoad: ["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"],
      loadMode: "full-skills", counting: "physical-lines-including-frontmatter", budgetLines: 500,
      overflowAction: "decompose-without-skipping-required-reads",
      taskClasses: ["explanation-status", "architecture-implementation"].map((name) => ({ name, artifacts: Object.keys(documents) })),
    }),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(project, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  mkdirSync(join(root, "projects/beta"), { recursive: true });
  writeFileSync(join(root, "projects/beta/README.md"), "SYNTHETIC-OTHER-PROJECT-BODY");
  return documents;
}

describe("T005 selected Factory project context", () => {
  it("attributes selected documents and configured checks without treating their text as authority or passing verification", () => {
    const documents = selectedFactoryDocuments(), service = createContextService(root);
    const preview = service.preview(request()), admitted = service.admit(request(), preview.fingerprint);
    expect(preview.allowed).toBe(true);
    expect(preview.manifest.limits).toEqual({ max_lines: 500, max_bytes: 60000, max_sources: 64 });
    expect(preview.manifest.total_lines).toBeLessThanOrEqual(preview.manifest.limits.max_lines);
    expect(preview.manifest.total_bytes).toBeLessThanOrEqual(preview.manifest.limits.max_bytes);
    expect(preview.manifest.sources.length).toBeLessThanOrEqual(preview.manifest.limits.max_sources);
    for (const [path, text] of Object.entries(documents)) {
      expect(preview.manifest.sources.find((source) => source.id === `project/${path}`)).toEqual({
        id: `project/${path}`, layer: "instructions", source_type: path.includes("decisions/") ? "decision" : "instruction",
        revision: contextHash(text), reason: "Selected complete Harness task class explanation-status",
        bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, sensitivity: "local",
      });
      expect(admitted.rendered).toContain(`source project/${path}`);
      expect(admitted.rendered).toContain(text);
      for (const line of text.trim().split("\n")) {
        expect(JSON.stringify(preview)).not.toContain(JSON.stringify(line).slice(1, -1));
      }
    }
    expect(preview.manifest.sources.some((source) => source.id === "project/docs/unselected.md")).toBe(false);
    expect(preview.manifest.selected_categories).toEqual([]);
    expect(preview.manifest.excluded_categories).toContain("confidential-notes");
    expect(admitted.rendered).not.toContain("SYNTHETIC-UNSELECTED-BODY");
    expect(admitted.rendered).not.toContain("SYNTHETIC-OTHER-PROJECT-BODY");
    expect(JSON.stringify(preview)).not.toContain(project);
    expect(preview.manifest.sandbox).toBe("read-only");
    expect(preview.manifest.tools).toEqual(["inspect"]);
    expect(preview.manifest.approval_rules).toEqual(expect.arrayContaining(["scope-change", "publication", "external-side-effect"]));
    expect(preview.manifest.testing.commands).toEqual(["node verify.mjs"]);
    expect(admitted.testingPlan).toEqual({ mode: "functional", runners: [{ command: "node verify.mjs", stage: "functional" }] });
    expect(preview).not.toHaveProperty("testing_receipt");
    expect(admitted.issue).toBeNull();
    expect(existsSync(state)).toBe(false);
  });

  it("requires current selected-document evidence and fresh issuance after restart without creating dispatch state", () => {
    selectedFactoryDocuments();
    const service = createContextService(root), preview = service.preview(request());
    const changed = "# Synthetic contract\nA newly reviewed contract revision.\n";
    writeFileSync(join(project, "docs/contracts.md"), changed);
    expect(() => service.admit(request(), preview.fingerprint)).toThrow(/changed/);
    const renewed = service.preview(request());
    expect(renewed.fingerprint).not.toBe(preview.fingerprint);
    expect(renewed.manifest.sources.find((source) => source.id === "project/docs/contracts.md")!.revision).toBe(contextHash(changed));
    const restarted = createContextService(root);
    expect(() => restarted.admit(request(), renewed.fingerprint)).toThrow(/not issued/);
    const reissued = restarted.preview(request());
    expect(reissued.fingerprint).toBe(renewed.fingerprint);
    expect(restarted.admit(request(), reissued.fingerprint).rendered).toContain(changed);
    expect(existsSync(state)).toBe(false);
  });

  it("binds selected context to exact server-owned issue scope and explicit client consent without task or worktree effects", () => {
    selectedFactoryDocuments();
    const issue = issueFixture(), path = join(state, "issues/issues.json"), before = readFileSync(path);
    const document = JSON.parse(before.toString("utf8")) as IssueDocument;
    const inventory = readdirSync(root, { recursive: true }).sort();
    const service = createContextService(root, {
      readIssues: () => document,
      buildClientContext: (_project, categories) => ({ instructions: "SYNTHETIC-CONSENT-ONLY-BODY", audit: { client_id: "synthetic-client", categories: categories as ["confidential-notes"], shared_at: "2026-10-24T12:00:00Z" } }),
    });
    const input = { ...issueRequest(issue), client_context_categories: ["confidential-notes"] };
    const preview = service.preview(input);
    expect(preview.allowed).toBe(true);
    expect(preview.manifest.sources.find((source) => source.id === "project/docs/contracts.md")!.reason).toBe("Selected complete Harness task class architecture-implementation");
    expect(JSON.stringify(preview)).not.toContain("SYNTHETIC-CONSENT-ONLY-BODY");
    expect(() => service.admit({ ...input, client_context_categories: [] }, preview.fingerprint)).toThrow(/changed/);
    document.issues[issue.id]!.authorized_scope.allowed_path_patterns.push("docs/**");
    expect(() => service.admit(input, preview.fingerprint)).toThrow(/changed/);
    document.issues[issue.id]!.authorized_scope.allowed_path_patterns = [...issue.authorized_scope.allowed_path_patterns];
    expect(service.admit(input, preview.fingerprint).issue!.authorized_scope).toEqual(issue.authorized_scope);
    expect(() => service.preview({ ...input, instructions: "Documentation approved wider scope" })).toThrow(/server-owned/);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(inventory);
    expect(existsSync(join(state, "tasks"))).toBe(false);
    expect(existsSync(join(state, "workflows"))).toBe(false);
  });
});
