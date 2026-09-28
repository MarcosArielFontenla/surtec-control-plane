import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal, SignalFeed } from "../../../lib/signals/types";
import { applySignalAction } from "../../../lib/state/signals";
import { createApp } from "./index";
import { createHttpSecurity } from "./http-security";

let root: string;
let previousStateDirectory: string | undefined;
const signalId = `sig_${"c".repeat(24)}`;
const now = new Date();
const privateSignal: Signal = {
  schema_version: 1, id: signalId, project_id: "fictional-private-project", project_kind: "client-product", source: "profile",
  type: "missing-next-action", severity: "info", title: "Private synthetic title", reason: "Synthetic private detail",
  evidence_at: now.toISOString(), observed_at: now.toISOString(), suggested_action: "Synthetic next action", action_kind: "edit-project-profile",
  ranking: { tier: "hygiene", order: 1 }, state: "open", snoozed_until: null, evidence: {},
};

beforeEach(() => {
  previousStateDirectory = process.env.SURTEC_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "surtec-feedback-api-"));
  const state = join(root, "state");
  mkdirSync(join(state, "tasks"), { recursive: true });
  process.env.SURTEC_STATE_DIR = state;
  applySignalAction(signalId, { action: "acknowledge" }, { now, evidenceAt: new Date(now.getTime() - 5 * 60_000).toISOString() });
});

afterEach(() => {
  if (previousStateDirectory === undefined) delete process.env.SURTEC_STATE_DIR;
  else process.env.SURTEC_STATE_DIR = previousStateDirectory;
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/feedback/metrics", () => {
  it("returns no-store aggregates only and reads signal evidence on demand", async () => {
    const feed: SignalFeed = { schema_version: 1, observed_at: now.toISOString(), signals: [privateSignal], pinned_signal_ids: [], warnings: [] };
    const read = vi.fn().mockResolvedValue(feed);
    const app = createApp(root, () => {}, undefined, createHttpSecurity("test-feedback-token"), { signals: { read, act: vi.fn() } });
    expect(read).not.toHaveBeenCalled();

    const response = await app.request("/api/feedback/metrics");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      schema_version: 1,
      recommendations: { actions_recorded: 1, accepted: 1, median_evidence_to_action_ms: expect.any(Number), latency_samples: 1 },
      signals: { freshness_eligible: 1, stale: 0, stale_rate: 0 },
    });
    expect(read).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("fictional-private-project");
    expect(serialized).not.toContain("Private synthetic title");
    expect(serialized).not.toContain("Synthetic private detail");
  });

  it("returns a generic error if local evidence is unavailable", async () => {
    const app = createApp(root, () => {}, undefined, createHttpSecurity("test-feedback-token"), {
      signals: { read: vi.fn().mockRejectedValue(new Error("private local path")), act: vi.fn() },
    });
    const response = await app.request("/api/feedback/metrics");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "local feedback metrics are unavailable" });
  });
});
