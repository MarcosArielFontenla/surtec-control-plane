import { describe, expect, it, vi } from "vitest";
import type { DeploymentProvider, ProjectIntegrationsSnapshot } from "../../../lib/integrations/types";
import type { PolicyProject } from "../../../lib/policy/service";
import type { TraceSpan, Tracer } from "../../../lib/observability/tracing";
import { createProjectIntegrationsService } from "./project-integrations";
import { createRoutineProjectIntegrationsService, type RoutineCommandResult } from "./project-integrations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      readDependencies: () => ({ ok: true, outdated: 2, observed_at: observedAt }),
      deploymentProviders: [deploymentProvider("http-health", 5), deploymentProvider("railway")],
      tracer: tracing.tracer,
      clock: () => new Date(observedAt),
    });

    const result = await service.read("alpha", { includeDependencies: true });

    expect(result).toMatchObject<Partial<ProjectIntegrationsSnapshot>>({
      schema_version: 2,
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
      dependencies: { provider: "npm", configured: true, health: "degraded", outdated: 2, observed_at: observedAt },
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

  it("preserves only bounded pull-request decision fields and the CI run start time", async () => {
    const service = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true }),
      readGithub: () => ({ ok: true, prs: 1, issues: 0, waitingPullRequests: [{ number: 7, updatedAt: observedAt, reviewDecision: "CHANGES_REQUESTED" }] }),
      readCi: () => ({ state: "running", startedAt: observedAt, runId: "gh-run-123", updatedAt: observedAt }),
      deploymentProviders: [],
      clock: () => new Date(observedAt),
    });
    const result = await service.read("alpha");
    expect(result.source_control.remote.waiting_pull_requests).toEqual([
      { number: 7, updated_at: observedAt, review_decision: "CHANGES_REQUESTED" },
    ]);
    expect(result.ci).toMatchObject({ status: "running", run_started_at: observedAt, run_id: "gh-run-123", run_updated_at: observedAt });
  });

  it("keeps dependency health independent and distinguishes an unconfigured manifest from a degraded check", async () => {
    const noManifest = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false }),
      readGithub: () => ({ ok: true, prs: 0, issues: 0 }),
      readCi: () => ({ state: "none" }),
      readDependencies: () => ({ ok: false, outdated: 0, error: "sin package.json", observed_at: observedAt }),
      deploymentProviders: [],
      clock: () => new Date(observedAt),
    });
    const missingInstall = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false }),
      readGithub: () => ({ ok: true, prs: 0, issues: 0 }),
      readCi: () => ({ state: "none" }),
      readDependencies: () => ({ ok: false, outdated: 0, error: "n/a (npm install)", observed_at: observedAt }),
      deploymentProviders: [],
      clock: () => new Date(observedAt),
    });

    await expect(noManifest.read("alpha", { includeDependencies: true })).resolves.toMatchObject({
      dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, error: "sin package.json" },
    });
    await expect(missingInstall.read("alpha", { includeDependencies: true })).resolves.toMatchObject({
      dependencies: { provider: "npm", configured: true, health: "unknown", outdated: 0, error: "n/a (npm install)" },
    });
  });

  it("defers expensive dependency checks for portfolio reads but shares the cache for project detail", async () => {
    const readDependencies = vi.fn(() => ({ ok: true, outdated: 0, observed_at: observedAt }));
    const service = createProjectIntegrationsService("/repo", {
      policy: { project: () => project() },
      readLocalGit: () => ({ branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true }),
      readGithub: () => ({ ok: true, prs: 0, issues: 0 }),
      readCi: () => ({ state: "none" }),
      readDependencies,
      deploymentProviders: [],
      clock: () => new Date(observedAt),
    });

    const portfolio = await service.read("alpha");
    expect(portfolio.dependencies).toMatchObject({ health: "unknown", error: "Detailed dependency check was not requested." });
    expect(readDependencies).not.toHaveBeenCalled();
    await service.read("alpha", { includeDependencies: true });
    await service.read("alpha", { includeDependencies: true });
    expect(readDependencies).toHaveBeenCalledOnce();
    service.invalidate("alpha");
    await service.read("alpha", { includeDependencies: true });
    expect(readDependencies).toHaveBeenCalledTimes(2);
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

describe("T010 bounded async routine integrations", () => {
  async function fixture(run: (path: string) => Promise<void>): Promise<void> {
    const path = mkdtempSync(join(tmpdir(), "surtec-routine-integration-"));
    try { await run(path); } finally { rmSync(path, { recursive: true, force: true }); }
  }
  const options = (signal = new AbortController().signal, check = vi.fn()) => ({ signal, check,
    deadline_at: "2026-09-21T12:00:30.000Z" });
  const gitHash = "a".repeat(40);
  const gitOutput = `# branch.oid ${gitHash}\n# branch.head private-branch\n# branch.ab +1 -2\n1 .M N... 100644 100644 100644 ${gitHash} ${gitHash} private-path\n`;
  const runner = () => vi.fn(async (file: string): Promise<RoutineCommandResult> => file === "git"
    ? { status: 0, stdout: gitOutput } : { status: 0, stdout: JSON.stringify([{ status: "completed", conclusion: "failure", databaseId: 3,
      updatedAt: observedAt, private_payload: "private-provider-payload" }]) });
  it("uses fixed no-shell async argv, purpose environments and technical projections", async () => fixture(async (path) => {
    const run = runner(); const doFetch = vi.fn(async (_url: string) => new Response(null, { status: 200 }));
    const readDependencies = vi.fn(async () => 2);
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: path, railway: null }) },
      run, fetch: doFetch as typeof fetch, readDependencies, clock: () => new Date(observedAt),
      environment: { PATH: "safe-path", GH_TOKEN: "private-gh-value", OPENAI_API_KEY: "private-model-value", NODE_OPTIONS: "unsafe" } });
    const result = await service.read("alpha", options());
    expect(result.source_control).toMatchObject({ health: "ok", branch: null, dirty: true, uncommitted: 1, ahead: 1, behind: 2 });
    expect(result.ci).toMatchObject({ status: "failing", health: "down", run_id: "3" });
    expect(result.dependencies).toMatchObject({ health: "degraded", outdated: 2 });
    expect(result.deployments[0]).toMatchObject({ health: "ok", http_status: 200, url: null });
    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls as unknown as [string, string[], { env: NodeJS.ProcessEnv; shell: boolean }][]) {
      expect(call[2].shell).toBe(false); expect(call[2].env.OPENAI_API_KEY).toBeUndefined(); expect(call[2].env.NODE_OPTIONS).toBeUndefined();
      expect(call[1]).not.toContain("install"); expect(call[1]).not.toContain("update");
      if (call[0] === "git") expect(call[2].env.GH_TOKEN).toBeUndefined(); else expect(call[2].env.GH_TOKEN).toBe("private-gh-value");
    }
    expect(doFetch.mock.calls[0]?.[0]).toBe("https://alpha.example.com/health");
    const text = JSON.stringify(result);
    for (const privateValue of ["private-branch", "private-path", "private-gh-value", "private-model-value", "private-provider-payload"]) expect(text).not.toContain(privateValue);
  }));
  it("keeps unsafe legacy npm checks unavailable rather than launching a shell or inventing zero", async () => fixture(async (path) => {
    const run = runner();
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: path, repo: null, deploy_url: null, railway: null }) },
      run, clock: () => new Date(observedAt) });
    const result = await service.read("alpha", options());
    expect(result.dependencies).toMatchObject({ configured: true, health: "unknown", outdated: null });
    expect(run.mock.calls.map((call) => call[0])).toEqual(["git"]);
  }));
  it("does not start providers for disabled or unconfigured sources", async () => {
    const run = runner(); const doFetch = vi.fn(); const readDependencies = vi.fn();
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null }) },
      run, fetch: doFetch, readDependencies, providersEnabled: false, clock: () => new Date(observedAt) });
    await expect(service.read("alpha", options())).resolves.toMatchObject({ ci: { health: "unconfigured" }, dependencies: { outdated: null } });
    expect(run).not.toHaveBeenCalled(); expect(doFetch).not.toHaveBeenCalled(); expect(readDependencies).not.toHaveBeenCalled();
  });
  it.each(["missing", "../alpha", "alpha; echo unsafe"])("rejects unknown/injected project %s before source effects", async (id) => {
    const run = runner(); const doFetch = vi.fn();
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => { throw new Error("private-policy-error"); } },
      run, fetch: doFetch, clock: () => new Date(observedAt) });
    await expect(service.read(id, options())).rejects.toThrow(); expect(run).not.toHaveBeenCalled(); expect(doFetch).not.toHaveBeenCalled();
  });
  it.each(["file:///private", "https://user:pass@example.com"])("refuses unsafe trusted health configuration %s", async (url) => {
    const doFetch = vi.fn(); const run = runner();
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, repo: null, deploy_url: url, railway: null }) },
      run, fetch: doFetch, clock: () => new Date(observedAt) });
    const result = await service.read("alpha", options());
    expect(result.deployments).toHaveLength(2); expect(result.deployments[0].health).toBe("unknown"); expect(doFetch).not.toHaveBeenCalled();
  });
  it.each(["https://github.com/other-host.example/owner/repo", "https://github.com/owner/repo?token=private", "https://github.com/owner/../repo"])(
    "refuses noncanonical GitHub repository selection before subprocess effects", async (repo) => {
      const run = runner(); const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, repo, deploy_url: null, railway: null }) },
        run, clock: () => new Date(observedAt) });
      await expect(service.read("alpha", options())).resolves.toMatchObject({ ci: { health: "unconfigured" } }); expect(run).not.toHaveBeenCalled();
    });
  it("coalesces exact-config reads while cancellation affects only its owning consumer", async () => {
    let finish!: (result: RoutineCommandResult) => void;
    const run = vi.fn(() => new Promise<RoutineCommandResult>((done) => { finish = done; }));
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, deploy_url: null, railway: null }) },
      run, clock: () => new Date(observedAt) });
    const firstController = new AbortController(); const first = service.read("alpha", options(firstController.signal));
    const firstRejected = expect(first).rejects.toThrow("stopped");
    const second = service.read("alpha", options()); await new Promise((done) => setTimeout(done, 5));
    firstController.abort(); await firstRejected;
    finish({ status: 0, stdout: "[]" }); await expect(second).resolves.toMatchObject({ ci: { status: "none" } });
    expect(run).toHaveBeenCalledOnce(); await service.read("alpha", options()); expect(run).toHaveBeenCalledOnce();
  });
  it("stops the last consumer, propagates cancellation, and refuses late cache publication", async () => {
    let finish!: (result: RoutineCommandResult) => void; let seenSignal!: AbortSignal;
    const run = vi.fn((_file, _args, config) => new Promise<RoutineCommandResult>((done) => { finish = done; seenSignal = config.signal; }));
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, deploy_url: null, railway: null }) },
      run, clock: () => new Date(observedAt) });
    const controller = new AbortController(); const pending = service.read("alpha", options(controller.signal));
    const rejected = expect(pending).rejects.toThrow("stopped"); await new Promise((done) => setTimeout(done, 5));
    controller.abort(); await rejected; expect(seenSignal.aborted).toBe(true);
    finish({ status: 0, stdout: "[]" }); await new Promise((done) => setTimeout(done, 5));
    const again = service.read("alpha", options()); await new Promise((done) => setTimeout(done, 5));
    expect(run).toHaveBeenCalledTimes(2); finish({ status: 0, stdout: "[]" }); await again;
  });
  it("isolates a slow optional provider and leaves timers/heartbeat responsive", async () => fixture(async (path) => {
    const run = runner(); let slowSignal!: AbortSignal;
    const doFetch = vi.fn(async (_url, init) => { slowSignal = init.signal; return new Promise<Response>(() => undefined); });
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: path, railway: null }) },
      run, fetch: doFetch as typeof fetch, sourceTimeoutMs: 30, clock: () => new Date(observedAt) });
    let heartbeats = 0; const timer = setInterval(() => heartbeats++, 2);
    try {
      const result = await service.read("alpha", options());
      expect(result.source_control.health).toBe("ok"); expect(result.ci.status).toBe("failing");
      expect(result.deployments[0].health).toBe("unknown"); expect(slowSignal.aborted).toBe(true); expect(heartbeats).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  }));
  it("deadline refusal happens before work and a short consumer deadline aborts active sources", async () => {
    const run = vi.fn(() => new Promise<RoutineCommandResult>(() => undefined));
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, deploy_url: null, railway: null }) },
      run, clock: () => new Date(observedAt) });
    await expect(service.read("alpha", { ...options(), deadline_at: observedAt })).rejects.toThrow("stopped"); expect(run).not.toHaveBeenCalled();
    await expect(service.read("alpha", { ...options(), deadline_at: "2026-09-21T12:00:00.010Z" })).rejects.toThrow("stopped");
  });
  it("invalidates changed trusted configuration and verifies it after every await", async () => {
    let configured = project({ repo_path: null, deploy_url: null, railway: null });
    const run = runner(); const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => configured }, run, clock: () => new Date(observedAt) });
    await service.read("alpha", options()); configured = { ...configured, default_branch: "changed" };
    await service.read("alpha", options()); expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(["not-json", "{}", "[{\"status\":\"completed\"}]", "[{},{}]", " ".repeat(262145), "[".repeat(40) + "0" + "]".repeat(40)])(
    "preserves malformed/oversized provider state as unavailable without raw output", async (stdout) => {
      const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, deploy_url: null, railway: null }) },
        run: async () => ({ status: 0, stdout }), clock: () => new Date(observedAt) });
      await expect(service.read("alpha", options())).resolves.toMatchObject({ ci: { status: "unknown", health: "unknown" } });
    });
  it("uses the fixed Railway read query and refuses invalid UTF-8 even in an ignored field", async () => {
    const valid = Buffer.from('{"data":{"deployments":{"edges":[{"node":{"status":"SUCCESS"}}]}},"ignored":"');
    const invalid = Buffer.concat([valid, Buffer.from([0xff]), Buffer.from('"}')]); const doFetch = vi.fn(async (_url: string) => new Response(invalid));
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: null, repo: null, deploy_url: null }) },
      fetch: doFetch as typeof fetch, environment: { RAILWAY_TOKEN: "private-token" }, clock: () => new Date(observedAt) });
    const result = await service.read("alpha", options()); expect(result.deployments[1].health).toBe("unknown");
    expect(doFetch.mock.calls[0]?.[0]).toBe("https://backboard.railway.com/graphql/v2");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it.each(["# branch.oid junk\n# branch.head main\n", `# branch.oid ${gitHash}\n# branch.head main\n# branch.ab malformed\n`,
    `# branch.oid ${gitHash}\n# branch.head main\n1 private-path\n`])("refuses malformed porcelain without fabricating clean/zero Git facts", async (stdout) => fixture(async (path) => {
    const service = createRoutineProjectIntegrationsService("/repo", { policy: { project: () => project({ repo_path: path, repo: null, deploy_url: null, railway: null }) },
      run: async () => ({ status: 0, stdout }), clock: () => new Date(observedAt) });
    const result = await service.read("alpha", options());
    expect(result.source_control).toMatchObject({ health: "unknown", dirty: null, uncommitted: null, ahead: null, behind: null });
  }));
});
