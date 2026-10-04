import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertProfile, assertProfiles } from "../harness/validation";
import type { HarnessProfilesDocument, ProjectHarnessProfile } from "../harness/types";
import { harnessProfilesPath, locksDir } from "./paths";
import { withStateLock } from "./store";

export class HarnessStateError extends Error {}
export function readHarnessProfiles(filePath = harnessProfilesPath()): HarnessProfilesDocument {
  if (!existsSync(filePath)) return { schema_version: 1, profiles: {} };
  try {
    if (statSync(filePath).size > 10 * 1024 * 1024) throw new Error("size limit");
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    assertProfiles(value);
    return value;
  } catch { throw new HarnessStateError("Harness observations are invalid or unsupported; stored bytes were preserved."); }
}
export function saveHarnessProfile(profile: ProjectHarnessProfile, filePath = harnessProfilesPath()): void {
  assertProfile(profile);
  withStateLock("harness-profiles", () => {
    const document = readHarnessProfiles(filePath);
    document.profiles[profile.project_id] = profile;
    assertProfiles(document);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(document, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Only this write's unique temporary file is eligible. */ }
      throw error;
    }
  }, locksDir(dirname(dirname(filePath))));
}
