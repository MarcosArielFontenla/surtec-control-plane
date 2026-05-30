// Server bootstrap — always starts the API + static UI when run as a script.
// Kept separate from index.ts so index.ts only EXPORTS createApp (imported cleanly
// by tests) and the server starts reliably under `tsx`, `tsx watch`, and `node`
// without sniffing process.argv[1] (which `tsx watch` rewrites, so the old
// entrypoint guard never fired and the server silently never listened).
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./index";
import { reconcileRunning } from "../../../runner/reconcile";

const interrupted = reconcileRunning();
if (interrupted > 0) console.log(`Reconciled ${interrupted} interrupted task(s) from a previous run.`);

const app = createApp();
app.use("/*", serveStatic({ root: "./dashboard/dist" }));
const port = Number(process.env.PORT ?? 4317);
serve({ fetch: app.fetch, port });
console.log(`Surtec Control Plane dashboard on http://localhost:${port}`);
