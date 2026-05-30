// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttentionPanel } from "./AttentionPanel";
import type { AttentionItem } from "../../../../lib/state/types";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ decision: { status: "approved" } }),
  })) as unknown as typeof fetch);
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(() => vi.unstubAllGlobals());

describe("AttentionPanel", () => {
  it("shows Aprobar/Rechazar on task-level items and POSTs approve on click", async () => {
    const items: AttentionItem[] = [
      { kind: "awaiting-approval", task_id: "T-1", project: "p", title: "Do it" },
      { kind: "risk", task_id: "T-1", project: "p", title: "no rate limit" },
    ];
    render(<AttentionPanel items={items} />);

    const approve = screen.getAllByRole("button", { name: /aprobar/i });
    expect(approve).toHaveLength(1); // only the awaiting-approval item, not the risk
    fireEvent.click(approve[0]);

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const post = calls.find((c) => String(c[0]).endsWith("/api/tasks/T-1/approve"));
      expect(post).toBeTruthy();
      expect((post![1] as RequestInit).method).toBe("POST");
    });
  });

  it("renders no buttons for risk/blocker items", () => {
    render(<AttentionPanel items={[{ kind: "risk", task_id: "T-2", project: "p", title: "r" }]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a verification badge per item status", () => {
    render(
      <AttentionPanel
        items={[
          { kind: "awaiting-approval", task_id: "T-1", project: "p", title: "ok", verification: "passed" },
          { kind: "awaiting-approval", task_id: "T-2", project: "p", title: "bad", verification: "failed" },
          { kind: "awaiting-approval", task_id: "T-3", project: "p", title: "none", verification: null },
        ]}
      />,
    );
    expect(screen.getByText(/verificado/)).toBeTruthy();
    expect(screen.getByText(/verificación falló/)).toBeTruthy();
    expect(screen.getByText(/sin verificar/)).toBeTruthy();
  });
});
