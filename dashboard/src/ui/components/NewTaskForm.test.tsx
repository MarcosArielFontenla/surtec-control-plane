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

    await waitFor(() => expect(screen.getByText(/Despachado: T-abc/)).toBeTruthy());
  });

  it("dispatches workspace-write when the Implementar mode is selected", async () => {
    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Modo"), { target: { value: "workspace-write" } });
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "Implement X." } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.sandbox).toBe("workspace-write");
      expect(body.self_verify).toBeUndefined(); // plain workspace-write must NOT opt into auto-fix
    });
  });

  it("dispatches self_verify when the auto-fix (verify) mode is selected", async () => {
    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Modo"), { target: { value: "workspace-write-verify" } });
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.sandbox).toBe("workspace-write");
      expect(body.self_verify).toBe(true);
    });
  });

  it("shows an error banner when dispatch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => ({ projects: [{ project: "stock-control", agents: ["backend-engineer"] }] }) } as Response;
      }
      return { ok: false, status: 400, json: async () => ({ error: "agent not allowed" }) } as Response;
    }) as unknown as typeof fetch);

    render(<NewTaskForm />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => expect(screen.getByText(/agent not allowed/)).toBeTruthy());
  });
});
