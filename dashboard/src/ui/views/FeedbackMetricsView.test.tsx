// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackMetricsView } from "./FeedbackMetricsView";
import * as api from "../api";
import type { FeedbackMetrics } from "../../../../lib/feedback-metrics";

afterEach(() => vi.restoreAllMocks());

const metrics: FeedbackMetrics = {
  schema_version: 1,
  generated_at: "2026-09-28T12:00:00.000Z",
  recommendations: { actions_recorded: 4, accepted: 2, snoozed: 1, dismissed: 1, pinned: 3, median_evidence_to_action_ms: 90_000, latency_samples: 3 },
  tasks: { total: 5, terminal: 4, completed: 3, retried: 1, needs_review: 1, success_rate: 0.75, retry_rate: 0.2, needs_review_rate: 0.25 },
  verification: { passed: 3, failed: 1, skipped: 0, missing: 0, eligible: 4, pass_rate: 0.75 },
  work_sessions: { total: 3, completed: 2, closed: 3, completed_with_next_action: 1, next_action_captured: 2, completion_rate: 2 / 3, next_action_capture_rate: 2 / 3 },
  signals: { freshness_eligible: 6, stale: 2, stale_rate: 1 / 3 },
};

describe("FeedbackMetricsView", () => {
  it("shows local aggregates without exposing any individual project or task data", async () => {
    const get = vi.spyOn(api, "getFeedbackMetrics").mockResolvedValue(metrics);
    render(<FeedbackMetricsView />);

    await waitFor(() => expect(screen.getByText("Feedback operativo")).toBeInTheDocument());
    expect(screen.getByText("2 aceptadas · 1 pospuestas · 1 descartadas")).toBeInTheDocument();
    expect(screen.getByText("75% completadas")).toBeInTheDocument();
    expect(screen.getByText("2/6 vencidas")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fictional-project-id");
    expect(document.body.textContent).not.toContain("private-task-title");
    expect(get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("renders unavailable local feedback without showing private service details", async () => {
    vi.spyOn(api, "getFeedbackMetrics").mockRejectedValue(new Error("private path D:/private/state"));
    render(<FeedbackMetricsView />);
    await waitFor(() => expect(screen.getByText(/No pude leer las métricas locales/)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("D:/private/state");
  });
});
