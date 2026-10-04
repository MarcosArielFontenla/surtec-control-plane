import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeed, runRecord, runSetStatus } from "./surtec-state";

describe("cli seed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-cli-"));
    mkdirSync(join(root, "fixtures", "tasks"), { recursive: true });
    mkdirSync(join(root, "fixtures", "projects"), { recursive: true });
    writeFileSync(join(root, "fixtures", "tasks", "T-1.json"), JSON.stringify({
      envelope: { id: "T-1", source: "cli", project: "synthetic", task_type: "analysis", agent: "backend-engineer", title: "Synthetic history", instructions: "Synthetic", repo_path: "/synthetic", branch: "agent/T-1", sandbox: "read-only", expected_outputs: [], requires_human_approval: true, metadata: {} },
      lifecycle: "finished", outcome: "completed", created_at: "2026-09-30T00:00:00Z", started_at: null, updated_at: "2026-09-30T00:00:00Z", finished_at: "2026-09-30T00:00:00Z", result: null, logs_path: null,
    }), "utf8");
    writeFileSync(join(root, "fixtures", "projects", "p.json"), "{}", "utf8");
    process.env.SURTEC_STATE_DIR = join(root, "state");
    process.env.SURTEC_FIXTURES_DIR = join(root, "fixtures");
  });
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_FIXTURES_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("copies fixtures into the state dir", () => {
    const { tasks, projects } = runSeed();
    expect(tasks).toBe(1);
    expect(projects).toBe(1);
    expect(existsSync(join(root, "state", "tasks", "T-1.json"))).toBe(true);
    expect(existsSync(join(root, "state", "projects", "p.json"))).toBe(true);
  });
  it("refuses raw envelopes instead of importing a new ungoverned queued task", async () => {
    const path = join(root, "envelope.json");
    writeFileSync(path, JSON.stringify({ id: "RAW-1", source: "cli", sandbox: "workspace-write", context_manifest: {} }));
    await expect(runRecord(path, { repoRoot: root })).rejects.toThrow();
    expect(existsSync(join(root, "state/tasks/RAW-1.json"))).toBe(false);
  });
  it("preflights all seed tasks and refuses queued work before copying any fixture", () => {
    const path = join(root, "fixtures/tasks/T-1.json");
    const record = JSON.parse(readFileSync(path, "utf8")); record.envelope.id = "T-2"; record.lifecycle = "queued"; record.outcome = null; record.finished_at = null;
    writeFileSync(join(root, "fixtures/tasks/T-2.json"), JSON.stringify(record));
    expect(() => runSeed()).toThrow(/terminal task history/);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("does not overwrite an existing task when importing history", () => {
    runSeed(); const path = join(root, "state/tasks/T-1.json"); const before = readFileSync(path);
    expect(() => runSeed()).toThrow(/replace/); expect(readFileSync(path)).toEqual(before);
  });
  it("does not reopen seeded terminal history as recoverable running work", () => {
    runSeed(); const path = join(root, "state/tasks/T-1.json"); const before = readFileSync(path);
    expect(() => runSetStatus("T-1", "running")).toThrow(/leased worker/);
    expect(readFileSync(path)).toEqual(before);
  });
});
