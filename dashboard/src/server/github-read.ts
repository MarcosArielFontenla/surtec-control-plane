import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class GithubError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GithubError"; }
}

export interface GithubCounts { ok: boolean; prs: number; issues: number; error?: string }

const TIMEOUT_MS = 20_000;
const TAIL_CHARS = 2000;

interface SpawnDep {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}
interface ResolveDeps {
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

function ghErr(r: { stdout?: string | Buffer; stderr?: string | Buffer; error?: Error }): string {
  return (asStr(r.stderr) + asStr(r.stdout) + (r.error ? r.error.message : "")).trim().slice(-TAIL_CHARS);
}

function countOf(stdout: string | Buffer | undefined): number {
  const arr = JSON.parse(asStr(stdout)); // throws on bad JSON
  return Array.isArray(arr) ? arr.length : 0;
}

// Reads open PR + issue counts for a repo via read-only gh (fixed argv, no shell, cwd = repo path).
// Never throws — gh failures (missing/unauth/non-github/disabled-issues/bad-output) yield { ok:false, error }.
export function readGithubCountsAtPath(path: string, deps: SpawnDep = {}): GithubCounts {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const pr = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (pr.status !== 0 || pr.error) return { ok: false, prs: 0, issues: 0, error: ghErr(pr) };
  const iss = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (iss.status !== 0 || iss.error) return { ok: false, prs: 0, issues: 0, error: ghErr(iss) };
  try {
    return { ok: true, prs: countOf(pr.stdout), issues: countOf(iss.stdout) };
  } catch {
    return { ok: false, prs: 0, issues: 0, error: "bad gh output" };
  }
}

export function resolveRepoPath(repoRoot: string, id: string, deps: ResolveDeps = {}): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new GithubError(`unknown project: ${id}`, 404);
  return proj.path;
}
