import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSafeIdentifier } from "../security/identifiers";
import type { ClientPortfolioDocument } from "../client-portfolio";
import { clientPortfolioPath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validateClientPortfolioDocument } from "./validation";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export class ClientPortfolioStoreError extends Error {}

export class UnsupportedClientPortfolioVersionError extends ClientPortfolioStoreError {
  constructor(readonly version: number) {
    super(`unsupported client portfolio schema version: ${version}`);
  }
}

function readDocument(filePath: string): ClientPortfolioDocument {
  if (!existsSync(filePath)) return { schema_version: 1, clients: {}, commitments: {} };
  try {
    if (statSync(filePath).size > MAX_DOCUMENT_BYTES) throw new ClientPortfolioStoreError("client portfolio document exceeds the 10 MiB limit");
  } catch (error) {
    if (error instanceof ClientPortfolioStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schema_version: 1, clients: {}, commitments: {} };
  }

  let value: unknown;
  try { value = JSON.parse(readFileSync(filePath, "utf8")); }
  catch { throw new ClientPortfolioStoreError("client portfolio document contains invalid JSON"); }

  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedClientPortfolioVersionError(version);
  if (!validateClientPortfolioDocument(value)) {
    throw new ClientPortfolioStoreError(`client portfolio document is invalid: ${describeValidation(validateClientPortfolioDocument.errors)}`);
  }
  for (const [id, client] of Object.entries(value.clients)) {
    if (!isSafeIdentifier(id) || client.id !== id) throw new ClientPortfolioStoreError("client keys must match safe client IDs");
  }
  for (const [id, commitment] of Object.entries(value.commitments)) {
    if (!isSafeIdentifier(id) || commitment.id !== id) throw new ClientPortfolioStoreError("commitment keys must match safe commitment IDs");
  }
  return value;
}

function writeDocumentAtomic(filePath: string, document: ClientPortfolioDocument): void {
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

export function readClientPortfolio(filePath: string = clientPortfolioPath()): ClientPortfolioDocument {
  return readDocument(filePath);
}

export function mutateClientPortfolio(
  mutate: (document: ClientPortfolioDocument) => void,
  filePath: string = clientPortfolioPath(),
): ClientPortfolioDocument {
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("client-portfolio", () => {
    const document = readDocument(filePath);
    mutate(document);
    if (!validateClientPortfolioDocument(document)) {
      throw new ClientPortfolioStoreError(`client portfolio document is invalid: ${describeValidation(validateClientPortfolioDocument.errors)}`);
    }
    for (const [id, client] of Object.entries(document.clients)) {
      if (!isSafeIdentifier(id) || client.id !== id) throw new ClientPortfolioStoreError("client keys must match safe client IDs");
    }
    for (const [id, commitment] of Object.entries(document.commitments)) {
      if (!isSafeIdentifier(id) || commitment.id !== id) throw new ClientPortfolioStoreError("commitment keys must match safe commitment IDs");
    }
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (bytes > MAX_DOCUMENT_BYTES) throw new ClientPortfolioStoreError("client portfolio document exceeds the 10 MiB limit");
    writeDocumentAtomic(filePath, document);
    return document;
  }, join(stateRoot, "locks"));
}
