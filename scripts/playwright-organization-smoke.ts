import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import type { CompanyProfile, Objective, OrganizationSnapshot } from "../lib/organization";
import type { Signal, SignalFeed } from "../lib/signals/types";
import type { OverviewModel, ProjectView, TodayModel } from "../lib/state/types";

const sessionToken = "playwright-organization-session-token";
const observedAt = new Date().toISOString();
const reviewDate = observedAt.slice(0, 10);
const objective = (id: string, overrides: Partial<Objective> = {}): Objective => ({
  schema_version: 1, id, company_id: "surtec", title: `Outcome ${id}`, desired_outcome: `Synthetic result for ${id}.`,
  success_criteria: ["Observable evidence is available."], status: "active", horizon: "quarter", priority: 2,
  target_date: "2026-12-31", parent_objective_id: null, project_ids: [], owner: "marcos", last_reviewed_at: reviewDate,
  ...overrides,
});
const objectives = [
  objective("obj-healthy", { project_ids: ["healthy-project"] }),
  objective("obj-missing", { project_ids: [], success_criteria: [], last_reviewed_at: null }),
  objective("obj-stale", { project_ids: ["stale-project"], last_reviewed_at: "2026-08-01" }),
  objective("obj-paused", { project_ids: ["paused-project"], status: "paused" }),
  objective("obj-achieved", { project_ids: ["achieved-project"], status: "achieved" }),
];
const company: CompanyProfile = {
  schema_version: 1, id: "surtec", display_name: "SURTEC", mission: "Synthetic local mission.",
  operating_principles: ["Keep decisions observable."], active_objective_ids: ["obj-healthy", "obj-missing", "obj-stale"], last_reviewed_at: reviewDate,
};
const organization: OrganizationSnapshot = {
  company, objectives,
  project_objectives: {
    "healthy-project": { objective_ids: ["obj-healthy"], primary_objective_id: "obj-healthy" },
    "stale-project": { objective_ids: ["obj-stale"], primary_objective_id: "obj-stale" },
    "paused-project": { objective_ids: ["obj-paused"], primary_objective_id: "obj-paused" },
    "achieved-project": { objective_ids: ["obj-achieved"], primary_objective_id: "obj-achieved" },
  },
};
function project(id: string): ProjectView {
  return { id, status: "active", health: "ok", note: null, repo: null, path: null, configured: false, git: null, last_activity: null, task_counts: { inProgress: 0, finished: 0 } };
}
const projects = ["healthy-project", "stale-project", "paused-project", "achieved-project", "personal-project"].map(project);
const overview: OverviewModel = { projects, inProgress: [], history: [], attention: [] };
const emptyToday: TodayModel = {
  date: reviewDate, time_zone: "America/Buenos_Aires", generated_at: observedAt,
  active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
  counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
  portfolio: { signal_status: "available", signals_observed_at: observedAt, recommendations: [], critical_attention: [], work_to_continue: [],
    client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [],
    sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] } }, warnings: [],
};
const staleSignal: Signal = {
  schema_version: 1, id: "sig_aaaaaaaaaaaaaaaaaaaaaaaa", project_id: "stale-project", project_kind: "internal-tool", source: "objective",
  type: "objective-review-stale", severity: "warning", title: "Stale project evidence", reason: "Synthetic warning for browser validation.",
  evidence_at: observedAt, observed_at: observedAt, suggested_action: "Review the linked project.", action_kind: "review-objective",
  ranking: { tier: "maintenance", order: 6 }, state: "open", snoozed_until: null, evidence: { objective_id: "obj-stale", objective_title: "Outcome obj-stale" },
};
const feed: SignalFeed = { schema_version: 1, observed_at: observedAt, signals: [staleSignal], pinned_signal_ids: [], warnings: [] };
const savedCompany: CompanyProfile[] = [];

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  try {
    browser = await launchBrowser();
    vite = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0, strictPort: true } });
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let status = 200;
      let body: unknown = {};
      if (url.pathname === "/api/overview") body = overview;
      else if (url.pathname === "/api/today") body = emptyToday;
      else if (url.pathname === "/api/runs") body = { runs: [] };
      else if (url.pathname === "/api/portfolio/profiles") body = { profiles: [] };
      else if (url.pathname === "/api/organization" && method === "GET") body = organization;
      else if (url.pathname === "/api/signals") body = feed;
      else if (url.pathname === "/api/session") body = { token: sessionToken };
      else if (url.pathname === "/api/dispatch-options") body = { projects: [] };
      else if (url.pathname === "/api/organization/company" && method === "PUT") {
        const payload = request.postDataJSON() as CompanyProfile;
        if (request.headers()["x-surtec-session"] !== sessionToken) status = 403;
        else { savedCompany.push(payload); body = { company: { ...payload, last_reviewed_at: reviewDate } }; }
      } else {
        status = 404; body = { error: `fixture endpoint not found: ${method} ${url.pathname}` };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "SURTEC" }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();

    const card = (id: string) => page.locator(".organization-objective-card").filter({ hasText: `Outcome obj-${id}` });
    assert.match(await card("healthy").innerText(), /Saludable/);
    assert.match(await card("missing").innerText(), /Requiere revisión/);
    assert.match(await card("missing").innerText(), /Faltan criterios de éxito/);
    assert.match(await card("stale").innerText(), /Requiere revisión/);
    assert.match(await card("stale").innerText(), /2026-08-01/);
    assert.match(await card("stale").innerText(), /1 señales de atención/);
    assert.match(await card("paused").innerText(), /Pausada/);
    assert.match(await card("achieved").innerText(), /Lograda/);

    await page.getByLabel("Misión").fill("Updated synthetic local mission.");
    await page.getByRole("button", { name: "Guardar perfil" }).click();
    await page.getByText("Perfil SURTEC guardado localmente.").waitFor();
    assert.equal(savedCompany.length, 1, "company profile is submitted once");
    assert.equal(savedCompany[0]?.mission, "Updated synthetic local mission.");
    assert.equal(await page.getByText("personal-project", { exact: true }).count(), 1, "personal projects remain in the project-link inventory");
    console.log("Playwright Organization smoke passed: company edit, healthy/missing/stale/paused/achieved objective states, project evidence, and authenticated local write.");
    await page.close();
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
