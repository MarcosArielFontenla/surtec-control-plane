import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
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
import { runTask } from "../../../runner/run-task";
import { reconcileRunning } from "../../../runner/reconcile";

export function createApp(
  repoRoot: string = process.cwd(),
  onTaskCreated: (id: string) => void = (id) => {
    runTask(id, repoRoot).catch((err: unknown) => {
      console.error(`runTask failed unexpectedly for ${id}:`, err);
    });
  },
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

  return app;
}

// Entrypoint: only runs when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  const interrupted = reconcileRunning();
  if (interrupted > 0) console.log(`Reconciled ${interrupted} interrupted task(s) from a previous run.`);
  const app = createApp();
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));
  const port = Number(process.env.PORT ?? 4317);
  serve({ fetch: app.fetch, port });
  console.log(`Surtec Control Plane dashboard on http://localhost:${port}`);
}
