import { listTasks, writeTask } from "../lib/state/store";
import { failureResult } from "./result";

export function reconcileRunning(): number {
  let n = 0;
  for (const rec of listTasks()) {
    if (rec.lifecycle !== "running") continue;
    const end = new Date().toISOString();
    rec.lifecycle = "finished";
    rec.finished_at = end;
    rec.updated_at = end;
    rec.outcome = "failed";
    rec.result = failureResult(rec.envelope, "interrupted by server restart", rec.logs_path ?? "");
    writeTask(rec);
    n++;
  }
  return n;
}
