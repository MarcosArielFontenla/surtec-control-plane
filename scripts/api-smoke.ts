import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../dashboard/src/server/index";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = createApp(root, () => {});

const overview = await app.request("/api/overview");
if (!overview.ok) throw new Error(`overview smoke failed with ${overview.status}`);
const overviewBody = await overview.json() as Record<string, unknown>;
for (const field of ["projects", "inProgress", "history", "attention"]) {
  if (!Array.isArray(overviewBody[field])) throw new Error(`overview response is missing ${field}`);
}
const projects = overviewBody.projects as unknown[];

const options = await app.request("/api/dispatch-options");
if (!options.ok) throw new Error(`dispatch-options smoke failed with ${options.status}`);
const optionsBody = await options.json() as { projects?: unknown };
if (!Array.isArray(optionsBody.projects)) throw new Error("dispatch-options response is invalid");

console.log(JSON.stringify({
  overview_status: overview.status,
  discovered_projects: projects.length,
  dispatch_options_status: options.status,
  configured_projects: optionsBody.projects.length,
}));
