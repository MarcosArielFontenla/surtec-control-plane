import { mapPaperclipTaskToTaskEnvelope } from "./mapper.js";
import type { PaperclipTask, TaskEnvelope } from "./types.js";

export function convertPaperclipTask(task: PaperclipTask): TaskEnvelope {
  return mapPaperclipTaskToTaskEnvelope(task);
}

export type { AgentResult, PaperclipTask, TaskEnvelope } from "./types.js";

