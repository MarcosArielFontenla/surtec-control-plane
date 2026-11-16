// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { OverviewModel, TodayModel } from "../../../lib/state/types";
import * as taskDetail from "./views/TaskDetailView";
import * as issueView from "./views/IssuesView";
import * as organizationView from "./views/OrganizationView";
import * as projectDetail from "./views/ProjectDetailView";
import type { OperatingNavigationTarget } from "./views/OrganizationView";
import type { ProjectReadinessNavigationTarget } from "./components/ProjectReadinessPanel";
import * as apiClient from "./api";
import * as todayView from "./views/TodayView";
import * as clientView from "./views/ClientCommitmentsView";
import * as taskForm from "./components/NewTaskForm";
import type { Signal } from "../../../lib/signals/types";
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

const dispatchProject = (project: string): apiClient.DispatchProjectCapability => ({ project, allowed_agents: [], project_sandbox_ceiling: "read-only", has_local_checkout: true, has_verification_commands: false, agents: [] });

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
  it.each(["issues", "issue", "workflow"] as const)("keeps project readiness %s navigation in the existing issue flow with an exact immediate return", async kind => {
    const open = vi.spyOn(apiClient, "openProject").mockResolvedValue(undefined);
    const preview = vi.spyOn(apiClient, "fetchDispatchOptions");
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject }) => <section>Readiness Today root<button onClick={() => void onOpenProject("stock-control")}>Readiness project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness, onBack }) => <section>Ready project {project.id}<button onClick={() => onNavigateReadiness?.(kind === "issues" ? { kind, projectId: project.id } : kind === "issue" ? { kind, id: "I-READY", projectId: project.id } : { kind, id: "W-READY", issueId: "I-READY", projectId: project.id })}>Readiness next</button><button onClick={onBack}>Readiness project back</button></section>);
    const issues = vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <section>{workflowFocus ? `Ready workflow ${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Existing unfiltered issues"}<button onClick={() => onOpenTask?.("T-READY")}>Readiness task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Ready task {taskId}<button onClick={onBack}>Readiness task back</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Readiness project" })); await screen.findByText("Ready project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Readiness next" })); await screen.findByText(kind === "workflow" ? "Ready workflow stock-control/I-READY/W-READY" : "Existing unfiltered issues");
    expect(screen.getByText(/sin filtro de la lista ni prefill/)).toBeTruthy(); expect(screen.getByText(/elegí su proyecto explícitamente/)).toBeTruthy();
    expect(issues.mock.calls.at(-1)?.[0]).toMatchObject({ workflowFocus: kind === "workflow" ? { projectId: "stock-control", issueId: "I-READY", workflowId: "W-READY" } : null });
    if (kind === "issue") expect(screen.getByRole("link", { name: "Ir a tarjeta I-READY" }).getAttribute("href")).toBe("#work-issue-I-READY");
    else expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Readiness task" })); await screen.findByText("Ready task T-READY");
    expect(screen.getByRole("button", { name: "Volver al proyecto stock-control" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Readiness task back" })); await screen.findByText(kind === "workflow" ? "Ready workflow stock-control/I-READY/W-READY" : "Existing unfiltered issues");
    fireEvent.click(screen.getByRole("button", { name: "Volver al proyecto stock-control" })); await screen.findByText("Ready project stock-control");
    expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull(); expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Readiness project back" })); await screen.findByText("Readiness Today root");
    expect(open).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => /\/open(?:\?|$)/.test(String(url)) || (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("retains the readiness project return through a stage task's exact workflow", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject }) => <button onClick={() => void onOpenProject("stock-control")}>Stage readiness project</button>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness }) => <section>Stage origin {project.id}<button onClick={() => onNavigateReadiness?.({ kind: "issue", id: "I-READY", projectId: project.id })}>Stage readiness issue</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <section>{workflowFocus ? `Stage owner ${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Stage issue list"}<button onClick={() => onOpenTask?.("T-STAGE")}>Stage task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack, onOpenWorkflow }) => <section>Stage execution {taskId}<button onClick={onBack}>Back to stage owner</button><button onClick={() => onOpenWorkflow?.({ projectId: "stock-control", issueId: "I-READY", workflowId: "W-READY" })}>Stage owner workflow</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Stage readiness project" })); fireEvent.click(await screen.findByRole("button", { name: "Stage readiness issue" })); fireEvent.click(await screen.findByRole("button", { name: "Stage task" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stage owner workflow" })); await screen.findByText("Stage owner I-READY/W-READY");
    fireEvent.click(screen.getByRole("button", { name: "Stage task" })); fireEvent.click(await screen.findByRole("button", { name: "Back to stage owner" })); await screen.findByText("Stage owner I-READY/W-READY");
    fireEvent.click(screen.getByRole("button", { name: "Volver al proyecto stock-control" })); await screen.findByText("Stage origin stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByRole("button", { name: "Stage readiness project" });
  });

  it.each(["stock-control", "other-project"])("retains a directly inspected project task's workflow return only for the exact project %s", async workflowProject => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject }) => <button onClick={() => void onOpenProject("stock-control")}>Direct readiness project</button>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onOpenTask }) => <section>Direct readiness {project.id}<button onClick={() => onOpenTask("T-DIRECT-READY")}>Direct readiness task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ onOpenWorkflow }) => <button onClick={() => onOpenWorkflow?.({ projectId: workflowProject, issueId: "I-DIRECT-READY", workflowId: "W-DIRECT-READY" })}>Direct readiness workflow</button>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `Direct workflow ${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Direct workflow absent"}</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Direct readiness project" })); fireEvent.click(await screen.findByRole("button", { name: "Direct readiness task" })); fireEvent.click(await screen.findByRole("button", { name: "Direct readiness workflow" })); await screen.findByText(`Direct workflow ${workflowProject}/I-DIRECT-READY/W-DIRECT-READY`);
    if (workflowProject === "stock-control") {
      fireEvent.click(screen.getByRole("button", { name: "Volver al proyecto stock-control" })); await screen.findByText("Direct readiness stock-control");
    } else expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull();
    expect(screen.getByRole("button", { name: "Volver a Hoy" })).toBeTruthy();
  });

  it("preserves Today and objective ancestry around the project readiness loop", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onNavigate }) => <section>Daily loop Today<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-READY" })}>Daily objective</button></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>Daily objective {focusedObjectiveId ?? "none"}<button onClick={() => onNavigate?.({ kind: "project", id: "stock-control" })}>Daily linked project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness, onBack }) => <section>Daily project {project.id}<button onClick={() => onNavigateReadiness?.({ kind: "issues", projectId: project.id })}>Daily choose issues</button><button onClick={onBack}>Daily project back</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(() => <section>Daily current issues</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Daily objective" })); fireEvent.click(await screen.findByRole("button", { name: "Daily linked project" })); fireEvent.click(await screen.findByRole("button", { name: "Daily choose issues" })); await screen.findByText("Daily current issues");
    expect(screen.getByRole("button", { name: "Volver al objetivo OBJ-READY" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Volver a Hoy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Volver al proyecto stock-control" })); await screen.findByText("Daily project stock-control"); fireEvent.click(screen.getByRole("button", { name: "Daily project back" })); await screen.findByText("Daily objective OBJ-READY");
    expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull(); expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-READY" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Daily loop Today");
  });

  it("returns from the readiness list to the portfolio project without inventing a Today or objective origin", async () => {
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness, onBack }) => <section>Portfolio readiness {project.id}<button onClick={() => onNavigateReadiness?.({ kind: "issues", projectId: project.id })}>Portfolio choose issues</button><button onClick={onBack}>Portfolio project back</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(() => <section>Portfolio issue list</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Overview" })); fireEvent.click(await screen.findByRole("button", { name: "Detalle operativo de stock-control" })); fireEvent.click(await screen.findByRole("button", { name: "Portfolio choose issues" })); await screen.findByText("Portfolio issue list");
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull(); expect(screen.queryByRole("button", { name: /^Volver al objetivo/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volver al proyecto stock-control" })); await screen.findByText("Portfolio readiness stock-control"); fireEvent.click(screen.getByRole("button", { name: "Portfolio project back" })); await screen.findByRole("button", { name: "Detalle operativo de stock-control" });
    expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull();
  });

  it.each(["issues", "issue", "workflow"] as const)("refuses a foreign project in readiness %s navigation without switching or preparing work", async kind => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject }) => <button onClick={() => void onOpenProject("stock-control")}>Foreign readiness project</button>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness }) => <section>Foreign-safe project {project.id}<button onClick={() => onNavigateReadiness?.(kind === "issues" ? { kind, projectId: "other-project" } : kind === "issue" ? { kind, id: "I-FOREIGN", projectId: "other-project" } : { kind, id: "W-FOREIGN", issueId: "I-FOREIGN", projectId: "other-project" })}>Foreign readiness reference</button></section>);
    const issues = vi.spyOn(issueView, "IssuesView").mockImplementation(() => <section>Unexpected foreign issue list</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Foreign readiness project" })); fireEvent.click(await screen.findByRole("button", { name: "Foreign readiness reference" }));
    await screen.findByText("Foreign-safe project stock-control"); expect(screen.getByRole("alert").textContent).toContain("no corresponde al proyecto seleccionado"); expect(issues).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull(); expect(screen.queryByText("I-FOREIGN")).toBeNull();
  });

  it("clears readiness return, exact issue/workflow focus and prefill across sidebar changes and ignores old callbacks", async () => {
    let retainedNavigate: ((target: ProjectReadinessNavigationTarget) => void) | undefined;
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject, onNavigate }) => <section>Clean readiness Today<button onClick={() => void onOpenProject("stock-control")}>Clean readiness project</button><button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-READY" })}>Clean readiness objective</button></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>Clean readiness objective {focusedObjectiveId ?? "none"}<button onClick={() => onNavigate?.({ kind: "project", id: "stock-control" })}>Clean readiness linked project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onNavigateReadiness }) => { retainedNavigate = onNavigateReadiness; return <section>Clean readiness selected {project.id}<button onClick={() => onNavigateReadiness?.({ kind: "workflow", id: "W-READY", issueId: "I-READY", projectId: project.id })}>Clean readiness workflow</button></section>; });
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `Clean selected ${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Clean issue list"}</section>);
    vi.spyOn(taskForm, "NewTaskForm").mockImplementation(({ initialProject, initialInstructions }) => <section>Clean task form {initialProject ?? "no prefill"}<p>{initialInstructions}</p></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Clean readiness objective" })); fireEvent.click(await screen.findByRole("button", { name: "Clean readiness linked project" })); fireEvent.click(await screen.findByRole("button", { name: "Clean readiness workflow" })); await screen.findByText("Clean selected I-READY/W-READY");
    fireEvent.click(screen.getByRole("button", { name: "Issues" })); await screen.findByText("Clean issue list"); expect(screen.queryByRole("region", { name: "Retorno al proyecto" })).toBeNull(); expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull(); expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-READY" })).toBeNull();
    act(() => retainedNavigate?.({ kind: "issue", id: "I-STALE", projectId: "stock-control" })); expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByText("Clean task form no prefill"); expect(screen.queryByText(/I-READY|W-READY|I-STALE/)).toBeNull();
  });

  it.skipIf(process.env.SURTEC_OPERATING_UI_BROWSER_SMOKE !== "1")("validates the SURTEC overview and objective detail with actual isolated API/Vite/browser, protected editors, mobile and restart", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
    const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path"), { spawn } = await import("node:child_process");
    const { createServer: probeServer } = await import("node:net");
    const { createServer } = await import("vite"), { chromium } = await import("playwright");
    const { cleanupSmoke, observeResponse } = await import("../../../scripts/playwright-local-app-smoke");
    const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(root, "runtime");
    let browser: Browser | null = null, vite: ViteDevServer | null = null, api: ChildProcess | null = null, exited = Promise.resolve();
    let output = "", stage = "setup";
    const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
    async function startApi(): Promise<string> {
      output = "";
      api = spawn(process.execPath, ["--import", "tsx", "operating-ui-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      exited = new Promise<void>((done) => { api!.once("exit", () => done()); api!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; api.stdout!.on("data", collect); api.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_OPERATING_UI_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
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
    async function startUi(apiUrl: string) {
      const probe = probeServer();
      await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen(); return vite.resolvedUrls!.local[0]!;
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects"));
      await writeFile(join(root, "registry/projects.yml"), "projects: {}\n");
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(runtime, "operating-ui-api.ts"), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createOrganizationService } from './dashboard/src/server/organization-service';
import { createOperatingViewService } from './dashboard/src/server/operating-view-service';
import { type OperatingSourceInput } from './lib/operating-views';
const root = process.env.SURTEC_FIXTURE_ROOT!;
const clock = () => new Date('2026-10-16T12:00:00.000Z');
const organization = createOrganizationService({ clock });
if (!existsSync(join(root, 'initialized'))) {
  organization.saveCompany({ schema_version: 1, id: 'surtec', display_name: 'SURTEC fixture', mission: 'Public fixture mission', operating_principles: ['Preserve explicit authority'], active_objective_ids: [], last_reviewed_at: null });
  organization.createObjective({ title: 'Public fixture objective', desired_outcome: 'Inspect operating evidence', success_criteria: ['No implicit effects'], status: 'active', horizon: 'quarter', priority: 3, target_date: null, parent_objective_id: null });
  writeFileSync(join(root, 'initialized'), 'owned synthetic fixture');
}
const source = (items: OperatingSourceInput['items'] = []): OperatingSourceInput => ({ availability: 'available', reason: 'observed', origin: 'saved', observed_at: '2026-10-15T12:00:00.000Z', fresh_until: '2026-10-15T13:00:00.000Z', complete: true, items });
const operating = createOperatingViewService(root, { stateRoot: process.env.SURTEC_STATE_DIR, projectsRoot: process.env.SURTEC_PROJECTS_ROOT, clock, readers: {
  company: () => { const c = organization.read().company; return source([{ id: c.id, label: c.display_name, state: null, summary: c.mission, principles: c.operating_principles }]); },
  objectives: () => { const objectives = organization.read().objectives; return source([...objectives.map(o => ({ id: o.id, label: o.title, state: o.status, summary: o.desired_outcome, criteria: o.success_criteria, parent_objective_id: o.parent_objective_id, reviewed_on: o.last_reviewed_at })), ...Array.from({ length: 10 }, (_, i) => ({ id: 'z-child-' + i, label: 'Public child ' + i, state: 'draft', parent_objective_id: objectives[0]!.id }))]); },
  projects: () => { const id = organization.read().objectives[0]!.id; return source(Array.from({ length: 8 }, (_, i) => ({ id: 'project-' + i, label: 'Public fixture project ' + i, state: 'active', project_kind: 'personal' as const, objective_ids: [id], primary_objective_id: id }))); },
  issues: () => ({ ...source([]), confidential_notes: 'SYNTHETIC_PRIVATE_NOTE_MUST_NOT_RENDER' }),
  signals: () => ({ availability: 'unavailable', reason: 'missing-source', origin: null, observed_at: null, fresh_until: null, complete: false, items: [] }),
} });
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
const dependencies = { organization, operating, signals: { read: async () => ({ schema_version: 1, observed_at: clock().toISOString(), signals: [], pinned_signal_ids: [], warnings: [] }), act: forbidden }, integrations: { read: forbidden, invalidate: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_OPERATING_UI_READY:' + (server.address() as { port: number }).port));
process.once('SIGTERM', () => server.close());
`);
      stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], requests: { path: string; method: string }[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      page.on("request", request => requests.push({ path: new URL(request.url()).pathname, method: request.method() }));
      await page.goto(uiUrl);
      const editorRead = await observeResponse(page, "/api/organization", "GET", () => page.getByRole("button", { name: "SURTEC", exact: true }).click());
      expect(editorRead.status(), "The protected editor source must load independently").toBe(200);
      const objectiveId = (await editorRead.json()).objectives[0].id as string;
      const panel = page.getByRole("region", { name: "Overview operativo SURTEC" }), projects = panel.getByRole("region", { name: "Proyectos", exact: true });
      await panel.getByText("Public fixture mission", { exact: true }).waitFor();
      expect(await panel.getByRole("region").count()).toBe(11);
      expect(await projects.getByText("8 en total", { exact: true }).count()).toBe(1);
      expect(await projects.locator(".operating-rows > li").count()).toBe(6);
      expect(await panel.getByRole("region", { name: "Señales", exact: true }).getByText(/No disponible/).count()).toBe(1);
      expect(await projects.getByText(/Desactualizada/).count()).toBe(1);
      expect(await projects.locator('time[datetime="2026-10-15T12:00:00.000Z"]').count()).toBe(1);
      stage = "bounded pagination and independent drafts";
      const mission = page.getByRole("textbox", { name: "Misión", exact: true });
      await mission.fill("Unsaved fixture draft");
      await projects.getByRole("button", { name: "Siguiente página de Proyectos" }).click(); await projects.getByText("Public fixture project 7", { exact: true }).waitFor();
      expect(await projects.locator(".operating-rows > li").count()).toBe(2); expect(await projects.getByText("Public fixture project 0", { exact: true }).count()).toBe(0);
      await panel.getByRole("button", { name: "Actualizar lectura", exact: true }).click(); await projects.getByText("Public fixture project 0", { exact: true }).waitFor();
      expect(await mission.inputValue()).toBe("Unsaved fixture draft");
      expect(requests.filter(request => request.method !== "GET")).toEqual([]);
      expect(requests.some(request => request.path === "/api/signals" || /\/open$/.test(request.path))).toBe(false);
      stage = "explicit protected editor persistence";
      const saved = await observeResponse(page, "/api/organization/company", "PUT", () => page.getByRole("button", { name: "Guardar perfil", exact: true }).click()); expect(saved.status()).toBe(200);
      await panel.getByText("Unsaved fixture draft", { exact: true }).waitFor();
      const stored = await readFile(join(root, "state/organization/organization.json"), "utf8"); expect(stored).toContain("Unsaved fixture draft");
      expect(requests.filter(request => request.method !== "GET")).toEqual([{ path: "/api/organization/company", method: "PUT" }]);
      stage = "objective detail, bounded ancestry and drafts";
      await page.getByRole("textbox", { name: "Título", exact: true }).fill("Retained objective draft");
      const objectiveResponse = await observeResponse(page, `/api/operating/objectives/${objectiveId}`, "GET", () => panel.getByRole("button", { name: "Ver objetivo Public fixture objective" }).click());
      expect(objectiveResponse.status()).toBe(200); expect(objectiveResponse.headers()["cache-control"]).toBe("no-store");
      const detail = page.getByRole("region", { name: "Detalle de objetivo", exact: true });
      await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      expect(await detail.getByRole("region", { name: "Resultado y criterios" }).getByText("No implicit effects", { exact: true }).count()).toBe(1);
      expect(await detail.getByRole("region", { name: "Proyectos vinculados" }).locator(".operating-rows > li").count()).toBe(8);
      expect(await detail.getByRole("region", { name: "Salud explicada" }).getByText(/Evaluación incompleta/).count()).toBe(1);
      const relatedObjectives = detail.getByRole("region", { name: "Objetivos relacionados", exact: true });
      expect(await relatedObjectives.locator(".operating-rows > li").count()).toBe(8);
      await relatedObjectives.getByRole("button", { name: "Siguiente página de Objetivos relacionados" }).click(); await relatedObjectives.getByText("Public child 9", { exact: true }).waitFor();
      expect(await relatedObjectives.locator(".operating-rows > li").count()).toBe(3);
      expect(await detail.getByRole("region", { name: "Resultado y criterios" }).getByText(/La ficha seleccionada no está en esta página/).count()).toBe(1);
      await relatedObjectives.getByRole("button", { name: "Primera página de Objetivos relacionados" }).click(); await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      await detail.getByRole("button", { name: "Cerrar detalle de objetivo" }).click(); expect(await detail.count()).toBe(0);
      expect(await page.getByRole("textbox", { name: "Título", exact: true }).inputValue()).toBe("Retained objective draft");
      expect(await mission.inputValue()).toBe("Unsaved fixture draft");
      await page.getByRole("button", { name: "Ver detalle de objetivo Public fixture objective", exact: true }).click(); await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      stage = "objective to missing project and exact return";
      await detail.getByRole("region", { name: "Proyectos vinculados" }).getByRole("button", { name: "Ver proyecto Public fixture project 0", exact: true }).click(); await page.getByText("El proyecto ya no está en el portfolio actual.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver al portfolio" }).click(); await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      expect(await detail.getByText(`Objetivo seleccionado: ${objectiveId}. Solo lectura: navegar no autoriza trabajo ni publica resultados.`, { exact: true }).count()).toBe(1);
      expect(requests.filter(request => request.method !== "GET")).toEqual([{ path: "/api/organization/company", method: "PUT" }]);
      stage = "mobile controls, keyboard and reload";
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("button", { name: "SURTEC", exact: true }).click(); await panel.getByText("Unsaved fixture draft", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "SURTEC overview must fit the mobile viewport").toBe(true);
      const save = page.getByRole("button", { name: "Guardar perfil", exact: true }); expect((await save.boundingBox())!.width).toBeLessThan(250);
      const select = page.getByRole("combobox", { name: "Horizonte", exact: true }); expect(await select.evaluate(element => { const option = element.querySelector("option")!; return getComputedStyle(option).color !== getComputedStyle(option).backgroundColor; })).toBe(true);
      await panel.getByRole("button", { name: "Ver objetivo Public fixture objective" }).click(); await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Objective detail must fit the mobile viewport").toBe(true);
      await detail.getByRole("button", { name: "Actualizar objetivo" }).focus();
      const objectiveKeyboard = await observeResponse(page, `/api/operating/objectives/${objectiveId}`, "GET", () => page.keyboard.press("Enter")); expect(objectiveKeyboard.status()).toBe(200);
      await detail.getByRole("button", { name: "Cerrar detalle de objetivo" }).click();
      await panel.getByRole("button", { name: "Actualizar lectura" }).focus();
      const keyboardRead = await observeResponse(page, "/api/operating/overview", "GET", () => page.keyboard.press("Enter"));
      expect(keyboardRead.status()).toBe(200); expect(keyboardRead.headers()["cache-control"]).toBe("no-store");
      expect(JSON.stringify(await keyboardRead.json())).not.toContain("SYNTHETIC_PRIVATE_NOTE_MUST_NOT_RENDER");
      expect(await panel.getByRole("region", { name: "Issues y decisiones" }).getByText(/No disponible/).count()).toBe(1);
      expect(await page.getByText("SYNTHETIC_PRIVATE_NOTE_MUST_NOT_RENDER", { exact: false }).count()).toBe(0);
      expect(await page.getByText("forbidden-runtime", { exact: false }).count()).toBe(0);
      stage = "actual process restart and refusal";
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUrl = await startUi(apiUrl);
      expect((await fetch(`${apiUrl}/api/organization/company`, { method: "PUT", headers: { "X-Surtec-Session": oldSession }, body: "{}" })).status).toBe(403);
      await page.goto(restartedUrl); await page.getByRole("button", { name: "SURTEC", exact: true }).click(); await panel.getByText("Unsaved fixture draft", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Ver objetivo Public fixture objective" }).click(); await detail.getByRole("heading", { name: "Public fixture objective", exact: true }).waitFor();
      expect(await detail.getByRole("region", { name: "Resultado y criterios" }).getByText("No implicit effects", { exact: true }).count()).toBe(1);
      expect(await readFile(join(root, "state/organization/organization.json"), "utf8")).toBe(stored);
      expect(existsSync(join(root, "forbidden-effect"))).toBe(false); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
      expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(httpErrors).toEqual([]);
    } catch (error) { throw new Error(`Q T003/T004 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: api ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
    }
  }, 120000);

  it.each(["commitments", "sessions"] as const)("routes the operating %s section without carrying another selection", async (section) => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ onNavigate }) => <button onClick={() => onNavigate?.({ kind: "section", section })}>Q section</button>);
    vi.spyOn(todayView, "TodayView").mockImplementation(() => <section>Today destination</section>);
    vi.spyOn(clientView, "ClientCommitmentsView").mockImplementation(() => <section>Commitments destination</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); fireEvent.click(screen.getByRole("button", { name: "Q section" }));
    await screen.findByText(section === "commitments" ? "Commitments destination" : "Today destination");
    expect(screen.queryByText("Referencia seleccionada")).toBeNull(); expect(screen.queryByText("Detalle de tarea")).toBeNull();
  });

  it("retains the existing explicit Today editor launch separately from operating navigation", async () => {
    const open = vi.spyOn(apiClient, "openProject").mockResolvedValue(undefined);
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject, onOpenEditor }) => <section><button onClick={() => void onOpenProject("stock-control")}>Internal project</button><button onClick={() => void onOpenEditor?.("stock-control")}>Explicit editor</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onBack }) => <section>Today project {project.id}<button onClick={onBack}>Return from project</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Internal project" }));
    await screen.findByText("Today project stock-control"); expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return from project" })); fireEvent.click(await screen.findByRole("button", { name: "Explicit editor" }));
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("stock-control", "vscode"));
  });

  it("returns Today -> project -> task -> project -> Today without carrying sidebar state", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject, onOpenHarness }) => <section>Today root<button onClick={() => void onOpenProject("stock-control")}>Inspect Today project</button><button onClick={() => onOpenHarness?.("stock-control")}>Inspect Today Harness</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onOpenTask, onBack }) => <section>Today project {project.id}<button onClick={() => onOpenTask("TASK-TODAY")}>Inspect project task</button><button onClick={onBack}>Project back</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Today task {taskId}<button onClick={onBack}>Task back</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect Today project" })); await screen.findByText("Today project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Inspect project task" })); await screen.findByText("Today task TASK-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Task back" })); await screen.findByText("Today project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Project back" })); await screen.findByText("Today root");
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Today Harness" })); await screen.findByText("Today project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByRole("button", { name: "Detalle operativo de stock-control" });
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => /\/open(?:\?|$)/.test(String(url)) || (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it.each([
    { kind: "objective", id: "OBJ-TODAY" }, { kind: "project", id: "missing-project" },
    { kind: "task", id: "TASK-TODAY" }, { kind: "issue", id: "ISSUE-TODAY", projectId: "stock-control" },
    { kind: "workflow", id: "WF-TODAY", issueId: "ISSUE-TODAY", projectId: "stock-control" },
  ] satisfies OperatingNavigationTarget[])("opens the exact Today $kind reference internally and returns without inventing links", async target => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onNavigate }) => <section>Today recommendation<button onClick={() => onNavigate?.(target)}>Inspect lineage</button></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId }) => <section>Today objective {focusedObjectiveId ?? "none"}</section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId }) => <section>Today execution {taskId}</section>);
    const issue = vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `Today workflow ${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Today issue list"}</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect lineage" }));
    if (target.kind === "objective") await screen.findByText("Today objective OBJ-TODAY");
    else if (target.kind === "project") await screen.findByText("El proyecto ya no está en el portfolio actual.");
    else if (target.kind === "task") await screen.findByText("Today execution TASK-TODAY");
    else if (target.kind === "issue") {
      await screen.findByText("Today issue list"); expect(screen.getByRole("link", { name: "Ir a tarjeta ISSUE-TODAY" }).getAttribute("href")).toBe("#work-issue-ISSUE-TODAY");
      expect(issue.mock.calls.at(-1)?.[0]?.workflowFocus).toBeNull();
    } else await screen.findByText("Today workflow stock-control/ISSUE-TODAY/WF-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Today recommendation");
    expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
  });

  it.each(["issue", "workflow"] as const)("keeps a Today %s as the immediate task return before returning to Today", async kind => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onNavigate }) => <section>Today issue origin<button onClick={() => onNavigate?.(kind === "issue" ? { kind: "issue", id: "ISSUE-TODAY", projectId: "stock-control" } : { kind: "workflow", id: "WF-TODAY", issueId: "ISSUE-TODAY", projectId: "stock-control" })}>Inspect issue lineage</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <section>{workflowFocus ? `Immediate ${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Immediate issue list"}<button onClick={() => onOpenTask?.("TASK-ISSUE-TODAY")}>Inspect issue task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Immediate task {taskId}<button onClick={onBack}>Immediate back</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect issue lineage" })); fireEvent.click(await screen.findByRole("button", { name: "Inspect issue task" }));
    await screen.findByText("Immediate task TASK-ISSUE-TODAY"); fireEvent.click(screen.getByRole("button", { name: "Immediate back" }));
    await screen.findByText(kind === "workflow" ? "Immediate ISSUE-TODAY/WF-TODAY" : "Immediate issue list");
    if (kind === "issue") expect(screen.getByRole("link", { name: "Ir a tarjeta ISSUE-TODAY" }).getAttribute("href")).toBe("#work-issue-ISSUE-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Today issue origin");
    fireEvent.click(screen.getByRole("button", { name: "Issues" })); await screen.findByText("Immediate issue list");
    expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull(); expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
  });

  it("preserves Today return through a task's exact workflow and clears it on sidebar navigation", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenTask }) => <section>Today task origin<button onClick={() => onOpenTask("TASK-TODAY")}>Inspect Today task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onOpenWorkflow, onBack }) => <section>Owned task {taskId}<button onClick={() => onOpenWorkflow?.({ issueId: "ISSUE-TODAY", workflowId: "WF-TODAY", projectId: "stock-control" })}>Inspect owning workflow</button><button onClick={onBack}>Back from stage task</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <section>{workflowFocus ? `Owned workflow ${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "No Today workflow"}<button onClick={() => onOpenTask?.("TASK-STAGE")}>Inspect stage</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect Today task" })); fireEvent.click(await screen.findByRole("button", { name: "Inspect owning workflow" }));
    await screen.findByText("Owned workflow stock-control/ISSUE-TODAY/WF-TODAY"); fireEvent.click(screen.getByRole("button", { name: "Inspect stage" })); await screen.findByText("Owned task TASK-STAGE");
    fireEvent.click(screen.getByRole("button", { name: "Back from stage task" })); await screen.findByText("Owned workflow stock-control/ISSUE-TODAY/WF-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Today task origin");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Today task" })); fireEvent.click(screen.getByRole("button", { name: "Inspect owning workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Issues" })); await screen.findByText("No Today workflow"); expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
  });

  it("keeps the Today origin behind objective -> project -> task navigation and direct task return", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onNavigate, onOpenTask }) => <section>Today hierarchy root<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-TODAY" })}>Inspect Today objective</button><button onClick={() => onOpenTask("DIRECT-TODAY")}>Inspect direct task</button></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>Origin objective {focusedObjectiveId ?? "none"}<button onClick={() => onNavigate?.({ kind: "project", id: "stock-control" })}>Inspect objective project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onOpenTask, onBack }) => <section>Origin project {project.id}<button onClick={() => onOpenTask("OBJECTIVE-TODAY")}>Inspect objective task</button><button onClick={onBack}>Return to origin objective</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Origin task {taskId}<button onClick={onBack}>Return to immediate origin</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect direct task" })); await screen.findByText("Origin task DIRECT-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Return to immediate origin" })); await screen.findByText("Today hierarchy root");
    fireEvent.click(screen.getByRole("button", { name: "Inspect Today objective" })); await screen.findByText("Origin objective OBJ-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Inspect objective project" })); await screen.findByText("Origin project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Inspect objective task" })); await screen.findByText("Origin task OBJECTIVE-TODAY");
    fireEvent.click(screen.getByRole("button", { name: "Return to immediate origin" })); await screen.findByText("Origin project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Return to origin objective" })); await screen.findByText("Origin objective OBJ-TODAY");
    expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-TODAY" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Today hierarchy root");
  });

  it("keeps a Harness project reference exact even when its ID equals the organization root", async () => {
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenHarness }) => <button onClick={() => onOpenHarness?.("surtec")}>Inspect root-named Harness project</button>);
    const organization = vi.spyOn(organizationView, "OrganizationView").mockImplementation(() => <section>Organization root</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect root-named Harness project" }));
    await screen.findByText("El proyecto ya no está en el portfolio actual."); expect(organization).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Volver al portfolio" })); await screen.findByRole("button", { name: "Inspect root-named Harness project" });
  });

  it("distinguishes a real Today project named surtec from the explicit organization-root callback", async () => {
    vi.spyOn(apiClient, "useOverview").mockReturnValue({ data: { ...overview, projects: [{ ...overview.projects[0]!, id: "surtec" }] }, error: null });
    const open = vi.spyOn(apiClient, "openProject").mockResolvedValue(undefined);
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onOpenProject, onOpenOrganization }) => <section>Root-name Today origin<button onClick={() => void onOpenProject("surtec")}>Inspect actual surtec project</button><button onClick={() => onOpenOrganization?.()}>Inspect organization root</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onBack }) => <section>Actual root-named project {project.id}<button onClick={onBack}>Return from root-named project</button></section>);
    const organization = vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId }) => <section>Explicit organization root {focusedObjectiveId ?? "without objective"}</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Inspect actual surtec project" }));
    await screen.findByText("Actual root-named project surtec"); expect(organization).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return from root-named project" })); fireEvent.click(await screen.findByRole("button", { name: "Inspect organization root" }));
    await screen.findByText("Explicit organization root without objective"); expect(screen.queryByText("Actual root-named project surtec")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Root-name Today origin");
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull(); expect(open).not.toHaveBeenCalled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it.each([null, "client-product", "personal", "experiment", "internal-tool", "surtec-product", "template"] satisfies Signal["project_kind"][])("prefills only generic inspection for hostile recommendation text with project kind %s", async projectKind => {
    const signal: Signal = { schema_version: 1, id: "private-signal", project_id: "stock-control", project_kind: projectKind, source: "note", type: "follow-up", severity: "warning", title: "SYNTHETIC_PRIVATE_TITLE", reason: "SYNTHETIC_PRIVATE_FEEDBACK", evidence_at: today.generated_at, observed_at: today.generated_at, suggested_action: "SYNTHETIC_PRIVATE_ACTION", action_kind: "prepare-task", ranking: { tier: "unfinished-work", order: 1 }, state: "open", snoozed_until: null, evidence: { note: "SYNTHETIC_PRIVATE_NOTE", role_id: "engineer", client_context_categories: ["feedback"], instructions: "SYNTHETIC_PRIVATE_INSTRUCTIONS" } };
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask }) => <button onClick={() => onPrepareTask(signal)}>Prepare generic task</button>);
    vi.spyOn(apiClient, "fetchDispatchOptions").mockResolvedValue({ projects: [dispatchProject("stock-control")] });
    vi.spyOn(apiClient, "getContextRoles").mockResolvedValue({ roles: [] });
    const OriginalForm = taskForm.NewTaskForm;
    const form = vi.spyOn(taskForm, "NewTaskForm").mockImplementation(props => <OriginalForm {...props} />);
    render(<App />); await screen.findByText("1 repos · 1 tareas activas"); fireEvent.click(screen.getByRole("button", { name: "Prepare generic task" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Instrucciones" }) as HTMLTextAreaElement).value).toBe("Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form."));
    expect(form.mock.calls[0]?.[0]?.initialProject).toBe("stock-control");
    expect(JSON.stringify(form.mock.calls)).not.toContain("SYNTHETIC_PRIVATE");
    expect(Object.keys(form.mock.calls[0]![0])).toEqual(["bulkProjectIds", "initialProject", "initialInstructions", "onPrefillConsumed"]);
    expect((screen.getByRole("button", { name: "Despachar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull(); expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("refuses a missing Today prefill project without selecting a different project or copying private text", async () => {
    const signal: Signal = { schema_version: 1, id: "sig_missing_project", project_id: "missing-project", project_kind: null, source: "note", type: "synthetic-gap", severity: "info", title: "Missing synthetic project", evidence_at: "2026-10-16T12:00:00Z", observed_at: "2026-10-16T12:00:00Z", action_kind: "review-evidence", ranking: { tier: "unfinished-work", order: 1 }, state: "open", snoozed_until: null, suggested_action: "SYNTHETIC_PRIVATE_ACTION", reason: "SYNTHETIC_PRIVATE_NOTE", evidence: { instructions: "SYNTHETIC_PRIVATE_INSTRUCTIONS" } };
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask }) => <section>Missing recommendation origin<button onClick={() => onPrepareTask(signal)}>Prepare missing project</button></section>);
    const form = vi.spyOn(taskForm, "NewTaskForm").mockImplementation(({ initialProject, initialInstructions }) => <section>{initialProject ? `Unexpected prefill ${initialProject}` : "No substituted task project"}<p>{initialInstructions}</p></section>);
    render(<App />); await screen.findByText("Missing recommendation origin");
    fireEvent.click(screen.getByRole("button", { name: "Prepare missing project" })); await screen.findByText("El proyecto ya no está en el portfolio actual.");
    expect(screen.getByText("missing-project")).toBeTruthy(); expect(form).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
    fireEvent.click(screen.getByRole("button", { name: "Volver al portfolio" })); await screen.findByText("Missing recommendation origin");
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByText("No substituted task project");
    expect(form.mock.calls.at(-1)?.[0]?.initialProject).toBeUndefined(); expect(form.mock.calls.at(-1)?.[0]?.initialInstructions).toBeUndefined();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("clears an unconsumed Today prefill, objective return and issue focus when navigation changes", async () => {
    const signal = { project_id: "stock-control", project_kind: null, source: "note", suggested_action: "SYNTHETIC_PRIVATE_ACTION", reason: "SYNTHETIC_PRIVATE_NOTE" } as Signal;
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask, onNavigate }) => <section>Today clean origin<button onClick={() => onPrepareTask(signal)}>Prepare unconsumed task</button><button onClick={() => onNavigate?.({ kind: "issue", id: "ISSUE-TODAY", projectId: "stock-control" })}>Choose Today issue</button></section>);
    vi.spyOn(apiClient, "fetchDispatchOptions").mockResolvedValue({ projects: [dispatchProject("stock-control")] });
    vi.spyOn(taskForm, "NewTaskForm").mockImplementation(({ initialProject, initialInstructions }) => <section>{initialProject ? `Prefill ${initialProject}` : "No task prefill"}<p>{initialInstructions}</p></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>{focusedObjectiveId ? `Previous objective ${focusedObjectiveId}` : "No previous objective"}<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-OLD" })}>Choose old objective</button><button onClick={() => onNavigate?.({ kind: "section", section: "sessions" })}>Go to Today</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(() => <section>Today issue destination</section>);
    render(<App />); await screen.findByText("1 repos · 1 tareas activas"); fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); fireEvent.click(screen.getByRole("button", { name: "Choose old objective" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to Today" })); fireEvent.click(await screen.findByRole("button", { name: "Prepare unconsumed task" })); await screen.findByText("Prefill stock-control");
    expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-OLD" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hoy" })); fireEvent.click(screen.getByRole("button", { name: "Choose Today issue" })); await screen.findByText("Today issue destination");
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByText("No task prefill");
    expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE"); expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull(); expect(screen.queryByRole("button", { name: "Volver a Hoy" })).toBeNull();
  });

  it.each(["omitted-project", "failed-read"] as const)("keeps the original project detail without a prefill when dispatch options return %s", async outcome => {
    const signal = { project_id: "stock-control", project_kind: "personal", source: "note", reason: "SYNTHETIC_PRIVATE_NOTE", suggested_action: "SYNTHETIC_PRIVATE_ACTION" } as Signal;
    const options = vi.spyOn(apiClient, "fetchDispatchOptions");
    if (outcome === "omitted-project") options.mockResolvedValue({ projects: [dispatchProject("another-project")] });
    else options.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_DISPATCH_ERROR"));
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask }) => <section>Unconfigured recommendation origin<button onClick={() => onPrepareTask(signal)}>Prepare unconfigured project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project }) => <section>Original project detail {project.id}</section>);
    const form = vi.spyOn(taskForm, "NewTaskForm").mockImplementation(({ initialProject, initialInstructions }) => <section>{initialProject ? `Unexpected project ${initialProject}` : "No dispatch prefill"}<p>{initialInstructions}</p></section>);
    render(<App />); await screen.findByText("1 repos · 1 tareas activas");
    expect(options).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Prepare unconfigured project" }));
    await screen.findByText("Original project detail stock-control"); expect(options).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("No pude confirmar este proyecto en las opciones actuales; no se preparó un borrador ni se eligió otro proyecto. Revisá su configuración antes de reintentar.");
    expect(form).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE"); expect(document.body.textContent).not.toContain("another-project");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Hoy" })); await screen.findByText("Unconfigured recommendation origin"); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByText("No dispatch prefill");
    expect(form.mock.calls.at(-1)?.[0]?.initialProject).toBeUndefined(); expect(form.mock.calls.at(-1)?.[0]?.initialInstructions).toBeUndefined();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it.each(["sidebar", "new-selection"] as const)("ignores a late dispatch-options response after %s navigation", async destination => {
    let complete!: (value: apiClient.DispatchOptions) => void;
    const options = vi.spyOn(apiClient, "fetchDispatchOptions").mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const signal = { project_id: "stock-control", project_kind: "personal", source: "note", reason: "SYNTHETIC_PRIVATE_NOTE", suggested_action: "SYNTHETIC_PRIVATE_ACTION" } as Signal;
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask, onNavigate }) => <section>Pending prefill origin<button onClick={() => onPrepareTask(signal)}>Prepare pending project</button><button onClick={() => onNavigate?.({ kind: "task", id: "TASK-NEW-SELECTION" })}>Choose another task</button></section>);
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(() => <section>Unrelated organization destination</section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId }) => <section>New selection {taskId}</section>);
    const form = vi.spyOn(taskForm, "NewTaskForm").mockImplementation(({ initialProject }) => <section>{initialProject ? `Unexpected pending prefill ${initialProject}` : "No pending task prefill"}</section>);
    render(<App />); await screen.findByText("1 repos · 1 tareas activas"); fireEvent.click(screen.getByRole("button", { name: "Prepare pending project" }));
    expect(options).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: destination === "sidebar" ? "SURTEC" : "Choose another task" }));
    const expectedDestination = destination === "sidebar" ? "Unrelated organization destination" : "New selection TASK-NEW-SELECTION";
    await screen.findByText(expectedDestination);
    await act(async () => { complete({ projects: [dispatchProject("stock-control")] }); });
    expect(screen.getByText(expectedDestination)).toBeTruthy(); expect(form).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByText("No pending task prefill"); expect(form.mock.calls.at(-1)?.[0]?.initialProject).toBeUndefined();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("ignores a late private dispatch-options failure after the pending preparation is unmounted", async () => {
    let fail!: (reason: Error) => void;
    vi.spyOn(apiClient, "fetchDispatchOptions").mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const signal = { project_id: "stock-control", project_kind: null, source: "note" } as Signal;
    vi.spyOn(todayView, "TodayView").mockImplementation(({ onPrepareTask }) => <button onClick={() => onPrepareTask(signal)}>Prepare before unmount</button>);
    const form = vi.spyOn(taskForm, "NewTaskForm");
    const view = render(<App />); await screen.findByText("1 repos · 1 tareas activas"); fireEvent.click(screen.getByRole("button", { name: "Prepare before unmount" })); view.unmount();
    await act(async () => { fail(new Error("SYNTHETIC_PRIVATE_LATE_ERROR")); });
    expect(form).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
  });

  it("keeps typed operating project/task return navigation internal and resets sidebar selections", async () => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ onNavigate, focusedObjectiveId }) => <section>Operating home {focusedObjectiveId}<button onClick={() => onNavigate?.({ kind: "project", id: "stock-control" })}>Q project</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onOpenTask, onBack }) => <section>Q project {project.id}<button onClick={() => onOpenTask("TASK-Q")}>Q task</button><button onClick={onBack}>Q back</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Q task {taskId}<button onClick={onBack}>Q back</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" }));
    fireEvent.click(screen.getByRole("button", { name: "Q project" })); await screen.findByText("Q project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Q task" })); await screen.findByText("Q task TASK-Q");
    fireEvent.click(screen.getByRole("button", { name: "Q back" })); await screen.findByText("Q project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Q back" })); await screen.findByText("Operating home");
    fireEvent.click(screen.getByRole("button", { name: "Overview" })); await screen.findByRole("button", { name: "Detalle operativo de stock-control" });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => /\/open(?:\?|$)/.test(String(url)) || (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("returns objective -> project -> task -> project -> exact objective and closes its selection", async () => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate, onCloseObjective }) => <section>{focusedObjectiveId ? `Objective detail ${focusedObjectiveId}` : "No objective detail"}<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-Q" })}>Open Q objective</button><button onClick={() => onNavigate?.({ kind: "project", id: "stock-control" })}>Open linked project</button><button onClick={onCloseObjective}>Close Q objective</button></section>);
    vi.spyOn(projectDetail, "ProjectDetailView").mockImplementation(({ project, onOpenTask, onBack }) => <section>Linked project {project.id}<button onClick={() => onOpenTask("TASK-Q")}>Inspect linked task</button><button onClick={onBack}>Return from project</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Linked task {taskId}<button onClick={onBack}>Return from task</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Q objective" })); await screen.findByText("Objective detail OBJ-Q");
    fireEvent.click(screen.getByRole("button", { name: "Open linked project" })); await screen.findByText("Linked project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Inspect linked task" })); await screen.findByText("Linked task TASK-Q");
    fireEvent.click(screen.getByRole("button", { name: "Return from task" })); await screen.findByText("Linked project stock-control");
    fireEvent.click(screen.getByRole("button", { name: "Return from project" })); await screen.findByText("Objective detail OBJ-Q");
    expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-Q" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Q objective" })); await screen.findByText("No objective detail");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it.each([
    { kind: "issue", id: "ISSUE-Q", projectId: "stock-control" },
    { kind: "workflow", id: "WF-Q", issueId: "ISSUE-Q", projectId: "stock-control" },
    { kind: "task", id: "TASK-Q" },
    { kind: "section", section: "commitments" },
  ] satisfies OperatingNavigationTarget[])("retains the objective return reference across $kind navigation and clears it on sidebar", async target => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>{focusedObjectiveId ? `Focused ${focusedObjectiveId}` : "Unfocused SURTEC"}<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-Q" })}>Select objective</button><button onClick={() => onNavigate?.(target)}>Inspect contribution</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Issue list without workflow focus"}</section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId }) => <section>Selected task {taskId}</section>);
    vi.spyOn(clientView, "ClientCommitmentsView").mockImplementation(() => <section>Commitments view</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" }));
    fireEvent.click(screen.getByRole("button", { name: "Select objective" })); await screen.findByText("Focused OBJ-Q");
    fireEvent.click(screen.getByRole("button", { name: "Inspect contribution" })); await screen.findByRole("button", { name: "Volver al objetivo OBJ-Q" });
    if (target.kind === "issue") { await screen.findByText("Issue list without workflow focus"); expect(screen.getByRole("link", { name: "Ir a tarjeta ISSUE-Q" }).getAttribute("href")).toBe("#work-issue-ISSUE-Q"); }
    else if (target.kind === "workflow") await screen.findByText("ISSUE-Q/WF-Q");
    else if (target.kind === "task") await screen.findByText("Selected task TASK-Q");
    else await screen.findByText("Commitments view");
    fireEvent.click(screen.getByRole("button", { name: "Volver al objetivo OBJ-Q" })); await screen.findByText("Focused OBJ-Q");
    fireEvent.click(screen.getByRole("button", { name: "Inspect contribution" })); fireEvent.click(screen.getByRole("button", { name: "SURTEC" }));
    await screen.findByText("Unfocused SURTEC"); expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-Q" })).toBeNull();
  });

  it("preserves objective return when inspecting a task's exact workflow, without carrying it to unrelated navigation", async () => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>{focusedObjectiveId ?? "No focus"}<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-Q" })}>Objective</button><button onClick={() => onNavigate?.({ kind: "task", id: "TASK-Q" })}>Evidence task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ onOpenWorkflow }) => <button onClick={() => onOpenWorkflow?.({ issueId: "ISSUE-Q", workflowId: "WF-Q", projectId: "stock-control" })}>Exact workflow</button>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "No workflow"}</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); fireEvent.click(screen.getByRole("button", { name: "Objective" }));
    fireEvent.click(screen.getByRole("button", { name: "Evidence task" })); fireEvent.click(await screen.findByRole("button", { name: "Exact workflow" }));
    await screen.findByText("stock-control/ISSUE-Q/WF-Q"); fireEvent.click(screen.getByRole("button", { name: "Volver al objetivo OBJ-Q" }));
    await screen.findByText("OBJ-Q"); fireEvent.click(screen.getByRole("button", { name: "Issues" })); await screen.findByText("No workflow");
    expect(screen.queryByRole("button", { name: "Volver al objetivo OBJ-Q" })).toBeNull();
  });

  it.each(["issue", "workflow"] as const)("returns a task opened from an objective's %s to its immediate issue view before returning to the objective", async kind => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ focusedObjectiveId, onNavigate }) => <section>{focusedObjectiveId ?? "No objective"}<button onClick={() => onNavigate?.({ kind: "objective", id: "OBJ-Q" })}>Choose objective</button><button onClick={() => onNavigate?.(kind === "issue" ? { kind: "issue", id: "ISSUE-Q", projectId: "stock-control" } : { kind: "workflow", id: "WF-Q", issueId: "ISSUE-Q", projectId: "stock-control" })}>Choose issue evidence</button></section>);
    vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus, onOpenTask } = {}) => <section>{workflowFocus ? `Retained ${workflowFocus.issueId}/${workflowFocus.workflowId}` : "Retained issue list"}<button onClick={() => onOpenTask?.("TASK-ISSUE")}>Issue evidence task</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId, onBack }) => <section>Evidence task: {taskId}<button onClick={onBack}>Return to evidence owner</button></section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); fireEvent.click(screen.getByRole("button", { name: "Choose objective" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose issue evidence" })); fireEvent.click(await screen.findByRole("button", { name: "Issue evidence task" }));
    await screen.findByText("Evidence task: TASK-ISSUE"); fireEvent.click(screen.getByRole("button", { name: "Return to evidence owner" }));
    await screen.findByText(kind === "workflow" ? "Retained ISSUE-Q/WF-Q" : "Retained issue list");
    if (kind === "issue") expect(screen.getByRole("link", { name: "Ir a tarjeta ISSUE-Q" }).getAttribute("href")).toBe("#work-issue-ISSUE-Q");
    expect(screen.queryByText("Evidence task: TASK-ISSUE")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Volver al objetivo OBJ-Q" })); await screen.findByText("OBJ-Q");
  });

  it.each([
    { kind: "objective", id: "objective-q" }, { kind: "task", id: "TASK-Q" },
    { kind: "issue", id: "ISSUE-Q", projectId: "stock-control" },
    { kind: "workflow", id: "WF-Q", issueId: "ISSUE-Q", projectId: "stock-control" },
    { kind: "project", id: "no-longer-in-portfolio" },
  ] satisfies OperatingNavigationTarget[])("routes exact operating $kind references without inventing another workflow or project", async (target) => {
    vi.spyOn(organizationView, "OrganizationView").mockImplementation(({ onNavigate, focusedObjectiveId }) => <section>Q objective {focusedObjectiveId ?? "none"}<button onClick={() => onNavigate?.(target)}>Q navigate</button></section>);
    vi.spyOn(taskDetail, "TaskDetailView").mockImplementation(({ taskId }) => <section>Exact task {taskId}</section>);
    const issues = vi.spyOn(issueView, "IssuesView").mockImplementation(({ workflowFocus } = {}) => <section>{workflowFocus ? `Exact workflow ${workflowFocus.projectId}/${workflowFocus.issueId}/${workflowFocus.workflowId}` : "No workflow selected"}</section>);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); fireEvent.click(screen.getByRole("button", { name: "Q navigate" }));
    if (target.kind === "objective") await screen.findByText(`Q objective ${target.id}`);
    else if (target.kind === "task") await screen.findByText(`Exact task ${target.id}`);
    else if (target.kind === "project") await screen.findByText("El proyecto ya no está en el portfolio actual.");
    else if (target.kind === "issue") {
      await screen.findByRole("region", { name: "Referencia de issue" });
      expect(screen.getByRole("link", { name: "Ir a tarjeta ISSUE-Q" }).getAttribute("href")).toBe("#work-issue-ISSUE-Q");
      expect(issues.mock.calls.at(-1)?.[0]?.workflowFocus).toBeNull();
    } else await screen.findByText("Exact workflow stock-control/ISSUE-Q/WF-Q");
    fireEvent.click(screen.getByRole("button", { name: "Issues" })); await screen.findByText("No workflow selected");
    expect(screen.queryByRole("region", { name: "Referencia de issue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "SURTEC" })); await screen.findByText("Q objective none");
  });

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
