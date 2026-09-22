import { describe, expect, it } from "vitest";
import { assertProjectIntegrationsSnapshot } from "./validation";

function snapshot(): Record<string, unknown> {
  return {
    schema_version: 1,
    project_id: "alpha",
    observed_at: "2026-09-21T12:00:00.000Z",
    trace_id: null,
    source_control: {
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
    },
    ci: {
      provider: "github-actions",
      configured: false,
      health: "unconfigured",
      status: null,
      branch: null,
    },
    deployments: [],
  };
}

describe("project integrations schema", () => {
  it("accepts the versioned read model", () => {
    expect(() => assertProjectIntegrationsSnapshot(snapshot())).not.toThrow();
  });

  it("rejects unknown fields and unsupported versions", () => {
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), schema_version: 2 })).toThrow(/schema_version/);
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), credential: "secret" })).toThrow(/additional properties/);
  });
});
