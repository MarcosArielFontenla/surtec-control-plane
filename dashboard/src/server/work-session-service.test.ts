import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord, TaskEvent, TaskRecord } from "../../../lib/state/types";
import { listWorkSessions } from "../../../lib/state/work-sessions";
import { createWorkSessionService, WorkSessionConflictError, WorkSessionNotFoundError, WorkSessionValidationError } from "./work-session-service";

let root: string | undefined;
let now = new Date("2026-09-27T10:00:00.000Z");
const fixedClock = () => new Date(now);

function makeService(overrides: Parameters<typeof createWorkSessionService>[1] = {}) {
  root = mkdtempSync(join(tmpdir(), "surtec-work-session-service-"));
  return createWorkSessionService(process.cwd(), { filePath: join(root, "state", "sessions", "work-sessions.json"), clock: fixedClock, resolveProject: (id) => id === "alpha" ? { branch: "feature/resume" } : id === "beta" ? { branch: "main" } : null, ...overrides });
}

const linkedTask = {
  envelope: { id: "TASK-1", project: "alpha", title: "Implement the save flow" },
  lifecycle: "finished",
  outcome: "completed",
  result: { verification: { status: "passed" } },
  decision: { pr_url: "https://github.com/example/alpha/pull/42" },
} as unknown as TaskRecord;

const linkedRun: RunRecord = {
  runId: "run-1", projectId: "alpha", kind: "oneshot", command: "pnpm test", status: "exited",
  pid: null, startedAt: "2026-09-27T09:00:00.000Z", endedAt: "2026-09-27T09:01:00.000Z", exitCode: 0,
};

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  now = new Date("2026-09-27T10:00:00.000Z");
});

describe("work session service", () => {
  it("captures project context, links task/process evidence, notes, and focused time across repeated pauses and restart", () => {
    const service = makeService({
      readTask: (id) => id === "TASK-1" ? linkedTask : null,
      readEvents: () => [{ type: "verification" } as TaskEvent],
      readRun: (id) => id === "run-1" ? linkedRun : null,
    });
    const created = service.start({ project_id: "alpha", objective: "Finish the save flow", related_task_ids: ["TASK-1"], related_run_ids: ["run-1"] });
    expect(created.branch).toBe("feature/resume");
    expect(created.related_task_ids).toEqual(["TASK-1"]);
    expect(created.related_run_ids).toEqual(["run-1"]);

    now = new Date(now.getTime() + 25 * 60_000);
    service.addNote(created.id, "The API transition is implemented.");
    service.pause(created.id, "Review the Playwright result");
    expect(service.snapshot().paused[0]?.elapsed_focused_ms).toBe(25 * 60_000);

    const restartedWhilePaused = createWorkSessionService(process.cwd(), {
      filePath: join(root!, "state", "sessions", "work-sessions.json"), clock: fixedClock,
      readTask: () => linkedTask, readEvents: () => [{ type: "verification" } as TaskEvent], readRun: () => linkedRun,
    });
    expect(restartedWhilePaused.snapshot().paused[0]).toMatchObject({ id: created.id, elapsed_focused_ms: 25 * 60_000, next_action: "Review the Playwright result" });

    now = new Date(now.getTime() + 3 * 60 * 60_000);
    service.resume(created.id);
    now = new Date(now.getTime() + 10 * 60_000);
    service.pause(created.id, "Run the final suite");

    now = new Date(now.getTime() + 2 * 60 * 60_000);
    service.resume(created.id);
    now = new Date(now.getTime() + 5 * 60_000);
    service.complete(created.id, "Save flow completed and verified.", "none");

    const restarted = createWorkSessionService(process.cwd(), { filePath: join(root!, "state", "sessions", "work-sessions.json"), clock: fixedClock,
      readTask: () => linkedTask, readEvents: () => [{ type: "verification" } as TaskEvent], readRun: () => linkedRun });
    expect(restarted.snapshot().active).toHaveLength(0);
    const completed = restarted.snapshot().completed;
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      status: "completed", focused_ms: 40 * 60_000, elapsed_focused_ms: 40 * 60_000,
      result_summary: "Save flow completed and verified.", next_action: "none", notes: ["The API transition is implemented."],
      related_tasks: [{ id: "TASK-1", latest_event: "verification", verification: "passed", pull_request_url: "https://github.com/example/alpha/pull/42" }],
      related_runs: [{ id: "run-1", status: "exited", exit_code: 0 }],
    });
  });

  it("allows only one active session and preserves paused sessions when another starts", () => {
    const service = makeService();
    const first = service.start({ project_id: "alpha", objective: "Work A" });
    expect(() => service.start({ project_id: "beta", objective: "Work B" })).toThrow(WorkSessionConflictError);
    service.pause(first.id, "Resume A tomorrow");
    const second = service.start({ project_id: "beta", objective: "Work B" });
    expect(service.snapshot().active.map((session) => session.id)).toEqual([second.id]);
    expect(service.snapshot().paused.map((session) => session.id)).toEqual([first.id]);
    expect(() => service.resume(first.id)).toThrow(WorkSessionConflictError);
  });

  it("requires a discovered project and same-project existing associations", () => {
    const service = makeService({ readTask: () => linkedTask, readRun: (id) => id === "run-1" ? linkedRun : null });
    expect(() => service.start({ project_id: "missing", objective: "Test" })).toThrow(/not a discovered/);
    expect(() => service.start({ project_id: "beta", objective: "Test", related_task_ids: ["TASK-1"] })).toThrow(WorkSessionValidationError);
    expect(() => service.start({ project_id: "alpha", objective: "Test", related_run_ids: ["unknown"] })).toThrow(WorkSessionNotFoundError);
  });

  it("rejects empty required content and records explicit none consistently", () => {
    const service = makeService();
    expect(() => service.start({ project_id: "alpha", objective: "  " })).toThrow(WorkSessionValidationError);
    const session = service.start({ project_id: "alpha", objective: "Test transitions" });
    expect(() => service.pause(session.id, "  ")).toThrow(WorkSessionValidationError);
    service.pause(session.id, "Resume tests");
    service.complete(session.id, "Finished.", " NONE ");
    expect(listWorkSessions(join(root!, "state", "sessions", "work-sessions.json"))[0]?.next_action).toBe("none");
  });
});
