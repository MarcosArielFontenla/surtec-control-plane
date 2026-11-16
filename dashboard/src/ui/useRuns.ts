import { useRef } from "react";
import type { RunRecord } from "../../../lib/state/types";
import { listRuns } from "./api";
import { usePolling } from "./usePolling";

// Polls /api/runs. Returns the run list (last good value kept on error).
export function useRuns(intervalMs = 2000): { runs: RunRecord[]; error: string | null } {
  const empty = useRef<RunRecord[]>([]);
  const { data, error } = usePolling(listRuns, intervalMs);
  return { runs: data?.runs ?? empty.current, error };
}
