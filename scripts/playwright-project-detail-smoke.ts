import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import type { ProjectIntegrationsSnapshot } from "../lib/integrations/types";
import type { ProjectProfile } from "../lib/portfolio-profile";
import type { OverviewModel, ProjectView, TodayModel } from "../lib/state/types";
import type { Signal, SignalFeed } from "../lib/signals/types";

const sessionToken = "playwright-project-detail-smoke-session-token";
const observedAt = new Date().toISOString();
const refreshedAt = new Date(Date.now() + 60_000).toISOString();
const integrationReads = new Map<string, number>();
const refreshReads: string[] = [];
let taskPosts = 0;
let legacyProviderReads = 0;

function project(id: string, configured: boolean, repo: string | null): ProjectView {
  return {
    id, status: configured ? "active" : "discovered", health: null, note: null, repo, path: null, configured,
    git: configured ? { branch: "main", dirty: false, uncommitted: 0, ahead: 1, behind: 0,
      last_commit: { hash: "abc1234", subject: `Synthetic commit for ${id}`, at: observedAt }, ok: true } : null,
    last_activity: observedAt, task_counts: { inProgress: id === "configured-project" ? 1 : 0, finished: 1 },
  };
}

const projects = [
  project("configured-project", true, "https://github.com/fictional/configured-project.git"),
  project("unconfigured-project", false, null),
  project("degraded-project", true, "https://github.com/fictional/degraded-project.git"),
];

const overview: OverviewModel = {
  projects,
  inProgress: [{ id: "task-active", project: "configured-project", agent: "backend-engineer", title: "Synthetic active task",
    lifecycle: "running", outcome: null, updated_at: observedAt, finished_at: null, requires_human_approval: false,
    attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  history: [{ id: "task-recent", project: "configured-project", agent: "qa-reviewer", title: "Synthetic recent task",
    lifecycle: "finished", outcome: "completed", updated_at: observedAt, finished_at: observedAt, requires_human_approval: false,
    attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null }],
  attention: [],
};

const profile = (id: string, kind: ProjectProfile["kind"] = "personal"): ProjectProfile => ({
  schema_version: 2, project_id: id, kind, lifecycle: "active", priority: 2, criticality: "medium",
  current_goal: `Synthetic goal for ${id}`, next_action: `Review synthetic next action for ${id}`,
  deadline: null, client_id: kind === "client-product" ? "private-fixture-client-id" : null,
  last_reviewed_at: observedAt.slice(0, 10), tags: ["fictional"],
});

function signal(id: string, projectId: string, state: Signal["state"]): Signal {
  return {
    schema_version: 1, id: `sig_${id.padStart(24, "0")}`, project_id: projectId, project_kind: "personal",
    source: "profile", type: "active-project-stale", severity: "warning", title: `Synthetic ${state} signal for ${projectId}`,
    reason: "Fictional evidence for browser validation.", evidence_at: observedAt, observed_at: observedAt,
    suggested_action: "Review the synthetic next action.", action_kind: "review-project",
    ranking: { tier: "hygiene", order: 1 }, state, snoozed_until: state === "snoozed" ? refreshedAt : null,
    evidence: { days_since_review: 40 },
  };
}

const signals: Signal[] = [
  signal("1", "configured-project", "open"),
  signal("2", "configured-project", "snoozed"),
  signal("3", "configured-project", "resolved"),
];

const today: TodayModel = {
  date: observedAt.slice(0, 10), time_zone: "America/Buenos_Aires", generated_at: observedAt,
  active: overview.inProgress, attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
  counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 }, warnings: [],
  portfolio: { signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [], work_to_continue: [],
    client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [],
    sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] } },
};

function integrations(id: string, refreshed: boolean): ProjectIntegrationsSnapshot {
  const at = refreshed ? refreshedAt : observedAt;
  if (id === "unconfigured-project") {
    return {
      schema_version: 2, project_id: id, observed_at: at, trace_id: null,
      source_control: { provider: "git", configured: false, health: "unconfigured", branch: null, dirty: null, uncommitted: null, ahead: null, behind: null,
        remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
      ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
      dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: at },
      deployments: [
        { provider: "http-health", configured: false, health: "unconfigured", status: null, observed_at: at, url: null, http_status: null, latency_ms: null, deployed_at: null },
        { provider: "railway", configured: false, health: "unconfigured", status: null, observed_at: at, url: null, http_status: null, latency_ms: null, deployed_at: null },
      ],
    };
  }

  const degraded = id === "degraded-project";
  return {
    schema_version: 2, project_id: id, observed_at: at, trace_id: null,
    source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
      remote: { provider: "github", configured: true, health: degraded ? "unknown" : "ok",
        pull_requests: degraded ? null : 2, issues: degraded ? null : 4,
        waiting_pull_requests: degraded ? [] : [{ number: 12, updated_at: at, review_decision: "REVIEW_REQUIRED" }],
        ...(degraded ? { error: "GitHub unavailable in fictional fixture" } : {}) } },
    ci: { provider: "github-actions", configured: true, health: degraded ? "unknown" : "ok", status: degraded ? "unknown" : "passing", branch: "main",
      ...(degraded ? { error: "CI unavailable in fictional fixture" } : { run_id: "1001", run_updated_at: at }) },
    dependencies: { provider: "npm", configured: true, health: degraded ? "unknown" : "ok", outdated: degraded ? 0 : 0, observed_at: at,
      ...(degraded ? { error: "npm install required in fictional fixture" } : {}) },
    deployments: [
      { provider: "http-health", configured: true, health: degraded ? "unknown" : "ok", status: degraded ? null : "up", observed_at: at,
        url: degraded ? null : "https://configured.example.test", http_status: degraded ? null : 200, latency_ms: degraded ? null : 37, deployed_at: at,
        ...(degraded ? { error: "health check unavailable in fictional fixture" } : {}) },
      { provider: "railway", configured: true, health: degraded ? "unknown" : "ok", status: degraded ? null : "success", observed_at: at,
        url: degraded ? null : "https://railway.example.test", http_status: null, latency_ms: null, deployed_at: at,
        ...(degraded ? { error: "Railway unavailable in fictional fixture" } : {}) },
    ],
  };
}

function emptySignals(): SignalFeed {
  return { schema_version: 1, observed_at: observedAt, signals, pinned_signal_ids: [], warnings: [] };
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

async function clickProjectDetail(page: Page, id: string): Promise<void> {
  await page.getByRole("button", { name: `Detalle operativo de ${id}` }).click();
  await page.getByRole("heading", { name: "Integraciones" }).waitFor();
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  try {
    browser = await launchBrowser();
    vite = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0, strictPort: true } });
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/api\/projects\/[^/]+\/(github|deps|deploy|railway)$/.test(path)) legacyProviderReads += 1;
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let status = 200;
      let body: unknown;
      if (url.pathname === "/api/overview") body = overview;
      else if (url.pathname === "/api/today") body = today;
      else if (url.pathname === "/api/runs") body = { runs: [] };
      else if (url.pathname === "/api/portfolio/profiles") body = { profiles: [
        profile("configured-project", "client-product"), profile("unconfigured-project"), profile("degraded-project"),
      ] };
      else if (url.pathname === "/api/session") body = { token: sessionToken };
      else if (url.pathname === "/api/dispatch-options") body = { projects: projects.map((item) => ({
        project: item.id, allowed_agents: ["backend-engineer"], project_sandbox_ceiling: "workspace-write",
        has_local_checkout: true, has_verification_commands: true,
        agents: [{ agent: "backend-engineer", agent_sandbox_ceiling: "workspace-write", allowed_modes: ["read-only", "workspace-write"],
          default_mode: "read-only", modes: [{ mode: "read-only", allowed: true, reason: null }, { mode: "workspace-write", allowed: true, reason: null }] }],
      })) };
      else if (url.pathname === "/api/signals") body = emptySignals();
      else if (url.pathname === "/api/activity") body = { items: [
        { kind: "commit", at: observedAt, project: "configured-project", hash: "abc1234", subject: "Synthetic recent commit", author: "Fixture Author" },
        { kind: "task", at: observedAt, project: "configured-project", taskId: "task-active", agent: "backend-engineer", title: "Synthetic active task", state: "en curso" },
      ] };
      else if (url.pathname.endsWith("/integrations")) {
        const id = url.pathname.split("/").at(-2) ?? "";
        const refreshed = url.searchParams.get("refresh") === "true";
        integrationReads.set(id, (integrationReads.get(id) ?? 0) + 1);
        if (refreshed) refreshReads.push(id);
        body = integrations(id, refreshed);
      } else if (url.pathname.endsWith("/notes")) body = { notes: [{ id: "note-fictional", text: "Synthetic local note", done: false, created_at: observedAt }] };
      else if (url.pathname === "/api/tasks" && request.method() === "POST") { taskPosts += 1; status = 201; body = { id: "unexpected-task" }; }
      else if (url.pathname.startsWith("/api/projects/") && url.pathname.endsWith("/open") && request.method() === "POST") body = { ok: true };
      else { status = 404; body = { error: "fictional fixture endpoint not found" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });

    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: /Overview/ }).click();

    await clickProjectDetail(page, "configured-project");
    await page.getByText("Synthetic goal for configured-project").waitFor();
    await page.getByText("Synthetic active task", { exact: true }).first().waitFor();
    await page.getByText("Synthetic recent task").waitFor();
    await page.getByText("Synthetic open signal for configured-project").waitFor();
    await page.getByText("Synthetic snoozed signal for configured-project").waitFor();
    await page.getByText("Synthetic resolved signal for configured-project").waitFor();
    await page.getByText("Synthetic recent commit").waitFor();
    await page.getByText("Synthetic local note").waitFor();
    await page.getByText("No hay sesiones activas o pausadas para este proyecto.").waitFor();
    await page.getByText("2 PR abiertas · 4 issues abiertas").waitFor();
    await page.getByRole("link", { name: /PR #12/ }).waitFor();
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("private-fixture-client-id")), false,
      "the local client reference is not rendered in the detail page");
    assert.equal(integrationReads.get("configured-project"), 1, "the configured detail used one aggregate integration read");

    await page.getByRole("button", { name: "Actualizar" }).click();
    await page.locator(`[title="${refreshedAt}"]`).first().waitFor();
    assert.deepEqual(refreshReads, ["configured-project"], "manual refresh requested a cache-bypassing aggregate read");

    await page.getByRole("button", { name: /Preparar tarea/ }).click();
    await page.getByLabel("Proyecto").waitFor();
    assert.equal(await page.getByLabel("Proyecto").inputValue(), "configured-project", "safe quick action prefills the project");
    assert.equal(await page.getByPlaceholder(/instrucciones/i).inputValue(),
      "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.",
      "client project profile text is not copied into task instructions automatically");
    assert.equal(taskPosts, 0, "preparing a task did not dispatch it");

    await page.getByRole("button", { name: /Overview/ }).click();
    await clickProjectDetail(page, "degraded-project");
    await page.getByText("GitHub unavailable in fictional fixture").waitFor();
    await page.getByText("health check unavailable in fictional fixture").waitFor();
    await page.getByText("Synthetic goal for degraded-project").waitFor();
    await page.getByRole("heading", { name: "Tareas activas" }).waitFor();
    assert.equal(integrationReads.get("degraded-project"), 1, "degraded providers did not prevent the aggregate detail from loading");

    await page.getByRole("button", { name: /Overview/ }).click();
    await clickProjectDetail(page, "unconfigured-project");
    await page.getByText("Sin configurar", { exact: true }).first().waitFor();
    await page.getByText("Synthetic goal for unconfigured-project").waitFor();
    assert.equal(integrationReads.get("unconfigured-project"), 1, "unconfigured detail used one aggregate integration read");
    assert.equal(legacyProviderReads, 0, "ProjectCard/detail did not issue redundant provider-specific reads");

    console.log("Playwright Project Detail smoke passed: configured, unconfigured, degraded, freshness refresh, grouped project state, and safe task prefill.");
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
