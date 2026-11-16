import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent, TaskEventType } from "./types";
import { eventsDir, stateRootForStoreDirectory } from "./paths";
import { assertSafeIdentifier } from "../security/identifiers";
import { safeJson } from "../security/redaction";
import { describeValidation, validateTaskEvent } from "./validation";
import { withStateLock } from "./store";
import { assertMaintenanceMutation, withMaintenanceMutation } from "./maintenance";

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
  const root = stateRootForStoreDirectory(dir, "events");
  return withMaintenanceMutation(root, () => appendTaskEventOwned(input, dir, root));
}

function appendTaskEventOwned(input: AppendTaskEventInput, dir: string, root: string): TaskEvent {
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
  assertMaintenanceMutation(root);
  mkdirSync(dir, { recursive: true });
  withStateLock(`event-${input.task_id}`, () => {
    const line = `${safeJson(event)}\n`;
    assertMaintenanceMutation(root);
    appendFileSync(join(dir, `${input.task_id}.jsonl`), line, "utf8");
  }, join(dir, ".locks"), root);
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
