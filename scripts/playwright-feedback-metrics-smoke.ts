import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import type { FeedbackMetrics } from "../lib/feedback-metrics";
import type { TodayModel } from "../lib/state/types";

const sessionToken = "playwright-feedback-metrics-session-token";
const now = new Date().toISOString();
const metrics: FeedbackMetrics = {
  schema_version: 1,
  generated_at: now,
  recommendations: { actions_recorded: 4, accepted: 2, snoozed: 1, dismissed: 1, pinned: 1, median_evidence_to_action_ms: 90_000, latency_samples: 3 },
  tasks: { total: 5, terminal: 4, completed: 3, retried: 1, needs_review: 1, success_rate: 0.75, retry_rate: 0.2, needs_review_rate: 0.25 },
  verification: { passed: 3, failed: 1, skipped: 0, missing: 0, eligible: 4, pass_rate: 0.75 },
  work_sessions: { total: 3, completed: 2, closed: 3, completed_with_next_action: 1, next_action_captured: 2, completion_rate: 2 / 3, next_action_capture_rate: 2 / 3 },
  signals: { freshness_eligible: 6, stale: 2, stale_rate: 1 / 3 },
};

function today(): TodayModel {
  return {
    date: now.slice(0, 10), time_zone: "America/Buenos_Aires", generated_at: now,
    active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
    counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
    portfolio: {
      signal_status: "available", signals_observed_at: now, recommendations: [], critical_attention: [], work_to_continue: [],
      client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [], pinned_signal_ids: [], warnings: [],
      sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
    },
    warnings: [],
  };
}

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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const metricRequests: string[] = [];
    const writes: string[] = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let body: unknown = {};
      let status = 200;
      if (request.method() !== "GET") writes.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === "/api/overview") body = { projects: [], inProgress: [], history: [], attention: [] };
      else if (url.pathname === "/api/today") body = today();
      else if (url.pathname === "/api/runs") body = { runs: [] };
      else if (url.pathname === "/api/portfolio/profiles") body = { profiles: [] };
      else if (url.pathname === "/api/session") body = { token: sessionToken };
      else if (url.pathname === "/api/feedback/metrics") { metricRequests.push(request.method()); body = metrics; }
      else { status = 404; body = { error: "synthetic fixture endpoint not found" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });

    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();
    assert.equal(metricRequests.length, 0, "aggregate metrics are not polled while another dashboard view is open");
    await page.getByRole("button", { name: /Feedback/ }).click();
    await page.getByRole("heading", { name: "Feedback operativo" }).waitFor();
    await page.getByText("2 aceptadas · 1 pospuestas · 1 descartadas").waitFor();
    await page.getByText("75% completadas").waitFor();
    await page.getByText("2/6 vencidas").waitFor();
    assert.deepEqual(metricRequests, ["GET"], "the feedback view makes one read-only aggregate request on demand");
    assert.deepEqual(writes, [], "the feedback view performs no mutations");

    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/feedback/metrics");
    await page.getByRole("button", { name: "Actualizar" }).click();
    assert.equal((await refreshed).status(), 200, "manual refresh receives local metrics");
    assert.deepEqual(metricRequests, ["GET", "GET"], "manual refresh re-reads local aggregates only");
    console.log("Playwright Feedback Metrics smoke passed: on-demand aggregate read, recommendation/task/session/signal metrics, refresh, and no mutations.");
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
