# Project "Open" Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project "open" actions on the dashboard — open a discovered project in VS Code, open its folder in the OS file explorer, and open it on GitHub — driven from the project card.

**Architecture:** GitHub is a pure client-side link from the git remote. VS Code/Folder are server-spawned via `POST /api/projects/:id/open`; the server re-runs discovery to resolve the real path (the client sends only the id), then spawns a fixed binary. A pure `resolveOpenCommand` picks the per-platform command; `spawn`/`platform`/`editorCmd`/`discover` are injectable for tests.

**Tech Stack:** TypeScript ESM, Node `child_process.spawn`, Hono, React, Vitest + Testing Library/jsdom.

**Spec:** `docs/superpowers/specs/2026-05-30-project-open-actions-design.md`

---

## File Structure

- `lib/github-url.ts` (create) + test — `githubWebUrl(remote)`.
- `dashboard/src/server/open-project.ts` (create) + test — `OpenError`, `resolveOpenCommand`, `openProject`.
- `dashboard/src/server/index.ts` (modify) — `POST /api/projects/:id/open`.
- `dashboard/src/server/index.test.ts` (modify) — 404/400 endpoint tests.
- `dashboard/src/ui/api.ts` (modify) — `openProject(id, target)`.
- `dashboard/src/ui/components/ProjectCard.tsx` (modify) + test — actions row.
- `dashboard/src/ui/styles/dashboard.css` (modify) — `.es-card__actions`, `.es-link`.
- `README.md` (modify).

---

## Task 1: githubWebUrl (lib/github-url.ts)

**Files:**
- Create: `lib/github-url.ts`, `lib/github-url.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { githubWebUrl } from "./github-url";

describe("githubWebUrl", () => {
  it("converts an https remote with .git", () => {
    expect(githubWebUrl("https://github.com/MarcosArielFontenla/appointment-manager.git"))
      .toBe("https://github.com/MarcosArielFontenla/appointment-manager");
  });
  it("keeps an https remote without .git", () => {
    expect(githubWebUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });
  it("converts an ssh git@ remote", () => {
    expect(githubWebUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
  });
  it("converts an ssh:// remote", () => {
    expect(githubWebUrl("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });
  it("strips a trailing slash", () => {
    expect(githubWebUrl("https://github.com/owner/repo/")).toBe("https://github.com/owner/repo");
  });
  it("returns null for a non-GitHub host", () => {
    expect(githubWebUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  });
  it("returns null for null/empty", () => {
    expect(githubWebUrl(null)).toBeNull();
    expect(githubWebUrl("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/github-url.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/github-url.ts`**

```ts
// Converts a git remote into a github.com web URL, or null when it is not a GitHub remote.
export function githubWebUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const s = remote.trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/github-url.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/github-url.ts lib/github-url.test.ts
git commit -m "feat(lib): githubWebUrl derives a web URL from a git remote"
```

---

## Task 2: openProject (dashboard/src/server/open-project.ts)

**Files:**
- Create: `dashboard/src/server/open-project.ts`, `dashboard/src/server/open-project.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveOpenCommand, openProject, OpenError } from "./open-project";

describe("resolveOpenCommand", () => {
  it("vscode → editor cmd, shell on win32 only", () => {
    expect(resolveOpenCommand("vscode", "/p", "win32", "code")).toEqual({ command: "code", args: ["/p"], shell: true });
    expect(resolveOpenCommand("vscode", "/p", "darwin", "code")).toEqual({ command: "code", args: ["/p"], shell: false });
  });
  it("vscode honors a custom editor", () => {
    expect(resolveOpenCommand("vscode", "/p", "linux", "cursor")).toEqual({ command: "cursor", args: ["/p"], shell: false });
  });
  it("folder → per-platform explorer/open/xdg-open, no shell", () => {
    expect(resolveOpenCommand("folder", "/p", "win32", "code")).toEqual({ command: "explorer", args: ["/p"], shell: false });
    expect(resolveOpenCommand("folder", "/p", "darwin", "code")).toEqual({ command: "open", args: ["/p"], shell: false });
    expect(resolveOpenCommand("folder", "/p", "linux", "code")).toEqual({ command: "xdg-open", args: ["/p"], shell: false });
  });
});

describe("openProject", () => {
  const discover = () => [{ id: "alpha", path: "/p/alpha" }];

  it("spawns the editor for a discovered project", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const r = openProject("/repo", "alpha", "vscode", { discover, spawn, platform: "win32", editorCmd: "code", root: "/root" });
    expect(r).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("code", ["/p/alpha"], expect.objectContaining({ detached: true, stdio: "ignore", shell: true }));
  });

  it("spawns the folder opener", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    openProject("/repo", "alpha", "folder", { discover, spawn, platform: "darwin", editorCmd: "code", root: "/root" });
    expect(spawn).toHaveBeenCalledWith("open", ["/p/alpha"], expect.objectContaining({ shell: false }));
  });

  it("throws OpenError 404 for an unknown project and does not spawn", () => {
    const spawn = vi.fn();
    try {
      openProject("/repo", "ghost", "vscode", { discover, spawn, root: "/root" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OpenError);
      expect((e as OpenError).status).toBe(404);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("throws OpenError 400 for an invalid target and does not spawn", () => {
    const spawn = vi.fn();
    try {
      openProject("/repo", "alpha", "browser", { discover, spawn, root: "/root" });
      expect.unreachable();
    } catch (e) {
      expect((e as OpenError).status).toBe(400);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("throws OpenError 500 when spawn throws", () => {
    const spawn = vi.fn(() => { throw new Error("ENOENT: code"); });
    try {
      openProject("/repo", "alpha", "vscode", { discover, spawn, platform: "linux", editorCmd: "code", root: "/root" });
      expect.unreachable();
    } catch (e) {
      expect((e as OpenError).status).toBe(500);
      expect((e as OpenError).message).toContain("ENOENT");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run dashboard/src/server/open-project.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `dashboard/src/server/open-project.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class OpenError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "OpenError";
  }
}

export type OpenTarget = "vscode" | "folder";
const TARGETS: OpenTarget[] = ["vscode", "folder"];

export function resolveOpenCommand(
  target: OpenTarget,
  path: string,
  platform: NodeJS.Platform,
  editorCmd: string,
): { command: string; args: string[]; shell: boolean } {
  if (target === "vscode") {
    // shell on Windows so a `.cmd` shim (code.cmd / cursor.cmd) resolves; Node escapes the args.
    return { command: editorCmd, args: [path], shell: platform === "win32" };
  }
  const command = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
  return { command, args: [path], shell: false };
}

interface OpenDeps {
  spawn?: (command: string, args: string[], opts: object) => { unref?: () => void };
  platform?: NodeJS.Platform;
  editorCmd?: string;
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function openProject(repoRoot: string, id: string, target: string, deps: OpenDeps = {}): { ok: true } {
  if (!TARGETS.includes(target as OpenTarget)) {
    throw new OpenError(`invalid target: ${target}`, 400);
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  const editorCmd = deps.editorCmd ?? process.env.SURTEC_EDITOR_CMD ?? "code";
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new OpenError(`unknown project: ${id}`, 404);

  const { command, args, shell } = resolveOpenCommand(target as OpenTarget, proj.path, platform, editorCmd);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell });
    child.unref?.();
  } catch (e) {
    throw new OpenError((e as Error).message, 500);
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run dashboard/src/server/open-project.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/open-project.ts dashboard/src/server/open-project.test.ts
git commit -m "feat(dashboard): openProject spawns editor/folder for a discovered project"
```

---

## Task 3: Endpoint (dashboard/src/server/index.ts)

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Modify: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Write the failing tests** in `dashboard/src/server/index.test.ts`

```ts
it("open: 404 for an unknown project", async () => {
  const empty = mkdtempSync(join(tmpdir(), "surtec-open-empty-"));
  process.env.SURTEC_PROJECTS_ROOT = empty;
  try {
    const app = createApp(repoRoot);
    const res = await app.request("/api/projects/ghost/open", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "vscode" }),
    });
    expect(res.status).toBe(404);
  } finally {
    delete process.env.SURTEC_PROJECTS_ROOT;
    rmSync(empty, { recursive: true, force: true });
  }
});

it("open: 400 for an invalid target", async () => {
  const empty = mkdtempSync(join(tmpdir(), "surtec-open-bad-"));
  process.env.SURTEC_PROJECTS_ROOT = empty;
  try {
    const app = createApp(repoRoot);
    const res = await app.request("/api/projects/whatever/open", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "browser" }),
    });
    expect(res.status).toBe(400);
  } finally {
    delete process.env.SURTEC_PROJECTS_ROOT;
    rmSync(empty, { recursive: true, force: true });
  }
});
```

(These never spawn — invalid target fails before discovery; unknown id fails after an empty discovery. Reuse the file's existing `mkdtempSync`/`rmSync`/`tmpdir`/`join` imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run dashboard/src/server/index.test.ts`
Expected: FAIL (route 404 as "not found" with no JSON / wrong status).

- [ ] **Step 3: Add the endpoint to `dashboard/src/server/index.ts`**

Add the import (with the other server imports):
```ts
import { openProject, OpenError } from "./open-project";
```

Add the route inside `createApp` (after the existing `POST /api/tasks/:id/reject` handler):
```ts
  app.post("/api/projects/:id/open", async (c) => {
    let body: { target?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      return c.json(openProject(repoRoot, c.req.param("id"), String(body?.target ?? "")));
    } catch (err) {
      if (err instanceof OpenError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(dashboard): POST /api/projects/:id/open endpoint"
```

---

## Task 4: UI — api.openProject + ProjectCard actions

**Files:**
- Modify: `dashboard/src/ui/api.ts`
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.test.tsx`
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Add `openProject` to `dashboard/src/ui/api.ts`**

```ts
export async function openProject(id: string, target: "vscode" | "folder"): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `open failed: ${res.status}`);
  }
}
```

- [ ] **Step 2: Add CSS to `dashboard/src/ui/styles/dashboard.css`**

```css
.es-card__actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; margin-top: var(--sp-1); }
.es-link { font-size: var(--fs-body-sm); color: var(--ink); text-decoration: none; }
.es-link:hover { text-decoration: underline; }
```

- [ ] **Step 3: Write the failing test** in `dashboard/src/ui/components/ProjectCard.test.tsx`

Add (reuse the file's `base`/render setup; stub fetch):
```ts
it("renders a GitHub link from the repo and opens VS Code", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const p = { ...base, repo: "git@github.com:owner/repo.git" };
  render(<ProjectCard p={p as any} />);

  const link = screen.getByRole("link", { name: /github/i });
  expect(link.getAttribute("href")).toBe("https://github.com/owner/repo");

  fireEvent.click(screen.getByRole("button", { name: /vs code/i }));
  await waitFor(() => {
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/projects/alpha/open"));
    expect(post).toBeTruthy();
    expect(JSON.parse((post![1] as RequestInit).body as string).target).toBe("vscode");
  });
  vi.unstubAllGlobals();
});

it("renders no GitHub link when repo is null", () => {
  render(<ProjectCard p={{ ...base, repo: null } as any} />);
  expect(screen.queryByRole("link", { name: /github/i })).toBeNull();
});
```
(Add `vi`, `fireEvent`, `waitFor` to the imports if missing. `base` has `id: "alpha"`.)

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL (no link / no button).

- [ ] **Step 5: Update `dashboard/src/ui/components/ProjectCard.tsx`**

Add imports:
```tsx
import { useState } from "react";
import { githubWebUrl } from "../../../../lib/github-url";
import { openProject } from "../api";
```
Inside `ProjectCard`, before the return, add state + handler:
```tsx
  const [openErr, setOpenErr] = useState<string | null>(null);
  const open = (target: "vscode" | "folder") => {
    setOpenErr(null);
    openProject(p.id, target).catch((e) => setOpenErr((e as Error).message));
  };
  const gh = githubWebUrl(p.repo);
```
Add an actions row at the end of the card (after the last `t-micro` div, still inside the `es-card` div):
```tsx
      <div className="es-card__actions">
        <button type="button" className="es-btn es-btn--ghost" onClick={() => open("vscode")}>VS Code</button>
        <button type="button" className="es-btn es-btn--ghost" onClick={() => open("folder")}>Carpeta</button>
        {gh && <a className="es-link" href={gh} target="_blank" rel="noreferrer">GitHub</a>}
      </div>
      {openErr && <div className="es-banner es-banner--danger">{openErr}</div>}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (existing git-status tests + 2 new).

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/ui/api.ts dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(dashboard): open actions (VS Code / Carpeta / GitHub) on the project card"
```

---

## Task 5: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README note** (under the "Dashboard style" / portfolio docs):

```markdown
### Project actions

Each project card has quick actions: **VS Code** and **Carpeta** ask the local server to open the project
in your editor (`code`, override with `SURTEC_EDITOR_CMD`) or the OS file explorer — the client sends only
the project id and the server resolves the real path from discovery (no client-supplied paths). **GitHub**
is a direct link derived from the project's git remote. (Running dev/build/test and git actions come next.)
```

- [ ] **Step 2: Full suite + type-check + build**

Run: `pnpm test`
Expected: all pass (prior 157 + github-url 7 + open-project 8 + index 2 + ProjectCard 2).

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document project open actions"
```

---

## Self-Review (plan vs. spec)

**Spec coverage:** §5 `github-url.ts` → Task 1; `open-project.ts` (OpenError, resolveOpenCommand,
openProject) → Task 2; endpoint → Task 3; `api.ts` + `ProjectCard.tsx` + dashboard.css → Task 4; README →
Task 5. ✅ §9 testing: github-url, open-project (resolve + 5 openProject cases), index (404/400),
ProjectCard (link + click) all have tasks. ✅ §7 safety: client sends only the id, server resolves the
path via discovery, fixed target allowlist, fixed binary — Task 2 implements + tests the unknown-id /
invalid-target / spawn-throw paths. ✅

**Type consistency:** `OpenTarget = "vscode"|"folder"` (Task 2) matches `api.openProject` (Task 4) and the
endpoint body. `OpenError {message, status}` (Task 2) is mapped by the endpoint (Task 3). `resolveOpenCommand`
and `openProject` signatures match their tests. `githubWebUrl(remote)` (Task 1) used by ProjectCard (Task 4). ✅

**Placeholder scan:** No TBD/TODO; full code in every step; Task 3/4 reuse existing test setup with concrete
new cases. ✅
