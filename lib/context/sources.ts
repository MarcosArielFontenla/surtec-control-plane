import { lstatSync } from "node:fs";
import { parse } from "yaml";
import { readContained } from "../harness/source";
import type { ContextRoute } from "./types";
import type { ContextTextSource } from "./assemble";
import { ContextContractError, safeContextPath } from "./validation";

export interface ProjectContextSelection {
  roleId: string;
  taskKind: string;
  affectedDomains: string[];
  routes: ContextRoute[];
  requiredSkillIds: string[];
  // Selected by application policy, never by parsing prose or granting project permissions.
  harnessTaskClasses?: string[];
}
interface HarnessSelection { alwaysLoad: string[]; taskClasses: { name: string; artifacts: string[] }[] }
const MANDATORY_HARNESS_PATHS = ["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"];
function supportedHarnessSelection(raw: string): HarnessSelection {
  let value: unknown;
  try { value = parse(raw); } catch { throw new ContextContractError("Invalid Harness context selection manifest"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextContractError("Invalid Harness context selection manifest");
  const record = value as Record<string, unknown>;
  const paths = (candidate: unknown): candidate is string[] => Array.isArray(candidate) && candidate.length <= 64
    && candidate.every((path) => typeof path === "string" && safeContextPath(path)) && new Set(candidate).size === candidate.length;
  if (record.version !== 1 || !paths(record.alwaysLoad)
    || !MANDATORY_HARNESS_PATHS.every((path) => (record.alwaysLoad as string[]).includes(path))
    || record.loadMode !== "full-skills" || record.counting !== "physical-lines-including-frontmatter"
    || record.overflowAction !== "decompose-without-skipping-required-reads"
    || !Number.isInteger(record.budgetLines) || (record.budgetLines as number) < 1 || (record.budgetLines as number) > 2000
    || !Array.isArray(record.taskClasses) || record.taskClasses.length > 32) throw new ContextContractError("Unsupported or invalid Harness context selection manifest");
  const classes = new Set<string>();
  for (const route of record.taskClasses) {
    if (!route || typeof route !== "object" || Array.isArray(route) || !Object.hasOwn(route, "name") || !Object.hasOwn(route, "artifacts")
      || typeof route.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(route.name) || classes.has(route.name)
      || !paths(route.artifacts)) throw new ContextContractError("Invalid Harness context task class");
    classes.add(route.name);
  }
  return { alwaysLoad: record.alwaysLoad, taskClasses: record.taskClasses } as HarnessSelection;
}
export function readProjectContext(root: string, input: ProjectContextSelection): { sources: ContextTextSource[]; omitted: string[]; harnessPresent: boolean } {
  const sources = new Map<string, ContextTextSource>();
  const omitted = new Set<string>();
  let totalRead = 0;
  const read = (path: string, required: boolean, reason: string): Buffer | null => {
    if (!safeContextPath(path) || !/\.(?:md|ya?ml|json)$/i.test(path)) throw new ContextContractError("Unsafe or unsupported context source path");
    if (sources.has(path)) return null;
    let bytes;
    try {
      if (lstatSync(root).isSymbolicLink()) throw new Error("linked project root");
      bytes = readContained(root, path);
    } catch { throw new ContextContractError("Selected context source is unsafe or unavailable"); }
    if (!bytes) {
      if (required) throw new ContextContractError("Required selected context source is missing");
      omitted.add(path); return null;
    }
    totalRead += bytes.length;
    if (totalRead > 2 * 1024 * 1024 || sources.size >= 64) throw new ContextContractError("Project context read budget exceeded");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ContextContractError("Selected context source is not valid UTF-8"); }
    const skill = /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path);
    if (skill) {
      const raw = text;
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      let metadata: unknown;
      try { metadata = frontmatter ? parse(frontmatter[1]!) : null; } catch { metadata = null; }
      const expected = path.split("/")[2];
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
        || !Object.hasOwn(metadata, "name") || (metadata as { name: unknown }).name !== expected
        || !Object.hasOwn(metadata, "description") || typeof (metadata as { description: unknown }).description !== "string"
        || !(metadata as { description: string }).description.trim()) throw new ContextContractError("Required or selected skill metadata is invalid");
    }
    sources.set(path, { id: `project/${path}`, layer: path.includes("ROUTING") || path.endsWith("budget-manifest.yaml") ? "harness-routing" : "instructions", source_type: skill ? "skill" : /decisions\//.test(path) ? "decision" : "instruction", reason, sensitivity: "local", text });
    return bytes;
  };
  const primer = read("AGENTS.md", false, "Project root instructions");
  if (primer && primer.toString("utf8").replace(/\r\n/g, "\n").trimEnd().split("\n").length > 40) throw new ContextContractError("Project primer exceeds the small-root context target");
  const manifest = read(".agents/cold-start/budget-manifest.yaml", false, "Supported structured Harness selection");
  let recognizedPrimer = false;
  const primerHeader = primer && /^---\r?\n([\s\S]*?)\r?\n---/.exec(primer.toString("utf8"));
  if (primerHeader) {
    let metadata: unknown;
    try { metadata = parse(primerHeader[1]!); } catch { throw new ContextContractError("Invalid project primer metadata"); }
    recognizedPrimer = !!metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && Object.hasOwn(metadata, "role") && (metadata as { role: unknown }).role === "session-primer";
  }
  if (recognizedPrimer && !manifest) throw new ContextContractError("Required structured Harness selection manifest is missing");
  if (manifest) {
    const selection = supportedHarnessSelection(manifest.toString("utf8"));
    for (const path of selection.alwaysLoad) read(path, true, "Mandatory project Harness source");
    const selectedClasses = [...new Set(input.harnessTaskClasses ?? [])].sort();
    if (selectedClasses.length > 32) throw new ContextContractError("Harness task-class selection exceeds its limit");
    for (const name of selectedClasses) {
      const route = selection.taskClasses.find((candidate) => candidate.name === name);
      if (!route) throw new ContextContractError("Required Harness task class is unavailable");
      for (const path of [...route.artifacts].sort()) read(path, true, `Selected complete Harness task class ${name}`);
    }
  }
  for (const route of [...input.routes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (route.role_ids.length && !route.role_ids.includes(input.roleId)) continue;
    if (route.task_kinds.length && !route.task_kinds.includes(input.taskKind)) continue;
    if (route.affected_domains.length && !route.affected_domains.some((domain) => input.affectedDomains.includes(domain))) continue;
    for (const path of [...route.paths].sort()) read(path, route.required, `Trusted context route ${route.id}`);
  }
  for (const skill of [...new Set(input.requiredSkillIds)].sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(skill)) throw new ContextContractError("Invalid required skill identity");
    read(`.agents/skills/${skill}/SKILL.md`, true, "Complete required role skill; snapshots are not substitutes");
  }
  return { sources: [...sources.values()], omitted: [...omitted].sort(), harnessPresent: !!primer || !!manifest };
}
