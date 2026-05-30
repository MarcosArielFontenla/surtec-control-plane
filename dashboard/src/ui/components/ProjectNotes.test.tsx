// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectNotes } from "./ProjectNotes";

afterEach(() => vi.unstubAllGlobals());

describe("ProjectNotes", () => {
  it("loads notes on mount and shows the pending count badge", async () => {
    const notes = [{ id: "1", text: "a", done: false, created_at: "t" }, { id: "2", text: "b", done: false, created_at: "t" }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notes }) })) as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /notas \(2\)/i })).toBeTruthy());
  });

  it("adds a note: posts { text } and renders the returned list", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return { ok: true, status: 200, json: async () => ({ notes: [] }) };
      return { ok: true, status: 200, json: async () => ({ notes: [{ id: "1", text: "do x", done: false, created_at: "t" }] }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /^notas$/i }));
    fireEvent.change(screen.getByPlaceholderText(/nueva/i), { target: { value: "do x" } });
    fireEvent.click(screen.getByRole("button", { name: /agregar/i }));
    await waitFor(() => expect(screen.getByText("do x")).toBeTruthy());
    const post = (fetchMock.mock.calls as unknown[][]).find(
      (c) => (c[1] as RequestInit)?.method === "POST" && String(c[0]).endsWith("/api/projects/alpha/notes"),
    );
    expect(JSON.parse((post![1] as RequestInit).body as string).text).toBe("do x");
  });

  it("Agregar is disabled for empty input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ notes: [] }) })) as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /^notas$/i }));
    expect((screen.getByRole("button", { name: /agregar/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggling an item posts { action: 'toggle' }", async () => {
    const initial = [{ id: "1", text: "a", done: false, created_at: "t" }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return { ok: true, status: 200, json: async () => ({ notes: initial }) };
      return { ok: true, status: 200, json: async () => ({ notes: [{ id: "1", text: "a", done: true, created_at: "t" }] }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /notas \(1\)/i }));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      const post = (fetchMock.mock.calls as unknown[][]).find(
        (c) => (c[1] as RequestInit)?.method === "POST" && String(c[0]).endsWith("/api/projects/alpha/notes/1"),
      );
      expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("toggle");
    });
  });

  it("deleting an item posts { action: 'delete' } and removes it", async () => {
    const initial = [{ id: "1", text: "borrame", done: false, created_at: "t" }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return { ok: true, status: 200, json: async () => ({ notes: initial }) };
      return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectNotes projectId="alpha" />);
    fireEvent.click(await screen.findByRole("button", { name: /notas \(1\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /borrar/i }));
    await waitFor(() => expect(screen.queryByText("borrame")).toBeNull());
    const post = (fetchMock.mock.calls as unknown[][]).find(
      (c) => (c[1] as RequestInit)?.method === "POST" && String(c[0]).endsWith("/api/projects/alpha/notes/1"),
    );
    expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("delete");
  });
});
