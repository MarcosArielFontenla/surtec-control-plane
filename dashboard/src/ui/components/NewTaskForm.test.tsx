// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NewTaskForm } from "./NewTaskForm";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => ({ projects: [{ project: "stock-control", agents: ["backend-engineer"] }] }) } as Response;
    }
    return { ok: true, status: 201, json: async () => ({ id: "T-abc" }) } as Response;
  }) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("NewTaskForm", () => {
  it("loads options and dispatches a task with the entered instructions", async () => {
    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    const textarea = screen.getByPlaceholderText(/instrucciones/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Analyze the auth module." } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        project: "stock-control",
        agent: "backend-engineer",
        instructions: "Analyze the auth module.",
      });
    });
  });
});
