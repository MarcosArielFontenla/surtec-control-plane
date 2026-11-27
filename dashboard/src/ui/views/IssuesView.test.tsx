// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { IssuesView } from "./IssuesView";
import * as api from "../api";
import type { Inbox } from "../../../../lib/state/types";
import type { DeliveryObservation, IssueCreateInput, IssueLineage, WorkIssue } from "../../../../lib/issues/types";
import { BUDGET_DIMENSIONS, type BudgetAmounts } from "../../../../lib/budgets/types";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [] });
  vi.spyOn(api, "fetchDispatchOptions").mockResolvedValue({ projects: [] });
  vi.spyOn(api, "getOrganization").mockResolvedValue({ company: {} as never, objectives: [], project_objectives: {} });
  vi.spyOn(api, "getContextRoles").mockResolvedValue({ roles: [] });
  vi.spyOn(api, "getClientContextOptions").mockResolvedValue({ available: false, categories: [] });
  vi.spyOn(api, "getWorkflows").mockResolvedValue({ workflows: [] });
  vi.spyOn(api, "fetchBudgets").mockResolvedValue(projectBudget());
});

const inbox: Inbox = {
  items: [
    { number: 2, title: "beta issue", url: "https://gh/beta/2", updatedAt: "2026-05-20T00:00:00Z", labels: ["bug"], author: "b", projectId: "beta", slug: "owner/beta" },
    { number: 1, title: "alpha issue", url: "https://gh/alpha/1", updatedAt: "2026-05-01T00:00:00Z", labels: [], author: "a", projectId: "alpha", slug: "owner/alpha" },
  ],
  repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: true }],
};

function projectBudget(sourceId = "issue-project-policy"): api.BudgetReadView {
  return { schema_version: 1, observed_at: "2026-10-11T12:00:00.000Z", status: "unavailable", executable: false, reserves_capacity: false,
    ledger: { status: "unavailable", revision: null, updated_at: null }, policy: { revision: 2, fingerprint: "e".repeat(64) },
    sources: [{ id: sourceId, kind: "policy", scope: { kind: "project", id: "alpha" }, revision: 2, fingerprint: "e".repeat(64), period: "none", bucket: "none",
      dimensions: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: dimension === "attempts" ? "configured" : "unconfigured",
        cap: dimension === "attempts" ? 10 : null, proven_consumed: null, consumed: null, reserved: null, remaining: null, warning: null }])) as api.BudgetReadView["sources"][number]["dimensions"] }],
    pricing: { status: "unavailable", reason: "no-versioned-source" },
    denials: [{ code: "budget-accounting-unavailable", dimension: "attempts", source_ids: [sourceId] }] };
}

function reviewedFixture(): IssueLineage {
  const issue: WorkIssue = {
    schema_version: 1, id: "I-review", project_id: "alpha", objective_id: null, parent_issue_id: null,
    title: "Review fixture", expected_outcome: "Persist the fixture", acceptance_criteria: ["The fixture persists"],
    status: "ready-for-review", work_scale: "trivial", classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false }, classification_rationale: ["narrow"], plan: [],
    authorized_scope: { expected_outcome: "Persist the fixture", acceptance_criteria: ["The fixture persists"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] },
    scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null,
    priority: 50, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null,
    task_ids: ["T-review"], evidence_ids: [], candidate_ids: ["C-review"], created_at: "2026-09-29T12:00:00Z", updated_at: "2026-09-29T12:00:00Z", revision: 4,
  };
  return {
    issue, tasks: [], sessions: [], evidence: [], evidence_gaps: ["Human acceptance evidence is missing for the current candidate."],
    candidates: [{ schema_version: 1, id: "C-review", issue_id: issue.id, task_id: "T-review", execution_id: "run-review", repository_id: "alpha", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64), changed_paths: ["src/fixture.ts"], scope_revision: 1, created_at: issue.created_at, invalidated_at: null }],
  };
}

function deliveryFixture(): IssueLineage {
  const issueId = "I-11111111-1111-4111-8111-111111111111", evidenceId = "E-22222222-2222-4222-8222-222222222222";
  const fixture = reviewedFixture();
  fixture.issue = { ...fixture.issue, id: issueId, task_ids: [], candidate_ids: [], evidence_ids: [evidenceId] };
  fixture.candidates = [];
  fixture.evidence = [{ schema_version: 1, id: evidenceId, issue_id: issueId, task_id: null, execution_id: null,
    candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: 1, kind: "work-product", status: "informational",
    label: "Operator delivery observation", reference: `/api/work-issues/${issueId}`, created_at: "2026-09-29T13:00:00Z",
    delivery_observation: { schema_version: 1, kind: "follow-up-recorded", origin: "operator-entered", commitment_id: null,
      occurred_at: "2026-09-29T12:00:00Z", summary: "PRIVATE_DELIVERY_FOLLOW_UP_CANARY", source_reference: "follow-up-fixture",
      next_action: "PRIVATE_DELIVERY_NEXT_ACTION_CANARY" } }];
  return fixture;
}

function authorizedFixture() {
  const issue = { ...reviewedFixture().issue, status: "authorized" as const, revision: 3, assigned_role_id: "backend-engineer", task_ids: [], candidate_ids: [] };
  vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
  vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [issue] });
  vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [{ project: "alpha", allowed_agents: ["backend-engineer", "tech-lead"], project_sandbox_ceiling: "workspace-write", has_local_checkout: true, has_verification_commands: true,
    agents: ["backend-engineer", "tech-lead"].map((agent) => ({ agent, agent_sandbox_ceiling: "workspace-write", allowed_modes: ["workspace-write"], default_mode: "workspace-write", modes: [] })) }] });
  vi.mocked(api.getContextRoles).mockResolvedValue({ roles: [
    { id: "reviewer", display_name: "Reviewer (Codex profile)", responsibility: "Read-only", sandbox_ceiling: "read-only", agents: ["backend-engineer"] },
    { id: "software-engineer", display_name: "Software Engineer (Codex profile)", responsibility: "Scoped implementation", sandbox_ceiling: "workspace-write", agents: ["backend-engineer", "tech-lead"] },
  ] });
  vi.mocked(api.getClientContextOptions).mockResolvedValue({ available: true, categories: ["confidential-notes"] });
  const preview: api.ContextPreview = { schema_version: 1, fingerprint: "a".repeat(64), allowed: true, blocked_reasons: [], runtime_read_limitation: "Runtime reads remain bounded by existing sandbox, not project-only.", manifest: {
    schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "software-engineer", agent_id: "backend-engineer", task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope", "verify-configured"], approval_rules: ["publication"],
    budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "focused", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: [], requires_red_evidence: false },
  } };
  const requestPreview = vi.spyOn(api, "previewContext").mockResolvedValue(preview);
  const dispatch = vi.spyOn(api, "dispatchWorkIssue").mockResolvedValue({ issue: { ...issue, status: "working", revision: 4 }, task_id: "T-1" });
  return { issue, preview, requestPreview, dispatch };
}

describe("IssuesView", () => {
  it.skipIf(process.env.SURTEC_ISSUE_OPERATING_BROWSER_SMOKE !== "1")("validates T005 with actual isolated API/Vite/browser, protected decisions, candidate refusal, mobile and restart", async () => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
    const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path"), { spawn, execFileSync } = await import("node:child_process");
    const { createServer: probeServer } = await import("node:net");
    const { createServer } = await import("vite"), { chromium } = await import("playwright");
    const { cleanupSmoke, observeResponse } = await import("../../../../scripts/playwright-local-app-smoke");
    const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(root, "runtime");
    let browser: Browser | null = null, vite: ViteDevServer | null = null, child: ChildProcess | null = null, exited = Promise.resolve();
    let output = "", stage = "setup";
    const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
    async function startApi(): Promise<string> {
      output = "";
      child = spawn(process.execPath, ["--import", "tsx", "issue-operating-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
      exited = new Promise<void>((done) => { child!.once("exit", () => done()); child!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_ISSUE_OPERATING_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
        if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`);
        await delay(200);
      }
      throw new Error(`Synthetic API readiness failed at ${stage}: ${output}`);
    }
    async function stopApi() {
      if (!child || child.exitCode !== null) return true;
      // Use an owned IPC stop so Windows does not terminate a worker while it
      // holds a file-first boundary. The same existing deadlines still apply.
      if (child.connected) child.send("stop"); else child.kill("SIGTERM");
      if (await Promise.race([exited.then(() => true), delay(8000).then(() => false)])) return true;
      child.kill("SIGKILL"); return Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    }
    async function startUi(apiUrl: string) {
      const probe = probeServer();
      await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen(); return vite.resolvedUrls!.local[0]!;
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects/alpha"), { recursive: true }); await mkdir(join(root, "empty-hooks"));
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) await cp(join(repoRoot, "registry", name), join(root, "registry", name));
      await cp(join(repoRoot, "evals"), join(root, "evals"), { recursive: true });
      await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha:\n    allowed_agents: [product-manager, backend-engineer, tech-lead, reality-checker, qa-reviewer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n");
      await writeFile(join(root, "projects/alpha/AGENTS.md"), "SYNTHETIC_PRIVATE_SOURCE_BODY_MUST_NOT_RENDER\n");
      const git = (args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, ...args], { cwd: join(root, "projects/alpha"), env: environment, windowsHide: true, stdio: "pipe" });
      git(["init", "--quiet"]); git(["config", "user.name", "Synthetic UI Fixture"]); git(["config", "user.email", "fixture@example.invalid"]); git(["add", "AGENTS.md"]); git(["commit", "--quiet", "-m", "Synthetic fixture"]);
      await writeFile(join(runtime, "issue-operating-api.ts"), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './dashboard/src/server/index';
import { createIssueService } from './dashboard/src/server/issue-service';
import { mutateIssueDocument } from './lib/state/issues';
import { WorkflowOrchestrator } from './runner/workflow-orchestrator';
import { TaskOrchestrator } from './runner/task-orchestrator';
const root = process.env.SURTEC_FIXTURE_ROOT!, effects = join(root, 'synthetic-effects.json');
if (existsSync(process.env.SURTEC_CODEX_BIN!)) throw new Error('Paid runtime entry must not exist');
const issues = createIssueService(root, { projectIds: () => ['alpha'] });
if (!issues.list().length) {
  const input = { project_id: 'alpha', title: 'Q analysis fixture', expected_outcome: 'Inspect bounded evidence', acceptance_criteria: ['Evidence retained'], assigned_role_id: 'backend-engineer', authorized_scope: { expected_outcome: 'Inspect bounded evidence', acceptance_criteria: ['Evidence retained'], allowed_path_patterns: ['src/**'], excluded_path_patterns: ['secrets/**'], allowed_change_categories: ['ui'], explicit_exclusions: ['No deployment'] } };
  issues.create(input);
  const review = issues.create({ ...input, title: 'Q exact candidate fixture' });
  const decision = issues.create({ ...input, title: 'Q scope decision fixture' });
  mutateIssueDocument(doc => {
    const item = doc.issues[review.id]!, id = 'C-' + randomUUID(), evidenceId = 'E-' + randomUUID();
    item.status = 'ready-for-review'; item.task_ids = ['T-recorded-only']; item.candidate_ids = [id]; item.evidence_ids = [evidenceId];
    doc.candidates[id] = { schema_version: 1, id, issue_id: item.id, task_id: 'T-recorded-only', execution_id: 'run-recorded-only', repository_id: 'alpha', base_revision: 'a'.repeat(40), candidate_revision: 'b'.repeat(40), diff_fingerprint: 'c'.repeat(64), changed_paths: ['src/fixture.ts'], scope_revision: item.scope_revision, created_at: item.updated_at, invalidated_at: null };
    doc.evidence[evidenceId] = { schema_version: 1, id: evidenceId, issue_id: item.id, task_id: 'T-recorded-only', execution_id: 'run-recorded-only', candidate_id: id, candidate_revision: 'b'.repeat(40), diff_fingerprint: 'c'.repeat(64), scope_revision: item.scope_revision, kind: 'verification', label: 'Recorded infrastructure check', reference: '/api/tasks/T-recorded-only', status: 'passed', created_at: item.updated_at };
    const pending = doc.issues[decision.id]!; pending.status = 'needs-decision'; pending.next_action = 'Inspect the recorded scope proposal';
    pending.scope_change_proposal = { id: 'scope-proposal-public', discovered_paths: ['src/outside.ts'], proposed_scope: pending.authorized_scope, discovered_at: pending.updated_at, evidence_task_id: 'T-recorded-only' };
  });
}
const workflows = new WorkflowOrchestrator(root);
const executor = { async run(options: { mode: string }) {
  if (options.mode !== 'read-only') throw new Error('UI fixture forbids writer/model effects');
  const count = existsSync(effects) ? Number(readFileSync(effects, 'utf8')) : 0; writeFileSync(effects, String(count + 1));
  const structuredOutput = { schema_version: 1, kind: 'analysis', status: 'completed', summary: 'Synthetic public analysis', evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: 'Inspect the bounded proposal', requested_decision: null, recommendations: ['Keep acceptance explicit'] };
  return { structuredOutput, finalText: JSON.stringify(structuredOutput), threadId: 'synthetic-ui-thread', turnId: 'synthetic-ui-turn', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } };
} };
const worker = new TaskOrchestrator({ repoRoot: root, executor, workflows, pollMs: 50 }); worker.start();
const app = createApp(root, worker, undefined, undefined, { issues, workflows: workflows.service, inbox: async () => ({ items: [], repos: [] }) });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_ISSUE_OPERATING_READY:' + (server.address() as { port: number }).port));
let stopping = false;
function stop() { if (stopping) return; stopping = true; void worker.stop().then(() => server.close(() => process.exit(0))); }
process.on('message', message => { if (message === 'stop') stop(); });
process.once('SIGTERM', stop);
`);
      stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(10000);
      const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], mutations: string[] = [];
      const failedResponses: Promise<string>[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("response", response => { if (response.status() >= 400) {
        const label = `${response.status()} ${new URL(response.url()).pathname}`; httpErrors.push(label);
        failedResponses.push(response.json().then(body => `${label}: ${String(body.error ?? "no error field").slice(0, 500)}`).catch(() => `${label}: response body unavailable`));
      } });
      page.on("request", request => { if (request.method() !== "GET") mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
      await page.goto(uiUrl); await page.getByRole("button", { name: /Issues/ }).click();
      const card = page.locator("article.work-issue-card").filter({ hasText: "Q analysis fixture" });
      const review = page.locator("article.work-issue-card").filter({ hasText: "Q exact candidate fixture" });
      const decision = page.locator("article.work-issue-card").filter({ hasText: "Q scope decision fixture" });
      await decision.getByRole("region", { name: "Decisión actual de Q scope decision fixture" }).getByText(/Disparador registrado: cambio de scope/).waitFor();
      expect(mutations).toEqual([]); expect(existsSync(join(root, "synthetic-effects.json"))).toBe(false);
      stage = "exact recorded candidate and protected refusal";
      await review.getByRole("button", { name: "Revisar candidato" }).click();
      await review.getByText(/Candidato registrado para el scope actual/).waitFor();
      expect(await review.getByText(/Vigencia Git no comprobada/).count()).toBe(1);
      expect(await review.getByRole("button", { name: "Aceptar este candidato local" }).isDisabled()).toBe(true);
      await review.getByRole("checkbox", { name: "Evidence retained" }).check();
      // The synthetic record is not an executed Git candidate: real acceptance must refuse it.
      const issueId = (await (await fetch(`${apiUrl}/api/work-issues`)).json()).issues.find((item: WorkIssue) => item.title === "Q exact candidate fixture").id as string;
      const beforeRefusal = await readFile(join(root, "state/issues/issues.json"), "utf8");
      const refused = await observeResponse(page, `/api/work-issues/${issueId}/accept`, "POST", () => review.getByRole("button", { name: "Aceptar este candidato local" }).click());
      expect(refused.status()).toBe(409); expect(await readFile(join(root, "state/issues/issues.json"), "utf8")).toBe(beforeRefusal);
      expect(await page.getByRole("alert").getByText(/La operación fue rechazada/).count()).toBe(1);
      expect(await review.locator(".work-issue-status").textContent()).toBe("Listo para revisión");
      stage = "explicit workflow preview and human gate";
      await card.getByRole("button", { name: "Ver workflow" }).click();
      const panel = page.getByRole("region", { name: "Workflow de Q analysis fixture" });
      const previewResponse = await observeResponse(page, "/api/workflows/preview", "POST", () => panel.getByRole("button", { name: "Previsualizar workflow", exact: true }).click());
      expect(previewResponse.status()).toBe(200); expect((await previewResponse.json()).allowed).toBe(true);
      await panel.getByText("Workflow habilitado para este pedido.").waitFor(); expect(await panel.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled()).toBe(true);
      expect(existsSync(join(root, "synthetic-effects.json"))).toBe(false);
      await panel.getByRole("checkbox", { name: /Apruebo este template/ }).check();
      const started = await observeResponse(page, "/api/workflows/start", "POST", () => panel.getByRole("button", { name: "Iniciar workflow aprobado" }).click());
      expect(started.status()).toBe(201); const owner = (await started.json()).workflow;
      await panel.getByLabel("Motivo de la decisión").waitFor({ timeout: 20000 });
      expect(await panel.getByRole("button", { name: "Aprobar decisión exacta" }).isDisabled()).toBe(true);
      await panel.getByRole("region", { name: "Estado operativo y disparador del workflow" }).getByText(/Necesita decisión/).first().waitFor();
      expect(await card.getByRole("button", { name: "Despachar tarea aprobada" }).count()).toBe(0);
      stage = "exact task navigation and evidence distinction";
      await panel.getByText("Etapas, roles y consentimiento aprobado", { exact: true }).click(); await panel.getByRole("button", { name: /^Ver tarea / }).first().click();
      await page.getByRole("region", { name: "Estado operativo de la tarea" }).getByText(/no acredita Hecho/).waitFor();
      await page.getByRole("region", { name: "Scope y requisitos registrados" }).waitFor(); await page.getByRole("region", { name: "Testing capturado por infraestructura" }).waitFor();
      expect(await page.getByRole("region", { name: "Estado operativo de la tarea" }).getByText(/resultado completed/).count()).toBe(1);
      await page.getByRole("button", { name: "Abrir workflow del issue" }).click(); await panel.getByLabel("Motivo de la decisión").waitFor();
      await panel.getByLabel("Motivo de la decisión").fill("Reviewed the exact fictional proposal"); await panel.getByRole("checkbox", { name: /Revisé esta decisión/ }).check();
      const accepted = await observeResponse(page, `/api/workflows/${owner.id}/decision`, "POST", () => panel.getByRole("button", { name: "Aprobar decisión exacta" }).click());
      expect(accepted.status()).toBe(200); expect((await accepted.json()).workflow.status).toBe("completed");
      await card.locator(".work-issue-status").filter({ hasText: "proposed" }).waitFor();
      expect((await (await fetch(`${apiUrl}/api/work-issues/${owner.issue_id}`)).json()).issue.status).toBe("proposed");
      expect(Number(await readFile(join(root, "synthetic-effects.json"), "utf8"))).toBe(1);
      stage = "mobile scope, controls and reload";
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("button", { name: /Issues/ }).click();
      await review.getByText("Scope y clasificación · revisión 1", { exact: true }).click(); await review.getByRole("button", { name: "Revisar candidato" }).click(); await review.getByText(/Vigencia Git no comprobada/).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Expanded issue evidence must fit mobile").toBe(true);
      expect((await review.getByRole("button", { name: "Aceptar este candidato local" }).boundingBox())!.width).toBeLessThan(350);
      expect(await review.getByRole("checkbox", { name: "Evidence retained" }).isChecked()).toBe(false);
      await card.getByRole("button", { name: "Ver workflow" }).click(); await panel.getByLabel("Workflow registrado").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Workflow evidence must fit mobile").toBe(true);
      expect(await page.getByText("SYNTHETIC_PRIVATE_SOURCE_BODY_MUST_NOT_RENDER", { exact: false }).count()).toBe(0);
      stage = "API restart, retained evidence and old-session refusal";
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      await page.goto("about:blank"); expect(await stopApi()).toBe(true);
      expect(existsSync(join(root, "state/maintenance/boundary.lock")), "A graceful owned restart must not leave a live boundary lock").toBe(false);
      apiUrl = await startApi(); await vite!.close(); const restartedUrl = await startUi(apiUrl);
      expect((await fetch(`${apiUrl}/api/workflows/preview`, { method: "POST", headers: { "X-Surtec-Session": oldSession }, body: "{}" })).status).toBe(403);
      await page.goto(restartedUrl); await page.getByRole("button", { name: /Issues/ }).click(); await decision.getByText(/Disparador registrado: cambio de scope/).waitFor();
      await card.getByRole("button", { name: "Ver workflow" }).click(); await panel.getByLabel("Workflow registrado").waitFor();
      expect((await (await fetch(`${apiUrl}/api/workflows/${owner.id}`)).json()).workflow.status).toBe("completed");
      expect((await (await fetch(`${apiUrl}/api/work-issues/${issueId}`)).json()).issue.status).toBe("ready-for-review");
      expect(Number(await readFile(join(root, "synthetic-effects.json"), "utf8"))).toBe(1); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
      expect(mutations).toEqual([`POST /api/work-issues/${issueId}/accept`, "POST /api/workflows/preview", "POST /api/workflows/start", `POST /api/workflows/${owner.id}/decision`]);
      expect(git(["status", "--porcelain"]).toString().trim()).toBe("");
      expect(pageErrors).toEqual([]); expect(httpErrors, JSON.stringify(await Promise.all(failedResponses))).toEqual([`409 /api/work-issues/${issueId}/accept`]);
      expect(consoleErrors.filter(message => !message.includes("409 (Conflict)"))).toEqual([]);
    } catch (error) { throw new Error(`Q T005 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
    }
  }, 120000);

  it.each([
    ["working", "Trabajando"], ["checking", "Verificando"], ["needs-decision", "Necesita decisión"],
    ["ready-for-review", "Listo para revisión"], ["done", "Hecho"], ["blocked", "Bloqueado"],
    ["proposed", "proposed"], ["authorized", "authorized"], ["cancelled", "cancelled"],
  ] as const)("projects %s without changing its authoritative lifecycle", async (status, label) => {
    const fixture = reviewedFixture(); fixture.issue.status = status;
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    render(<IssuesView />);
    expect(await screen.findByText(label, { selector: ".work-issue-status" })).toBeInTheDocument();
    if (status !== "done") expect(screen.queryByText("Hecho", { selector: ".work-issue-status" })).toBeNull();
    expect(api.getWorkflows).toHaveBeenCalledTimes(1);
  });

  it("presents canonical ancestry, complete recorded scope and source time without exporting session notes", async () => {
    const fixture = reviewedFixture();
    fixture.issue = { ...fixture.issue, objective_id: "O-exact", parent_issue_id: "I-parent", assigned_role_id: "backend-engineer", related_commitment_ids: ["COM-exact"],
      plan: ["Inspect then verify"], authorized_scope: { ...fixture.issue.authorized_scope, excluded_path_patterns: ["secrets/**"], explicit_exclusions: ["No deployment"] } };
    fixture.sessions = [{ id: "S-exact", objective: "PRIVATE_SESSION_OBJECTIVE", notes: "PRIVATE_SESSION_NOTE" } as never];
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] }); vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    render(<IssuesView />); await screen.findByText("Review fixture");
    const ancestry = screen.getByRole("region", { name: "Resultado y linaje de Review fixture" });
    expect(ancestry).toHaveTextContent("O-exact"); expect(ancestry).toHaveTextContent("I-parent"); expect(ancestry).toHaveTextContent("COM-exact");
    expect(ancestry.querySelector("time")).toHaveAttribute("dateTime", fixture.issue.updated_at);
    fireEvent.click(screen.getByText("Scope y clasificación · revisión 1"));
    expect(screen.getByText("secrets/**", { exact: false })).toBeInTheDocument(); expect(screen.getByText("No deployment", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver linaje y evidencia" })); await screen.findByText(/S-exact/);
    expect(document.body.textContent).not.toMatch(/PRIVATE_SESSION_/);
    expect(screen.getByText(/no un log completo de auditoría/)).toBeInTheDocument();
  });

  it("keeps independent delivery facts behind an explicit consultation and private detail disclosure", async () => {
    const fixture = deliveryFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    const getDetail = vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    const record = vi.spyOn(api, "recordDeliveryObservation");
    render(<IssuesView />);
    await screen.findByText("Review fixture");
    expect(screen.queryByRole("button", { name: "Consultar entrega y seguimiento" })).toBeNull();
    expect(getDetail).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("PRIVATE_DELIVERY_");
    fireEvent.click(screen.getByRole("button", { name: "Ver linaje y evidencia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    for (const heading of ["Aceptación técnica", "Readiness revisada", "Entorno observado", "Handoff registrado", "Respuesta registrada", "Seguimiento registrado"]) {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toContain("PRIVATE_DELIVERY_");
    expect(screen.queryByText("Hecho", { selector: ".work-issue-status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aceptar este candidato local" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Mostrar detalle privado ${fixture.evidence[0]!.id}` }));
    expect(await screen.findByText("PRIVATE_DELIVERY_FOLLOW_UP_CANARY")).toBeInTheDocument();
    expect(screen.getByText("PRIVATE_DELIVERY_NEXT_ACTION_CANARY")).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it("records only a confirmed manual fact and refreshes the issue revision, lineage and context preview", async () => {
    const authorized = authorizedFixture(), before = deliveryFixture();
    before.issue = { ...before.issue, status: "authorized", assigned_role_id: "backend-engineer", revision: 3 };
    before.evidence = []; before.issue.evidence_ids = [];
    const observation: DeliveryObservation = { schema_version: 1, kind: "follow-up-recorded", origin: "operator-entered", commitment_id: null,
      occurred_at: new Date("2026-09-29T12:00").toISOString(), summary: "PRIVATE_SAVED_FOLLOW_UP", source_reference: "follow-up-fixture", next_action: "PRIVATE_SAVED_NEXT_ACTION" };
    const saved = deliveryFixture(); saved.issue = { ...before.issue, revision: 4, updated_at: "2026-09-29T13:00:00Z", evidence_ids: [saved.evidence[0]!.id] };
    saved.evidence[0]!.delivery_observation = observation;
    saved.evidence[0]!.created_at = new Date(Date.parse(observation.occurred_at) + 60_000).toISOString();
    let stored = false;
    vi.mocked(api.getWorkIssues).mockImplementation(async () => ({ issues: [stored ? saved.issue : before.issue] }));
    const getDetail = vi.spyOn(api, "getWorkIssue").mockImplementation(async () => stored ? saved : before);
    const record = vi.spyOn(api, "recordDeliveryObservation").mockImplementation(async () => { stored = true; return { issue: saved.issue, evidence: saved.evidence[0]! }; });
    const accept = vi.spyOn(api, "acceptWorkIssueCandidate"), authorize = vi.spyOn(api, "authorizeWorkIssue");
    const commitmentWrite = vi.spyOn(api, "saveCommitment");
    render(<IssuesView />);
    const previewButton = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    fireEvent.click(previewButton); await screen.findByText("Contexto habilitado para este pedido.");
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Ver linaje y evidencia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    fireEvent.click(await screen.findByRole("button", { name: "Registrar observación manual" }));
    fireEvent.change(screen.getByLabelText("Tipo de observación"), { target: { value: observation.kind } });
    fireEvent.change(screen.getByLabelText("Momento de la observación (hora local)"), { target: { value: "2026-09-29T12:00" } });
    fireEvent.change(screen.getByLabelText("Resumen privado"), { target: { value: observation.summary } });
    fireEvent.change(screen.getByLabelText("Referencia de origen"), { target: { value: observation.source_reference } });
    fireEvent.change(screen.getByLabelText("Próxima acción privada"), { target: { value: observation.next_action } });
    const save = screen.getByRole("button", { name: "Guardar observación local" });
    expect(save).toBeDisabled(); expect(record).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirmo registrar este hecho manual sin aprobar entrega ni completar compromisos" }));
    fireEvent.click(save);
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record).toHaveBeenCalledWith(before.issue.id, { project_id: "alpha", expected_revision: 3, scope_revision: 1,
      candidate_id: null, candidate_revision: null, diff_fingerprint: null, delivery_observation: {
        ...observation, occurred_at: new Date("2026-09-29T12:00").toISOString(),
      }, confirm: true });
    await screen.findByText(/Preview sobre revisión 4/);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull());
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" })).toBeInTheDocument();
    expect(getDetail.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain("PRIVATE_SAVED_");
    expect(authorized.dispatch).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled(); expect(commitmentWrite).not.toHaveBeenCalled();
  });

  it.each(["active-owner", "unavailable-owner"])("refuses manual delivery recording with %s while retaining readable lineage", async (ownership) => {
    const fixture = deliveryFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    const record = vi.spyOn(api, "recordDeliveryObservation");
    if (ownership === "active-owner") vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-owner", issue_id: fixture.issue.id, status: "waiting-human" } as never] });
    else vi.mocked(api.getWorkflows).mockRejectedValue(new Error("PRIVATE_OWNER_READ_ERROR"));
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver linaje y evidencia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    expect(await screen.findByRole("heading", { name: "Seguimiento registrado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar observación manual" })).toBeDisabled();
    expect(record).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("PRIVATE_OWNER_READ_ERROR");
  });

  it("disables manual delivery recording while another protected issue action is pending", async () => {
    const fixture = deliveryFixture(); fixture.issue.status = "proposed";
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    let finish!: (value: { issue: WorkIssue }) => void;
    const authorize = vi.spyOn(api, "authorizeWorkIssue").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const record = vi.spyOn(api, "recordDeliveryObservation");
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver linaje y evidencia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar observación manual" }));
    fireEvent.click(screen.getByRole("button", { name: "Autorizar scope exacto" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Guardar observación local" })).toBeDisabled();
    expect(record).not.toHaveBeenCalled();
    await act(async () => finish({ issue: fixture.issue }));
  });

  it("discards an open manual form and revealed private facts when lineage refresh no longer matches the visible revision", async () => {
    const fixture = deliveryFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    const getDetail = vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    const record = vi.spyOn(api, "recordDeliveryObservation");
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver linaje y evidencia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    fireEvent.click(screen.getByRole("button", { name: `Mostrar detalle privado ${fixture.evidence[0]!.id}` }));
    fireEvent.click(screen.getByRole("button", { name: "Registrar observación manual" }));
    fireEvent.change(screen.getByLabelText("Resumen privado"), { target: { value: "PRIVATE_UNSAVED_DRAFT" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirmo registrar este hecho manual sin aprobar entrega ni completar compromisos" }));
    getDetail.mockResolvedValue({ ...fixture, issue: { ...fixture.issue, revision: fixture.issue.revision + 1 } });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findByText(/El linaje no coincide con la revisión visible/);
    expect(screen.queryByRole("button", { name: "Guardar observación local" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Consultar entrega y seguimiento" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/PRIVATE_(DELIVERY|UNSAVED)_/);
    expect(record).not.toHaveBeenCalled();
  });

  it("uses only the exact scope proposal as a classified decision trigger and retains protected actions", async () => {
    const fixture = reviewedFixture(); fixture.issue = { ...fixture.issue, status: "needs-decision", next_action: "Review the changed scope",
      scope_change_proposal: { id: "SP-exact", discovered_paths: ["src/outside.ts"], proposed_scope: fixture.issue.authorized_scope, discovered_at: fixture.issue.updated_at, evidence_task_id: "T-origin" } };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] }); vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    const approve = vi.spyOn(api, "approveWorkIssueScope").mockResolvedValue({ issue: fixture.issue });
    render(<IssuesView />);
    const reason = await screen.findByRole("region", { name: "Decisión actual de Review fixture" });
    expect(reason).toHaveTextContent("Disparador registrado: cambio de scope"); expect(reason).toHaveTextContent("SP-exact"); expect(reason).toHaveTextContent("T-origin");
    expect(approve).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Autorizar nueva revisión de scope" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(fixture.issue));
  });

  it("does not infer a limit or policy trigger from free-text next action or completed workflow", async () => {
    const fixture = reviewedFixture(); fixture.issue = { ...fixture.issue, status: "needs-decision", next_action: "Token budget exhausted; policy changed; tests failed", blocked_by_issue_ids: ["I-missing"] };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] }); vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-finished", issue_id: fixture.issue.id, status: "completed" } as never] });
    render(<IssuesView />);
    const reason = await screen.findByRole("region", { name: "Decisión actual de Review fixture" });
    expect(reason).toHaveTextContent("Brecha de motivo"); expect(reason).toHaveTextContent("I-missing: estado no disponible");
    expect(reason).not.toHaveTextContent("Disparador registrado: presupuesto"); expect(screen.queryByText("Hecho", { selector: ".work-issue-status" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Autorizar reintento con scope sin cambios" })).toBeEnabled();
  });

  it("separates current-scope candidate records from invalidated and other-scope records without claiming Git validity", async () => {
    const fixture = reviewedFixture();
    fixture.candidates.push({ ...fixture.candidates[0]!, id: "C-old", scope_revision: 2 }, { ...fixture.candidates[0]!, id: "C-invalid", invalidated_at: fixture.issue.updated_at });
    fixture.evidence = [{ schema_version: 1, id: "E-exact", issue_id: fixture.issue.id, task_id: "T-review", execution_id: "run-review", candidate_id: "C-review", candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64), scope_revision: 1, kind: "verification", label: "Infrastructure verification record", reference: "/api/tasks/T-review", status: "passed", created_at: fixture.issue.updated_at }];
    fixture.tasks = [{ task: { envelope: { id: "T-review" }, lifecycle: "finished", outcome: "completed" }, executions: [{ run_id: "run-review", attempt: 2, events: [] }] } as never];
    const onOpenTask = vi.fn(); vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] }); vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture);
    const accept = vi.spyOn(api, "acceptWorkIssueCandidate");
    render(<IssuesView onOpenTask={onOpenTask} />); fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findByText(/Candidato registrado para el scope actual/);
    expect(screen.getByText(/Candidato de otro scope/)).toBeInTheDocument(); expect(screen.getByText(/Candidato invalidado/)).toBeInTheDocument();
    expect(screen.getAllByText(/Vigencia Git no comprobada/)).toHaveLength(3);
    expect(screen.getByText("Infrastructure verification record").closest("div")).toHaveTextContent("run-review");
    expect(screen.getByRole("button", { name: "Aceptar este candidato local" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ver tarea T-review" })); expect(onOpenTask).toHaveBeenCalledWith("T-review"); expect(accept).not.toHaveBeenCalled();
  });

  it.each(["other-issue", "other-project", "other-revision", "other-scope"])("rejects a lineage read bound to %s", async (mismatch) => {
    const fixture = reviewedFixture(), wrong = { ...fixture, issue: { ...fixture.issue } };
    if (mismatch === "other-issue") wrong.issue.id = "I-other";
    if (mismatch === "other-project") wrong.issue.project_id = "other";
    if (mismatch === "other-revision") wrong.issue.revision++;
    if (mismatch === "other-scope") wrong.issue.scope_revision++;
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] }); vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] }); vi.spyOn(api, "getWorkIssue").mockResolvedValue(wrong);
    render(<IssuesView />); fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Aceptar este candidato local" })).toBeNull(); expect(document.body.textContent).not.toContain("C-review");
  });

  it("ignores collapsed lineage and old refresh responses and clears old criterion confirmations", async () => {
    const fixture = reviewedFixture(); let finish!: (value: IssueLineage) => void;
    const fresh = { ...fixture, evidence_gaps: ["Latest evidence gap"] };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] }); vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [fixture.issue] });
    const read = vi.spyOn(api, "getWorkIssue").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(fresh);
    render(<IssuesView />); fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" })); await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar linaje" })); fireEvent.click(screen.getByRole("button", { name: "Revisar candidato" })); await screen.findByText("Latest evidence gap", { exact: false });
    await act(async () => finish(fixture)); expect(screen.queryByText(/Human acceptance evidence is missing/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "The fixture persists" })); expect(screen.getByRole("button", { name: "Aceptar este candidato local" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" })); await screen.findByRole("checkbox", { name: "The fixture persists" });
    expect(screen.getByRole("checkbox", { name: "The fixture persists" })).not.toBeChecked(); expect(screen.getByRole("button", { name: "Aceptar este candidato local" })).toBeDisabled();
  });

  it("uses fixed public read failures rather than rendering raw private exceptions", async () => {
    vi.mocked(api.getWorkIssues).mockRejectedValue(new Error("PRIVATE_LOCAL_SOURCE_BODY")); vi.mocked(api.getWorkflows).mockRejectedValue(new Error("PRIVATE_AUTHORITY_PATH"));
    vi.spyOn(api, "getInbox").mockRejectedValue(new Error("PRIVATE_PROVIDER_TOKEN")); render(<IssuesView />);
    await screen.findByText(/La lectura de issues no está disponible/); expect(document.body.textContent).not.toContain("PRIVATE_");
  });

  it("does not republish a pending old lineage after an issue-list refresh fails", async () => {
    const fixture = reviewedFixture(); let finish!: (value: IssueLineage) => void;
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValueOnce({ issues: [fixture.issue] }).mockRejectedValue(new Error("PRIVATE_FAILED_LIST"));
    const read = vi.spyOn(api, "getWorkIssue").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<IssuesView />); fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" })); await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" })); await screen.findByText(/La lectura de issues no está disponible/);
    await act(async () => finish(fixture));
    expect(screen.queryByRole("button", { name: "Aceptar este candidato local" })).toBeNull(); expect(document.body.textContent).not.toContain("C-review");
    expect(document.body.textContent).not.toContain("PRIVATE_FAILED_LIST");
  });
  it("does not display another issue's optional budget while preserving the exact context dispatch gate", async () => {
    const fixture = authorizedFixture();
    fixture.requestPreview.mockResolvedValue({ ...fixture.preview, budget_preview: {
      schema_version: 1, observed_at: "2026-10-11T12:00:00.000Z", status: "unavailable", can_admit: false, executable: false, reserves_capacity: false,
      ledger: { status: "unavailable", revision: null, updated_at: null },
      binding: { attribution: { company_id: "surtec", project_ids: ["alpha"], objective_ids: [], issue_id: "different-issue",
        role_id: "software-engineer", execution_id: "foreign-preview-only" }, cap_fingerprint: "f".repeat(64), policy_bindings: [],
      ceilings: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, dimension === "total_tokens" ? 32109 : 1])) as BudgetAmounts },
      resolution: null, prospective_hold: null, denials: [{ code: "budget-ledger-unavailable", source_ids: ["ledger:unavailable"] }],
      limitation: "Synthetic informational preview only",
    } });
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByText("Contexto habilitado para este pedido.");
    const context = screen.getByRole("region", { name: "Preview de contexto" });
    const summary = within(context).getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(summary).toHaveTextContent("Presupuesto no disponible.");
    expect(summary).not.toHaveTextContent("32109");
    expect(summary).not.toHaveTextContent("f".repeat(64));
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).not.toBeDisabled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(api.fetchBudgets).not.toHaveBeenCalled();
  });

  it("reads project budget only for expanded lineage without inventing issue or objective attribution", async () => {
    const lineage = reviewedFixture();
    lineage.issue = { ...lineage.issue, objective_id: "explicit-issue-objective" };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [lineage.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(lineage);
    render(<IssuesView />);
    await screen.findByText("Review fixture");
    expect(api.fetchBudgets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ver linaje y evidencia" }));
    await screen.findAllByText(/issue-project-policy/);
    const budget = within(screen.getByRole("region", { name: "Presupuesto del proyecto" }));
    expect(budget.getByText("Disponibilidad informativa: no disponible.")).toBeInTheDocument();
    expect(budget.getAllByText(/límite 10 · consumido desconocido · probado desconocido · reservado desconocido · restante desconocido/)).toHaveLength(1);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(1);
    expect(api.fetchBudgets).toHaveBeenCalledWith({ project_id: "alpha" });
    expect(screen.getByText("Presupuesto del proyecto")).toBeInTheDocument();
    expect(screen.getByText(/no el presupuesto exacto del issue/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("budget-accounting-unavailable");
    expect(budget.queryByText(/explicit-issue-objective/)).toBeNull();
    expect(screen.getByRole("region", { name: "Resultado y linaje de Review fixture" })).toHaveTextContent("explicit-issue-objective");
    expect(screen.getByText(/Human acceptance evidence is missing/)).toBeInTheDocument();
  });

  it("retains the manual candidate acceptance gate when the optional project budget is unavailable", async () => {
    const ready = reviewedFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [ready.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(ready);
    vi.mocked(api.fetchBudgets).mockRejectedValue(new Error("Synthetic private budget failure"));
    const accept = vi.spyOn(api, "acceptWorkIssueCandidate");
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findByRole("checkbox", { name: "The fixture persists" });
    await screen.findByText("No pude consultar el presupuesto; el resto de la vista sigue disponible.");
    expect(api.fetchBudgets).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Aceptar este candidato local" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "The fixture persists" }));
    expect(screen.getByRole("button", { name: "Aceptar este candidato local" })).not.toBeDisabled();
    expect(accept).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Synthetic private budget failure");
  });

  it("refreshes budget evidence after successful issue acceptance even when the issue list revision does not advance", async () => {
    const ready = reviewedFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [ready.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(ready);
    const accept = vi.spyOn(api, "acceptWorkIssueCandidate").mockResolvedValue({ issue: { ...ready.issue, status: "done", revision: 5 } });
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findAllByText(/issue-project-policy/);
    vi.mocked(api.fetchBudgets).mockResolvedValue(projectBudget("post-action-project-policy"));
    fireEvent.click(screen.getByRole("checkbox", { name: "The fixture persists" }));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar este candidato local" }));
    await screen.findAllByText(/post-action-project-policy/);
    expect(accept).toHaveBeenCalledWith(ready.issue, ready.candidates[0], ["The fixture persists"], false);
    expect(api.fetchBudgets).toHaveBeenCalledTimes(2);
    expect(api.fetchBudgets).toHaveBeenLastCalledWith({ project_id: "alpha" });
    expect(document.body.textContent).not.toContain("issue-project-policy");
  });

  it("discards an old budget request after lineage is collapsed and reopened", async () => {
    const ready = reviewedFixture();
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [ready.issue] });
    vi.spyOn(api, "getWorkIssue").mockResolvedValue(ready);
    let finishOld!: (value: api.BudgetReadView) => void;
    vi.mocked(api.fetchBudgets).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(projectBudget("reopened-project-policy"));
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver linaje y evidencia" }));
    await waitFor(() => expect(api.fetchBudgets).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar linaje" }));
    fireEvent.click(screen.getByRole("button", { name: "Ver linaje y evidencia" }));
    await screen.findAllByText(/reopened-project-policy/);
    await act(async () => finishOld(projectBudget("stale-project-policy")));
    expect(document.body.textContent).not.toContain("stale-project-policy");
    expect(document.body.textContent).toContain("reopened-project-policy");
    expect(api.fetchBudgets).toHaveBeenCalledTimes(2);
  });

  it("ignores an older ownership refresh that finishes after the latest snapshot", async () => {
    const fixture = authorizedFixture(); let finish!: (value: { workflows: never[] }) => void;
    vi.mocked(api.getWorkflows).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<IssuesView />); await waitFor(() => expect(api.getWorkflows).toHaveBeenCalledTimes(1));
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-1", issue_id: fixture.issue.id, project_id: "alpha", status: "waiting-human" } as never] });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" })); await screen.findByText(/Workflow activo W-1/);
    await act(async () => finish({ workflows: [] }));
    expect(screen.getByText(/Workflow activo W-1/)).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("hides generic dispatch and acceptance while a workflow owns the issue", async () => {
    const fixture = authorizedFixture();
    vi.mocked(api.getWorkflows).mockResolvedValue({ workflows: [{ id: "W-1", issue_id: fixture.issue.id, project_id: "alpha", status: "waiting-human" } as never] });
    render(<IssuesView />);
    await screen.findByText(/Workflow activo W-1/);
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aceptar este candidato local" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ver workflow" })).toBeInTheDocument();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed for manual actions when workflow ownership cannot be read", async () => {
    const fixture = authorizedFixture(); vi.mocked(api.getWorkflows).mockRejectedValue(new Error("Synthetic unavailable ownership"));
    render(<IssuesView />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("requires explicit preview, retains the assigned agent and dispatches its exact role/revision/fingerprint", async () => {
    const fixture = authorizedFixture();
    render(<IssuesView />);
    const previewButton = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    expect(fixture.requestPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    const assigned = screen.getByLabelText("Agente autorizado de Review fixture");
    expect(assigned).toBeDisabled(); expect(assigned).toHaveValue("backend-engineer");
    expect(within(screen.getByLabelText("Perfil Codex de Review fixture")).queryByText("Reviewer (Codex profile)")).toBeNull();
    fireEvent.click(previewButton);
    await screen.findByText("Contexto habilitado para este pedido.");
    expect(fixture.requestPreview).toHaveBeenCalledWith({ kind: "issue", project: "alpha", agent: "backend-engineer", role_id: "software-engineer", issue_id: fixture.issue.id, expected_revision: 3, client_context_categories: [] });
    fireEvent.click(screen.getByRole("button", { name: "Despachar tarea aprobada" }));
    await waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith(fixture.issue.id, 3, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: "a".repeat(64), client_context_categories: [] }));
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
  });

  it("resets preview and confidential consent on explicit refresh and issue revision changes", async () => {
    const fixture = authorizedFixture();
    render(<IssuesView />);
    const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ });
    expect(notes).not.toBeChecked();
    fireEvent.click(notes);
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar contexto del issue" }));
    await screen.findByText("Contexto habilitado para este pedido.");
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [{ ...fixture.issue, revision: 4, scope_revision: 2 }] });
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(screen.queryByRole("button", { name: "Despachar tarea aprobada" })).toBeNull();
    await screen.findByText(/Preview sobre revisión 4/);
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(await screen.findByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("shows blocked admission without dispatch or implicit downgrade", async () => {
    const fixture = authorizedFixture();
    fixture.requestPreview.mockResolvedValue({ ...fixture.preview, allowed: false, blocked_reasons: ["Testing evidence configuration is unavailable"] });
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByText("Testing evidence configuration is unavailable");
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("discards a stale server dispatch and requires a new preview", async () => {
    const fixture = authorizedFixture();
    fixture.dispatch.mockRejectedValue(new Error("Context preview changed; regenerate before dispatch"));
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button); await screen.findByText("Contexto habilitado para este pedido.");
    fireEvent.click(screen.getByRole("button", { name: "Despachar tarea aprobada" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("ignores a late preview after the issue has refreshed", async () => {
    const fixture = authorizedFixture();
    let finish!: (value: api.ContextPreview) => void;
    fixture.requestPreview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<IssuesView />);
    const button = await screen.findByRole("button", { name: "Previsualizar contexto del issue" });
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar contexto del issue" })).not.toBeDisabled());
    finish(fixture.preview);
    await waitFor(() => expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled());
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("does not silently replace a historical assignment outside the available profile", async () => {
    const fixture = authorizedFixture();
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [{ ...fixture.issue, assigned_role_id: "unavailable-engineer" }] });
    render(<IssuesView />);
    await screen.findByText(/Sin perfil compatible disponible/);
    expect(screen.getByRole("button", { name: "Despachar tarea aprobada" })).toBeDisabled();
    expect(fixture.requestPreview).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it.each([false, true])("invalidates accepted lineage and does not retain stale gaps when refetch fails=%s", async (fails) => {
    const ready = reviewedFixture();
    const done: IssueLineage = { ...ready, issue: { ...ready.issue, status: "done", revision: 5 }, evidence_gaps: [] };
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.getWorkIssues).mockResolvedValueOnce({ issues: [ready.issue] }).mockResolvedValue({ issues: [done.issue] });
    const getDetail = vi.spyOn(api, "getWorkIssue").mockResolvedValueOnce(ready);
    if (fails) getDetail.mockRejectedValueOnce(new Error("Synthetic detail refresh failed"));
    else getDetail.mockResolvedValueOnce(done);
    vi.spyOn(api, "acceptWorkIssueCandidate").mockResolvedValue({ issue: done.issue });
    render(<IssuesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Revisar candidato" }));
    await screen.findByText(/Human acceptance evidence is missing/);
    fireEvent.click(screen.getByRole("checkbox", { name: "The fixture persists" }));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar este candidato local" }));
    await screen.findByText("done");
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Human acceptance evidence is missing/)).toBeNull());
    if (fails) await screen.findByRole("alert");
    else await screen.findByText(/sin brechas conocidas/);
  });

  it("loads and lists issues newest-first with title links", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    const link = screen.getByRole("link", { name: /beta issue/i });
    expect(link.getAttribute("href")).toBe("https://gh/beta/2");
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("filters by repo", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/repositorio externo/i), { target: { value: "alpha" } });
    expect(screen.queryByText("beta issue")).toBeNull();
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("shows the empty state when there are no issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "alpha", slug: "owner/alpha", ok: true }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/sin issues externos abiertos/i)).toBeTruthy());
  });

  it("shows a degraded note for repos whose gh failed (some ok, some not)", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({
      items: [],
      repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: false, error: "no access" }],
    });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/no se pudo leer/i)).toBeTruthy());
  });

  it("shows 'GitHub no disponible' when every repo failed", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "beta", slug: "owner/beta", ok: false, error: "no gh" }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/github no disponible/i)).toBeTruthy());
    expect(screen.queryByText(/sin issues externos abiertos/i)).toBeNull();
  });

  it("distinguishes a healthy empty repository from a failed repository in a partial inbox", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({
      items: [inbox.items[0]!],
      repos: [...inbox.repos, { id: "failed", slug: "owner/failed", ok: false }],
    });
    render(<IssuesView />);
    expect((await screen.findByRole("link", { name: /beta issue/i })).getAttribute("href")).toBe("https://gh/beta/2");
    expect(screen.getByText("No se pudo leer: failed.")).toBeTruthy();
    const filter = screen.getByLabelText("Repositorio externo");
    fireEvent.change(filter, { target: { value: "alpha" } });
    expect(screen.getByText("Sin issues externos abiertos")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "failed" } });
    expect(screen.getByText("Issues externos no disponibles para este repositorio.")).toBeTruthy();
    expect(screen.queryByText("Sin issues externos abiertos")).toBeNull();
  });

  it("does not report an empty inbox when the provider read rejects", async () => {
    vi.spyOn(api, "getInbox").mockRejectedValue(new Error("synthetic inbox failure"));
    render(<IssuesView />);
    expect(await screen.findByText(/no pude leer los issues externos/i)).toBeTruthy();
    expect(screen.queryByText(/sin issues externos abiertos/i)).toBeNull();
  });

  it("keeps local work proposals separate from provider inbox issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [{
      id: "I-1", schema_version: 1, project_id: "alpha", objective_id: null, parent_issue_id: null,
      title: "Local outcome", expected_outcome: "Make the flow work", acceptance_criteria: ["It persists"], status: "proposed", work_scale: "trivial",
      classification_inputs: { affected_domains: [], requires_migration: false, security_impact: false }, classification_rationale: ["narrow"], plan: [],
      authorized_scope: { expected_outcome: "Make the flow work", acceptance_criteria: ["It persists"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] },
      scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 50, criticality: "low",
      blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null, task_ids: [], evidence_ids: [], candidate_ids: [],
      created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z", revision: 2,
    }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("Local outcome")).toBeTruthy());
    expect(screen.getByText("Trabajo aprobado")).toBeTruthy();
    expect(screen.getByText("Issues externos")).toBeTruthy();
    expect(screen.queryByText("Local outcome")?.closest("a")).toBeNull();
  });
});

const PENDING_INTAKE_KEY = "surtec.work-issue.pending-request.v1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CANCEL_INTAKE_LABEL = "Entiendo que el pedido podría existir; cancelar este intento no lo elimina.";
type KeyedIntakeInput = IssueCreateInput & { request_id: string };

function intakeIssue(requestId = REQUEST_ID, input?: IssueCreateInput, overrides: Partial<WorkIssue> = {}): WorkIssue {
  const base = reviewedFixture().issue;
  const expectedOutcome = input?.expected_outcome.trim() ?? "Keep one durable manual request.";
  const criteria = input?.acceptance_criteria ?? ["The request has one identity."];
  return {
    ...base, id: `I-${requestId}`, project_id: input?.project_id.trim() ?? "alpha", objective_id: input?.objective_id ?? null,
    parent_issue_id: input?.parent_issue_id ?? null, title: input?.title.trim() ?? "Recovered manual request",
    expected_outcome: expectedOutcome, acceptance_criteria: criteria, status: "proposed", revision: 2,
    authorized_scope: input ? structuredClone(input.authorized_scope) : { ...base.authorized_scope, expected_outcome: expectedOutcome, acceptance_criteria: criteria },
    classification_inputs: { affected_domains: input?.classification_inputs?.affected_domains ?? [], requires_migration: input?.classification_inputs?.requires_migration ?? false, security_impact: input?.classification_inputs?.security_impact ?? false },
    plan: input?.plan ?? [], priority: input?.priority ?? 50, criticality: input?.criticality ?? "low",
    assigned_role_id: input?.assigned_role_id ?? null, related_commitment_ids: input?.related_commitment_ids ?? [], external_references: input?.external_references ?? [],
    blocked_by_issue_ids: input?.blocked_by_issue_ids ?? [], next_action: input?.next_action ?? null,
    task_ids: [], candidate_ids: [], evidence_ids: [],
    intake_receipt: { schema_version: 1, request_id: requestId, request_fingerprint: "a".repeat(64) },
    ...overrides,
  };
}

function deferredIntake<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mockIntakeCreate() {
  return vi.spyOn(api, "createWorkIssue").mockRejectedValue(new Error("Synthetic unexpected intake"));
}

async function fillIntake(title = "PRIVATE_DRAFT_REQUEST") {
  const summary = screen.getByText("Crear issue local");
  const details = summary.closest("details") as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
  await waitFor(() => expect(screen.getByLabelText("Repositorio local")).toHaveValue("alpha"));
  fireEvent.change(screen.getByLabelText("Título"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Resultado esperado"), { target: { value: "PRIVATE_EXPECTED_OUTCOME" } });
  fireEvent.change(screen.getByLabelText(/^Criterios de aceptación/), { target: { value: "Keep one exact request." } });
  fireEvent.change(screen.getByLabelText(/^Paths permitidos/), { target: { value: "src/**" } });
  fireEvent.change(screen.getByLabelText(/^Categorías de cambio/), { target: { value: "test" } });
  return screen.getByLabelText("Título").closest("form")!;
}

describe("T004 manual intake identity and recovery", () => {
  beforeEach(() => {
    sessionStorage.removeItem(PENDING_INTAKE_KEY);
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [] });
    vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [{ project: "alpha", allowed_agents: ["backend-engineer"], project_sandbox_ceiling: "workspace-write", has_local_checkout: true, has_verification_commands: true,
      agents: [{ agent: "backend-engineer", agent_sandbox_ceiling: "workspace-write", allowed_modes: ["workspace-write"], default_mode: "workspace-write", modes: [] }] }] });
  });
  afterEach(() => { vi.restoreAllMocks(); sessionStorage.removeItem(PENDING_INTAKE_KEY); });

  it("reserves one UUID before POST and fences a double submit while preserving only that UUID", async () => {
    const pending = deferredIntake<{ issue: WorkIssue }>(), create = mockIntakeCreate().mockReturnValue(pending.promise);
    render(<IssuesView />); const form = await fillIntake();
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]![0] as KeyedIntakeInput;
    expect(payload.request_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id);
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).not.toContain("PRIVATE_");
    expect(screen.getByRole("group", { name: "Datos del pedido local" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: CANCEL_INTAKE_LABEL }));
    expect(screen.getByRole("button", { name: "Cancelar intento pendiente" })).toBeDisabled();
    await act(async () => pending.resolve({ issue: intakeIssue(payload.request_id, payload) }));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
    expect(screen.getByLabelText("Título")).toHaveValue("");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries the same UUID and frozen payload explicitly after a lost response", async () => {
    const create = mockIntakeCreate().mockRejectedValueOnce(new Error("PRIVATE_TRANSPORT_FAILURE"))
      .mockImplementationOnce(async (payload) => ({ issue: intakeIssue(payload.request_id, payload) }));
    render(<IssuesView />); fireEvent.submit(await fillIntake());
    const retry = await screen.findByRole("button", { name: "Reintentar mismo pedido" });
    await waitFor(() => expect(retry).toBeEnabled());
    const original = structuredClone(create.mock.calls[0]![0]);
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(original.request_id);
    expect(screen.getByLabelText("Título")).toBeDisabled();
    expect(document.body.textContent).not.toContain("PRIVATE_TRANSPORT_FAILURE");
    fireEvent.click(retry);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(original);
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
  });

  it("uses a new UUID only for a subsequent deliberate request after confirmed success", async () => {
    const create = mockIntakeCreate().mockImplementation(async (payload) => ({ issue: intakeIssue(payload.request_id, payload) }));
    render(<IssuesView />); fireEvent.submit(await fillIntake("First deliberate request"));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue(""));
    fireEvent.submit(await fillIntake("Second deliberate request"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0].request_id).not.toBe(create.mock.calls[0]![0].request_id);
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
  });

  it("keeps a confirmed POST fact when the following list refresh fails", async () => {
    const create = mockIntakeCreate().mockImplementation(async (payload) => ({ issue: intakeIssue(payload.request_id, payload) }));
    vi.mocked(api.getWorkIssues).mockResolvedValueOnce({ issues: [] }).mockRejectedValue(new Error("PRIVATE_REFRESH_FAILURE"));
    render(<IssuesView />); fireEvent.submit(await fillIntake());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const id = `I-${create.mock.calls[0]![0].request_id}`;
    expect(await screen.findByText(`Pedido confirmado: ${id}.`)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull();
    expect(screen.queryByRole("region", { name: "Pedido local pendiente" })).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_REFRESH_FAILURE");
  });

  it("reconciles a stored UUID after reload through GET without posting or authorizing work", async () => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, REQUEST_ID);
    const recovered = intakeIssue(REQUEST_ID, undefined, { status: "authorized", revision: 4 });
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [recovered] });
    const create = mockIntakeCreate(), authorize = vi.spyOn(api, "authorizeWorkIssue"), dispatch = vi.spyOn(api, "dispatchWorkIssue");
    render(<IssuesView />);
    expect(await screen.findByText(`Pedido confirmado: ${recovered.id}.`)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull();
    expect(create).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["absent", "failed", "duplicate", "future-receipt"])("preserves uncertainty for a %s reload observation without automatic recreation", async (kind) => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, REQUEST_ID);
    const first = intakeIssue();
    if (kind === "failed") vi.mocked(api.getWorkIssues).mockRejectedValue(new Error("PRIVATE_READ_FAILURE"));
    else if (kind === "duplicate") vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [first, { ...first, id: `I-${OTHER_REQUEST_ID}` }] });
    else if (kind === "future-receipt") vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [{ ...first, intake_receipt: { ...first.intake_receipt!, schema_version: 2 } } as unknown as WorkIssue] });
    const create = mockIntakeCreate(); render(<IssuesView />);
    await act(async () => {});
    expect(screen.getByRole("region", { name: "Pedido local pendiente" })).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(REQUEST_ID);
    expect(screen.getByRole("button", { name: "Crear propuesta local", hidden: true })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reintentar mismo pedido" })).toBeNull();
    expect(create).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("PRIVATE_READ_FAILURE");
  });

  it("resolves a pending UUID through an explicit later read without sending another POST", async () => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, REQUEST_ID);
    const create = mockIntakeCreate(); render(<IssuesView />); await act(async () => {});
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [intakeIssue()] });
    fireEvent.click(screen.getByRole("button", { name: "Comprobar pedido pendiente" }));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
    expect(create).not.toHaveBeenCalled();
  });

  it("requires an explicit acknowledgement to cancel an unresolved intent and never creates automatically", async () => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, REQUEST_ID);
    const create = mockIntakeCreate(); render(<IssuesView />); await act(async () => {});
    const cancel = screen.getByRole("button", { name: "Cancelar intento pendiente" });
    expect(cancel).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: CANCEL_INTAKE_LABEL })); expect(cancel).toBeEnabled(); fireEvent.click(cancel);
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
    expect(screen.queryByRole("region", { name: "Pedido local pendiente" })).toBeNull(); expect(create).not.toHaveBeenCalled();
    create.mockImplementation(async (payload) => ({ issue: intakeIssue(payload.request_id, payload) }));
    fireEvent.submit(await fillIntake("A consciously new request"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].request_id).not.toBe(REQUEST_ID);
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
  });

  it.each(["read", "write"])("does not POST when pending identity storage cannot %s safely", async (operation) => {
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
    if (operation === "read") vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === PENDING_INTAKE_KEY) throw new Error("PRIVATE_STORAGE_FAILURE"); return originalGet.call(this, key);
    });
    else vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === PENDING_INTAKE_KEY) throw new Error("PRIVATE_STORAGE_FAILURE"); originalSet.call(this, key, value);
    });
    const create = mockIntakeCreate(); render(<IssuesView />);
    if (operation === "write") fireEvent.submit(await fillIntake()); else await act(async () => {});
    await waitFor(() => expect(screen.getByRole("region", { name: "Pedido local pendiente" })).toBeInTheDocument());
    expect(create).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("PRIVATE_STORAGE_FAILURE");
  });

  it("keeps the creation gate closed when a confirmed request UUID cannot be removed", async () => {
    const remove = Storage.prototype.removeItem;
    const removal = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (key === PENDING_INTAKE_KEY) throw new Error("PRIVATE_STORAGE_REMOVAL_FAILURE"); remove.call(this, key);
    });
    const create = mockIntakeCreate().mockImplementation(async (payload) => ({ issue: intakeIssue(payload.request_id, payload) }));
    render(<IssuesView />); fireEvent.submit(await fillIntake());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]![0];
    await waitFor(() => expect(screen.getByRole("region", { name: "Pedido local pendiente" })).toBeInTheDocument());
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id);
    expect(screen.getByRole("button", { name: "Crear propuesta local", hidden: true })).toBeDisabled();
    expect(document.body.textContent).not.toContain("PRIVATE_STORAGE_REMOVAL_FAILURE");
    removal.mockRestore(); vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [intakeIssue(payload.request_id, payload)] });
    fireEvent.click(screen.getByRole("button", { name: "Comprobar pedido pendiente" }));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull()); expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not erase a different UUID which appeared while a POST was in flight", async () => {
    const pending = deferredIntake<{ issue: WorkIssue }>(), create = mockIntakeCreate().mockReturnValue(pending.promise);
    render(<IssuesView />); fireEvent.submit(await fillIntake()); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]![0]; sessionStorage.setItem(PENDING_INTAKE_KEY, OTHER_REQUEST_ID);
    await act(async () => pending.resolve({ issue: intakeIssue(payload.request_id, payload) }));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(OTHER_REQUEST_ID);
    expect(screen.getByRole("button", { name: "Crear propuesta local", hidden: true })).toBeDisabled(); expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not let an unknown stored identity cancel a later valid one without reconciliation", async () => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, "PRIVATE_INVALID_STORED_DATA");
    const create = mockIntakeCreate(); render(<IssuesView />); await act(async () => {});
    expect(document.body.textContent).not.toContain("PRIVATE_INVALID_STORED_DATA");
    sessionStorage.setItem(PENDING_INTAKE_KEY, OTHER_REQUEST_ID);
    fireEvent.click(screen.getByRole("checkbox", { name: CANCEL_INTAKE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar intento pendiente" }));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(OTHER_REQUEST_ID); expect(create).not.toHaveBeenCalled();
    vi.mocked(api.getWorkIssues).mockResolvedValue({ issues: [intakeIssue(OTHER_REQUEST_ID)] });
    fireEvent.click(screen.getByRole("button", { name: "Comprobar pedido pendiente" }));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull()); expect(create).not.toHaveBeenCalled();
  });

  it("fences a read begun before POST from closing that pending intent", async () => {
    const lateRead = deferredIntake<{ issues: WorkIssue[] }>(), post = deferredIntake<{ issue: WorkIssue }>();
    const create = mockIntakeCreate().mockReturnValue(post.promise);
    render(<IssuesView />); const form = await fillIntake();
    vi.mocked(api.getWorkIssues).mockReturnValueOnce(lateRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" })); fireEvent.submit(form);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); const payload = create.mock.calls[0]![0];
    await act(async () => lateRead.resolve({ issues: [intakeIssue(payload.request_id, payload)] }));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id);
    expect(screen.getByRole("button", { name: "Cancelar intento pendiente" })).toBeDisabled();
    await act(async () => post.reject(new Error("Synthetic lost response")));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id);
  });

  it("fences an old reconciliation after cancellation and a new explicit intent", async () => {
    sessionStorage.setItem(PENDING_INTAKE_KEY, REQUEST_ID);
    const lateRead = deferredIntake<{ issues: WorkIssue[] }>(), post = deferredIntake<{ issue: WorkIssue }>(), create = mockIntakeCreate().mockReturnValue(post.promise);
    render(<IssuesView />); await act(async () => {});
    vi.mocked(api.getWorkIssues).mockReturnValueOnce(lateRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Comprobar pedido pendiente" }));
    fireEvent.click(screen.getByRole("checkbox", { name: CANCEL_INTAKE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar intento pendiente" }));
    await waitFor(() => expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBeNull());
    fireEvent.submit(await fillIntake()); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]![0];
    await act(async () => lateRead.resolve({ issues: [intakeIssue()] }));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id); expect(payload.request_id).not.toBe(REQUEST_ID);
    await act(async () => post.reject(new Error("Synthetic lost new response")));
  });

  it("retains the UUID after unmount even if its old POST later confirms", async () => {
    const post = deferredIntake<{ issue: WorkIssue }>(), create = mockIntakeCreate().mockReturnValue(post.promise);
    const view = render(<IssuesView />); fireEvent.submit(await fillIntake()); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]![0]; view.unmount();
    await act(async () => post.resolve({ issue: intakeIssue(payload.request_id, payload) }));
    expect(sessionStorage.getItem(PENDING_INTAKE_KEY)).toBe(payload.request_id); expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("T004 manual issue API contracts", () => {
  const body = (): KeyedIntakeInput => ({ request_id: REQUEST_ID, project_id: "alpha", title: "Synthetic API request", expected_outcome: "Keep one request.",
    acceptance_criteria: ["One identity persists."], authorized_scope: { expected_outcome: "Keep one request.", acceptance_criteria: ["One identity persists."],
      allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["test"], explicit_exclusions: [] } });
  function mockResponse(reply: unknown) {
    const fetcher = vi.fn(async (target: RequestInfo | URL, _init?: RequestInit) => {
      if (String(target) === "/api/session") return new Response(JSON.stringify({ token: "synthetic-intake-session" }), { status: 200 });
      return new Response(JSON.stringify(reply), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher); return fetcher;
  }

  it("sends the caller's UUID and exact payload rather than generating a new identity", async () => {
    const payload = body(), issue = intakeIssue(REQUEST_ID, payload), fetcher = mockResponse({ issue });
    expect(await api.createWorkIssue(payload)).toEqual({ issue });
    const post = fetcher.mock.calls.find(([target]) => String(target) === "/api/work-issues")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual(payload);
  });

  it.each([undefined, "", "A1111111-B222-4333-8444-E55555555555"])("refuses an absent or malformed explicit UUID before any HTTP mutation (%#)", async (requestId) => {
    const fetcher = mockResponse({});
    await expect(api.createWorkIssue({ ...body(), request_id: requestId } as KeyedIntakeInput)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["missing-receipt", "foreign-request", "foreign-project", "future-issue", "future-receipt", "missing-scope", "invalid-array"])("rejects an unsafe %s POST acknowledgement", async (kind) => {
    const payload = body(), issue = intakeIssue(REQUEST_ID, payload);
    if (kind === "missing-receipt") delete issue.intake_receipt;
    if (kind === "foreign-request") issue.intake_receipt!.request_id = OTHER_REQUEST_ID;
    if (kind === "foreign-project") issue.project_id = "beta";
    if (kind === "future-issue") (issue as unknown as Record<string, unknown>).schema_version = 2;
    if (kind === "future-receipt") (issue.intake_receipt as unknown as Record<string, unknown>).schema_version = 2;
    if (kind === "missing-scope") delete (issue as unknown as Record<string, unknown>).authorized_scope;
    if (kind === "invalid-array") (issue as unknown as Record<string, unknown>).acceptance_criteria = null;
    mockResponse({ issue }); await expect(api.createWorkIssue(payload)).rejects.toThrow();
  });

  it("accepts a complete GET collection with explicit historical receipt absence", async () => {
    vi.mocked(api.getWorkIssues).mockRestore();
    const legacy = intakeIssue(); delete legacy.intake_receipt; mockResponse({ issues: [legacy] });
    expect(await api.getWorkIssues()).toEqual({ issues: [legacy] });
  });

  it.each(["partial", "missing", "future", "duplicate-issue", "duplicate-request", "null-receipt", "missing-scope", "invalid-array"])("refuses a %s GET collection instead of claiming complete recovery coverage", async (kind) => {
    vi.mocked(api.getWorkIssues).mockRestore();
    const issue = intakeIssue(), response: Record<string, unknown> = { issues: [issue] };
    if (kind === "partial") response.next_cursor = "unobserved-page";
    if (kind === "missing") delete response.issues;
    if (kind === "future") (issue as unknown as Record<string, unknown>).schema_version = 2;
    if (kind === "duplicate-issue") response.issues = [issue, issue];
    if (kind === "duplicate-request") response.issues = [issue, { ...issue, id: `I-${OTHER_REQUEST_ID}` }];
    if (kind === "null-receipt") (issue as unknown as Record<string, unknown>).intake_receipt = null;
    if (kind === "missing-scope") delete (issue as unknown as Record<string, unknown>).authorized_scope;
    if (kind === "invalid-array") (issue as unknown as Record<string, unknown>).task_ids = null;
    mockResponse(response); await expect(api.getWorkIssues()).rejects.toThrow();
  });
});
