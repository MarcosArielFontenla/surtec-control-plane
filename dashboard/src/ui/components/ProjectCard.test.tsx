// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import * as api from "../api";
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
    expect(screen.getAllByText(/main/).length).toBeGreaterThan(0);
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

describe("ProjectCard branch control", () => {
  afterEach(() => vi.unstubAllGlobals());

  const gitP = (over: Partial<import("../../../../lib/state/types").GitStatus> = {}): ProjectView => ({
    ...base,
    git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true, ...over },
  });

  // Routes fetch by URL+method: GET /branches → list; POST /branch → op result.
  function stubBranchFetch(result: { ok: boolean; output: string } = { ok: true, output: "done" }) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/branches") && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ({ branches: ["main", "dev"], current: "main" }) };
      }
      return { ok: true, status: 200, json: async () => result };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return fetchMock;
  }

  it("renders no branch control for a non-git project", () => {
    render(<ProjectCard p={base} />);
    expect(screen.queryByRole("button", { name: /^main$/i })).toBeNull();
  });

  it("opening the panel lists branches and marks current", async () => {
    stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^main$/i }));
    await waitFor(() => expect(screen.getByText("● main")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^dev$/ })).toBeTruthy();
  });

  it("clicking a branch posts a switch op", async () => {
    const fetchMock = stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^main$/i }));
    const devBtn = await screen.findByRole("button", { name: /^dev$/ });
    fireEvent.click(devBtn);
    await waitFor(() => {
      const post = (fetchMock.mock.calls as unknown[][]).find(
        (c) => String(c[0]).endsWith("/api/projects/alpha/branch") && (c[1] as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      const b = JSON.parse((post![1] as RequestInit).body as string);
      expect(b.op).toBe("switch"); expect(b.name).toBe("dev");
    });
  });

  it("disables switch buttons when the tree is dirty", async () => {
    stubBranchFetch();
    render(<ProjectCard p={gitP({ dirty: true, uncommitted: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: /^main$/i }));
    const devBtn = (await screen.findByRole("button", { name: /^dev$/ })) as HTMLButtonElement;
    expect(devBtn.disabled).toBe(true);
  });

  it("creates a branch from the typed name; Crear disabled when empty", async () => {
    const fetchMock = stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^main$/i }));
    const crear = (await screen.findByRole("button", { name: /^crear$/i })) as HTMLButtonElement;
    expect(crear.disabled).toBe(true); // empty input
    fireEvent.change(screen.getByPlaceholderText(/nueva/i), { target: { value: "feature/z" } });
    expect(crear.disabled).toBe(false);
    fireEvent.click(crear);
    await waitFor(() => {
      const post = (fetchMock.mock.calls as unknown[][]).find(
        (c) => String(c[0]).endsWith("/api/projects/alpha/branch") && (c[1] as RequestInit)?.method === "POST",
      );
      const b = JSON.parse((post![1] as RequestInit).body as string);
      expect(b.op).toBe("create"); expect(b.name).toBe("feature/z");
    });
  });

  it("shows a warn banner when a branch op is refused (ok:false)", async () => {
    stubBranchFetch({ ok: false, output: "working tree no está limpio; commiteá o descartá los cambios para cambiar de branch" });
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^main$/i }));
    const devBtn = await screen.findByRole("button", { name: /^dev$/ });
    fireEvent.click(devBtn);
    await waitFor(() => {
      const banner = screen.getByText(/no está limpio/);
      expect(banner.className).toContain("banner--warn");
    });
  });
});

describe("ProjectCard github counts", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ghP = (): ProjectView => ({ ...base, repo: "git@github.com:owner/repo.git" });

  it("renders no PRs·Issues button for a non-github repo", () => {
    render(<ProjectCard p={{ ...base, repo: null }} />);
    expect(screen.queryByRole("button", { name: /prs · issues/i })).toBeNull();
  });

  it("loads and shows counts + CI on click", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, prs: 2, issues: 5, ci: "passing" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={ghP()} />);
    fireEvent.click(screen.getByRole("button", { name: /prs · issues/i }));
    await waitFor(() => expect(screen.getByText(/PRs: 2 · Issues: 5/)).toBeTruthy());
    expect(screen.getByText(/CI: ok/)).toBeTruthy();
    expect(container.querySelector(".ci .pdot--ok")).toBeTruthy();
    const get = (fetchMock.mock.calls as unknown[][]).find((c) => String(c[0]).endsWith("/api/projects/alpha/github"));
    expect(get).toBeTruthy();
  });

  it("shows 'no disponible' for degraded counts but still shows CI (independent)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, prs: 0, issues: 0, ci: "failing", error: "issues disabled" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={ghP()} />);
    fireEvent.click(screen.getByRole("button", { name: /prs · issues/i }));
    await waitFor(() => expect(screen.getByText(/no disponible/i)).toBeTruthy());
    expect(screen.getByText(/CI: falló/)).toBeTruthy();
    expect(container.querySelector(".ci .pdot--danger")).toBeTruthy();
  });

  it("shows 'no disponible' and retries on reopen when the fetch throws (HTTP error)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={ghP()} />);
    const btn = screen.getByRole("button", { name: /prs · issues/i });
    fireEvent.click(btn); // open + fetch (throws → err)
    await waitFor(() => expect(screen.getByText(/no disponible/i)).toBeTruthy());
    fireEvent.click(btn); // close
    fireEvent.click(btn); // reopen → retries (data still null)
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe("ProjectCard deps status", () => {
  afterEach(() => vi.unstubAllGlobals());

  const gitOkP = (): ProjectView => ({
    ...base,
    git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
  });

  it("renders no Deps button for a repo without git", () => {
    render(<ProjectCard p={base} />); // git: null
    expect(screen.queryByRole("button", { name: /^deps$/i })).toBeNull();
  });

  it("loads and shows the outdated count on click", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, outdated: 2 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/2 desactualizadas/)).toBeTruthy());
    expect(container.querySelector(".link-pop__val .pdot--warn")).toBeTruthy();
    const get = (fetchMock.mock.calls as unknown[][]).find((c) => String(c[0]).endsWith("/api/projects/alpha/deps"));
    expect(get).toBeTruthy();
  });

  it("shows 'al día' with an ok dot when nothing is outdated", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, outdated: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { container } = render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/al día/i)).toBeTruthy());
    expect(container.querySelector(".link-pop__val .pdot--ok")).toBeTruthy();
  });

  it("shows the degraded message when not ok", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, outdated: 0, error: "n/a (npm install)" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={gitOkP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deps$/i }));
    await waitFor(() => expect(screen.getByText(/npm install/i)).toBeTruthy());
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
    // confirm shown, git push not posted yet
    expect(screen.getByText(/Publicar 2 commits a origin\/main/)).toBeTruthy();
    const gitCalls = () => (fetchMock.mock.calls as unknown[][]).filter((c) => String(c[0]).endsWith("/api/projects/alpha/git"));
    expect(gitCalls().length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown[][];
      const post = calls.find((c) => String(c[0]).endsWith("/api/projects/alpha/git"));
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).action).toBe("push");
    });
  });

  it("shows a warn banner with the git output when the action fails (ok:false)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: false, action: "pull", output: "fatal: Not possible to fast-forward, aborting." }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<ProjectCard p={gitP({ behind: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: /^pull$/i }));
    await waitFor(() => {
      const banner = screen.getByText(/Not possible to fast-forward/);
      expect(banner).toBeTruthy();
      expect(banner.className).toContain("banner--warn");
    });
  });
});

describe("ProjectCard deploy health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the deploy dot, label and 'abrir sitio' link when configured + up", async () => {
    vi.spyOn(api, "getDeploy").mockResolvedValue({ configured: true, url: "https://alpha.up.railway.app", state: "up", status: 200, ms: 120 });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(screen.getByText(/up/)).toBeTruthy());
    const link = screen.getByRole("link", { name: /abrir sitio/i });
    expect(link.getAttribute("href")).toBe("https://alpha.up.railway.app");
  });

  it("renders no deploy control when the project is not configured for deploy", async () => {
    vi.spyOn(api, "getDeploy").mockResolvedValue({ configured: false, url: null, state: null, status: null, ms: null });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(api.getDeploy).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /abrir sitio/i })).toBeNull();
  });
});

describe("ProjectCard railway deploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the railway state + relative time + link when configured", async () => {
    vi.spyOn(api, "getRailway").mockResolvedValue({ configured: true, ok: true, state: "success", at: "2026-05-30T10:00:00Z", url: "https://x.up.railway.app" });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(screen.getByText(/Railway: success/)).toBeTruthy());
    expect(screen.getByRole("link", { name: /ver deploy/i }).getAttribute("href")).toBe("https://x.up.railway.app");
  });

  it("renders no railway line when not configured", async () => {
    vi.spyOn(api, "getRailway").mockResolvedValue({ configured: false, ok: false, state: null, at: null, url: null });
    render(<ProjectCard p={base} />);
    await waitFor(() => expect(api.getRailway).toHaveBeenCalled());
    expect(screen.queryByText(/Railway:/)).toBeNull();
  });
});
