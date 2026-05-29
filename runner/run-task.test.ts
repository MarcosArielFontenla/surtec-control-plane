import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";

vi.mock("./claude", () => ({ runReadOnlyAgent: vi.fn() }));
import { runReadOnlyAgent } from "./claude";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";

let root: string;
let repo: string;

function queuedRecord(): TaskRecord {
  return {
    envelope: {
      id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
      agent: "backend-engineer", title: "Analyze", instructions: "Review auth.",
      repo_path: repo, branch: "agent/T-1", sandbox: "read-only",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-runtask-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    description: Implements backend.\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  vi.mocked(runReadOnlyAgent).mockReset();
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

describe("runTask", () => {
  it("transitions queued -> finished with the parsed AgentResult", async () => {
    writeTask(queuedRecord());
    vi.mocked(runReadOnlyAgent).mockResolvedValue({
      text: '```json\n{ "summary": "ok", "risks": ["r"], "blockers": [], "next_steps": [], "status": "completed" }\n```',
      costUsd: 0.01,
      tokens: 42,
    });

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("completed");
    expect(rec.result?.summary).toBe("ok");
    expect(rec.result?.risks).toEqual(["r"]);
    expect(rec.started_at).not.toBeNull();
    expect(rec.finished_at).not.toBeNull();
  });

  it("marks failed with a blocker when the agent throws", async () => {
    writeTask(queuedRecord());
    vi.mocked(runReadOnlyAgent).mockRejectedValue(new Error("api exploded"));

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.lifecycle).toBe("finished");
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers).toEqual(["api exploded"]);
  });

  it("fails cleanly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    writeTask(queuedRecord());

    await runTask("T-1", root);

    const rec = readTask("T-1")!;
    expect(rec.outcome).toBe("failed");
    expect(rec.result?.blockers[0]).toContain("ANTHROPIC_API_KEY");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });

  it("fails when the repo path does not exist", async () => {
    const rec = queuedRecord();
    rec.envelope.repo_path = join(root, "does-not-exist");
    writeTask(rec);

    await runTask("T-1", root);

    const out = readTask("T-1")!;
    expect(out.outcome).toBe("failed");
    expect(out.result?.blockers[0]).toContain("repo not found");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });

  it("fails when the agent id is not in the registry", async () => {
    const rec = queuedRecord();
    rec.envelope.agent = "ghost-agent";
    writeTask(rec);

    await runTask("T-1", root);

    const out = readTask("T-1")!;
    expect(out.outcome).toBe("failed");
    expect(out.result?.blockers[0]).toContain("unknown agent");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });
});
