// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BulkSync } from "./BulkSync";
import * as api from "../api";

afterEach(() => vi.restoreAllMocks());

describe("BulkSync", () => {
  it("Fetch all calls gitSync(id,'fetch') per repo and renders a row per repo", async () => {
    const gitSync = vi.spyOn(api, "gitSync").mockResolvedValue({ ok: true, action: "fetch", output: "ok" });
    render(<BulkSync projectIds={["alpha", "beta"]} />);
    fireEvent.click(screen.getByRole("button", { name: /fetch all/i }));
    await waitFor(() => {
      expect(gitSync).toHaveBeenCalledWith("alpha", "fetch");
      expect(gitSync).toHaveBeenCalledWith("beta", "fetch");
    });
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("a repo that returns ok:false is shown failed; the others ok; the run continues", async () => {
    vi.spyOn(api, "gitSync").mockImplementation(async (id: string) =>
      id === "beta"
        ? { ok: false, action: "fetch", output: "conflict" }
        : { ok: true, action: "fetch", output: "ok" });
    render(<BulkSync projectIds={["alpha", "beta", "gamma"]} />);
    fireEvent.click(screen.getByRole("button", { name: /fetch all/i }));
    await waitFor(() => {
      expect(screen.getByText("beta").closest("li")?.querySelector(".es-dot--danger")).toBeTruthy();
      expect(screen.getByText("alpha").closest("li")?.querySelector(".es-dot--ok")).toBeTruthy();
      expect(screen.getByText("gamma").closest("li")?.querySelector(".es-dot--ok")).toBeTruthy();
    });
  });

  it("a repo whose gitSync throws (HTTP error) is shown failed; the run continues", async () => {
    vi.spyOn(api, "gitSync").mockImplementation(async (id: string) => {
      if (id === "beta") throw new Error("git fetch failed: 500");
      return { ok: true, action: "fetch", output: "ok" };
    });
    render(<BulkSync projectIds={["alpha", "beta", "gamma"]} />);
    fireEvent.click(screen.getByRole("button", { name: /fetch all/i }));
    await waitFor(() => {
      expect(screen.getByText("beta").closest("li")?.querySelector(".es-dot--danger")).toBeTruthy();
      expect(screen.getByText("gamma").closest("li")?.querySelector(".es-dot--ok")).toBeTruthy();
    });
  });

  it("Pull all sends 'pull' and disables the buttons while running", async () => {
    let resolve!: (v: { ok: boolean; action: string; output: string }) => void;
    vi.spyOn(api, "gitSync").mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<BulkSync projectIds={["alpha"]} />);
    const pull = screen.getByRole("button", { name: /pull all/i }) as HTMLButtonElement;
    fireEvent.click(pull);
    await waitFor(() => expect(pull.disabled).toBe(true));
    resolve({ ok: true, action: "pull", output: "ok" });
    await waitFor(() => expect(pull.disabled).toBe(false));
    expect(api.gitSync).toHaveBeenCalledWith("alpha", "pull");
  });

  it("empty projectIds → buttons disabled and no rows", () => {
    render(<BulkSync projectIds={[]} />);
    expect((screen.getByRole("button", { name: /fetch all/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("list")).toBeNull();
  });
});
