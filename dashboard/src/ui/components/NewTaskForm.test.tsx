// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { NewTaskForm } from "./NewTaskForm";
import type { ContextPreview } from "../api";

function previewFixture(allowed = true): ContextPreview {
  return { schema_version: 1, fingerprint: "a".repeat(64), allowed, blocked_reasons: allowed ? [] : ["Current capacity denies admission"], runtime_read_limitation: "Subsequent runtime reads are not guaranteed project-only.", manifest: {
    schema_version: 1, fingerprint: "a".repeat(64), project_id: "stock-control", agent_id: "backend-engineer", role_id: "planner", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: ["publication"],
    budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 },
    sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
    routing: { action: "direct", work_scale: "trivial", review_depth: "focused", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: [], requires_red_evidence: false },
  } };
}

function contextResponse(url: string): Response | null {
  if (String(url).endsWith("/context/roles")) return { ok: true, status: 200, json: async () => ({ roles: [
    { id: "planner", display_name: "Planner (Codex profile)", responsibility: "Plan bounded work.", sandbox_ceiling: "read-only", agents: ["backend-engineer"] },
    { id: "reviewer", display_name: "Reviewer (Codex profile)", responsibility: "Review bounded work.", sandbox_ceiling: "read-only", agents: ["backend-engineer"] },
    { id: "software-engineer", display_name: "Software Engineer (Codex profile)", responsibility: "Scoped engineering work.", sandbox_ceiling: "workspace-write", agents: ["backend-engineer"] },
  ] }) } as Response;
  if (String(url).endsWith("/api/context/preview")) return { ok: true, status: 200, json: async () => previewFixture() } as Response;
  return null;
}

async function generatePreview() {
  const button = screen.getByRole("button", { name: "Previsualizar contexto" });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await screen.findByText("Contexto habilitado para este pedido.");
}

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
    const context = contextResponse(url); if (context) return context;
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
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
    await generatePreview();
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks") && (c[1] as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        project: "stock-control",
        agent: "backend-engineer",
        instructions: "Analyze the auth module.",
        sandbox: "read-only", role_id: "planner", preview_fingerprint: "a".repeat(64), client_context_categories: [],
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
    await generatePreview();
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

  it("keeps workspace-write unavailable in the generic task form and directs implementation through Issues", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    const modeSelect = screen.getByLabelText("Modo") as HTMLSelectElement;
    expect(modeSelect.value).toBe("read-only");
    expect((screen.getByRole("option", { name: /Implementar \(workspace-write\)/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("option", { name: /auto-fix/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText(/issue local desde Issues/i)).toBeTruthy();
  });

  it("does not dispatch a write task from the generic form even when auto-fix is available by policy", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    await waitFor(() => expect(screen.getByText("backend-engineer")).toBeTruthy());

    expect((screen.getByRole("option", { name: /auto-fix/ }) as HTMLOptionElement).disabled).toBe(true);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).endsWith("/api/tasks") && (call[1] as RequestInit)?.method === "POST")).toBe(false);
  });

  it("defaults to the safest permitted mode and disables self-verify when checks are absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
      const context = contextResponse(url); if (context) return context;
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
    expect(screen.getByText(/no verification commands/)).toBeTruthy();
  });

  it("blocks dispatch when the project has no contained local checkout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, _init?: RequestInit) => {
      const context = contextResponse(url); if (context) return context;
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
      const context = contextResponse(url); if (context) return context;
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
    await generatePreview();
    fireEvent.click(screen.getByRole("button", { name: /despachar/i }));

    await waitFor(() => expect(screen.getByText(/agent not allowed/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
  });

  it("invalidates preview and resets confidential consent when the task or profile changes", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ });
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Inspect delivery" } });
    fireEvent.click(notes);
    await generatePreview();
    expect(screen.getByRole("button", { name: /despachar/i })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Different task" } });
    expect(notes).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
    await generatePreview();
    fireEvent.change(screen.getByLabelText("Perfil Codex"), { target: { value: "reviewer" } });
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
  });

  it("does not resurrect an issued preview when edits return to the original instructions", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Original task" } });
    await generatePreview();
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Changed task" } });
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Original task" } });
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("treats a profile sandbox ceiling as a ceiling, keeping permitted engineering analysis read-only", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    await screen.findByRole("option", { name: "Software Engineer (Codex profile)" });
    fireEvent.change(screen.getByLabelText("Perfil Codex"), { target: { value: "software-engineer" } });
    expect(screen.getByLabelText("Modo")).toHaveValue("read-only");
    expect(screen.getByRole("option", { name: /Implementar \(workspace-write\)/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
  });

  it("invalidates preview when consent changes and never dispatches blocked previews", async () => {
    render(<NewTaskForm bulkProjectIds={[]} />);
    fireEvent.change(await screen.findByLabelText("Instrucciones"), { target: { value: "Inspect delivery" } });
    await generatePreview();
    fireEvent.click(screen.getByRole("checkbox", { name: /Notas confidenciales/ }));
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => String(url).endsWith("/api/context/preview")
      ? Promise.resolve({ ok: true, json: async () => previewFixture(false) } as Response) : original(url, init)));
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar contexto" }));
    await screen.findByText("Contexto bloqueado: no se puede despachar.");
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
  });

  it("ignores a late preview after editing instructions, including editing back to the original request", async () => {
    const original = globalThis.fetch;
    let resolvePreview!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => String(url).endsWith("/api/context/preview")
      ? new Promise<Response>((resolve) => { resolvePreview = resolve; }) : original(url, init)));
    render(<NewTaskForm bulkProjectIds={[]} />);
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Initial task" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar contexto" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar contexto" }));
    await waitFor(() => expect(resolvePreview).toBeDefined());
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Changed task" } });
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Initial task" } });
    resolvePreview({ ok: true, json: async () => previewFixture() } as Response);
    await waitFor(() => expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled());
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });

  it("ignores a late profile response from the previous project and resets consent", async () => {
    const original = globalThis.fetch;
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/dispatch-options")) {
        const fixture = dispatchOptions();
        return Promise.resolve({ ok: true, json: async () => ({ projects: [fixture.projects[0], { ...fixture.projects[0], project: "second-project" }] }) } as Response);
      }
      if (url.endsWith("/stock-control/context/roles")) return new Promise<Response>((resolve) => { finish = resolve; });
      return original(url, init);
    }));
    render(<NewTaskForm bulkProjectIds={[]} />);
    const notes = await screen.findByRole("checkbox", { name: /Notas confidenciales/ });
    fireEvent.click(notes); expect(notes).toBeChecked();
    fireEvent.change(screen.getByLabelText("Proyecto"), { target: { value: "second-project" } });
    await waitFor(() => expect(screen.getByLabelText("Perfil Codex")).toHaveValue("planner"));
    await act(async () => { finish({ ok: true, json: async () => ({ roles: [{ id: "old-project-role", display_name: "Old project role", sandbox_ceiling: "read-only", agents: ["backend-engineer"] }] }) } as Response); });
    expect(screen.getByLabelText("Proyecto")).toHaveValue("second-project");
    expect(screen.getByLabelText("Perfil Codex")).toHaveValue("planner");
    expect(screen.queryByText("Old project role")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Notas confidenciales/ })).not.toBeChecked();
  });

  it.each(["future-version", "mismatched-role"])("rejects a %s preview response instead of enabling dispatch", async (variant) => {
    const original = globalThis.fetch;
    const fixture = previewFixture();
    if (variant === "future-version") fixture.manifest.schema_version = 2 as never;
    else fixture.manifest.role_id = "unselected-profile";
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/api/context/preview")
      ? Promise.resolve({ ok: true, json: async () => fixture } as Response) : original(url, init)));
    render(<NewTaskForm bulkProjectIds={[]} />);
    fireEvent.change(screen.getByLabelText("Instrucciones"), { target: { value: "Inspect safely" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Previsualizar contexto" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Previsualizar contexto" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /despachar/i })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
  });
});
