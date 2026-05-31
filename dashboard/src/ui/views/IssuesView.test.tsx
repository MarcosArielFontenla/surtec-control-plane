// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IssuesView } from "./IssuesView";
import * as api from "../api";
import type { Inbox } from "../../../../lib/state/types";

afterEach(() => vi.restoreAllMocks());

const inbox: Inbox = {
  items: [
    { number: 2, title: "beta issue", url: "https://gh/beta/2", updatedAt: "2026-05-20T00:00:00Z", labels: ["bug"], author: "b", projectId: "beta", slug: "owner/beta" },
    { number: 1, title: "alpha issue", url: "https://gh/alpha/1", updatedAt: "2026-05-01T00:00:00Z", labels: [], author: "a", projectId: "alpha", slug: "owner/alpha" },
  ],
  repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: true }],
};

describe("IssuesView", () => {
  it("loads and lists issues newest-first with title links", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    const link = screen.getByRole("link", { name: /beta issue/i });
    expect(link.getAttribute("href")).toBe("https://gh/beta/2");
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("filters by repo", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText("beta issue")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/repositorio/i), { target: { value: "alpha" } });
    expect(screen.queryByText("beta issue")).toBeNull();
    expect(screen.getByText("alpha issue")).toBeTruthy();
  });

  it("shows the empty state when there are no issues", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "alpha", slug: "owner/alpha", ok: true }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/sin issues abiertos/i)).toBeTruthy());
  });

  it("shows a degraded note for repos whose gh failed (some ok, some not)", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({
      items: [],
      repos: [{ id: "alpha", slug: "owner/alpha", ok: true }, { id: "beta", slug: "owner/beta", ok: false, error: "no access" }],
    });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/no se pudo leer/i)).toBeTruthy());
  });

  it("shows 'GitHub no disponible' when every repo failed", async () => {
    vi.spyOn(api, "getInbox").mockResolvedValue({ items: [], repos: [{ id: "beta", slug: "owner/beta", ok: false, error: "no gh" }] });
    render(<IssuesView />);
    await waitFor(() => expect(screen.getByText(/github no disponible/i)).toBeTruthy());
  });
});
