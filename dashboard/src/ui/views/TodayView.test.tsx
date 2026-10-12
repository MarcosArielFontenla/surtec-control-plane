// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Signal } from "../../../../lib/signals/types";
import type { ProjectView, TodayModel } from "../../../../lib/state/types";
import { postSignalAction } from "../api";
import { RoutinePanel } from "../components/RoutinePanel";
import { TodayView } from "./TodayView";

vi.mock("../api", () => ({ postSignalAction: vi.fn().mockResolvedValue({}) }));
vi.mock("../components/RoutinePanel", () => ({
  RoutinePanel: vi.fn(({ projects, refreshKey }: { projects: ProjectView[]; refreshKey: string }) => (
    <section aria-label="Routine integration fixture" data-testid="routine-panel" data-refresh-key={refreshKey}>
      {projects.map(({ id }) => id).join(", ")}
    </section>
  )),
}));

beforeEach(() => vi.clearAllMocks());

const task = {
  id: "T-1", project: "alpha", agent: "engineer", title: "Ship evidence", lifecycle: "running" as const,
  outcome: null, updated_at: "2026-09-21T12:00:00Z", finished_at: null, requires_human_approval: true,
  attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
};

const project: ProjectView = {
  id: "alpha", status: "active", health: null, note: null, repo: null, path: null, configured: false,
  git: null, last_activity: null, task_counts: { inProgress: 0, finished: 0 },
};

function signal(number: number, over: Partial<Signal> = {}): Signal {
  return {
    schema_version: 1, id: `sig_${number.toString(16).padStart(24, "0")}`, project_id: `project-${number}`,
    project_kind: "client-product", source: "profile", type: "deadline-approaching", severity: "warning",
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
      sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
    },
    ...over,
  };
}

describe("TodayView", () => {
  it("mounts the routine panel after work sessions with only discovered projects and the observed Today timestamp", () => {
    const projects = [project];
    const data = model();
    const onRefresh = vi.fn(); const onOpenTask = vi.fn(); const onOpenProject = vi.fn(); const onPrepareTask = vi.fn();
    render(<TodayView data={data} error={null} projects={projects} onOpenTask={onOpenTask}
      onOpenProject={onOpenProject} onPrepareTask={onPrepareTask} onRefresh={onRefresh} />);

    const props = vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0];
    expect(props).toEqual({ projects, refreshKey: data.generated_at });
    expect(props?.projects).toBe(projects);
    const panel = screen.getByTestId("routine-panel");
    expect(panel.previousElementSibling).toContainElement(screen.getByRole("heading", { name: "Sesiones de trabajo" }));
    expect(panel).toHaveAttribute("data-refresh-key", data.generated_at);
    expect(onRefresh).not.toHaveBeenCalled(); expect(postSignalAction).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled(); expect(onOpenProject).not.toHaveBeenCalled(); expect(onPrepareTask).not.toHaveBeenCalled();
  });

  it("updates the routine refresh binding only when a new Today model is rendered", async () => {
    const first = model();
    const second = model([], { generated_at: "2026-09-21T12:01:00Z" });
    const refresh = vi.fn().mockResolvedValue(second);
    const common = { error: null, projects: [project], onOpenTask: vi.fn(), onOpenProject: async () => {},
      onPrepareTask: vi.fn(), onRefresh: refresh };
    const view = render(<TodayView data={first} {...common} />);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar Hoy" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", first.generated_at);

    view.rerender(<TodayView data={second} {...common} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", second.generated_at);
    expect(vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0]).toEqual({ projects: common.projects, refreshKey: second.generated_at });
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("removes the routine panel when Today has no model and mounts it again with the new timestamp", () => {
    const common = { error: null, onOpenTask: vi.fn(), onOpenProject: async () => {},
      onPrepareTask: vi.fn(), onRefresh: async () => model() };
    const view = render(<TodayView data={null} {...common} />);
    expect(screen.queryByTestId("routine-panel")).not.toBeInTheDocument();
    expect(screen.getByText("Cargando Hoy…")).toBeInTheDocument();
    expect(RoutinePanel).not.toHaveBeenCalled();

    view.rerender(<TodayView data={model()} {...common} />);
    expect(vi.mocked(RoutinePanel).mock.calls.at(-1)?.[0]).toEqual({ projects: [], refreshKey: model().generated_at });
    view.rerender(<TodayView data={null} {...common} error="Unavailable fixture" />);
    expect(screen.queryByTestId("routine-panel")).not.toBeInTheDocument();
    expect(screen.getByText(/No pude cargar Hoy/)).toBeInTheDocument();

    const latest = model([], { generated_at: "2026-09-21T12:02:00Z" });
    view.rerender(<TodayView data={latest} {...common} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", latest.generated_at);
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("preserves the routine observation binding and task activity when a Today refresh fails", () => {
    const latest = model();
    render(<TodayView data={latest} error="Unavailable fixture" onOpenTask={vi.fn()} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => latest} />);
    expect(screen.getByTestId("routine-panel")).toHaveAttribute("data-refresh-key", latest.generated_at);
    expect(screen.getByText(/mostrando el último estado conocido/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /T-1/ })).toBeInTheDocument();
    expect(screen.getByText("Actividad de Codex")).toBeInTheDocument();
  });

  it("keeps non-Harness recommendation navigation and explicit task preparation unchanged", async () => {
    const item = signal(1);
    const onOpenProject = vi.fn().mockResolvedValue(undefined); const onPrepareTask = vi.fn();
    render(<TodayView data={model([item])} error={null} onOpenTask={vi.fn()} onOpenProject={onOpenProject}
      onPrepareTask={onPrepareTask} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith(item.project_id));
    fireEvent.click(screen.getByRole("button", { name: "Preparar tarea" }));
    expect(onPrepareTask).toHaveBeenCalledExactlyOnceWith(item);
    expect(screen.getByTestId("routine-panel")).toBeInTheDocument();
    expect(postSignalAction).not.toHaveBeenCalled();
  });

  it("opens Harness evidence without preparing a task or launching the editor", () => {
    const onOpenHarness = vi.fn(); const onOpenProject = vi.fn(); const onPrepareTask = vi.fn();
    render(<TodayView data={model([signal(1, { source: "harness", title: "Harness evidence" })])} error={null} onOpenTask={vi.fn()} onOpenProject={onOpenProject} onOpenHarness={onOpenHarness} onPrepareTask={onPrepareTask} onRefresh={async () => model()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver Harness" })); expect(onOpenHarness).toHaveBeenCalledWith("project-1");
    expect(onOpenProject).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Preparar tarea" })).not.toBeInTheDocument();
  });
  it("renders portfolio recommendations and keeps the existing task activity accessible", () => {
    const onOpenTask = vi.fn();
    render(<TodayView data={model([signal(1)])} error={null} onOpenTask={onOpenTask} onOpenProject={async () => {}}
      onPrepareTask={vi.fn()} onRefresh={async () => model()} projects={[project]} />);

    expect(screen.getByText("2026-09-21")).toBeInTheDocument();
    expect(screen.getByText("Ahora · recomendaciones principales")).toBeInTheDocument();
    expect(screen.getAllByText("Deadline recommendation 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Completadas hoy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /T-1/ }));
    expect(onOpenTask).toHaveBeenCalledWith("T-1");
    expect(screen.getByRole("heading", { name: "Sesiones de trabajo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeInTheDocument();
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
