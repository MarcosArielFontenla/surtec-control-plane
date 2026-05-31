import type {
  TaskRecord, ProjectStatusOverride, OverviewModel, ProjectView, TaskView, AttentionItem,
} from "./types";
import type { PortfolioProject } from "../portfolio";

export interface RegistryProject {
  id: string;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  repo_path?: string | null;
  default_branch?: string | null;
  deploy_url?: string | null;
  railway?: { project_id: string; service_id: string; environment_id: string } | null;
}

function toTaskView(t: TaskRecord): TaskView {
  return {
    id: t.envelope.id,
    project: t.envelope.project,
    agent: t.envelope.agent,
    title: t.envelope.title,
    lifecycle: t.lifecycle,
    outcome: t.outcome,
    updated_at: t.updated_at,
    finished_at: t.finished_at,
    requires_human_approval: t.envelope.requires_human_approval,
  };
}

export function buildOverview(
  registryProjects: PortfolioProject[],
  tasks: TaskRecord[],
  overrides: ProjectStatusOverride[],
): OverviewModel {
  const overrideById = new Map(overrides.map((o) => [o.id, o]));

  const inProgress = tasks
    .filter((t) => t.lifecycle !== "finished")
    .map(toTaskView);

  const history = tasks
    .filter((t) => t.lifecycle === "finished")
    .map(toTaskView)
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));

  const projects: ProjectView[] = registryProjects.map((rp) => {
    const projTasks = tasks.filter((t) => t.envelope.project === rp.id);
    const lastActivity = projTasks.reduce<string | null>(
      (max, t) => (max === null || t.updated_at > max ? t.updated_at : max),
      null,
    );
    const ov = overrideById.get(rp.id);
    return {
      id: rp.id,
      status: rp.status,
      health: ov?.health ?? null,
      note: ov?.note ?? null,
      repo: rp.repo,
      path: rp.path ?? null,
      configured: rp.configured ?? false,
      git: rp.git ?? null,
      last_activity: lastActivity,
      task_counts: {
        inProgress: projTasks.filter((t) => t.lifecycle !== "finished").length,
        finished: projTasks.filter((t) => t.lifecycle === "finished").length,
      },
    };
  });

  const attention: AttentionItem[] = [];
  for (const t of tasks) {
    if (t.decision != null) continue; // decided tasks contribute no attention items
    // A task-level flag is raised only once: needs-review takes priority over
    // awaiting-approval (review the work before approving it). Both branches guard
    // on lifecycle === "finished" so a still-running task never surfaces here.
    const verification = t.result?.verification?.status ?? null;
    if (t.lifecycle === "finished" && t.outcome === "needs-review") {
      attention.push({ kind: "needs-review", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title, verification });
    } else if (t.lifecycle === "finished" && t.envelope.requires_human_approval) {
      attention.push({ kind: "awaiting-approval", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title, verification });
    }
    if (t.result) {
      for (const r of t.result.risks) {
        attention.push({ kind: "risk", task_id: t.envelope.id, project: t.envelope.project, title: r });
      }
      for (const b of t.result.blockers) {
        attention.push({ kind: "blocker", task_id: t.envelope.id, project: t.envelope.project, title: b });
      }
    }
  }

  return { projects, inProgress, history, attention };
}
