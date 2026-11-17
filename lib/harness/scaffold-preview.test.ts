import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { inspectHarnessWithCoverage } from "./inspect";
import { previewHarnessScaffold } from "./scaffold-preview";
import { hash, loadHarnessSource } from "./source";
import type { HarnessManifest, HarnessSourceRegistry, Ownership } from "./types";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readdirSync: vi.fn(fs.readdirSync) };
});
vi.mock("./inspect", async (importOriginal) => {
  const inspect = await importOriginal<typeof import("./inspect")>();
  return { ...inspect, inspectHarnessWithCoverage: vi.fn(inspect.inspectHarnessWithCoverage) };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const inspect = await vi.importActual<typeof import("./inspect")>("./inspect");
const repoRoot = resolve(".");
const registryPath = "registry/harness-sources.yml";
const archetypePath = "registry/project-archetypes.yml";
const projectId = "scaffold-fixture";
const primer = "AGENTS.md";
const spec = ".agents/templates/entity.spec.yaml";
const tasks = ".agents/templates/feature.tasks.md";
const roots: string[] = [];
const junction = process.platform === "win32" ? "junction" : "dir";

afterEach(() => {
  vi.mocked(openSync).mockReset();
  vi.mocked(readdirSync).mockReset();
  vi.mocked(inspectHarnessWithCoverage).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ownedRoot() {
  const root = mkdtempSync(join(tmpdir(), "surtec-preview-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, bytes: string | Buffer) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
}

function fillInventory(root: string) {
  const directory = join(root, ".agents/zz-fixture");
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 130; index++) writeFileSync(join(directory, `fixture-${index}.txt`), "fixture");
}

function configuredSource(ownership: HarnessSourceRegistry["projects"][string]["ownership"] = []) {
  const source = loadHarnessSource(repoRoot);
  if (!source.manifest || !source.registry) throw new Error("Test requires the reviewed canonical source");
  const root = ownedRoot();
  for (const { path } of source.manifest.expected_entries) write(root, path, readFileSync(join(repoRoot, path)));
  const manifestPath = source.registry.source.manifest;
  for (const path of [manifestPath, archetypePath]) write(root, path, readFileSync(join(repoRoot, path)));
  const registry: HarnessSourceRegistry = {
    ...source.registry,
    projects: {
      [projectId]: {
        ownership, testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] },
        review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: null,
      },
    },
  };
  write(root, registryPath, stringify(registry));
  return { root, registry, manifestPath };
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    return [path, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : hash(readFileSync(absolute))];
  });
}

function request(targetRoot: string, controlPlaneRoot = repoRoot) {
  return { repoRoot: controlPlaneRoot, targetRoot, projectId, selection: "personal@1" };
}

function available(input: Parameters<typeof previewHarnessScaffold>[0]) {
  const result = previewHarnessScaffold(input);
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error("Expected an available preview");
  return result;
}

describe("previewHarnessScaffold", () => {
  it("offers only the pinned additions with unknown global validation after count truncation", () => {
    const target = ownedRoot();
    const { root, registry } = configuredSource([{ path: primer, classification: "user-owned", evidence: "Synthetic owner decision" }]);
    write(target, primer, "Private working primer\n");
    mkdirSync(join(target, ".agents/templates"), { recursive: true });
    expect(available(request(target, root)).doctor).not.toHaveProperty("inventory_coverage");
    fillInventory(target);
    const limited = inspectHarnessWithCoverage(target, projectId, loadHarnessSource(root));
    expect(limited.inventoryLimits).toEqual(["entry-count"]);
    registry.projects[projectId].validation = { fingerprint: limited.profile.project_fingerprint, status: "passed", observed_at: "2026-11-16T20:00:00.000Z" };
    write(root, registryPath, stringify(registry));
    expect(inspectHarnessWithCoverage(target, projectId, loadHarnessSource(root)).profile.validation.status).toBe("passed");
    const before = snapshot(target);
    const input = { ...request(target, root), includeAdditionText: true };
    const result = available(input);
    expect(result.doctor).toMatchObject({
      status: "unknown", inventory_coverage: "partial", inventory_limit: "entry-count",
      project_fingerprint: limited.profile.project_fingerprint, validation: { status: "unknown", observed_at: null },
    });
    expect(result.entries).toMatchObject([
      { path: spec, presence: "missing", decision: "safe-addition" },
      { path: tasks, presence: "missing", decision: "safe-addition" },
      { path: primer, presence: "present", decision: "user-owned-conflict" },
    ]);
    expect(result.addition_text).toEqual([spec, tasks].map((path) => ({ path, text: readFileSync(join(root, path), "utf8") })));
    expect(result.execution_authority).toBe("none");
    expect(available(input)).toEqual(result);
    expect(snapshot(target)).toEqual(before);
  });

  it.each(["depth", "read-error", "unsafe-entry", "omitted-plan-entry"])(
    "refuses a count-truncated observation with %s",
    (fault) => {
      const target = ownedRoot();
      fillInventory(target);
      if (fault === "depth") {
        mkdirSync(join(target, ".agents/aa/a/b/c/d/e/f/g"), { recursive: true });
      } else if (fault === "read-error") {
        const denied = join(target, ".agents/aa-unreadable");
        mkdirSync(denied);
        vi.mocked(readdirSync).mockImplementation((path, options) => {
          if (path === denied) throw Object.assign(new Error("Synthetic directory read error"), { code: "EACCES" });
          return fs.readdirSync(path, options);
        });
        expect(inspectHarnessWithCoverage(target, projectId, loadHarnessSource(repoRoot)).inventoryLimits).toEqual(["read-error", "entry-count"]);
      } else if (fault === "unsafe-entry") {
        symlinkSync(ownedRoot(), join(target, ".agents/aa-unsafe"), junction);
      } else {
        vi.mocked(inspectHarnessWithCoverage).mockImplementationOnce((...args) => {
          const observed = inspect.inspectHarnessWithCoverage(...args);
          expect(observed.inventoryLimits).toEqual(["entry-count"]);
          observed.profile.entries = observed.profile.entries.filter(({ path }) => path !== tasks);
          return observed;
        });
      }
      expect(previewHarnessScaffold(request(target))).toEqual({
        status: "unavailable", reason: "target-unavailable", execution_authority: "none",
      });
    },
  );

  it("binds the actual Doctor, ownership, and pinned bytes while preserving the target inventory", () => {
    const target = ownedRoot();
    const privatePrimer = "Private project instructions\r\nSecond line";
    const evidence = `private ownership reference at ${target}`;
    const source = configuredSource([{ path: primer, classification: "user-owned", evidence }]);
    write(target, primer, privatePrimer);
    write(target, tasks, readFileSync(join(source.root, tasks)));
    write(target, "unrelated.txt", "untouched");
    const before = snapshot(target);
    const input = { ...request(target, source.root), includeAdditionText: true };
    const result = available(input);
    const specBytes = readFileSync(join(source.root, spec));

    expect(result.entries.map(({ path }) => path)).toEqual([spec, tasks, primer]);
    expect(result.entries).toMatchObject([
      { path: spec, presence: "missing", decision: "safe-addition", observed_sha256: null, canonical_sha256: hash(specBytes), canonical_physical_lines: 26 },
      { path: tasks, presence: "present", decision: "unchanged", ownership: "unknown", ownership_evidence_sha256: null },
      {
        path: primer, presence: "present", decision: "user-owned-conflict", action: "preserve-and-review-conflict",
        ownership: "user-owned", ownership_evidence_sha256: hash(evidence),
        observed_sha256: hash(privatePrimer), observed_physical_lines: 2,
      },
    ]);
    expect(result).toMatchObject({
      doctor: { status: "legacy", doctor_status: "warning", validation: { status: "unknown" } },
      validation: { status: "unknown" },
      routing: { updated: false, added_active_context_lines: 0, added_physical_lines: 26 },
      backup: { paths: [], fingerprint: hash("[]") },
      rollback: { additions: [{ path: spec, expected_sha256: hash(specBytes) }], requires_unchanged_ownership_and_sha256: true },
      execution_authority: "none",
    });
    expect(result.addition_text).toEqual([{ path: spec, text: specBytes.toString("utf8") }]);
    expect(available(input)).toEqual(result);
    expect(available(request(target, source.root))).toMatchObject({ fingerprint: result.fingerprint, addition_text: [] });
    expect(snapshot(target)).toEqual(before);
    const serialized = JSON.stringify(result);
    for (const privateValue of [privatePrimer, target, source.root, evidence]) {
      expect(serialized).not.toContain(JSON.stringify(privateValue).slice(1, -1));
    }
  });

  it.each([
    ["project-owned", "user-owned-conflict"],
    ["unknown", "manual-migration-required"],
    ["scaffold-managed", "manual-migration-required"],
  ] as const)("preserves a differing template with %s ownership", (ownership: Ownership, decision) => {
    const target = ownedRoot();
    const source = configuredSource([{ path: spec, classification: ownership, evidence: "reviewed fixture evidence" }]);
    write(target, spec, "Existing template\n");
    const result = available({ ...request(target, source.root), includeAdditionText: true });
    expect(result.entries.find((entry) => entry.path === spec)).toMatchObject({ decision, ownership, observed_physical_lines: 1 });
    expect(result.entries.find((entry) => entry.path === primer)).toMatchObject({ presence: "missing", decision: "manual-migration-required" });
    expect(result.addition_text.map(({ path }) => path)).toEqual([tasks]);
    expect(result.backup.paths).toEqual([]);
  });

  it("binds the target identity, project identifier, and observed bytes", () => {
    const target = ownedRoot();
    write(target, spec, "one\n");
    const baseline = available(request(target));
    const other = ownedRoot();
    write(other, spec, "one\n");
    expect(available(request(other)).fingerprint).not.toBe(baseline.fingerprint);
    expect(available({ ...request(target), projectId: "other-fixture" }).fingerprint).not.toBe(baseline.fingerprint);
    write(target, spec, "two\n");
    const changed = available(request(target));
    expect(changed.entries[0].decision).toBe(baseline.entries[0].decision);
    expect(changed.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("invalidates the fingerprint for a repinned source version and a registry byte change", () => {
    const target = ownedRoot();
    const { root, registry, manifestPath } = configuredSource();
    const baseline = available(request(target, root));
    const manifest: HarnessManifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    const manifestBytes = JSON.stringify({ ...manifest, harness_version: "surtec-h1-h4-fixture-v2" });
    write(root, manifestPath, manifestBytes);
    registry.source.manifest_sha256 = hash(manifestBytes);
    write(root, registryPath, stringify(registry));
    const changedVersion = available(request(target, root));
    expect(changedVersion.source.version).toBe("surtec-h1-h4-fixture-v2");
    expect(changedVersion.fingerprint).not.toBe(baseline.fingerprint);
    const yaml = readFileSync(join(root, archetypePath), "utf8");
    write(root, archetypePath, `${yaml}\n# fixture comment\n`);
    expect(available(request(target, root)).fingerprint).not.toBe(changedVersion.fingerprint);
  });

  it("refuses a changed canonical entry without returning a partial plan", () => {
    const target = ownedRoot();
    const { root } = configuredSource();
    write(root, spec, "canonical bytes changed");
    expect(previewHarnessScaffold(request(target, root))).toEqual({
      status: "unavailable", reason: "source-unavailable", execution_authority: "none",
    });
    expect(snapshot(target)).toEqual([]);
  });

  it("requires explicit selection and a valid project identifier", () => {
    const target = ownedRoot();
    expect(previewHarnessScaffold({ ...request(target), selection: "personal" })).toMatchObject({ reason: "archetype-unavailable" });
    expect(previewHarnessScaffold({ ...request(target), projectId: "../outside" })).toMatchObject({ reason: "target-unavailable" });
    expect(snapshot(target)).toEqual([]);
  });

  it.each(["redirected root", "redirected ancestor", "linked parent", "file parent", "hard-linked file", "oversized file"])(
    "refuses a %s and preserves the owned fixture",
    (fault) => {
      const fixture = ownedRoot();
      const physical = join(fixture, "physical");
      mkdirSync(physical);
      let target = physical;
      if (fault === "redirected root" || fault === "redirected ancestor" || fault === "linked parent") {
        const redirected = fault === "linked parent" ? join(physical, ".agents") : join(fixture, "redirected");
        const outside = ownedRoot();
        mkdirSync(join(outside, "nested"));
        symlinkSync(outside, redirected, junction);
        if (fault === "redirected root") target = redirected;
        if (fault === "redirected ancestor") target = join(redirected, "nested");
      } else if (fault === "file parent") {
        write(target, ".agents", "file in place of a directory");
      } else if (fault === "hard-linked file") {
        write(fixture, "source.txt", "linked private content");
        mkdirSync(join(target, ".agents/templates"), { recursive: true });
        linkSync(join(fixture, "source.txt"), join(target, spec));
      } else {
        write(target, spec, Buffer.alloc(256 * 1024 + 1));
      }
      const before = snapshot(fixture);
      expect(previewHarnessScaffold(request(target))).toEqual({
        status: "unavailable", reason: "target-unavailable", execution_authority: "none",
      });
      expect(snapshot(fixture)).toEqual(before);
    },
  );

  it("refuses an entry changed between the named lookup and open", () => {
    const root = ownedRoot();
    fillInventory(root);
    const path = join(root, spec);
    write(root, spec, "original");
    vi.mocked(openSync).mockImplementation((name, flags, mode) => {
      if (name === path) writeFileSync(path, "change during read");
      return fs.openSync(name, flags, mode);
    });
    expect(previewHarnessScaffold(request(root))).toMatchObject({ status: "unavailable", reason: "target-unavailable" });
    expect(readFileSync(path, "utf8")).toBe("change during read");
  });
});
