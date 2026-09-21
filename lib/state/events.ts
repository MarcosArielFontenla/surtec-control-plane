import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent, TaskEventType } from "./types";
import { eventsDir } from "./paths";
import { assertSafeIdentifier } from "../security/identifiers";
import { safeJson } from "../security/redaction";
import { describeValidation, validateTaskEvent } from "./validation";
import { withStateLock } from "./store";

export interface AppendTaskEventInput {
  task_id: string;
  type: TaskEventType;
  revision: number;
  run_id?: string | null;
  attempt?: number | null;
  payload?: Record<string, unknown>;
  at?: string;
}

export function appendTaskEvent(input: AppendTaskEventInput, dir: string = eventsDir()): TaskEvent {
  assertSafeIdentifier(input.task_id, "task id");
  const event: TaskEvent = {
    event_id: randomUUID(),
    task_id: input.task_id,
    type: input.type,
    at: input.at ?? new Date().toISOString(),
    revision: input.revision,
    run_id: input.run_id ?? null,
    attempt: input.attempt ?? null,
    payload: input.payload ?? {},
  };
  if (!validateTaskEvent(event)) throw new Error(`invalid task event: ${describeValidation(validateTaskEvent.errors)}`);
  mkdirSync(dir, { recursive: true });
  withStateLock(`event-${input.task_id}`, () => {
    appendFileSync(join(dir, `${input.task_id}.jsonl`), `${safeJson(event)}\n`, "utf8");
  }, join(dir, ".locks"));
  return event;
}

export function readTaskEvents(taskId: string, dir: string = eventsDir()): TaskEvent[] {
  assertSafeIdentifier(taskId, "task id");
  const path = join(dir, `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!validateTaskEvent(value)) {
        throw new Error(`invalid task event at line ${index + 1}: ${describeValidation(validateTaskEvent.errors)}`);
      }
      return value;
    });
}
