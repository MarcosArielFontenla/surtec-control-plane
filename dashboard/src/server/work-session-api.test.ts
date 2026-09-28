import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "../../../lib/state/types";
import type { ProcessManager } from "../../../runner/process-manager";
import { createApp } from "./index";
import { createWorkSessionService } from "./work-session-service";

let root: string | undefined;
let now = new Date("2026-09-27T12:00:00.000Z");

async function request(app: ReturnType<typeof createApp>, path: string, body?: unknown): Promise<Response> {
  const session = await app.request("/api/session");
  const token = ((await session.json()) as { token: string }).token;
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Surtec-Session": token },
    body: JSON.stringify(body),
  });
}

function setup() {
  root = mkdtempSync(join(tmpdir(), "surtec-work-session-api-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
  const run: RunRecord = {
    runId: "run-alpha", projectId: "alpha", kind: "dev", command: "pnpm dev", status: "running",
    pid: 101, startedAt: now.toISOString(), endedAt: null, exitCode: null,
  };
  const stop = vi.fn();
  const manager = { start: vi.fn(), stop, get: vi.fn().mockReturnValue({ record: run, log: "" }), list: vi.fn().mockReturnValue([run]), subscribe: vi.fn() } as unknown as ProcessManager;
  const filePath = join(root, "state", "sessions", "work-sessions.json");
  const workSessions = createWorkSessionService(process.cwd(), {
    filePath,
    clock: () => new Date(now),
    resolveProject: (id) => id === "alpha" ? { branch: "feature/local-session" } : null,
    readRun: (id) => id === run.runId ? run : null,
  });
  return { app: createApp(root, () => {}, manager, undefined, { workSessions }), filePath, run, stop };
}

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  now = new Date("2026-09-27T12:00:00.000Z");
});

describe("work session API", () => {
  it("protects writes, supports the full workflow, exposes resume context, and survives service restart", async () => {
    const { app, filePath } = setup();
    const forbidden = await app.request("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: "alpha", objective: "Test" }) });
    expect(forbidden.status).toBe(403);

    const started = await request(app, "/api/sessions", { project_id: "alpha", objective: "Validate the local workflow", related_run_ids: ["run-alpha"] });
    expect(started.status).toBe(201);
    const { session } = await started.json() as { session: { id: string } };
    expect(session.id).toMatch(/^ws_/);

    expect((await request(app, `/api/sessions/${session.id}/action`, { action: "add-note", note: "API flow is in place." })).status).toBe(200);
    now = new Date(now.getTime() + 20 * 60_000);
    expect((await request(app, `/api/sessions/${session.id}/action`, { action: "pause", next_action: "Run the browser smoke" })).status).toBe(200);
    const today = await app.request("/api/today");
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({ portfolio: { sessions: { active: [], paused: [{ objective: "Validate the local workflow", branch: "feature/local-session", next_action: "Run the browser smoke", elapsed_focused_ms: 20 * 60_000, related_runs: [{ id: "run-alpha", status: "running" }], notes: ["API flow is in place."] }] } } });

    now = new Date(now.getTime() + 60 * 60_000);
    expect((await request(app, `/api/sessions/${session.id}/action`, { action: "resume" })).status).toBe(200);
    now = new Date(now.getTime() + 10 * 60_000);
    expect((await request(app, `/api/sessions/${session.id}/action`, { action: "complete", result_summary: "Flow verified.", next_action: "none" })).status).toBe(200);

    const restartedService = createWorkSessionService(process.cwd(), { filePath, clock: () => new Date(now), resolveProject: () => ({ branch: null }) });
    const restartedApp = createApp(root!, () => {}, undefined, undefined, { workSessions: restartedService });
    expect(await (await restartedApp.request("/api/sessions")).json()).toMatchObject({ active: [], paused: [], completed: [{ status: "completed", next_action: "none", result_summary: "Flow verified.", elapsed_focused_ms: 30 * 60_000 }] });
  });

  it("enforces one active session and requires an explicit next action when pausing", async () => {
    const { app } = setup();
    const first = await request(app, "/api/sessions", { project_id: "alpha", objective: "One active session" });
    const { session } = await first.json() as { session: { id: string } };
    expect((await request(app, "/api/sessions", { project_id: "alpha", objective: "Second active session" })).status).toBe(409);
    expect((await request(app, `/api/sessions/${session.id}/action`, { action: "pause", next_action: " " })).status).toBe(400);
    const paused = await request(app, `/api/sessions/${session.id}/action`, { action: "pause", next_action: "Resume after lunch" });
    expect(paused.status).toBe(200);
    expect((await request(app, "/api/sessions", { project_id: "alpha", objective: "Next session" })).status).toBe(201);
    expect((await request(app, "/api/sessions/missing-session/action", { action: "resume" })).status).toBe(404);
  });

  it("does not stop or cancel associated processes when a session is paused", async () => {
    const { app, stop, run } = setup();
    const started = await request(app, "/api/sessions", { project_id: "alpha", objective: "Keep dev process alive", related_run_ids: [run.runId] });
    const { session } = await started.json() as { session: { id: string } };
    const paused = await request(app, `/api/sessions/${session.id}/action`, { action: "pause", next_action: "Continue later" });
    expect(paused.status).toBe(200);
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects malformed request bodies without exposing implementation details", async () => {
    const { app } = setup();
    expect((await request(app, "/api/sessions", { project_id: "alpha", objective: " " })).status).toBe(400);
    const unknown = await request(app, "/api/sessions/does-not-exist/action", { action: "resume" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "work session not found" });
  });

  it("degrades only the session panel when persisted session state is corrupt", async () => {
    const { app, filePath } = setup();
    mkdirSync(join(root!, "state", "sessions"), { recursive: true });
    writeFileSync(filePath, "{", "utf8");
    const response = await app.request("/api/today");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.portfolio.sessions).toMatchObject({ available: false, active: [], paused: [], completed: [] });
    expect(body.active).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(root!);
    const unavailable = await app.request("/api/sessions");
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toEqual({ error: "work session state is unavailable" });
  });
});
