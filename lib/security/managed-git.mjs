import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_PLANE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function ensureDirectory(path, label) {
  if (!existsSync(path)) mkdirSync(path);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a control-plane-owned directory`);
  }
}

export function managedHooksDirectory(controlPlaneRoot = CONTROL_PLANE_ROOT) {
  const root = realpathSync.native(controlPlaneRoot);
  const stateDirectory = join(root, "state");
  const securityDirectory = join(stateDirectory, "security");
  const hooksDirectory = join(securityDirectory, "managed-git-hooks-empty");

  ensureDirectory(stateDirectory, "state path");
  ensureDirectory(securityDirectory, "security state path");
  ensureDirectory(hooksDirectory, "managed Git hooks path");
  if (readdirSync(hooksDirectory).length !== 0) {
    throw new Error("managed Git hooks directory must remain empty");
  }
  return hooksDirectory;
}

export function managedGitArgs(args, controlPlaneRoot = CONTROL_PLANE_ROOT) {
  const hooksDirectory = managedHooksDirectory(controlPlaneRoot);
  return ["-c", `core.hooksPath=${hooksDirectory}`, ...args];
}
