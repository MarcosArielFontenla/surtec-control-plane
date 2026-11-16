// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectView } from "../../../../lib/state/types";
import type { ProjectIntegrationsSnapshot } from "../../../../lib/integrations/types";
import { projectOperatingView, type OperatingFact, type OperatingView } from "../../../../lib/operating-views";
import * as api from "../api";
import { ProjectReadinessPanel } from "./ProjectReadinessPanel";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";

const observed = "2026-10-15T12:00:00.000Z";
const project: ProjectView = { id: "alpha", status: "active", health: null, note: "PRIVATE_NOTE", repo: null, path: "D:/private/alpha", configured: true, git: null, last_activity: null, task_counts: { inProgress: 0, finished: 1 } };
function capability(projectId = "alpha"): api.DispatchProjectCapability {
  return { project: projectId, allowed_agents: ["engineer"], project_sandbox_ceiling: "read-only", has_local_checkout: true, has_verification_commands: false,
    agents: [{ agent: "engineer", agent_sandbox_ceiling: "read-only", allowed_modes: ["read-only"], default_mode: "read-only", modes: [{ mode: "read-only", allowed: true, reason: null }] }] };
}
function operating(id = "alpha"): OperatingView {
  const source = (items: OperatingFact[]) => ({ availability: "available", reason: "observed", origin: "saved", observed_at: observed, fresh_until: "2026-10-15T13:00:00.000Z", complete: true, items });
  return projectOperatingView({ schema_version: 1, as_of: "2026-10-16T12:00:00.000Z", sources: {
    projects: source([{ id, project_id: id, label: "Public project", state: "active", project_kind: "personal", objective_ids: [], primary_objective_id: null }]), objectives: source([]),
    issues: source([{ id: "I-exact", project_id: id, label: "Public issue", state: "blocked", decision_reason: "dependency-blocked" }]),
    executions: source([{ id: "T-exact", project_id: id, issue_id: "I-exact", label: "Public task", state: "finished", result_status: "completed" }]),
    workflows: source([{ id: "W-exact", project_id: id, issue_id: "I-exact", label: "Public workflow", state: "waiting-human", workflow_template_id: "implementation" }]),
    harness: source([{ id, project_id: id, label: "Public Harness", state: "healthy", validation_status: "passed" }]),
    sessions: source([{ id: "S-exact", project_id: id, label: "PRIVATE_SESSION_OBJECTIVE", summary: "PRIVATE_SESSION_NOTES", state: "paused" }]),
  } }, { kind: "project", id, page_size: 6 });
}
const integrations: ProjectIntegrationsSnapshot = { schema_version: 2, project_id: "alpha", observed_at: observed, trace_id: null,
  source_control: { provider: "git", configured: false, health: "unconfigured", branch: null, dirty: null, uncommitted: null, ahead: null, behind: null, remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
  ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main" }, dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observed }, deployments: [] };
beforeEach(() => {
  vi.spyOn(api, "getOperatingProject").mockResolvedValue(operating());
  vi.spyOn(api, "fetchDispatchOptions").mockResolvedValue({ projects: [capability()] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(extra: Partial<Parameters<typeof ProjectReadinessPanel>[0]> = {}) {
  const props = { project, integrations, integrationsLoading: false, integrationsUnavailable: false, onNavigate: vi.fn(), onOpenTask: vi.fn(), ...extra };
  return { ...render(<ProjectReadinessPanel {...props} />), props };
}
async function consult() {
  fireEvent.click(screen.getByRole("button", { name: "Consultar preparación" }));
  await screen.findByRole("region", { name: "Opciones registradas del proyecto" });
  const details = screen.queryByText("Evidencia local consultada y decisiones"); if (details) fireEvent.click(details);
}

describe("ProjectReadinessPanel", () => {
  it.skipIf(process.env.SURTEC_PROJECT_READINESS_BROWSER_SMOKE !== "1")("accepts project readiness and the existing protected daily loop with actual isolated API/Vite/browser, mobile and restart", async () => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
    const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path"), { spawn, execFileSync } = await import("node:child_process");
    const { createServer: probeServer } = await import("node:net");
    const { createServer } = await import("vite"), { chromium } = await import("playwright");
    const { cleanupSmoke, observeResponse, harnessTreeHash } = await import("../../../../scripts/playwright-local-app-smoke");
    const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(root, "runtime");
    let browser: Browser | null = null, vite: ViteDevServer | null = null, child: ChildProcess | null = null, exited = Promise.resolve();
    let output = "", stage = "setup";
    const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
    async function startApi(): Promise<string> {
      output = "";
      child = spawn(process.execPath, ["--import", "tsx", "readiness-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
      exited = new Promise<void>(done => { child!.once("exit", () => done()); child!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_READINESS_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
        if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`); await delay(200);
      }
      throw new Error(`Synthetic API readiness failed at ${stage}: ${output}`);
    }
    async function stopApi() {
      if (!child || child.exitCode !== null) return true;
      if (child.connected) child.send("stop");
      if (await Promise.race([exited.then(() => true), delay(8000).then(() => false)])) return true;
      child.kill("SIGKILL"); return Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    }
    async function startUi(apiUrl: string) {
      const probe = probeServer(); await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen(); return vite.resolvedUrls!.local[0]!;
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects")); await mkdir(join(root, "empty-hooks"));
      for (const id of ["alpha", "beta"]) {
        const path = join(root, "projects", id); await mkdir(path); await writeFile(join(path, "fixture.txt"), `Public ${id} sentinel\n`);
        execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, "init", "--quiet"], { cwd: path, env: environment, windowsHide: true, stdio: "pipe" });
      }
      await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n  beta: {}\n"); await writeFile(join(root, "registry/agents.yml"), "agents: []\n");
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(runtime, "readiness-api.ts"), `
import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createOrganizationService } from './dashboard/src/server/organization-service';
import { createIssueService } from './dashboard/src/server/issue-service';
import { mutateIssueDocument } from './lib/state/issues';
import { writeTask } from './lib/state/store';
import { emptyProjectProfile } from './lib/portfolio-profile';
import { upsertProjectProfile } from './lib/state/portfolio-profiles';
const root = process.env.SURTEC_FIXTURE_ROOT!, clock = () => new Date('2026-10-16T12:00:00.000Z');
const organization = createOrganizationService({ clock }), issues = createIssueService(root, { now: clock, projectIds: () => ['alpha', 'beta'] });
if (!existsSync(join(root, 'initialized'))) {
  organization.saveCompany({ schema_version: 1, id: 'surtec', display_name: 'Public readiness fixture', mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null });
  for (const id of ['alpha', 'beta']) upsertProjectProfile({ ...emptyProjectProfile(id), last_reviewed_at: '2026-10-16' });
  const expected = 'Inspect fictional daily evidence', criteria = ['Evidence remains inspectable'];
  const input = { project_id: 'alpha', title: 'Public daily issue', expected_outcome: expected, acceptance_criteria: criteria, assigned_role_id: 'backend-engineer', authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ['src/**'], excluded_path_patterns: [], allowed_change_categories: ['ui'], explicit_exclusions: [] } };
  const issue = issues.create(input), review = issues.create({ ...input, title: 'Public review issue' });
  writeTask({ envelope: { id: 'T-daily', source: 'dashboard', project: 'alpha', task_type: 'analysis', agent: 'backend-engineer', title: 'Public recorded task', instructions: 'SYNTHETIC_PRIVATE_TASK_BODY', repo_path: join(root, 'projects/alpha'), branch: 'main', sandbox: 'read-only', expected_outputs: [], requires_human_approval: true, metadata: { issue_id: issue.id } }, lifecycle: 'queued', outcome: null, created_at: clock().toISOString(), started_at: null, updated_at: clock().toISOString(), finished_at: null, result: null, logs_path: null });
  mutateIssueDocument(document => {
    document.issues[issue.id]!.task_ids.push('T-daily');
    const item = document.issues[review.id]!, id = 'C-' + randomUUID(), evidenceId = 'E-' + randomUUID();
    item.status = 'ready-for-review'; item.task_ids = ['T-historical-review']; item.candidate_ids = [id]; item.evidence_ids = [evidenceId];
    document.candidates[id] = { schema_version: 1, id, issue_id: item.id, task_id: 'T-historical-review', execution_id: 'run-historical', repository_id: 'alpha', base_revision: 'a'.repeat(40), candidate_revision: 'b'.repeat(40), diff_fingerprint: 'c'.repeat(64), changed_paths: ['src/fixture.ts'], scope_revision: item.scope_revision, created_at: item.updated_at, invalidated_at: null };
    document.evidence[evidenceId] = { schema_version: 1, id: evidenceId, issue_id: item.id, task_id: 'T-historical-review', execution_id: 'run-historical', candidate_id: id, candidate_revision: 'b'.repeat(40), diff_fingerprint: 'c'.repeat(64), scope_revision: item.scope_revision, kind: 'verification', label: 'Historical infrastructure check', reference: '/api/tasks/T-historical-review', status: 'passed', created_at: item.updated_at };
  }); writeFileSync(join(root, 'initialized'), 'owned records only; no worker/model');
}
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
const dependencies = { organization, issues, context: { roles: () => [], preview: forbidden }, integrations: { read: async (id: string) => ({ schema_version: 2, project_id: id, observed_at: clock().toISOString(), trace_id: null, source_control: { provider: 'git', configured: false, health: 'unconfigured', branch: null, dirty: null, uncommitted: null, ahead: null, behind: null, remote: { provider: 'github', configured: false, health: 'unconfigured', pull_requests: null, issues: null } }, ci: { provider: 'github-actions', configured: false, health: 'unconfigured', status: null, branch: null }, dependencies: { provider: 'npm', configured: false, health: 'unconfigured', outdated: null, observed_at: clock().toISOString() }, deployments: [] }), invalidate: forbidden }, signals: { read: async () => ({ schema_version: 1, observed_at: clock().toISOString(), signals: [], pinned_signal_ids: [], warnings: [] }), act: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_READINESS_READY:' + (server.address() as { port: number }).port));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
`);
      stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
      const unchangedPaths = ["organization/organization.json", "tasks/T-daily.json", "portfolio/projects.json"];
      const before = await Promise.all(unchangedPaths.map(path => readFile(join(root, "state", path), "utf8"))), sourceHash = await harnessTreeHash(join(root, "projects"));
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
      const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], mutations: string[] = [], reads: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`); else reads.push(path); });
      const panel = page.getByRole("region", { name: "Preparación del proyecto", exact: true });
      async function openProject(id = "alpha") { await page.getByRole("button", { name: /Overview/ }).click(); await page.getByRole("button", { name: `Detalle operativo de ${id}`, exact: true }).click(); await panel.waitFor(); await page.getByTestId("harness-status").waitFor(); }
      await page.goto(uiUrl); await openProject(); expect(reads.some(path => path.startsWith("/api/operating/"))).toBe(false);
      stage = "inert anchors and explicit saved-only preparation";
      const harnessReads = reads.filter(path => path.endsWith("/harness")).length;
      await panel.getByRole("link", { name: "Inspeccionar detalle Harness existente", exact: true }).press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("project-harness-alpha");
      await panel.getByRole("link", { name: "Ir a la sesión del proyecto", exact: true }).press("Enter"); expect(await page.evaluate(() => document.activeElement?.id)).toBe("project-sessions-alpha");
      const lookup = await observeResponse(page, "/api/operating/projects/alpha", "GET", () => panel.getByRole("button", { name: "Consultar preparación", exact: true }).click());
      expect(lookup.status()).toBe(200); expect(lookup.headers()["cache-control"]).toBe("no-store");
      await panel.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor(); await panel.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
      expect(await panel.getByText(/Sin comandos registrados; esto no impide/).count()).toBe(1); expect(await panel.getByText(/not-enabled/).count()).toBe(1);
      expect(reads.filter(path => path.endsWith("/harness"))).toHaveLength(harnessReads); expect(mutations).toEqual([]); expect(existsSync(join(root, "state/harness/profiles.json"))).toBe(false);
      stage = "existing issue selection, scope authorization and preview refusal";
      await panel.getByRole("button", { name: "Revisar o proponer issue", exact: true }).click(); await page.getByRole("region", { name: "Retorno al proyecto", exact: true }).waitFor();
      await page.getByText("Crear issue local", { exact: true }).click(); await page.getByRole("combobox", { name: "Repositorio local", exact: true }).selectOption("beta"); await page.getByRole("combobox", { name: "Repositorio local", exact: true }).selectOption("alpha");
      const issueCard = page.locator("article.work-issue-card").filter({ has: page.getByRole("heading", { name: "Public daily issue", exact: true }) });
      await issueCard.waitFor(); const issueId = (await issueCard.getAttribute("id"))!.replace("work-issue-", "");
      expect(mutations).toEqual([]); const authorized = await observeResponse(page, `/api/work-issues/${issueId}/authorize`, "POST", () => issueCard.getByRole("button", { name: "Autorizar scope exacto", exact: true }).click()); expect(authorized.status()).toBe(200);
      await issueCard.getByRole("button", { name: "Previsualizar contexto del issue", exact: true }).waitFor();
      expect(await issueCard.getByRole("button", { name: "Previsualizar contexto del issue", exact: true }).isDisabled()).toBe(true);
      expect(await issueCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).isDisabled()).toBe(true);
      await issueCard.getByRole("button", { name: "Ver linaje y evidencia", exact: true }).click(); await issueCard.getByRole("button", { name: "Ver tarea T-daily", exact: true }).click();
      await page.getByRole("heading", { name: "Public recorded task", exact: true }).waitFor(); await page.getByRole("button", { name: "Volver", exact: true }).click(); await issueCard.waitFor();
      await page.getByRole("button", { name: "Volver al proyecto alpha", exact: true }).click(); await panel.waitFor();
      stage = "exact candidate review remains an existing human gate";
      await panel.getByRole("button", { name: "Consultar preparación", exact: true }).click(); await panel.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor(); await panel.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
      const reviewRecord = (await (await fetch(`${apiUrl}/api/work-issues`)).json()).issues.find((issue: { title: string }) => issue.title === "Public review issue");
      await panel.getByRole("button", { name: `Revisar issue ${reviewRecord.id}`, exact: true }).click(); await page.getByRole("region", { name: "Referencia de issue", exact: true }).getByText(`Proyecto alpha · Issue ${reviewRecord.id}`, { exact: true }).waitFor();
      const reviewCard = page.locator(`#work-issue-${reviewRecord.id}`); await reviewCard.getByRole("button", { name: "Revisar candidato", exact: true }).click(); await reviewCard.getByText(/Vigencia Git no comprobada/).waitFor();
      expect(await reviewCard.getByRole("button", { name: "Aceptar este candidato local", exact: true }).isDisabled()).toBe(true);
      expect(await reviewCard.getByRole("checkbox", { name: "Evidence remains inspectable", exact: true }).isChecked()).toBe(false);
      await page.getByRole("button", { name: "Volver al proyecto alpha", exact: true }).click(); await panel.waitFor();
      stage = "explicit session start, pause, resume and recorded closure";
      const sessions = page.locator("#project-sessions-alpha"); await panel.getByRole("link", { name: "Ir a la sesión del proyecto", exact: true }).click();
      await sessions.getByRole("textbox", { name: "Objetivo de la sesión", exact: true }).fill("SYNTHETIC_PRIVATE_SESSION_OBJECTIVE");
      const started = await observeResponse(page, "/api/sessions", "POST", () => sessions.getByRole("button", { name: "Iniciar sesión", exact: true }).click()); expect(started.status()).toBe(201); const sessionId = (await started.json()).session.id as string;
      await sessions.getByLabel("Próximo paso al pausar", { exact: true }).fill("Inspect the recorded next step");
      const paused = await observeResponse(page, `/api/sessions/${sessionId}/action`, "POST", () => sessions.getByRole("button", { name: "Pausar sesión", exact: true }).click()); expect(paused.status()).toBe(200);
      await sessions.getByRole("button", { name: "Reanudar sesión", exact: true }).waitFor();
      const resumed = await observeResponse(page, `/api/sessions/${sessionId}/action`, "POST", () => sessions.getByRole("button", { name: "Reanudar sesión", exact: true }).click()); expect(resumed.status()).toBe(200);
      await sessions.getByRole("button", { name: "Pausar sesión", exact: true }).waitFor(); await sessions.getByText("Completar sesión", { exact: true }).click(); await sessions.getByRole("textbox", { name: "Resultado", exact: true }).fill("Inspected evidence; no task executed");
      await sessions.getByRole("textbox", { name: "Próximo paso", exact: true }).fill("Review the next fictional issue");
      const completed = await observeResponse(page, `/api/sessions/${sessionId}/action`, "POST", () => sessions.getByRole("button", { name: "Guardar cierre", exact: true }).click()); expect(completed.status()).toBe(200);
      expect((await completed.json()).session.status).toBe("completed");
      await sessions.locator(".work-session-result").filter({ hasText: "Inspected evidence; no task executed" }).waitFor();
      await panel.getByRole("button", { name: "Consultar preparación", exact: true }).click(); await panel.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor();
      expect(await panel.innerText()).not.toMatch(/SYNTHETIC_PRIVATE/);
      stage = "mobile, optional personal evidence and project-local drafts";
      await page.setViewportSize({ width: 390, height: 844 }); await panel.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await panel.getByRole("button", { name: "Consultar preparación", exact: true }).boundingBox())!.width).toBeLessThan(350);
      await sessions.getByRole("textbox", { name: "Objetivo de la sesión", exact: true }).fill("UNSAVED_ALPHA_DRAFT");
      await openProject("beta"); expect(await page.locator("#project-sessions-beta").getByRole("textbox", { name: "Objetivo de la sesión", exact: true }).inputValue()).toBe("");
      await panel.getByRole("button", { name: "Consultar preparación", exact: true }).click(); await panel.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor(); await panel.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
      expect(await panel.getByText(/Alineación canónica: intentionally-unaligned/).count()).toBe(1); expect(await panel.getByRole("button", { name: "Revisar o proponer issue", exact: true }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      stage = "reload preserves the recorded session closure";
      await page.reload(); await openProject(); await sessions.locator(".work-session-result").filter({ hasText: "Inspected evidence; no task executed" }).waitFor();
      const issueBytes = await readFile(join(root, "state/issues/issues.json"), "utf8"), sessionBytes = await readFile(join(root, "state/sessions/work-sessions.json"), "utf8");
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      stage = "restart, retained records and old-session refusal";
      await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUi = await startUi(apiUrl);
      expect((await fetch(`${apiUrl}/api/sessions`, { method: "POST", headers: { "X-Surtec-Session": oldSession }, body: "{}" })).status).toBe(403);
      await page.goto(restartedUi); await openProject(); await sessions.locator(".work-session-result").filter({ hasText: "Inspected evidence; no task executed" }).waitFor();
      expect(await readFile(join(root, "state/issues/issues.json"), "utf8")).toBe(issueBytes); expect(await readFile(join(root, "state/sessions/work-sessions.json"), "utf8")).toBe(sessionBytes);
      expect(await Promise.all(unchangedPaths.map(path => readFile(join(root, "state", path), "utf8")))).toEqual(before); expect(await harnessTreeHash(join(root, "projects"))).toBe(sourceHash);
      expect(mutations).toEqual([`POST /api/work-issues/${issueId}/authorize`, "POST /api/sessions", ...Array.from({ length: 3 }, () => `POST /api/sessions/${sessionId}/action`)]);
      expect(reads.some(path => /\/open$/.test(path))).toBe(false); expect(existsSync(join(root, "state/harness/profiles.json"))).toBe(false);
      expect(existsSync(join(root, "forbidden-effect"))).toBe(false); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
      expect(pageErrors, JSON.stringify(pageErrors)).toEqual([]); expect(httpErrors, JSON.stringify(httpErrors)).toEqual([]); expect(consoleErrors, JSON.stringify(consoleErrors)).toEqual([]);
    } catch (error) { throw new Error(`Q T008 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
    }
  }, 120000);
  it("reuses matching integration observations without reading, refreshing, exposing paths or granting execution on render", () => {
    mount(); const panel = screen.getByRole("region", { name: "Preparación del proyecto" });
    expect(panel).toHaveTextContent("Preparado para inspeccionar no significa autorizado para ejecutar");
    expect(panel).toHaveTextContent("CI ok / passing"); expect(panel.querySelector("time")).toHaveAttribute("dateTime", observed);
    expect(api.getOperatingProject).not.toHaveBeenCalled(); expect(api.fetchDispatchOptions).not.toHaveBeenCalled();
    expect(panel.textContent).not.toMatch(/PRIVATE|D:\/private/); expect(panel).toHaveTextContent("not-enabled"); expect(panel).toHaveTextContent("deferred");
    expect(within(panel).queryByRole("button", { name: /Ejecutar|Activar|Autorizar|Despachar|Aplicar/ })).toBeNull();
  });
  it("consults only explicit bounded local reads and distinguishes configured verification, saved Harness and effective policy", async () => {
    const harness = vi.spyOn(api, "getProjectHarness"), preview = vi.spyOn(api, "previewContext"), dispatch = vi.spyOn(api, "createTask"), providers = vi.spyOn(api, "getProjectIntegrations");
    mount(); await consult();
    expect(api.getOperatingProject).toHaveBeenCalledExactlyOnceWith("alpha", { page_size: 6 }); expect(api.fetchDispatchOptions).toHaveBeenCalledOnce();
    expect(screen.getByText(/Sin comandos registrados; esto no impide por sí solo el análisis/)).toBeInTheDocument();
    expect(screen.getByText(/Estado healthy · validación registrada passed/)).toBeInTheDocument();
    expect(screen.getByText(/no exponen fecha de observación/)).toBeInTheDocument(); expect(screen.getByText(/no es un grant de ejecución/)).toBeInTheDocument();
    expect(screen.getByText(/issues: available · stale · cobertura complete/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("PRIVATE_SESSION");
    expect(harness).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(providers).not.toHaveBeenCalled();
  });
  it("uses exact issue/workflow/task references and native anchors, never issuing a mutation", async () => {
    const { props } = mount(); await consult();
    fireEvent.click(screen.getByRole("button", { name: "Revisar issue I-exact" })); expect(props.onNavigate).toHaveBeenCalledWith({ kind: "issue", id: "I-exact", projectId: "alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Revisar workflow W-exact" })); expect(props.onNavigate).toHaveBeenCalledWith({ kind: "workflow", id: "W-exact", issueId: "I-exact", projectId: "alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Inspeccionar tarea T-exact" })); expect(props.onOpenTask).toHaveBeenCalledWith("T-exact");
    fireEvent.click(screen.getByRole("button", { name: "Revisar o proponer issue" })); expect(props.onNavigate).toHaveBeenCalledWith({ kind: "issues", projectId: "alpha" });
    expect(screen.getByRole("link", { name: "Ir a la sesión del proyecto" })).toHaveAttribute("href", "#project-sessions-alpha");
    expect(screen.getByRole("link", { name: "Inspeccionar detalle Harness existente" })).toHaveAttribute("href", "#project-harness-alpha");
    expect(screen.getByText(/Motivo: Dependencia bloqueante/)).toBeInTheDocument();
    expect(screen.getByText(/Finalizar tareas, CI saludable y URLs no aceptan un issue/)).toBeInTheDocument();
  });
  it("retains partial coverage, unknown totals and off-page evidence instead of claiming zero blockers", async () => {
    const view = operating(), issues = view.sections.find(section => section.kind === "issues")!;
    issues.source = { ...issues.source, complete: false, reason: "coverage-incomplete" }; issues.coverage = "partial"; issues.total = null; issues.rows = []; issues.has_more = true;
    vi.mocked(api.getOperatingProject).mockResolvedValue(view); mount(); await consult();
    expect(screen.getByText(/issues: available · stale · cobertura partial.*total desconocido.*hay más registros/)).toBeInTheDocument();
    expect(screen.getByText(/no demuestra ausencia de bloqueos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revisar o proponer issue" })).toBeEnabled();
  });
  it("does not substitute a registered project for an unregistered discovered repository", async () => {
    vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [capability("beta")] }); mount(); await consult();
    expect(screen.getByText(/Proyecto no registrado en opciones/)).toBeInTheDocument(); expect(document.body.textContent).not.toContain("beta");
    expect(screen.getByRole("button", { name: "Revisar issue I-exact" })).toBeEnabled();
  });
  it.each(["view", "options", "both"])("isolates a failed %s source without exposing its exception or blocking personal inspection", async failing => {
    if (failing !== "options") vi.mocked(api.getOperatingProject).mockRejectedValue(new Error("PRIVATE_READ D:/private/state.json"));
    if (failing !== "view") vi.mocked(api.fetchDispatchOptions).mockRejectedValue(new Error("PRIVATE_OPTIONS"));
    mount({ project: { ...project, configured: false, path: null } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar preparación" })); await screen.findByText(/Una fuente de preparación no pudo confirmarse/);
    expect(document.body.textContent).not.toMatch(/PRIVATE_READ|PRIVATE_OPTIONS|D:\/private/);
    expect(screen.getByRole("button", { name: "Revisar o proponer issue" })).toBeEnabled(); expect(screen.getByRole("link", { name: "Ir a la sesión del proyecto" })).toBeInTheDocument();
    if (failing === "view") expect(screen.getByRole("region", { name: "Opciones registradas del proyecto" })).toBeInTheDocument();
    if (failing === "options") { fireEvent.click(screen.getByText("Evidencia local consultada y decisiones")); expect(screen.getByRole("button", { name: "Revisar issue I-exact" })).toBeInTheDocument(); }
  });
  it.each(["foreign-focus", "future-version", "cross-project", "missing-issue"])("does not infer a local issue/workflow from %s evidence", async mismatch => {
    const view = operating();
    if (mismatch === "foreign-focus") view.focus_id = "beta";
    if (mismatch === "future-version") (view as unknown as { schema_version: number }).schema_version = 2;
    if (mismatch === "cross-project") for (const section of view.sections) for (const row of section.rows) row.lineage.gaps.push("cross-project");
    if (mismatch === "missing-issue") for (const section of view.sections.filter(section => ["issues", "workflows"].includes(section.kind))) { section.rows = []; }
    vi.mocked(api.getOperatingProject).mockResolvedValue(view); mount(); await consult();
    expect(screen.queryByRole("button", { name: "Revisar issue I-exact" })).toBeNull(); expect(screen.queryByRole("button", { name: "Revisar workflow W-exact" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revisar o proponer issue" })).toBeEnabled();
  });
  it.each([null, { ...capability(), has_verification_commands: "yes" }, { ...capability(), agents: [null] }])("fails malformed exact options closed while retaining the valid operating source", async value => {
    vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [value] } as unknown as api.DispatchOptions); mount();
    fireEvent.click(screen.getByRole("button", { name: "Consultar preparación" }));
    await screen.findByText(/Una fuente de preparación no pudo confirmarse/);
    fireEvent.click(screen.getByText("Evidencia local consultada y decisiones")); expect(screen.getByRole("button", { name: "Revisar issue I-exact" })).toBeInTheDocument();
  });
  it("shows the concrete missing-checkout restriction without treating an optional goal/Harness as a blocker", async () => {
    const value = capability(); value.has_local_checkout = false; value.agents[0]!.modes[0]!.allowed = false;
    vi.mocked(api.fetchDispatchOptions).mockResolvedValue({ projects: [value] }); mount(); await consult();
    expect(screen.getByText(/Restricción registrada: falta checkout Git local contenido/)).toBeInTheDocument();
    expect(screen.getByText(/Objetivo, cliente y Harness son opcionales/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Revisar o proponer issue" })).toBeEnabled();
  });
  it("rejects a foreign integration snapshot and marks a retained snapshot as historical after a failed refresh", () => {
    const { rerender, props } = mount({ integrations: { ...integrations, project_id: "beta" } }); expect(screen.queryByText(/CI ok \/ passing/)).toBeNull();
    rerender(<ProjectReadinessPanel {...props} integrations={integrations} integrationsUnavailable />);
    expect(screen.getByText(/falló la lectura posterior; snapshot anterior/)).toBeInTheDocument();
  });
  it("fences late reads across project changes and never carries profile state back to another project", async () => {
    let finish!: (value: OperatingView) => void;
    vi.mocked(api.getOperatingProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender, props } = mount(); fireEvent.click(screen.getByRole("button", { name: "Consultar preparación" }));
    rerender(<ProjectReadinessPanel {...props} project={{ ...project, id: "beta" }} />);
    await act(async () => finish(operating()));
    expect(screen.queryByText("Evidencia local consultada y decisiones")).toBeNull(); expect(document.body.textContent).not.toContain("I-exact");
    expect(screen.getByRole("link", { name: "Ir a la sesión del proyecto" })).toHaveAttribute("href", "#project-sessions-beta");
  });
});
