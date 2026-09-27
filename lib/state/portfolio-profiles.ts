import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import type { PortfolioProfilesDocument, ProjectProfile } from "../portfolio-profile";
import { portfolioProfilesPath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validatePortfolioProfilesDocument, validateProjectProfile } from "./validation";

export class PortfolioProfileStoreError extends Error {}

export class UnsupportedPortfolioSchemaVersionError extends PortfolioProfileStoreError {
  constructor(readonly version: number) {
    super(`unsupported portfolio profile schema version: ${version}`);
  }
}

const emptyDocument = (): PortfolioProfilesDocument => ({ schema_version: 1, projects: {} });

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

function readDocument(filePath: string): PortfolioProfilesDocument {
  if (!existsSync(filePath)) return emptyDocument();

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new PortfolioProfileStoreError("portfolio profile store contains invalid JSON");
  }

  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedPortfolioSchemaVersionError(version);
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
  return Object.values(readDocument(filePath).projects);
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
