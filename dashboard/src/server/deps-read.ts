import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class DepsError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "DepsError"; }
}

export interface DepsStatus { ok: boolean; outdated: number; error?: string }

const TIMEOUT_MS = 60_000;

interface DepsDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  exists?: (p: string) => boolean;
}
interface ResolveDeps {
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

// Counts outdated npm deps via read-only `npm outdated --json` (cwd = repo path). Requires node_modules for a
// meaningful count. Never throws — missing pkg / node_modules / npm error / bad output → { ok:false, error }.
export function readDepsStatus(path: string, deps: DepsDeps = {}): DepsStatus {
  const exists = deps.exists ?? existsSync;
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  if (!exists(join(path, "package.json"))) return { ok: false, outdated: 0, error: "sin package.json" };
  if (!exists(join(path, "node_modules"))) return { ok: false, outdated: 0, error: "n/a (npm install)" };
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npmCmd, ["outdated", "--json"], { cwd: path, encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error) return { ok: false, outdated: 0, error: r.error.message };
  // npm outdated exits 1 when there ARE outdated packages — DO NOT gate on the exit code.
  const out = asStr(r.stdout).trim();
  let obj: unknown;
  try {
    obj = out ? JSON.parse(out) : {};
  } catch {
    return { ok: false, outdated: 0, error: "bad npm output" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, outdated: 0, error: "bad npm output" };
  return { ok: true, outdated: Object.keys(obj).length };
}

export function resolveDepsPath(repoRoot: string, id: string, deps: ResolveDeps = {}): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new DepsError(`unknown project: ${id}`, 404);
  return proj.path;
}
