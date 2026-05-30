import { spawnSync as nodeSpawnSync } from "node:child_process";
import { loadRegistryProjects } from "./registry";
import { githubRepoSlug } from "../../../lib/github-url";

export class GithubError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GithubError"; }
}

export interface GithubCounts { ok: boolean; prs: number; issues: number; error?: string }

export type CiState = "passing" | "failing" | "running" | "none" | "unknown";
export interface GithubOverview { ok: boolean; prs: number; issues: number; ci: CiState; error?: string }

const TIMEOUT_MS = 20_000;
const TAIL_CHARS = 2000;

interface SpawnDep {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}
interface ResolveDeps {
  loadRegistry?: (repoRoot: string) => { id: string; repo: string | null }[];
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

// Reads open PR + issue counts for an EXPLICIT "owner/repo" slug via read-only gh (fixed argv, no shell,
// `-R slug` so gh never infers a fork's upstream from local remotes). Never throws — gh failures
// (missing/unauth/non-github/disabled-issues/bad-output) yield { ok:false, error }.
export function readGithubCounts(slug: string, deps: SpawnDep = {}): GithubCounts {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const pr = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (pr.status !== 0 || pr.error) return { ok: false, prs: 0, issues: 0, error: ghErr(pr) };
  const iss = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (iss.status !== 0 || iss.error) return { ok: false, prs: 0, issues: 0, error: ghErr(iss) };
  try {
    return { ok: true, prs: countOf(pr.stdout), issues: countOf(iss.stdout) };
  } catch {
    return { ok: false, prs: 0, issues: 0, error: "bad gh output" };
  }
}

// Reads the latest CI run state on a branch via read-only gh. Never throws — any failure → "unknown".
export function readCiStatus(slug: string, branch: string, deps: SpawnDep = {}): { state: CiState } {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const r = spawnSync("gh", ["run", "list", "--branch", branch, "--limit", "1", "--json", "status,conclusion", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.status !== 0 || r.error) return { state: "unknown" };
  let arr: { status?: string; conclusion?: string | null }[];
  try {
    const parsed = JSON.parse(asStr(r.stdout));
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { state: "unknown" };
  }
  if (arr.length === 0) return { state: "none" };
  const run = arr[0];
  if (run.status === "completed") return { state: run.conclusion === "success" ? "passing" : "failing" };
  return { state: "running" };
}

// Resolves a project id to its GitHub "owner/repo" slug FROM THE TRUSTED REGISTRY (the configured repo,
// e.g. origin — never a fork's upstream). Throws GithubError(404) for an unknown id; returns null when the
// project exists but is not a GitHub repo.
export function resolveRepoSlug(repoRoot: string, id: string, deps: ResolveDeps = {}): string | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new GithubError(`unknown project: ${id}`, 404);
  return githubRepoSlug(proj.repo);
}

export interface GithubCache { get(slug: string): GithubCounts; invalidate(slug: string): void }

export function createGithubCache(opts: {
  read?: (slug: string) => GithubCounts; ttlMs?: number; now?: () => number;
} = {}): GithubCache {
  const read = opts.read ?? ((slug: string) => readGithubCounts(slug));
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: GithubCounts; at: number }>();
  return {
    get(slug: string): GithubCounts {
      const hit = cache.get(slug);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = read(slug);
      cache.set(slug, { value, at: t });
      return value;
    },
    invalidate(slug: string): void {
      cache.delete(slug);
    },
  };
}
