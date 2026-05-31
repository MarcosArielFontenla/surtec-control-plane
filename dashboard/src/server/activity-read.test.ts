import { describe, it, expect } from "vitest";
import { readRecentCommits, taskActivity, buildActivityFeed, createActivityCache, type CommitRow } from "./activity-read";
import type { TaskRecord, ActivityFeed } from "../../../lib/state/types";

type SpawnResult = { status: number | null; stdout?: string; error?: Error };
const fakeSpawn = (res: SpawnResult) => (_cmd: string, _args: string[]) => res;

const row = (h: string, sub: string, at: string, author: string) => [h, h.slice(0, 7), sub, at, author].join("\x00");

describe("readRecentCommits", () => {
  it("parses NUL-separated git log rows", () => {
    const stdout = [row("abcdef1234", "fix bug", "2026-05-20T10:00:00Z", "marcos"), row("0011223344", "add x", "2026-05-19T09:00:00Z", "ana")].join("\n") + "\n";
    const out = readRecentCommits("/p", 8, fakeSpawn({ status: 0, stdout }));
    expect(out).toEqual<CommitRow[]>([
      { hash: "abcdef1234", shortHash: "abcdef1", subject: "fix bug", at: "2026-05-20T10:00:00Z", author: "marcos" },
      { hash: "0011223344", shortHash: "0011223", subject: "add x", at: "2026-05-19T09:00:00Z", author: "ana" },
    ]);
  });

  it("never throws on a non-zero git status → []", () => {
    expect(readRecentCommits("/p", 8, fakeSpawn({ status: 128, stdout: "" }))).toEqual([]);
  });

  it("never throws on a spawn error → []", () => {
    expect(readRecentCommits("/p", 8, fakeSpawn({ status: null, error: new Error("ENOENT") }))).toEqual([]);
  });
});

const baseTask = (over: Partial<TaskRecord> & { id?: string } = {}): TaskRecord => ({
  envelope: { id: over.id ?? "T1", source: "cli", project: "alpha", task_type: "bugfix", agent: "backend-engineer", title: "do it", instructions: "x", repo_path: "/p", branch: "agent/T1", sandbox: "workspace-write", expected_outputs: [], requires_human_approval: false, metadata: {} },
  lifecycle: "queued", outcome: null, created_at: "2026-05-01T00:00:00Z", started_at: null, updated_at: "2026-05-01T00:00:00Z", finished_at: null, result: null, logs_path: null,
  ...over,
});

describe("taskActivity (one row per task at its current state)", () => {
  it("queued → despachada at created_at", () => {
    expect(taskActivity(baseTask())).toMatchObject({ kind: "task", state: "despachada", at: "2026-05-01T00:00:00Z", project: "alpha", agent: "backend-engineer", title: "do it", taskId: "T1" });
  });
  it("running → en curso at started_at", () => {
    expect(taskActivity(baseTask({ lifecycle: "running", started_at: "2026-05-02T00:00:00Z" }))).toMatchObject({ state: "en curso", at: "2026-05-02T00:00:00Z" });
  });
  it("finished → hecha at finished_at", () => {
    expect(taskActivity(baseTask({ lifecycle: "finished", outcome: "completed", finished_at: "2026-05-03T00:00:00Z" }))).toMatchObject({ state: "hecha", at: "2026-05-03T00:00:00Z" });
  });
  it("approved decision → aprobada at decision.at (wins over lifecycle)", () => {
    expect(taskActivity(baseTask({ lifecycle: "finished", finished_at: "2026-05-03T00:00:00Z", decision: { status: "approved", at: "2026-05-04T00:00:00Z" } }))).toMatchObject({ state: "aprobada", at: "2026-05-04T00:00:00Z" });
  });
  it("rejected decision → rechazada at decision.at", () => {
    expect(taskActivity(baseTask({ decision: { status: "rejected", at: "2026-05-05T00:00:00Z" } }))).toMatchObject({ state: "rechazada", at: "2026-05-05T00:00:00Z" });
  });
});

describe("buildActivityFeed", () => {
  it("merges commits + tasks, sorts by `at` desc, and stamps project from discovery", () => {
    const discover = () => [{ id: "alpha", path: "/repos/alpha" }, { id: "beta", path: "/repos/beta" }];
    const commitsByPath: Record<string, CommitRow[]> = {
      "/repos/alpha": [{ hash: "a1", shortHash: "a1", subject: "alpha commit", at: "2026-05-10T00:00:00Z", author: "m" }],
      "/repos/beta": [{ hash: "b1", shortHash: "b1", subject: "beta commit", at: "2026-05-15T00:00:00Z", author: "m" }],
    };
    const readCommits = (path: string) => commitsByPath[path] ?? [];
    const listTasks = () => [baseTask({ id: "T9", lifecycle: "running", started_at: "2026-05-12T00:00:00Z" })];

    const feed = buildActivityFeed("/root", { discover, readCommits, listTasks });
    expect(feed.items.map((i) => i.at)).toEqual(["2026-05-15T00:00:00Z", "2026-05-12T00:00:00Z", "2026-05-10T00:00:00Z"]);
    expect(feed.items[0]).toMatchObject({ kind: "commit", project: "beta", subject: "beta commit" });
    expect(feed.items[1]).toMatchObject({ kind: "task", taskId: "T9", state: "en curso" });
  });

  it("caps the feed at the configured size", () => {
    const discover = () => [{ id: "alpha", path: "/repos/alpha" }];
    const many: CommitRow[] = Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}`, shortHash: `h${i}`, subject: `c${i}`, at: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, author: "m" }));
    const feed = buildActivityFeed("/root", { discover, readCommits: () => many, listTasks: () => [], cap: 60 });
    expect(feed.items).toHaveLength(60);
  });

  it("skips repos with no commits without breaking the feed", () => {
    const discover = () => [{ id: "alpha", path: "/repos/alpha" }, { id: "empty", path: "/repos/empty" }];
    const feed = buildActivityFeed("/root", { discover, readCommits: (p) => (p === "/repos/alpha" ? [{ hash: "a", shortHash: "a", subject: "x", at: "2026-05-01T00:00:00Z", author: "m" }] : []), listTasks: () => [] });
    expect(feed.items).toHaveLength(1);
  });
});

describe("createActivityCache", () => {
  it("serves cached within TTL and recomputes after", () => {
    let t = 0; let calls = 0;
    const cache = createActivityCache({ ttlMs: 100, now: () => t });
    const empty: ActivityFeed = { items: [] };
    const compute = () => { calls++; return empty; };
    cache.get("activity", compute);
    cache.get("activity", compute);
    expect(calls).toBe(1);
    t = 200;
    cache.get("activity", compute);
    expect(calls).toBe(2);
  });
});
