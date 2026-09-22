import type { PolicyProject } from "../../../lib/policy/service";
import type { DeploymentObservation, DeploymentProvider, IntegrationHealth } from "../../../lib/integrations/types";
import { integrationError, safeHttpUrl } from "../../../lib/integrations/safety";
import { readDeployHealth, type DeployPing } from "./deploy-read";
import { readRailwayDeploy, type RailwayIds, type RailwayPing } from "./railway-read";

type ReadHttpHealth = (url: string) => Promise<DeployPing>;
type ReadRailway = (ids: RailwayIds, token: string) => Promise<RailwayPing>;

function emptyObservation(
  provider: DeploymentObservation["provider"],
  observedAt: string,
): DeploymentObservation {
  return {
    provider,
    configured: false,
    health: "unconfigured",
    status: null,
    observed_at: observedAt,
    url: null,
    http_status: null,
    latency_ms: null,
    deployed_at: null,
  };
}

function railwayHealth(result: RailwayPing): IntegrationHealth {
  if (!result.ok) return "unknown";
  switch (result.state) {
    case "success": return "ok";
    case "building":
    case "deploying":
    case "waiting":
    case "queued": return "degraded";
    case "failed":
    case "crashed": return "down";
    case "removed":
    case "sleeping":
    case "skipped": return "degraded";
    default: return "unknown";
  }
}

export function createHttpHealthDeploymentProvider(
  dependencies: { readHealth?: ReadHttpHealth } = {},
): DeploymentProvider {
  const readHealth = dependencies.readHealth ?? readDeployHealth;
  return {
    id: "http-health",
    async observe(project: PolicyProject, observedAt: string): Promise<DeploymentObservation> {
      if (!project.deploy_url) return emptyObservation("http-health", observedAt);
      const url = safeHttpUrl(project.deploy_url);
      if (!url) {
        return {
          ...emptyObservation("http-health", observedAt),
          configured: true,
          health: "unknown",
          error: "deployment URL must be http(s) and must not contain credentials",
        };
      }
      try {
        const result = await readHealth(url);
        return {
          provider: "http-health",
          configured: true,
          health: result.state === "up" ? "ok" : result.state,
          status: result.state,
          observed_at: observedAt,
          url,
          http_status: result.status,
          latency_ms: result.ms,
          deployed_at: null,
          ...(result.error ? { error: integrationError(result.error) } : {}),
        };
      } catch (error) {
        return {
          ...emptyObservation("http-health", observedAt),
          configured: true,
          health: "unknown",
          url,
          error: integrationError(error),
        };
      }
    },
  };
}

export function createRailwayDeploymentProvider(
  dependencies: { token?: string; readRailway?: ReadRailway } = {},
): DeploymentProvider {
  const readRailway = dependencies.readRailway ?? readRailwayDeploy;
  const token = dependencies.token;
  return {
    id: "railway",
    async observe(project: PolicyProject, observedAt: string): Promise<DeploymentObservation> {
      if (!project.railway) return emptyObservation("railway", observedAt);
      if (!token) {
        return {
          ...emptyObservation("railway", observedAt),
          configured: true,
          health: "unknown",
          error: "Railway credential is not configured",
        };
      }
      try {
        const result = await readRailway(project.railway, token);
        const url = safeHttpUrl(result.url);
        return {
          provider: "railway",
          configured: true,
          health: railwayHealth(result),
          status: result.state,
          observed_at: observedAt,
          url,
          http_status: null,
          latency_ms: null,
          deployed_at: result.at,
          ...(result.error ? { error: integrationError(result.error) } : {}),
          ...(result.url && !url ? { error: "provider returned an unsafe URL" } : {}),
        };
      } catch (error) {
        return {
          ...emptyObservation("railway", observedAt),
          configured: true,
          health: "unknown",
          error: integrationError(error),
        };
      }
    },
  };
}
