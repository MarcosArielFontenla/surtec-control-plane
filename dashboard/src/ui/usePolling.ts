import { useCallback, useEffect, useRef, useState } from "react";

// Per-hook request ownership; interval ticks never queue behind a slow read.
export function usePolling<T>(load: () => Promise<T>, intervalMs: number): {
  data: T | null; error: string | null; refresh: () => Promise<T>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const reader = useRef(load);
  const inFlight = useRef<Promise<T> | null>(null);

  const read = useCallback(() => {
    let loading: Promise<T>;
    try { loading = load(); } catch (reason) { loading = Promise.reject(reason); }
    const request = loading.then((next) => {
      if (active.current && reader.current === load) { setData(next); setError(null); }
      return next;
    }).catch((reason: unknown) => {
      if (active.current && reader.current === load) setError((reason as Error).message);
      throw reason;
    }).finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    inFlight.current = request;
    return request;
  }, [load]);

  const refresh = useCallback(async () => {
    // A post-mutation refresh needs its own later read, not the earlier payload.
    while (inFlight.current) {
      try { await inFlight.current; } catch { /* A previous failure cannot satisfy or refuse this fresh request. */ }
    }
    if (!active.current || reader.current !== load) throw new Error("Polling is not active");
    return read();
  }, [load, read]);

  useEffect(() => {
    active.current = true;
    reader.current = load;
    const tick = () => {
      if (!active.current || inFlight.current) return;
      void read().catch(() => { /* read already records errors; interval ticks have no awaiting caller. */ });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    // Keep the request alive across effect replay; actual unmount ignores its result.
    return () => { active.current = false; clearInterval(timer); };
  }, [intervalMs, load, read]);

  return { data, error, refresh };
}
