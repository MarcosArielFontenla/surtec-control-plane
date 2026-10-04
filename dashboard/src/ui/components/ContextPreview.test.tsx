// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextManifestEvidence, ContextPreview } from "./ContextPreview";
import { previewContext, dispatchWorkIssue, type ContextPreview as Preview } from "../api";

const preview: Preview = { schema_version: 1, fingerprint: "a".repeat(64), allowed: true, blocked_reasons: [], runtime_read_limitation: "Runtime reads are not guaranteed project-only.", manifest: {
  schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "planner", agent_id: "tech-lead", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: ["scope-change"],
  budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, total_lines: 12, total_bytes: 200,
  sources: [{ id: "project/AGENTS.md", layer: "instructions", source_type: "instruction", revision: "b".repeat(64), reason: "Selected mandatory instructions", bytes: 200, lines: 12, sensitivity: "local" }],
  selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: ["Optional objective missing"],
  routing: { action: "planning", work_scale: "bounded", review_depth: "full", qa_required: true, reasons: ["Two affected domains"], delegation: { admitted: false, executable: false, reasons: ["Execution unavailable"] } },
  testing: { mode: "functional", minimum_review_depth: "full", runner_ids: [], commands: ["node verify.mjs"], reasons: ["Trusted policy"], requires_red_evidence: false },
} };

afterEach(() => vi.unstubAllGlobals());

describe("safe context evidence", () => {
  it("renders attributable policy, limits, privacy, fingerprints and the runtime limitation, not private bodies", () => {
    const extra = { ...preview, rendered: "Private prompt body", manifest: { ...preview.manifest, private_body: "Confidential client text" } };
    render(<ContextPreview preview={extra} />);
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
});
