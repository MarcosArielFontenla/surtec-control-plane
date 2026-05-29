import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { listTasks, listProjectOverrides, readTask } from "../../../lib/state/store";
import { buildOverview } from "../../../lib/state/derive";
import { loadRegistryProjects } from "./registry";
import { createTask, ValidationError } from "./dispatch";
import { runTask } from "../../../runner/run-task";
import { reconcileRunning } from "../../../runner/reconcile";

export function createApp(
  repoRoot: string = process.cwd(),
  onTaskCreated: (id: string) => void = (id) => { void runTask(id, repoRoot); },
): Hono {
  const app = new Hono();

  app.get("/api/overview", (c) => {
    try {
      const overview = buildOverview(
        loadRegistryProjects(repoRoot),
        listTasks(),
        listProjectOverrides(),
      );
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
    const projects = loadRegistryProjects(repoRoot).map((p) => ({
      project: p.id,
      agents: p.allowed_agents ?? [],
    }));
    return c.json({ projects });
  });

  app.post("/api/tasks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const { id } = createTask(body as { project: string; agent: string; instructions: string }, repoRoot);
      onTaskCreated(id);
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}

// Entrypoint: only runs when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  reconcileRunning();
  const app = createApp();
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));
  const port = Number(process.env.PORT ?? 4317);
  serve({ fetch: app.fetch, port });
  console.log(`Surtec Control Plane dashboard on http://localhost:${port}`);
}
