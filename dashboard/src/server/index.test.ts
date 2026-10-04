import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "./index";
import { readTask, updateTask } from "../../../lib/state/store";
import type { ProcessManager } from "../../../runner/process-manager";
import type { RunRecord } from "../../../lib/state/types";
import { appendTaskEvent } from "../../../lib/state/events";
import type { TaskControl } from "../../../runner/task-orchestrator";
import { TaskControlError } from "../../../runner/task-orchestrator";
import { createIssueService } from "./issue-service";

async function apiRequest(app: ReturnType<typeof createApp>, path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return app.request(path, init);
  const session = await app.request("/api/session");
  const { token } = (await session.json()) as { token: string };
  const headers = new Headers(init?.headers);
  headers.set("X-Surtec-Session", token);
  return app.request(path, { ...init, headers });
}

function fakeManager(over: Partial<ProcessManager> = {}): ProcessManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...over,
  } as ProcessManager;
}

function fakeTaskControl(over: Partial<TaskControl> = {}): TaskControl {
  return {
    enqueue: vi.fn(),
    cancel: vi.fn().mockImplementation(() => readTask("STK-1")!),
    retry: vi.fn().mockImplementation(() => readTask("STK-1")!),
    ...over,
  };
}

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-api-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  const projectsRoot = join(root, "projects");
  mkdirSync(join(projectsRoot, "stock-control", ".git"), { recursive: true });
  process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements backend.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    status: active\n    allowed_agents:\n      - backend-engineer\n    sandbox:\n      default: workspace-write\n    commands:\n      build: pnpm build\n",
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
  process.env.SURTEC_TIME_ZONE = "UTC";
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) cpSync(join("registry", name), join(root, "registry", name));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
  }
});

async function previewTask(app: ReturnType<typeof createApp>, input: { project: string; agent: string; instructions: string; client_context_categories?: string[] }) {
  const role_id = "software-engineer";
  const response = await apiRequest(app, "/api/context/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "analysis", ...input, role_id }) });
  expect(response.status).toBe(200);
  const preview = await response.json(); expect(preview.allowed).toBe(true);
  return { ...input, role_id, preview_fingerprint: preview.fingerprint };
}

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  delete process.env.SURTEC_TIME_ZONE;
  rmSync(root, { recursive: true, force: true });
});

describe("api", () => {
  it("protects workflow mutation routes before service invocation or task scheduling", async () => {
    const fired = vi.fn(), preview = vi.fn();
    const app = createApp(root, fired, undefined, undefined, { workflows: { preview } as never });
    for (const path of ["/api/workflows/preview", "/api/workflows/start", "/api/workflows/example/decision", "/api/workflows/example/cancel", "/api/workflows/example/recover"]) expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(403);
    expect(fired).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(existsSync(join(stateDir, "workflows"))).toBe(false);
  });
  it("GET /api/overview returns the four view arrays", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "surtec-ov-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = emptyRoot;
    try {
      const app = createApp(root);
      const res = await app.request("/api/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects).toEqual([]);
      expect(body.inProgress.map((t: { id: string }) => t.id)).toEqual(["STK-1"]);
      expect(body.history).toEqual([]);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("overview returns discovered projects with git status", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "surtec-ov-root-"));
    const alpha = join(projectsRoot, "alpha");
    mkdirSync(alpha, { recursive: true });
    spawnSync("git", ["init", "-b", "main", alpha], { encoding: "utf8" });
    writeFileSync(join(alpha, "f.txt"), "x\n", "utf8");
    spawnSync("git", ["-C", alpha, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    spawnSync("git", ["-C", alpha, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
    process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
    try {
      const app = createApp(root);
      const res = await app.request("/api/overview");
      expect(res.status).toBe(200);
      const body = await res.json();
      const p = body.projects.find((x: { id: string }) => x.id === "alpha");
      expect(p).toBeTruthy();
      expect(p.git.branch).toBe("main");
      expect(p.configured).toBe(false);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(projectsRoot, { recursive: true, force: true });
    }
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

  it("GET /api/tasks/:id/events returns the append-only stream", async () => {
    appendTaskEvent({ task_id: "STK-1", type: "warning", revision: 1, payload: { message: "check" } });
    const app = createApp(root);
    const res = await app.request("/api/tasks/STK-1/events");
    expect(res.status).toBe(200);
    expect((await res.json()).events).toMatchObject([{ task_id: "STK-1", type: "warning" }]);
  });

  it("GET /api/today returns evidence-backed daily operations", async () => {
    appendTaskEvent({ task_id: "STK-1", type: "retry-scheduled", revision: 1, payload: { reason: "transient" }, at: "2026-05-28T11:00:00Z" });
    const app = createApp(root, () => {}, undefined, undefined, {
      signals: {
        read: vi.fn().mockResolvedValue({ schema_version: 1, observed_at: "2026-05-28T12:00:00.000Z", signals: [], pinned_signal_ids: [], warnings: [] }),
        act: vi.fn(),
      },
    });

    const res = await app.request("/api/today?date=2026-05-28");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: "2026-05-28", time_zone: "UTC", counts: { active: 1, retries: 1 },
      active: [{ id: "STK-1" }], retries: [{ task: { id: "STK-1" }, event: { type: "retry-scheduled" } }],
      portfolio: { signal_status: "available", recommendations: [], sessions: { available: true, active: [], paused: [], completed: [] } },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("degrades optional portfolio intelligence without hiding task activity", async () => {
    const app = createApp(root, () => {}, undefined, undefined, {
      signals: {
        read: vi.fn().mockRejectedValue(new Error("private local state path")),
        act: vi.fn(),
      },
    });
    const response = await app.request("/api/today");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.active).toMatchObject([{ id: "STK-1" }]);
    expect(body.portfolio.signal_status).toBe("unavailable");
    expect(body.warnings).toContain("Portfolio intelligence is temporarily unavailable; Codex task activity remains available.");
    expect(JSON.stringify(body)).not.toContain("private local state path");
  });

  it("GET /api/today rejects an invalid date", async () => {
    const res = await createApp(root).request("/api/today?date=today");
    expect(res.status).toBe(400);
  });

  it("GET /api/tasks/:id/detail returns consolidated task evidence", async () => {
    appendTaskEvent({ task_id: "STK-1", type: "policy-evaluated", revision: 1, payload: { allowed: true } });
    const app = createApp(root);

    const res = await app.request("/api/tasks/STK-1/detail");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      task: { envelope: { id: "STK-1" } },
      policy_decisions: [{ type: "policy-evaluated" }],
      diff: { status: "none" },
      cleanup: { status: "unknown" },
    });
  });

  it("GET /api/dispatch-options returns effective project and agent mode capabilities", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/dispatch-options");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toMatchObject([{
      project: "stock-control",
      allowed_agents: ["backend-engineer"],
      project_sandbox_ceiling: "workspace-write",
      has_local_checkout: true,
      has_verification_commands: false,
      agents: [{
        agent: "backend-engineer",
        agent_sandbox_ceiling: "workspace-write",
        allowed_modes: ["read-only", "workspace-write"],
        default_mode: "read-only",
        modes: [
          { mode: "read-only", allowed: true, reason: null },
          { mode: "workspace-write", allowed: true, reason: null },
          { mode: "workspace-write-verify", allowed: false, reason: "project 'stock-control' has no verification commands" },
        ],
      }],
    }]);
  });

  it("POST /api/tasks creates a queued task and returns 201 {id}", async () => {
    const fired: string[] = [];
    const app = createApp(root, (id: string) => { fired.push(id); });
    const res = await apiRequest(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await previewTask(app, { project: "stock-control", agent: "backend-engineer", instructions: "Analyze auth." })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^T-/);
    expect(fired).toEqual([body.id]);
  });
  it("rejects stale or omitted admission without scheduling or persisting a task", async () => {
    const fired = vi.fn(); const app = createApp(root, fired);
    const input = { project: "stock-control", agent: "backend-engineer", instructions: "Inspect synthetic source" };
    const admitted = await previewTask(app, input);
    const post = (body: unknown) => apiRequest(app, "/api/tasks", { method: "POST", body: JSON.stringify(body) });
    expect((await post(input)).status).toBe(400);
    expect((await post({ ...admitted, instructions: "Changed request" })).status).toBe(409);
    expect((await post({ ...admitted, context_manifest: {} })).status).toBe(400);
    expect(fired).not.toHaveBeenCalled();
    expect((await (await app.request("/api/overview")).json()).inProgress).toHaveLength(1);
    // A server restart invalidates the ephemeral issuance ledger.
    const restarted = createApp(root, fired);
    expect((await apiRequest(restarted, "/api/tasks", { method: "POST", body: JSON.stringify(admitted) })).status).toBe(409);
    expect(fired).not.toHaveBeenCalled();
  });
  it("shares the issuance ledger with real locked issue dispatch and rejects stale or forged scope", async () => {
    // The baseline fixture owns this project's writer slot; release it before new admission.
    updateTask("STK-1", (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); });
    writeFileSync(join(root, "registry/projects.yml"), "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n");
    const issues = createIssueService(root, { projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Synthetic fix", expected_outcome: "Bounded result", acceptance_criteria: ["Verified result"], assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Bounded result", acceptance_criteria: ["Verified result"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-human");
    const fired = vi.fn(); const app = createApp(root, fired);
    const previewResponse = await apiRequest(app, "/api/context/preview", { method: "POST", body: JSON.stringify({ kind: "issue", project: issue.project_id, issue_id: issue.id, expected_revision: issue.revision, agent: "backend-engineer", role_id: "software-engineer" }) });
    expect(previewResponse.status).toBe(200); const preview = await previewResponse.json(); expect(preview.allowed).toBe(true);
    const path = `/api/work-issues/${issue.id}/dispatch`;
    const admission = { expected_revision: issue.revision, agent: "backend-engineer", role_id: "software-engineer", preview_fingerprint: preview.fingerprint };
    const post = (body: unknown) => apiRequest(app, path, { method: "POST", body: JSON.stringify(body) });
    const before = readFileSync(join(stateDir, "issues/issues.json"));
    expect((await post({ ...admission, preview_fingerprint: "a".repeat(64) })).status).toBe(409);
    expect((await post({ ...admission, authorized_scope: {} })).status).toBe(400);
    expect(fired).not.toHaveBeenCalled(); expect(readFileSync(join(stateDir, "issues/issues.json"))).toEqual(before);
    const response = await post(admission); expect(response.status).toBe(201); const result = await response.json();
    expect(readTask(result.task_id)!.envelope.context_manifest).toMatchObject({ role_id: "software-engineer", sandbox: "workspace-write", fingerprint: preview.fingerprint });
    expect(result.issue.assigned_role_id).toBe("backend-engineer"); expect(fired).toHaveBeenCalledWith(result.task_id);
    expect((await post(admission)).status).toBe(409); expect(fired).toHaveBeenCalledOnce();
  });

  it("POST /api/tasks rejects workspace writes that are not linked to an authorized issue", async () => {
    const fired: string[] = [];
    const app = createApp(root, (id: string) => { fired.push(id); });
    const res = await apiRequest(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "stock-control", agent: "backend-engineer", instructions: "Implement a change.", sandbox: "workspace-write",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("authorized local issue") });
    expect(fired).toEqual([]);
  });

  it("POST /api/tasks returns 400 for a disallowed agent", async () => {
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks returns 400 for a malformed JSON body", async () => {
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks/:id/cancel delegates to the durable worker control", async () => {
    const cancel = vi.fn().mockImplementation(() => readTask("STK-1")!);
    const app = createApp(root, fakeTaskControl({ cancel }));
    const res = await apiRequest(app, "/api/tasks/STK-1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("STK-1");
  });

  it("POST /api/tasks/:id/retry maps task conflicts to 409", async () => {
    const retry = vi.fn().mockImplementation(() => { throw new TaskControlError("budget exhausted", 409); });
    const app = createApp(root, fakeTaskControl({ retry }));
    const res = await apiRequest(app, "/api/tasks/STK-1/retry", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "budget exhausted" });
  });

  it("task control mutations fail closed when no worker was injected", async () => {
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks/STK-1/cancel", { method: "POST" });
    expect(res.status).toBe(503);
  });

  function writeFinishedReadOnly(id: string): void {
    const repoPath = join(root, "projects", "stock-control");
    const task = {
      envelope: {
        id, source: "dashboard", project: "stock-control", task_type: "analysis",
        agent: "backend-engineer", title: "Look", instructions: "x", repo_path: repoPath,
        branch: `agent/${id}`, sandbox: "read-only", expected_outputs: [],
        requires_human_approval: true, metadata: {},
      },
      lifecycle: "finished", outcome: "completed", created_at: "2026-05-29T10:00:00Z",
      started_at: "2026-05-29T10:00:00Z", updated_at: "2026-05-29T10:00:00Z",
      finished_at: "2026-05-29T10:30:00Z", result: null, logs_path: null, decision: null,
    };
    writeFileSync(join(stateDir, "tasks", `${id}.json`), JSON.stringify(task), "utf8");
  }

  it("POST /api/tasks/:id/approve records an approved decision", async () => {
    writeFinishedReadOnly("RV-1");
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks/RV-1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.status).toBe("approved");
    expect(readTask("RV-1")!.decision?.status).toBe("approved");
  });

  it("POST /api/tasks/:id/reject records a rejected decision", async () => {
    writeFinishedReadOnly("RV-2");
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks/RV-2/reject", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).decision.status).toBe("rejected");
    expect(readTask("RV-2")!.decision?.status).toBe("rejected");
  });

  it("POST /api/tasks/:id/approve returns 404 for a missing task", async () => {
    const app = createApp(root, () => {});
    const res = await apiRequest(app, "/api/tasks/NOPE/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/approve is idempotent when already approved", async () => {
    writeFinishedReadOnly("RV-3");
    const app = createApp(root, () => {});
    const first = await apiRequest(app, "/api/tasks/RV-3/approve", { method: "POST" });
    const res = await apiRequest(app, "/api/tasks/RV-3/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await first.json());
  });

  it("open: 404 for an unknown project", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-open-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(root);
      const res = await apiRequest(app, "/api/projects/ghost/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "vscode" }),
      });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("open: 400 for an invalid target", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-open-bad-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(root);
      const res = await apiRequest(app, "/api/projects/whatever/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "browser" }),
      });
      expect(res.status).toBe(400);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("git sync route", () => {
  it("POST /api/projects/:id/git with an invalid action → 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/whatever/git", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "merge" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/git for an unknown project → 404", async () => {
    // Pin discovery to an empty dir so no project resolves (mirror the /open 404 test in this file,
    // which uses process.env.SURTEC_PROJECTS_ROOT + delete in finally — NOT vi.stubEnv).
    const empty = mkdtempSync(join(tmpdir(), "surtec-git-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await apiRequest(app, "/api/projects/__nope__/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fetch" }),
      });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("POST /api/projects/:id/git with an invalid JSON body → 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/whatever/git", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("branch routes", () => {
  it("POST /api/projects/:id/branch with an invalid op → 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "delete", name: "main" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with an invalid name → 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "switch", name: "-x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with invalid JSON → 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch for an unknown project (valid op+name) → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-branch-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await apiRequest(app, "/api/projects/__nope__/branch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "switch", name: "main" }),
      });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("GET /api/projects/:id/branches for an unknown project → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-branch-empty2-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/branches");
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("github route", () => {
  it("GET /api/projects/:id/github for an unknown project → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-gh-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/github");
      expect(res.status).toBe(404);
      // Assert it's OUR handler's JSON 404 (not Hono's default plain-text 404 for an unregistered route),
      // which confirms the route is actually wired.
      expect((await res.json()) as { error?: string }).toMatchObject({ error: expect.stringMatching(/unknown project/) });
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("deps route", () => {
  it("GET /api/projects/:id/deps for an unknown project → 404 (our JSON handler)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-deps-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/deps");
      expect(res.status).toBe(404);
      expect((await res.json()) as { error?: string }).toMatchObject({ error: expect.stringMatching(/unknown project/) });
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("notes routes", () => {
  let notesStateDir: string;
  beforeEach(() => { notesStateDir = mkdtempSync(join(tmpdir(), "surtec-notes-state-")); process.env.SURTEC_STATE_DIR = notesStateDir; });
  afterEach(() => { delete process.env.SURTEC_STATE_DIR; rmSync(notesStateDir, { recursive: true, force: true }); });

  it("POST then GET round-trips a note; toggle then delete mutate it", async () => {
    const app = createApp(process.cwd());
    const add = await apiRequest(app, "/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "do the thing" }),
    });
    expect(add.status).toBe(200);
    const notes = ((await add.json()) as { notes: { id: string; done: boolean }[] }).notes;
    expect(notes).toHaveLength(1);
    const nid = notes[0].id;

    const list = await app.request("/api/projects/alpha/notes");
    expect(((await list.json()) as { notes: unknown[] }).notes).toHaveLength(1);

    const tog = await apiRequest(app, `/api/projects/alpha/notes/${nid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle" }),
    });
    expect((((await tog.json()) as { notes: { done: boolean }[] }).notes)[0].done).toBe(true);

    const del = await apiRequest(app, `/api/projects/alpha/notes/${nid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete" }),
    });
    expect(((await del.json()) as { notes: unknown[] }).notes).toHaveLength(0);
  });

  it("rejects an unsafe project id (contains '..') with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/a..b/notes");
    expect(res.status).toBe(400);
  });

  it("rejects empty text with 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects text over 500 chars with 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "a".repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid action with 400", async () => {
    const app = createApp(process.cwd());
    const res = await apiRequest(app, "/api/projects/alpha/notes/n1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "nuke" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("portfolio profile routes", () => {
  const validProfile = {
    schema_version: 2,
    project_id: "stock-control",
    kind: "client-product",
    lifecycle: "active",
    priority: 2,
    criticality: "high",
    current_goal: "Prepare the next release.",
    next_action: "Review the rollout checklist.",
    deadline: "2026-12-15",
    client_id: "client-demo",
    last_reviewed_at: "2026-09-27",
    tags: ["release", "example"],
  };

  it("lists an empty local store and saves/reads a profile without changing technical config", async () => {
    const app = createApp(root);
    const initial = await app.request("/api/portfolio/profiles");
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toBe("no-store");
    expect(await initial.json()).toEqual({ profiles: [], migration: null });

    const saved = await apiRequest(app, "/api/projects/stock-control/profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validProfile),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ profile: validProfile });

    const listed = await app.request("/api/portfolio/profiles");
    expect(await listed.json()).toEqual({ profiles: [validProfile], migration: null });
    expect(readFileSync(join(root, "registry", "projects.yml"), "utf8")).toContain("sandbox:");
    expect(existsSync(join(stateDir, "portfolio", "projects.json"))).toBe(true);
  });

  it("requires the local session token and validates IDs, fields, and calendar dates", async () => {
    const app = createApp(root);
    const path = "/api/projects/stock-control/profile";
    expect((await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validProfile) })).status).toBe(403);

    const mismatch = await apiRequest(app, "/api/projects/other-project/profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validProfile),
    });
    expect(mismatch.status).toBe(400);

    const invalidDate = await apiRequest(app, path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...validProfile, deadline: "2026-02-29" }),
    });
    expect(invalidDate.status).toBe(400);
    const unsafeId = await apiRequest(app, "/api/projects/a..b/profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...validProfile, project_id: "a..b" }),
    });
    expect(unsafeId.status).toBe(400);
    const empty = await app.request("/api/portfolio/profiles");
    expect(await empty.json()).toEqual({ profiles: [], migration: null });
  });

  it("fails closed on an unsupported local schema version and preserves the file", async () => {
    const storePath = join(stateDir, "portfolio", "projects.json");
    mkdirSync(join(stateDir, "portfolio"), { recursive: true });
    const futureDocument = JSON.stringify({ schema_version: 3, projects: {} });
    writeFileSync(storePath, futureDocument, "utf8");
    const app = createApp(root);
    expect((await app.request("/api/portfolio/profiles")).status).toBe(409);
    const attemptedWrite = await apiRequest(app, "/api/projects/stock-control/profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validProfile),
    });
    expect(attemptedWrite.status).toBe(409);
    expect(readFileSync(storePath, "utf8")).toBe(futureDocument);
  });
});

describe("run routes", () => {
  it("GET /api/runs returns the manager list", async () => {
    const rec: RunRecord = { runId: "r1", projectId: "p", kind: "dev", command: "d",
      status: "running", pid: 1, startedAt: "t", endedAt: null, exitCode: null };
    const app = createApp(process.cwd(), () => {}, fakeManager({ list: vi.fn().mockReturnValue([rec]) }));
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [rec] });
  });

  it("POST /run with an unconfigured command → 400", async () => {
    const app = createApp(root, () => {}, fakeManager());
    const res = await apiRequest(app, "/api/projects/stock-control/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /run for an unknown project → 404", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await apiRequest(app, "/api/projects/__nope__/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "dev" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /run that hits a busy slot → 409", async () => {
    const { SlotBusyError } = await import("../../../runner/process-manager");
    const start = vi.fn().mockImplementation(() => { throw new SlotBusyError("dev"); });
    const app = createApp(root, () => {}, fakeManager({ start }));
    const res = await apiRequest(app, "/api/projects/stock-control/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "build" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/runs/:id/stop → { ok: true }", async () => {
    const stop = vi.fn();
    const app = createApp(process.cwd(), () => {}, fakeManager({ stop }));
    const res = await apiRequest(app, "/api/runs/r1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith("r1");
  });

  it("GET /api/projects/:id/commands returns the registry map + running slots", async () => {
    const app = createApp(root, () => {}, fakeManager());
    const res = await app.request("/api/projects/stock-control/commands");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Record<string, string>; running: object };
    expect(body.commands.build).toBe("pnpm build");
    expect(body.running).toEqual({ dev: null, oneshot: null });
  });

  it("GET /api/runs/:id → 404 when unknown", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager({ get: vi.fn().mockReturnValue(null) }));
    const res = await app.request("/api/runs/nope");
    expect(res.status).toBe(404);
  });

  it("SSE stream resolves via the race-guard when the run ends between get and subscribe", async () => {
    const running: RunRecord = { runId: "r1", projectId: "p", kind: "dev", command: "d",
      status: "running", pid: 1, startedAt: "t", endedAt: null, exitCode: null };
    const ended: RunRecord = { ...running, status: "exited", endedAt: "t2", exitCode: 0 };
    let calls = 0;
    const get = vi.fn().mockImplementation(() => {
      calls += 1;
      // 1st call: snapshot (running). 2nd call: the in-guard re-check (already ended).
      return { record: calls === 1 ? running : ended, log: "" };
    });
    const subscribe = vi.fn().mockReturnValue(() => {}); // never fires the callback
    const app = createApp(process.cwd(), () => {}, fakeManager({ get, subscribe }));
    const res = await app.request("/api/runs/r1/stream");
    expect(res.status).toBe(200);
    const text = await res.text(); // reading to completion proves the stream closed (no hang)
    expect(text).toContain("event: snapshot");
    expect(text).toContain("event: status");
  });
});

describe("GET /api/inbox", () => {
  it("returns the aggregated inbox shape and never 500s with no GitHub repos", async () => {
    const app = createApp(root);
    const res = await app.request("/api/inbox");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.repos)).toBe(true);
  });
});

describe("GET /api/activity", () => {
  it("returns the activity feed shape and never 500s", async () => {
    const app = createApp(root);
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("GET /api/projects/:id/deploy", () => {
  it("returns { configured:false } when the project has no deploy_url", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/stock-control/deploy");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });
  it("404s for an unknown project", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/nope/deploy");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/railway", () => {
  it("returns { configured:false } when the project has no railway block", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/stock-control/railway");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });
  it("404s for an unknown project", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/nope/railway");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/integrations", () => {
  it("returns a versioned snapshot without requiring optional external integrations", async () => {
    const app = createApp(root);
    const res = await app.request("/api/projects/stock-control/integrations");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      schema_version: 2,
      project_id: "stock-control",
      trace_id: null,
      source_control: { provider: "git", configured: true },
      ci: { provider: "github-actions", configured: false, health: "unconfigured" },
      dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null },
      deployments: [
        { provider: "http-health", configured: false, health: "unconfigured" },
        { provider: "railway", configured: false, health: "unconfigured" },
      ],
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("invalidates the aggregate and shared dependency cache on explicit refresh", async () => {
    const snapshot = {
      schema_version: 2 as const,
      project_id: "stock-control",
      observed_at: "2026-09-27T12:00:00.000Z",
      trace_id: null,
      source_control: { provider: "git" as const, configured: false, health: "unconfigured" as const, branch: null, dirty: null, uncommitted: null, ahead: null, behind: null,
        remote: { provider: "github" as const, configured: false, health: "unconfigured" as const, pull_requests: null, issues: null } },
      ci: { provider: "github-actions" as const, configured: false, health: "unconfigured" as const, status: null, branch: null },
      dependencies: { provider: "npm" as const, configured: false, health: "unconfigured" as const, outdated: null, observed_at: "2026-09-27T12:00:00.000Z" },
      deployments: [],
    };
    const integrations = { read: vi.fn().mockResolvedValue(snapshot), invalidate: vi.fn() };
    const app = createApp(root, () => {}, undefined, undefined, { integrations });

    const response = await app.request("/api/projects/stock-control/integrations?refresh=true");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(integrations.invalidate).toHaveBeenCalledWith("stock-control");
    expect(integrations.read).toHaveBeenCalledWith("stock-control", { includeDependencies: true });
  });

  it("maps unknown and invalid project identifiers through canonical policy", async () => {
    const app = createApp(root);
    expect((await app.request("/api/projects/nope/integrations")).status).toBe(404);
    expect((await app.request("/api/projects/bad!/integrations")).status).toBe(400);
  });

  it("protects local client records and only adds explicitly selected context to Codex tasks", async () => {
    const app = createApp(root, () => {});
    const input = {
      display_name: "Fictional API client",
      status: "active",
      criticality: "high",
      sla_note: "Fictional response target.",
      next_review_date: "2026-10-15",
      confidential_notes: "Fictional confidential note, selected only in this test.",
    };
    expect((await app.request("/api/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).status).toBe(403);
    const createdClientResponse = await apiRequest(app, "/api/clients", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    expect(createdClientResponse.status).toBe(201);
    const { client } = await createdClientResponse.json() as { client: { id: string } };

    const summaryResponse = await app.request("/api/clients");
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await summaryResponse.json())).not.toContain(input.confidential_notes);
    const detailResponse = await app.request("/api/clients/" + client.id);
    expect((await detailResponse.json()).client.confidential_notes).toBe(input.confidential_notes);

    const projectProfile = {
      schema_version: 2, project_id: "stock-control", kind: "client-product", lifecycle: "active", priority: 1, criticality: "high",
      current_goal: "Deliver the fictional inventory workflow.", next_action: "Check the release criteria.", deadline: null,
      client_id: client.id, last_reviewed_at: null, tags: [],
    };
    const profileResponse = await apiRequest(app, "/api/projects/stock-control/profile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(projectProfile),
    });
    expect(profileResponse.status).toBe(200);

    const commitmentInput = {
      project_id: "stock-control", client_id: client.id, title: "Fictional inventory milestone",
      expected_outcome: "The fictional workflow is ready.", due_date: "2026-09-30", priority: 1, criticality: "high", state: "in-progress",
      issue_numbers: [12], pull_request_numbers: [34], task_ids: ["STK-1"], session_ids: [], next_action: "Verify the workflow.",
    };
    const createdCommitment = await apiRequest(app, "/api/commitments", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commitmentInput),
    });
    expect(createdCommitment.status).toBe(201);
    const contextOptions = await app.request("/api/projects/stock-control/client-context-options");
    expect(await contextOptions.json()).toMatchObject({
      available: true,
      categories: ["client-identity", "project-outcome", "active-commitments", "service-context", "confidential-notes"],
    });

    const plainTaskResponse = await apiRequest(app, "/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await previewTask(app, { project: "stock-control", agent: "backend-engineer", instructions: "Inspect the project." })),
    });
    const plainTaskId = (await plainTaskResponse.json() as { id: string }).id;
    const plainTask = readTask(plainTaskId)!;
    expect(plainTask.envelope.instructions).toBe("Inspect the project.");
    expect(plainTask.envelope.metadata.client_context_share).toBeUndefined();
    expect(JSON.stringify(plainTask)).not.toContain(input.display_name);
    expect(JSON.stringify(plainTask)).not.toContain(input.confidential_notes);

    const sharedTaskResponse = await apiRequest(app, "/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await previewTask(app, {
        project: "stock-control", agent: "backend-engineer", instructions: "Inspect the project.",
        client_context_categories: ["confidential-notes"],
      })),
    });
    expect(sharedTaskResponse.status).toBe(201);
    const sharedTaskId = (await sharedTaskResponse.json() as { id: string }).id;
    const sharedTask = readTask(sharedTaskId)!;
    expect(sharedTask.envelope.instructions).toContain(input.confidential_notes);
    expect(sharedTask.envelope.title).toBe("Inspect the project.");
    expect(sharedTask.envelope.metadata.client_context_share).toMatchObject({
      client_id: client.id,
      categories: ["confidential-notes"],
    });
  });

  it("creates local issues, requires explicit authorization, and dispatches through linked task lineage", async () => {
    const enqueued: string[] = [];
    const issueService = createIssueService(root, {
      projectIds: () => ["stock-control"],
      createTask: (_input, _repoRoot, trusted) => ({ id: trusted!.taskId }),
    });
    const app = createApp(root, (id) => enqueued.push(id), undefined, undefined, { issues: issueService });
    const issueInput = {
      project_id: "stock-control", title: "Deliver the local issue flow", expected_outcome: "A task is tied to approved scope.",
      acceptance_criteria: ["The scope is recorded.", "Execution is linked."],
      assigned_role_id: "backend-engineer", next_action: "Implement the authorized flow.",
      authorized_scope: {
        expected_outcome: "A task is tied to approved scope.", acceptance_criteria: ["The scope is recorded.", "Execution is linked."],
        allowed_path_patterns: ["dashboard/src/**"], excluded_path_patterns: [], allowed_change_categories: ["api", "tests"], explicit_exclusions: [],
      },
    };
    const created = await apiRequest(app, "/api/work-issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(issueInput) });
    expect(created.status).toBe(201);
    const { issue } = await created.json() as { issue: { id: string; status: string; revision: number } };
    expect(issue.status).toBe("proposed");
    expect((await app.request("/api/work-issues")).status).toBe(200);

    const blockedDispatch = await apiRequest(app, `/api/work-issues/${issue.id}/dispatch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: issue.revision, agent: "backend-engineer" }),
    });
    expect(blockedDispatch.status).toBe(409);

    const authorization = await apiRequest(app, `/api/work-issues/${issue.id}/authorize`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: issue.revision, approval_id: "local-phase-test" }),
    });
    expect(authorization.status).toBe(200);
    const authorizedIssue = (await authorization.json() as { issue: { revision: number; status: string } }).issue;
    const dispatched = await apiRequest(app, `/api/work-issues/${issue.id}/dispatch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: authorizedIssue.revision, agent: "backend-engineer" }),
    });
    expect(dispatched.status).toBe(201);
    const body = await dispatched.json() as { issue: { status: string; task_ids: string[] }; task_id: string };
    expect(body.issue.status).toBe("working");
    expect(body.issue.task_ids).toEqual([body.task_id]);
    expect(enqueued).toEqual([body.task_id]);
    expect((await app.request(`/api/work-issues/${issue.id}`)).status).toBe(200);
  });
});
