import type { TaskOrchestration, TaskRecord } from "./types";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_RUNTIME_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

function positiveInteger(value: string | undefined, fallback: number, maximum?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

export function defaultTaskOrchestration(): TaskOrchestration {
  return {
    attempts: 0,
    max_attempts: positiveInteger(process.env.SURTEC_TASK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 20),
    max_runtime_ms: positiveInteger(process.env.SURTEC_TASK_MAX_RUNTIME_MS, DEFAULT_MAX_RUNTIME_MS, 86_400_000),
    max_total_tokens: positiveInteger(process.env.SURTEC_TASK_MAX_TOTAL_TOKENS, DEFAULT_MAX_TOTAL_TOKENS),
    cumulative_tokens: 0,
    retry_at: null,
    cancel_requested_at: null,
    lease: null,
    last_failure: null,
  };
}

export function ensureTaskOrchestration(record: TaskRecord): TaskOrchestration {
  record.revision ??= 1;
  record.orchestration ??= defaultTaskOrchestration();
  return record.orchestration;
}
