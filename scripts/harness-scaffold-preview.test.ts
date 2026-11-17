import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { inspectHarness } from "../lib/harness/inspect";
import { previewHarnessScaffold } from "../lib/harness/scaffold-preview";
import { hash, loadHarnessSource, readContained } from "../lib/harness/source";
import type { HarnessSourceRegistry } from "../lib/harness/types";

const repoRoot = resolve(".");
const primer = "AGENTS.md";
const spec = ".agents/templates/entity.spec.yaml";
const tasks = ".agents/templates/feature.tasks.md";
const projectId = "phase-r-fixture";
const primerEvidence = "Fixture author declaration for the synthetic root primer.";
const prefix = "surtec-phase-r-acceptance-";

function writeFixtureFile(root: string, path: string, bytes: Buffer | string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes, { flag: "wx" });
}

function requiredBytes(root: string, path: string): Buffer {
  const bytes = readContained(root, path);
  if (!bytes) throw new Error("A reviewed acceptance fixture input is missing.");
  return bytes;
}

function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const file = join(root, path);
    const stat = lstatSync(file);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("Unexpected entry in the disposable tree.");
    return [path.split(sep).join("/"), stat.isDirectory() ? "directory" : hash(readFileSync(file))];
  }));
}

it("compares the real Doctor before and after the sole proposed addition on two disposable trees", () => {
  const reviewed = loadHarnessSource(repoRoot);
  if (reviewed.status !== "trusted" || !reviewed.manifest || !reviewed.registry) {
    throw new Error("Phase R acceptance requires the reviewed Harness source.");
  }
  expect(reviewed.manifest.harness_version).toBe("surtec-h1-h4-v1");
  const parent = realpathSync.native(tmpdir());
  const owned = mkdtempSync(join(parent, prefix));
  const baseline = join(owned, "baseline");
  const projected = join(owned, "projected");
  const sourceRoot = join(owned, "source");
  const identity = lstatSync(owned, { bigint: true });
  try {
    const canonicalRoot = resolve(repoRoot, reviewed.registry.source.root);
    for (const entry of reviewed.manifest.expected_entries) {
      const bytes = requiredBytes(canonicalRoot, entry.path);
      expect(hash(bytes)).toBe(entry.sha256);
      writeFixtureFile(sourceRoot, entry.path, bytes);
    }
    const manifestPath = reviewed.registry.source.manifest;
    writeFixtureFile(sourceRoot, manifestPath, requiredBytes(repoRoot, manifestPath));
    const archetypes = "registry/project-archetypes.yml";
    writeFixtureFile(sourceRoot, archetypes, requiredBytes(repoRoot, archetypes));
    const registry: HarnessSourceRegistry = {
      ...reviewed.registry,
      source: { ...reviewed.registry.source, root: "." },
      projects: {
        [projectId]: {
          ownership: [{ path: primer, classification: "user-owned", evidence: primerEvidence }],
          testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] },
          review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: null,
        },
      },
    };
    writeFixtureFile(sourceRoot, "registry/harness-sources.yml", stringify(registry));
    const source = loadHarnessSource(sourceRoot);
    expect(source).toMatchObject({ status: "trusted", manifest: reviewed.manifest });

    const taskBytes = requiredBytes(canonicalRoot, tasks);
    const specBytes = requiredBytes(canonicalRoot, spec);
    for (const target of [baseline, projected]) {
      writeFixtureFile(target, primer, "# Synthetic project instructions\n");
      writeFixtureFile(target, tasks, taskBytes);
    }
    const baselineBefore = snapshot(baseline);
    const sourceBefore = snapshot(sourceRoot);
    const previewInput = { repoRoot: sourceRoot, projectId, selection: "personal@1", includeAdditionText: true };
    const before = previewHarnessScaffold({ ...previewInput, targetRoot: baseline });
    expect(before.status).toBe("available");
    if (before.status !== "available") throw new Error("The baseline preview was unavailable.");
    expect(before.entries).toMatchObject([
      { path: spec, presence: "missing", decision: "safe-addition", canonical_sha256: hash(specBytes), canonical_physical_lines: 26 },
      { path: tasks, decision: "unchanged", ownership: "unknown", observed_sha256: hash(taskBytes) },
      { path: primer, decision: "user-owned-conflict", ownership: "user-owned", ownership_evidence_sha256: hash(primerEvidence) },
    ]);
    expect(before.addition_text).toEqual([{ path: spec, text: specBytes.toString("utf8") }]);
    expect(before.backup.paths).toEqual([]);
    expect(before.rollback.additions).toEqual([{ path: spec, expected_sha256: hash(specBytes) }]);
    expect(before.execution_authority).toBe("none");

    // Seed the independent hypothetical tree with the exact pinned addition.
    writeFixtureFile(projected, spec, specBytes);
    const projectedBefore = snapshot(projected);
    expect(projectedBefore).toEqual({ ...baselineBefore, [spec]: hash(specBytes) });
    const after = previewHarnessScaffold({ ...previewInput, targetRoot: projected });
    expect(after.status).toBe("available");
    if (after.status !== "available") throw new Error("The projected preview was unavailable.");
    expect(after.entries).toMatchObject([
      { path: spec, presence: "present", decision: "unchanged", ownership: "unknown", observed_sha256: hash(specBytes) },
      { path: tasks, decision: "unchanged", ownership: "unknown", observed_sha256: hash(taskBytes) },
      { path: primer, decision: "user-owned-conflict", ownership: "user-owned", ownership_evidence_sha256: hash(primerEvidence) },
    ]);
    expect(after.addition_text).toEqual([]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect([before, after].map(({ routing }) => routing)).toEqual([
      { updated: false, added_active_context_lines: 0, added_physical_lines: 26 },
      { updated: false, added_active_context_lines: 0, added_physical_lines: 0 },
    ]);
    for (const [tree, preview] of [[baseline, before], [projected, after]] as const) {
      const doctor = inspectHarness(tree, projectId, source);
      expect(doctor).toMatchObject({ status: "legacy", doctor_status: "warning", validation: { status: "unknown" } });
      expect(preview.doctor.project_fingerprint).toBe(doctor.project_fingerprint);
      expect(preview.validation.status).toBe("unknown");
    }
    expect(before.doctor.project_fingerprint).not.toBe(after.doctor.project_fingerprint);
    expect(specBytes.toString("utf8")).toMatch(/^  status: placeholder$/m);
    expect(taskBytes.toString("utf8")).toMatch(/^status: draft$/m);
    expect(snapshot(baseline)).toEqual(baselineBefore);
    expect(snapshot(projected)).toEqual(projectedBefore);
    expect(snapshot(sourceRoot)).toEqual(sourceBefore);
  } finally {
    const current = lstatSync(owned, { bigint: true });
    if (dirname(owned) !== parent || !basename(owned).startsWith(prefix) || realpathSync.native(owned) !== owned
      || !current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("Disposable acceptance root identity changed.");
    }
    rmSync(owned, { recursive: true });
    for (const path of [baseline, projected, sourceRoot, owned]) {
      expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
    }
  }
});
