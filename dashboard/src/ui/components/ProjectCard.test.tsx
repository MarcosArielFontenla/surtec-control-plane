// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import * as api from "../api";
import type { ProjectView } from "../../../../lib/state/types";

const base: ProjectView = {
  id: "alpha", status: "active", health: null, note: null, repo: null,
  last_activity: null, task_counts: { inProgress: 0, finished: 0 },
  path: "/p/alpha", configured: true, git: null,
};

describe("ProjectCard", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("renders git state, last commit and configured status", () => {
    const project: ProjectView = {
      ...base,
      git: { branch: "main", dirty: true, uncommitted: 2, ahead: 1, behind: 0,
        last_commit: { hash: "abc123", subject: "fix bug", at: "2026-05-29T10:00:00Z" }, ok: true },
    };
    render(<ProjectCard p={project} />);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("2 sin commitear")).toBeTruthy();
    expect(screen.getByText(/fix bug/)).toBeTruthy();
    expect(screen.getByText("configurado")).toBeTruthy();
  });

  it("shows a branch-unavailable state when local Git cannot be read", () => {
    render(<ProjectCard p={{ ...base, git: { branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false } }} />);
    expect(screen.getByText("git: no disponible")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^fetch$/i })).toBeNull();
  });

  it("renders task counts and running indicators", () => {
    render(<ProjectCard p={{ ...base, task_counts: { inProgress: 2, finished: 4 } }} running={["dev"]} />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("● dev")).toBeTruthy();
  });

  it("opens the operating detail on explicit click and does not fetch legacy provider endpoints", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onOpenDetail = vi.fn();
    render(<ProjectCard p={{ ...base, repo: "git@github.com:owner/repo.git" }} onOpenDetail={onOpenDetail} />);
    expect(screen.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/owner/repo");
    fireEvent.click(screen.getByRole("button", { name: "Detalle operativo de alpha" }));
    expect(onOpenDetail).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the local project target explicitly and reports the error", async () => {
    vi.spyOn(api, "openProject").mockRejectedValue(new Error("open denied"));
    render(<ProjectCard p={base} />);
    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByText("open denied")).toBeTruthy());
    expect(api.openProject).toHaveBeenCalledWith("alpha", "vscode");
  });

  it("only posts push after explicit confirmation", async () => {
    const gitSync = vi.spyOn(api, "gitSync").mockResolvedValue({ ok: true, action: "push", output: "pushed" });
    const project = { ...base, git: { branch: "main", dirty: false, uncommitted: 0, ahead: 2, behind: 0, last_commit: null, ok: true } };
    render(<ProjectCard p={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(screen.getByText(/Publicar 2 commits/)).toBeTruthy();
    expect(gitSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(gitSync).toHaveBeenCalledWith("alpha", "push"));
  });

  it("loads branches and lets the operator create a named branch", async () => {
    vi.spyOn(api, "getBranches").mockResolvedValue({ branches: ["main", "feature"], current: "main" });
    vi.spyOn(api, "branchOp").mockResolvedValue({ ok: true, output: "created" });
    const project = { ...base, git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true } };
    render(<ProjectCard p={project} />);
    fireEvent.click(screen.getByRole("button", { name: /main/ }));
    await waitFor(() => expect(screen.getByText("feature")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("nueva-branch"), { target: { value: "phase-f" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(api.branchOp).toHaveBeenCalledWith("alpha", "create", "phase-f"));
  });
});
