// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TodayModel } from "../../../../lib/state/types";
import { TodayView } from "./TodayView";

const task = {
  id: "T-1", project: "alpha", agent: "engineer", title: "Ship evidence", lifecycle: "running" as const,
  outcome: null, updated_at: "2026-09-21T12:00:00Z", finished_at: null, requires_human_approval: true,
  attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
};

const model: TodayModel = {
  date: "2026-09-21", time_zone: "America/Buenos_Aires", generated_at: "2026-09-21T12:00:00Z",
  active: [task], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [], warnings: [],
  counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
};

describe("TodayView", () => {
  it("renders the daily evidence summary and opens a task", () => {
    const onOpenTask = vi.fn();
    render(<TodayView data={model} error={null} onOpenTask={onOpenTask} />);

    expect(screen.getByText("2026-09-21")).toBeInTheDocument();
    expect(screen.getByText("Completadas hoy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /T-1/ }));
    expect(onOpenTask).toHaveBeenCalledWith("T-1");
  });
});
