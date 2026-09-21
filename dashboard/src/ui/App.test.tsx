// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { OverviewModel, TodayModel } from "../../../lib/state/types";

const overview: OverviewModel = {
  projects: [{
    id: "stock-control", status: "active", health: "ok", note: null,
    repo: null, path: null, configured: false, git: null,
    last_activity: "2026-05-28T11:15:00Z",
    task_counts: { inProgress: 1, finished: 1 },
  }],
  inProgress: [{
    id: "STK-002", project: "stock-control", agent: "qa-reviewer",
    title: "Regression pass", lifecycle: "running", outcome: null,
    updated_at: "2026-05-28T11:15:00Z", finished_at: null, requires_human_approval: false,
    attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
  }],
  history: [],
  attention: [{ kind: "risk", task_id: "STK-001", project: "stock-control", title: "No rate limiting" }],
};

const today: TodayModel = {
  date: "2026-09-21", time_zone: "America/Buenos_Aires", generated_at: "2026-09-21T12:00:00Z",
  active: overview.inProgress, attention: overview.attention, completed: [], failed: [], cancelled: [],
  retries: [], cancellations: [], recoveries: [], warnings: [],
  counts: { active: 1, attention: 1, completed: 0, failed: 0, cancelled: 0, retries: 0 },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    }
    if (String(url).endsWith("/api/runs")) {
      return { ok: true, status: 200, json: async () => ({ runs: [] }) };
    }
    if (String(url).endsWith("/api/today")) {
      return { ok: true, status: 200, json: async () => today };
    }
    return { ok: true, status: 200, json: async () => overview };
  }) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("opens on Today and can navigate to the portfolio overview", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Jornada operativa")).toBeTruthy());
    expect(screen.getAllByText(/STK-002/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    await waitFor(() => expect(screen.getByText("stock-control")).toBeTruthy());
    expect(screen.getAllByText(/STK-002/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No rate limiting/)).toBeTruthy();
  });

  it("shows the error banner when the overview fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => ({ projects: [] }) } as Response;
      }
      if (String(url).endsWith("/api/runs")) return { ok: true, status: 200, json: async () => ({ runs: [] }) } as Response;
      throw new Error("network down");
    }) as unknown as typeof fetch);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/No pude cargar Hoy/)).toBeTruthy());
  });
});
