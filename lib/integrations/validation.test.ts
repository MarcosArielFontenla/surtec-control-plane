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

  it("accepts bounded CI freshness and pull-request decision evidence", () => {
    const value = snapshot() as { source_control: { remote: Record<string, unknown> }; ci: Record<string, unknown> };
    value.source_control.remote.waiting_pull_requests = [{ number: 12, updated_at: "2026-09-27T12:00:00.000Z", review_decision: "REVIEW_REQUIRED" }];
    value.ci.run_started_at = "2026-09-27T11:00:00.000Z";
    value.ci.run_id = "12345";
    value.ci.run_updated_at = "2026-09-27T12:00:00.000Z";
    expect(() => assertProjectIntegrationsSnapshot(snapshot())).not.toThrow();
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), source_control: value.source_control, ci: value.ci })).not.toThrow();
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), source_control: { ...value.source_control, remote: { ...value.source_control.remote, payload: { secret: "no" } } } })).toThrow(/additional properties/);
  });

  it("rejects unknown fields and unsupported versions", () => {
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), schema_version: 2 })).toThrow(/schema_version/);
    expect(() => assertProjectIntegrationsSnapshot({ ...snapshot(), credential: "secret" })).toThrow(/additional properties/);
  });
});
