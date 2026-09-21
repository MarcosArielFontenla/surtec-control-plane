// Server bootstrap — always starts the API + static UI when run as a script.
// Kept separate from index.ts so index.ts only EXPORTS createApp (imported cleanly
// by tests) and the server starts reliably under `tsx`, `tsx watch`, and `node`
// without sniffing process.argv[1] (which `tsx watch` rewrites, so the old
// entrypoint guard never fired and the server silently never listened).
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./index";
import { reconcileStartup } from "../../../runner/reconcile";

const reconciliation = reconcileStartup();
if (reconciliation.interrupted > 0) console.log(`Reconciled ${reconciliation.interrupted} interrupted task(s) from a previous run.`);
if (reconciliation.worktrees.orphans.length > 0) {
  console.warn(`Found ${reconciliation.worktrees.orphans.length} orphaned managed worktree(s); see the reconciliation report before cleanup.`);
}
for (const error of reconciliation.worktrees.errors) console.warn(`Worktree reconciliation warning: ${error}`);

const app = createApp();
app.use("/*", serveStatic({ root: "./dashboard/dist" }));
const port = Number(process.env.PORT ?? 4317);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`Surtec Control Plane dashboard on http://127.0.0.1:${port}`);
