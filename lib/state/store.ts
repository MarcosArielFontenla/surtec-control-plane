import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync,
} from "node:fs";
import { join, dirname, basename, isAbsolute, relative, resolve } from "node:path";
import { types as nodeTypes } from "node:util";
import type { TaskRecord, ProjectStatusOverride } from "./types";
import { tasksDir, projectsDir, locksDir, stateRootForStoreDirectory, stateRootForLockDirectory } from "./paths";
import { assertSafeIdentifier } from "../security/identifiers";
import { describeValidation, validateProjectOverride, validateTaskRecord } from "./validation";
import { assertMaintenanceMutation, withMaintenanceMutation, StateLockConflictError, MaintenanceStateError } from "./maintenance";

function assertMaintenanceContainment(root: string, target: string): void {
  const location = relative(resolve(root), resolve(target));
  if (isAbsolute(location) || location === ".." || location.startsWith("../") || location.startsWith("..\\")) {
    throw new MaintenanceStateError("State mutation target is outside its maintenance boundary; no files were changed.");
  }
}

function assertSynchronousStateCallback(action: unknown): void {
  if (typeof action !== "function" || nodeTypes.isProxy(action) || nodeTypes.isAsyncFunction(action) || nodeTypes.isGeneratorFunction(action)) {
    throw new MaintenanceStateError("State mutation callback must be synchronous and non-proxied; no files were changed.");
  }
}

export function writeJsonAtomic(filePath: string, data: unknown, maintenanceRoot?: string): void {
  const directory = dirname(filePath);
  const folder = process.platform === "win32" ? basename(directory).toLowerCase() : basename(directory);
  const root = maintenanceRoot ?? (["tasks", "projects", "notes", "reconciliation"].includes(folder)
    ? stateRootForStoreDirectory(directory, folder) : directory);
  assertMaintenanceContainment(root, filePath);
  withMaintenanceMutation(root, () => {
    assertMaintenanceMutation(root);
    mkdirSync(directory, { recursive: true });
    const tmp = `${filePath}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    assertMaintenanceMutation(root);
    writeFileSync(tmp, serialized, "utf8");
    assertMaintenanceMutation(root);
    renameSync(tmp, filePath);
  });
}

export { StateLockConflictError };

const STALE_LOCK_MS = 30_000;

export function withStateLock<T>(id: string, action: () => T, dir: string = locksDir(), maintenanceRoot?: string): T {
  assertSafeIdentifier(id, "lock id");
  assertSynchronousStateCallback(action);
  const root = maintenanceRoot ?? stateRootForLockDirectory(dir);
  assertMaintenanceContainment(root, dir);
  return withMaintenanceMutation(root, () => withStateLockOwned(id, action, dir, root));
}

function withStateLockOwned<T>(id: string, action: () => T, dir: string, root: string): T {
  assertMaintenanceMutation(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.lock`);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(path).mtimeMs <= STALE_LOCK_MS) {
        throw new StateLockConflictError(`state lock is busy: ${id}`);
      }
      unlinkSync(path);
      descriptor = openSync(path, "wx");
    } catch (retryError) {
      if (retryError instanceof StateLockConflictError) throw retryError;
      if ((retryError as NodeJS.ErrnoException).code === "ENOENT") {
        descriptor = openSync(path, "wx");
      } else {
        throw retryError;
      }
    }
  }
  try {
    assertMaintenanceMutation(root);
    writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return action();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(path); } catch { /* a stale-lock recovery may already have removed it */ }
  }
}

function readJsonDir<T>(dir: string, label: string, validate: ((value: unknown) => value is T) & { errors?: unknown }): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!validate(value)) throw new Error(describeValidation(validate.errors as never));
      out.push(value);
    } catch (err) {
      console.warn(`[store] skipping unreadable ${label} file ${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function writeTask(record: TaskRecord, dir: string = tasksDir()): void {
  const root = stateRootForStoreDirectory(dir, "tasks");
  withMaintenanceMutation(root, () => {
    if (!validateTaskRecord(record)) throw new Error(`invalid task record: ${describeValidation(validateTaskRecord.errors)}`);
    assertSafeIdentifier(record.envelope.id, "task id");
    writeJsonAtomic(join(dir, `${record.envelope.id}.json`), record, root);
  });
}

export function readTask(id: string, dir: string = tasksDir()): TaskRecord | null {
  assertSafeIdentifier(id, "task id");
  const p = join(dir, `${id}.json`);
  try {
    const value: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!validateTaskRecord(value)) throw new Error(`invalid task record: ${describeValidation(validateTaskRecord.errors)}`);
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function updateTask(id: string, mutate: (record: TaskRecord) => void | boolean, dir: string = tasksDir()): TaskRecord | null {
  assertSafeIdentifier(id, "task id");
  assertSynchronousStateCallback(mutate);
  const root = stateRootForStoreDirectory(dir, "tasks");
  return withMaintenanceMutation(root, () => withStateLock(id, () => {
    const record = readTask(id, dir);
    if (!record) return null;
    const previousRevision = record.revision ?? 0;
    if (withMaintenanceMutation(root, () => mutate(record)) === false) return record;
    record.revision = previousRevision + 1;
    writeTask(record, dir);
    return record;
  }, join(root, "locks"), root));
}

export function listTasks(dir: string = tasksDir()): TaskRecord[] {
  return readJsonDir<TaskRecord>(dir, "task", validateTaskRecord);
}

export function listProjectOverrides(dir: string = projectsDir()): ProjectStatusOverride[] {
  return readJsonDir<ProjectStatusOverride>(dir, "project", validateProjectOverride);
}

export function upsertProjectOverride(o: ProjectStatusOverride, dir: string = projectsDir()): void {
  const root = stateRootForStoreDirectory(dir, "projects");
  withMaintenanceMutation(root, () => {
    if (!validateProjectOverride(o)) throw new Error(`invalid project override: ${describeValidation(validateProjectOverride.errors)}`);
    assertSafeIdentifier(o.id, "project id");
    writeJsonAtomic(join(dir, `${o.id}.json`), o, root);
  });
}
