import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredProject {
  id: string;
  path: string;
}

export const DEFAULT_IGNORE = ["node_modules"];

// Scans `root` at depth 1 and returns every subdirectory that is a git repo
// (has a `.git` dir OR file). Skips dot-folders and ignored names. Never throws.
export function discoverProjects(root: string, ignore: string[] = DEFAULT_IGNORE): DiscoveredProject[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const ignoreSet = new Set(ignore);
  const out: DiscoveredProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (ignoreSet.has(e.name)) continue;
    const path = join(root, e.name);
    if (existsSync(join(path, ".git"))) out.push({ id: e.name, path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
