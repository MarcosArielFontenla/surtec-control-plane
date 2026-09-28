import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectProfile } from "../portfolio-profile";
import { listProjectProfiles, upsertProjectProfile, UnsupportedPortfolioSchemaVersionError } from "./portfolio-profiles";
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
