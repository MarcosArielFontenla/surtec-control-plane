import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { TaskRecord, ProjectStatusOverride } from "./types";
import { tasksDir, projectsDir } from "./paths";
import { assertSafeIdentifier } from "../security/identifiers";
import { describeValidation, validateProjectOverride, validateTaskRecord } from "./validation";

export function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
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
