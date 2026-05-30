# Branch Ops (list / switch / create) (B.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List local branches, switch to one (blocked when the tree is dirty), and create+switch a new branch on a project's MAIN checkout from its card — with strict branch-name validation and server-side path resolution.

**Architecture:** A new server module `dashboard/src/server/git-branch.ts` validates names, resolves the project path via discovery (never a client path), and runs fixed git argv via `spawnSync` (no shell). Switch is refused when `git status --porcelain` is non-empty; create carries changes to the new branch. A refused/failed op is a `200` result, not an HTTP error; only invalid op/name (400) or unknown project (404) are HTTP errors. On success the git-status cache entry is invalidated so the new branch shows on the next overview poll. The card gets a `BranchControl` panel.

**Tech Stack:** TypeScript ESM, Node `child_process.spawnSync`, Hono, React 18 + Vite, Vitest + Testing Library/jsdom. Windows/PowerShell host.

**Spec:** `docs/superpowers/specs/2026-05-30-branch-ops-design.md`

---

## File Structure

**Create:**
- `dashboard/src/server/git-branch.ts` — `validateBranchName`, `listBranches`, `switchBranch`, `createBranch`, `BranchError`, types. Discovery-based path resolution (inline, like `git-sync.ts`); never throws except `BranchError`.
- `dashboard/src/server/git-branch.test.ts`.

**Modify:**
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/branches`, `POST /api/projects/:id/branch`; cache invalidation on success.
- `dashboard/src/server/index.test.ts` — route tests.
- `dashboard/src/ui/api.ts` — `getBranches(id)`, `branchOp(id, op, name)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `BranchControl` sub-component.
- `dashboard/src/ui/components/ProjectCard.test.tsx` — branch-control tests.
- `dashboard/src/ui/styles/dashboard.css` — `.es-branches*` styles.

---

## Task 1: `git-branch.ts` — `validateBranchName` + `listBranches`

**Files:**
- Create: `dashboard/src/server/git-branch.ts`
- Test: `dashboard/src/server/git-branch.test.ts`

This task builds name validation, the scaffolding (BranchError, types, deps, path resolution helpers), and the read-only `listBranches`. Task 2 adds `switchBranch`/`createBranch`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/server/git-branch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { validateBranchName, listBranches, BranchError } from "./git-branch";

const discoverAlpha = () => [{ id: "alpha", path: "/p/alpha" }];

describe("validateBranchName", () => {
  it("accepts valid names", () => {
    for (const n of ["feature/x", "fix-1", "release_2.0", "a/b/c", "main"]) {
      expect(validateBranchName(n)).toBe(true);
    }
  });
  it("rejects dangerous/invalid names", () => {
    for (const n of ["", "-foo", "--force", ".hidden", "/abs", "feat..x", "ends/", "wip.lock", "has space", "tab\tname", "a~b", "a:b", "a?b", "a".repeat(201)]) {
      expect(validateBranchName(n)).toBe(false);
    }
  });
});

describe("listBranches", () => {
  it("parses the branch list and detects current", () => {
    const spawnSync = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes("branch")) return { status: 0, stdout: "main\ndev\nfeature/x\n" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "dev\n" };
      return { status: 0, stdout: "" };
    });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r).toEqual({ branches: ["main", "dev", "feature/x"], current: "dev" });
  });

  it("returns current null for a detached HEAD", () => {
    const spawnSync = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes("branch")) return { status: 0, stdout: "main\n" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "HEAD\n" };
      return { status: 0, stdout: "" };
    });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.current).toBeNull();
  });

  it("throws BranchError(404) for an unknown project", () => {
    expect(() => listBranches("/repo", "ghost", { spawnSync: vi.fn() as never, discover: () => [], root: "/root" }))
      .toThrow(BranchError);
  });

  it("returns empty branches (no throw) when git fails", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "not a repo" });
    const r = listBranches("/repo", "alpha", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r).toEqual({ branches: [], current: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/git-branch.test.ts`
Expected: FAIL — `Cannot find module './git-branch'`.

- [ ] **Step 3: Implement**

Create `dashboard/src/server/git-branch.ts`:

```ts
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

export class BranchError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "BranchError"; }
}

export type BranchOp = "switch" | "create";
export interface BranchListResult { branches: string[]; current: string | null }
export interface BranchOpResult { ok: boolean; output: string }

const TIMEOUT_MS = 30_000;
const TAIL_CHARS = 4000;
const NAME_RE = /^[A-Za-z0-9._/-]+$/;

// Strict, pure branch-name validator — a SAFE SUBSET of git's ref rules. Rejecting a leading "-" is what
// blocks git argument injection (e.g. "--force"/"-d") when the name is passed as an argv element.
export function validateBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.startsWith("/")) return false;
  if (name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..")) return false;
  return NAME_RE.test(name);
}

export interface GitBranchDeps {
  spawnSync?: (command: string, args: string[], opts: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

function resolvePath(repoRoot: string, id: string, deps: GitBranchDeps): string {
  const discover = deps.discover ?? discoverProjects;
  const root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  const proj = discover(root, ignore).find((p) => p.id === id);
  if (!proj) throw new BranchError(`unknown project: ${id}`, 404);
  return proj.path;
}

function asStr(v: string | Buffer | undefined): string {
  return typeof v === "string" ? v : (v as Buffer | undefined)?.toString() ?? "";
}

export function listBranches(repoRoot: string, id: string, deps: GitBranchDeps = {}): BranchListResult {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const path = resolvePath(repoRoot, id, deps);
  const list = spawnSync("git", ["-C", path, "branch", "--format=%(refname:short)"], { encoding: "utf8", timeout: TIMEOUT_MS });
  const branches = list.status === 0 && !list.error
    ? asStr(list.stdout).split("\n").map((s) => s.trim()).filter(Boolean)
    : [];
  const head = spawnSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: TIMEOUT_MS });
  const cur = head.status === 0 && !head.error ? asStr(head.stdout).trim() : "";
  const current = cur && cur !== "HEAD" ? cur : null;
  return { branches, current };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/git-branch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/git-branch.ts dashboard/src/server/git-branch.test.ts
git commit -m "feat(server): git-branch validateBranchName + listBranches"
```

---

## Task 2: `git-branch.ts` — `switchBranch` + `createBranch`

**Files:**
- Modify: `dashboard/src/server/git-branch.ts`
- Test: `dashboard/src/server/git-branch.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `dashboard/src/server/git-branch.test.ts` (new describe blocks; reuse `discoverAlpha`):

```ts
import { switchBranch, createBranch } from "./git-branch";

// Routes a git spawnSync by subcommand so a single mock can drive switchBranch (which runs
// status --porcelain, branch, rev-parse, then switch).
function routeSpawn(routes: { porcelain?: object; branch?: object; head?: object; switch?: object }) {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("--porcelain")) return routes.porcelain ?? { status: 0, stdout: "" };
    if (args.includes("branch")) return routes.branch ?? { status: 0, stdout: "main\ndev\n" };
    if (args.includes("rev-parse")) return routes.head ?? { status: 0, stdout: "main\n" };
    if (args.includes("switch")) return routes.switch ?? { status: 0, stdout: "" };
    return { status: 0, stdout: "" };
  });
}

describe("switchBranch", () => {
  it("refuses (ok:false) and does NOT switch when the tree is dirty", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: " M file.ts\n" } });
    const r = switchBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no está limpio/);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall).toBeUndefined(); // switch never attempted
  });

  it("refuses (ok:false) when the target branch does not exist", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: "" }, branch: { status: 0, stdout: "main\ndev\n" } });
    const r = switchBranch("/repo", "alpha", "nope", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no existe/);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall).toBeUndefined();
  });

  it("switches when clean and the branch exists", () => {
    const spawnSync = routeSpawn({ porcelain: { status: 0, stdout: "" }, branch: { status: 0, stdout: "main\ndev\n" }, switch: { status: 0, stdout: "Switched to branch 'dev'" } });
    const r = switchBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(true);
    const switchCall = (spawnSync.mock.calls as unknown[][]).find((c) => (c[1] as string[]).includes("switch"));
    expect(switchCall![1]).toEqual(["-C", "/p/alpha", "switch", "dev"]);
  });
});

describe("createBranch", () => {
  it("runs git switch -c with the exact argv and returns ok on exit 0", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stdout: "Switched to a new branch 'feature/y'" });
    const r = createBranch("/repo", "alpha", "feature/y", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(true);
    expect(spawnSync.mock.calls[0][1]).toEqual(["-C", "/p/alpha", "switch", "-c", "feature/y"]);
  });

  it("returns ok:false (no throw) when git fails (e.g. name already exists)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 128, stdout: "", stderr: "fatal: a branch named 'dev' already exists" });
    const r = createBranch("/repo", "alpha", "dev", { spawnSync: spawnSync as never, discover: discoverAlpha, root: "/root" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already exists/);
  });

  it("throws BranchError(404) for an unknown project", () => {
    expect(() => createBranch("/repo", "ghost", "x", { spawnSync: vi.fn() as never, discover: () => [], root: "/root" }))
      .toThrow(BranchError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/git-branch.test.ts`
Expected: FAIL — `switchBranch`/`createBranch` are not exported.

- [ ] **Step 3: Implement**

Append to `dashboard/src/server/git-branch.ts` (after `listBranches`):

```ts
function combine(r: { stdout?: string | Buffer; stderr?: string | Buffer; error?: Error }): string {
  return (asStr(r.stdout) + asStr(r.stderr) + (r.error ? r.error.message : "")).trim().slice(-TAIL_CHARS);
}

// Switches the main checkout to an EXISTING local branch. Refuses (ok:false, no switch) when the working
// tree is dirty or the target branch does not exist. The caller (route) has already validated the name.
export function switchBranch(repoRoot: string, id: string, name: string, deps: GitBranchDeps = {}): BranchOpResult {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const path = resolvePath(repoRoot, id, deps);
  const status = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (asStr(status.stdout).trim().length > 0) {
    return { ok: false, output: "working tree no está limpio; commiteá o descartá los cambios para cambiar de branch" };
  }
  const { branches } = listBranches(repoRoot, id, deps);
  if (!branches.includes(name)) {
    return { ok: false, output: `la branch no existe: ${name}` };
  }
  const r = spawnSync("git", ["-C", path, "switch", name], { encoding: "utf8", timeout: TIMEOUT_MS });
  return { ok: r.status === 0 && !r.error, output: combine(r) };
}

// Creates AND switches to a new branch from the current HEAD (safe even with a dirty tree — git carries
// the changes to the new branch). The caller (route) has already validated the name.
export function createBranch(repoRoot: string, id: string, name: string, deps: GitBranchDeps = {}): BranchOpResult {
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const path = resolvePath(repoRoot, id, deps);
  const r = spawnSync("git", ["-C", path, "switch", "-c", name], { encoding: "utf8", timeout: TIMEOUT_MS });
  return { ok: r.status === 0 && !r.error, output: combine(r) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/git-branch.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/git-branch.ts dashboard/src/server/git-branch.test.ts
git commit -m "feat(server): switchBranch (dirty/existence guard) + createBranch"
```

---

## Task 3: branch routes + cache invalidation

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Add failing route tests**

Add this describe block to `dashboard/src/server/index.test.ts` (the imports `mkdtempSync`/`rmSync`/`tmpdir`/`join` already exist; mirror the `/git` 404 test's `process.env.SURTEC_PROJECTS_ROOT = mkdtempSync(...)` + `delete` in finally pattern):

```ts
describe("branch routes", () => {
  it("POST /api/projects/:id/branch with an invalid op → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "delete", name: "main" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with an invalid name → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "switch", name: "-x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch with invalid JSON → 400", async () => {
    const app = createApp(process.cwd());
    const res = await app.request("/api/projects/whatever/branch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/projects/:id/branch for an unknown project (valid op+name) → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-branch-empty-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/branch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "switch", name: "main" }),
      });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("GET /api/projects/:id/branches for an unknown project → 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "surtec-branch-empty2-"));
    process.env.SURTEC_PROJECTS_ROOT = empty;
    try {
      const app = createApp(process.cwd());
      const res = await app.request("/api/projects/__nope__/branches");
      expect(res.status).toBe(404);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — the branch routes return 404 (route not found) / wrong status.

- [ ] **Step 3: Implement the routes**

In `dashboard/src/server/index.ts`:

1. Add the import (next to the `git-sync` import):

```ts
import { validateBranchName, listBranches, switchBranch, createBranch, BranchError } from "./git-branch";
```

2. Inside `createApp`, after the `POST /api/projects/:id/git` route (and before `return app;`), add:

```ts
  app.get("/api/projects/:id/branches", (c) => {
    try {
      return c.json(listBranches(repoRoot, c.req.param("id")));
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/branch", async (c) => {
    let body: { op?: string; name?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const id = c.req.param("id");
    const op = String(body?.op ?? "");
    const name = String(body?.name ?? "");
    if (op !== "switch" && op !== "create") return c.json({ error: `invalid op: ${op}` }, 400);
    if (!validateBranchName(name)) return c.json({ error: `invalid branch name: ${name}` }, 400);
    try {
      const result = op === "switch"
        ? switchBranch(repoRoot, id, name)
        : createBranch(repoRoot, id, name);
      if (result.ok) {
        const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
        const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
        const proj = discoverProjects(root, ignore).find((p) => p.id === id);
        if (proj) gitStatusCache.invalidate(proj.path);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 400 | 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

> `dirname`, `discoverProjects`, `DEFAULT_IGNORE`, and `gitStatusCache` are ALREADY in scope in `createApp` (used by `/api/overview` and the B.3 `/git` route). Reuse them.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite (no regressions)**

Run: `pnpm exec vitest run dashboard/src/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(server): GET branches + POST branch (switch/create) routes + cache bust"
```

---

## Task 4: API client `getBranches` + `branchOp`

**Files:**
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Implement** — append to `dashboard/src/ui/api.ts`:

```ts
export async function getBranches(id: string): Promise<{ branches: string[]; current: string | null }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branches`);
  if (!res.ok) throw new Error(`branches failed: ${res.status}`);
  return (await res.json()) as { branches: string[]; current: string | null };
}

export async function branchOp(
  id: string, op: "switch" | "create", name: string,
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, name }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `branch ${op} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; output: string };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/api.ts
git commit -m "feat(ui): getBranches + branchOp api clients"
```

## Context for Task 4
Mirrors the existing `gitSync`/`openProject` clients (same `throw new Error(e.error ?? ...)` shape). A refused/failed branch op still returns HTTP 200 with `{ ok:false, output }` — so `branchOp` only throws on a real HTTP error (400/404/500); the caller inspects `r.ok`.

---

## Task 5: ProjectCard `BranchControl` + styles

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.test.tsx`
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Add failing tests**

Add a new describe block to `dashboard/src/ui/components/ProjectCard.test.tsx` (the file has a `base` fixture with `git: null` and uses `vi.stubGlobal("fetch", …)` + `afterEach(() => vi.unstubAllGlobals())`):

```tsx
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
    expect(screen.queryByRole("button", { name: /^branch:/i })).toBeNull();
  });

  it("opening the panel lists branches and marks current", async () => {
    stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^branch:/i }));
    await waitFor(() => expect(screen.getByText("● main")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^dev$/ })).toBeTruthy();
  });

  it("clicking a branch posts a switch op", async () => {
    const fetchMock = stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^branch:/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /^branch:/i }));
    const devBtn = (await screen.findByRole("button", { name: /^dev$/ })) as HTMLButtonElement;
    expect(devBtn.disabled).toBe(true);
  });

  it("creates a branch from the typed name; Crear disabled when empty", async () => {
    const fetchMock = stubBranchFetch();
    render(<ProjectCard p={gitP()} />);
    fireEvent.click(screen.getByRole("button", { name: /^branch:/i }));
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — no branch control / button.

- [ ] **Step 3: Implement the `BranchControl` sub-component**

In `dashboard/src/ui/components/ProjectCard.tsx`:

1. Add `getBranches`, `branchOp` to the api import (it currently imports `openProject, gitSync`):

```tsx
import { openProject, gitSync, getBranches, branchOp } from "../api";
```

2. Add a `BranchControl` sub-component (place it next to the existing `GitLine`/`GitSyncRow` sub-components, above `export function ProjectCard`):

```tsx
function BranchControl({ project }: { project: ProjectView }) {
  const git = project.git;
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(git?.ok ? git.branch : null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  if (!git?.ok) return null;

  const load = () => {
    setLoading(true);
    getBranches(project.id)
      .then((b) => { setBranches(b.branches); setCurrent(b.current); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const op = (operation: "switch" | "create", name: string) => {
    setBusy(true);
    setResult(null);
    branchOp(project.id, operation, name)
      .then((r) => {
        setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") });
        if (operation === "create" && r.ok) setNewName("");
        load();
      })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="es-branches">
      <button type="button" className="es-btn es-btn--ghost" onClick={toggle}>
        Branch: {current ?? "(detached)"}
      </button>
      {open && (
        <div className="es-branches__panel">
          {git.dirty && <div className="es-branches__note">árbol sucio: commiteá o descartá para cambiar de branch</div>}
          {loading ? (
            <span className="es-empty">cargando…</span>
          ) : (
            <ul className="es-branches__list">
              {branches.map((b) => (
                <li key={b}>
                  {b === current ? (
                    <span className="es-branches__cur">● {b}</span>
                  ) : (
                    <button type="button" className="es-btn es-btn--ghost" disabled={busy || git.dirty} onClick={() => op("switch", b)}>{b}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="es-branches__create">
            <input className="es-input" placeholder="nueva-branch" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" className="es-btn es-btn--ghost" disabled={busy || newName.trim() === ""} onClick={() => op("create", newName.trim())}>Crear</button>
          </div>
          {result && <div className={`es-banner ${result.ok ? "es-banner--ok" : "es-banner--warn"}`}>{result.text}</div>}
        </div>
      )}
    </div>
  );
}
```

3. Render it inside the card, right after the `<GitSyncRow project={p} />` line:

```tsx
      <BranchControl project={p} />
```

- [ ] **Step 4: Add the CSS** — append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* branch control */
.es-branches { margin-top: var(--sp-2); }
.es-branches__panel { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); padding: var(--sp-3); background: var(--surface-2); border-radius: var(--r-md); }
.es-branches__note { font-size: var(--fs-caption); color: var(--warn-700); }
.es-branches__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow: auto; }
.es-branches__cur { font-size: var(--fs-body-sm); font-weight: 600; }
.es-branches__create { display: flex; gap: var(--sp-2); }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS (existing ProjectCard tests + the 5 new branch-control ones).

- [ ] **Step 6: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): ProjectCard BranchControl (list/switch/create) panel"
```

## Context for Task 5
`BranchControl` is a local sub-component (like `GitLine`/`GitSyncRow`). It renders only when `project.git?.ok`. The branch list is fetched on panel open (not polled). Switch buttons are disabled when `git.dirty` (the server ALSO enforces this); create stays enabled. After any op the panel re-fetches the list, and the git-line refreshes via the 3s overview poll (the server invalidated the cache). `useState` is already imported in ProjectCard.tsx. The CSS tokens used (`--surface-2`, `--warn-700`, `--sp-*`, `--r-md`, `--fs-*`) already exist in the file.

---

## Task 6: Full verification + manual smoke + finish the branch

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (existing 228 + new: git-branch validateBranchName/listBranches/switchBranch/createBranch, branch routes (5), ProjectCard branch control (5)).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (REQUIRED — use the verification-before-completion skill)**

Start the API server (`PORT=4319 pnpm exec tsx dashboard/src/server/serve.ts` in the background). Then exercise over HTTP against a REAL discovered git project (use a project you don't mind creating a throwaway branch in, then switch back):
- `GET /api/projects/<a-real-git-project>/branches` → `{ branches:[…], current:"…" }`.
- `POST …/branch { "op":"create", "name":"surtec-smoke-test" }` → `200 { ok:true }` (creates+switches). Verify via `GET …/branches` that `current` is now `surtec-smoke-test`.
- `POST …/branch { "op":"switch", "name":"<the original branch>" }` → `200 { ok:true }` (switch back). Then clean up the throwaway branch manually (`git -C <path> branch -d surtec-smoke-test`).
- `POST …/branch { "op":"switch", "name":"-x" }` → `400`. `POST …/branch { "op":"delete", "name":"main" }` → `400`. `GET …/branches` for a non-existent id → `404`.
- Optionally: if the project has uncommitted changes, confirm a switch returns `{ ok:false, "no está limpio" }`.

Capture the actual observed output. Restore the project to its original branch and remove the throwaway branch. If anything fails, switch to systematic-debugging. Kill the test server afterward.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch — the project's established per-slice flow. Then update the memory file `live-status-dashboard-slice.md` to add the B.4 slice.

---

## Self-Review (completed during planning)

- **Spec coverage:** validateBranchName → Task 1; listBranches → Task 1; switchBranch (dirty + existence guard) + createBranch → Task 2; routes (GET branches, POST branch with op/name validation + cache bust) → Task 3; api client → Task 4; ProjectCard BranchControl (list/switch/create, dirty-disabled switch, create input) + CSS → Task 5; verification + finish → Task 6. All spec sections covered.
- **Placeholder scan:** no TODO/TBD; every code step has complete code, including the `routeSpawn`/`stubBranchFetch` test helpers and the full component.
- **Type consistency:** `BranchError`/`BranchOp`/`BranchListResult`/`BranchOpResult`/`GitBranchDeps`/`validateBranchName`/`listBranches`/`switchBranch`/`createBranch` defined in Tasks 1-2 and used identically in Task 3; `getBranches`/`branchOp(id, op, name)` signatures consistent between Task 4 and Task 5; the `{ ok, output }` and `{ branches, current }` shapes are consistent across server, api, and UI. The route validates the name (400) before calling switch/create, and `switchBranch` independently re-checks branch membership.
