import { spawnSync as nodeSpawnSync } from "node:child_process";
import { loadRegistryProjects } from "./registry";
import { githubRepoSlug } from "../../../lib/github-url";
import { githubCliEnvironment } from "../../../lib/security/environment";
import { redactText } from "../../../lib/security/redaction";

export class GithubError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "GithubError"; }
}

export interface GithubPullRequestAction {
  number: number;
  updatedAt: string;
  reviewDecision: "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "APPROVED" | "UNKNOWN";
}
export interface GithubCounts { ok: boolean; prs: number; issues: number; waitingPullRequests?: GithubPullRequestAction[]; error?: string }

export type CiState = "passing" | "failing" | "running" | "none" | "unknown";
export interface GithubOverview { ok: boolean; prs: number; issues: number; ci: CiState; error?: string }

const TIMEOUT_MS = 20_000;
const TAIL_CHARS = 2000;

interface SpawnDep {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}
interface ResolveDeps {
  loadRegistry?: (repoRoot: string) => { id: string; repo: string | null; default_branch?: string | null }[];
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

function ghErr(r: { stdout?: string | Buffer; stderr?: string | Buffer; error?: Error }): string {
  return redactText((asStr(r.stderr) + asStr(r.stdout) + (r.error ? r.error.message : "")).trim()).slice(-TAIL_CHARS);
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
  const pr = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,updatedAt,reviewDecision", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS, env: githubCliEnvironment() });
  if (pr.status !== 0 || pr.error) return { ok: false, prs: 0, issues: 0, error: ghErr(pr) };
  const iss = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS, env: githubCliEnvironment() });
  if (iss.status !== 0 || iss.error) return { ok: false, prs: 0, issues: 0, error: ghErr(iss) };
  try {
    const parsedPullRequests = JSON.parse(asStr(pr.stdout)) as { number?: number; updatedAt?: string; reviewDecision?: string | null }[];
    const waitingPullRequests = (Array.isArray(parsedPullRequests) ? parsedPullRequests : [])
      .filter((item) => item.reviewDecision === "CHANGES_REQUESTED" || item.reviewDecision === "REVIEW_REQUIRED")
      .slice(0, 100)
      .map((item) => ({
        number: Number.isInteger(item.number) ? item.number! : 0,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt.slice(0, 100) : "",
        reviewDecision: item.reviewDecision as GithubPullRequestAction["reviewDecision"],
      }))
      .filter((item) => item.number > 0 && Boolean(item.updatedAt));
    return { ok: true, prs: countOf(pr.stdout), issues: countOf(iss.stdout), waitingPullRequests };
  } catch {
    return { ok: false, prs: 0, issues: 0, error: "bad gh output" };
  }
}

// Reads the latest CI run state on a branch via read-only gh. Never throws — any failure → "unknown".
export function readCiStatus(slug: string, branch: string, deps: SpawnDep = {}): { state: CiState; startedAt?: string | null; runId?: string | null; updatedAt?: string | null } {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const r = spawnSync("gh", ["run", "list", "--branch", branch, "--limit", "1", "--json", "status,conclusion,startedAt,databaseId,updatedAt", "-R", slug], { encoding: "utf8", timeout: TIMEOUT_MS, env: githubCliEnvironment() });
  if (r.status !== 0 || r.error) return { state: "unknown" };
  let arr: { status?: string; conclusion?: string | null; startedAt?: string | null; databaseId?: number | null; updatedAt?: string | null }[];
  try {
    const parsed = JSON.parse(asStr(r.stdout));
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { state: "unknown" };
  }
  if (arr.length === 0) return { state: "none" };
  const run = arr[0];
  const runId = Number.isSafeInteger(run.databaseId) && Number(run.databaseId) > 0 ? String(run.databaseId) : undefined;
  const updatedAt = typeof run.updatedAt === "string" ? run.updatedAt.slice(0, 100) : undefined;
  const identity = { ...(runId ? { runId } : {}), ...(updatedAt ? { updatedAt } : {}) };
  if (run.status === "completed") return { state: run.conclusion === "success" ? "passing" : "failing", ...identity };
  return { state: "running", startedAt: typeof run.startedAt === "string" ? run.startedAt.slice(0, 100) : null, ...identity };
}

// Resolves a project id to its GitHub { slug, branch } FROM THE TRUSTED REGISTRY (the configured repo +
// default branch — never a fork's upstream). Throws GithubError(404) for an unknown id; returns null when
// the project exists but is not a GitHub repo.
export function resolveRepoRef(repoRoot: string, id: string, deps: ResolveDeps = {}): { slug: string; branch: string } | null {
  const load = deps.loadRegistry ?? loadRegistryProjects;
  const proj = load(repoRoot).find((p) => p.id === id);
  if (!proj) throw new GithubError(`unknown project: ${id}`, 404);
  const slug = githubRepoSlug(proj.repo);
  if (!slug) return null;
  return { slug, branch: proj.default_branch ?? "main" };
}

export interface GithubCache { get(key: string, compute: () => GithubOverview): GithubOverview; invalidate(key: string): void }

export function createGithubCache(opts: { ttlMs?: number; now?: () => number } = {}): GithubCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: GithubOverview; at: number }>();
  return {
    get(key: string, compute: () => GithubOverview): GithubOverview {
      const hit = cache.get(key);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = compute();
      cache.set(key, { value, at: t });
      return value;
    },
    invalidate(key: string): void {
      cache.delete(key);
    },
  };
}
