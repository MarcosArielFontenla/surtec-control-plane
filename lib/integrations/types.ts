import type { PolicyProject } from "../policy/service";

export type IntegrationHealth = "ok" | "degraded" | "down" | "unknown" | "unconfigured";
export type DeploymentProviderId = "http-health" | "railway";

export interface SourceControlObservation {
  provider: "git";
  configured: boolean;
  health: IntegrationHealth;
  branch: string | null;
  dirty: boolean | null;
  uncommitted: number | null;
  ahead: number | null;
  behind: number | null;
  remote: {
    provider: "github";
    configured: boolean;
    health: IntegrationHealth;
    pull_requests: number | null;
    issues: number | null;
    error?: string;
  };
  error?: string;
}

export interface CiObservation {
  provider: "github-actions";
  configured: boolean;
  health: IntegrationHealth;
  status: "passing" | "failing" | "running" | "none" | "unknown" | null;
  branch: string | null;
  error?: string;
}

export interface DeploymentObservation {
  provider: DeploymentProviderId;
  configured: boolean;
  health: IntegrationHealth;
  status: string | null;
  observed_at: string;
  url: string | null;
  http_status: number | null;
  latency_ms: number | null;
  deployed_at: string | null;
  error?: string;
}

export interface ProjectIntegrationsSnapshot {
  schema_version: 1;
  project_id: string;
  observed_at: string;
  trace_id: string | null;
  source_control: SourceControlObservation;
  ci: CiObservation;
  deployments: DeploymentObservation[];
}

export interface DeploymentProvider {
  readonly id: DeploymentProviderId;
  observe(project: PolicyProject, observedAt: string): Promise<DeploymentObservation>;
}

export interface ProjectIntegrationsReader {
  read(projectId: string): Promise<ProjectIntegrationsSnapshot>;
  invalidate(projectId: string): void;
}
