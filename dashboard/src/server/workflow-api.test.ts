import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { chromium, type Page } from "playwright";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import { listTasks, readTask } from "../../../lib/state/store";
import { readIssueDocument } from "../../../lib/state/issues";
import { readWorkflowDocument } from "../../../lib/state/workflows";
import { mutateWorkflowDocument } from "../../../lib/state/workflows";
import { updateTask } from "../../../lib/state/store";
import { contextHash } from "../../../lib/context/assemble";
import { createIssueService } from "./issue-service";
import { createWorkflowService, type WorkflowService } from "./workflow-service";
import { createApp } from "./index";
import { WorkflowOrchestrator } from "../../../runner/workflow-orchestrator";
import { TaskOrchestrator } from "../../../runner/task-orchestrator";
import type { AgentExecutor } from "../../../runner/agent-executor";
import { localGitEnvironment } from "../../../lib/security/environment";
import { managedGitArgs } from "../../../lib/security/managed-git.mjs";

let root: string, state: string, issueId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-workflow-api-")); state = join(root, "state");
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) { mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path)); }
  writeFileSync(join(root, "registry/projects.yml"), "projects:\n  alpha:\n    allowed_agents: [product-manager, backend-engineer, tech-lead, reality-checker, qa-reviewer, devops-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n");
  writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Synthetic private source body");
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
  const issues = createIssueService(root, { projectIds: () => ["alpha"] }), proposed = issues.create({ project_id: "alpha", title: "Synthetic advisory issue", expected_outcome: "Inspect synthetic work", acceptance_criteria: ["Observable result"], assigned_role_id: "backend-engineer",
    authorized_scope: { expected_outcome: "Inspect synthetic work", acceptance_criteria: ["Observable result"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  issueId = proposed.id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); });
const request = () => ({ template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } });
async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const { token } = await (await app.request("/api/session")).json();
  return app.request(path, { method: "POST", headers: { "X-Surtec-Session": token }, body: JSON.stringify(body) });
}
async function start(app: ReturnType<typeof createApp>, input: unknown = request()) {
  const response = await post(app, "/api/workflows/preview", input); expect(response.status).toBe(200); const preview = await response.json(); expect(preview.allowed).toBe(true);
  const result = await post(app, "/api/workflows/start", { request: input, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-human-root", confirm: true }); expect(result.status).toBe(201);
  return { input, preview, result: await result.json() };
}

describe("protected strict workflow API", () => {
  it("requires session/origin/fetch-site protection and bounded JSON before invoking service", async () => {
    const preview = vi.fn(), start = vi.fn(), decide = vi.fn(), cancel = vi.fn(), recover = vi.fn(), unsupported = vi.fn(), dispatch = vi.fn();
    const app = createApp(root, dispatch, undefined, undefined, { workflows: { preview, start, decide, cancel, recover, unsupported } as unknown as WorkflowService });
    const { token } = await (await app.request("/api/session")).json();
    for (const path of ["/api/workflows/preview", "/api/workflows/start", "/api/workflows/synthetic/decision", "/api/workflows/synthetic/cancel", "/api/workflows/synthetic/recover"]) {
      const headerCases: Record<string, string>[] = [{}, { "X-Surtec-Session": "stale" }, { "X-Surtec-Session": token, origin: "https://untrusted.invalid" }, { "X-Surtec-Session": token, "sec-fetch-site": "cross-site" }];
      for (const headers of headerCases) expect((await app.request(path, { method: "POST", headers, body: "{}" })).status).toBe(403);
      expect((await app.request(path, { method: "POST", headers: { "X-Surtec-Session": token }, body: "{" })).status).toBe(400);
      expect((await app.request(path, { method: "POST", headers: { "X-Surtec-Session": token }, body: JSON.stringify({ body: "x".repeat(33 * 1024) }) })).status).toBe(413);
    }
    for (const callback of [preview, start, decide, cancel, recover, unsupported, dispatch]) expect(callback).not.toHaveBeenCalled(); expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false);
  });
  it("preview/list/detail/start expose safe references, exact revisions and no execution callback", async () => {
    const dispatch = vi.fn(), app = createApp(root, dispatch);
    const empty = await app.request("/api/workflows"); expect(await empty.json()).toEqual({ workflows: [] }); expect(existsSync(join(state, "workflows"))).toBe(false);
    const started = await start(app), id = started.result.workflow.id;
    expect(started.result).toMatchObject({ execution_enabled: false, workflow: { status: "running", revision: 2 }, admission_intents: [{ status: "committed" }], stages: [{ status: "queued" }] });
    const detail = await app.request(`/api/workflows/${id}`); expect(detail.headers.get("Cache-Control")).toBe("no-store"); expect(await detail.json()).toEqual(started.result);
    const list = await app.request(`/api/workflows?issue_id=${issueId}`); expect(await list.json()).toEqual({ workflows: [started.result.workflow] });
    const encoded = JSON.stringify({ preview: started.preview, detail: started.result }); expect(encoded).not.toContain(root); expect(encoded).not.toContain("Synthetic private source body");
    expect(dispatch).not.toHaveBeenCalled(); expect(listTasks()).toHaveLength(1); expect(readIssueDocument().issues[issueId]!.status).toBe("proposed");
    const before = JSON.stringify(readWorkflowDocument());
    expect((await post(app, "/api/workflows/start", { request: started.input, preview_fingerprint: started.preview.fingerprint, approval_id: "duplicate", confirm: true })).status).toBe(409);
    expect(JSON.stringify(readWorkflowDocument())).toBe(before); expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(["grant", "context_manifest", "metadata", "path", "instructions", "task_id", "scope", "graph", "stages"])("denies caller %s injection with no persistent effects", async (key) => {
    const app = createApp(root), input = request();
    expect((await post(app, "/api/workflows/preview", { ...input, [key]: {} })).status).toBe(400);
    const preview = await (await post(app, "/api/workflows/preview", input)).json();
    expect((await post(app, "/api/workflows/start", { request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-human", [key]: {} })).status).toBe(400);
    expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false);
  });
  it("denies forged digest, changed consent, confirmation and stale issuance across restart", async () => {
    const app = createApp(root), input = request(), preview = await (await post(app, "/api/workflows/preview", input)).json();
    const payload = { request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-human" };
    expect((await post(app, "/api/workflows/start", { ...payload, preview_fingerprint: "a".repeat(64) })).status).toBe(409);
    expect((await post(app, "/api/workflows/start", { ...payload, request: { ...input, client_context_categories: { "portfolio-analyst": ["confidential-notes"] } } })).status).toBe(409);
    expect((await post(app, "/api/workflows/start", { ...payload, confirm: false })).status).toBe(400);
    const { token } = await (await app.request("/api/session")).json(), restarted = createApp(root);
    expect((await restarted.request("/api/workflows/start", { method: "POST", headers: { "X-Surtec-Session": token }, body: JSON.stringify(payload) })).status).toBe(403);
    expect((await post(restarted, "/api/workflows/start", payload)).status).toBe(409);
    expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false);
  });
  it.each(["project-instructions", "current-agent-policy", "issue-authority"] as const)("denies an issued root after %s drift with unchanged post-drift state and zero scheduling effects", async (changed) => {
    const notify = vi.fn(), cancelTask = vi.fn(), workflows = createWorkflowService(root, { execution: { available: () => true, notify, cancelTask } });
    const app = createApp(root, undefined, undefined, undefined, { workflows }), input = request();
    const previewResponse = await post(app, "/api/workflows/preview", input); expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json(); expect(preview.allowed).toBe(true); expect(preview.roles[0].manifest.selected_categories).toEqual([]);
    if (changed === "project-instructions") writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed synthetic instructions after preview");
    else if (changed === "current-agent-policy") {
      const policyPath = join(root, "registry/projects.yml"); writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("product-manager, ", ""));
    } else createIssueService(root).authorize(issueId, input.expected_revision, "synthetic-current-authority-human");
    const issueBytes = readFileSync(join(state, "issues/issues.json")), currentIssue = readIssueDocument().issues[issueId]!;
    const denied = await post(app, "/api/workflows/start", { request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-stale-root-human" });
    expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("Synthetic private source body");
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes); expect(readIssueDocument().issues[issueId]).toEqual(currentIssue);
    expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
    expect(notify).not.toHaveBeenCalled(); expect(cancelTask).not.toHaveBeenCalled();
  });
  it("records the exact pending plan through the protected decision route without issue edits or a writer", async () => {
    const issues = createIssueService(root), initial = readIssueDocument().issues[issueId]!; issues.authorize(issueId, initial.revision, "synthetic-scope-human");
    const dispatch = vi.fn(), app = createApp(root, dispatch), input = { ...request(), template_id: "implementation", selected_agents: { planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker" } };
    const { result } = await start(app, input), stageId = result.stages[0].id, taskId = result.stages[0].task_id, at = new Date().toISOString();
    updateTask(taskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = at; task.orchestration!.attempts = 1; });
    mutateWorkflowDocument((document) => {
      const workflow = document.workflows[result.workflow.id]!, stage = document.stages[stageId]!; workflow.revision++; workflow.updated_at = at;
      workflow.counters = { tasks: 1, attempts: 1, runtime_ms: 100, total_tokens: 50, accounting_complete: true }; stage.status = "running"; stage.execution_id = "synthetic-plan-run"; stage.updated_at = at;
      document.accounting["synthetic-plan-run"] = { schema_version: 1, id: "synthetic-plan-run", workflow_id: workflow.id, stage_id: stage.id, task_id: taskId, execution_id: stage.execution_id, attempt: 1, attempt_charged: true, active_runtime_ms: 100, observed_tokens: 50, usage_complete: true, captured_at: at };
    });
    mutateWorkflowDocument((document) => {
      const workflow = document.workflows[result.workflow.id]!, stage = document.stages[stageId]!; workflow.revision++; workflow.updated_at = at; workflow.status = "waiting-human"; workflow.pending_decision_id = "synthetic-plan-decision";
      stage.status = "completed"; stage.output = { schema_version: 1, kind: "plan", status: "completed", summary: "Synthetic exact plan", plan: ["Stay in current scope"], scope_change_required: false, evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Wait for human", requested_decision: "Approve plan" }; stage.output_fingerprint = contextHash(JSON.stringify(stage.output));
      document.decisions["synthetic-plan-decision"] = { schema_version: 1, id: "synthetic-plan-decision", workflow_id: workflow.id, kind: "plan-approval", status: "pending", expected_workflow_revision: workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision, resource_fingerprint: stage.output_fingerprint, candidate_id: null, review_receipt_ids: [], summary: "Approve current plan", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
    });
    const document = readWorkflowDocument(), workflow = document.workflows[result.workflow.id]!, decision = document.decisions["synthetic-plan-decision"]!;
    const body = { expected_revision: workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", confirm: true, approval_id: "synthetic-exact-plan-human", rationale: "Synthetic scoped approval" };
    const issueBytes = readFileSync(join(state, "issues/issues.json")), path = `/api/workflows/${workflow.id}/decision`;
    expect((await post(app, path, { ...body, scope: {} })).status).toBe(400); expect((await post(app, path, { ...body, resource_fingerprint: "a".repeat(64) })).status).toBe(409);
    const response = await post(app, path, body); expect(response.status).toBe(200); expect((await response.json()).workflow.approved_plan.decision_id).toBe(decision.id);
    expect((await post(app, path, body)).status).toBe(409); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes); expect(listTasks()).toHaveLength(1); expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects null per-role consent rather than silently treating it as confirmation", async () => {
    const app = createApp(root); expect((await post(app, "/api/workflows/preview", { ...request(), client_context_categories: { "portfolio-analyst": null } })).status).toBe(400); expect(listTasks()).toEqual([]);
  });
  it("unsupported/stale decisions, stop/recovery and unknown queries cannot mutate state", async () => {
    const app = createApp(root), { result } = await start(app), before = JSON.stringify(readWorkflowDocument());
    for (const action of ["cancel", "recover"]) expect((await post(app, `/api/workflows/${result.workflow.id}/${action}`, { expected_revision: result.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).status).toBe(409);
    expect((await post(app, `/api/workflows/${result.workflow.id}/decision`, { expected_revision: result.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision, decision_id: "forged-decision", resource_fingerprint: "a".repeat(64), decision: "approve", approval_id: "synthetic-human", rationale: "Synthetic", confirm: true })).status).toBe(409);
    for (const query of ["path=private", "issue_id=a&issue_id=b", "project_id=../private"]) expect((await app.request(`/api/workflows?${query}`)).status).toBe(400);
    expect((await app.request("/api/workflows/missing")).status).toBe(404); expect(JSON.stringify(readWorkflowDocument())).toBe(before); expect(listTasks()).toHaveLength(1);
  });
  it("the manual issue dispatch route cannot bypass workflow ownership", async () => {
    const dispatch = vi.fn(), app = createApp(root, dispatch); await start(app);
    const issue = readIssueDocument().issues[issueId]!, bytes = readFileSync(join(state, "issues/issues.json"));
    const response = await post(app, `/api/work-issues/${issueId}/dispatch`, { expected_revision: issue.revision, agent: "backend-engineer" });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: expect.stringContaining("active workflow") }); expect(dispatch).not.toHaveBeenCalled(); expect(listTasks()).toHaveLength(1); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(bytes);
  });
  it("does not reveal raw exceptions or corrupt-state bytes through error responses", async () => {
    const preview = vi.fn(() => { throw new Error("Synthetic private source C:\\private\\auth.json"); });
    const app = createApp(root, undefined, undefined, undefined, { workflows: { preview } as unknown as WorkflowService });
    const failed = await post(app, "/api/workflows/preview", request()); expect(failed.status).toBe(409); expect(await failed.text()).not.toContain("Synthetic private");
    mkdirSync(join(state, "workflows")); const bytes = '{"schema_version":99,"private":"Synthetic private body"}'; writeFileSync(join(state, "workflows/workflows.json"), bytes);
    const response = await createApp(root).request("/api/workflows"); expect(response.status).toBe(409); expect(await response.text()).not.toContain("Synthetic private"); expect(readFileSync(join(state, "workflows/workflows.json"), "utf8")).toBe(bytes);
  });
  it("reports retained admission failure without raw diagnostic leakage or scheduling", async () => {
    const dispatch = vi.fn(), workflows = createWorkflowService(root, { createTask: () => { throw new Error("Synthetic private source body"); } }), app = createApp(root, dispatch, undefined, undefined, { workflows });
    const input = request(), preview = await (await post(app, "/api/workflows/preview", input)).json();
    const response = await post(app, "/api/workflows/start", { request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-human" });
    expect(response.status).toBe(409); const failure = await response.json(); expect(failure.workflow_id).toMatch(/^WF-/); expect(JSON.stringify(failure)).not.toContain("Synthetic private");
    const detail = await (await app.request(`/api/workflows/${failure.workflow_id}`)).json(); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.admission_intents[0].status).toBe("reserved"); expect(dispatch).not.toHaveBeenCalled();
  });
  it("runs real loopback HTTP approval/restart and an explicitly selected local browser with zero executor calls", async () => {
    const dispatch = vi.fn(), app = createApp(root, dispatch), server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      if (!server.address()) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address() as AddressInfo, base = `http://127.0.0.1:${address.port}`;
      const input = request();
      let result;
      // Offline CI always exercises actual HTTP. Browser acceptance is run
      // explicitly below/alongside the existing local smoke, not installed by CI.
      if (process.env.SURTEC_WORKFLOW_BROWSER_SMOKE === "1") {
        try { browser = await chromium.launch({ headless: true }); }
        catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
        const page = await browser.newPage(); await page.goto(`${base}/api/session`);
        result = await page.evaluate(async (request) => {
          const { token } = await (await fetch("/api/session")).json();
          const post = async (path: string, value: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": token }, body: JSON.stringify(value) });
          const preview = await (await post("/api/workflows/preview", request)).json();
          const response = await post("/api/workflows/start", { request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-browser-human" });
          return { status: response.status, result: await response.json() };
        }, input);
        await page.reload(); expect(await page.evaluate(async (id: string) => (await fetch(`/api/workflows/${id}`)).json(), result.result.workflow.id)).toEqual(result.result);
      } else {
        const { token } = await (await fetch(`${base}/api/session`)).json();
        const headers = { "Content-Type": "application/json", "X-Surtec-Session": token };
        const preview = await (await fetch(`${base}/api/workflows/preview`, { method: "POST", headers, body: JSON.stringify(input) })).json();
        const response = await fetch(`${base}/api/workflows/start`, { method: "POST", headers, body: JSON.stringify({ request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-http-human" }) });
        result = { status: response.status, result: await response.json() };
        expect(await (await fetch(`${base}/api/workflows/${result.result.workflow.id}`)).json()).toEqual(result.result);
      }
      expect(result.status).toBe(201); expect(result.result.execution_enabled).toBe(false); expect(result.result.admission_intents[0].status).toBe("committed");
      // A fresh application instance reconstructs the same durable read model.
      const restarted = createApp(root, dispatch); expect(await (await restarted.request(`/api/workflows/${result.result.workflow.id}`)).json()).toEqual(result.result);
      expect(dispatch).not.toHaveBeenCalled(); expect(listTasks()).toHaveLength(1); expect(listTasks()[0]!.orchestration!.attempts).toBe(0);
    } finally { try { await browser?.close(); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } }
  }, 30_000);
  it.each(["implementation", "trivial-change"] as const)("seals %s and current quality review before exact human acceptance through the real API/browser", async (template) => {
    const repo = join(root, "projects/alpha");
    const git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" }).toString();
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "base\n"); writeFileSync(join(repo, "verify.mjs"), "process.exit(0)\n");
    git("add", "-A"); git("commit", "-m", "synthetic workflow base");
    const issues = createIssueService(root), proposed = issues.create({ project_id: "alpha", title: `Synthetic ${template} workflow`, expected_outcome: "Verify the bounded result",
      acceptance_criteria: ["Observable result", "No changes outside the approved path"], ...(template === "implementation" ? { criticality: "high" as const, classification_inputs: { requires_migration: true } } : {}),
      assigned_role_id: "backend-engineer", plan: ["Change the synthetic value", "Run its configured verification"], next_action: "Review the exact candidate",
      authorized_scope: { expected_outcome: "Verify the bounded result", acceptance_criteria: ["Observable result", "No changes outside the approved path"],
        allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: template === "implementation" ? ["implementation", "migration"] : ["documentation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-exact-scope-human");
    let workflowId = "";
    const usage = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 };
    const executor: AgentExecutor = { run: vi.fn(async (input) => {
      const owner = readWorkflowDocument().workflows[workflowId], stage = owner?.current_stage_id ? readWorkflowDocument().stages[owner.current_stage_id] : null;
      if (!stage) throw new Error("Synthetic executor received no current stage");
      const base = { schema_version: 1 as const, status: "completed" as const, summary: `Synthetic ${stage.kind} output`, evidence_ids: [], unresolved_questions: [], risks: [],
        recommended_next_action: "Wait for the next exact gate", requested_decision: null };
      let structuredOutput: unknown;
      if (stage.kind === "planning") structuredOutput = { ...base, kind: "plan", plan: ["Change only src/value.txt", "Run the configured verifier"], scope_change_required: false };
      else if (stage.kind === "implementation") {
        expect(input.cwd).not.toBe(repo); writeFileSync(join(input.cwd, "src/value.txt"), "verified candidate\n");
        expect(input.verifyCommands).toContain("node verify.mjs");
        structuredOutput = { status: "completed", summary: "Synthetic bounded implementation", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
      } else if (stage.kind === "review") {
        expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]);
        expect(input.cwd).not.toBe(repo); expect(readFileSync(join(input.cwd, "src/value.txt"), "utf8")).toBe("verified candidate\n");
        const issueFacts = readIssueDocument(), candidateId = owner!.candidate!.candidate_id;
        const verificationEvidence = issueFacts.issues[issue.id]!.evidence_ids.map((id) => issueFacts.evidence[id]!).find((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidateId);
        expect(verificationEvidence).toBeDefined();
        structuredOutput = { ...base, kind: "review", verdict: "approve", findings: [{ id: "synthetic-advisory", severity: "advisory", summary: "Confirm the retained operational window",
          path: null, evidence_ids: [verificationEvidence!.id], scope_change_required: false }] };
      } else if (stage.kind === "qa") {
        expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]);
        expect(input.cwd).not.toBe(repo); expect(readFileSync(join(input.cwd, "src/value.txt"), "utf8")).toBe("verified candidate\n");
        const issueFacts = readIssueDocument(), candidateId = owner!.candidate!.candidate_id;
        const verificationEvidence = issueFacts.issues[issue.id]!.evidence_ids.map((id) => issueFacts.evidence[id]!).find((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidateId);
        const diffEvidence = issueFacts.issues[issue.id]!.evidence_ids.map((id) => issueFacts.evidence[id]!).find((entry) => entry.kind === "diff" && entry.candidate_id === candidateId);
        expect(verificationEvidence).toBeDefined(); expect(diffEvidence).toBeDefined();
        structuredOutput = { ...base, kind: "qa", verdict: "approve", findings: [], criteria: issueFacts.issues[issue.id]!.acceptance_criteria.map((criterion, index) => ({ criterion, status: "supported",
          evidence_ids: [index === 0 ? verificationEvidence!.id : diffEvidence!.id] })) };
      } else throw new Error("Synthetic executor received an unsupported stage");
      return { finalText: "Never promote raw fallback", structuredOutput, threadId: `synthetic-${stage.kind}-thread`, turnId: `synthetic-${stage.kind}-turn`, usage };
    }) };
    let controller = new WorkflowOrchestrator(root), worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
    let server: ReturnType<typeof serve> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined, base = "";
    const pageErrors: string[] = [];
    const listen = async () => {
      const app = createApp(root, worker, undefined, undefined, { workflows: controller.service });
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      const httpServer = server as unknown as import("node:http").Server;
      httpServer.keepAliveTimeout = 120_000; httpServer.headersTimeout = 125_000;
      if (!server.address()) await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const closeServer = async () => { if (!server) return; const current = server; server = undefined;
      await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve())); expect(current.listening).toBe(false); };
    const get = async (path: string) => {
      if (page) return page.evaluate(async (path) => (await fetch(path)).json(), path);
      return (await (await fetch(`${base}${path}`)).json());
    };
    const post = async (path: string, body: unknown) => {
      if (page) return page.evaluate(async ({ path, body }) => {
        const { token } = await (await fetch("/api/session")).json();
        const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": token }, body: JSON.stringify(body) });
        return { status: response.status, result: await response.json() };
      }, { path, body });
      const { token } = await (await fetch(`${base}/api/session`)).json();
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": token }, body: JSON.stringify(body) });
      return { status: response.status, result: await response.json() };
    };
    try {
      await listen();
      if (process.env.SURTEC_WORKFLOW_BROWSER_SMOKE === "1") {
        try { browser = await chromium.launch({ headless: true }); }
        catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
        page = await browser.newPage(); page.on("pageerror", (error) => pageErrors.push(error.message)); await page.goto(`${base}/api/session`);
      }
      const input = { template_id: template, template_version: 1, project_id: "alpha", issue_id: issue.id, expected_revision: issue.revision,
        selected_agents: template === "implementation" ? { planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" }
          : { "software-engineer": "backend-engineer", reviewer: "reality-checker" } };
      const preview = await post("/api/workflows/preview", input);
      expect(preview.status).toBe(200); expect(preview.result.allowed).toBe(true); expect(preview.result.review_policy.qa_required).toBe(template === "implementation");
      expect(preview.result.plan.stages.map((stage: { kind: string }) => stage.kind)).toEqual(template === "implementation" ? ["planning", "implementation", "review", "qa"] : ["implementation", "review"]);
      expect(preview.result.review_policy.effective_depth).toMatch(/focused|full/); expect(executor.run).not.toHaveBeenCalled();
      const started = await post("/api/workflows/start", { request: input, preview_fingerprint: preview.result.fingerprint, confirm: true, approval_id: "synthetic-workflow-root-human" });
      expect(started.status).toBe(201); workflowId = started.result.workflow.id;
      let path = `/api/workflows/${workflowId}`;
      const runOne = async (kind: string) => {
        expect(await worker.runOnce()).toBe(1);
        const owner = readWorkflowDocument().workflows[workflowId]!, stage = readWorkflowDocument().stages[owner.current_stage_id!]!;
        expect(stage.kind).toBe(kind); const taskId = stage.task_id!;
        await vi.waitFor(() => expect(readTask(taskId)?.lifecycle).toBe("finished"), { timeout: 15_000 });
        controller.reconcile();
        if (page) await page.reload();
        return get(path);
      };
      let detail = started.result;
      if (template === "implementation") {
        detail = await runOne("planning");
        expect(detail.workflow.status).toBe("waiting-human"); expect(detail.decisions[0].kind).toBe("plan-approval");
        expect(await worker.runOnce()).toBe(0); expect(executor.run).toHaveBeenCalledOnce(); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
        const planDecision = detail.decisions[0];
        const planApproval = await post(path + "/decision", { expected_revision: detail.workflow.revision, expected_issue_revision: planDecision.expected_issue_revision,
          decision_id: planDecision.id, resource_fingerprint: planDecision.resource_fingerprint, decision: "approve", confirm: true,
          approval_id: "synthetic-planner-approval", rationale: "Approved exact bounded plan" });
        expect(planApproval.status).toBe(200); expect(planApproval.result.workflow.approved_plan.stage_id).toBe(detail.stages[0].id);
        if (page) await page.reload(); expect((await get(path)).workflow.status).toBe("running");
      }

      detail = await runOne("implementation");
      expect(detail.workflow.status, detail.workflow.blocked_reason ?? undefined).toBe("running");
      expect(detail.workflow.candidate.candidate_id).toBeTruthy(); expect(detail.review_receipts).toEqual([]);
      expect(readIssueDocument().issues[issue.id]!.status).toBe("checking");
      expect(detail.handoffs.map((entry: { from_role_id: string; to_role_id: string }) => [entry.from_role_id, entry.to_role_id])).toContainEqual(["software-engineer", "reviewer"]);
      expect(detail.lineage.candidate_ids).toContain(detail.workflow.candidate.candidate_id); expect(detail.lineage.corrections_consumed).toBe(0);

      detail = await runOne("review");
      expect(detail.review_receipts.map((entry: { role_id: string }) => entry.role_id)).toEqual(["reviewer"]);
      if (template === "trivial-change") {
        expect(detail.workflow.status).toBe("waiting-human"); expect(detail.decisions.at(-1).kind).toBe("risk-acknowledgement");
        expect(detail.stages.some((stage: { kind: string }) => stage.kind === "planning")).toBe(false);
        expect(readIssueDocument().issues[issue.id]!.status).toBe("ready-for-review"); expect(executor.run).toHaveBeenCalledTimes(2);
        const candidateId = detail.workflow.candidate.candidate_id, issueBeforeStop = readIssueDocument();
        const stopped = await post(path + "/cancel", { expected_revision: detail.workflow.revision, expected_issue_revision: issueBeforeStop.issues[issue.id]!.revision });
        expect(stopped.status).toBe(200); controller.reconcile(); expect((await get(path)).workflow.status).toBe("cancelled");
        expect(readIssueDocument()).toEqual(issueBeforeStop); expect(await worker.runOnce()).toBe(0);
        const quality = { template_id: "quality-review", template_version: 1, project_id: "alpha", issue_id: issue.id, expected_revision: issueBeforeStop.issues[issue.id]!.revision,
          candidate_id: candidateId, selected_agents: { reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" } };
        const qualityPreview = await post("/api/workflows/preview", quality);
        expect(qualityPreview.status).toBe(200); expect(qualityPreview.result.allowed).toBe(true); expect(qualityPreview.result.candidate.candidate_id).toBe(candidateId);
        expect(qualityPreview.result.plan.stages.map((stage: { kind: string }) => stage.kind)).toEqual(["review", "qa"]);
        expect(qualityPreview.result.correction).toMatchObject({ enabled: false, max_corrections: 0 }); expect(executor.run).toHaveBeenCalledTimes(2);
        const qualityStart = await post("/api/workflows/start", { request: quality, preview_fingerprint: qualityPreview.result.fingerprint, confirm: true, approval_id: "synthetic-quality-root-human" });
        expect(qualityStart.status).toBe(201); workflowId = qualityStart.result.workflow.id; path = `/api/workflows/${workflowId}`;
        expect(readIssueDocument().issues[issue.id]!.status).toBe("ready-for-review"); detail = await runOne("review");
        expect(detail.review_receipts).toHaveLength(1); expect(detail.review_receipts[0].candidate.candidate_id).toBe(candidateId);
        expect(readIssueDocument().issues[issue.id]!.status).toBe("ready-for-review");
      } else expect(readIssueDocument().issues[issue.id]!.status).toBe("checking");
      expect(detail.workflow.status).toBe("running"); expect(detail.stages.at(-1).kind).toBe("qa");

      detail = await runOne("qa");
      expect(detail.workflow.status).toBe("waiting-human"); expect(detail.decisions.at(-1).kind).toBe("risk-acknowledgement");
      expect(detail.review_receipts.map((entry: { role_id: string }) => entry.role_id)).toEqual(["reviewer", "qa-evaluator"]);
      expect(readIssueDocument().issues[issue.id]!.status).toBe("ready-for-review");
      const readyBeforeBypass = readIssueDocument(), readyCandidate = detail.workflow.candidate;
      const directAcceptance = await post(`/api/work-issues/${issue.id}/accept`, { expected_revision: readyBeforeBypass.issues[issue.id]!.revision,
        candidate_id: readyCandidate.candidate_id, fingerprint: readyCandidate.diff_fingerprint, approval_id: "synthetic-direct-bypass",
        rationale: "This legacy route must not bypass governed review decisions", confirmed_criteria: readyBeforeBypass.issues[issue.id]!.acceptance_criteria });
      expect(directAcceptance.status).toBe(409); expect(directAcceptance.result.error).toContain("explicit workflow candidate decision");
      expect(readIssueDocument()).toEqual(readyBeforeBypass);
      const risk = detail.decisions.at(-1);
      const acknowledged = await post(path + "/decision", { expected_revision: detail.workflow.revision, expected_issue_revision: risk.expected_issue_revision,
        decision_id: risk.id, resource_fingerprint: risk.resource_fingerprint, decision: "approve", confirm: true,
        approval_id: "synthetic-advisory-human-ack", rationale: "The exact candidate-bound advisory risk was reviewed" });
      expect(acknowledged.status).toBe(200); expect(acknowledged.result.workflow.status).toBe("running");
      controller.reconcile(); if (page) await page.reload(); detail = await get(path);
      expect(detail.workflow.status).toBe("waiting-human"); expect(detail.decisions.at(-1).kind).toBe("candidate-acceptance");
      const acceptance = detail.decisions.at(-1), readyIssue = readIssueDocument().issues[issue.id]!;
      const acceptanceBody = { expected_revision: detail.workflow.revision, expected_issue_revision: acceptance.expected_issue_revision,
        decision_id: acceptance.id, resource_fingerprint: acceptance.resource_fingerprint, decision: "approve", confirm: true,
        approval_id: "synthetic-final-human-acceptance", rationale: "Every current criterion was confirmed", confirmed_criteria: readyIssue.acceptance_criteria };
      const beforeDenied = { issues: readFileSync(join(state, "issues/issues.json")), workflows: readFileSync(join(state, "workflows/workflows.json")), tasks: listTasks() };
      for (const invalid of [{ ...acceptanceBody, expected_revision: detail.workflow.revision - 1 }, { ...acceptanceBody, resource_fingerprint: "a".repeat(64) },
        { ...acceptanceBody, confirm: false }, { ...acceptanceBody, confirmed_criteria: readyIssue.acceptance_criteria.slice(0, 1) }]) {
        expect((await post(path + "/decision", invalid)).status).toBe(invalid.confirm === false ? 400 : 409);
      }
      const candidateTask = readTask(detail.workflow.candidate.task_id)!, candidateTree = (candidateTask.envelope.metadata.run as { worktree_path: string }).worktree_path;
      writeFileSync(join(candidateTree, "src/value.txt"), "Changed after sealed read-only reviews\n");
      expect((await post(path + "/decision", acceptanceBody)).status).toBe(409);
      expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeDenied.issues); expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(beforeDenied.workflows);
      expect(listTasks()).toEqual(beforeDenied.tasks); expect(executor.run).toHaveBeenCalledTimes(4);
      writeFileSync(join(candidateTree, "src/value.txt"), "verified candidate\n");
      const accepted = await post(path + "/decision", acceptanceBody);
      expect(accepted.status).toBe(200); expect(accepted.result.workflow.status).toBe("completed");
      expect(readIssueDocument().issues[issue.id]!.status).toBe("done"); expect(accepted.result.workflow.next_action).toContain("publication remains separately authorized");
      expect(executor.run).toHaveBeenCalledTimes(4); expect(pageErrors).toEqual([]);
      if (page) { await page.reload(); expect(await get(path)).toEqual(accepted.result); }

      await worker.stop(); await closeServer(); controller = new WorkflowOrchestrator(root); worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 }); await listen();
      if (page) await page.goto(`${base}/api/session`);
      expect(await get(path)).toEqual(accepted.result); expect(await worker.runOnce()).toBe(0); expect(executor.run).toHaveBeenCalledTimes(4);
      expect(listTasks()).toHaveLength(4); expect(listTasks().every((task) => task.lifecycle === "finished" && task.outcome === "completed")).toBe(true);
      expect(git("rev-parse", "HEAD").trim()).toBe(detail.workflow.candidate.base_revision); expect(git("remote").trim()).toBe("");
    } finally {
      try { await worker.stop(); } finally { try { await browser?.close(); if (browser) expect(browser.isConnected()).toBe(false); } finally { await closeServer(); } }
    }
  }, 90_000);
  it.each(["analysis", "planner-analysis", "operations-investigation"] as const)("runs %s through real HTTP/browser, current human gate and fresh-server recovery without replay", async (template) => {
    const executor: AgentExecutor = { run: vi.fn(async (input) => {
      expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]); expect(input.threadId).toBeUndefined();
      return { finalText: "Never promote raw fallback", threadId: "synthetic-thread", turnId: "synthetic-turn",
      structuredOutput: { schema_version: 1, status: "completed", summary: "Synthetic bounded proposal", evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Wait for human", requested_decision: null,
        ...(template === "operations-investigation" ? { kind: "operations", proposed_issue: { title: "Synthetic operations proposal", expected_outcome: "Inspect the proposed service action", acceptance_criteria: ["Inspect synthetic evidence"], plan: ["Inspect before changing"], allowed_path_patterns: ["src/**"], next_action: "Wait for explicit human scope approval" } }
          : { kind: "analysis", recommendations: ["Inspect the proposal"] }) },
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } }; }) };
    let controller = new WorkflowOrchestrator(root), worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
    let server: ReturnType<typeof serve> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined, base = "";
    const pageErrors: string[] = [];
    const listen = async () => {
      const app = createApp(root, worker, undefined, undefined, { workflows: controller.service });
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      if (!server.address()) await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const closeServer = async () => { if (server) { const current = server; server = undefined; await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve())); expect(current.listening).toBe(false); } };
    const get = async (path: string) => page ? page.evaluate(async (path) => (await fetch(path)).json(), path) : (await fetch(`${base}${path}`)).json();
    const remotePost = async (path: string, body: unknown) => {
      if (page) return page.evaluate(async ({ path, body }) => {
        const { token } = await (await fetch("/api/session")).json();
        const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": token }, body: JSON.stringify(body) });
        return { status: response.status, result: await response.json() };
      }, { path, body });
      const { token } = await (await fetch(`${base}/api/session`)).json();
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": token }, body: JSON.stringify(body) });
      return { status: response.status, result: await response.json() };
    };
    try {
      await listen();
      if (process.env.SURTEC_WORKFLOW_BROWSER_SMOKE === "1") {
        try { browser = await chromium.launch({ headless: true }); }
        catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
        page = await browser.newPage(); page.on("pageerror", (error) => pageErrors.push(error.message)); await page.goto(`${base}/api/session`);
      }
      const input = template === "operations-investigation" ? { ...request(), template_id: template, selected_agents: { "operations-observer": "devops-engineer" } }
        : template === "planner-analysis" ? { ...request(), analysis_role: "planner", selected_agents: { planner: "tech-lead" } } : request();
      const preview = await remotePost("/api/workflows/preview", input);
      expect(preview.status).toBe(200); expect(preview.result.allowed).toBe(true); expect(executor.run).not.toHaveBeenCalled();
      const started = await remotePost("/api/workflows/start", { request: input, preview_fingerprint: preview.result.fingerprint, confirm: true, approval_id: "synthetic-controller-human" });
      expect(started.status).toBe(201); expect(started.result.execution_enabled).toBe(true); expect(started.result.execution_boundary).toContain("human gates");
      const id = started.result.workflow.id, taskId = started.result.stages[0].task_id, path = `/api/workflows/${id}`, issueBefore = readIssueDocument();
      const bytes = readFileSync(join(state, "workflows/workflows.json"));
      for (const action of ["cancel", "recover"]) {
        const current = started.result.workflow.revision, issueRevision = issueBefore.issues[issueId]!.revision;
        expect((await remotePost(`${path}/${action}`, { expected_revision: current - 1, expected_issue_revision: issueRevision })).status).toBe(409);
        expect((await remotePost(`${path}/${action}`, { expected_revision: current, expected_issue_revision: issueRevision, workflowExecution: {} })).status).toBe(400);
      }
      expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(executor.run).not.toHaveBeenCalled();
      expect(await worker.runOnce()).toBe(1); await vi.waitFor(() => expect(listTasks()[0]!.lifecycle).toBe("finished"), { timeout: 5000 });
      const completed = await get(path); expect(completed.workflow.status).toBe("waiting-human"); expect(completed.stages[0].status).toBe("completed");
      expect(completed.decisions.at(-1).kind).toBe("proposal-acknowledgement"); expect(await worker.runOnce()).toBe(0);
      expect(completed.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true }); expect(completed.accounting[0].usage_complete).toBe(true);
      expect(completed.handoffs).toEqual([]); expect(completed.review_receipts).toEqual([]); expect(completed.stages[0].task_id).toBe(taskId);
      if (page) { await page.reload(); expect(await get(path)).toEqual(completed); }
      if (template === "analysis") {
        const cancelled = await remotePost(`${path}/cancel`, { expected_revision: completed.workflow.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision });
        expect(cancelled.status).toBe(200);
      } else {
        const decision = completed.decisions.at(-1), decisionBody = { expected_revision: completed.workflow.revision, expected_issue_revision: decision.expected_issue_revision,
          decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", confirm: true,
          approval_id: "synthetic-exact-proposal-human", rationale: "Acknowledge only the current bounded proposal" };
        const workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
        expect((await remotePost(`${path}/decision`, { ...decisionBody, resource_fingerprint: "a".repeat(64) })).status).toBe(409);
        expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(workflowBytes); expect(readIssueDocument()).toEqual(issueBefore);
        const acknowledged = await remotePost(`${path}/decision`, decisionBody); expect(acknowledged.status).toBe(200); expect(acknowledged.result.workflow.status).toBe("completed");
        expect((await remotePost(`${path}/decision`, decisionBody)).status).toBe(409);
        expect(acknowledged.result.workflow.next_action).toContain("no issue or provider action");
      }
      controller.reconcile(); const stopped = await get(path); expect(stopped.workflow.status).toBe(template === "analysis" ? "cancelled" : "completed");
      expect(stopped.workflow.counters).toEqual(completed.workflow.counters); expect(readIssueDocument()).toEqual(issueBefore);
      expect(Object.keys(readIssueDocument().issues)).toEqual([issueId]); expect(readIssueDocument().issues[issueId]!.status).toBe("proposed");
      const { token: oldToken } = await (await fetch(`${base}/api/session`)).json();
      await worker.stop(); await closeServer(); controller = new WorkflowOrchestrator(root); worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 }); await listen();
      if (page) await page.goto(`${base}/api/session`);
      expect(await get(path)).toEqual(stopped); expect(await worker.runOnce()).toBe(0); expect(await get(path)).toEqual(stopped);
      const stale = await fetch(`${base}${path}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "X-Surtec-Session": oldToken }, body: JSON.stringify({ expected_revision: stopped.workflow.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision }) });
      expect(stale.status).toBe(403); expect(pageErrors).toEqual([]); expect(executor.run).toHaveBeenCalledOnce(); expect(listTasks()).toHaveLength(1);
      expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
    } finally {
      try { await worker.stop(); } finally { try { await browser?.close(); if (browser) expect(browser.isConnected()).toBe(false); } finally { await closeServer(); } }
    }
  }, 30_000);
});
