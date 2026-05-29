import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { TaskRecord, ProjectStatusOverride } from "./types";
import { tasksDir, projectsDir } from "./paths";

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function readJsonDir<T>(dir: string, label: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
    } catch (err) {
      console.warn(`[store] skipping unreadable ${label} file ${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function writeTask(record: TaskRecord, dir: string = tasksDir()): void {
  writeJsonAtomic(join(dir, `${record.envelope.id}.json`), record);
}

export function readTask(id: string, dir: string = tasksDir()): TaskRecord | null {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as TaskRecord;
}

export function listTasks(dir: string = tasksDir()): TaskRecord[] {
  return readJsonDir<TaskRecord>(dir, "task");
}

export function listProjectOverrides(dir: string = projectsDir()): ProjectStatusOverride[] {
  return readJsonDir<ProjectStatusOverride>(dir, "project");
}

export function upsertProjectOverride(o: ProjectStatusOverride, dir: string = projectsDir()): void {
  writeJsonAtomic(join(dir, `${o.id}.json`), o);
}
