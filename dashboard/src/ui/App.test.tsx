// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { OverviewModel } from "../../../lib/state/types";

const overview: OverviewModel = {
  projects: [{
    id: "stock-control", status: "active", health: "ok", note: null,
    repo: null, last_activity: "2026-05-28T11:15:00Z",
    task_counts: { inProgress: 1, finished: 1 },
  }],
  inProgress: [{
    id: "STK-002", project: "stock-control", agent: "qa-reviewer",
    title: "Regression pass", lifecycle: "running", outcome: null,
    updated_at: "2026-05-28T11:15:00Z", finished_at: null, requires_human_approval: false,
  }],
  history: [],
  attention: [{ kind: "risk", task_id: "STK-001", project: "stock-control", title: "No rate limiting" }],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    }
    return { ok: true, status: 200, json: async () => overview };
  }) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("renders projects, in-progress tasks and attention items", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("stock-control")).toBeTruthy());
    expect(screen.getByText(/STK-002/)).toBeTruthy();
    expect(screen.getByText(/No rate limiting/)).toBeTruthy();
  });

  it("shows the error banner when the overview fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/No pude refrescar/)).toBeTruthy());
  });
});
