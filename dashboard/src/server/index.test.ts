import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index";

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-api-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    status: active\n",
    "utf8",
  );
  stateDir = join(root, "state");
  mkdirSync(join(stateDir, "tasks"), { recursive: true });
  const task = {
    envelope: {
      id: "STK-1", source: "cli", project: "stock-control", task_type: "bugfix",
      agent: "backend-engineer", title: "Fix it", instructions: "x", repo_path: "~/dev",
      branch: "agent/STK-1", sandbox: "workspace-write", expected_outputs: [],
      requires_human_approval: false, metadata: {},
    },
    lifecycle: "running", outcome: null, created_at: "2026-05-28T10:00:00Z",
    started_at: "2026-05-28T10:00:00Z", updated_at: "2026-05-28T10:00:00Z",
    finished_at: null, result: null, logs_path: null,
  };
  writeFileSync(join(stateDir, "tasks", "STK-1.json"), JSON.stringify(task), "utf8");
  process.env.SURTEC_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("api", () => {
  it("GET /api/overview returns the four view arrays", async () => {
    const app = createApp(root);
    const res = await app.request("/api/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["stock-control"]);
    expect(body.inProgress.map((t: { id: string }) => t.id)).toEqual(["STK-1"]);
    expect(body.history).toEqual([]);
  });

  it("GET /api/tasks/:id returns the record", async () => {
    const app = createApp(root);
    const res = await app.request("/api/tasks/STK-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope.id).toBe("STK-1");
  });

  it("GET /api/tasks/:id returns 404 when missing", async () => {
    const app = createApp(root);
    const res = await app.request("/api/tasks/NOPE");
    expect(res.status).toBe(404);
  });
});
