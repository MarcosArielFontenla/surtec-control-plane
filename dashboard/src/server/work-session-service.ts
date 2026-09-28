import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { readGitStatus } from "../../../lib/git-status";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { readTaskEvents } from "../../../lib/state/events";
import { workSessionsPath } from "../../../lib/state/paths";
import { listWorkSessions, mutateWorkSessions, type WorkSessionsDocument } from "../../../lib/state/work-sessions";
import { readTask } from "../../../lib/state/store";
import type {
  RunRecord, TaskRecord, TodayWorkSessionState, WorkSession, WorkSessionRunEvidence, WorkSessionTaskEvidence, WorkSessionView,
} from "../../../lib/state/types";

const MAX_FOCUSED_MS = 31_536_000_000;

export class WorkSessionError extends Error {}
export class WorkSessionValidationError extends WorkSessionError {}
export class WorkSessionProjectNotFoundError extends WorkSessionError {}
export class WorkSessionNotFoundError extends WorkSessionError {}
export class WorkSessionConflictError extends WorkSessionError {}
export class WorkSessionTransitionError extends WorkSessionError {}

export interface WorkSessionStartInput {
  project_id: string;
  objective: string;
  related_task_ids?: string[];
  related_run_ids?: string[];
}

export type WorkSessionActionInput =
  | { action: "add-note"; note: string }
  | { action: "associate"; task_ids?: string[]; run_ids?: string[] }
  | { action: "pause"; next_action: string }
  | { action: "resume" }
  | { action: "complete"; result_summary: string; next_action: string };

export type WorkSessionService = ReturnType<typeof createWorkSessionService>;

export interface WorkSessionServiceDependencies {
  filePath?: string;
  clock?: () => Date;
  resolveProject?: (projectId: string) => { branch: string | null } | null;
  readTask?: (taskId: string) => TaskRecord | null;
  readEvents?: (taskId: string) => ReturnType<typeof readTaskEvents>;
  readRun?: (runId: string) => RunRecord | null;
}

function resolveDiscoveredProject(repoRoot: string, projectId: string): { branch: string | null } | null {
  const projectsRoot = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((name) => name.trim()).filter(Boolean)];
  const project = discoverProjects(projectsRoot, ignore).find((candidate) => candidate.id === projectId);
  if (!project) return null;
  try {
    return { branch: readGitStatus(project.path).branch };
  } catch {
    return { branch: null };
  }
}

function normalizeRequiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new WorkSessionValidationError(`${label} is required and must be at most ${maximum} characters`);
  return normalized;
}

function normalizeNextAction(value: string): string {
  const normalized = normalizeRequiredText(value, "next action", 1000);
  return normalized.toLowerCase() === "none" ? "none" : normalized;
}

function validateIds(ids: string[] = [], label: string): string[] {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length || unique.some((id) => !isSafeIdentifier(id))) {
    throw new WorkSessionValidationError(`${label} must contain unique safe identifiers`);
  }
  if (unique.length > 100) throw new WorkSessionValidationError(`${label} cannot contain more than 100 identifiers`);
  return unique;
}

function safePullRequestUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    return /^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,12}$/.test(url.pathname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function taskEvidence(session: WorkSession, read: (id: string) => TaskRecord | null, readEvents: WorkSessionServiceDependencies["readEvents"]): WorkSessionTaskEvidence[] {
  return session.related_task_ids.map((id) => {
    const task = read(id);
    if (!task || task.envelope.project !== session.project_id) {
      return { id, available: false, title: null, lifecycle: null, outcome: null, latest_event: null, verification: null, pull_request_url: null };
    }
    let latestEvent: WorkSessionTaskEvidence["latest_event"] = null;
    try { latestEvent = readEvents?.(id).at(-1)?.type ?? null; } catch { /* Keep the rest of the resume evidence visible. */ }
    return {
      id,
      available: true,
      title: task.envelope.title,
      lifecycle: task.lifecycle,
      outcome: task.outcome,
      latest_event: latestEvent,
      verification: task.result?.verification?.status ?? null,
      pull_request_url: safePullRequestUrl(task.decision?.pr_url),
    };
  });
}

function runEvidence(session: WorkSession, read: (id: string) => RunRecord | null): WorkSessionRunEvidence[] {
  return session.related_run_ids.map((id) => {
    const run = read(id);
    if (!run || run.projectId !== session.project_id) {
      return { id, kind: null, status: "unavailable", started_at: null, exit_code: null };
    }
    return { id, kind: run.kind, status: run.status, started_at: run.startedAt, exit_code: run.exitCode };
  });
}

function viewSession(
  session: WorkSession,
  now: Date,
  readTaskRecord: (id: string) => TaskRecord | null,
  readEvents: WorkSessionServiceDependencies["readEvents"],
  readRun: (id: string) => RunRecord | null,
): WorkSessionView {
  const activeSince = session.status === "active" && session.active_since ? Date.parse(session.active_since) : Number.NaN;
  const activeElapsed = Number.isFinite(activeSince) ? Math.max(0, now.getTime() - activeSince) : 0;
  return {
    ...session,
    elapsed_focused_ms: Math.min(MAX_FOCUSED_MS, session.focused_ms + activeElapsed),
    related_tasks: taskEvidence(session, readTaskRecord, readEvents),
    related_runs: runEvidence(session, readRun),
  };
}

export function createWorkSessionService(repoRoot: string = process.cwd(), dependencies: WorkSessionServiceDependencies = {}) {
  const filePath = dependencies.filePath ?? workSessionsPath();
  const clock = dependencies.clock ?? (() => new Date());
  const resolveProject = dependencies.resolveProject ?? ((id: string) => resolveDiscoveredProject(repoRoot, id));
  const readTaskRecord = dependencies.readTask ?? readTask;
  const readEvents = dependencies.readEvents ?? readTaskEvents;
  const readRun = dependencies.readRun ?? (() => null);

  const snapshot = (): TodayWorkSessionState => {
    const now = clock();
    const sessions = listWorkSessions(filePath).map((session) => viewSession(session, now, readTaskRecord, readEvents, readRun));
    return {
      available: true,
      unavailable_reason: null,
      active: sessions.filter((session) => session.status === "active"),
      paused: sessions.filter((session) => session.status === "paused").sort((left, right) => right.paused_at!.localeCompare(left.paused_at!)),
      completed: sessions.filter((session) => session.status === "completed")
        .sort((left, right) => right.completed_at!.localeCompare(left.completed_at!)).slice(0, 5),
    };
  };

  const requireSession = (document: WorkSessionsDocument, id: string): WorkSession => {
    const session = document.sessions.find((entry) => entry.id === id);
    if (!session) throw new WorkSessionNotFoundError("work session not found");
    return session;
  };

  const update = <T>(id: string, mutate: (session: WorkSession) => T): T => {
    if (!isSafeIdentifier(id)) throw new WorkSessionValidationError("invalid work session ID");
    return mutateWorkSessions((document) => mutate(requireSession(document, id)), filePath);
  };

  const validateAssociations = (projectId: string, taskIds: string[], runIds: string[]) => {
    const tasks = validateIds(taskIds, "task IDs");
    const runs = validateIds(runIds, "process IDs");
    for (const taskId of tasks) {
      const task = readTaskRecord(taskId);
      if (!task) throw new WorkSessionNotFoundError(`related task not found: ${taskId}`);
      if (task.envelope.project !== projectId) throw new WorkSessionValidationError(`related task belongs to another project: ${taskId}`);
    }
    for (const runId of runs) {
      const run = readRun(runId);
      if (!run) throw new WorkSessionNotFoundError(`related process not found: ${runId}`);
      if (run.projectId !== projectId) throw new WorkSessionValidationError(`related process belongs to another project: ${runId}`);
    }
    return { tasks, runs };
  };

  return {
    snapshot,
    start(input: WorkSessionStartInput): WorkSession {
      if (!isSafeIdentifier(input.project_id)) throw new WorkSessionValidationError("invalid project ID");
      const objective = normalizeRequiredText(input.objective, "objective", 2000);
      const project = resolveProject(input.project_id);
      if (!project) throw new WorkSessionProjectNotFoundError("project is not a discovered local repository");
      const { tasks, runs } = validateAssociations(input.project_id, input.related_task_ids ?? [], input.related_run_ids ?? []);
      const now = clock().toISOString();

      return mutateWorkSessions((document) => {
        if (document.sessions.some((session) => session.status === "active")) {
          throw new WorkSessionConflictError("another work session is already active; pause or complete it first");
        }
        const session: WorkSession = {
          schema_version: 1,
          id: `ws_${randomUUID()}`,
          project_id: input.project_id,
          objective,
          status: "active",
          branch: typeof project.branch === "string" && project.branch.length <= 255 ? project.branch : null,
          started_at: now,
          paused_at: null,
          completed_at: null,
          related_task_ids: tasks,
          related_run_ids: runs,
          notes: [],
          result_summary: null,
          next_action: null,
          focused_ms: 0,
          active_since: now,
        };
        document.sessions.push(session);
        return session;
      }, filePath);
    },
    addNote(id: string, note: string): WorkSession {
      const normalized = normalizeRequiredText(note, "note", 2000);
      return update(id, (session) => {
        if (session.status === "completed") throw new WorkSessionTransitionError("completed sessions cannot be changed");
        if (session.notes.length >= 100) throw new WorkSessionConflictError("work session note limit reached");
        session.notes.push(normalized);
        return session;
      });
    },
    associate(id: string, taskIds: string[] = [], runIds: string[] = []): WorkSession {
      if (taskIds.length === 0 && runIds.length === 0) throw new WorkSessionValidationError("associate at least one task or process");
      const session = listWorkSessions(filePath).find((entry) => entry.id === id);
      if (!session) throw new WorkSessionNotFoundError("work session not found");
      const { tasks, runs } = validateAssociations(session.project_id, taskIds, runIds);
      return update(id, (current) => {
        if (current.status === "completed") throw new WorkSessionTransitionError("completed sessions cannot be changed");
        current.related_task_ids = [...new Set([...current.related_task_ids, ...tasks])];
        current.related_run_ids = [...new Set([...current.related_run_ids, ...runs])];
        if (current.related_task_ids.length > 100 || current.related_run_ids.length > 100) throw new WorkSessionConflictError("work session association limit reached");
        return current;
      });
    },
    pause(id: string, nextAction: string): WorkSession {
      const action = normalizeNextAction(nextAction);
      return update(id, (session) => {
        if (session.status !== "active" || !session.active_since) throw new WorkSessionTransitionError("only an active session can be paused");
        const now = clock();
        session.focused_ms = Math.min(MAX_FOCUSED_MS, session.focused_ms + Math.max(0, now.getTime() - Date.parse(session.active_since)));
        session.status = "paused";
        session.active_since = null;
        session.paused_at = now.toISOString();
        session.next_action = action;
        return session;
      });
    },
    resume(id: string): WorkSession {
      return update(id, (session) => {
        if (session.status !== "paused") throw new WorkSessionTransitionError("only a paused session can be resumed");
        if (listWorkSessions(filePath).some((other) => other.id !== id && other.status === "active")) {
          throw new WorkSessionConflictError("another work session is already active; pause or complete it first");
        }
        session.status = "active";
        session.active_since = clock().toISOString();
        session.paused_at = null;
        return session;
      });
    },
    complete(id: string, resultSummary: string, nextAction: string): WorkSession {
      const summary = normalizeRequiredText(resultSummary, "result summary", 2000);
      const action = normalizeNextAction(nextAction);
      return update(id, (session) => {
        if (session.status === "completed") throw new WorkSessionTransitionError("session is already completed");
        const now = clock();
        if (session.status === "active" && session.active_since) {
          session.focused_ms = Math.min(MAX_FOCUSED_MS, session.focused_ms + Math.max(0, now.getTime() - Date.parse(session.active_since)));
        }
        session.status = "completed";
        session.active_since = null;
        session.paused_at = null;
        session.completed_at = now.toISOString();
        session.result_summary = summary;
        session.next_action = action;
        return session;
      });
    },
  };
}
