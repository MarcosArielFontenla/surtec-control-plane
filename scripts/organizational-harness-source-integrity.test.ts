import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarnessService } from "../dashboard/src/server/harness-service";
import { previewRegisteredScaffold } from "../lib/harness/scaffold-project";
import { hash, loadHarnessSource } from "../lib/harness/source";
import { PolicyService } from "../lib/policy/service";
import { harnessProfilesPath } from "../lib/state/paths";
import { createScaffoldCliFixture, scaffoldFixtureMissingTemplate, scaffoldFixtureProjectId } from "./testing/scaffold-cli-fixture";

const registryPath = "registry/harness-sources.yml";
const routingPath = ".agents/orchestration/ROUTING.md";
const selection = "personal@1";
const observedAt = new Date("2026-11-17T12:00:00.000Z");
type Fixture = ReturnType<typeof createScaffoldCliFixture>;

function snapshot(root: string) {
  const entries = new Map<string, string | null>();
  function visit(path: string) {
    const file = join(root, path);
    const stat = lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.set(path, null);
      for (const child of readdirSync(file).sort()) visit(posix.join(path, child));
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      entries.set(path, hash(readFileSync(file)));
    } else {
      throw new Error(`Unexpected fixture entry at ${path}.`);
    }
  }
  visit(".");
  return entries;
}

function prepareSource(fixture: Fixture) {
  const trusted = loadHarnessSource(fixture.control);
  if (trusted.status !== "trusted" || !trusted.registry || !trusted.manifest || !trusted.fingerprint) {
    throw new Error("The intact fixture must load as a trusted Harness source.");
  }
  const registryFile = join(fixture.control, registryPath);
  const manifestFile = join(fixture.control, trusted.registry.source.manifest);
  const registryBytes = readFileSync(registryFile);
  const manifestBytes = readFileSync(manifestFile);
  const manifestPin = trusted.registry.source.manifest_sha256;
  const { expected_entries: entries, harness_version: version } = trusted.manifest;
  const missingTemplate = entries.find(({ path }) => path === scaffoldFixtureMissingTemplate);
  if (!missingTemplate) throw new Error("The fixture's missing template must be pinned.");
  const changedPins = () => entries
    .filter(({ path, sha256 }) => hash(readFileSync(join(fixture.control, path))) !== sha256)
    .map(({ path }) => path);
  expect(hash(manifestBytes)).toBe(manifestPin);
  expect(changedPins()).toEqual([]);
  return {
    registryFile, registryBytes, manifestFile, manifestBytes, manifestPin, changedPins,
    version, missingTemplate, fingerprint: trusted.fingerprint,
  };
}

function observe(fixture: Fixture) {
  const before = snapshot(fixture.root);
  function unchanged<T>(operation: string, run: () => T): T {
    try {
      return run();
    } finally {
      expect(snapshot(fixture.root), `${operation} preserves the fixture inventory and hashes`).toEqual(before);
      expect(existsSync(fixture.state), `${operation} leaves state absent`).toBe(false);
    }
  }
  const policy = new PolicyService(fixture.control, { environment: fixture.environment });
  const source = unchanged("source loader", () => loadHarnessSource(fixture.control));
  const doctor = unchanged("Doctor", () => createHarnessService(fixture.control, {
    policy, statePath: harnessProfilesPath(fixture.state), clock: () => observedAt,
  }).read(scaffoldFixtureProjectId));
  const preview = unchanged("registered preview", () => previewRegisteredScaffold(fixture.control, {
    projectId: scaffoldFixtureProjectId, selection,
  }, policy));
  return { source, doctor, preview };
}

function withFixture(check: (fixture: Fixture, baseline: ReturnType<typeof prepareSource>) => void) {
  const fixture = createScaffoldCliFixture();
  try {
    expect(existsSync(fixture.state)).toBe(false);
    check(fixture, prepareSource(fixture));
  } finally {
    fixture.dispose();
  }
}

describe("org.harness.source-integrity", () => {
  it("uses the reviewed source fingerprint and pinned template with intact files", () => {
    withFixture((fixture, baseline) => {
      const { source, doctor, preview } = observe(fixture);
      expect(source).toMatchObject({ status: "trusted", fingerprint: baseline.fingerprint });
      expect(doctor).toMatchObject({
        saved: null,
        observation: {
          project_id: scaffoldFixtureProjectId, canonical_version: baseline.version, source_fingerprint: baseline.fingerprint,
          entries: expect.arrayContaining([expect.objectContaining({ path: scaffoldFixtureMissingTemplate, status: "missing" })]),
        },
      });
      expect(preview).toMatchObject({
        status: "available", execution_authority: "none", project_id: scaffoldFixtureProjectId,
        source: { version: baseline.version, fingerprint: baseline.fingerprint },
        additions: [{ path: scaffoldFixtureMissingTemplate, sha256: baseline.missingTemplate.sha256, preimage: "absent" }],
      });
    });
  });

  it.each(["source file", "manifest"] as const)("denies a changed pinned %s without returning any plan", (changed) => {
    withFixture((fixture, baseline) => {
      if (changed === "source file") {
        appendFileSync(join(fixture.control, routingPath), "\n");
        expect(baseline.changedPins()).toEqual([routingPath]);
        const manifest = readFileSync(baseline.manifestFile);
        expect(manifest).toEqual(baseline.manifestBytes);
        expect(hash(manifest)).toBe(baseline.manifestPin);
      } else {
        appendFileSync(baseline.manifestFile, "\n");
        const manifest = readFileSync(baseline.manifestFile);
        expect(hash(manifest)).not.toBe(baseline.manifestPin);
        expect(JSON.parse(manifest.toString("utf8"))).toEqual(JSON.parse(baseline.manifestBytes.toString("utf8")));
        expect(baseline.changedPins()).toEqual([]);
      }
      expect(readFileSync(baseline.registryFile)).toEqual(baseline.registryBytes);

      const { source, doctor, preview } = observe(fixture);
      expect(source).toMatchObject({ status: "unknown", manifest: null, registry: null, fingerprint: null });
      expect(doctor).toMatchObject({
        saved: null,
        observation: {
          project_id: scaffoldFixtureProjectId, comparison: "unknown", canonical_version: null, source_fingerprint: null,
          findings: expect.arrayContaining([expect.objectContaining({ id: "source-unavailable" })]),
        },
      });
      expect(preview).toEqual({ status: "unavailable", reason: "source-unavailable", execution_authority: "none" });
    });
  });
});
