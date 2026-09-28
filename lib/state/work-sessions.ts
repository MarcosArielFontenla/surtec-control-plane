import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import type { WorkSession } from "./types";
import { workSessionsPath } from "./paths";
import { StateLockConflictError, withStateLock } from "./store";
import { describeValidation, validateWorkSessionsDocument } from "./validation";

export interface WorkSessionsDocument {
  schema_version: 1;
  sessions: WorkSession[];
}

export class WorkSessionStoreError extends Error {}

export class UnsupportedWorkSessionSchemaVersionError extends WorkSessionStoreError {
  constructor(readonly version: number) {
    super(`unsupported work session schema version: ${version}`);
  }
}

const MAX_STATE_BYTES = 10 * 1024 * 1024;
const emptyDocument = (): WorkSessionsDocument => ({ schema_version: 1, sessions: [] });

function assertSessionIdentities(document: WorkSessionsDocument): void {
  const ids = new Set<string>();
  for (const session of document.sessions) {
    if (!isSafeIdentifier(session.id) || ids.has(session.id)) {
      throw new WorkSessionStoreError("work session IDs must be safe and unique");
    }
    if (!isSafeIdentifier(session.project_id)) throw new WorkSessionStoreError("work session project IDs must be safe");
    ids.add(session.id);
  }
  if (document.sessions.filter((session) => session.status === "active").length > 1) {
    throw new WorkSessionStoreError("work session store contains multiple active sessions");
  }
}

function readDocument(filePath: string): WorkSessionsDocument {
  if (!existsSync(filePath)) return emptyDocument();
  if (statSync(filePath).size > MAX_STATE_BYTES) throw new WorkSessionStoreError("work session store exceeds its size limit");

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new WorkSessionStoreError("work session store contains invalid JSON");
  }

  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedWorkSessionSchemaVersionError(version);
  if (!validateWorkSessionsDocument(value)) {
    throw new WorkSessionStoreError(`work session store is invalid: ${describeValidation(validateWorkSessionsDocument.errors)}`);
  }
  const document = value as unknown as WorkSessionsDocument;
  assertSessionIdentities(document);
  return document;
}

function writeDocumentAtomic(filePath: string, document: WorkSessionsDocument): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(document, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new WorkSessionStoreError("work session store exceeds its size limit");
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* only the unique temporary file created above is eligible for cleanup */ }
    throw error;
  }
}

export function listWorkSessions(filePath: string = workSessionsPath()): WorkSession[] {
  return readDocument(filePath).sessions;
}

export function mutateWorkSessions<T>(
  mutate: (document: WorkSessionsDocument) => T,
  filePath: string = workSessionsPath(),
): T {
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("work-sessions", () => {
    const document = readDocument(filePath);
    const result = mutate(document);
    if (!validateWorkSessionsDocument(document)) {
      throw new WorkSessionStoreError(`work session store is invalid: ${describeValidation(validateWorkSessionsDocument.errors)}`);
    }
    assertSessionIdentities(document);
    writeDocumentAtomic(filePath, document);
    return result;
  }, join(stateRoot, "locks"));
}

export { StateLockConflictError };
