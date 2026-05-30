// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InProgressColumn } from "./InProgressColumn";
import type { TaskView } from "../../../../lib/state/types";

const task = (id: string, outcome: TaskView["outcome"]): TaskView => ({
  id, project: "p", agent: "backend-engineer", title: `title ${id}`, lifecycle: "finished", outcome, updated_at: "", finished_at: null, requires_human_approval: false,
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
});
