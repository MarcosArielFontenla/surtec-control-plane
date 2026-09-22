import { describe, expect, it, vi } from "vitest";
import type { PolicyProject } from "../../../lib/policy/service";
import { createHttpHealthDeploymentProvider, createRailwayDeploymentProvider } from "./deployment-providers";

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
    deploy_url: null,
    railway: null,
    ...overrides,
  };
}

describe("HTTP health deployment provider", () => {
  it("normalizes the existing HTTP health reader", async () => {
    const readHealth = vi.fn().mockResolvedValue({ state: "up", status: 204, ms: 18 });
    const provider = createHttpHealthDeploymentProvider({ readHealth });

    await expect(provider.observe(project({ deploy_url: "https://example.com/health" }), observedAt)).resolves.toEqual({
      provider: "http-health",
      configured: true,
      health: "ok",
      status: "up",
      observed_at: observedAt,
      url: "https://example.com/health",
      http_status: 204,
      latency_ms: 18,
      deployed_at: null,
    });
  });

  it("does not fetch unsafe registry URLs", async () => {
    const readHealth = vi.fn();
    const provider = createHttpHealthDeploymentProvider({ readHealth });

    const result = await provider.observe(project({ deploy_url: "https://user:secret@example.com/health" }), observedAt);

    expect(result).toMatchObject({ configured: true, health: "unknown", url: null });
    expect(readHealth).not.toHaveBeenCalled();
  });

  it("returns an explicit unconfigured observation", async () => {
    const provider = createHttpHealthDeploymentProvider();
    await expect(provider.observe(project(), observedAt)).resolves.toMatchObject({
      provider: "http-health",
      configured: false,
      health: "unconfigured",
    });
  });
});

describe("Railway deployment provider", () => {
  it("normalizes success without exposing the credential", async () => {
    const readRailway = vi.fn().mockResolvedValue({
      ok: true,
      state: "success",
      at: "2026-09-21T11:59:00.000Z",
      url: "https://alpha.up.railway.app",
    });
    const provider = createRailwayDeploymentProvider({ token: "private-token", readRailway });
    const result = await provider.observe(project({ railway: { project_id: "p", service_id: "s", environment_id: "e" } }), observedAt);

    expect(result).toMatchObject({ provider: "railway", configured: true, health: "ok", status: "success" });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(readRailway).toHaveBeenCalledWith({ project_id: "p", service_id: "s", environment_id: "e" }, "private-token");
  });

  it("distinguishes missing credentials from missing provider configuration", async () => {
    const configured = project({ railway: { project_id: "p", service_id: "s", environment_id: "e" } });
    const withoutToken = createRailwayDeploymentProvider();

    await expect(withoutToken.observe(configured, observedAt)).resolves.toMatchObject({ configured: true, health: "unknown" });
    await expect(withoutToken.observe(project(), observedAt)).resolves.toMatchObject({ configured: false, health: "unconfigured" });
  });

  it("redacts provider errors and rejects unsafe response URLs", async () => {
    const configured = project({ railway: { project_id: "p", service_id: "s", environment_id: "e" } });
    const errorProvider = createRailwayDeploymentProvider({
      token: "tok",
      readRailway: async () => { throw new Error("secret=provider-redaction-value"); },
    });
    const unsafeUrlProvider = createRailwayDeploymentProvider({
      token: "tok",
      readRailway: async () => ({ ok: true, state: "success", at: null, url: "javascript:alert(1)" }),
    });

    expect((await errorProvider.observe(configured, observedAt)).error).not.toContain("provider-redaction-value");
    await expect(unsafeUrlProvider.observe(configured, observedAt)).resolves.toMatchObject({
      url: null,
      error: "provider returned an unsafe URL",
    });
  });
});
