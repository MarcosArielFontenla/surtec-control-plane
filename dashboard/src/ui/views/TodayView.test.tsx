// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Signal } from "../../../../lib/signals/types";
import type { ProjectView, TodayModel } from "../../../../lib/state/types";
import { getContextRoles, getOperatingProject, postSignalAction } from "../api";
import { projectOperatingView, type OperatingFact, type OperatingView } from "../../../../lib/operating-views";
import { RoutinePanel } from "../components/RoutinePanel";
import { TodayView } from "./TodayView";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";

vi.mock("../api", () => ({ postSignalAction: vi.fn().mockResolvedValue({}), getOperatingProject: vi.fn(), getContextRoles: vi.fn() }));
vi.mock("../components/RoutinePanel", () => ({
  RoutinePanel: vi.fn(({ projects, refreshKey }: { projects: ProjectView[]; refreshKey: string }) => (
    <section aria-label="Routine integration fixture" data-testid="routine-panel" data-refresh-key={refreshKey}>
      {projects.map(({ id }) => id).join(", ")}
    </section>
  )),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOperatingProject).mockRejectedValue(new Error("Synthetic missing lineage"));
  vi.mocked(getContextRoles).mockRejectedValue(new Error("Synthetic missing profiles"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const task = {
  id: "T-1", project: "alpha", agent: "engineer", title: "Ship evidence", lifecycle: "running" as const,
  outcome: null, updated_at: "2026-09-21T12:00:00Z", finished_at: null, requires_human_approval: true,
  attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
};

const project: ProjectView = {
  id: "alpha", status: "active", health: null, note: null, repo: null, path: null, configured: false,
  git: null, last_activity: null, task_counts: { inProgress: 0, finished: 0 },
};

function signal(number: number, over: Partial<Signal> = {}): Signal {
  return {
    schema_version: 1, id: `sig_${number.toString(16).padStart(24, "0")}`, project_id: `project-${number}`,
    project_kind: "client-product", source: "profile", type: "deadline-approaching", severity: "warning",
    title: `Deadline recommendation ${number}`, reason: `Deadline evidence ${number} is due soon.`,
    evidence_at: "2026-09-21T11:00:00Z", observed_at: "2026-09-21T12:00:00Z",
    suggested_action: "Review the recorded next step.", action_kind: "review-deadline",
    ranking: { tier: "imminent-deadline", order: 4 }, state: "open", snoozed_until: null,
    evidence: { deadline: "2026-09-22", days_remaining: 1 }, ...over,
  };
}

function model(signals: Signal[] = [], over: Partial<TodayModel> = {}): TodayModel {
  const visible = signals.slice(0, 3);
  return {
    date: "2026-09-21", time_zone: "America/Buenos_Aires", generated_at: "2026-09-21T12:00:00Z",
    active: [task], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [], warnings: [],
    counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
    portfolio: {
      signal_status: "available", signals_observed_at: "2026-09-21T12:00:00Z", recommendations: visible,
      critical_attention: [], work_to_continue: [], client_commitments: visible, personal_opportunities: [], stale_profiles: [],
      snoozed_signals: [], pinned_signal_ids: [], warnings: [],
      sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
    },
    ...over,
  };
}

function operating(projectId = "alpha", personal = false): OperatingView {
  const source = (items: OperatingFact[]) => ({ availability: "available", reason: "observed", origin: "saved", observed_at: "2026-09-20T12:00:00Z", fresh_until: "2026-09-20T13:00:00Z", complete: true, items });
  return projectOperatingView({ schema_version: 1, as_of: "2026-09-21T12:00:00Z", sources: {
    projects: source([{ id: projectId, label: "Public project", state: "active", project_kind: personal ? "personal" : "client-product", objective_ids: [], primary_objective_id: null }]),
    objectives: source([]),
    issues: source(personal ? [] : [{ id: "I-local", label: "Public local issue", state: "working", project_id: projectId, objective_id: null }]),
    executions: source(personal ? [] : [{ id: "T-1", label: "Public task", state: "finished", result_status: "completed", project_id: projectId, issue_id: "I-local", role_id: "software-engineer" }]),
    workflows: source(personal ? [] : [{ id: "W-exact", label: "Public workflow", state: "waiting-human", project_id: projectId, issue_id: "I-local", workflow_template_id: "implementation", role_id: "reviewer" }]),
  } }, { kind: "project", id: projectId, page_size: 20 });
}

describe("TodayView", () => {
  it.skipIf(process.env.SURTEC_TODAY_LINEAGE_BROWSER_SMOKE !== "1")("accepts Today lineage, exact navigation and generic prefills with isolated actual API/Vite/browser, mobile and restart", async () => {
    vi.unstubAllGlobals();
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
      child = spawn(process.execPath, ["--import", "tsx", "today-lineage-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
      exited = new Promise<void>(done => { child!.once("exit", () => done()); child!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_TODAY_LINEAGE_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
        if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`);
        await delay(200);
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
      const probe = probeServer();
      await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen(); return vite.resolvedUrls!.local[0]!;
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects")); await mkdir(join(root, "empty-hooks"));
      for (const id of ["alpha", "beta", "gamma"]) {
        const path = join(root, "projects", id); await mkdir(path);
        await writeFile(join(path, "fixture.txt"), `Public ${id} source sentinel; navigation must not modify this file.\n`);
        execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, "init", "--quiet"], { cwd: path, env: environment, windowsHide: true, stdio: "pipe" });
      }
      await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n  beta: {}\n"); await writeFile(join(root, "registry/agents.yml"), "agents: []\n");
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(runtime, "today-lineage-api.ts"), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createOrganizationService } from './dashboard/src/server/organization-service';
import { createIssueService } from './dashboard/src/server/issue-service';
import { mutateIssueDocument } from './lib/state/issues';
import { writeTask } from './lib/state/store';
import { emptyProjectProfile } from './lib/portfolio-profile';
import { upsertProjectProfile } from './lib/state/portfolio-profiles';
import type { Signal, SignalFeed } from './lib/signals/types';
const root = process.env.SURTEC_FIXTURE_ROOT!, clock = () => new Date('2026-10-16T12:00:00.000Z');
const organization = createOrganizationService({ clock });
const issues = createIssueService(root, { now: clock, projectIds: () => ['alpha', 'beta'] });
if (!existsSync(join(root, 'initialized'))) {
  const objective = organization.createObjective({ title: 'Public daily objective', desired_outcome: 'Inspect daily evidence', success_criteria: ['Preserve authority'], status: 'active', horizon: 'quarter', priority: 3, target_date: null, parent_objective_id: null });
  organization.setProjectObjectives('alpha', [objective.id], objective.id);
  for (const id of ['alpha', 'beta', 'gamma']) upsertProjectProfile({ ...emptyProjectProfile(id), kind: id === 'alpha' ? 'client-product' : 'personal', last_reviewed_at: '2026-10-16' });
  const expected = 'Inspect fictional work', criteria = ['Keep evidence inspectable'];
  const issue = issues.create({ project_id: 'alpha', objective_id: objective.id, title: 'Public daily issue', expected_outcome: expected, acceptance_criteria: criteria, assigned_role_id: 'backend-engineer', authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ['src/**'], excluded_path_patterns: [], allowed_change_categories: ['ui'], explicit_exclusions: [] } });
  writeTask({ envelope: { id: 'T-linked', source: 'dashboard', project: 'alpha', task_type: 'analysis', agent: 'backend-engineer', title: 'Public daily task', instructions: 'SYNTHETIC_PRIVATE_TASK_BODY', repo_path: join(root, 'projects/alpha'), branch: 'main', sandbox: 'read-only', expected_outputs: [], requires_human_approval: true, metadata: { issue_id: issue.id } }, lifecycle: 'queued', outcome: null, created_at: clock().toISOString(), started_at: null, updated_at: clock().toISOString(), finished_at: null, result: null, logs_path: null });
  mutateIssueDocument(document => { const stored = document.issues[issue.id]!; stored.task_ids.push('T-linked'); stored.updated_at = clock().toISOString(); stored.revision++; });
  writeFileSync(join(root, 'initialized'), 'owned synthetic records only; no worker');
}
const objectiveId = organization.read().objectives[0]!.id;
const signal = (id: string, project: string, source: Signal['source'], evidence: Record<string, unknown>, order: number): Signal => ({ schema_version: 1, id, project_id: project, project_kind: project === 'alpha' ? 'client-product' : project === 'beta' ? 'personal' : null, source, type: 'synthetic-observation', severity: 'info', title: 'Public recommendation ' + order, reason: 'Inspect recorded evidence', evidence_at: '2027-01-01T00:00:00.000Z', observed_at: clock().toISOString(), suggested_action: 'Inspect without authorizing execution', action_kind: 'review-evidence', ranking: { tier: 'unfinished-work', order }, state: 'open', snoozed_until: null, evidence });
const feed: SignalFeed = { schema_version: 1, observed_at: clock().toISOString(), pinned_signal_ids: [], warnings: [], signals: [signal('sig_daily_task', 'alpha', 'task', { task_id: 'T-linked', primary_objective_id: objectiveId, private_context: 'SYNTHETIC_PRIVATE_SIGNAL_BODY' }, 1), signal('sig_daily_personal', 'beta', 'profile', {}, 2), signal('sig_daily_objective', 'surtec', 'objective', { objective_id: objectiveId }, 3), signal('sig_daily_unregistered', 'gamma', 'profile', { private_context: 'SYNTHETIC_PRIVATE_UNREGISTERED_BODY' }, 4)] };
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
const integrations = { schema_version: 2, project_id: 'alpha', observed_at: clock().toISOString(), trace_id: null, source_control: { provider: 'git', configured: false, health: 'unconfigured', branch: null, dirty: null, uncommitted: null, ahead: null, behind: null, remote: { provider: 'github', configured: false, health: 'unconfigured', pull_requests: null, issues: null } }, ci: { provider: 'github-actions', configured: false, health: 'unconfigured', status: null, branch: null }, dependencies: { provider: 'npm', configured: false, health: 'unconfigured', outdated: null, observed_at: clock().toISOString() }, deployments: [] };
const dependencies = { organization, issues, context: { roles: () => [{ id: 'backend-engineer', display_name: 'Registered engineering profile', responsibility: 'Scoped synthetic work', sandbox_ceiling: 'workspace-write', agents: ['backend-engineer'] }], preview: forbidden }, integrations: { read: async (id: string) => ({ ...integrations, project_id: id }), invalidate: forbidden }, signals: { read: async () => feed, act: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_TODAY_LINEAGE_READY:' + (server.address() as { port: number }).port));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
`);
      stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
      const statePaths = ["organization/organization.json", "issues/issues.json", "tasks/T-linked.json", "portfolio/projects.json"];
      const before = await Promise.all(statePaths.map(path => readFile(join(root, "state", path), "utf8")));
      const projectsHash = await harnessTreeHash(join(root, "projects"));
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
      const pageErrors: string[] = [], consoleErrors: { message: string; path: string }[] = [], httpErrors: string[] = [], mutations: string[] = [], reads: string[] = [];
      const resourcePath = (url: string) => { try { const parsed = new URL(url); return parsed.pathname + parsed.search; } catch { return "unknown"; } };
      page.on("pageerror", error => pageErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push({ message: message.text(), path: resourcePath(message.location().url) }); });
      page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${resourcePath(response.url())}`); });
      page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`); else reads.push(path); });
      await page.goto(uiUrl);
      const card = page.getByRole("article", { name: "Recomendación sig_daily_task", exact: true }); await card.waitFor();
      expect(await page.locator(".today-portfolio-section").filter({ has: page.getByRole("heading", { name: "Ahora · recomendaciones principales", exact: true }) }).getByRole("article").count()).toBe(3);
      expect(reads.some(path => path.startsWith("/api/operating/") || path.includes("/context/roles"))).toBe(false);
      expect(await card.locator('time[datetime="2027-01-01T00:00:00.000Z"]').count()).toBe(1);
      stage = "on-demand exact issue lineage and registered profiles";
      await card.getByText("Linaje y perfiles · consultar evidencia", { exact: true }).click();
      const lineageResponse = await observeResponse(page, "/api/operating/projects/alpha", "GET", () => card.getByRole("button", { name: "Consultar linaje y perfiles", exact: true }).click());
      expect(lineageResponse.status()).toBe(200); expect(lineageResponse.headers()["cache-control"]).toBe("no-store");
      await card.getByRole("region", { name: "Perfiles registrados de sig_daily_task", exact: true }).waitFor();
      expect(await card.getByText(/Registered engineering profile/).count()).toBe(1);
      expect(await card.getByText(/no confirma el task kind, scope, consentimiento, presupuesto/).count()).toBe(1);
      const issueButton = card.getByRole("button", { name: /^Ver issue I-/ }); await issueButton.waitFor();
      const issueId = (await issueButton.innerText()).replace("Ver issue ", "");
      await issueButton.click(); await page.getByRole("region", { name: "Referencia de issue", exact: true }).getByText(`Proyecto alpha · Issue ${issueId}`, { exact: true }).waitFor();
      await page.locator(`#work-issue-${issueId}`).getByText("Public daily issue", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver a Hoy", exact: true }).click(); await card.waitFor();
      stage = "in-app project, task, objective and exact returns";
      await card.getByRole("button", { name: "Abrir proyecto", exact: true }).click(); await page.getByRole("heading", { name: "Detalle operativo", exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver a Hoy", exact: true }).click(); await card.getByRole("button", { name: "Ver tarea", exact: true }).click();
      await page.getByRole("heading", { name: "Public daily task", exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver", exact: true }).click(); await card.waitFor();
      await page.getByRole("article", { name: "Recomendación sig_daily_objective", exact: true }).getByRole("button", { name: "Abrir SURTEC", exact: true }).click();
      await page.getByRole("region", { name: "Detalle de objetivo", exact: true }).getByRole("heading", { name: "Public daily objective", exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver a Hoy", exact: true }).click();
      expect(httpErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(pageErrors).toEqual([]);
      stage = "discovered but unregistered project never substitutes a prefill";
      const unregistered = page.getByRole("article", { name: "Recomendación sig_daily_unregistered", exact: true });
      const optionsRead = await observeResponse(page, "/api/dispatch-options", "GET", () => unregistered.getByRole("button", { name: "Preparar tarea", exact: true }).click());
      expect(optionsRead.status()).toBe(200); expect((await optionsRead.json()).projects.map((project: { project: string }) => project.project)).toEqual(["alpha", "beta"]);
      await page.getByRole("heading", { name: "Detalle operativo", exact: true }).waitFor();
      await page.getByText(/No pude confirmar este proyecto en las opciones actuales/).waitFor();
      await page.getByText("No pude consultar el presupuesto; el resto de la vista sigue disponible.", { exact: true }).waitFor();
      await page.getByText("No pude leer el Harness. No se modificó el proyecto.", { exact: true }).waitFor();
      expect(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).count()).toBe(0);
      expect(await page.getByText("SYNTHETIC_PRIVATE_UNREGISTERED_BODY", { exact: false }).count()).toBe(0);
      await page.getByRole("button", { name: "Volver a Hoy", exact: true }).click(); await card.waitFor();
      stage = "private-safe draft, required preview and no implicit effects";
      await card.getByRole("button", { name: "Preparar tarea", exact: true }).click();
      await page.getByRole("textbox", { name: "Instrucciones", exact: true }).waitFor();
      await page.waitForFunction(() => (document.querySelector('select[aria-label="Proyecto"]') as HTMLSelectElement)?.value === "alpha" && !!(document.querySelector('textarea[name="instructions"]') as HTMLTextAreaElement)?.value);
      expect(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).inputValue()).toBe("Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.");
      expect(await page.getByRole("button", { name: "Despachar", exact: true }).isDisabled()).toBe(true);
      expect(await page.locator('input[type="checkbox"]:checked').count()).toBe(0);
      await page.getByRole("button", { name: "Hoy", exact: true }).click(); await card.waitFor();
      expect(await page.getByRole("button", { name: "Volver a Hoy", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Overview", exact: false }).click(); await page.getByRole("textbox", { name: "Instrucciones", exact: true }).waitFor();
      expect(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).inputValue()).toBe("");
      stage = "personal independence, mobile and keyboard consultation";
      await page.getByRole("button", { name: "Hoy", exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
      const personal = page.getByRole("article", { name: "Recomendación sig_daily_personal", exact: true });
      await personal.getByText("Linaje y perfiles · consultar evidencia", { exact: true }).click();
      await personal.getByRole("button", { name: "Consultar linaje y perfiles", exact: true }).focus();
      const personalRead = await observeResponse(page, "/api/operating/projects/beta", "GET", () => page.keyboard.press("Enter")); expect(personalRead.status()).toBe(200);
      const personalView = await personalRead.json() as OperatingView;
      expect(personalView.sections.find(section => section.kind === "projects")?.rows.find(row => row.id === "beta")?.lineage.alignment).toBe("intentionally-unaligned");
      await personal.getByText(/Independencia personal intencional según el snapshot/).waitFor();
      expect(await personal.getByRole("button", { name: "Preparar tarea", exact: true }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await personal.getByRole("button", { name: "Consultar linaje y perfiles", exact: true }).boundingBox())!.width).toBeLessThan(350);
      expect(await page.getByText(/SYNTHETIC_PRIVATE_SIGNAL_BODY/).count()).toBe(0);
      stage = "reload and actual process restart preserve records and rotate session";
      await page.reload(); await card.waitFor();
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUi = await startUi(apiUrl);
      expect((await fetch(`${apiUrl}/api/tasks`, { method: "POST", headers: { "X-Surtec-Session": oldSession }, body: "{}" })).status).toBe(403);
      await page.goto(restartedUi); await card.waitFor(); await card.getByRole("button", { name: "Ver tarea", exact: true }).click(); await page.getByRole("heading", { name: "Public daily task", exact: true }).waitFor();
      expect(await Promise.all(statePaths.map(path => readFile(join(root, "state", path), "utf8")))).toEqual(before);
      expect(await harnessTreeHash(join(root, "projects"))).toBe(projectsHash);
      expect(mutations).toEqual([]); expect(reads.some(path => /\/open$/.test(path))).toBe(false);
      expect(existsSync(join(root, "forbidden-effect"))).toBe(false); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
      expect(pageErrors, JSON.stringify(pageErrors)).toEqual([]);
      const refusedResources = ["/api/budgets?project_id=gamma", "/api/projects/gamma/harness"];
      for (const path of refusedResources) expect(httpErrors).toContain(`404 ${path}`);
      expect(httpErrors.every(error => refusedResources.some(path => error === `404 ${path}`)), JSON.stringify(httpErrors)).toBe(true);
      expect(consoleErrors.length).toBeGreaterThanOrEqual(2);
      expect(consoleErrors.every(error => refusedResources.includes(error.path) && error.message.includes("404 (Not Found)")), JSON.stringify(consoleErrors)).toBe(true);
    } catch (error) { throw new Error(`Q T007 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
    }
  }, 120000);

  it.each([null, { id: "planner", agents: [], display_name: 42 }, { id: "planner", agents: [], display_name: "Planner", responsibility: "Scoped", sandbox_ceiling: "full-access" }])("isolates malformed registered profiles while retaining independently confirmed lineage", async (role) => {
    const item = signal(1, { project_id: "alpha", source: "task", evidence: { task_id: "T-1" } });
    vi.mocked(getOperatingProject).mockResolvedValue(operating());
    vi.mocked(getContextRoles).mockResolvedValue({ roles: [role] } as unknown as Awaited<ReturnType<typeof getContextRoles>>);
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={vi.fn()} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia")); fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" }));
    await screen.findByText(/Una fuente de linaje o perfiles/); expect(screen.getByRole("button", { name: "Ver issue I-local" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: `Perfiles registrados de ${item.id}` })).toBeNull();
    expect(screen.getByRole("button", { name: "Consultar linaje y perfiles" })).toBeEnabled();
  });

  it("opens the exact SURTEC objective and reserves organization fallback for an unavailable objective id", () => {
    const item = signal(1, { source: "objective", project_id: "surtec", evidence: { objective_id: "OBJ-own" } });
    const navigate = vi.fn(), root = vi.fn(), project = vi.fn();
    const common = { error: null, onOpenTask: vi.fn(), onOpenProject: project, onPrepareTask: vi.fn(), onOpenOrganization: root, onNavigate: navigate, onRefresh: async () => model() };
    const rendered = render(<TodayView data={model([item])} {...common} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir SURTEC" })); expect(navigate).toHaveBeenCalledWith({ kind: "objective", id: "OBJ-own" }); expect(root).not.toHaveBeenCalled(); expect(project).not.toHaveBeenCalled();
    rendered.rerender(<TodayView data={model([{ ...item, evidence: {} }])} {...common} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir SURTEC" })); expect(root).toHaveBeenCalledOnce(); expect(project).not.toHaveBeenCalled();
  });
  it("shows reference versus observation times and strategic context without inspecting anything on render", () => {
    const item = signal(1, { project_id: "alpha", evidence_at: "2027-01-01T00:00:00Z", evidence: { primary_objective_id: "OBJ-primary", primary_objective_title: "Public objective" } });
    const onNavigate = vi.fn();
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={onNavigate} onRefresh={async () => model()} />);
    const lineage = screen.getByRole("region", { name: `Linaje de ${item.id}` });
    expect(lineage).toHaveTextContent("Contexto estratégico del proyecto: OBJ-primary"); expect(lineage).toHaveTextContent("no atribuye el issue a ese objetivo");
    expect(lineage).toHaveTextContent("Issue local: no confirmado");
    expect(screen.getByText(/Fecha de referencia de la señal:/).querySelector("time")).toHaveAttribute("dateTime", "2027-01-01T00:00:00Z");
    expect(screen.getByText(/Señal observada:/).querySelector("time")).toHaveAttribute("dateTime", item.observed_at);
    expect(getOperatingProject).not.toHaveBeenCalled(); expect(getContextRoles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ver objetivo OBJ-primary" })); expect(onNavigate).toHaveBeenCalledWith({ kind: "objective", id: "OBJ-primary" }); expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("keeps a signal's own objective separate from its project's primary objective", () => {
    const item = signal(1, { source: "objective", evidence: { objective_id: "OBJ-own", primary_objective_id: "OBJ-other" } });
    const navigate = vi.fn(); render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={navigate} onRefresh={async () => model()} />);
    const lineage = screen.getByRole("region", { name: `Linaje de ${item.id}` });
    expect(lineage).toHaveTextContent("Objetivo de esta señal: OBJ-own"); expect(lineage).toHaveTextContent("Contexto estratégico del proyecto: OBJ-other");
    fireEvent.click(screen.getByRole("button", { name: "Ver objetivo OBJ-own" })); expect(navigate).toHaveBeenCalledWith({ kind: "objective", id: "OBJ-own" });
  });

  it("does not treat an external issue number or arbitrary evidence fields as local ownership or permission", () => {
    const item = signal(1, { source: "issue", evidence: { issue_number: 7, issue_id: "I-forged", workflow_id: "W-forged", role_id: "owner", private_context: "PRIVATE-EVIDENCE-BODY" } });
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={vi.fn()} onRefresh={async () => model()} />);
    const lineage = screen.getByRole("region", { name: `Linaje de ${item.id}` });
    expect(lineage).toHaveTextContent("issue GitHub #7"); expect(lineage).toHaveTextContent("Issue local: no confirmado"); expect(lineage).toHaveTextContent("no informados por el feed");
    expect(document.body.textContent).not.toMatch(/I-forged|W-forged|PRIVATE-EVIDENCE-BODY/); expect(screen.queryByRole("button", { name: /Ver issue|Ver workflow/ })).toBeNull();
  });

  it("consults exact task lineage on demand and labels registered profiles/workflows as evidence rather than grants", async () => {
    const item = signal(1, { project_id: "alpha", source: "task", evidence: { task_id: "T-1" } });
    vi.mocked(getOperatingProject).mockResolvedValue(operating());
    vi.mocked(getContextRoles).mockResolvedValue({ roles: [{ id: "software-engineer", display_name: "Registered engineer", responsibility: "Scoped work", sandbox_ceiling: "workspace-write", agents: ["backend-engineer"] }] });
    const navigate = vi.fn(); render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={navigate} onRefresh={async () => model()} />);
    expect(getOperatingProject).not.toHaveBeenCalled(); fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia"));
    fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" }));
    await screen.findByRole("region", { name: `Perfiles registrados de ${item.id}` });
    expect(getOperatingProject).toHaveBeenCalledExactlyOnceWith("alpha", { page_size: 20 }); expect(getContextRoles).toHaveBeenCalledExactlyOnceWith("alpha");
    const lineage = screen.getByRole("region", { name: `Linaje de ${item.id}` });
    expect(lineage).toHaveTextContent("software-engineer · referencia registrada, no permiso actual"); expect(lineage).toHaveTextContent("template implementation");
    expect(lineage).toHaveTextContent("stale"); expect(lineage).toHaveTextContent("no confirma el task kind, scope, consentimiento, presupuesto");
    fireEvent.click(screen.getByRole("button", { name: "Ver issue I-local" })); expect(navigate).toHaveBeenCalledWith({ kind: "issue", id: "I-local", projectId: "alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Ver workflow W-exact" })); expect(navigate).toHaveBeenCalledWith({ kind: "workflow", id: "W-exact", issueId: "I-local", projectId: "alpha" });
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("does not declare intentional personal independence from a missing feed link until a canonical snapshot confirms it", async () => {
    const item = signal(1, { project_id: "alpha", project_kind: "personal", evidence: {} });
    vi.mocked(getOperatingProject).mockResolvedValue(operating("alpha", true)); vi.mocked(getContextRoles).mockResolvedValue({ roles: [] });
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onRefresh={async () => model()} />);
    expect(screen.getByText(/su ausencia en esta señal no prueba/)).toBeInTheDocument(); expect(screen.queryByText(/Independencia personal intencional según/)).toBeNull();
    fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia")); fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" }));
    await screen.findByText(/Independencia personal intencional según el snapshot/); expect(screen.getByText(/Sin perfiles disponibles/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparar tarea" })).toBeEnabled(); expect(postSignalAction).not.toHaveBeenCalled();
  });

  it.each(["foreign-focus", "foreign-task", "cross-project", "missing-task"])("does not substitute %s lineage for the exact signal task", async (mismatch) => {
    const item = signal(1, { project_id: "alpha", source: "task", evidence: { task_id: "T-1" } }), view = operating();
    if (mismatch === "foreign-focus") view.focus_id = "beta";
    else { const tasks = view.sections.find(section => section.kind === "executions")!; if (mismatch === "foreign-task") tasks.rows = [{ ...tasks.rows[0]!, id: "OTHER" }]; if (mismatch === "cross-project") tasks.rows[0]!.lineage.gaps.push("cross-project"); if (mismatch === "missing-task") tasks.rows = []; }
    vi.mocked(getOperatingProject).mockResolvedValue(view); vi.mocked(getContextRoles).mockResolvedValue({ roles: [] });
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}} onPrepareTask={vi.fn()} onNavigate={vi.fn()} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia")); fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" })); await screen.findByRole("region", { name: `Perfiles registrados de ${item.id}` });
    expect(screen.queryByRole("button", { name: "Ver issue I-local" })).toBeNull(); expect(screen.queryByRole("button", { name: "Ver workflow W-exact" })).toBeNull();
  });

  it("isolates failed lineage/profile reads without printing raw exceptions or blocking project inspection", async () => {
    const item = signal(1, { project_id: "alpha" }); vi.mocked(getOperatingProject).mockRejectedValue(new Error("PRIVATE SNAPSHOT /private/state.json")); vi.mocked(getContextRoles).mockRejectedValue(new Error("PRIVATE PROFILE"));
    const open = vi.fn().mockResolvedValue(undefined); render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={open} onPrepareTask={vi.fn()} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia")); fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" })); await screen.findByText(/Una fuente de linaje o perfiles/);
    expect(document.body.textContent).not.toContain("PRIVATE"); fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" })); expect(open).toHaveBeenCalledWith("alpha");
  });

  it("fences a late on-demand response across signal changes and never carries it to another project", async () => {
    let finish!: (value: OperatingView) => void; const item = signal(1, { project_id: "alpha", source: "task", evidence: { task_id: "T-1" } });
    vi.mocked(getOperatingProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); vi.mocked(getContextRoles).mockResolvedValue({ roles: [] });
    const props = { error: null, onOpenTask: vi.fn(), onOpenProject: async () => {}, onPrepareTask: vi.fn(), onRefresh: async () => model() };
    const rendered = render(<TodayView data={model([item])} {...props} />); fireEvent.click(screen.getByText("Linaje y perfiles · consultar evidencia")); fireEvent.click(screen.getByRole("button", { name: "Consultar linaje y perfiles" }));
    rendered.rerender(<TodayView data={model([{ ...item, project_id: "beta" }])} {...props} />); await act(async () => finish(operating()));
    expect(document.body.textContent).not.toContain("I-local"); expect(document.body.textContent).not.toContain("W-exact"); expect(screen.queryByRole("region", { name: `Perfiles registrados de ${item.id}` })).toBeNull();
  });

  it("separates explicit editor launch from in-app inspection and treats navigation failures as public gaps", async () => {
    const item = signal(1); const editor = vi.fn().mockRejectedValue(new Error("PRIVATE EDITOR PATH"));
    const open = vi.fn().mockResolvedValue(undefined); render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={open} onOpenEditor={editor} onPrepareTask={vi.fn()} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" })); expect(editor).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledWith(item.project_id);
    fireEvent.click(screen.getByRole("button", { name: "Abrir en VS Code" })); await screen.findByRole("alert"); expect(editor).toHaveBeenCalledWith(item.project_id); expect(document.body.textContent).not.toContain("PRIVATE EDITOR PATH");
  });
  it("mounts the routine panel after work sessions with only discovered projects and the observed Today timestamp", () => {
    const projects = [project];
    const data = model();
    const onRefresh = vi.fn(); const onOpenTask = vi.fn(); const onOpenProject = vi.fn(); const onPrepareTask = vi.fn();
    render(<TodayView data={data} error={null} projects={projects} onOpenTask={onOpenTask}
      onOpenProject={onOpenProject} onPrepareTask={onPrepareTask} onRefresh={onRefresh} />);

    const props = vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0];
    expect(props).toEqual({ projects, refreshKey: data.generated_at });
    expect(props?.projects).toBe(projects);
    const panel = screen.getByTestId("routine-panel");
    expect(panel.previousElementSibling).toContainElement(screen.getByRole("heading", { name: "Sesiones de trabajo" }));
    expect(panel).toHaveAttribute("data-refresh-key", data.generated_at);
    expect(onRefresh).not.toHaveBeenCalled(); expect(postSignalAction).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled(); expect(onOpenProject).not.toHaveBeenCalled(); expect(onPrepareTask).not.toHaveBeenCalled();
  });

  it("updates the routine refresh binding only when a new Today model is rendered", async () => {
    const first = model();
    const second = model([], { generated_at: "2026-09-21T12:01:00Z" });
    const refresh = vi.fn().mockResolvedValue(second);
    const common = { error: null, projects: [project], onOpenTask: vi.fn(), onOpenProject: async () => {},
      onPrepareTask: vi.fn(), onRefresh: refresh };
    const view = render(<TodayView data={first} {...common} />);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar Hoy" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", first.generated_at);

    view.rerender(<TodayView data={second} {...common} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", second.generated_at);
    expect(vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0]).toEqual({ projects: common.projects, refreshKey: second.generated_at });
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("removes the routine panel when Today has no model and mounts it again with the new timestamp", () => {
    const common = { error: null, onOpenTask: vi.fn(), onOpenProject: async () => {},
      onPrepareTask: vi.fn(), onRefresh: async () => model() };
    const view = render(<TodayView data={null} {...common} />);
    expect(screen.queryByTestId("routine-panel")).not.toBeInTheDocument();
    expect(screen.getByText("Cargando Hoy…")).toBeInTheDocument();
    expect(RoutinePanel).not.toHaveBeenCalled();

    view.rerender(<TodayView data={model()} {...common} />);
    expect(vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0]).toEqual({ projects: [], refreshKey: model().generated_at });
    view.rerender(<TodayView data={null} {...common} error="Unavailable fixture" />);
    expect(screen.queryByTestId("routine-panel")).not.toBeInTheDocument();
    expect(screen.getByText(/No pude cargar Hoy/)).toBeInTheDocument();

    const latest = model([], { generated_at: "2026-09-21T12:02:00Z" });
    view.rerender(<TodayView data={latest} {...common} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", latest.generated_at);
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("preserves the routine observation binding and task activity when a Today refresh fails", () => {
    const latest = model();
    render(<TodayView data={latest} error="Unavailable fixture" onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => latest} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", latest.generated_at);
    expect(screen.getByText(/mostrando el último estado conocido/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /T-1/ })).toBeInTheDocument();
    expect(screen.getByText("Actividad de Codex")).toBeInTheDocument();
  });

  it("keeps non-Harness recommendation navigation and explicit task preparation unchanged", async () => {
    const item = signal(1);
    const onOpenProject = vi.fn().mockResolvedValue(undefined); const onPrepareTask = vi.fn();
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={onOpenProject}
      onPrepareTask={onPrepareTask} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith(item.project_id));
    fireEvent.click(screen.getByRole("button", { name: "Preparar tarea" }));
    expect(onPrepareTask).toHaveBeenCalledExactlyOnceWith(item);
    expect(screen.getByTestId("routine-panel")).toBeInTheDocument();
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("opens Harness evidence without preparing a task or launching the editor", () => {
    const onOpenHarness = vi.fn(); const onOpenProject = vi.fn(); const onPrepareTask = vi.fn();
    render(<TodayView data={model([signal(1, { source: "harness", title: "Harness evidence" })])} error={null} onOpenTask={vi.fn()} onOpenProject={onOpenProject} onOpenHarness={onOpenHarness} onPrepareTask={onPrepareTask} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver Harness" })); expect(onOpenHarness).toHaveBeenCalledWith("project-1");
    expect(onOpenProject).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Preparar tarea" })).not.toBeInTheDocument();
  });
  it("renders portfolio recommendations and keeps the existing task activity accessible", () => {
    const onOpenTask = vi.fn();
    render(<TodayView data={model([signal(1)])} error={null} onOpenTask={onOpenTask} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => model()} projects={[project]} />);

    expect(screen.getByText("2026-09-21")).toBeInTheDocument();
    expect(screen.getByText("Ahora · recomendaciones principales")).toBeInTheDocument();
    expect(screen.getAllByText("Deadline recommendation 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Completadas hoy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /T-1/ }));
    expect(onOpenTask).toHaveBeenCalledWith("T-1");
    expect(screen.getByRole("heading", { name: "Sesiones de trabajo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeInTheDocument();
  });

  it("keeps the primary recommendation count at three for an overloaded signal feed", () => {
    const signals = Array.from({ length: 8 }, (_, index) => signal(index + 1));
    render(<TodayView data={model(signals)} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => model()} />);
    const heading = screen.getByText("Ahora · recomendaciones principales").closest("section");
    expect(heading?.querySelectorAll(".today-signal")).toHaveLength(3);
  });

  it("shows a calm healthy empty state and refreshes after a human signal action", async () => {
    const refresh = vi.fn().mockResolvedValue(model());
    const item = signal(9);
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={refresh} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Reconocer/ })[0]!);
    await waitFor(() => expect(postSignalAction).toHaveBeenCalledWith(item.id, { action: "acknowledge" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    const calm = model();
    render(<TodayView data={calm} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => calm} />);
    expect(screen.getByText(/Tu cartera está tranquila/)).toBeInTheDocument();
  });

  it("does not describe unavailable portfolio evidence as a healthy calm state", () => {
    const unavailable = model([], { portfolio: { ...model().portfolio, signal_status: "unavailable" } });
    render(<TodayView data={unavailable} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => unavailable} />);
    expect(screen.getByText(/no está disponible ahora/)).toBeInTheDocument();
    expect(screen.queryByText(/Tu cartera está tranquila/)).not.toBeInTheDocument();
  });

  it("surfaces degraded source warnings without replacing the portfolio page", () => {
    const degraded = model([], { warnings: ["GitHub issue evidence is unavailable."], portfolio: {
      ...model().portfolio, signal_status: "degraded", warnings: ["GitHub issue evidence is unavailable."],
    } });
    render(<TodayView data={degraded} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => degraded} />);
    expect(screen.getByText("Inteligencia parcial")).toBeInTheDocument();
    expect(screen.getByText("GitHub issue evidence is unavailable.")).toBeInTheDocument();
  });
});
