// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import type { ProjectView } from "../../../../lib/state/types";

const base: ProjectView = {
  id: "alpha", status: "active", health: null, note: null, repo: null,
  last_activity: null, task_counts: { inProgress: 0, finished: 0 },
  path: "/p/alpha", configured: true, git: null,
};

describe("ProjectCard git status", () => {
  it("renders git status, last commit and the configured chip", () => {
    const p: ProjectView = {
      ...base,
      git: { branch: "main", dirty: true, uncommitted: 2, ahead: 1, behind: 0,
        last_commit: { hash: "abc123", subject: "fix bug", at: "2026-05-29T10:00:00Z" }, ok: true },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/2 sin commitear/)).toBeTruthy();
    expect(screen.getByText(/fix bug/)).toBeTruthy();
    expect(screen.getByText(/configurado/i)).toBeTruthy();
  });

  it("shows 'limpio' for a clean repo and the sin-configurar chip", () => {
    const p: ProjectView = {
      ...base, configured: false,
      git: { branch: "dev", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/limpio/i)).toBeTruthy();
    expect(screen.getByText(/sin configurar/i)).toBeTruthy();
  });

  it("shows 'no disponible' when git read failed", () => {
    const p: ProjectView = {
      ...base,
      git: { branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false },
    };
    render(<ProjectCard p={p} />);
    expect(screen.getByText(/no disponible/i)).toBeTruthy();
  });

  it("renders no git line when git is null", () => {
    render(<ProjectCard p={base} />);
    expect(screen.queryByText(/no disponible/i)).toBeNull();
    expect(screen.queryByText(/limpio/i)).toBeNull();
  });
});

describe("ProjectCard running indicator", () => {
  it("shows a running indicator when a run is active", () => {
    const p: ProjectView = { ...base };
    render(<ProjectCard p={p} running={["dev"]} />);
    expect(screen.getByText("● dev")).toBeTruthy();
  });

  it("shows no running indicator when idle", () => {
    const p: ProjectView = { ...base };
    render(<ProjectCard p={p} running={[]} />);
    expect(screen.queryByText(/●/)).toBeNull();
  });
});

describe("ProjectCard open actions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a GitHub link from the repo and opens VS Code", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = { ...base, repo: "git@github.com:owner/repo.git" };
    render(<ProjectCard p={p as any} />);

    const link = screen.getByRole("link", { name: /github/i });
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo");

    fireEvent.click(screen.getByRole("button", { name: /vs code/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown[][];
      const post = calls.find((c) => String(c[0]).endsWith("/api/projects/alpha/open"));
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).target).toBe("vscode");
    });
  });

  it("renders no GitHub link when repo is null", () => {
    render(<ProjectCard p={{ ...base, repo: null } as any} />);
    expect(screen.queryByRole("link", { name: /github/i })).toBeNull();
  });

  it("shows the error when opening fails", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "code no está en el PATH" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={{ ...base } as any} />);
    fireEvent.click(screen.getByRole("button", { name: /vs code/i }));
    await waitFor(() => expect(screen.getByText(/code no está en el PATH/)).toBeTruthy());
  });
});

describe("ProjectCard git sync", () => {
  afterEach(() => vi.unstubAllGlobals());

  const gitP = (over: Partial<import("../../../../lib/state/types").GitStatus> = {}): ProjectView => ({
    ...base,
    git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true, ...over },
  });

  it("renders no git-sync row when the repo is not git-ok", () => {
    render(<ProjectCard p={base} />); // git: null
    expect(screen.queryByRole("button", { name: /^fetch$/i })).toBeNull();
  });

  it("Fetch posts gitSync(id,'fetch') and shows the output", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, action: "fetch", output: "Already up to date." }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^fetch$/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown[][];
      const post = calls.find((c) => String(c[0]).endsWith("/api/projects/alpha/git"));
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("fetch");
    });
    await waitFor(() => expect(screen.getByText(/Already up to date/)).toBeTruthy());
  });

  it("Push is disabled when ahead is 0", () => {
    render(<ProjectCard p={gitP({ ahead: 0 })} />);
    const push = screen.getByRole("button", { name: /^push$/i }) as HTMLButtonElement;
    expect(push.disabled).toBe(true);
  });

  it("Push asks for confirmation and only posts after Confirmar", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, action: "push", output: "pushed" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={gitP({ ahead: 2 })} />);
    fireEvent.click(screen.getByRole("button", { name: /^push$/i }));
    // confirm shown, nothing posted yet
    expect(screen.getByText(/Publicar 2 commits a origin\/main/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown[][];
      const post = calls.find((c) => String(c[0]).endsWith("/api/projects/alpha/git"));
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("push");
    });
  });
});
