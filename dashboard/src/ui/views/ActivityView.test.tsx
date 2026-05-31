// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActivityView } from "./ActivityView";
import * as api from "../api";
import type { ActivityFeed } from "../../../../lib/state/types";

afterEach(() => vi.restoreAllMocks());

const feed: ActivityFeed = {
  items: [
    { kind: "commit", at: "2026-05-15T00:00:00Z", project: "beta", hash: "b1c2d3e", subject: "beta commit", author: "marcos" },
    { kind: "task", at: "2026-05-12T00:00:00Z", project: "alpha", taskId: "T9", agent: "backend-engineer", title: "do the thing", state: "en curso" },
  ],
};

describe("ActivityView", () => {
  it("lists commit + task rows newest-first", async () => {
    vi.spyOn(api, "getActivity").mockResolvedValue(feed);
    render(<ActivityView />);
    await waitFor(() => expect(screen.getByText("beta commit")).toBeTruthy());
    expect(screen.getByText("do the thing")).toBeTruthy();
    expect(screen.getByText(/en curso/)).toBeTruthy();
  });

  it("filters to commits only", async () => {
    vi.spyOn(api, "getActivity").mockResolvedValue(feed);
    render(<ActivityView />);
    await waitFor(() => expect(screen.getByText("beta commit")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^commits$/i }));
    expect(screen.getByText("beta commit")).toBeTruthy();
    expect(screen.queryByText("do the thing")).toBeNull();
  });

  it("shows the empty state when there is no activity", async () => {
    vi.spyOn(api, "getActivity").mockResolvedValue({ items: [] });
    render(<ActivityView />);
    await waitFor(() => expect(screen.getByText(/sin actividad reciente/i)).toBeTruthy());
  });
});
