import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "./index";
import { readTask } from "../../../lib/state/store";
import type { ProcessManager } from "../../../runner/process-manager";
import type { RunRecord } from "../../../lib/state/types";

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

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-api-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    status: active\n    allowed_agents:\n      - backend-engineer\n",
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

  it("GET /api/dispatch-options returns projects with their allowed agents", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/dispatch-options");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([{ project: "stock-control", agents: ["backend-engineer"] }]);
  });

  it("POST /api/tasks creates a queued task and returns 201 {id}", async () => {
    const fired: string[] = [];
    const app = createApp(root, (id: string) => { fired.push(id); });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "stock-control", agent: "backend-engineer", instructions: "Analyze auth." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^T-/);
    expect(fired).toEqual([body.id]);
  });

  it("POST /api/tasks returns 400 for a disallowed agent", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "stock-control", agent: "frontend-engineer", instructions: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/tasks returns 400 for a malformed JSON body", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  function writeFinishedReadOnly(id: string): void {
    const task = {
      envelope: {
        id, source: "dashboard", project: "stock-control", task_type: "analysis",
        agent: "backend-engineer", title: "Look", instructions: "x", repo_path: "~/dev",
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
    const res = await app.request("/api/tasks/RV-1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.status).toBe("approved");
    expect(readTask("RV-1")!.decision?.status).toBe("approved");
  });

  it("POST /api/tasks/:id/reject records a rejected decision", async () => {
    writeFinishedReadOnly("RV-2");
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks/RV-2/reject", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).decision.status).toBe("rejected");
    expect(readTask("RV-2")!.decision?.status).toBe("rejected");
  });

  it("POST /api/tasks/:id/approve returns 404 for a missing task", async () => {
    const app = createApp(root, () => {});
    const res = await app.request("/api/tasks/NOPE/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/approve returns 400 when already decided", async () => {
    writeFinishedReadOnly("RV-3");
    const app = createApp(root, () => {});
    await app.request("/api/tasks/RV-3/approve", { method: "POST" });
    const res = await app.request("/api/tasks/RV-3/approve", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("open: 404 for an unknown project", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-open-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(root);
      const res = await app.request("/api/projects/ghost/open", {
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
      const res = await app.request("/api/projects/whatever/open", {
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
    const res = await app.request("/api/projects/whatever/git", {
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
      const res = await app.request("/api/projects/__nope__/git", {
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
    const res = await app.request("/api/projects/whatever/git", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("branch routes", () => {
  it("POST /api/projects/:id/branch with an invalid op → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "delete", name: "main" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with an invalid name → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "switch", name: "-x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with invalid JSON → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch for an unknown project (valid op+name) → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-branch-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/branch", {
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
    const add = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "do the thing" }),
    });
    expect(add.status).toBe(200);
    const notes = ((await add.json()) as { notes: { id: string; done: boolean }[] }).notes;
    expect(notes).toHaveLength(1);
    const nid = notes[0].id;

    const list = await app.request("/api/projects/alpha/notes");
    expect(((await list.json()) as { notes: unknown[] }).notes).toHaveLength(1);

    const tog = await app.request(`/api/projects/alpha/notes/${nid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle" }),
    });
    expect((((await tog.json()) as { notes: { done: boolean }[] }).notes)[0].done).toBe(true);

    const del = await app.request(`/api/projects/alpha/notes/${nid}`, {
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
    const res = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects text over 500 chars with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/alpha/notes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "a".repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid action with 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/alpha/notes/n1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "nuke" }),
    });
    expect(res.status).toBe(400);
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
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/appointment-manager/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /run for an unknown project → 404", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/__nope__/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "dev" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /run that hits a busy slot → 409", async () => {
    const { SlotBusyError } = await import("../../../runner/process-manager");
    const start = vi.fn().mockImplementation(() => { throw new SlotBusyError("dev"); });
    const app = createApp(process.cwd(), () => {}, fakeManager({ start }));
    const res = await app.request("/api/projects/expense-tracker-mvp/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "build" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/runs/:id/stop → { ok: true }", async () => {
    const stop = vi.fn();
    const app = createApp(process.cwd(), () => {}, fakeManager({ stop }));
    const res = await app.request("/api/runs/r1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith("r1");
  });

  it("GET /api/projects/:id/commands returns the registry map + running slots", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/expense-tracker-mvp/commands");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Record<string, string>; running: object };
    expect(body.commands.build).toBe("npm run build");
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
