import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface RegistryDoc {
  projects?: Record<string, {
    verify?: string[];
    commands?: { install?: string; test?: string; build?: string; lint?: string };
  }>;
}

// Resolves the verification command list for a project from the registry (trusted config).
// Never throws — any error (missing file, parse error, unknown project) yields [].
export function loadProjectVerifyCommands(repoRoot: string, projectId: string): string[] {
  let doc: RegistryDoc;
  try {
    const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
    doc = (parse(raw) ?? {}) as RegistryDoc;
  } catch {
    return [];
  }
  const p = doc.projects?.[projectId];
  if (!p) return [];
  if (Array.isArray(p.verify) && p.verify.length > 0) {
    return p.verify.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  }
  const cmds = p.commands ?? {};
  if (cmds.install && cmds.test) return [cmds.install, cmds.test];
  if (cmds.test) return [cmds.test];
  return [];
}
