import { listTasks, writeTask } from "../lib/state/store";
import { writeJsonAtomic } from "../lib/state/store";
import { stateDir } from "../lib/state/paths";
import { join } from "node:path";
import { PolicyService } from "../lib/policy/service";
import { canonicalPath } from "../lib/security/paths";
import type { TaskRecord } from "../lib/state/types";
import { listManagedWorktrees, type ManagedWorktree } from "./worktree";
import { failureResult } from "./result";

export interface OrphanWorktree {
  project: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
}

export interface ReconciliationReport {
  at: string;
  orphans: OrphanWorktree[];
  errors: string[];
}

interface ReconciliationDependencies {
  tasks?: () => TaskRecord[];
  projects?: () => { id: string; repo_path: string | null }[];
  worktrees?: (repoPath: string) => ManagedWorktree[];
  reportPath?: string;
  now?: () => string;
}

export function reconcileRunning(): number {
  let n = 0;
  for (const rec of listTasks()) {
    if (rec.lifecycle !== "running") continue;
    const end = new Date().toISOString();
    rec.lifecycle = "finished";
    rec.finished_at = end;
    rec.updated_at = end;
    rec.outcome = "failed";
    rec.result = failureResult(rec.envelope, "interrupted by server restart", rec.logs_path ?? "");
    writeTask(rec);
    n++;
  }
  return n;
}

export function reconcileOrphanWorktrees(
  repoRoot: string = process.cwd(),
  dependencies: ReconciliationDependencies = {},
): ReconciliationReport {
  const tasks = dependencies.tasks ?? listTasks;
  const projects = dependencies.projects ?? (() => new PolicyService(repoRoot).listProjects());
  const worktrees = dependencies.worktrees ?? listManagedWorktrees;
  const report: ReconciliationReport = {
    at: (dependencies.now ?? (() => new Date().toISOString()))(),
    orphans: [],
    errors: [],
  };
  const knownPaths = new Set(
    tasks()
      .map((record) => (record.envelope.metadata?.run as { worktree_path?: unknown } | undefined)?.worktree_path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map(canonicalPath),
  );

  try {
    for (const project of projects()) {
      if (!project.repo_path) continue;
      try {
        for (const item of worktrees(project.repo_path)) {
          if (knownPaths.has(canonicalPath(item.worktreePath))) continue;
          report.orphans.push({
            project: project.id,
            repo_path: project.repo_path,
            worktree_path: item.worktreePath,
            branch: item.branch,
          });
        }
      } catch (error) {
        report.errors.push(`${project.id}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    report.errors.push(`registry: ${(error as Error).message}`);
  }

  writeJsonAtomic(dependencies.reportPath ?? join(stateDir(), "reconciliation", "orphan-worktrees.json"), report);
  return report;
}

export function reconcileStartup(repoRoot: string = process.cwd()): { interrupted: number; worktrees: ReconciliationReport } {
  return {
    interrupted: reconcileRunning(),
    worktrees: reconcileOrphanWorktrees(repoRoot),
  };
}
