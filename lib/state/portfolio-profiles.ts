import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import type { PortfolioProfilesDocument, ProjectProfile } from "../portfolio-profile";
import { portfolioProfilesPath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validatePortfolioProfilesDocument, validatePortfolioProfilesDocumentV1, validateProjectProfile } from "./validation";

export class PortfolioProfileStoreError extends Error {}

export class UnsupportedPortfolioSchemaVersionError extends PortfolioProfileStoreError {
  constructor(readonly version: number) {
    super(`unsupported portfolio profile schema version: ${version}`);
  }
}

export interface PortfolioProfileMigrationReport {
  migration: "portfolio-profiles-v1-to-v2";
  project_count: number;
  client_categories_migrated: number;
  personal_categories_preserved: number;
  source_sha256: string;
  target_sha256: string;
  backup_id: string;
}

const emptyDocument = (): PortfolioProfilesDocument => ({ schema_version: 2, projects: {} });

export type ProjectProfilesSnapshot =
  | { status: "absent"; schema_version: null; fingerprint: null; profiles: readonly ProjectProfile[] }
  | { status: "migration-required"; schema_version: 1; fingerprint: string; profiles: readonly ProjectProfile[] }
  | { status: "current"; schema_version: 2; fingerprint: string; profiles: readonly ProjectProfile[] };
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
function snapshotError(): PortfolioProfileStoreError {
  return new PortfolioProfileStoreError("Portfolio profile evidence is invalid, unsupported or unavailable; no changes were made.");
}
function checkSnapshotPath(path: string): void {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of segments.entries()) {
    current = join(current, part);
    let stat: Stats;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw snapshotError(); }
    const last = index === segments.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw snapshotError();
  }
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeSnapshot(child); Object.freeze(value); }
  return value;
}
/** No locks, migration, backup, repair or invented review timestamps; v1 remains visibly unavailable. */
export function readProjectProfilesSnapshot(filePath: string = portfolioProfilesPath()): ProjectProfilesSnapshot {
  const path = resolve(filePath);
  checkSnapshotPath(path);
  let before: Stats;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return freezeSnapshot({ status: "absent", schema_version: null, fingerprint: null, profiles: [] });
    throw snapshotError();
  }
  if (before.size > SNAPSHOT_MAX_BYTES) throw snapshotError();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    const same = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!same(opened)) throw snapshotError();
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(descriptor, buffer, length, buffer.length - length, null); if (count === 0) break; length += count; }
    const named = lstatSync(path);
    if (length !== before.size || !same(fstatSync(descriptor)) || !same(named) || named.isSymbolicLink()) throw snapshotError();
    checkSnapshotPath(path);
    const bytes = buffer.subarray(0, length);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
    if (typeof version === "number" && version > 2) throw new UnsupportedPortfolioSchemaVersionError(version);
    const valid = version === 1 ? validatePortfolioProfilesDocumentV1(value) : validatePortfolioProfilesDocument(value);
    if (!valid) throw snapshotError();
    const document = value as { projects: Record<string, ProjectProfile> };
    if (Object.entries(document.projects).some(([id, profile]) => !isSafeIdentifier(id) || ["constructor", "prototype", "__proto__"].includes(id) || id !== profile.project_id)) throw snapshotError();
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    if (version === 1) return freezeSnapshot({ status: "migration-required", schema_version: 1, fingerprint, profiles: [] });
    return freezeSnapshot({ status: "current", schema_version: 2, fingerprint, profiles: Object.values(document.projects) });
  } catch (error) {
    if (error instanceof UnsupportedPortfolioSchemaVersionError) throw error;
    throw snapshotError();
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeDocumentAtomic(filePath: string, document: PortfolioProfilesDocument): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* only the unique temporary file created above is eligible for cleanup */ }
    throw error;
  }
}

function migrateV1Document(value: { schema_version: 1; projects: Record<string, Omit<ProjectProfile, "schema_version" | "kind"> & { schema_version: 1; kind: "personal" | "client" }> }): PortfolioProfilesDocument {
  return {
    schema_version: 2,
    projects: Object.fromEntries(Object.entries(value.projects).map(([id, profile]) => [id, {
      ...profile,
      schema_version: 2 as const,
      kind: profile.kind === "client" ? "client-product" as const : "personal" as const,
    }])),
  };
}

function migrateV1File(filePath: string, original: string, migrated: PortfolioProfilesDocument): PortfolioProfileMigrationReport {
  const stateRoot = dirname(dirname(filePath));
  const backupDirectory = join(stateRoot, "backups", "phase-k-portfolio-profiles");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const sourceSha256 = createHash("sha256").update(original).digest("hex");
  const targetText = JSON.stringify(migrated, null, 2);
  const targetSha256 = createHash("sha256").update(targetText).digest("hex");
  const backupId = `${sourceSha256}.v1.json`;
  const report: PortfolioProfileMigrationReport = {
    migration: "portfolio-profiles-v1-to-v2",
    project_count: Object.keys(migrated.projects).length,
    client_categories_migrated: Object.values(migrated.projects).filter((profile) => profile.kind === "client-product").length,
    personal_categories_preserved: Object.values(migrated.projects).filter((profile) => profile.kind === "personal").length,
    source_sha256: sourceSha256,
    target_sha256: targetSha256,
    backup_id: backupId,
  };
  console.info(`[portfolio] migration preflight ${JSON.stringify(report)}`);
  const backupPath = join(backupDirectory, backupId);
  if (existsSync(backupPath)) {
    const existing = readFileSync(backupPath, "utf8");
    if (createHash("sha256").update(existing).digest("hex") !== sourceSha256) throw new PortfolioProfileStoreError("portfolio migration backup does not match the source fingerprint");
  } else {
    const descriptor = openSync(backupPath, "wx", 0o600);
    try { writeFileSync(descriptor, original, "utf8"); }
    finally { closeSync(descriptor); }
  }

  const stagePath = `${filePath}.${randomUUID()}.migration.tmp`;
  try {
    writeFileSync(stagePath, targetText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const stagedValue: unknown = JSON.parse(readFileSync(stagePath, "utf8"));
    if (!validatePortfolioProfilesDocument(stagedValue)) throw new PortfolioProfileStoreError(`migrated portfolio profile store is invalid: ${describeValidation(validatePortfolioProfilesDocument.errors)}`);
    for (const [projectId, profile] of Object.entries((stagedValue as PortfolioProfilesDocument).projects)) {
      if (!isSafeIdentifier(projectId) || profile.project_id !== projectId) throw new PortfolioProfileStoreError("migrated portfolio profile keys must match safe project IDs");
    }
    renameSync(stagePath, filePath);
  } catch (error) {
    try { unlinkSync(stagePath); } catch { /* only the unique staged file created above is eligible for cleanup */ }
    throw error;
  }
  console.info(`[portfolio] migration completed ${JSON.stringify(report)}`);
  return report;
}

function readDocument(filePath: string, migrateLegacy = true, report?: { value: PortfolioProfileMigrationReport | null }): PortfolioProfilesDocument {
  if (!existsSync(filePath)) return emptyDocument();

  let raw: string;
  let value: unknown;
  try {
    raw = readFileSync(filePath, "utf8");
    value = JSON.parse(raw);
  } catch {
    throw new PortfolioProfileStoreError("portfolio profile store contains invalid JSON");
  }

  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 2) throw new UnsupportedPortfolioSchemaVersionError(version);
  if (version === 1) {
    if (!validatePortfolioProfilesDocumentV1(value)) {
      throw new PortfolioProfileStoreError(`portfolio profile store is invalid: ${describeValidation(validatePortfolioProfilesDocumentV1.errors)}`);
    }
    const migrated = migrateV1Document(value as Parameters<typeof migrateV1Document>[0]);
    for (const [projectId, profile] of Object.entries(migrated.projects)) {
      if (!isSafeIdentifier(projectId) || profile.project_id !== projectId) {
        throw new PortfolioProfileStoreError("portfolio profile keys must match safe project IDs");
      }
    }
    if (migrateLegacy) {
      if (!validatePortfolioProfilesDocument(migrated)) throw new PortfolioProfileStoreError(`migrated portfolio profile store is invalid: ${describeValidation(validatePortfolioProfilesDocument.errors)}`);
      const migrationReport = migrateV1File(filePath, raw, migrated);
      if (report) report.value = migrationReport;
    }
    return migrated;
  }
  if (!validatePortfolioProfilesDocument(value)) {
    throw new PortfolioProfileStoreError(`portfolio profile store is invalid: ${describeValidation(validatePortfolioProfilesDocument.errors)}`);
  }
  for (const [projectId, profile] of Object.entries(value.projects)) {
    if (!isSafeIdentifier(projectId) || profile.project_id !== projectId) {
      throw new PortfolioProfileStoreError("portfolio profile keys must match safe project IDs");
    }
  }
  return value;
}

export function listProjectProfiles(filePath: string = portfolioProfilesPath()): ProjectProfile[] {
  return listProjectProfilesWithMigration(filePath).profiles;
}

export function listProjectProfilesWithMigration(filePath: string = portfolioProfilesPath()): { profiles: ProjectProfile[]; migration: PortfolioProfileMigrationReport | null } {
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("portfolio-profiles", () => {
    const report = { value: null as PortfolioProfileMigrationReport | null };
    const document = readDocument(filePath, true, report);
    return { profiles: Object.values(document.projects), migration: report.value };
  }, join(stateRoot, "locks"));
}

export function upsertProjectProfile(profile: ProjectProfile, filePath: string = portfolioProfilesPath()): ProjectProfile[] {
  if (!validateProjectProfile(profile)) {
    throw new PortfolioProfileStoreError(`project profile is invalid: ${describeValidation(validateProjectProfile.errors)}`);
  }
  if (!isSafeIdentifier(profile.project_id)) throw new PortfolioProfileStoreError("project profile has an unsafe project ID");

  const stateRoot = dirname(dirname(filePath));
  return withStateLock("portfolio-profiles", () => {
    const document = readDocument(filePath);
    document.projects[profile.project_id] = profile;
    writeDocumentAtomic(filePath, document);
    return Object.values(document.projects);
  }, join(stateRoot, "locks"));
}
