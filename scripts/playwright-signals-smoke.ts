import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import type { SignalEvidenceSnapshot } from "../lib/signals/engine";
import type { TaskRecord } from "../lib/state/types";
import { createApp } from "../dashboard/src/server/index";
import { createHttpSecurity } from "../dashboard/src/server/http-security";
import { createSignalService } from "../dashboard/src/server/signal-service";

const token = "playwright-local-signal-smoke-token";
const now = new Date();
const at = now.toISOString();
const deadline = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const task = {
  envelope: {
    id: "smoke-task", source: "smoke", project: "smoke-project", task_type: "test", agent: "codex", title: "Smoke task",
    instructions: "", repo_path: ".", branch: "main", sandbox: "read-only", expected_outputs: [],
    requires_human_approval: false, metadata: {},
  },
  lifecycle: "finished", outcome: "failed", created_at: at, started_at: at, updated_at: at, finished_at: at,
  result: null, logs_path: null,
} as TaskRecord;

const evidence: SignalEvidenceSnapshot = {
  projects: [{
    id: "smoke-project", status: "discovered", git: null, integrations: null, last_activity_at: at, notes: [],
    profile: {
      schema_version: 2, project_id: "smoke-project", kind: "personal", lifecycle: "active", priority: 3,
      criticality: "medium", current_goal: null, next_action: null, deadline,
      client_id: null, last_reviewed_at: at.slice(0, 10), tags: [],
    },
  }],
  tasks: [task],
  issues: [],
};

function startServer(statePath: string, port: number): ReturnType<typeof serve> {
  const signals = createSignalService({ reader: { read: async () => evidence }, statePath });
  const app = createApp(process.cwd(), () => {}, undefined, createHttpSecurity(token), { signals });
  app.get("/__playwright__", (context) => context.html("<!doctype html><html><body><main>Signal API browser smoke</main></body></html>"));
  return serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}

async function waitForListen(server: ReturnType<typeof serve>): Promise<number> {
  if (server.listening) return (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return (server.address() as AddressInfo).port;
}

async function stopServer(server: ReturnType<typeof serve>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "surtec-playwright-signals-"));
  const statePath = join(tempRoot, "signals", "human-state.json");
  let browser: Browser | null = null;
  let server: ReturnType<typeof serve> | null = null;
  try {
    browser = await launchBrowser();
    server = startServer(statePath, 0);
    const port = await waitForListen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/__playwright__`);
    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const firstRun = await page.evaluate(async ({ expectedToken, until }) => {
      const sessionResponse = await fetch("/api/session", { cache: "no-store" });
      const session = await sessionResponse.json() as { token: string };
      const response = await fetch("/api/signals", { cache: "no-store" });
      const feed = await response.json() as { signals: { id: string; type: string; state: string; snoozed_until: string | null }[]; pinned_signal_ids: string[] };
      const actionByType: Record<string, Record<string, string>> = {
        "missing-current-goal": { action: "acknowledge" },
        "missing-next-action": { action: "snooze", until },
        "deadline-approaching": { action: "pin-for-today" },
        "task-failed": { action: "resolve" },
      };
      const statuses: number[] = [];
      for (const signal of feed.signals) {
        const action = actionByType[signal.type];
        if (!action) continue;
        const result = await fetch(`/api/signals/${signal.id}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Surtec-Session": session.token },
          body: JSON.stringify(action),
        });
        statuses.push(result.status);
      }
      const denied = await fetch(`/api/signals/${feed.signals[0].id}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }),
      });
      return { sessionOk: session.token === expectedToken, feedCount: feed.signals.length, statuses, deniedStatus: denied.status };
    }, { expectedToken: token, until: snoozeUntil });

    assert.equal(firstRun.sessionOk, true, "browser received the in-memory local session token");
    assert.ok(firstRun.feedCount >= 4, "browser received deterministic fake signal evidence");
    assert.ok(firstRun.statuses.length === 4 && firstRun.statuses.every((status) => status === 200), "all signal actions were accepted");
    assert.equal(firstRun.deniedStatus, 403, "mutation without the session token was rejected");

    await stopServer(server);
    server = startServer(statePath, port);
    await waitForListen(server);
    await page.reload();
    const afterRestart = await page.evaluate(async () => {
      const response = await fetch("/api/signals", { cache: "no-store" });
      const feed = await response.json() as { signals: { type: string; state: string; snoozed_until: string | null }[]; pinned_signal_ids: string[] };
      return {
        states: Object.fromEntries(feed.signals.map((signal) => [signal.type, { state: signal.state, snoozed_until: signal.snoozed_until }])),
        pinCount: feed.pinned_signal_ids.length,
      };
    });
    assert.equal(afterRestart.states["missing-current-goal"]?.state, "acknowledged");
    assert.equal(afterRestart.states["missing-next-action"]?.state, "snoozed");
    assert.equal(afterRestart.states["deadline-approaching"]?.state, "open");
    assert.equal(afterRestart.states["task-failed"]?.state, "resolved");
    assert.equal(afterRestart.pinCount, 1);
    console.log("Playwright signal API smoke passed: same-origin reads, session-protected mutations, and restart persistence verified.");
    await page.close();
  } finally {
    if (server?.listening) await stopServer(server);
    if (browser) await browser.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
