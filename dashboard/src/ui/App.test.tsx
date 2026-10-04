// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { OverviewModel, TodayModel } from "../../../lib/state/types";
import * as taskDetail from "./views/TaskDetailView";
import * as issueView from "./views/IssuesView";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";

const overview: OverviewModel = {
  projects: [{
    id: "stock-control", status: "active", health: "ok", note: null,
    repo: null, path: null, configured: false, git: null,
    last_activity: "2026-05-28T11:15:00Z",
    task_counts: { inProgress: 1, finished: 1 },
  }],
  inProgress: [{
    id: "STK-002", project: "stock-control", agent: "qa-reviewer",
    title: "Regression pass", lifecycle: "running", outcome: null,
    updated_at: "2026-05-28T11:15:00Z", finished_at: null, requires_human_approval: false,
    attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
  }],
  history: [],
  attention: [{ kind: "risk", task_id: "STK-001", project: "stock-control", title: "No rate limiting" }],
};

const today: TodayModel = {
  date: "2026-09-21", time_zone: "America/Buenos_Aires", generated_at: "2026-09-21T12:00:00Z",
  active: overview.inProgress, attention: overview.attention, completed: [], failed: [], cancelled: [],
  retries: [], cancellations: [], recoveries: [], warnings: [],
  counts: { active: 1, attention: 1, completed: 0, failed: 0, cancelled: 0, retries: 0 },
  portfolio: {
    signal_status: "unavailable", signals_observed_at: null, recommendations: [], critical_attention: [], work_to_continue: [],
    client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [],
    warnings: [], sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    }
    if (path === "/api/portfolio/profiles") return { ok: true, status: 200, json: async () => ({ profiles: [] }) };
    if (String(url).endsWith("/api/runs")) {
      return { ok: true, status: 200, json: async () => ({ runs: [] }) };
    }
    if (String(url).endsWith("/api/today")) {
      return { ok: true, status: 200, json: async () => today };
    }
    if (path === "/api/projects/stock-control/integrations") return { ok: true, status: 200, json: async () => ({
      schema_version: 2, project_id: "stock-control", observed_at: "2026-09-21T12:00:00Z", trace_id: null,
      source_control: { provider: "git", configured: false, health: "unconfigured", branch: null, dirty: null, uncommitted: null, ahead: null, behind: null,
        remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
      ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
      dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: "2026-09-21T12:00:00Z" },
      deployments: [],
    }) };
    if (path === "/api/signals") return { ok: true, status: 200, json: async () => ({ schema_version: 1, observed_at: "2026-09-21T12:00:00Z", signals: [], pinned_signal_ids: [], warnings: [] }) };
    if (path === "/api/activity") return { ok: true, status: 200, json: async () => ({ items: [] }) };
    if (path === "/api/projects/stock-control/notes") return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    return { ok: true, status: 200, json: async () => overview };
  }) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("App", () => {
  it.skipIf(process.env.SURTEC_WORKFLOW_UI_BROWSER_SMOKE !== "1")("accepts a bounded workflow through the isolated actual API/dashboard, task navigation, reload and API restart", async () => {
    vi.unstubAllGlobals();
    // Vite/esbuild needs Node's byte-array realm, not jsdom's window realm.
    // The actual UI runs in the isolated external browser, not this VM.
    vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
    const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path"), { spawn, execFileSync } = await import("node:child_process");
    const { createServer: createPortProbe } = await import("node:net");
    const { createServer } = await import("vite"), { chromium } = await import("playwright");
    const { cleanupSmoke, observeResponse } = await import("../../../scripts/playwright-local-app-smoke");
    const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve(".");
    let browser: Browser | null = null, vite: ViteDevServer | null = null, api: ChildProcess | null = null, exited = Promise.resolve();
    const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    async function temporaryUiPort(): Promise<number> {
      const probe = createPortProbe();
      await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      try { const address = probe.address(); if (!address || typeof address === "string") throw new Error("UI fixture requires a loopback TCP port"); return address.port; }
      finally { await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done())); }
    }
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-paid-runtime"), SURTEC_FIXTURE_ROOT: root });
    const runtime = join(root, "runtime");
    let output = "", stage = "fixture setup", effectCount = 0;
    async function startApi(): Promise<string> {
      output = "";
      api = spawn(process.execPath, ["--import", "tsx", "workflow-ui-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      exited = new Promise<void>((done) => { api!.once("exit", () => done()); api!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; api.stdout!.on("data", collect); api.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_WORKFLOW_UI_READY:(\d+)/);
        if (ready) return `http://127.0.0.1:${ready[1]}`;
        if (api.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`);
        await delay(200);
      }
      throw new Error(`Synthetic API readiness failed at ${stage}: ${output}`);
    }
    async function stopApi() {
      if (!api || api.exitCode !== null) return true;
      api.kill("SIGTERM");
      if (await Promise.race([exited.then(() => true), delay(8000).then(() => false)])) return true;
      api.kill("SIGKILL"); return Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects/alpha"), { recursive: true }); await mkdir(join(root, "empty-hooks"));
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) await cp(join(repoRoot, "registry", name), join(root, "registry", name));
      await cp(join(repoRoot, "evals"), join(root, "evals"), { recursive: true });
      await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha:\n    allowed_agents: [product-manager, backend-engineer, tech-lead, reality-checker, qa-reviewer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n");
      await writeFile(join(root, "projects/alpha/AGENTS.md"), "Synthetic private source body; never render it.\n");
      const git = (args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, ...args], { cwd: join(root, "projects/alpha"), env: environment, windowsHide: true, stdio: "pipe" });
      git(["init", "--quiet"]); git(["config", "user.name", "Synthetic UI Fixture"]); git(["config", "user.email", "fixture@example.invalid"]); git(["add", "AGENTS.md"]); git(["commit", "--quiet", "-m", "Synthetic fixture"]);
      await writeFile(join(runtime, "workflow-ui-api.ts"), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './dashboard/src/server/index';
import { createIssueService } from './dashboard/src/server/issue-service';
import { WorkflowOrchestrator } from './runner/workflow-orchestrator';
import { TaskOrchestrator } from './runner/task-orchestrator';
const root = process.env.SURTEC_FIXTURE_ROOT!, effects = join(root, 'synthetic-effects.json');
if (existsSync(process.env.SURTEC_CODEX_BIN!)) throw new Error('Paid runtime entry must not exist');
const issues = createIssueService(root, { projectIds: () => ['alpha'] });
if (!issues.list().length) issues.create({ project_id: 'alpha', title: 'Isolated workflow UI fixture', expected_outcome: 'Inspect bounded evidence', acceptance_criteria: ['Evidence retained'], assigned_role_id: 'backend-engineer', authorized_scope: { expected_outcome: 'Inspect bounded evidence', acceptance_criteria: ['Evidence retained'], allowed_path_patterns: ['src/**'], excluded_path_patterns: [], allowed_change_categories: ['ui'], explicit_exclusions: [] } });
const workflows = new WorkflowOrchestrator(root);
const executor = { async run(options: { mode: string }) {
  if (options.mode !== 'read-only') throw new Error('UI fixture forbids writer/model effects');
  const count = existsSync(effects) ? Number(readFileSync(effects, 'utf8')) : 0; writeFileSync(effects, String(count + 1));
  const structuredOutput = { schema_version: 1, kind: 'analysis', status: 'completed', summary: 'Synthetic read-only UI stage', evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: 'Acknowledge the bounded proposal', requested_decision: null, recommendations: ['Keep human acceptance explicit'] };
  return { structuredOutput, finalText: JSON.stringify(structuredOutput), threadId: 'synthetic-ui-thread', turnId: 'synthetic-ui-turn', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } };
} };
const worker = new TaskOrchestrator({ repoRoot: root, executor, workflows, pollMs: 50 });
worker.start();
const app = createApp(root, worker, undefined, undefined, { issues, workflows: workflows.service, inbox: async () => ({ items: [], repos: [] }) });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_WORKFLOW_UI_READY:' + (server.address() as { port: number }).port));
let stopping = false;
process.once('SIGTERM', () => { if (stopping) return; stopping = true; void worker.stop().then(() => server.close()); });
`);
      stage = "actual API start"; let apiUrl = await startApi();
      const uiPort = await temporaryUiPort();
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port: uiPort, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen();
      expect((vite.httpServer!.address() as { port: number }).port).toBe(uiPort);
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage(), pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("response", (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
      await page.goto(vite.resolvedUrls!.local[0]!); await page.getByRole("button", { name: /Issues/ }).click();
      const card = page.locator("article.work-issue-card").filter({ hasText: "Isolated workflow UI fixture" }); await card.getByRole("button", { name: "Ver workflow" }).click();
      const panel = page.getByRole("region", { name: "Workflow de Isolated workflow UI fixture" });
      stage = "preview invalidation without effects";
      const firstPreview = await observeResponse(page, "/api/workflows/preview", "POST", () => panel.getByRole("button", { name: "Previsualizar workflow", exact: true }).click());
      const previewProof = await firstPreview.json(); expect(firstPreview.status(), String(previewProof.error ?? "Preview HTTP response")).toBe(200);
      expect(previewProof.allowed, JSON.stringify(previewProof.blocked_reasons)).toBe(true);
      try { await panel.getByText("Workflow habilitado para este pedido.").waitFor({ timeout: 5000 }); }
      catch { throw new Error(`Preview rendering guard: ${await panel.getByRole("alert").textContent().catch(() => "no bounded alert")}`); }
      expect(await panel.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled()).toBe(true);
      await panel.getByLabel("Tokens máximos").fill("50000"); expect(await panel.getByRole("region", { name: "Preview de workflow" }).count()).toBe(0);
      await panel.getByRole("button", { name: "Actualizar workflow" }).click(); expect(await panel.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled()).toBe(true);
      expect(existsSync(join(root, "state/workflows/workflows.json"))).toBe(false); expect(existsSync(join(root, "synthetic-effects.json"))).toBe(false);
      await panel.getByRole("button", { name: "Previsualizar workflow", exact: true }).click(); await panel.getByText("Workflow habilitado para este pedido.").waitFor();
      await panel.getByRole("checkbox", { name: /Apruebo este template/ }).check();
      const started = await observeResponse(page, "/api/workflows/start", "POST", () => panel.getByRole("button", { name: "Iniciar workflow aprobado" }).click()); expect(started.status()).toBe(201);
      const owner = (await started.json()).workflow;
      stage = "human gate and task-to-workflow navigation";
      await panel.getByLabel("Motivo de la decisión").waitFor({ timeout: 20000 }); expect(await panel.getByRole("button", { name: "Aprobar decisión exacta" }).isDisabled()).toBe(true);
      expect(await card.getByRole("button", { name: "Despachar tarea aprobada" }).count()).toBe(0);
      await panel.getByText("Etapas, roles y consentimiento aprobado", { exact: true }).click();
      await panel.getByRole("button", { name: /^Ver tarea / }).first().click(); await page.getByRole("region", { name: "Workflow propietario" }).waitFor();
      await page.getByRole("button", { name: "Abrir workflow del issue" }).click(); await panel.getByLabel("Motivo de la decisión").waitFor();
      expect(await panel.getByRole("checkbox", { name: /Revisé esta decisión/ }).isChecked()).toBe(false);
      await panel.getByLabel("Motivo de la decisión").fill("Reviewed this exact synthetic proposal"); await panel.getByRole("checkbox", { name: /Revisé esta decisión/ }).check();
      await panel.getByRole("button", { name: "Actualizar workflow" }).click(); await panel.getByLabel("Motivo de la decisión").waitFor(); expect(await panel.getByLabel("Motivo de la decisión").inputValue()).toBe("");
      await panel.getByLabel("Motivo de la decisión").fill("Reviewed this exact synthetic proposal"); await panel.getByRole("checkbox", { name: /Revisé esta decisión/ }).check();
      const accepted = await observeResponse(page, `/api/workflows/${owner.id}/decision`, "POST", () => panel.getByRole("button", { name: "Aprobar decisión exacta" }).click()); expect(accepted.status()).toBe(200); expect((await accepted.json()).workflow.status).toBe("completed");
      const linked = await (await fetch(`${apiUrl}/api/work-issues/${owner.issue_id}`)).json(); expect(linked.issue.status).toBe("proposed");
      effectCount = Number(await readFile(join(root, "synthetic-effects.json"), "utf8")); expect(effectCount).toBe(1);
      stage = "responsive controls and reload";
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("button", { name: /Issues/ }).click(); await card.getByRole("button", { name: "Ver workflow" }).click(); await panel.getByLabel("Workflow registrado").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await page.getByText("Synthetic private source body; never render it.", { exact: false }).count()).toBe(0);
      expect(await panel.getByRole("button", { name: "Detener workflow" }).count()).toBe(0);
      const select = panel.getByLabel("Template de workflow"); expect(await select.evaluate((element) => { const option = element.querySelector("option")!; return getComputedStyle(option).color !== getComputedStyle(option).backgroundColor; })).toBe(true);
      stage = "API restart and retained terminal evidence";
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      // Detach the development client before intentionally stopping its servers.
      // Outage rendering is covered by the fail-closed UI fixtures, not HMR retries.
      await page.goto("about:blank");
      expect(await stopApi()).toBe(true); apiUrl = await startApi();
      // Replace only this owned Vite server, using another unique loopback port.
      await vite.close(); const restartedUiPort = await temporaryUiPort();
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port: restartedUiPort, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" }); await vite.listen();
      expect((vite.httpServer!.address() as { port: number }).port).toBe(restartedUiPort);
      expect((await fetch(`${apiUrl}/api/workflows/preview`, { method: "POST", headers: { "X-Surtec-Session": oldSession }, body: "{}" })).status).toBe(403);
      await page.goto(vite.resolvedUrls!.local[0]!); await page.getByRole("button", { name: /Issues/ }).click(); await card.getByRole("button", { name: "Ver workflow" }).click(); await panel.getByLabel("Workflow registrado").waitFor();
      expect((await (await fetch(`${apiUrl}/api/workflows/${owner.id}`)).json()).workflow.status).toBe("completed");
      expect(Number(await readFile(join(root, "synthetic-effects.json"), "utf8"))).toBe(1);
      expect(pageErrors, JSON.stringify(pageErrors).slice(0, 2000)).toEqual([]);
      expect(consoleErrors, JSON.stringify(consoleErrors).slice(0, 2000)).toEqual([]);
      expect(httpErrors, JSON.stringify(httpErrors).slice(0, 2000)).toEqual([]); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
    } catch (error) { throw new Error(`T012 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: api ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] });
      expect(existsSync(root)).toBe(false);
    }
  }, 120000);

  it("navigates task -> exact issue/workflow -> stage task and clears scope on sidebar navigation", async () => {
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onOpenWorkflow }) => <div>Scoped task {taskId}<button type="button" onClick={() => onOpenWorkflow?.({ issueId: "I-1", workflowId: "W-1", projectId: "stock-control" })}>Open scoped workflow</button></div>);
    const issues = vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <div aria-label="Scoped workflows">{workflowFocus ? `${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "No navigation scope"}<button type="button" onClick={() => onOpenTask?.("T-stage")}>Open stage task</button></div>);
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "STK-002" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open scoped workflow" })); await screen.findByText("stock-control/I-1/W-1");
    expect(issues.mock.calls.at(-1)?.[0]?.workflowFocus).toEqual({ issueId: "I-1", workflowId: "W-1", projectId: "stock-control" });
    fireEvent.click(screen.getByRole("button", { name: "Open stage task" })); await screen.findByText("Scoped task T-stage");
    fireEvent.click(screen.getByRole("button", { name: /Issues/ })); await screen.findByText("No navigation scope");
    expect(screen.queryByText("stock-control/I-1/W-1")).toBeNull();
  });
  it("opens on Today and can navigate to the portfolio overview", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Cockpit diario")).toBeTruthy());
    expect(screen.getAllByText(/STK-002/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    await waitFor(() => expect(screen.getByText("stock-control")).toBeTruthy());
    expect(screen.getAllByText(/STK-002/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No rate limiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Detalle operativo de stock-control" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Integraciones" })).toBeTruthy());
    expect(screen.getByText("Perfil y próximo paso")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sesiones de trabajo" })).toBeTruthy();
    expect(screen.getByText("Notas locales")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tareas activas" })).toBeTruthy();
  });

  it("shows the error banner when the overview fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => ({ projects: [] }) } as Response;
      }
      if (String(url).endsWith("/api/runs")) return { ok: true, status: 200, json: async () => ({ runs: [] }) } as Response;
      throw new Error("network down");
    }) as unknown as typeof fetch);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/No pude cargar Hoy/)).toBeTruthy());
  });
});
