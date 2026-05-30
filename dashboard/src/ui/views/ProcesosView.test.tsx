// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProcesosView } from "./ProcesosView";
import * as api from "../api";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getProjectCommands").mockResolvedValue({
    commands: { dev: "npm run dev", build: "npm run build", test: "npm test" },
    running: { dev: null, oneshot: null },
  });
  // RunConsole opens an EventSource; stub it so the view can mount one.
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    addEventListener() {} close() {}
  };
});

describe("ProcesosView", () => {
  it("lists a project's commands and runs one", async () => {
    const runProject = vi.spyOn(api, "runProject").mockResolvedValue({ runId: "r1" });
    render(<ProcesosView projectIds={["expense-tracker-mvp"]} />);

    const runDev = await screen.findByRole("button", { name: /dev/i });
    fireEvent.click(runDev);
    await waitFor(() => expect(runProject).toHaveBeenCalledWith("expense-tracker-mvp", "dev"));
  });

  it("shows Detener for a running slot and stops it", async () => {
    vi.spyOn(api, "getProjectCommands").mockResolvedValue({
      commands: { dev: "npm run dev" },
      running: { dev: "r9", oneshot: null },
    });
    const stopRun = vi.spyOn(api, "stopRun").mockResolvedValue();
    render(<ProcesosView projectIds={["expense-tracker-mvp"]} />);

    const stop = await screen.findByRole("button", { name: /detener/i });
    fireEvent.click(stop);
    await waitFor(() => expect(stopRun).toHaveBeenCalledWith("r9"));
  });
});
