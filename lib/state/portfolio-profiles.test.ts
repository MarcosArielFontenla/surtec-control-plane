import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectProfile } from "../portfolio-profile";
import { listProjectProfiles, readProjectProfilesSnapshot, upsertProjectProfile, UnsupportedPortfolioSchemaVersionError } from "./portfolio-profiles";
import { validatePortfolioProfilesDocument } from "./validation";

let root: string;
let filePath: string;

const profile = (overrides: Partial<ProjectProfile> = {}): ProjectProfile => ({
  schema_version: 2,
  project_id: "alpha",
  kind: "client-product",
  lifecycle: "active",
  priority: 2,
  criticality: "high",
  current_goal: "Ship the next release.",
  next_action: "Review the checklist.",
  deadline: "2026-12-15",
  client_id: "client-demo",
  last_reviewed_at: "2026-09-27",
  tags: ["release", "example"],
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-portfolio-profiles-"));
  filePath = join(root, "portfolio", "projects.json");
  mkdirSync(join(root, "portfolio"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("local project profile store", () => {
  it("reads optional absence without a lock, directory or fabricated profile", () => {
    const missing = join(root, "missing-state/portfolio/projects.json");
    const before = readdirSync(root, { recursive: true });
    expect(readProjectProfilesSnapshot(missing)).toEqual({ status: "absent", schema_version: null, fingerprint: null, profiles: [] });
    expect(readdirSync(root, { recursive: true })).toEqual(before);
    expect(existsSync(join(root, "missing-state"))).toBe(false);
  });
  it.each(["client", "personal"])("validates v1 %s without migration, backup, lock or silent current evidence", (kind) => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 1, projects: { alpha: { ...profile({ client_id: kind === "personal" ? null : "client-demo" }), schema_version: 1, kind } } }, null, 2));
    writeFileSync(filePath, bytes);
    const before = readdirSync(root, { recursive: true });
    expect(readProjectProfilesSnapshot(filePath)).toEqual({ status: "migration-required", schema_version: 1,
      fingerprint: createHash("sha256").update(bytes).digest("hex"), profiles: [] });
    expect(readFileSync(filePath).equals(bytes)).toBe(true);
    expect(readdirSync(root, { recursive: true })).toEqual(before);
  });
  it("returns detached deeply frozen validated v2 evidence and its exact byte fingerprint", () => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 2, projects: { alpha: profile() } }, null, 2));
    writeFileSync(filePath, bytes);
    const before = readdirSync(root, { recursive: true });
    const snapshot = readProjectProfilesSnapshot(filePath);
    expect(snapshot).toEqual({ status: "current", schema_version: 2, fingerprint: createHash("sha256").update(bytes).digest("hex"), profiles: [profile()] });
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.profiles[0]!.tags)).toBe(true);
    expect(() => { snapshot.profiles[0]!.tags.push("changed"); }).toThrow();
    expect(readProjectProfilesSnapshot(filePath).profiles).not.toBe(snapshot.profiles);
    expect(readFileSync(filePath).equals(bytes)).toBe(true); expect(readdirSync(root, { recursive: true })).toEqual(before);
  });
  it.each(["invalid-json", "invalid-utf8", "future", "v1-invalid", "v2-invalid", "identity", "prototype", "oversized"])("refuses %s evidence without repair or private error content", (kind) => {
    let bytes = Buffer.from("{private fixture content");
    if (kind === "invalid-utf8") bytes = Buffer.from([0x7b, 0xff, 0x7d]);
    if (kind === "future") bytes = Buffer.from('{"schema_version":99,"private":"never log"}');
    if (kind === "v1-invalid") bytes = Buffer.from(JSON.stringify({ schema_version: 1, projects: { alpha: { ...profile(), schema_version: 1, kind: "unsupported" } } }));
    if (kind === "v2-invalid") bytes = Buffer.from(JSON.stringify({ schema_version: 2, projects: { alpha: { ...profile(), priority: 99 } } }));
    if (kind === "identity") bytes = Buffer.from(JSON.stringify({ schema_version: 2, projects: { beta: profile() } }));
    if (kind === "prototype") bytes = Buffer.from(JSON.stringify({ schema_version: 2, projects: { constructor: profile({ project_id: "constructor" }) } }));
    if (kind === "oversized") bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
    writeFileSync(filePath, bytes); const before = readdirSync(root, { recursive: true });
    expect(() => readProjectProfilesSnapshot(filePath)).toThrow(/unavailable|Unsupported|unsupported/);
    expect(readFileSync(filePath).equals(bytes)).toBe(true); expect(readdirSync(root, { recursive: true })).toEqual(before);
  });
  it("refuses hardlinked profile evidence without touching either name", () => {
    const bytes = JSON.stringify({ schema_version: 2, projects: {} }), other = join(root, "original.json");
    writeFileSync(other, bytes); linkSync(other, filePath);
    expect(() => readProjectProfilesSnapshot(filePath)).toThrow(/unavailable/);
    expect(readFileSync(filePath, "utf8")).toBe(bytes); expect(readFileSync(other, "utf8")).toBe(bytes);
    expect(existsSync(join(root, "locks"))).toBe(false);
  });
  it("refuses redirected ancestors even when the requested file is absent", () => {
    const target = join(root, "actual"), redirected = join(root, "redirected"); mkdirSync(target);
    symlinkSync(target, redirected, process.platform === "win32" ? "junction" : "dir");
    expect(() => readProjectProfilesSnapshot(join(redirected, "portfolio/projects.json"))).toThrow(/unavailable/);
    expect(readdirSync(target)).toEqual([]); expect(existsSync(join(root, "locks"))).toBe(false);
  });
  it("returns an empty list without creating a file when no profiles exist", () => {
    expect(listProjectProfiles(filePath)).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it("validates, atomically writes, and lists profiles by project ID", () => {
    const saved = upsertProjectProfile(profile(), filePath);
    expect(saved).toEqual([profile()]);
    expect(listProjectProfiles(filePath)).toEqual([profile()]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ schema_version: 2, projects: { alpha: profile() } });
    expect(readdirSync(join(root, "portfolio"))).toEqual(["projects.json"]);
  });

  it("updates a profile without dropping other projects", () => {
    upsertProjectProfile(profile(), filePath);
    upsertProjectProfile(profile({ project_id: "beta", kind: "personal", client_id: null }), filePath);
    upsertProjectProfile(profile({ next_action: "Run regression tests." }), filePath);
    expect(listProjectProfiles(filePath)).toHaveLength(2);
    expect(listProjectProfiles(filePath).find((item) => item.project_id === "alpha")?.next_action).toBe("Run regression tests.");
  });

  it("rejects unsafe IDs, out-of-range values, duplicate tags, and impossible dates", () => {
    expect(() => upsertProjectProfile(profile({ project_id: "a..b" }), filePath)).toThrow(/invalid|unsafe/);
    expect(() => upsertProjectProfile(profile({ client_id: "client..demo" }), filePath)).toThrow(/invalid/);
    expect(upsertProjectProfile(profile({ kind: "personal", client_id: "client-demo" }), filePath)[0]?.client_id).toBe("client-demo");
    expect(() => upsertProjectProfile(profile({ priority: 6 }), filePath)).toThrow(/invalid/);
    expect(() => upsertProjectProfile(profile({ tags: ["same", "same"] }), filePath)).toThrow(/invalid/);
    expect(() => upsertProjectProfile(profile({ deadline: "2026-02-29" }), filePath)).toThrow(/invalid/);
    expect(() => upsertProjectProfile(profile({ kind: "crm" as ProjectProfile["kind"] }), filePath)).toThrow(/invalid/);
    expect(() => upsertProjectProfile(profile({ current_goal: "x".repeat(501) }), filePath)).toThrow(/invalid/);
    expect(() => upsertProjectProfile({ ...profile(), confidential_notes: "not allowed" } as ProjectProfile, filePath)).toThrow(/invalid/);
    expect(existsSync(filePath)).toBe(true);
  });

  it("rejects malformed JSON and does not repair or overwrite it", () => {
    writeFileSync(filePath, "{broken", "utf8");
    expect(() => listProjectProfiles(filePath)).toThrow(/invalid JSON/);
    expect(() => upsertProjectProfile(profile(), filePath)).toThrow(/invalid JSON/);
    expect(readFileSync(filePath, "utf8")).toBe("{broken");
  });

  it("rejects unsupported future versions without overwriting them", () => {
    const futureDocument = JSON.stringify({ schema_version: 3, projects: {} });
    writeFileSync(filePath, futureDocument, "utf8");
    expect(() => listProjectProfiles(filePath)).toThrow(UnsupportedPortfolioSchemaVersionError);
    expect(() => upsertProjectProfile(profile(), filePath)).toThrow(UnsupportedPortfolioSchemaVersionError);
    expect(readFileSync(filePath, "utf8")).toBe(futureDocument);
  });

  it("rejects a document whose map key does not match the profile ID", () => {
    writeFileSync(filePath, JSON.stringify({ schema_version: 2, projects: { alpha: profile({ project_id: "beta" }) } }), "utf8");
    expect(() => listProjectProfiles(filePath)).toThrow(/keys must match/);
  });

  it("backs up and deterministically migrates existing version-one classifications without losing fields", () => {
    const legacy = {
      schema_version: 1,
      projects: {
        alpha: { ...profile(), schema_version: 1, kind: "client" },
        personal: { ...profile({ project_id: "personal", kind: "personal", client_id: null }), schema_version: 1, kind: "personal" },
      },
    };
    const original = JSON.stringify(legacy, null, 2);
    writeFileSync(filePath, original, "utf8");

    const migrated = listProjectProfiles(filePath);
    expect(migrated.find((item) => item.project_id === "alpha")).toEqual({ ...profile(), kind: "client-product" });
    expect(migrated.find((item) => item.project_id === "personal")).toEqual({ ...profile({ project_id: "personal", kind: "personal", client_id: null }) });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ schema_version: 2, projects: Object.fromEntries(migrated.map((item) => [item.project_id, item])) });
    const backupDirectory = join(root, "backups", "phase-k-portfolio-profiles");
    const [backup] = readdirSync(backupDirectory);
    expect(readFileSync(join(backupDirectory, backup!), "utf8")).toBe(original);
  });

  it("keeps the tracked synthetic fixture valid under the runtime contract", () => {
    const fixturePath = join(process.cwd(), "fixtures", "portfolio-profiles.example.json");
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(validatePortfolioProfilesDocument(fixture)).toBe(true);
  });
});
