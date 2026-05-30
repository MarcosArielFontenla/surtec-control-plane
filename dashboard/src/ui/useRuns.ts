import { useEffect, useState } from "react";
import type { RunRecord } from "../../../lib/state/types";
import { listRuns } from "./api";

// Polls /api/runs. Returns the run list (last good value kept on error).
export function useRuns(intervalMs = 2000): { runs: RunRecord[]; error: string | null } {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await listRuns();
        if (active) { setRuns(next.runs); setError(null); }
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);

  return { runs, error };
}
