import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class OpenError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "OpenError";
  }
}

export type OpenTarget = "vscode" | "folder";
const TARGETS: OpenTarget[] = ["vscode", "folder"];

export function resolveOpenCommand(
  target: OpenTarget,
  path: string,
  platform: NodeJS.Platform,
  editorCmd: string,
): { command: string; args: string[]; shell: boolean } {
  if (target === "vscode") {
    // shell on Windows so a `.cmd` shim (code.cmd / cursor.cmd) resolves; Node escapes the args.
    return { command: editorCmd, args: [path], shell: platform === "win32" };
  }
  const command = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
  return { command, args: [path], shell: false };
}

interface OpenDeps {
  spawn?: (command: string, args: string[], opts: object) => { unref?: () => void };
  platform?: NodeJS.Platform;
  editorCmd?: string;
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function openProject(repoRoot: string, id: string, target: string, deps: OpenDeps = {}): { ok: true } {
  if (!TARGETS.includes(target as OpenTarget)) {
    throw new OpenError(`invalid target: ${target}`, 400);
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const editorCmd = deps.editorCmd ?? process.env.SURTEC_EDITOR_CMD ?? "code";
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new OpenError(`unknown project: ${id}`, 404);

  const { command, args, shell } = resolveOpenCommand(target as OpenTarget, proj.path, platform, editorCmd);
  if (shell && /[&|;<>^`$()\n\r]/.test(command)) {
    throw new OpenError(`unsafe command: ${command}`, 400);
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell });
    child.unref?.();
  } catch (e) {
    throw new OpenError((e as Error).message, 500);
  }
  return { ok: true };
}
