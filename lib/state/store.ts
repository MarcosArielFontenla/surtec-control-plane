import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { TaskRecord, ProjectStatusOverride } from "./types";
import { tasksDir, projectsDir, locksDir } from "./paths";
import { assertSafeIdentifier } from "../security/identifiers";
import { describeValidation, validateProjectOverride, validateTaskRecord } from "./validation";

export function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

export class StateLockConflictError extends Error {}

const STALE_LOCK_MS = 30_000;

export function withStateLock<T>(id: string, action: () => T, dir: string = locksDir()): T {
  assertSafeIdentifier(id, "lock id");
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
  if (!validateTaskRecord(record)) throw new Error(`invalid task record: ${describeValidation(validateTaskRecord.errors)}`);
  assertSafeIdentifier(record.envelope.id, "task id");
  writeJsonAtomic(join(dir, `${record.envelope.id}.json`), record);
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
  return withStateLock(id, () => {
    const record = readTask(id, dir);
    if (!record) return null;
    const previousRevision = record.revision ?? 0;
    if (mutate(record) === false) return record;
    record.revision = previousRevision + 1;
    writeTask(record, dir);
    return record;
  }, join(dirname(dir), "locks"));
}

export function listTasks(dir: string = tasksDir()): TaskRecord[] {
  return readJsonDir<TaskRecord>(dir, "task", validateTaskRecord);
}

export function listProjectOverrides(dir: string = projectsDir()): ProjectStatusOverride[] {
  return readJsonDir<ProjectStatusOverride>(dir, "project", validateProjectOverride);
}

export function upsertProjectOverride(o: ProjectStatusOverride, dir: string = projectsDir()): void {
  if (!validateProjectOverride(o)) throw new Error(`invalid project override: ${describeValidation(validateProjectOverride.errors)}`);
  assertSafeIdentifier(o.id, "project id");
  writeJsonAtomic(join(dir, `${o.id}.json`), o);
}
