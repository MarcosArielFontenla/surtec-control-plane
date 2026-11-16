// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewModel, RunRecord, TodayModel } from "../../../lib/state/types";
import { useOverview, useToday } from "./api";
import { useRuns } from "./useRuns";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
interface RequestTicket {
  path: string;
  init: RequestInit | undefined;
  response: Deferred<Response>;
}
let requests: RequestTicket[] = [];
function ticket(index: number): RequestTicket {
  const value = requests[index];
  expect(value).toBeDefined();
  if (!value) throw new Error("Synthetic polling request is missing");
  return value;
}
const response = (body: unknown): Response => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
async function reply(read: RequestTicket, body: unknown): Promise<void> {
  await act(async () => { read.response.resolve(response(body)); await Promise.resolve(); });
}
async function fail(read: RequestTicket, error: Error): Promise<void> {
  await act(async () => { read.response.reject(error); await Promise.resolve(); });
}
async function advance(milliseconds: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const observe = <T,>(pending: Promise<T>): Promise<Outcome<T>> => pending.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);
function expectInactive(outcome: Outcome<TodayModel>): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok || !(outcome.error instanceof Error)) throw new Error("Synthetic inactive polling expected an Error");
  expect(outcome.error.message).toBe("Polling is not active");
}
function today(note: string): TodayModel {
  return {
    date: "2026-10-30", time_zone: "UTC", generated_at: "2026-10-30T12:00:00Z",
    active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
    counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 }, warnings: [note],
    portfolio: {
      signal_status: "unavailable", signals_observed_at: null, recommendations: [], critical_attention: [],
      work_to_continue: [], client_commitments: [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [],
      pinned_signal_ids: [], warnings: [],
      sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
    },
  };
}
interface PollingCase {
  name: string;
  path: string;
  interval: number;
  initial: unknown;
  useHook: (interval?: number) => { value: unknown; error: string | null };
  payload: (note: string) => { body: unknown; value: unknown };
}
const cases: PollingCase[] = [
  {
    name: "Overview", path: "/api/overview", interval: 3_000, initial: null,
    useHook(interval) { const result = useOverview(interval); return { value: result.data, error: result.error }; },
    payload(note) {
      const value: OverviewModel = { projects: [], inProgress: [], history: [],
        attention: [{ kind: "risk", task_id: "T-synthetic", project: "synthetic-project", title: note }] };
      return { body: value, value };
    },
  },
  {
    name: "Today", path: "/api/today", interval: 3_000, initial: null,
    useHook(interval) { const result = useToday(interval); return { value: result.data, error: result.error }; },
    payload(note) { const value = today(note); return { body: value, value }; },
  },
  {
    name: "Runs", path: "/api/runs", interval: 2_000, initial: [],
    useHook(interval) { const result = useRuns(interval); return { value: result.runs, error: result.error }; },
    payload(note) {
      const value: RunRecord[] = [{ runId: "R-" + note, projectId: "synthetic-project", kind: "oneshot",
        command: "node --version", status: "exited", pid: null, startedAt: "2026-10-30T12:00:00Z",
        endedAt: "2026-10-30T12:00:01Z", exitCode: 0 }];
      return { body: { runs: value }, value };
    },
  },
];
function StrictWrapper({ children }: PropsWithChildren) { return <StrictMode>{children}</StrictMode>; }

beforeEach(() => {
  requests = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pending = deferred<Response>();
    requests.push({ path: String(input), init, response: pending });
    return pending.promise;
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(cases)("$name background polling", (polling) => {
  it("keeps its default cadence and admits no second read while headers or JSON are pending", async () => {
    const hook = renderHook(() => polling.useHook());
    expect(requests).toHaveLength(1); expect(ticket(0).path).toBe(polling.path);
    expect(hook.result.current).toEqual({ value: polling.initial, error: null });
    await advance(polling.interval * 2); expect(requests).toHaveLength(1);
    const body = deferred<unknown>(), value = polling.payload("first");
    await reply(ticket(0), body.promise);
    await advance(polling.interval * 2); expect(requests).toHaveLength(1);
    await act(async () => { body.resolve(value.body); await Promise.resolve(); });
    expect(hook.result.current.value).toBe(value.value); expect(hook.result.current.error).toBeNull();
    expect(requests).toHaveLength(1);
    await advance(polling.interval - 1); expect(requests).toHaveLength(1);
    await advance(1); expect(requests).toHaveLength(2);
    expect(requests.every((read) => read.path === polling.path && read.init?.signal === undefined)).toBe(true);
  });

  it("releases a failed read, retains the last good value and clears its error after recovery", async () => {
    const hook = renderHook(() => polling.useHook()), first = polling.payload("last-good"), recovered = polling.payload("recovered");
    await reply(ticket(0), first.body);
    await advance(polling.interval); expect(requests).toHaveLength(2);
    const error = new Error("Synthetic " + polling.name + " read failed");
    await fail(ticket(1), error);
    expect(hook.result.current.value).toBe(first.value); expect(hook.result.current.error).toBe(error.message);
    expect(requests).toHaveLength(2);
    await advance(polling.interval); expect(requests).toHaveLength(3);
    await reply(ticket(2), recovered.body);
    expect(hook.result.current.value).toBe(recovered.value); expect(hook.result.current.error).toBeNull();
  });

  it("retains request ownership across an interval rerender and resumes only the new cadence", async () => {
    const hook = renderHook(({ interval }) => polling.useHook(interval),
      { initialProps: { interval: undefined as number | undefined } });
    expect(requests).toHaveLength(1);
    const nextInterval = polling.interval * 2;
    hook.rerender({ interval: nextInterval });
    await advance(nextInterval * 2); expect(requests).toHaveLength(1);
    const value = polling.payload("after-rerender");
    await reply(ticket(0), value.body);
    expect(hook.result.current.value).toBe(value.value);
    await advance(nextInterval - 1); expect(requests).toHaveLength(1);
    await advance(1); expect(requests).toHaveLength(2);
  });

  it("stops ticks on unmount and ignores a late result without aborting the existing fetch", async () => {
    const hook = renderHook(() => polling.useHook());
    expect(requests).toHaveLength(1); hook.unmount();
    await advance(polling.interval * 10); expect(requests).toHaveLength(1);
    await reply(ticket(0), polling.payload("after-unmount").body);
    expect(hook.result.current).toEqual({ value: polling.initial, error: null });
    await advance(polling.interval * 2); expect(requests).toHaveLength(1);
    expect(ticket(0).init?.signal).toBeUndefined();
  });

  it("keeps one pending read through StrictMode effect replay and publishes its first result", async () => {
    const hook = renderHook(() => polling.useHook(), { wrapper: StrictWrapper });
    expect(requests).toHaveLength(1);
    await advance(polling.interval * 3); expect(requests).toHaveLength(1);
    const first = polling.payload("strict-first");
    await reply(ticket(0), first.body);
    expect(hook.result.current.value).toBe(first.value); expect(hook.result.current.error).toBeNull();
    await advance(polling.interval); expect(requests).toHaveLength(2);
    const next = polling.payload("strict-next"); await reply(ticket(1), next.body);
    expect(hook.result.current.value).toBe(next.value);
    expect(requests.every((read) => read.init?.signal === undefined)).toBe(true);
  });

  it("keeps independent hook instances from blocking or publishing into one another", async () => {
    const first = renderHook(() => polling.useHook()), second = renderHook(() => polling.useHook());
    expect(requests).toHaveLength(2);
    const secondValue = polling.payload("second-instance");
    await reply(ticket(1), secondValue.body);
    await advance(polling.interval); expect(requests).toHaveLength(3);
    const nextSecondValue = polling.payload("second-next"); await reply(ticket(2), nextSecondValue.body);
    const firstValue = polling.payload("first-instance"); await reply(ticket(0), firstValue.body);
    expect(first.result.current.value).toBe(firstValue.value);
    expect(second.result.current.value).toBe(nextSecondValue.value);
    expect(first.result.current.error).toBeNull(); expect(second.result.current.error).toBeNull();
  });
});

describe("Today explicit refresh", () => {
  it("waits for a previous poll to settle but always returns its own later GET, including after a prior failure", async () => {
    for (const previous of ["success", "failure"] as const) {
      const base = requests.length, hook = renderHook(() => useToday());
      expect(requests).toHaveLength(base + 1);
      let refreshed!: Promise<Outcome<TodayModel>>;
      act(() => { refreshed = observe(hook.result.current.refresh()); });
      await advance(9_000); expect(requests).toHaveLength(base + 1);
      if (previous === "success") await reply(ticket(base), today("earlier-poll"));
      else await fail(ticket(base), new Error("Synthetic previous poll failed"));
      expect(requests).toHaveLength(base + 2);
      const settled = vi.fn(); void refreshed.then(settled);
      expect(settled).not.toHaveBeenCalled();
      await advance(6_000); expect(requests).toHaveLength(base + 2);
      const fresh = today("manual-" + previous);
      await reply(ticket(base + 1), fresh);
      expect(await refreshed).toEqual({ ok: true, value: fresh });
      expect(hook.result.current.data).toBe(fresh); expect(hook.result.current.error).toBeNull();
      hook.unmount();
    }
  });

  it("serializes concurrent refresh callers into separate fresh reads and keeps automatic ticks behind them", async () => {
    const hook = renderHook(() => useToday());
    await reply(ticket(0), today("initial"));
    let first!: Promise<Outcome<TodayModel>>, second!: Promise<Outcome<TodayModel>>;
    act(() => { first = observe(hook.result.current.refresh()); second = observe(hook.result.current.refresh()); });
    expect(requests).toHaveLength(2);
    await advance(6_000); expect(requests).toHaveLength(2);
    const firstValue = today("first-manual"); await reply(ticket(1), firstValue);
    expect(await first).toEqual({ ok: true, value: firstValue });
    expect(requests).toHaveLength(3);
    await advance(6_000); expect(requests).toHaveLength(3);
    const secondValue = today("second-manual"); await reply(ticket(2), secondValue);
    expect(await second).toEqual({ ok: true, value: secondValue });
    expect(hook.result.current.data).toBe(secondValue); expect(hook.result.current.error).toBeNull();
    await advance(3_000); expect(requests).toHaveLength(4);
    expect(requests.every((read) => read.init?.signal === undefined)).toBe(true);
  });

  it("propagates its own failure, preserves good data and releases the next automatic recovery", async () => {
    const hook = renderHook(() => useToday()), good = today("last-good");
    await reply(ticket(0), good);
    let refreshed!: Promise<Outcome<TodayModel>>;
    act(() => { refreshed = observe(hook.result.current.refresh()); });
    expect(requests).toHaveLength(2);
    const error = new Error("Synthetic explicit refresh failed");
    await fail(ticket(1), error);
    expect(await refreshed).toEqual({ ok: false, error });
    expect(hook.result.current.data).toBe(good); expect(hook.result.current.error).toBe(error.message);
    expect(requests).toHaveLength(2);
    await advance(3_000); expect(requests).toHaveLength(3);
    const recovered = today("automatic-recovery"); await reply(ticket(2), recovered);
    expect(hook.result.current.data).toBe(recovered); expect(hook.result.current.error).toBeNull();
  });

  it("rejects a refresh waiting across unmount without starting a deferred GET or cancelling the prior read", async () => {
    const hook = renderHook(() => useToday()), refresh = hook.result.current.refresh;
    let waiting!: Promise<Outcome<TodayModel>>;
    act(() => { waiting = observe(refresh()); });
    expect(requests).toHaveLength(1); hook.unmount();
    await advance(9_000); expect(requests).toHaveLength(1);
    await reply(ticket(0), today("late-poll"));
    expectInactive(await waiting);
    expect(requests).toHaveLength(1); expect(hook.result.current.data).toBeNull();
    expectInactive(await observe(refresh()));
    expect(requests).toHaveLength(1); expect(ticket(0).init?.signal).toBeUndefined();
  });
});
