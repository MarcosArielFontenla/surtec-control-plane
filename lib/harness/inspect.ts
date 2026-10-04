import { lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";
import { CAPABILITIES, type HarnessSource, type ProjectHarnessProfile } from "./types";
import { hash, readContained, safeRelative } from "./source";
import { doctorStatus, finding } from "./doctor";
import { assertProfile } from "./validation";
import { redactText } from "../security/redaction";

const MAX_ENTRIES = 128;
const MAX_TOTAL = 2 * 1024 * 1024;
function frontmatter(raw: string | undefined): Record<string, unknown> | null {
  try {
    const match = raw && /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const value: unknown = match ? parse(match[1]) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export function inspectHarness(root: string, projectId: string, source: HarnessSource, now = new Date()): ProjectHarnessProfile {
  const trusted = source.status === "trusted" ? source.manifest : null;
  const policy = source.registry && Object.hasOwn(source.registry.projects, projectId) ? source.registry.projects[projectId] : undefined;
  const result: ProjectHarnessProfile = {
    schema_version: 1, project_id: projectId, status: "unknown", detected_version: null,
    canonical_version: trusted?.harness_version ?? null, comparison: "unknown", capability_results: [],
    drift_summary: [], observed_at: now.toISOString(), source_fingerprint: source.fingerprint,
    project_fingerprint: hash("unobserved"), doctor_status: "unknown", findings: [], entries: [],
    testing_policy: policy?.testing_policy ?? { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] },
    runner_command: policy?.testing_policy.runner_id ? redactText(source.registry!.runners[policy.testing_policy.runner_id].command) : null,
    review_policy: policy?.review_policy ?? "unknown", backup_ready: policy?.backup_ready ?? false,
    rollback_ready: policy?.rollback_ready ?? false, validation: { status: "unknown", observed_at: null },
  };
  const content = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  let consumed = 0;
  const inspect = (path: string): "present" | "missing" | "unsafe" => {
    if (!safeRelative(path) || /(^|\/)(?:\.git|\.codex|\.aws|state|auth\.json|credentials|\.env[^/]*)(\/|$)/i.test(path)
      || !(path === "AGENTS.md" || path.startsWith(".agents/") || path.startsWith("docs/"))) return "unsafe";
    if (content.has(path)) return "present";
    try {
      const bytes = readContained(root, path);
      if (!bytes) { fingerprints.set(path, "missing"); return "missing"; }
      consumed += bytes.length;
      if (consumed > MAX_TOTAL || content.size >= MAX_ENTRIES) throw new Error("inventory limit");
      content.set(path, bytes.toString("utf8")); fingerprints.set(path, hash(bytes)); return "present";
    } catch { fingerprints.set(path, "unsafe"); return "unsafe"; }
  };
  const paths = new Set<string>(["AGENTS.md", ".agents/AGENTS.md", ".agents/orchestration/ROUTING.md"]);
  for (const entry of trusted?.expected_entries ?? []) paths.add(entry.path);
  let inventoryLimited = false;
  function walk(path: string, depth: number): void {
    try {
      if (depth > 6 || paths.size >= MAX_ENTRIES) { inventoryLimited = true; return; }
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) { paths.add(path); return; }
      if (!stat.isDirectory()) { paths.add(path); return; }
      const names = readdirSync(join(root, path)).sort();
      if (names.length > MAX_ENTRIES) inventoryLimited = true;
      for (const name of names.slice(0, MAX_ENTRIES)) {
        if (paths.size >= MAX_ENTRIES) { inventoryLimited = true; break; }
        const child = `${path}/${name}`;
        if (safeRelative(child)) walk(child, depth + 1);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") inventoryLimited = true;
    }
  }
  walk(".agents", 0);
  for (const path of [...paths].sort().slice(0, MAX_ENTRIES)) {
    const status = inspect(path);
    const owned = policy?.ownership.find((entry) => entry.path === path);
    result.entries.push({ path, status, ownership: owned?.classification ?? "unknown", ownership_evidence: owned?.evidence ?? null });
    if (status === "unsafe") result.findings.push(finding(`unsafe-${hash(path).slice(0, 16)}`, "An entry could not be safely inspected.", [path], "Links, unreadable files and size limits cannot be bypassed.", "Review the entry locally; do not auto-repair."));
  }
  const primer = content.get("AGENTS.md");
  const installed = !!primer || result.entries.some((entry) => entry.path.startsWith(".agents/") && entry.status !== "missing");
  const recognized = frontmatter(primer)?.role === "session-primer" && frontmatter(content.get(".agents/AGENTS.md"))?.role === "artifact-registry";
  result.status = !installed ? "absent" : recognized ? "healthy" : content.has(".agents/orchestration/ROUTING.md") ? "unknown" : "legacy";
  if (inventoryLimited) result.findings.push(finding("inventory-limit", "Inventory coverage is incomplete.", [".agents"], "The bounded inventory could not cover all entries.", "Review the unsupported or oversized tree locally."));
  if (inventoryLimited || result.entries.some((entry) => entry.status === "unsafe")) result.status = "unknown";
  if (!trusted) result.findings.push(finding("source-unavailable", "Canonical comparison is unavailable.", ["registry/harness-sources.yml"], source.reason ?? "No trusted baseline is available.", "Review the trusted source registry and baseline."));
  const expected = trusted?.expected_entries ?? [];
  for (const capability of CAPABILITIES) {
    const entries = expected.filter((entry) => entry.capability === capability);
    const missing = entries.filter((entry) => entry.required && result.entries.find((observed) => observed.path === entry.path)?.status !== "present");
    result.capability_results.push({ capability, expected: trusted?.capabilities[capability] ?? false,
      status: !trusted || !entries.length ? "unknown" : missing.length ? "missing" : "present", evidence: entries.map((entry) => entry.path).slice(0, 8) });
    if (missing.length && installed) result.findings.push(finding(`missing-${capability}`, `Required ${capability} entries are missing.`, missing.map((entry) => entry.path), "The selected version requires these entries.", "Review missing entries before any separately approved scaffold update."));
  }
  if (trusted && installed && recognized && result.status !== "unknown") {
    for (const entry of expected) {
      const observed = fingerprints.get(entry.path);
      if (observed !== entry.sha256) result.drift_summary.push(`${entry.path}: ${observed === "missing" ? "missing" : "differs from reviewed baseline"}`);
    }
    result.comparison = result.drift_summary.length ? "drift" : "compatible";
    if (!result.drift_summary.length) result.detected_version = trusted.harness_version;
    const missing = result.capability_results.some((entry) => entry.expected && entry.status === "missing");
    if (missing) result.status = "partial";
    if (result.drift_summary.length) result.findings.push(finding("drift-review", "The installed scaffold differs from the reviewed baseline.", result.drift_summary.slice(0, 8), "Differences may be intentional project changes; hashes are not ownership proof.", "Review the bounded differences; preserve unknown and user-owned files."));
  }
  if (installed && !recognized) result.findings.push(finding("unsupported-format", "Installed instructions are legacy or unrecognized.", ["AGENTS.md", ".agents/AGENTS.md"], "This inspector recognizes the reviewed H1-H4 layout only.", "Select a separately reviewed manifest for this dialect."));
  // Parse local links as data only. Never load URLs, execute commands or follow filesystem links.
  if (recognized) {
    const primerLines = primer!.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
    if (primerLines > 40) result.findings.push(finding("primer-budget", "The H1-H4 primer exceeds its 40-line limit.", ["AGENTS.md"], "A compact primer is part of this version's context contract.", "Review primer size and move detail to routed documents."));
    for (const [path, raw] of [...content]) {
      if (!path.endsWith(".md")) continue;
      const refs = [...raw.matchAll(/\]\(([^\s)]+)\)/g)].slice(0, 64);
      for (const match of refs) {
        const ref = match[1];
        if (/^[a-z]+:/i.test(ref) || ref.startsWith("#") || ref.includes("<")) continue;
        const target = posix.normalize(posix.join(posix.dirname(path), ref.split("#")[0]));
        if (!safeRelative(target) || inspect(target) !== "present") {
          result.findings.push(finding(`reference-${hash(path + target).slice(0, 16)}`, "A local instruction reference is broken or unsafe.", [path], "Referenced local evidence must be contained and readable.", "Review the local link target without executing instructions."));
        }
        if (result.findings.length >= 100) break;
      }
      if (result.findings.length >= 100) break;
    }
    const routing = content.get(".agents/orchestration/ROUTING.md");
    if (!routing?.includes("| Task class |") || !routing.includes("Mandatory") && !routing.includes("Always load")) {
      result.status = "invalid";
      result.findings.push(finding("routing-invalid", "H1-H4 routing structure is missing or invalid.", [".agents/orchestration/ROUTING.md"], "Required task routing cannot be established.", "Review task routing before using this scaffold."));
    }
    if (routing) for (const match of [...routing.matchAll(/`([^`]+\.(?:md|yaml|json))`/g)].slice(0, 64)) {
      if (inspect(match[1]) !== "present") {
        result.status = "invalid";
        result.findings.push(finding("routing-reference-invalid", "Routing references missing or unsafe artifacts.", [".agents/orchestration/ROUTING.md"], "A declared task route requires evidence that is unavailable.", "Review route references and preserve project-owned files."));
      }
    }
    result.findings.push(finding("instruction-conflicts-unverified", "Semantic instruction conflicts require human review.", ["AGENTS.md", ".agents/policies/project.md"], "Structural inspection cannot establish that all natural-language instructions are consistent.", "Review conflicting instructions before a separately authorized implementation.", "info"));
    for (const [path, raw] of content) if (path.endsWith("/SKILL.md")) {
      try {
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        const metadata = match ? parse(match[1]) : null;
        if (!metadata || typeof metadata.name !== "string" || typeof metadata.description !== "string" || typeof metadata.metadata?.version !== "string") throw new Error("skill metadata");
        if (metadata.metadata.snapshotPath) {
          const snapshotPath = metadata.metadata.snapshotPath;
          if (typeof snapshotPath !== "string" || inspect(snapshotPath) !== "present") throw new Error("skill snapshot");
          const snapshotRaw = content.get(snapshotPath)!;
          const snapshotMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(snapshotRaw);
          const snapshot = snapshotMatch ? parse(snapshotMatch[1]) : null;
          if (!snapshot || snapshot.sourceHash !== hash(Buffer.from(raw)) || String(snapshot.sourceVersion) !== metadata.metadata.version
            || snapshotRaw.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length > 25) throw new Error("skill snapshot drift");
        }
      } catch { result.status = "invalid"; result.findings.push(finding(`skill-${hash(path).slice(0, 16)}`, "Skill metadata is invalid.", [path], "Required skill identity, description and version cannot be established.", "Review the skill metadata without executing it.")); }
    }
    const budget = content.get(".agents/cold-start/budget-manifest.yaml");
    if (budget) try {
      const value = parse(budget);
      if (value.version !== 1 || !Array.isArray(value.alwaysLoad) || !Array.isArray(value.taskClasses) || value.taskClasses.length > 32
        || !["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"].every((path) => value.alwaysLoad.includes(path))
        || !Number.isInteger(value.budgetLines) || value.budgetLines <= 0) throw new Error("context format");
      for (const route of value.taskClasses.slice(0, 32)) {
        if (!Array.isArray(route.artifacts)) throw new Error("context route");
        const files = [...new Set<string>([...value.alwaysLoad, ...route.artifacts])];
        let lines = 0;
        for (const file of files.slice(0, 64)) { if (typeof file !== "string" || inspect(file) !== "present") throw new Error("context entry"); lines += content.get(file)!.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length; }
        if (files.length > 64 || lines > value.budgetLines) result.findings.push(finding(`context-${hash(String(route.name)).slice(0, 16)}`, "A declared context route exceeds its line budget.", [".agents/cold-start/budget-manifest.yaml"], "Physical lines are a proxy, not runtime tokens.", "Decompose the route without omitting required reads."));
      }
    } catch { result.findings.push(finding("context-unknown", "Context-budget evidence is invalid or incomplete.", [".agents/cold-start/budget-manifest.yaml"], "Unsupported or missing references cannot establish a passing budget.", "Review the manifest and referenced documents.")); }
  }
  result.project_fingerprint = hash(JSON.stringify([...fingerprints].sort(([a], [b]) => a.localeCompare(b))));
  if (policy?.validation?.fingerprint === result.project_fingerprint) result.validation = { status: policy.validation.status, observed_at: policy.validation.observed_at };
  if (result.validation.status === "failed") result.findings.push(finding("done-gate-failed", "A trusted validation record failed for this fingerprint.", ["trusted project validation record"], "This evidence applies to the exact observed content.", "Review failed validation before continuing implementation."));
  result.findings.push(finding("ownership-review", "Unclassified entries remain unknown-owned.", ["trusted project ownership metadata"], "Filenames and matching content do not authorize overwrite.", "Require explicit ownership confirmation before any future repair.", "info"));
  const additions = result.entries.filter((entry) => entry.status === "present" && !expected.some((canonical) => canonical.path === entry.path));
  if (trusted && additions.length) result.findings.push(finding("project-additions", "Additional project entries are preserved.", additions.map((entry) => entry.path), "Additional files are not automatically invalid or scaffold-owned.", "Review only when relevant; preserve project-specific additions.", "info"));
  const bounded = (text: string) => redactText(text).replace(/[\r\n\t]+/g, " ").slice(0, 240);
  result.entries = result.entries.map((entry) => ({ ...entry, ownership_evidence: entry.ownership_evidence ? bounded(entry.ownership_evidence) : null }));
  result.drift_summary = result.drift_summary.map(bounded);
  result.findings = result.findings.map((entry) => ({ ...entry, observed: bounded(entry.observed), why: bounded(entry.why), recommended_action: bounded(entry.recommended_action), evidence: entry.evidence.map(bounded) }));
  result.findings = [...new Map(result.findings.map((entry) => [entry.id, entry])).values()].slice(0, 128);
  result.doctor_status = doctorStatus(result);
  assertProfile(result);
  return result;
}
