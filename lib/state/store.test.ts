import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTask, readTask, listTasks, upsertProjectOverride, listProjectOverrides } from "./store";
import type { TaskRecord } from "./types";

function makeRecord(id: string): TaskRecord {
  return {
    envelope: {
      id, source: "cli", project: "stock-control", task_type: "bugfix",
      agent: "backend-engineer", title: `Task ${id}`, instructions: "do it",
      repo_path: "~/dev/surtec/stock-control", branch: `agent/${id}`,
      sandbox: "workspace-write", expected_outputs: ["summary"],
      requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-28T10:00:00Z", started_at: null,
    updated_at: "2026-05-28T10:00:00Z", finished_at: null,
    result: null, logs_path: null,
  };
}

describe("store", () => {
  let dir: string;
  let tasks: string;
  let projects: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "surtec-store-"));
    tasks = join(dir, "tasks");
    projects = join(dir, "projects");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("roundtrips a task write -> read", () => {
    const rec = makeRecord("STK-1");
    writeTask(rec, tasks);
    expect(readTask("STK-1", tasks)).toEqual(rec);
  });

  it("readTask returns null when missing", () => {
    expect(readTask("nope", tasks)).toBeNull();
  });

  it("listTasks returns [] when dir does not exist", () => {
    expect(listTasks(join(dir, "absent"))).toEqual([]);
  });

  it("listTasks skips an unreadable/corrupt file without throwing", () => {
    writeTask(makeRecord("STK-1"), tasks);
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "broken.json"), "{ not json", "utf8");
    const result = listTasks(tasks);
    expect(result.map((r) => r.envelope.id)).toEqual(["STK-1"]);
  });

  it("upserts and lists project overrides", () => {
    upsertProjectOverride({ id: "stock-control", health: "ok", note: "fine" }, projects);
    expect(listProjectOverrides(projects)).toEqual([
      { id: "stock-control", health: "ok", note: "fine" },
    ]);
  });
});
