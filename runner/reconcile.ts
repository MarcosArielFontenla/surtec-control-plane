import { listTasks } from "../lib/state/store";
import { writeJsonAtomic } from "../lib/state/store";
import { stateDir } from "../lib/state/paths";
import { join } from "node:path";
import { PolicyService } from "../lib/policy/service";
import { canonicalPath } from "../lib/security/paths";
import type { TaskRecord } from "../lib/state/types";
import { listManagedWorktrees, type ManagedWorktree } from "./worktree";
import { assertTaskBudgetAdmissionBinding } from "../lib/state/validation";
import { types as nodeTypes } from "node:util";

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

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function managedPath(record: TaskRecord): string | null {
  const envelope = ownData(record, "envelope"), metadata = ownData(envelope, "metadata");
  const path = ownData(ownData(metadata, "run"), "worktree_path");
  return typeof path === "string" && path.length > 0 ? path : null;
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
  const snapshots = tasks();
  const knownPaths = new Set(snapshots.map(managedPath).filter((path): path is string => path !== null).map(canonicalPath));
  for (const record of snapshots) {
    try {
      assertTaskBudgetAdmissionBinding(record);
      if (Object.hasOwn(record.envelope, "budget_admission")) {
        report.errors.push("Budget-bound task remains scaffold-only; inventory does not grant recovery, execution, publication or cleanup authority.");
      }
    } catch {
      // Inventory keeps safely observed paths known even when a supplied
      // admission is invalid. Never infer a refund, replacement or deletion.
      report.errors.push("Task budget facts are invalid or unavailable; retained bytes and managed paths require inspection.");
    }
  }

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

export function reconcileStartup(repoRoot: string = process.cwd()): { worktrees: ReconciliationReport } {
  return { worktrees: reconcileOrphanWorktrees(repoRoot) };
}
