import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import type { Signal, SignalRankingTier } from "../lib/signals/types";
import type { TodayModel } from "../lib/state/types";

const sessionToken = "playwright-today-smoke-session-token";
const observedAt = new Date().toISOString();

function signal(index: number, overrides: Partial<Signal> = {}): Signal {
  const tiers: SignalRankingTier[] = ["production-failure", "client-commitment", "blocked-work", "imminent-deadline", "unfinished-work", "maintenance", "hygiene"];
  return {
    schema_version: 1,
    id: `sig_${index.toString(16).padStart(24, "0")}`,
    project_id: `fictional-project-${index}`,
    project_kind: index % 2 === 0 ? "client-product" : "personal",
    source: "profile",
    type: index % 2 === 0 ? "deadline-approaching" : "active-project-stale",
    severity: index === 1 ? "critical" : index < 4 ? "warning" : "info",
    title: `Fictional recommendation ${index}`,
    reason: `Synthetic evidence for fictional project ${index}.`,
    evidence_at: observedAt,
    observed_at: observedAt,
    suggested_action: "Review the fictional next step.",
    action_kind: "review-project",
    ranking: { tier: tiers[Math.min(index - 1, tiers.length - 1)]!, order: Math.min(index, 7) },
    state: "open",
    snoozed_until: null,
    evidence: { days_remaining: index },
    ...overrides,
  };
}

function emptyToday(): TodayModel {
  return {
    date: observedAt.slice(0, 10),
    time_zone: "America/Buenos_Aires",
    generated_at: observedAt,
    active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
    counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
    portfolio: {
      signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [],
      work_to_continue: [], client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [],
      pinned_signal_ids: [], warnings: [],
      sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
    },
    warnings: [],
  };
}

function fixtureToday(name: string, signals: Signal[], warning = false): TodayModel {
  if (name === "empty") return emptyToday();
  const open = signals.filter((item) => item.state === "open" || item.state === "acknowledged");
  const feedWarnings = warning ? ["GitHub issue evidence for fictional-project-2 is unavailable."] : [];
  const base = emptyToday();
  base.active = name === "healthy" ? [{
    id: "fictional-task-1", project: "fictional-project-1", agent: "backend-engineer", title: "Maintain fictional service",
    lifecycle: "running", outcome: null, updated_at: observedAt, finished_at: null, requires_human_approval: false,
    attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
  }] : [];
  base.counts.active = base.active.length;
  base.portfolio.signal_status = warning ? "degraded" : "available";
  base.portfolio.warnings = feedWarnings;
  base.portfolio.recommendations = open.slice(0, 3);
  base.portfolio.critical_attention = open.filter((item) => item.severity === "critical" || ["production-failure", "client-commitment", "blocked-work"].includes(item.ranking.tier));
  base.portfolio.work_to_continue = open.filter((item) => item.ranking.tier === "unfinished-work");
  base.portfolio.client_commitments = open.filter((item) => item.project_kind === "client-product" && (item.ranking.tier === "client-commitment" || item.type.startsWith("deadline-")));
  base.portfolio.personal_opportunities = open.filter((item) => item.project_kind === "personal");
  base.portfolio.stale_profiles = open.filter((item) => item.type === "active-project-stale");
  base.portfolio.snoozed_signals = signals.filter((item) => item.state === "snoozed");
  base.portfolio.pinned_signal_ids = signals.filter((item) => item.evidence.pinned === true).map((item) => item.id);
  base.warnings = feedWarnings;
  return base;
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

async function serveFixture(vite: ViteDevServer, browser: Browser, name: string, overload = false, warning = false): Promise<void> {
  const signals = name === "objective" ? [
    signal(1, { project_id: "objective-project", project_kind: "surtec-product", evidence: { primary_objective_id: "obj-primary", primary_objective_title: "Objetivo primario" } }),
    signal(2, { project_id: "surtec", project_kind: null, source: "objective", type: "objective-without-projects", title: "Outcome Surtec", evidence: { objective_id: "obj-global", objective_title: "Outcome Surtec" } }),
  ] : name === "empty" || name === "healthy" ? [] : Array.from({ length: overload ? 9 : 2 }, (_, index) => signal(index + 1));
  const actions: { id: string; action: string; token: string | null }[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown;
    let status = 200;
    if (url.pathname === "/api/overview") body = { projects: [], inProgress: [], history: [], attention: [] };
    else if (url.pathname === "/api/today") body = fixtureToday(name, signals, warning);
    else if (url.pathname === "/api/runs") body = { runs: [] };
    else if (url.pathname === "/api/portfolio/profiles") body = { profiles: [] };
    else if (url.pathname === "/api/session") body = { token: sessionToken };
    else if (url.pathname === "/api/dispatch-options") body = { projects: [{
      project: "fictional-project-1", allowed_agents: ["backend-engineer"], project_sandbox_ceiling: "workspace-write",
      has_local_checkout: true, has_verification_commands: true,
      agents: [{ agent: "backend-engineer", agent_sandbox_ceiling: "workspace-write", allowed_modes: ["read-only", "workspace-write"],
        default_mode: "read-only", modes: [{ mode: "read-only", allowed: true, reason: null }, { mode: "workspace-write", allowed: true, reason: null }] }],
    }] };
    else if (url.pathname.startsWith("/api/signals/") && url.pathname.endsWith("/action") && request.method() === "POST") {
      const payload = request.postDataJSON() as { action?: string };
      const id = url.pathname.split("/").at(-2) ?? "";
      const suppliedToken = request.headers()["x-surtec-session"] ?? null;
      actions.push({ id, action: payload.action ?? "", token: suppliedToken });
      if (suppliedToken !== sessionToken) status = 403;
      else {
        const current = signals.find((item) => item.id === id);
        if (!current) status = 404;
        else if (payload.action === "pin-for-today") current.evidence.pinned = true;
        else if (payload.action === "snooze") current.state = "snoozed";
        else if (payload.action === "resolve") current.state = "resolved";
        else if (payload.action === "dismiss") current.state = "resolved";
        else current.state = "acknowledged";
        body = fixtureToday(name, signals, warning).portfolio;
      }
    } else {
      status = 404;
      body = { error: "fixture endpoint not found" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });

  try {
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();

    if (name === "healthy") {
      await page.getByText("Tu cartera está tranquila.").waitFor();
      await page.getByText("Maintain fictional service").waitFor();
    } else if (name === "objective") {
      await page.getByText("Apoya el objetivo: Objetivo primario").waitFor();
      const objectiveCard = page.locator(".today-signal").filter({ hasText: "Outcome Surtec" });
      await objectiveCard.getByRole("button", { name: "Abrir SURTEC" }).waitFor();
      assert.equal(await objectiveCard.getByRole("button", { name: /Preparar tarea/ }).count(), 0, "company-level objective signal does not prefill a fake project task");
    } else if (name === "degraded") {
      await page.getByText("Inteligencia parcial").waitFor();
      await page.getByText("GitHub issue evidence for fictional-project-2 is unavailable.").waitFor();
      await page.getByRole("button", { name: /Reconocer/ }).first().click();
      await page.getByText("Reconocida").first().waitFor();
      assert.equal(actions.length, 1, "a signal action was issued once");
      assert.equal(actions[0]?.token, sessionToken, "signal mutation carried the local session token");
      assert.equal(actions[0]?.action, "acknowledge");
      await page.getByRole("button", { name: /Fijar/ }).first().click();
      await page.getByText("Fijada hoy").first().waitFor();
      assert.equal(actions[1]?.token, sessionToken, "pin action carried the local session token");
      assert.equal(actions[1]?.action, "pin-for-today");
      await page.getByText("En vivo", { exact: true }).waitFor();
      await page.getByRole("button", { name: /Preparar tarea/ }).first().click();
      await page.getByLabel("Proyecto").waitFor();
      assert.equal(await page.getByLabel("Proyecto").inputValue(), "fictional-project-1", "recommendation prefilled its project");
      assert.match(await page.getByPlaceholder(/instrucciones/i).inputValue(), /Review the fictional next step/);
    } else if (name === "overloaded") {
      const nowSection = page.getByText("Ahora · recomendaciones principales").locator("xpath=../..");
      await nowSection.locator(".today-signal").first().waitFor();
      assert.equal(await nowSection.locator(".today-signal").count(), 3, "only the top three recommendations are rendered");
      await page.getByText("Prioridad #1 · Producción").first().waitFor();
    } else {
      await page.getByText("Tu cartera está tranquila.").waitFor();
      await page.getByText("Nada por ahora").waitFor();
      assert.equal(await page.locator(".today-signal").count(), 0);
    }
    console.log(`PASS Playwright Today fixture: ${name}${warning ? " (degraded source)" : ""}${overload ? " (overloaded)" : ""}`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  try {
    browser = await launchBrowser();
    vite = await createServer({
      configFile: "vite.config.ts",
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await vite.listen();
    await serveFixture(vite, browser, "healthy");
    await serveFixture(vite, browser, "objective");
    await serveFixture(vite, browser, "degraded", false, true);
    await serveFixture(vite, browser, "overloaded", true);
    await serveFixture(vite, browser, "empty");
    console.log("Playwright Today cockpit smoke passed: healthy, degraded, overloaded, empty, and protected human-action flows.");
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
