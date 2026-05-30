import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProjectCommands } from "../lib/state/types";

interface RegistryDoc {
  projects?: Record<string, { commands?: Record<string, unknown> }>;
}

const KEYS = ["dev", "build", "test", "lint", "install"] as const;

// Returns the trusted registry `commands` map for a project (keys: dev/build/test/lint/install),
// keeping only non-empty string values. Never throws — any error yields {}.
export function loadProjectCommands(repoRoot: string, projectId: string): ProjectCommands {
  let doc: RegistryDoc;
  try {
    doc = (parse(readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8")) ?? {}) as RegistryDoc;
  } catch {
    return {};
  }
  const raw = doc.projects?.[projectId]?.commands ?? {};
  const out: ProjectCommands = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim().length > 0) out[k] = v;
  }
  return out;
}
