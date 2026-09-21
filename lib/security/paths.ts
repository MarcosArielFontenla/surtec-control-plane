import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relation = relative(canonicalPath(root), canonicalPath(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function assertPathWithin(root: string, candidate: string, label = "path"): string {
  const canonical = canonicalPath(candidate);
  if (!isPathWithin(root, canonical)) throw new Error(`${label} escapes its allowed root`);
  return canonical;
}

