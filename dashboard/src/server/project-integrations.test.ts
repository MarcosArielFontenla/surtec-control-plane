import { describe, expect, it, vi } from "vitest";
import type { DeploymentProvider, ProjectIntegrationsSnapshot } from "../../../lib/integrations/types";
import type { PolicyProject } from "../../../lib/policy/service";
import type { TraceSpan, Tracer } from "../../../lib/observability/tracing";
import { createProjectIntegrationsService } from "./project-integrations";

const observedAt = "2026-09-21T12:00:00.000Z";

function project(overrides: Partial<PolicyProject> = {}): PolicyProject {
  return {
    id: "alpha",
    status: "active",
    repo: "https://github.com/surtec/alpha.git",
    repo_path: "D:/projects/alpha",
    default_branch: "main",
    allowed_agents: [],
    sandbox: "read-only",
    commands: {},
    verify_commands: [],
    approval: { before_merge: true, before_deploy: true },
    deploy_url: "https://alpha.example.com/health",
    railway: { project_id: "p", service_id: "s", environment_id: "e" },
    ...overrides,
  };
}

function deploymentProvider(id: DeploymentProvider["id"], delay = 0): DeploymentProvider {
  return {
    id,
    async observe(_project, at) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        provider: id,
        configured: true,
        health: "ok",
        status: "ready",
        observed_at: at,
        url: "https://example.com",
        http_status: id === "http-health" ? 200 : null,
        latency_ms: id === "http-health" ? 10 : null,
        deployed_at: null,
      };
    },
  };
}

function tracer(): { tracer: Tracer; spans: { name: string; events: string[]; status: string | undefined }[] } {
  const spans: { name: string; events: string[]; status: string | undefined }[] = [];
  return {
    spans,
    tracer: {
      startSpan(name): TraceSpan {
        const record = { name, events: [] as string[], status: undefined as string | undefined };
        spans.push(record);
        return {
          context: { traceId: "trace_123", spanId: `span_${spans.length}` },
          addEvent(event) { record.events.push(event); },
          end(status) { record.status = status; },
        };
      },
    },
  };
}

describe("createProjectIntegrationsService", () => {
  it("composes concrete source-control and CI reads with deterministic deployment provider order", async () => {
    const tracing = tracer();
    const service = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: "main", dirty: true, uncommitted: 2, ahead: 1, behind: 0, last_commit: null, ok: true }),
      readGithub: () => ({ ok: true, prs: 3, issues: 4 }),
      readCi: () => ({ state: "passing" }),
      deploymentProviders: [deploymentProvider("http-health", 5), deploymentProvider("railway")],
      tracer: tracing.tracer,
      clock: () => new Date(observedAt),
    });

    const result = await service.read("alpha");

    expect(result).toMatchObject<Partial<ProjectIntegrationsSnapshot>>({
      schema_version: 1,
      project_id: "alpha",
      observed_at: observedAt,
      trace_id: "trace_123",
      source_control: {
        provider: "git",
        configured: true,
        health: "ok",
        branch: "main",
        dirty: true,
        uncommitted: 2,
        ahead: 1,
        behind: 0,
        remote: { provider: "github", configured: true, health: "ok", pull_requests: 3, issues: 4 },
      },
      ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main" },
    });
    expect(result.deployments.map((item) => item.provider)).toEqual(["http-health", "railway"]);
    expect(tracing.spans.map((span) => span.name)).toEqual([
      "project-integrations.read",
      "project-integrations.deployment",
      "project-integrations.deployment",
    ]);
    expect(tracing.spans.every((span) => span.status === "ok")).toBe(true);
  });

  it("isolates a failing provider and redacts its error", async () => {
    const failing: DeploymentProvider = {
      id: "railway",
      async observe() { throw new Error("secret=railway-redaction-value"); },
    };
    const service = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false }),
      readGithub: () => { throw new Error("secret=private-value"); },
      readCi: () => { throw new Error("CI unavailable"); },
      deploymentProviders: [deploymentProvider("http-health"), failing],
      clock: () => new Date(observedAt),
    });

    const result = await service.read("alpha");

    expect(result.deployments[0].health).toBe("ok");
    expect(result.deployments[1]).toMatchObject({ provider: "railway", configured: true, health: "unknown" });
    expect(JSON.stringify(result)).not.toContain("railway-redaction-value");
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(result.source_control.remote.health).toBe("unknown");
    expect(result.ci.status).toBe("unknown");
  });

  it("uses a bounded TTL cache, invalidates explicitly, and never caches failures", async () => {
    let now = 0;
    const readLocalGit = vi.fn().mockReturnValue({ branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true });
    const policy = { project: vi.fn().mockImplementation((id: string) => {
      if (id === "missing") throw new Error("missing");
      return project({ repo: null, deploy_url: null, railway: null });
    }) };
    const service = createProjectIntegrationsService("/repo", {
      policy,
      readLocalGit,
      deploymentProviders: [],
      cacheNow: () => now,
      ttlMs: 100,
      clock: () => new Date(observedAt),
    });

    await service.read("alpha");
    await service.read("alpha");
    expect(readLocalGit).toHaveBeenCalledTimes(1);
    now = 101;
    await service.read("alpha");
    expect(readLocalGit).toHaveBeenCalledTimes(2);
    service.invalidate("alpha");
    await service.read("alpha");
    expect(readLocalGit).toHaveBeenCalledTimes(3);

    await expect(service.read("missing")).rejects.toThrow("missing");
    await expect(service.read("missing")).rejects.toThrow("missing");
    expect(policy.project).toHaveBeenCalledTimes(5);
  });

  it("fails closed when a provider returns another provider identity", async () => {
    const mismatched: DeploymentProvider = {
      id: "http-health",
      async observe(_project, at) {
        return {
          ...(await deploymentProvider("railway").observe(project(), at)),
          provider: "railway",
        };
      },
    };
    const service = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true }),
      readGithub: () => ({ ok: true, prs: 0, issues: 0 }),
      readCi: () => ({ state: "none" }),
      deploymentProviders: [mismatched],
      clock: () => new Date(observedAt),
    });

    await expect(service.read("alpha")).resolves.toMatchObject({
      deployments: [{ provider: "http-health", configured: true, health: "unknown" }],
    });
  });
});
