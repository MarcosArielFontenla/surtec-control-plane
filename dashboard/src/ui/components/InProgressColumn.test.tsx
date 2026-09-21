// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InProgressColumn } from "./InProgressColumn";
import type { TaskView } from "../../../../lib/state/types";
import { cancelTask, retryTask } from "../api";

vi.mock("../api", () => ({ cancelTask: vi.fn(), retryTask: vi.fn() }));

const task = (id: string, outcome: TaskView["outcome"]): TaskView => ({
  id, project: "p", agent: "backend-engineer", title: `title ${id}`, lifecycle: "finished", outcome, updated_at: "", finished_at: null, requires_human_approval: false,
  attempts: 1, max_attempts: 3, retry_at: null, cancel_requested_at: null,
});

describe("InProgressColumn", () => {
  it("shows the empty state when nothing is running", () => {
    render(<InProgressColumn inProgress={[]} history={[]} />);
    expect(screen.getByText("Nada por ahora")).toBeInTheDocument();
  });
  it("lists running tasks and recent history with outcome badges", () => {
    render(<InProgressColumn inProgress={[task("T9", null)]} history={[task("T1", "completed"), task("T2", "failed")]} />);
    expect(screen.getByText("title T9")).toBeInTheDocument();
    expect(screen.getByText("Historial reciente")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("offers cancellation for active work and retry for eligible failures", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    vi.mocked(cancelTask).mockResolvedValue();
    vi.mocked(retryTask).mockResolvedValue();
    const active = { ...task("T9", null), lifecycle: "running" as const };

    render(<InProgressColumn inProgress={[active]} history={[task("T2", "failed")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(cancelTask).toHaveBeenCalledWith("T9"));
    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("T2"));
    vi.unstubAllGlobals();
  });
});
