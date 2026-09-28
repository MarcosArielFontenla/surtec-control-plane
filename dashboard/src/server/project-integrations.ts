import type { GitStatus } from "../../../lib/state/types";
import { readGitStatus } from "../../../lib/git-status";
import { githubRepoSlug } from "../../../lib/github-url";
import { PolicyService, type PolicyProject } from "../../../lib/policy/service";
import { integrationError, safeHttpUrl } from "../../../lib/integrations/safety";
import { assertProjectIntegrationsSnapshot } from "../../../lib/integrations/validation";
import type {
  CiObservation,
  DependencyObservation,
  DeploymentObservation,
  DeploymentProvider,
  IntegrationHealth,
  ProjectIntegrationsReader,
  ProjectIntegrationsSnapshot,
  SourceControlObservation,
} from "../../../lib/integrations/types";
import { noOpTracer, type Tracer } from "../../../lib/observability/tracing";
import { readCiStatus, readGithubCounts, type CiState, type GithubCounts, type GithubPullRequestAction } from "./github-read";
import { createHttpHealthDeploymentProvider, createRailwayDeploymentProvider } from "./deployment-providers";
import { readDepsStatus, type DepsObservation } from "./deps-read";

interface ProjectPolicyReader {
  project(projectId: string): PolicyProject;
}

export interface ProjectIntegrationsDependencies {
  policy?: ProjectPolicyReader;
  readLocalGit?: (repoPath: string) => GitStatus;
  readGithub?: (slug: string) => GithubCounts;
  readCi?: (slug: string, branch: string) => { state: CiState; startedAt?: string | null; runId?: string | null; updatedAt?: string | null };
  readDependencies?: (repoPath: string) => DepsObservation;
  deploymentProviders?: DeploymentProvider[];
  tracer?: Tracer;
  clock?: () => Date;
  cacheNow?: () => number;
  ttlMs?: number;
  environment?: NodeJS.ProcessEnv;
}

const DEPLOYMENT_HEALTH = new Set<IntegrationHealth>(["ok", "degraded", "down", "unknown", "unconfigured"]);
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function ciHealth(state: CiState): IntegrationHealth {
  switch (state) {
    case "passing": return "ok";
    case "failing": return "down";
    case "running": return "degraded";
    default: return "unknown";
  }
}

function sourceControl(
  project: PolicyProject,
  readLocalGit: (repoPath: string) => GitStatus,
  readGithub: (slug: string) => GithubCounts,
): { observation: SourceControlObservation; slug: string | null } {
  let local: SourceControlObservation;
  if (!project.repo_path) {
    local = {
      provider: "git",
      configured: false,
      health: "unconfigured",
      branch: null,
      dirty: null,
      uncommitted: null,
      ahead: null,
      behind: null,
      remote: {
        provider: "github",
        configured: false,
        health: "unconfigured",
        pull_requests: null,
        issues: null,
      },
    };
  } else {
    try {
      const status = readLocalGit(project.repo_path);
      local = {
        provider: "git",
        configured: true,
        health: status.ok ? "ok" : "unknown",
        branch: status.branch,
        dirty: status.dirty,
        uncommitted: status.uncommitted,
        ahead: status.ahead,
        behind: status.behind,
        remote: {
          provider: "github",
          configured: false,
          health: "unconfigured",
          pull_requests: null,
          issues: null,
        },
        ...(!status.ok ? { error: "local Git status is unavailable" } : {}),
      };
    } catch (error) {
      local = {
        provider: "git",
        configured: true,
        health: "unknown",
        branch: null,
        dirty: null,
        uncommitted: null,
        ahead: null,
        behind: null,
        remote: {
          provider: "github",
          configured: false,
          health: "unconfigured",
          pull_requests: null,
          issues: null,
        },
        error: integrationError(error),
      };
    }
  }

  const slug = githubRepoSlug(project.repo);
  if (!slug) return { observation: local, slug: null };
  try {
    const counts = readGithub(slug);
    local.remote = {
      provider: "github",
      configured: true,
      health: counts.ok ? "ok" : "unknown",
      pull_requests: counts.ok ? counts.prs : null,
      issues: counts.ok ? counts.issues : null,
          waiting_pull_requests: counts.ok ? (counts.waitingPullRequests ?? []).map((item: GithubPullRequestAction) => ({
            number: item.number,
            updated_at: item.updatedAt,
            review_decision: item.reviewDecision,
          })) : [],
      ...(counts.error ? { error: integrationError(counts.error) } : {}),
    };
  } catch (error) {
    local.remote = {
      provider: "github",
      configured: true,
      health: "unknown",
      pull_requests: null,
      issues: null,
      error: integrationError(error),
    };
  }
  return { observation: local, slug };
}

function continuousIntegration(
  project: PolicyProject,
  slug: string | null,
  readCi: (slug: string, branch: string) => { state: CiState; startedAt?: string | null; runId?: string | null; updatedAt?: string | null },
): CiObservation {
  if (!slug) {
    return {
      provider: "github-actions",
      configured: false,
      health: "unconfigured",
      status: null,
      branch: null,
    };
  }
  const branch = project.default_branch ?? "main";
  try {
    const { state, startedAt, runId, updatedAt } = readCi(slug, branch);
    return {
      provider: "github-actions",
      configured: true,
      health: ciHealth(state),
      status: state,
      branch,
      ...(state === "running" ? { run_started_at: startedAt ?? null } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(updatedAt ? { run_updated_at: updatedAt } : {}),
      ...(state === "unknown" ? { error: "CI status is unavailable" } : {}),
    };
  } catch (error) {
    return {
      provider: "github-actions",
      configured: true,
      health: "unknown",
      status: "unknown",
      branch,
      error: integrationError(error),
    };
  }
}

function dependencyHealth(
  project: PolicyProject,
  readDependencies: (repoPath: string) => DepsObservation,
  observedAt: string,
): DependencyObservation {
  if (!project.repo_path) {
    return { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observedAt };
  }
  try {
    const result = readDependencies(project.repo_path);
    const configured = result.error !== "sin package.json";
    return {
      provider: "npm",
      configured,
      health: !configured ? "unconfigured" : result.ok ? (result.outdated > 0 ? "degraded" : "ok") : "unknown",
      outdated: configured ? result.outdated : null,
      observed_at: result.observed_at,
      ...(result.error ? { error: integrationError(result.error) } : {}),
    };
  } catch (error) {
    return {
      provider: "npm",
      configured: true,
      health: "unknown",
      outdated: null,
      observed_at: observedAt,
      error: integrationError(error),
    };
  }
}

function deferredDependencyHealth(project: PolicyProject, observedAt: string): DependencyObservation {
  return project.repo_path
    ? { provider: "npm", configured: true, health: "unknown", outdated: null, observed_at: observedAt, error: "Detailed dependency check was not requested." }
    : { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observedAt };
}

function providerConfigured(provider: DeploymentProvider, project: PolicyProject): boolean {
  return provider.id === "http-health" ? Boolean(project.deploy_url) : Boolean(project.railway);
}

function failedDeployment(
  provider: DeploymentProvider,
  project: PolicyProject,
  observedAt: string,
  error: unknown,
): DeploymentObservation {
  const configured = providerConfigured(provider, project);
  return {
    provider: provider.id,
    configured,
    health: configured ? "unknown" : "unconfigured",
    status: null,
    observed_at: observedAt,
    url: null,
    http_status: null,
    latency_ms: null,
    deployed_at: null,
    error: integrationError(error),
  };
}

function normalizeDeployment(
  provider: DeploymentProvider,
  value: DeploymentObservation,
  observedAt: string,
): DeploymentObservation {
  if (value.provider !== provider.id) throw new Error(`deployment provider identity mismatch: ${provider.id}`);
  const health = DEPLOYMENT_HEALTH.has(value.health) ? value.health : "unknown";
  const url = safeHttpUrl(value.url);
  const unsafeUrl = Boolean(value.url && !url);
  return {
    provider: provider.id,
    configured: value.configured === true,
    health,
    status: typeof value.status === "string" ? integrationError(value.status).slice(0, 100) : null,
    observed_at: observedAt,
    url,
    http_status: Number.isInteger(value.http_status) ? value.http_status : null,
    latency_ms: typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms) && value.latency_ms >= 0
      ? value.latency_ms
      : null,
    deployed_at: typeof value.deployed_at === "string" ? value.deployed_at.slice(0, 100) : null,
    ...(value.error ? { error: integrationError(value.error) } : {}),
    ...(unsafeUrl ? { error: "provider returned an unsafe URL" } : {}),
  };
}

function safeTraceId(value: string | undefined): string | null {
  return value && TRACE_ID.test(value) ? value : null;
}

export function createProjectIntegrationsService(
  repoRoot: string,
  dependencies: ProjectIntegrationsDependencies = {},
): ProjectIntegrationsReader {
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const readLocalGit = dependencies.readLocalGit ?? readGitStatus;
  const readGithub = dependencies.readGithub ?? readGithubCounts;
  const readCi = dependencies.readCi ?? readCiStatus;
  const environment = dependencies.environment ?? process.env;
  const providers = dependencies.deploymentProviders ?? [
    createHttpHealthDeploymentProvider(),
    createRailwayDeploymentProvider({ token: environment.RAILWAY_TOKEN }),
  ];
  const tracer = dependencies.tracer ?? noOpTracer;
  const clock = dependencies.clock ?? (() => new Date());
  const readDependencies = dependencies.readDependencies ?? ((repoPath: string) => ({
    ...readDepsStatus(repoPath),
    observed_at: clock().toISOString(),
  }));
  const cacheNow = dependencies.cacheNow ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? 60_000;
  const cache = new Map<string, { value: Promise<ProjectIntegrationsSnapshot>; at: number }>();

  const build = async (projectId: string, includeDependencies: boolean): Promise<ProjectIntegrationsSnapshot> => {
    const span = tracer.startSpan("project-integrations.read", { project_id: projectId });
    try {
      const project = policy.project(projectId);
      const observedAt = clock().toISOString();
      const source = sourceControl(project, readLocalGit, readGithub);
      const ci = continuousIntegration(project, source.slug, readCi);
      const dependency = includeDependencies
        ? dependencyHealth(project, readDependencies, observedAt)
        : deferredDependencyHealth(project, observedAt);
      span.addEvent("source-control.observed", { health: source.observation.health, remote_health: source.observation.remote.health });
      span.addEvent("ci.observed", { health: ci.health, status: ci.status });
      span.addEvent("dependencies.observed", { health: dependency.health, configured: dependency.configured });

      const deployments = await Promise.all(providers.map(async (provider) => {
        const providerSpan = tracer.startSpan("project-integrations.deployment", { project_id: project.id, provider: provider.id });
        try {
          const observation = normalizeDeployment(provider, await provider.observe(project, observedAt), observedAt);
          providerSpan.addEvent("observed", { health: observation.health, configured: observation.configured });
          providerSpan.end("ok");
          return observation;
        } catch (error) {
          const observation = failedDeployment(provider, project, observedAt, error);
          providerSpan.addEvent("failed", { configured: observation.configured });
          providerSpan.end("error");
          return observation;
        }
      }));

      const snapshot: ProjectIntegrationsSnapshot = {
        schema_version: 2,
        project_id: project.id,
        observed_at: observedAt,
        trace_id: safeTraceId(span.context?.traceId),
        source_control: source.observation,
        ci,
        dependencies: dependency,
        deployments,
      };
      assertProjectIntegrationsSnapshot(snapshot);
      span.end("ok");
      return snapshot;
    } catch (error) {
      span.end("error");
      throw error;
    }
  };

  return {
    read(projectId: string, options: { includeDependencies?: boolean } = {}): Promise<ProjectIntegrationsSnapshot> {
      const includeDependencies = options.includeDependencies === true;
      const cacheKey = `${projectId}\u0000${includeDependencies ? "detail" : "portfolio"}`;
      const at = cacheNow();
      const hit = cache.get(cacheKey);
      if (hit && at - hit.at < ttlMs) return hit.value;
      const value = build(projectId, includeDependencies);
      cache.set(cacheKey, { value, at });
      void value.catch(() => {
        if (cache.get(cacheKey)?.value === value) cache.delete(cacheKey);
      });
      return value;
    },
    invalidate(projectId: string): void {
      cache.delete(`${projectId}\u0000detail`);
      cache.delete(`${projectId}\u0000portfolio`);
    },
  };
}
