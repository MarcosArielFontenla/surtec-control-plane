import { resolve } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import { selectProjectArchetype } from "./archetypes";
import { inspectHarnessWithCoverage } from "./inspect";
import { observeScaffoldEntry, scaffoldDirectoryIdentity } from "./scaffold-files";
import { hash, loadHarnessSource } from "./source";
import type { Ownership } from "./types";

interface ScaffoldPreviewInput {
  repoRoot: string;
  targetRoot: string;
  projectId: string;
  selection: unknown;
  includeAdditionText?: boolean;
}

type UnavailableReason = "archetype-unavailable" | "source-unavailable" | "target-unavailable";
type Decision = "safe-addition" | "unchanged" | "user-owned-conflict" | "manual-migration-required";

const actions = {
  "safe-addition": "plan-addition",
  unchanged: "preserve",
  "user-owned-conflict": "preserve-and-review-conflict",
  "manual-migration-required": "review-manual-migration",
} as const satisfies Record<Decision, string>;

const primer = "AGENTS.md";

function unavailable(reason: UnavailableReason) {
  return { status: "unavailable", reason, execution_authority: "none" } as const;
}

function physicalLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function decide(path: string, observed: string | null, canonical: string, ownership: Ownership): Decision {
  if (observed === canonical) return "unchanged";
  if (observed === null) return path === primer ? "manual-migration-required" : "safe-addition";
  if (ownership === "user-owned" || ownership === "project-owned") return "user-owned-conflict";
  return "manual-migration-required";
}

/** Preview the reviewed paths using the trusted control-plane registry and a caller-owned target. */
export function previewHarnessScaffold(input: ScaffoldPreviewInput) {
  const repoRoot = resolve(input.repoRoot);
  let archetype;
  try {
    scaffoldDirectoryIdentity(repoRoot);
    archetype = selectProjectArchetype(repoRoot, input.selection);
  } catch {
    return unavailable("archetype-unavailable");
  }

  const source = loadHarnessSource(repoRoot);
  if (source.status !== "trusted" || !source.manifest || !source.registry || !source.fingerprint) {
    return unavailable("source-unavailable");
  }
  const { manifest, registry } = source;
  const canonicalRoot = resolve(repoRoot, source.registry.source.root);
  const paths = [...archetype.templates, primer].sort();
  let canonicalEntries;
  try {
    canonicalEntries = paths.map((path) => {
      const expected = manifest.expected_entries.find((entry) => entry.path === path);
      const observed = observeScaffoldEntry(canonicalRoot, path);
      if (!expected || !observed.bytes || observed.sha256 !== expected.sha256) throw new Error("Unpinned preview entry");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes);
      return { path, sha256: expected.sha256, text, physical_lines: physicalLines(observed.bytes) };
    });
  } catch {
    return unavailable("source-unavailable");
  }

  const root = resolve(input.targetRoot);
  if (!isSafeIdentifier(input.projectId)) return unavailable("target-unavailable");
  try {
    const targetIdentity = scaffoldDirectoryIdentity(root);
    const initial = paths.map((path) => observeScaffoldEntry(root, path));
    const { profile, inventoryLimits } = inspectHarnessWithCoverage(root, input.projectId, source);
    if (profile.entries.some((entry) => entry.status === "unsafe") || inventoryLimits.some((limit) => limit !== "entry-count")) {
      return unavailable("target-unavailable");
    }
    const partialInventory = inventoryLimits.includes("entry-count");

    const policy = Object.hasOwn(registry.projects, input.projectId) ? registry.projects[input.projectId] : undefined;
    const entries = canonicalEntries.map((canonical, index) => {
      const { path } = canonical;
      const observed = observeScaffoldEntry(root, path);
      const presence = observed.bytes ? "present" : "missing";
      const doctorEntry = profile.entries.find((entry) => entry.path === path);
      if (doctorEntry?.status !== presence || observed.sha256 !== initial[index].sha256 || observed.identity !== initial[index].identity) {
        throw new Error("Preview observation changed during inspection");
      }
      const evidence = policy?.ownership.find((entry) => entry.path === path)?.evidence;
      const decision = decide(path, observed.sha256, canonical.sha256, doctorEntry.ownership);
      return {
        path, presence, decision, action: actions[decision], ownership: doctorEntry.ownership,
        ownership_evidence_sha256: evidence === undefined ? null : hash(evidence),
        observed_sha256: observed.sha256, canonical_sha256: canonical.sha256,
        observed_physical_lines: observed.bytes ? physicalLines(observed.bytes) : null,
        canonical_physical_lines: canonical.physical_lines,
      };
    });
    if (scaffoldDirectoryIdentity(root) !== targetIdentity) return unavailable("target-unavailable");

    try {
      if (loadHarnessSource(repoRoot).fingerprint !== source.fingerprint
        || selectProjectArchetype(repoRoot, input.selection).registry_sha256 !== archetype.registry_sha256) {
        return unavailable("source-unavailable");
      }
    } catch {
      return unavailable("source-unavailable");
    }
    const additions = entries.filter((entry) => entry.decision === "safe-addition");
    const backupPaths: string[] = [];
    const plan = {
      schema_version: 1,
      archetype,
      source: { id: manifest.source_id, version: manifest.harness_version, fingerprint: source.fingerprint },
      target_fingerprint: hash(JSON.stringify([root, targetIdentity, input.projectId])),
      entries,
      doctor: {
        status: profile.status, doctor_status: profile.doctor_status, comparison: profile.comparison,
        detected_version: profile.detected_version, project_fingerprint: profile.project_fingerprint,
        validation: partialInventory ? { status: "unknown", observed_at: null } as const : profile.validation,
        ...(partialInventory ? { inventory_coverage: "partial", inventory_limit: "entry-count" } : {}),
      },
      routing: {
        updated: false,
        added_active_context_lines: 0,
        added_physical_lines: additions.reduce((total, entry) => total + entry.canonical_physical_lines, 0),
      },
      validation: { status: "unknown", expected: ["canonical-template-sha256", "harness-structure", "context-budget"] },
      backup: { paths: backupPaths, fingerprint: hash(JSON.stringify(backupPaths)) },
      rollback: {
        additions: additions.map((entry) => ({ path: entry.path, expected_sha256: entry.canonical_sha256 })),
        requires_unchanged_ownership_and_sha256: true,
      },
      execution_authority: "none",
    } as const;
    const additionText = input.includeAdditionText
      ? canonicalEntries.filter(({ path }) => additions.some((entry) => entry.path === path)).map(({ path, text }) => ({ path, text }))
      : [];

    return { status: "available", ...plan, fingerprint: hash(JSON.stringify(plan)), addition_text: additionText } as const;
  } catch {
    return unavailable("target-unavailable");
  }
}
