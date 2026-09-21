import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
import { buildPrBody, ensurePullRequest } from "./github";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "implementation",
  agent: "backend-engineer", title: "Add alert", instructions: "do it", repo_path: "~/dev/x",
  branch: "agent/T-1", sandbox: "workspace-write", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

beforeEach(() => mocks.spawnSync.mockReset());

function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    task_id: "T-1", agent: "backend-engineer", status: "completed",
    summary: "Added the alert endpoint.",
    files_changed: ["src/a.ts"], commands_run: [], tests_run: [],
    risks: ["no rate limit"], blockers: [], next_steps: ["add tests"], artifacts: [],
    logs_path: "reports/T-1.jsonl",
    ...over,
  };
}

describe("buildPrBody", () => {
  it("includes summary, risks, next steps, and a footer with the task id + agent", () => {
    const body = buildPrBody(envelope, result());
    expect(body).toContain("## Summary");
    expect(body).toContain("Added the alert endpoint.");
    expect(body).toContain("## Risks");
    expect(body).toContain("- no rate limit");
    expect(body).toContain("## Next steps");
    expect(body).toContain("- add tests");
    expect(body).toContain("task T-1");
    expect(body).toContain("agent backend-engineer");
  });

  it("omits empty risk/next-step sections", () => {
    const body = buildPrBody(envelope, result({ risks: [], next_steps: [] }));
    expect(body).not.toContain("## Risks");
    expect(body).not.toContain("## Next steps");
    expect(body).toContain("## Summary");
  });

  it("handles a null result with a placeholder summary", () => {
    const body = buildPrBody(envelope, null);
    expect(body).toContain("(no summary)");
    expect(body).toContain("task T-1");
  });
});

describe("ensurePullRequest", () => {
  it("returns an existing open PR instead of creating a duplicate", () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: "https://github.com/x/pull/1\n", stderr: "" });

    expect(ensurePullRequest("/repo", "agent/T-1", "main", "title", "body"))
      .toEqual({ url: "https://github.com/x/pull/1" });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync.mock.calls[0][1]).toContain("list");
  });

  it("creates a PR only after confirming that none is open", () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "https://github.com/x/pull/2\n", stderr: "" });

    expect(ensurePullRequest("/repo", "agent/T-1", "main", "title", "body"))
      .toEqual({ url: "https://github.com/x/pull/2" });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync.mock.calls[1][1]).toContain("create");
  });

  it("does not create a PR when the duplicate check fails", () => {
    mocks.spawnSync.mockReturnValueOnce({ status: 1, stdout: "", stderr: "token=ghp_abcdefghijklmnopqrstuvwxyz123456" });

    const result = ensurePullRequest("/repo", "agent/T-1", "main", "title", "body");

    expect(result.error).not.toContain("ghp_");
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });
});
