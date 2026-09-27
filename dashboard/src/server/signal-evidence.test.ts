import { describe, expect, it, vi } from "vitest";
import type { ProjectIntegrationsSnapshot, ProjectIntegrationsReader } from "../../../lib/integrations/types";
import { createSignalEvidenceReader } from "./signal-evidence";

const at = "2026-09-27T12:00:00.000Z";

function snapshot(projectId: string): ProjectIntegrationsSnapshot {
  return {
    schema_version: 1, project_id: projectId, observed_at: at, trace_id: null,
    source_control: {
      provider: "git", configured: true, health: "ok", branch: "main", dirty: false,
      uncommitted: 0, ahead: 0, behind: 0,
      remote: { provider: "github", configured: true, health: "ok", pull_requests: 0, issues: 0, waiting_pull_requests: [] },
    },
    ci: { provider: "github-actions", configured: true, health: "ok", status: "passing", branch: "main" },
    deployments: [],
  };
}

describe("portfolio signal evidence reader", () => {
  it("aggregates sources once, bounds integration concurrency, and isolates per-provider failures", async () => {
    let active = 0;
    let peak = 0;
    const integrations: ProjectIntegrationsReader = {
      async read(projectId) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (projectId === "beta") throw new Error("credential=must-not-leak");
        return snapshot(projectId);
      },
      invalidate: vi.fn(),
    };
    const reader = createSignalEvidenceReader("/control-plane", {
      integrations,
      root: "/portfolio",
      discover: () => [{ id: "alpha", path: "D:/private/alpha" }, { id: "beta", path: "D:/private/beta" }],
      readGit: () => ({ branch: "main", dirty: true, uncommitted: 1, ahead: 0, behind: 0, last_commit: { hash: "1234567", subject: "safe", at }, ok: true }),
      readTasks: () => [],
      readProfiles: () => [],
      readNotes: () => [],
      readInbox: async () => ({
        items: [{ projectId: "alpha", slug: "owner/alpha", number: 3, title: "private issue", url: "https://example.invalid", updatedAt: at, labels: ["high"], author: "private" }],
        repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: false, error: "token=must-not-leak" }],
      }),
      readRegisteredProjects: () => [{ id: "alpha", repo: "owner/alpha" }, { id: "beta", repo: "owner/beta" }],
      concurrency: 1,
    });

    const evidence = await reader.read();
    expect(evidence.projects).toHaveLength(2);
    expect(evidence.projects[0].git?.dirty).toBe(true);
    expect(evidence.projects[0].integrations?.project_id).toBe("alpha");
    expect(evidence.projects[1].integrations).toBeNull();
    expect(evidence.issues).toHaveLength(1);
    expect(evidence.warnings).toContain("Integration evidence for project beta is unavailable.");
    expect(evidence.warnings).toContain("GitHub issue evidence for project beta is unavailable.");
    expect(evidence.warnings?.join(" ")).not.toContain("must-not-leak");
    expect(JSON.stringify(evidence.projects)).not.toContain("D:/private");
    expect(peak).toBe(1);
  });

  it("keeps local signals when task/profile/issue sources fail", async () => {
    const reader = createSignalEvidenceReader("/control-plane", {
      root: "/portfolio",
      discover: () => [{ id: "alpha", path: "/private/alpha" }],
      readGit: () => ({ branch: "main", dirty: true, uncommitted: 1, ahead: 0, behind: 0, last_commit: null, ok: true }),
      readTasks: () => { throw new Error("task store failure"); },
      readProfiles: () => { throw new Error("profile store failure"); },
      readNotes: () => [],
      readInbox: async () => { throw new Error("provider failure"); },
      readRegisteredProjects: () => [],
    });
    const evidence = await reader.read();
    expect(evidence.projects).toHaveLength(1);
    expect(evidence.projects[0].git?.dirty).toBe(true);
    expect(evidence.projects[0].profile).toBeNull();
    expect(evidence.projects[0].profile_available).toBe(false);
    expect(evidence.warnings).toEqual(expect.arrayContaining([
      "Task evidence could not be read; other signal sources remain available.",
      "Portfolio profiles could not be read; other signal sources remain available.",
      "GitHub issue evidence could not be read; other signal sources remain available.",
    ]));
  });
});
