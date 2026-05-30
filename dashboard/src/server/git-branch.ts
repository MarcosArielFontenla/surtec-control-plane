import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class BranchError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "BranchError"; }
}

export type BranchOp = "switch" | "create";
export interface BranchListResult { branches: string[]; current: string | null }
export interface BranchOpResult { ok: boolean; output: string }

const TIMEOUT_MS = 30_000;
const TAIL_CHARS = 4000;
const NAME_RE = /^[A-Za-z0-9._/-]+$/;

// Strict, pure branch-name validator — a SAFE SUBSET of git's ref rules. Rejecting a leading "-" is what
// blocks git argument injection (e.g. "--force"/"-d") when the name is passed as an argv element.
export function validateBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.startsWith("/")) return false;
  if (name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..")) return false;
  return NAME_RE.test(name);
}

export interface GitBranchDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function resolvePath(repoRoot: string, id: string, deps: GitBranchDeps): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new BranchError(`unknown project: ${id}`, 404);
  return proj.path;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

export function listBranches(repoRoot: string, id: string, deps: GitBranchDeps = {}): BranchListResult {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const path = resolvePath(repoRoot, id, deps);
  const list = spawnSync("git", ["-C", path, "branch", "--format=%(refname:short)"], { encoding: "utf8", timeout: TIMEOUT_MS });
  const branches = list.status === 0 && !list.error
    ? asStr(list.stdout).split("\n").map((s) => s.trim()).filter(Boolean)
    : [];
  const head = spawnSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: TIMEOUT_MS });
  const cur = head.status === 0 && !head.error ? asStr(head.stdout).trim() : "";
  const current = cur && cur !== "HEAD" ? cur : null;
  return { branches, current };
}

// TAIL_CHARS is used by Task 2 (switchBranch/createBranch); declared here to keep the module self-contained.
void TAIL_CHARS;
