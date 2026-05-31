import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { listTasks } from "../../../lib/state/store";
import type { TaskRecord, ActivityItem, TaskActivity, ActivityFeed } from "../../../lib/state/types";

const TIMEOUT_MS = 10_000;

type SpawnSync = (cmd: string, args: string[], opts: object) => { status: number | null; stdout?: string; error?: Error };

export interface CommitRow { hash: string; shortHash: string; subject: string; at: string; author: string }

// Reads recent commits from a repo via read-only LOCAL git (no network). Never throws → [].
export function readRecentCommits(repoPath: string, limit = 8, spawnSync: SpawnSync = nodeSpawnSync as unknown as SpawnSync): CommitRow[] {
  const r = spawnSync("git", ["-C", repoPath, "log", "-n", String(limit), "--format=%H%x00%h%x00%s%x00%cI%x00%an"], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.status !== 0 || r.error || !r.stdout) return [];
  const out: CommitRow[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.includes("\x00")) continue;
    const [hash, shortHash, subject, at, author] = line.split("\x00");
    if (hash) out.push({ hash, shortHash: shortHash ?? "", subject: subject ?? "", at: at ?? "", author: author ?? "" });
  }
  return out;
}

// Derives ONE activity row per task at its current state (decision > lifecycle).
export function taskActivity(t: TaskRecord): TaskActivity {
  let state: string;
  let at: string;
  const d = t.decision;
  if (d && d.status === "approved") { state = "aprobada"; at = d.at; }
  else if (d && d.status === "rejected") { state = "rechazada"; at = d.at; }
  else if (t.lifecycle === "finished") { state = "hecha"; at = t.finished_at ?? t.updated_at; }
  else if (t.lifecycle === "running") { state = "en curso"; at = t.started_at ?? t.created_at; }
  else { state = "despachada"; at = t.created_at; }
  return { kind: "task", at, project: t.envelope.project, taskId: t.envelope.id, agent: t.envelope.agent, title: t.envelope.title, state };
}

interface BuildDeps {
  discover?: (root: string, ignore: string[]) => { id: string; path: string }[];
  readCommits?: (path: string, limit: number) => CommitRow[];
  listTasks?: () => TaskRecord[];
  perRepo?: number;
  cap?: number;
  root?: string;
  ignore?: string[];
}

// Merges recent commits across discovered repos + one row per task, sorted by `at` desc, capped. Never throws.
export function buildActivityFeed(repoRoot: string, deps: BuildDeps = {}): ActivityFeed {
  const discover = deps.discover ?? discoverProjects;
  const readCommits = deps.readCommits ?? ((p: string, n: number) => readRecentCommits(p, n));
  const tasks = (deps.listTasks ?? listTasks)();
  const perRepo = deps.perRepo ?? 8;
  const cap = deps.cap ?? 60;
  const root = deps.root ?? (process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot));
  const ignore = deps.ignore ?? [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

  const items: ActivityItem[] = [];
  for (const proj of discover(root, ignore)) {
    for (const c of readCommits(proj.path, perRepo)) {
      items.push({ kind: "commit", at: c.at, project: proj.id, hash: c.shortHash || c.hash, subject: c.subject, author: c.author });
    }
  }
  for (const t of tasks) items.push(taskActivity(t));
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { items: items.slice(0, cap) };
}

export interface ActivityCache { get(key: string, compute: () => ActivityFeed): ActivityFeed; invalidate(key: string): void }

export function createActivityCache(opts: { ttlMs?: number; now?: () => number } = {}): ActivityCache {
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: ActivityFeed; at: number }>();
  return {
    get(key, compute) {
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: t });
      return value;
    },
    invalidate(key) { cache.delete(key); },
  };
}
