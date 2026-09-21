// Server bootstrap — always starts the API + static UI when run as a script.
// Kept separate from index.ts so index.ts only EXPORTS createApp (imported cleanly
// by tests) and the server starts reliably under `tsx`, `tsx watch`, and `node`
// without sniffing process.argv[1] (which `tsx watch` rewrites, so the old
// entrypoint guard never fired and the server silently never listened).
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./index";
import { reconcileStartup } from "../../../runner/reconcile";
import { TaskOrchestrator } from "../../../runner/task-orchestrator";

const reconciliation = reconcileStartup();
if (reconciliation.worktrees.orphans.length > 0) {
  console.warn(`Found ${reconciliation.worktrees.orphans.length} orphaned managed worktree(s); see the reconciliation report before cleanup.`);
}
for (const error of reconciliation.worktrees.errors) console.warn(`Worktree reconciliation warning: ${error}`);

const orchestrator = new TaskOrchestrator();
orchestrator.start();
const app = createApp(process.cwd(), orchestrator);
app.use("/*", serveStatic({ root: "./dashboard/dist" }));
const port = Number(process.env.PORT ?? 4317);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`Surtec Control Plane dashboard on http://127.0.0.1:${port}`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await orchestrator.stop();
  server.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
