import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import type { ProjectIntegrationsSnapshot } from "../lib/integrations/types";
import type { OverviewModel, ProjectView, TodayModel, TodayWorkSessionState, WorkSession, WorkSessionView } from "../lib/state/types";

const sessionToken = "playwright-work-session-smoke-token";
const observedAt = new Date().toISOString();
const sessionId = "ws_fictional-session";
const mutations: { path: string; token: string | null; action: string | null }[] = [];
let stored: WorkSession | null = null;
let relatedTasks: WorkSessionView["related_tasks"] = [];
let relatedRuns: WorkSessionView["related_runs"] = [];
let elapsed = 0;
let activeSince: number | null = null;
let processStopRequests = 0;

function project(): ProjectView {
  return {
    id: "fictional-alpha", status: "active", health: "ok", note: null, repo: "https://github.com/fictional/alpha", path: null, configured: true,
    git: { branch: "feature/resume", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
    last_activity: observedAt, task_counts: { inProgress: 0, finished: 0 },
  };
}

const overview: OverviewModel = { projects: [project()], inProgress: [], history: [], attention: [] };

function snapshot(): TodayWorkSessionState {
  if (!stored) return { available: true, unavailable_reason: null, active: [], paused: [], completed: [] };
  const session: WorkSessionView = {
    ...stored,
    elapsed_focused_ms: elapsed + (activeSince == null ? 0 : Math.max(0, Date.now() - activeSince)),
    related_tasks: relatedTasks,
    related_runs: relatedRuns,
  };
  return {
    available: true,
    unavailable_reason: null,
    active: stored.status === "active" ? [session] : [],
    paused: stored.status === "paused" ? [session] : [],
    completed: stored.status === "completed" ? [session] : [],
  };
}

function today(): TodayModel {
  return {
    date: observedAt.slice(0, 10), time_zone: "America/Buenos_Aires", generated_at: new Date().toISOString(),
    active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
    counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
    portfolio: {
      signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [], work_to_continue: [],
      client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [], sessions: snapshot(),
    },
    warnings: [],
  };
}

function integrations(): ProjectIntegrationsSnapshot {
  return {
    schema_version: 2, project_id: "fictional-alpha", observed_at: observedAt, trace_id: null,
    source_control: { provider: "git", configured: true, health: "ok", branch: "feature/resume", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
      remote: { provider: "github", configured: true, health: "ok", pull_requests: 0, issues: 0, waiting_pull_requests: [] } },
    ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
    dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observedAt },
    deployments: [],
  };
}

function emptySignalFeed() {
  return { schema_version: 1 as const, observed_at: observedAt, signals: [], pinned_signal_ids: [], warnings: [] };
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

function recordMutation(page: Page) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST") return;
    const payload = request.postDataJSON() as { action?: string } | null;
    mutations.push({ path: url.pathname, token: request.headers()["x-surtec-session"] ?? null, action: payload?.action ?? null });
    if (url.pathname.endsWith("/stop")) processStopRequests += 1;
  });
}

async function installRoutes(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/api/overview") body = overview;
    else if (url.pathname === "/api/today") body = today();
    else if (url.pathname === "/api/runs") body = { runs: [] };
    else if (url.pathname === "/api/portfolio/profiles") body = { profiles: [] };
    else if (url.pathname === "/api/session") body = { token: sessionToken };
    else if (url.pathname === "/api/signals") body = emptySignalFeed();
    else if (url.pathname === "/api/activity") body = { items: [] };
    else if (url.pathname.endsWith("/integrations")) body = integrations();
    else if (url.pathname.endsWith("/notes")) body = { notes: [] };
    else if (url.pathname === "/api/sessions" && request.method() === "POST") {
      if (request.headers()["x-surtec-session"] !== sessionToken) status = 403;
      else if (stored?.status === "active") status = 409;
      else {
        const input = request.postDataJSON() as { project_id: string; objective: string };
        const now = new Date().toISOString();
        stored = {
          schema_version: 1, id: sessionId, project_id: input.project_id, objective: input.objective, status: "active", branch: "feature/resume",
          started_at: now, paused_at: null, completed_at: null, related_task_ids: [], related_run_ids: [], notes: [], result_summary: null,
          next_action: null, focused_ms: 0, active_since: now,
        };
        relatedTasks = []; relatedRuns = []; elapsed = 0; activeSince = Date.now();
        status = 201; body = { session: stored };
      }
    } else if (/^\/api\/sessions\/[^/]+\/action$/.test(url.pathname) && request.method() === "POST") {
      if (request.headers()["x-surtec-session"] !== sessionToken) status = 403;
      else if (!stored) status = 404;
      else {
        const action = request.postDataJSON() as { action: string; note?: string; task_ids?: string[]; run_ids?: string[]; next_action?: string; result_summary?: string };
        const now = Date.now();
        if (action.action === "add-note" && action.note) stored.notes.push(action.note);
        if (action.action === "associate") {
          for (const id of action.task_ids ?? []) {
            if (!stored.related_task_ids.includes(id)) stored.related_task_ids.push(id);
            relatedTasks.push({ id, available: true, title: "Fictional linked task", lifecycle: "finished", outcome: "completed", latest_event: "verification", verification: "passed", pull_request_url: "https://github.com/fictional/alpha/pull/9" });
          }
          for (const id of action.run_ids ?? []) {
            if (!stored.related_run_ids.includes(id)) stored.related_run_ids.push(id);
            relatedRuns.push({ id, kind: "dev", status: "running", started_at: new Date().toISOString(), exit_code: null });
          }
        }
        if (action.action === "pause" && stored.status === "active") {
          elapsed += Math.max(0, now - (activeSince ?? now)); activeSince = null;
          stored.status = "paused"; stored.paused_at = new Date(now).toISOString(); stored.active_since = null; stored.next_action = action.next_action ?? null;
        }
        if (action.action === "resume" && stored.status === "paused") {
          stored.status = "active"; stored.paused_at = null; stored.active_since = new Date(now).toISOString(); activeSince = now;
        }
        if (action.action === "complete") {
          if (stored.status === "active") elapsed += Math.max(0, now - (activeSince ?? now));
          activeSince = null; stored.focused_ms = elapsed; stored.active_since = null; stored.status = "completed";
          stored.paused_at = null; stored.completed_at = new Date(now).toISOString(); stored.next_action = action.next_action ?? null; stored.result_summary = action.result_summary ?? null;
        }
        body = { session: stored };
      }
    } else if (url.pathname.startsWith("/api/sessions/") && request.method() === "POST") {
      status = 404; body = { error: "fictional action not found" };
    } else if (url.pathname.startsWith("/api/sessions")) body = snapshot();
    else if (url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/branches")) body = { branches: ["feature/resume", "main"], current: "feature/resume" };
    else if (url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/git")) body = { ok: true, output: "" };
    else { status = 404; body = { error: `fictional fixture endpoint not found: ${url.pathname}` }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  try {
    browser = await launchBrowser();
    vite = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0, strictPort: true } });
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    recordMutation(page);
    await installRoutes(page);
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();

    await page.getByLabel("Objetivo de la sesión").fill("Retomar el flujo de trabajo ficticio");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.getByRole("heading", { name: "Retomar el flujo de trabajo ficticio" }).waitFor();
    await page.getByText("feature/resume", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Iniciar sesión" }).count(), 0, "an active session prevents another start action");

    await page.getByLabel("Nota rápida").fill("El contrato y las pruebas están implementados.");
    await page.getByRole("button", { name: "Guardar nota" }).click();
    await page.getByText("El contrato y las pruebas están implementados.").waitFor();
    await page.getByLabel("Tareas relacionadas").fill("fictional-task-1");
    await page.getByLabel("Procesos relacionados").fill("fictional-run-1");
    await page.getByRole("button", { name: "Vincular" }).click();
    await page.getByText(/fictional-task-1/).waitFor();
    await page.getByText("fictional-run-1", { exact: true }).waitFor();
    await page.getByLabel("Próximo paso al pausar").fill("Revisar el smoke de navegador");
    await page.getByRole("button", { name: "Pausar sesión" }).click();
    await page.getByText("Pausada", { exact: true }).waitFor();
    await page.getByText("Revisar el smoke de navegador").waitFor();

    await page.reload();
    await page.getByRole("heading", { name: "Retomar el flujo de trabajo ficticio" }).waitFor();
    await page.getByText("Pausada", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Detalle operativo de fictional-alpha" }).click();
    await page.getByRole("heading", { name: "Integraciones" }).waitFor();
    await page.getByRole("heading", { name: "Retomar el flujo de trabajo ficticio" }).waitFor();
    await page.getByRole("link", { name: "Pull request registrada" }).waitFor();
    await page.getByRole("button", { name: "Reanudar sesión" }).click();
    await page.getByText("En curso", { exact: true }).waitFor();
    await page.getByText("Completar sesión").click();
    await page.getByLabel("Resultado").fill("El flujo ficticio quedó implementado y verificado.");
    await page.getByLabel("Próximo paso", { exact: true }).fill("none");
    await page.getByRole("button", { name: "Guardar cierre" }).click();
    await page.getByText("Completada", { exact: true }).waitFor();
    await page.getByText("El flujo ficticio quedó implementado y verificado.").waitFor();
    await page.locator(".work-session-next").filter({ hasText: "none" }).waitFor();

    await page.getByRole("button", { name: "Hoy" }).click();
    await page.getByRole("heading", { name: "Retomar el flujo de trabajo ficticio" }).waitFor();
    const writeRequests = mutations.filter((item) => item.path.startsWith("/api/sessions"));
    assert.equal(writeRequests.length, 6, "start, note, association, pause, resume, and completion each issue one write");
    assert.equal(writeRequests.filter((item) => item.token === sessionToken).length, writeRequests.length, "every session mutation carries the local session token");
    assert.equal(processStopRequests, 0, "session pause/resume/completion never stopped local processes");
    assert.deepEqual(writeRequests.map((item) => item.action), [null, "add-note", "associate", "pause", "resume", "complete"]);

    console.log("Playwright Work Sessions smoke passed: Today start, notes, task/process links, pause, reload, project-detail resume, explicit completion, protected writes, and process safety.");
    await page.close();
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
