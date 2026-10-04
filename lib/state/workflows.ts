import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { WORKFLOW_LIMITS, type WorkflowDocument } from "../workflows/types";
import { assertWorkflowDocument, assertWorkflowDocumentMutation } from "../workflows/validation";
import { locksDir, workflowStatePath } from "./paths";
import { StateLockConflictError } from "./store";

export class WorkflowStateError extends Error {
  constructor(message = "Workflow state is invalid, unsupported or inaccessible; no automatic repair was performed.") {
    super(message); this.name = "WorkflowStateError";
  }
}
export class UnsupportedWorkflowVersionError extends WorkflowStateError {
  constructor(readonly version: number) { super("Unsupported workflow schema version; stored bytes were preserved."); this.name = "UnsupportedWorkflowVersionError"; }
}
const emptyDocument = (): WorkflowDocument => ({ schema_version: 1, workflows: {}, stages: {}, grants: {}, decisions: {}, handoffs: {}, review_receipts: {}, admission_intents: {}, accounting: {}, lineages: {}, events: [] });

// The selected state root is operator configuration, never a public request
// parameter. Reject existing redirections (including Windows junctions).
function safePath(path: string, file: boolean): void {
  const absolute = resolve(path), root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new WorkflowStateError(); }
    const lastFile = file && i === segments.length - 1;
    if (stat.isSymbolicLink() || (lastFile ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new WorkflowStateError("Unsafe workflow storage path; no automatic repair was performed.");
  }
}
function read(filePath: string): WorkflowDocument {
  safePath(filePath, true);
  let fd: number;
  try { fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument(); throw new WorkflowStateError(); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > WORKFLOW_LIMITS.documentBytes) throw new WorkflowStateError();
    // Bound allocation and reading even if a same-user process grows the file.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length !== stat.size) throw new WorkflowStateError();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
    if (typeof version === "number" && version > 1) throw new UnsupportedWorkflowVersionError(version);
    assertWorkflowDocument(value);
    return value;
  } catch (error) { if (error instanceof UnsupportedWorkflowVersionError) throw error; throw new WorkflowStateError(); }
  finally { closeSync(fd); }
}
function atomicWrite(filePath: string, document: WorkflowDocument, checkOwnership: () => void): void {
  const encoded = JSON.stringify(document); // persisted bytes use the same bound as validation
  if (Buffer.byteLength(encoded, "utf8") > WORKFLOW_LIMITS.documentBytes) throw new WorkflowStateError();
  safePath(filePath, true);
  try { mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 }); }
  catch { throw new WorkflowStateError("Workflow storage directory could not be created; no snapshot was replaced."); }
  safePath(filePath, true);
  const staged = `${filePath}.${randomUUID()}.tmp`;
  let fd: number | undefined, created = false;
  try {
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    safePath(filePath, true); checkOwnership();
    renameSync(staged, filePath);
    created = false;
  } catch { throw new WorkflowStateError("Workflow replacement failed; the previous snapshot was not replaced."); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (created) { try { unlinkSync(staged); } catch { /* Only this call's uniquely created staging file is eligible. */ } }
  }
}
function withWorkflowLock<T>(directory: string, action: (checkOwnership: () => void) => T): T {
  try { safePath(directory, false); mkdirSync(directory, { recursive: true, mode: 0o700 }); safePath(directory, false); }
  catch { throw new WorkflowStateError(); }
  const path = join(directory, "workflows.lock"), token = `${process.pid}\n${randomUUID()}\n`;
  safePath(path, true);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateLockConflictError("Workflow state lock is busy; explicit recovery is required if its owner is no longer running.");
    throw new WorkflowStateError();
  }
  const stat = fstatSync(fd);
  const checkOwnership = () => {
    try {
      safePath(path, true);
      const current = lstatSync(path);
      if (stat.ino !== current.ino || stat.dev !== current.dev || current.size !== Buffer.byteLength(token) || readFileSync(path, "utf8") !== token) throw new Error("ownership");
    } catch { throw new WorkflowStateError("Workflow lock ownership was lost; explicit recovery is required."); }
  };
  let initialized = false;
  try {
    try { writeFileSync(fd, token, "utf8"); initialized = true; }
    catch { throw new WorkflowStateError("Workflow lock initialization failed; no snapshot was replaced."); }
    return action(checkOwnership);
  } finally {
    closeSync(fd);
    // Never steal a lock by age, or unlink an unknown/replaced lock. A crash
    // leaves a visible conflict for an explicit, inspected recovery.
    if (initialized) {
      checkOwnership();
      try { unlinkSync(path); } catch { throw new WorkflowStateError("Workflow lock release failed; inspect ownership and the current snapshot before retrying."); }
    }
    else {
      // A failed initialization may leave a partial token, not an active lock.
      // Remove it only if it is still the exact regular file opened above.
      try { safePath(path, true); const current = lstatSync(path); if (current.ino === stat.ino && current.dev === stat.dev) unlinkSync(path); } catch { /* Preserve anything whose ownership cannot be proven. */ }
    }
  }
}

export function readWorkflowDocument(filePath: string = workflowStatePath()): WorkflowDocument { return read(resolve(filePath)); }

// Mutations are synchronous and state-only. Do not acquire issue/task/scheduler
// locks, invoke model/Git effects or await anything inside the callback. Read
// cross-store facts before entering, then use higher-level revision fences.
export function mutateWorkflowDocument<T>(mutate: (document: WorkflowDocument) => T, filePath: string = workflowStatePath()): T {
  const path = resolve(filePath);
  read(path); // corrupt/future/unsafe existing bytes cause no directory/lock write
  return withWorkflowLock(locksDir(dirname(dirname(path))), (checkOwnership) => {
    const before = read(path), document = structuredClone(before);
    const result = mutate(document);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new WorkflowStateError("Workflow mutation must be synchronous.");
    assertWorkflowDocumentMutation(before, document);
    checkOwnership();
    if (!isDeepStrictEqual(before, document)) atomicWrite(path, document, checkOwnership);
    return result;
  });
}
