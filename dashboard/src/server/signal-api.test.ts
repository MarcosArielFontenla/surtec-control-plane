import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SignalEvidenceSnapshot } from "../../../lib/signals/engine";
import { createSignalService } from "./signal-service";
import { createApp } from "./index";
import { createHttpSecurity } from "./http-security";

let root: string;
let statePath: string;
const now = new Date("2026-09-27T12:00:00.000Z");
const evidence: SignalEvidenceSnapshot = {
  projects: [{ id: "alpha", status: "discovered", git: null, profile: null, integrations: null, last_activity_at: null, notes: [] }],
  tasks: [], issues: [],
};

function api() {
  const signals = createSignalService({ reader: { read: async () => evidence }, statePath, clock: () => new Date(now) });
  return createApp(process.cwd(), () => {}, undefined, createHttpSecurity("test-session-token"), { signals });
}

async function feedFor(app: ReturnType<typeof api>): Promise<{ signals: { id: string; type: string; state: string }[]; pinned_signal_ids: string[] }> {
  const response = await app.request("http://127.0.0.1:4317/api/signals");
  return await response.json() as { signals: { id: string; type: string; state: string }[]; pinned_signal_ids: string[] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-signals-api-"));
  statePath = join(root, "signals", "human-state.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("signal API", () => {
  it("returns one validated, no-store feed with project failures isolated as warnings", async () => {
    const app = api();
    const response = await app.request("http://127.0.0.1:4317/api/signals");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { schema_version: number; signals: { type: string }[]; warnings: string[] };
    expect(body.schema_version).toBe(1);
    expect(body.signals.map((signal) => signal.type)).toEqual(expect.arrayContaining(["missing-current-goal", "missing-next-action"]));
    expect(body.warnings).toEqual([]);
  });

  it("requires the local session token and strictly validates signal action IDs and bodies", async () => {
    const app = api();
    const feed = await feedFor(app);
    const signalId = feed.signals[0].id;
    expect((await app.request(`http://127.0.0.1:4317/api/signals/${signalId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "acknowledge" }),
    })).status).toBe(403);
    const headers = { "Content-Type": "application/json", "X-Surtec-Session": "test-session-token" };
    expect((await app.request("http://127.0.0.1:4317/api/signals/not-valid/action", {
      method: "POST", headers, body: JSON.stringify({ action: "acknowledge" }),
    })).status).toBe(400);
    expect((await app.request(`http://127.0.0.1:4317/api/signals/${signalId}/action`, {
      method: "POST", headers, body: JSON.stringify({ action: "acknowledge", surprise: "field" }),
    })).status).toBe(400);
    const snooze = await app.request(`http://127.0.0.1:4317/api/signals/${signalId}/action`, {
      method: "POST", headers, body: JSON.stringify({ action: "snooze", until: now.toISOString() }),
    });
    expect(snooze.status).toBe(400);
  });

  it("persists human state across service recreation and supports pin, dismiss, and resolve", async () => {
    const firstApp = api();
    const original = await feedFor(firstApp);
    const byType = new Map(original.signals.map((signal) => [signal.type, signal.id]));
    const headers = { "Content-Type": "application/json", "X-Surtec-Session": "test-session-token" };
    const act = async (type: string, action: Record<string, string>) => firstApp.request(`http://127.0.0.1:4317/api/signals/${byType.get(type)}/action`, {
      method: "POST", headers, body: JSON.stringify(action),
    });
    expect((await act("missing-current-goal", { action: "acknowledge" })).status).toBe(200);
    expect((await act("missing-next-action", { action: "pin-for-today" })).status).toBe(200);
    expect((await act("project-review-stale", { action: "dismiss" })).status).toBe(200);

    const restarted = api();
    const afterRestart = await feedFor(restarted);
    expect(afterRestart.signals.find((signal) => signal.id === byType.get("missing-current-goal"))?.state).toBe("acknowledged");
    expect(afterRestart.pinned_signal_ids).toContain(byType.get("missing-next-action"));
    expect(afterRestart.signals.map((signal) => signal.id)).not.toContain(byType.get("project-review-stale"));
    const dismissedAction = await restarted.request(`http://127.0.0.1:4317/api/signals/${byType.get("project-review-stale")}/action`, {
      method: "POST", headers, body: JSON.stringify({ action: "resolve" }),
    });
    expect(dismissedAction.status).toBe(404);
    const resolve = await restarted.request(`http://127.0.0.1:4317/api/signals/${byType.get("missing-current-goal")}/action`, {
      method: "POST", headers, body: JSON.stringify({ action: "resolve" }),
    });
    expect(resolve.status).toBe(200);
    expect((await feedFor(api())).signals.find((signal) => signal.id === byType.get("missing-current-goal"))?.state).toBe("resolved");
  });

  it("rejects a signal occurrence that disappeared from current evidence", async () => {
    const service = createSignalService({ reader: { read: async () => ({ projects: [], tasks: [], issues: [] }) }, statePath, clock: () => new Date(now) });
    const app = createApp(process.cwd(), () => {}, undefined, createHttpSecurity("test-session-token"), { signals: service });
    const response = await app.request(`http://127.0.0.1:4317/api/signals/sig_${"a".repeat(24)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Surtec-Session": "test-session-token" },
      body: JSON.stringify({ action: "resolve" }),
    });
    expect(response.status).toBe(404);
  });

  it("returns conflict for an unsupported human-state version without rewriting it", async () => {
    const app = api();
    const future = JSON.stringify({ schema_version: 2, records: {} });
    mkdirSync(join(root, "signals"), { recursive: true });
    writeFileSync(statePath, "{broken", "utf8");
    const malformed = await app.request("http://127.0.0.1:4317/api/signals");
    expect(malformed.status).toBe(500);
    expect(JSON.stringify(await malformed.json())).not.toContain(root);
    writeFileSync(statePath, future, "utf8");
    const response = await app.request("http://127.0.0.1:4317/api/signals");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/unsupported/);
    expect(readFileSync(statePath, "utf8")).toBe(future);
  });
});
