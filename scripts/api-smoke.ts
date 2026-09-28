import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../dashboard/src/server/index";
import type { ProjectIntegrationsReader, ProjectIntegrationsSnapshot } from "../lib/integrations/types";
import { createSignalService } from "../dashboard/src/server/signal-service";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integrationSnapshot: ProjectIntegrationsSnapshot = {
  schema_version: 1,
  project_id: "smoke-project",
  observed_at: "2026-09-21T00:00:00.000Z",
  trace_id: null,
  source_control: {
    provider: "git", configured: false, health: "unconfigured", branch: null,
    dirty: null, uncommitted: null, ahead: null, behind: null,
    remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null },
  },
  ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
  deployments: [],
};
const integrations: ProjectIntegrationsReader = {
  read: async () => integrationSnapshot,
  invalidate: () => {},
};
const signals = createSignalService({
  reader: { read: async () => ({
    projects: [{ id: "smoke-project", status: "discovered", git: null, profile: null, profile_available: true, integrations: integrationSnapshot, last_activity_at: null, notes: [] }],
    tasks: [], issues: [],
  }) },
  statePath: join(tmpdir(), `surtec-api-smoke-${process.pid}-${randomUUID()}`, "signals", "human-state.json"),
  clock: () => new Date("2026-09-21T12:00:00.000Z"),
});
const app = createApp(root, () => {}, undefined, undefined, { integrations, signals });

const overview = await app.request("/api/overview");
if (!overview.ok) throw new Error(`overview smoke failed with ${overview.status}`);
const overviewBody = await overview.json() as Record<string, unknown>;
for (const field of ["projects", "inProgress", "history", "attention"]) {
  if (!Array.isArray(overviewBody[field])) throw new Error(`overview response is missing ${field}`);
}
const projects = overviewBody.projects as unknown[];

const portfolioProfiles = await app.request("/api/portfolio/profiles");
if (!portfolioProfiles.ok) throw new Error(`portfolio profiles smoke failed with ${portfolioProfiles.status}`);
const portfolioProfilesBody = await portfolioProfiles.json() as { profiles?: unknown };
if (!Array.isArray(portfolioProfilesBody.profiles)) throw new Error("portfolio profiles response is invalid");

const today = await app.request("/api/today");
if (!today.ok) throw new Error(`today smoke failed with ${today.status}`);
const todayBody = await today.json() as Record<string, unknown>;
for (const field of ["active", "attention", "completed", "failed", "cancelled", "retries", "cancellations", "recoveries"]) {
  if (!Array.isArray(todayBody[field])) throw new Error(`today response is missing ${field}`);
}
const todayPortfolio = todayBody.portfolio as Record<string, unknown> | undefined;
if (!todayPortfolio || !Array.isArray(todayPortfolio.recommendations) || todayPortfolio.recommendations.length > 3
  || !Array.isArray(todayPortfolio.critical_attention) || !Array.isArray(todayPortfolio.client_commitments)
  || !Array.isArray(todayPortfolio.personal_opportunities) || !Array.isArray(todayPortfolio.stale_profiles)
  || !Array.isArray(todayPortfolio.warnings)) {
  throw new Error("today portfolio model is invalid");
}

const options = await app.request("/api/dispatch-options");
if (!options.ok) throw new Error(`dispatch-options smoke failed with ${options.status}`);
const optionsBody = await options.json() as { projects?: unknown };
if (!Array.isArray(optionsBody.projects)) throw new Error("dispatch-options response is invalid");

const integrationResponse = await app.request("/api/projects/smoke-project/integrations");
if (!integrationResponse.ok) throw new Error(`integrations smoke failed with ${integrationResponse.status}`);
const integrationBody = await integrationResponse.json() as Record<string, unknown>;
if (integrationBody.schema_version !== 1 || integrationBody.project_id !== "smoke-project") {
  throw new Error("integrations response is invalid");
}

const signalResponse = await app.request("/api/signals");
if (!signalResponse.ok) throw new Error(`signals smoke failed with ${signalResponse.status}`);
const signalBody = await signalResponse.json() as { schema_version?: number; signals?: unknown; warnings?: unknown };
if (signalBody.schema_version !== 1 || !Array.isArray(signalBody.signals) || !Array.isArray(signalBody.warnings)) {
  throw new Error("signals response is invalid");
}

console.log(JSON.stringify({
  overview_status: overview.status,
  today_status: today.status,
  today_date: todayBody.date,
  discovered_projects: projects.length,
  dispatch_options_status: options.status,
  configured_projects: optionsBody.projects.length,
  portfolio_profiles_status: portfolioProfiles.status,
  portfolio_profiles: portfolioProfilesBody.profiles.length,
  integrations_status: integrationResponse.status,
  integration_schema_version: integrationBody.schema_version,
  signals_status: signalResponse.status,
  signal_count: signalBody.signals.length,
}));
