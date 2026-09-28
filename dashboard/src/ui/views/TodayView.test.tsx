// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Signal } from "../../../../lib/signals/types";
import type { TodayModel } from "../../../../lib/state/types";
import { postSignalAction } from "../api";
import { TodayView } from "./TodayView";

vi.mock("../api", () => ({ postSignalAction: vi.fn().mockResolvedValue({}) }));

const task = {
  id: "T-1", project: "alpha", agent: "engineer", title: "Ship evidence", lifecycle: "running" as const,
  outcome: null, updated_at: "2026-09-21T12:00:00Z", finished_at: null, requires_human_approval: true,
  attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
};

function signal(number: number, over: Partial<Signal> = {}): Signal {
  return {
    schema_version: 1, id: `sig_${number.toString(16).padStart(24, "0")}`, project_id: `project-${number}`,
    project_kind: "client", source: "profile", type: "deadline-approaching", severity: "warning",
    title: `Deadline recommendation ${number}`, reason: `Deadline evidence ${number} is due soon.`,
    evidence_at: "2026-09-21T11:00:00Z", observed_at: "2026-09-21T12:00:00Z",
    suggested_action: "Review the recorded next step.", action_kind: "review-deadline",
    ranking: { tier: "imminent-deadline", order: 4 }, state: "open", snoozed_until: null,
    evidence: { deadline: "2026-09-22", days_remaining: 1 }, ...over,
  };
}

function model(signals: Signal[] = [], over: Partial<TodayModel> = {}): TodayModel {
  const visible = signals.slice(0, 3);
  return {
    date: "2026-09-21", time_zone: "America/Buenos_Aires", generated_at: "2026-09-21T12:00:00Z",
    active: [task], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [], warnings: [],
    counts: { active: 1, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 },
    portfolio: {
      signal_status: "available", signals_observed_at: "2026-09-21T12:00:00Z", recommendations: visible,
      critical_attention: [], work_to_continue: [], client_commitments: visible, personal_opportunities: [], stale_profiles: [],
      snoozed_signals: [], pinned_signal_ids: [], warnings: [],
      sessions: { available: false, unavailable_reason: "Persisted work sessions are planned for Phase G.", active: [], paused: [] },
    },
    ...over,
  };
}

describe("TodayView", () => {
  it("renders portfolio recommendations and keeps the existing task activity accessible", () => {
    const onOpenTask = vi.fn();
    render(<TodayView data={model([signal(1)])} error={null} onOpenTask={onOpenTask} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => model()} />);

    expect(screen.getByText("2026-09-21")).toBeInTheDocument();
    expect(screen.getByText("Ahora · recomendaciones principales")).toBeInTheDocument();
    expect(screen.getAllByText("Deadline recommendation 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Completadas hoy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /T-1/ }));
    expect(onOpenTask).toHaveBeenCalledWith("T-1");
    expect(screen.getByText(/Sesiones pausadas y reanudables/)).toBeInTheDocument();
  });

  it("keeps the primary recommendation count at three for an overloaded signal feed", () => {
    const signals = Array.from({ length: 8 }, (_, index) => signal(index + 1));
    render(<TodayView data={model(signals)} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => model()} />);
    const heading = screen.getByText("Ahora · recomendaciones principales").closest("section");
    expect(heading?.querySelectorAll(".today-signal")).toHaveLength(3);
  });

  it("shows a calm healthy empty state and refreshes after a human signal action", async () => {
    const refresh = vi.fn().mockResolvedValue(model());
    const item = signal(9);
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={refresh} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Reconocer/ })[0]!);
    await waitFor(() => expect(postSignalAction).toHaveBeenCalledWith(item.id, { action: "acknowledge" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    const calm = model();
    render(<TodayView data={calm} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => calm} />);
    expect(screen.getByText(/Tu cartera está tranquila/)).toBeInTheDocument();
  });

  it("does not describe unavailable portfolio evidence as a healthy calm state", () => {
    const unavailable = model([], { portfolio: { ...model().portfolio, signal_status: "unavailable" } });
    render(<TodayView data={unavailable} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => unavailable} />);
    expect(screen.getByText(/no está disponible ahora/)).toBeInTheDocument();
    expect(screen.queryByText(/Tu cartera está tranquila/)).not.toBeInTheDocument();
  });

  it("surfaces degraded source warnings without replacing the portfolio page", () => {
    const degraded = model([], { warnings: ["GitHub issue evidence is unavailable."], portfolio: {
      ...model().portfolio, signal_status: "degraded", warnings: ["GitHub issue evidence is unavailable."],
    } });
    render(<TodayView data={degraded} error={null} onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => degraded} />);
    expect(screen.getByText("Inteligencia parcial")).toBeInTheDocument();
    expect(screen.getByText("GitHub issue evidence is unavailable.")).toBeInTheDocument();
  });
});
