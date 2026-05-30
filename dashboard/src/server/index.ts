import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { dirname } from "node:path";
import { listTasks, listProjectOverrides, readTask } from "../../../lib/state/store";
import { buildOverview } from "../../../lib/state/derive";
import { loadRegistryProjects } from "./registry";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { createGitStatusCache } from "../../../lib/git-status-cache";
import { assemblePortfolio } from "../../../lib/portfolio";
import { loadProjectConfig } from "./portfolio-config";
import { createTask, ValidationError } from "./dispatch";
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
import { openProject, OpenError } from "./open-project";
import { runGitSync, GitSyncError } from "./git-sync";
import { validateBranchName, listBranches, switchBranch, createBranch, BranchError } from "./git-branch";
import { runTask } from "../../../runner/run-task";
import { loadProjectCommands } from "../../../runner/project-commands";
import { processManager, SlotBusyError, type ProcessManager } from "../../../runner/process-manager";

export function createApp(
  repoRoot: string = process.cwd(),
  onTaskCreated: (id: string) => void = (id) => {
    runTask(id, repoRoot).catch((err: unknown) => {
      console.error(`runTask failed unexpectedly for ${id}:`, err);
    });
  },
  pm: ProcessManager = processManager,
): Hono {
  const app = new Hono();

  const gitStatusCache = createGitStatusCache();

  app.get("/api/overview", (c) => {
    try {
      const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
      const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
      const discovered = discoverProjects(root, ignore);
      const statusByPath = new Map(discovered.map((d) => [d.path, gitStatusCache.get(d.path)]));
      const config = loadProjectConfig(repoRoot);
      const portfolio = assemblePortfolio(discovered, statusByPath, config);
      const overview = buildOverview(portfolio, listTasks(), listProjectOverrides());
      return c.json(overview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const rec = readTask(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  app.get("/api/dispatch-options", (c) => {
    try {
      const projects = loadRegistryProjects(repoRoot).map((p) => ({
        project: p.id,
        agents: p.allowed_agents ?? [],
      }));
      return c.json({ projects });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const { id } = createTask(
        body as { project: string; agent: string; instructions: string; sandbox?: string; self_verify?: boolean },
        repoRoot,
      );
      onTaskCreated(id);
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/approve", (c) => {
    try {
      return c.json({ decision: approveTask(c.req.param("id"), repoRoot) });
    } catch (err) {
      // TaskNotFoundError extends ReviewError — check the subclass first (404 vs 400).
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/reject", (c) => {
    try {
      return c.json({ decision: rejectTask(c.req.param("id")) });
    } catch (err) {
      // TaskNotFoundError extends ReviewError — check the subclass first (404 vs 400).
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/open", async (c) => {
    let body: { target?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      return c.json(openProject(repoRoot, c.req.param("id"), String(body?.target ?? "")));
    } catch (err) {
      if (err instanceof OpenError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/git", async (c) => {
    let body: { action?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const id = c.req.param("id");
    try {
      const result = runGitSync(repoRoot, id, String(body?.action ?? ""));
      if (result.ok) {
        // Bust the cached status for this repo so ahead/behind refreshes on the next overview poll.
        const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
        const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
        const proj = discoverProjects(root, ignore).find((p) => p.id === id);
        if (proj) gitStatusCache.invalidate(proj.path);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof GitSyncError) return c.json({ error: err.message }, err.status as 400 | 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/branches", (c) => {
    try {
      return c.json(listBranches(repoRoot, c.req.param("id")));
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/branch", async (c) => {
    let body: { op?: string; name?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const id = c.req.param("id");
    const op = String(body?.op ?? "");
    const name = String(body?.name ?? "");
    if (op !== "switch" && op !== "create") return c.json({ error: `invalid op: ${op}` }, 400);
    if (!validateBranchName(name)) return c.json({ error: `invalid branch name: ${name}` }, 400);
    try {
      const result = op === "switch"
        ? switchBranch(repoRoot, id, name)
        : createBranch(repoRoot, id, name);
      if (result.ok) {
        const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
        const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
        const proj = discoverProjects(root, ignore).find((p) => p.id === id);
        if (proj) gitStatusCache.invalidate(proj.path);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 400 | 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Procesos (B.2): run project commands from the dashboard ---
  app.get("/api/runs", (c) => c.json({ runs: pm.list() }));

  app.get("/api/projects/:id/commands", (c) => {
    const id = c.req.param("id");
    const commands = loadProjectCommands(repoRoot, id);
    const running = pm.list().filter((r) => r.projectId === id && r.status === "running");
    return c.json({
      commands,
      running: {
        dev: running.find((r) => r.kind === "dev")?.runId ?? null,
        oneshot: running.find((r) => r.kind === "oneshot")?.runId ?? null,
      },
    });
  });

  app.post("/api/projects/:id/run", async (c) => {
    const id = c.req.param("id");
    let body: { command?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const key = String(body?.command ?? "");

    const project = loadRegistryProjects(repoRoot).find((p) => p.id === id);
    const cwd = project?.repo_path ?? null;
    if (!cwd) return c.json({ error: `unknown project: ${id}` }, 404);

    const command = (loadProjectCommands(repoRoot, id) as Record<string, string | undefined>)[key];
    if (!key || !command) return c.json({ error: `command not configured: ${key}` }, 400);

    const kind = key === "dev" ? "dev" : "oneshot";
    try {
      const rec = pm.start({ projectId: id, kind, command, cwd });
      return c.json({ runId: rec.runId }, 201);
    } catch (err) {
      if (err instanceof SlotBusyError) return c.json({ error: err.message }, 409);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/runs/:runId/stop", (c) => {
    pm.stop(c.req.param("runId"));
    return c.json({ ok: true });
  });

  app.get("/api/runs/:runId", (c) => {
    const r = pm.get(c.req.param("runId"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/runs/:runId/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("runId");
      const snap = pm.get(runId);
      if (!snap) { await stream.writeSSE({ event: "error", data: "not found" }); return; }
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ type: "snapshot", ...snap }) });
      if (snap.record.status !== "running") return; // already terminal: snapshot is enough
      await new Promise<void>((resolve) => {
        const unsub = pm.subscribe(runId, (e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
            .then(() => { if (e.type === "status") { unsub(); resolve(); } })
            .catch(() => { unsub(); resolve(); });
        });
        stream.onAbort(() => { unsub(); resolve(); });
        // Guard against a race: the run may have terminated between the get() above
        // and subscribe() here, in which case the terminal event already fired and we
        // would otherwise hang. Re-check and emit the final status ourselves.
        const after = pm.get(runId);
        if (after && after.record.status !== "running") {
          stream.writeSSE({ event: "status", data: JSON.stringify({ type: "status", record: after.record }) })
            .finally(() => { unsub(); resolve(); });
        }
      });
    }),
  );

  return app;
}

// Server bootstrap lives in ./serve.ts (so this module only exports createApp and
// imports cleanly in tests). `pnpm dev:api` / `pnpm start` run ./serve.ts.
