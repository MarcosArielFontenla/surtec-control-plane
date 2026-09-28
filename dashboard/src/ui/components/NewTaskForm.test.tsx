// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NewTaskForm } from "./NewTaskForm";

function dispatchOptions(overrides: { hasCheckout?: boolean; hasVerification?: boolean } = {}) {
  const hasCheckout = overrides.hasCheckout ?? true;
  const hasVerification = overrides.hasVerification ?? true;
  const writeAllowed = hasCheckout;
  const verifyAllowed = hasCheckout && hasVerification;
  return {
    projects: [{
      project: "stock-control",
      allowed_agents: ["backend-engineer"],
      project_sandbox_ceiling: "workspace-write",
      has_local_checkout: hasCheckout,
      has_verification_commands: hasVerification,
      agents: [{
        agent: "backend-engineer",
        agent_sandbox_ceiling: "workspace-write",
        allowed_modes: ["read-only", ...(writeAllowed ? ["workspace-write"] : []), ...(verifyAllowed ? ["workspace-write-verify"] : [])],
        default_mode: hasCheckout ? "read-only" : null,
        modes: [
          { mode: "read-only", allowed: hasCheckout, reason: hasCheckout ? null : "project has no contained local git checkout" },
          { mode: "workspace-write", allowed: writeAllowed, reason: writeAllowed ? null : "project has no contained local git checkout" },
          { mode: "workspace-write-verify", allowed: verifyAllowed, reason: !hasCheckout ? "project has no contained local git checkout" : hasVerification ? null : "project has no verification commands" },
        ],
      }],
    }],
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).endsWith("/api/session")) {
      return { ok: true, status: 200, json: async () => ({ token: "test-session-token" }) } as Response;
    }
    if (String(url).endsWith("/api/dispatch-options")) {
      return { ok: true, status: 200, json: async () => dispatchOptions() } as Response;
    }
    if (String(url).includes("/client-context-options")) {
      return { ok: true, status: 200, json: async () => ({
        available: true,
        categories: ["client-identity", "project-outcome", "active-commitments", "service-context", "confidential-notes"],
      }) } as Response;
    }
    return { ok: true, status: 201, json: async () => ({ id: "T-abc" }) } as Response;
  }) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("NewTaskForm", () => {
  it("loads options and dispatches a task with the entered instructions", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
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

  it("shares only explicitly selected client categories and leaves every category unchecked by default", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());
    const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ }) as HTMLInputElement;
    expect(notes.checked).toBe(false);
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "Review the delivery." } });
    fireEvent.click(notes);
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((call) => String(call[0]).endsWith("/api/tasks") && (call[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        client_context_categories: ["confidential-notes"],
      });
    });
  });

  it("prefills the selected project and suggested next action from a Today recommendation", async () => {
    const consumed = vi.fn();
    render(<NewTaskForm bulkProjectIds={[]} initialProject="stock-control"
      initialInstructions="Inspect the failing deployment. Evidence: health is degraded." onPrefillConsumed={consumed} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());
    expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe("stock-control");
    expect((screen.getByPlaceholderText(/instrucciones/i) as HTMLTextAreaElement).value)
      .toBe("Inspect the failing deployment. Evidence: health is degraded.");
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("dispatches workspace-write when the Implementar mode is selected", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
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
    render(<NewTaskForm bulkProjectIds={[]} />);
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

  it("defaults to the safest permitted mode and disables self-verify when checks are absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/api/session")) {
        return { ok: true, status: 200, json: async () => ({ token: "test-session-token" }) } as Response;
      }
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => dispatchOptions({ hasVerification: false }) } as Response;
      }
      return { ok: true, status: 201, json: async () => ({ id: "T-abc" }) } as Response;
    }) as unknown as typeof fetch);

    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    const modeSelect = screen.getByLabelText("Modo") as HTMLSelectElement;
    const verifyOption = screen.getByRole("option", { name: /auto-fix/ }) as HTMLOptionElement;
    expect(modeSelect.value).toBe("read-only");
    expect(verifyOption.disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("no verification commands");
  });

  it("blocks dispatch when the project has no contained local checkout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/api/session")) {
        return { ok: true, status: 200, json: async () => ({ token: "test-session-token" }) } as Response;
      }
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => dispatchOptions({ hasCheckout: false }) } as Response;
      }
      return { ok: true, status: 201, json: async () => ({ id: "T-abc" }) } as Response;
    }) as unknown as typeof fetch);

    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText(/no tiene un checkout local contenido/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /despachar/i }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an error banner when dispatch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/session")) {
        return { ok: true, status: 200, json: async () => ({ token: "test-session-token" }) } as Response;
      }
      if (String(url).endsWith("/api/dispatch-options")) {
        return { ok: true, status: 200, json: async () => dispatchOptions() } as Response;
      }
      return { ok: false, status: 400, json: async () => ({ error: "agent not allowed" }) } as Response;
    }) as unknown as typeof fetch);

    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/instrucciones/i), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => expect(screen.getByText(/agent not allowed/)).toBeTruthy());
  });
});
