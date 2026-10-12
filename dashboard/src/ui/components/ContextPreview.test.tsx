// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContextManifestEvidence, ContextPreview, useContextPreview } from "./ContextPreview";
import { previewContext, dispatchWorkIssue, type ContextPreview as Preview } from "../api";
import * as api from "../api";
import type { BudgetPreview } from "../../server/budget-service";

const preview: Preview = { schema_version: 1, fingerprint: "a".repeat(64), allowed: true, blocked_reasons: [], runtime_read_limitation: "Runtime reads are not guaranteed project-only.", manifest: {
  schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "planner", agent_id: "tech-lead", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: ["scope-change"],
  budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, total_lines: 12, total_bytes: 200,
  sources: [{ id: "project/AGENTS.md", layer: "instructions", source_type: "instruction", revision: "b".repeat(64), reason: "Selected mandatory instructions", bytes: 200, lines: 12, sensitivity: "local" }],
  selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: ["Optional objective missing"],
  routing: { action: "planning", work_scale: "bounded", review_depth: "full", qa_required: true, reasons: ["Two affected domains"], delegation: { admitted: false, executable: false, reasons: ["Execution unavailable"] } },
  testing: { mode: "functional", minimum_review_depth: "full", runner_ids: [], commands: ["node verify.mjs"], reasons: ["Trusted policy"], requires_red_evidence: false },
} };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function unavailableBudget(): BudgetPreview {
  return { schema_version: 1, observed_at: "2026-10-11T12:00:00Z", status: "unavailable", can_admit: false,
    executable: false, reserves_capacity: false, ledger: { status: "unavailable", revision: null, updated_at: null },
    binding: null, resolution: null, prospective_hold: null,
    denials: [{ code: "budget-ledger-unavailable", source_ids: ["ledger:unavailable"] }],
    limitation: "Informational preview only; no execution authority." };
}

function boundBudget(issueId: string | null = null): BudgetPreview {
  return { ...unavailableBudget(), binding: { attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"],
    issue_id: issueId, role_id: "planner", execution_id: "preview-context-only" }, cap_fingerprint: "c".repeat(64), policy_bindings: [],
    ceilings: { attempts: 1, runtime_ms: 60000, total_tokens: 10000, concurrent_reads: 1, concurrent_writes: 0, review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0 } } };
}

function PreviewHarness({ project = "alpha" }: { project?: string }) {
  const state = useContextPreview({ kind: "analysis", project, agent: "tech-lead", role_id: "planner", instructions: "Inspect synthetic evidence", client_context_categories: [] });
  return <><button onClick={() => void state.requestPreview()}>Request preview</button>{state.preview && <ContextPreview preview={state.preview} />}</>;
}

describe("safe context evidence", () => {
  it("renders attributable policy, limits, privacy, fingerprints and the runtime limitation, not private bodies", () => {
    const extra = { ...preview, rendered: "Private prompt body", manifest: { ...preview.manifest, private_body: "Confidential client text" } };
    render(<ContextPreview preview={extra} />);
    expect(screen.getAllByRole("region", { name: /preview de contexto/i })).toHaveLength(1);
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
    expect(screen.getByText(/12 \/ 500 líneas/)).toBeInTheDocument();
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("project/AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("b".repeat(64), { exact: false })).toBeInTheDocument();
    expect(screen.getByText("confidential-notes")).toBeInTheDocument();
    expect(screen.getByText("Runtime reads are not guaranteed project-only.")).toBeInTheDocument();
    expect(screen.queryByText("Private prompt body")).toBeNull();
    expect(screen.queryByText("Confidential client text")).toBeNull();
    expect(screen.getByText(/no demuestra que los checks/)).toBeInTheDocument();
  });

  it("shows blocked reasons and redacts known credentials and absolute paths in persisted command evidence", () => {
    render(<ContextPreview preview={{ ...preview, allowed: false, blocked_reasons: ["Changed issue revision"], manifest: {
      ...preview.manifest, testing: { ...preview.manifest.testing, commands: ["node C:\\private\\check.mjs api_key=synthetic-sensitive-value", "node /repo/private/check.mjs"] },
    } }} />);
    expect(screen.getByText("Changed issue revision")).toBeInTheDocument();
    expect(screen.getByText("Contexto bloqueado: no se puede despachar.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("synthetic-sensitive-value");
    expect(document.body.textContent).not.toContain("C:\\private");
    expect(document.body.textContent).not.toContain("/repo/private");
    expect(document.body.textContent).toContain("[LOCAL_PATH]");
  });

  it("does not infer authorization from an unknown manifest version", () => {
    render(<ContextManifestEvidence manifest={{ ...preview.manifest, schema_version: 2 } as never} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no se interpreta como autorización");
    expect(screen.queryByText("planner")).toBeNull();
  });

  it("uses protected explicit preview and issue dispatch requests with no client-authored manifest", async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/api/session") ? { token: "synthetic-session-token" } : preview } as Response));
    vi.stubGlobal("fetch", fetch);
    const request = { kind: "issue" as const, project: "alpha", agent: "tech-lead", role_id: "planner", issue_id: "I-1", expected_revision: 3, client_context_categories: [] };
    await previewContext(request);
    await dispatchWorkIssue("I-1", 3, "tech-lead", { role_id: "planner", preview_fingerprint: preview.fingerprint, client_context_categories: [] });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("/api/session");
    expect(calls[1][0]).toBe("/api/context/preview");
    expect(new Headers(calls[1][1].headers).get("X-Surtec-Session")).toBe("synthetic-session-token");
    expect(JSON.parse(calls[1][1].body as string)).toEqual(request);
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ expected_revision: 3, agent: "tech-lead", role_id: "planner", preview_fingerprint: preview.fingerprint, client_context_categories: [] });
  });

  it("keeps missing additive budget evidence unavailable without fetching a different scope or changing context authority", () => {
    const fetchBudget = vi.spyOn(api, "fetchBudgets").mockRejectedValue(new Error("A preview must not fetch project availability"));
    render(<ContextPreview preview={preview} />);
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(summary).toBeInTheDocument();
    expect(within(summary).getByText("Presupuesto no disponible.")).toBeInTheDocument();
    expect(within(summary).queryByRole("button")).toBeNull();
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
    expect(fetchBudget).not.toHaveBeenCalled();
  });

  it("shows unavailable budget diagnostics independently from an allowed context and performs no mutation", () => {
    const fetchBudget = vi.spyOn(api, "fetchBudgets"), dispatch = vi.spyOn(api, "dispatchWorkIssue"), workflow = vi.spyOn(api, "startWorkflow");
    render(<ContextPreview preview={{ ...preview, budget_preview: unavailableBudget() }} />);
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(within(summary).getByText("budget-ledger-unavailable", { exact: false })).toBeInTheDocument();
    expect(within(summary).getByText("Disponibilidad informativa: no disponible.")).toBeInTheDocument();
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
    expect(document.body.textContent).toContain(preview.fingerprint);
    expect(fetchBudget).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(workflow).not.toHaveBeenCalled();
  });

  it.each(["project", "role", "issue", "multiple projects", "missing attribution"])("does not display budget caps with a mismatched %s attribution", (mismatch) => {
    const budget = boundBudget();
    if (mismatch === "project") budget.binding!.attribution.project_ids = ["beta"];
    if (mismatch === "role") budget.binding!.attribution.role_id = "reviewer";
    if (mismatch === "issue") budget.binding!.attribution.issue_id = "I-other";
    if (mismatch === "multiple projects") budget.binding!.attribution.project_ids = ["alpha", "beta"];
    if (mismatch === "missing attribution") budget.binding!.attribution = null as never;
    render(<ContextPreview preview={{ ...preview, budget_preview: budget }} />);
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(within(summary).getByText("Presupuesto no disponible.")).toBeInTheDocument();
    expect(within(summary).queryByText("c".repeat(64))).toBeNull();
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
  });

  it.each([null, "I-1"])("shows exact optional issue-bound diagnostics for %s without changing context fingerprints", (issueId) => {
    const value = { ...preview, budget_preview: boundBudget(issueId) };
    render(<ContextPreview preview={value} expectedIssueId={issueId} />);
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(within(summary).getByText("c".repeat(64))).toBeInTheDocument();
    expect(within(summary).getByText("Disponibilidad informativa: no disponible.")).toBeInTheDocument();
    expect(value.fingerprint).toBe(preview.fingerprint);
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
  });

  it("rejects a foreign issue budget despite the same displayed project and role", () => {
    render(<ContextPreview preview={{ ...preview, budget_preview: boundBudget("I-other") }} expectedIssueId="I-1" />);
    const summary = screen.getByRole("region", { name: "Presupuesto informativo del contexto" });
    expect(within(summary).getByText("Presupuesto no disponible.")).toBeInTheDocument();
    expect(within(summary).queryByText("c".repeat(64))).toBeNull();
    expect(screen.getByText("Contexto habilitado para este pedido.")).toBeInTheDocument();
  });

  it("clears the budget with its context preview and rejects a late response after project navigation", async () => {
    let complete!: (value: Preview) => void;
    const read = vi.spyOn(api, "previewContext").mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const view = render(<PreviewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Request preview" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    view.rerender(<PreviewHarness project="beta" />);
    await act(async () => complete({ ...preview, budget_preview: unavailableBudget() }));
    expect(screen.queryByRole("region", { name: "Preview de contexto" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Presupuesto informativo del contexto" })).toBeNull();
  });

  it("replaces budget observations only through a new explicit context preview", async () => {
    const read = vi.spyOn(api, "previewContext").mockResolvedValueOnce({ ...preview, budget_preview: unavailableBudget() })
      .mockResolvedValueOnce({ ...preview, budget_preview: { ...unavailableBudget(), denials: [{ code: "budget-policy-unavailable", source_ids: ["policy:unavailable"] }] } });
    render(<PreviewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Request preview" }));
    await screen.findByText("budget-ledger-unavailable", { exact: false });
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Request preview" }));
    await screen.findByText("budget-policy-unavailable", { exact: false });
    expect(screen.queryByText("budget-ledger-unavailable", { exact: false })).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
