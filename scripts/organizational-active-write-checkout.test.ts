import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localGitEnvironment } from "../lib/security/environment";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { readTaskEvents } from "../lib/state/events";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { tasksDir } from "../lib/state/paths";
import { readTask, updateTask, writeTask } from "../lib/state/store";
import type { SandboxMode, TaskRecord } from "../lib/state/types";
import type { TaskRunCompletion, TaskRunOptions } from "../runner/run-task";
import { TaskOrchestrator } from "../runner/task-orchestrator";
import { createWorktree, listManagedWorktrees, managedWorktreeIdentity, removeWorktree, type WorktreeInfo } from "../runner/worktree";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject } from "./testing/role-policy-fixture";

const gitFixture = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../lib/security/managed-git.mjs", async (original) => {
  const actual = await original<typeof import("../lib/security/managed-git.mjs")>();
  return {
    ...actual,
    managedGitArgs(args: string[]) {
      if (!gitFixture.root) throw new Error("Managed Git requires the owned EVAL root.");
      return actual.managedGitArgs(args, gitFixture.root);
    },
  };
});

const writerAId = "T-write-a";
const writerBId = "T-write-b";
const readerId = "T-read";
const nowMs = Date.parse("2026-10-01T12:00:00.000Z");
const now = () => new Date(nowMs);
type Fixture = ReturnType<typeof createRolePolicyFixture>;

function git(fixture: Fixture, ...args: string[]): string {
  return execFileSync("git", managedGitArgs([
    "--no-optional-locks", "-C", fixture.checkout, "-c", "user.name=Surtec EVAL",
    "-c", "user.email=eval@example.invalid", "-c", "commit.gpgSign=false",
    "-c", "core.autocrlf=false", ...args,
  ]), {
    env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(fixture.root, "empty-git-config") },
    encoding: "utf8", windowsHide: true,
  }).trim();
}

function queuedTask(fixture: Fixture, id: string, sandbox: SandboxMode, order: number): TaskRecord {
  const createdAt = new Date(nowMs - 3_000 + order).toISOString();
  return {
    envelope: {
      id, source: "dashboard", project: roleFixtureProject, agent: roleFixtureAgent,
      task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
      title: id, instructions: "Inspect the disposable checkout.", repo_path: fixture.checkout,
      branch: `agent/${id}`, sandbox, expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null, created_at: createdAt, updated_at: createdAt,
    started_at: null, finished_at: null, result: null, logs_path: null, revision: 1,
    orchestration: defaultTaskOrchestration(),
  };
}

interface Attempt {
  taskId: string;
  workerId: string;
  runId: string;
  checkout: WorktreeInfo | null;
  release: () => void;
}

function controlledAttempts(fixture: Fixture) {
  const started: Attempt[] = [];
  const terminalized: string[] = [];
  async function runAttempt(taskId: string, { runId, workerId }: TaskRunOptions): Promise<TaskRunCompletion> {
    const task = readTask(taskId);
    const lease = task?.orchestration?.lease;
    if (!task || task.lifecycle !== "running" || !runId || !workerId || lease?.run_id !== runId
      || lease.worker_id !== workerId || Date.parse(lease.expires_at) <= nowMs
      || task.envelope.project !== roleFixtureProject || task.envelope.repo_path !== fixture.checkout) {
      throw new Error("Fixture attempt does not own the expected project lease.");
    }
    const checkout = task.envelope.sandbox === "workspace-write"
      ? createWorktree(fixture.checkout, taskId, task.envelope.agent)
      : null;
    await new Promise<void>((release) => { started.push({ taskId, workerId, runId, checkout, release }); });
    const finished = updateTask(taskId, (record) => {
      if (!record.orchestration || record.lifecycle !== "running" || record.orchestration.lease?.run_id !== runId
        || record.orchestration.lease.worker_id !== workerId) {
        throw new Error("Fixture attempt lost its lease before terminalization.");
      }
      record.lifecycle = "finished";
      record.outcome = "completed";
      record.finished_at = now().toISOString();
      record.updated_at = record.finished_at;
      record.orchestration.lease = null;
    });
    if (!finished) throw new Error("Fixture task disappeared before terminalization.");
    terminalized.push(taskId);
    return { outcome: "completed", retryable: false, stale: false };
  }
  return { started, terminalized, runAttempt };
}

function expectActive(attempt: Attempt, taskId: string, worker: TaskOrchestrator, checkout: WorktreeInfo | null) {
  expect(attempt).toMatchObject({ taskId, workerId: worker.workerId, checkout });
  const task = readTask(taskId);
  expect(task).toMatchObject({
    lifecycle: "running",
    orchestration: { attempts: 1, lease: { run_id: attempt.runId, worker_id: worker.workerId } },
  });
  expect(Date.parse(task!.orchestration!.lease!.expires_at)).toBeGreaterThan(nowMs);
  expect(readTaskEvents(taskId)).toMatchObject([
    { type: "claimed", task_id: taskId, run_id: attempt.runId, attempt: 1, payload: { worker_id: worker.workerId } },
  ]);
}

describe("org.execution.active-write-checkout", () => {
  it("serializes same-project write checkouts across ticks and workers with spare capacity", async () => {
    const fixture = createRolePolicyFixture({ sandbox: "workspace-write" });
    const attempts = controlledAttempts(fixture);
    const options = { repoRoot: fixture.root, maxConcurrent: 3, now, runAttempt: attempts.runAttempt };
    const workerA = new TaskOrchestrator({ ...options, workerId: "eval-worker-a" });
    const workerB = new TaskOrchestrator({ ...options, workerId: "eval-worker-b" });
    let trees: WorktreeInfo[] = [];
    try {
      gitFixture.root = fixture.root;
      for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
      git(fixture, "init", "--template=", "-b", "main");
      git(fixture, "add", "--", "AGENTS.md");
      git(fixture, "commit", "-m", "Synthetic baseline");
      const head = git(fixture, "rev-parse", "HEAD");
      const sourceStatus = git(fixture, "status", "--porcelain=v1", "--branch");
      expect(sourceStatus).toBe("## main");
      expect(git(fixture, "remote")).toBe("");
      const sourcePath = join(fixture.checkout, "AGENTS.md");
      const sourceBytes = readFileSync(sourcePath);
      const firstTree = managedWorktreeIdentity(fixture.checkout, writerAId, roleFixtureAgent);
      const secondTree = managedWorktreeIdentity(fixture.checkout, writerBId, roleFixtureAgent);
      trees = [firstTree, secondTree];

      writeTask(queuedTask(fixture, writerAId, "workspace-write", 0));
      writeTask(queuedTask(fixture, writerBId, "workspace-write", 1));
      writeTask(queuedTask(fixture, readerId, "read-only", 2));
      const secondTaskPath = join(tasksDir(fixture.state), `${writerBId}.json`);
      const queuedBytes = readFileSync(secondTaskPath);

      expect(await workerA.runOnce()).toBe(2);
      expect(workerA.activeCount).toBe(2);
      expect(attempts.started).toHaveLength(2);
      const [first, reader] = attempts.started;
      expectActive(first!, writerAId, workerA, firstTree);
      expectActive(reader!, readerId, workerA, null);
      expect(listManagedWorktrees(fixture.checkout)).toEqual([firstTree]);
      expect(readTask(writerBId)).toMatchObject({ lifecycle: "queued", orchestration: { attempts: 0, lease: null } });
      expect(readFileSync(secondTaskPath)).toEqual(queuedBytes);
      expect(readTaskEvents(writerBId)).toEqual([]);
      expect(existsSync(secondTree.worktreePath)).toBe(false);
      expect(git(fixture, "branch", "--list", secondTree.branch)).toBe("");

      expect(workerB.activeCount).toBe(0);
      expect(await workerB.runOnce()).toBe(0);
      expect(workerB.activeCount).toBe(0);
      expectActive(first!, writerAId, workerA, firstTree);
      expect(attempts.started).toHaveLength(2);
      expect(readFileSync(secondTaskPath)).toEqual(queuedBytes);
      expect(readTaskEvents(writerBId)).toEqual([]);
      expect(listManagedWorktrees(fixture.checkout)).toEqual([firstTree]);
      expect(existsSync(secondTree.worktreePath)).toBe(false);
      expect(git(fixture, "branch", "--list", secondTree.branch)).toBe("");

      first!.release();
      reader!.release();
      await workerA.stop();
      expect(workerA.activeCount).toBe(0);
      expect(attempts.terminalized).toEqual([writerAId, readerId]);
      expect(readTask(writerAId)).toMatchObject({ lifecycle: "finished", outcome: "completed", orchestration: { lease: null } });
      expect(listManagedWorktrees(fixture.checkout)).toEqual([firstTree]);

      expect(await workerB.runOnce()).toBe(1);
      expect(workerB.activeCount).toBe(1);
      expect(attempts.started).toHaveLength(3);
      const second = attempts.started[2]!;
      expectActive(second, writerBId, workerB, secondTree);
      expect(second.runId).not.toBe(first!.runId);
      expect(secondTree.worktreePath).not.toBe(firstTree.worktreePath);
      expect(secondTree.branch).not.toBe(firstTree.branch);
      expect(listManagedWorktrees(fixture.checkout).sort((a, b) => a.branch.localeCompare(b.branch))).toEqual(trees);
      expect(git(fixture, "rev-parse", "HEAD")).toBe(head);
      expect(git(fixture, "status", "--porcelain=v1", "--branch")).toBe(sourceStatus);
      expect(readFileSync(sourcePath)).toEqual(sourceBytes);

      second.release();
      await workerB.stop();
      expect(workerB.activeCount).toBe(0);
      expect(attempts.terminalized).toEqual([writerAId, readerId, writerBId]);
      expect(readTask(writerBId)).toMatchObject({ lifecycle: "finished", outcome: "completed", orchestration: { lease: null } });
    } finally {
      try {
        for (const attempt of attempts.started) attempt.release();
        await Promise.all([workerA.stop(), workerB.stop()]);
        if (trees.length) {
          for (const tree of trees) removeWorktree(fixture.checkout, tree.worktreePath, tree.branch);
          expect(trees.every((tree) => !existsSync(tree.worktreePath))).toBe(true);
          expect(listManagedWorktrees(fixture.checkout)).toEqual([]);
          expect(git(fixture, "branch", "--list", "agent/*")).toBe("");
        }
      } finally {
        vi.unstubAllEnvs();
        gitFixture.root = undefined;
        fixture.dispose();
      }
    }
  });
});
