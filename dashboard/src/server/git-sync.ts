import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class GitSyncError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GitSyncError"; }
}

export type GitAction = "fetch" | "pull" | "push";
export interface GitSyncResult { ok: boolean; action: GitAction; output: string }

const ARGV: Record<GitAction, (path: string) => string[]> = {
  fetch: (p) => ["-C", p, "fetch"],
  pull: (p) => ["-C", p, "pull", "--ff-only"],
  push: (p) => ["-C", p, "push"],
};

const TIMEOUT_MS = 60_000;
const TAIL_CHARS = 4000;

interface GitSyncDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

// Runs a fixed git command (fetch / pull --ff-only / push) on a discovered project's MAIN checkout.
// The action is validated against a 3-value allowlist; the path is resolved server-side via discovery
// (never a client path). A failed git is a result (ok:false), NOT a thrown error — only an invalid action
// (400) or unknown project (404) throw a typed GitSyncError.
export function runGitSync(repoRoot: string, id: string, action: string, deps: GitSyncDeps = {}): GitSyncResult {
  if (!Object.prototype.hasOwnProperty.call(ARGV, action)) {
    throw new GitSyncError(`invalid action: ${action}`, 400);
  }
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new GitSyncError(`unknown project: ${id}`, 404);

  const act = action as GitAction;
  const r = spawnSync("git", ARGV[act](proj.path), { encoding: "utf8", timeout: TIMEOUT_MS });
  const ok = r.status === 0 && !r.error;
  const stdout = typeof r.stdout === "string" ? r.stdout : (r.stdout as Buffer | null)?.toString() ?? "";
  const stderr = typeof r.stderr === "string" ? r.stderr : (r.stderr as Buffer | null)?.toString() ?? "";
  const output = (stdout + stderr + (r.error ? r.error.message : "")).trim().slice(-TAIL_CHARS);
  return { ok, action: act, output };
}
