# Portfolio Discovery + Live Git Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard auto-discovers the user's real git projects under a root folder and shows live local git status per project (branch, dirty + uncommitted count, ahead/behind origin, last commit), with the `registry/projects.yml` reduced to a config overlay matched by folder name.

**Architecture:** New dependency-free `lib/` modules — `discover` (scan root for git repos), `git-status` (read-only local git via spawnSync), `git-status-cache` (TTL cache), `portfolio` (merge discovery + status + config). `buildOverview` consumes the merged `PortfolioProject[]`; `/api/overview` wires it; `ProjectCard` renders git status. Dispatch is unchanged (visibility-only slice).

**Tech Stack:** TypeScript ESM, Node `child_process.spawnSync` + `node:fs`, yaml, Hono, React, Vitest + Testing Library/jsdom, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-29-portfolio-discovery-design.md`

---

## File Structure

- `lib/state/types.ts` (modify) — `GitStatus`; `ProjectView` += `path`, `configured`, `git`.
- `lib/discover.ts` (create) — `discoverProjects(root, ignore)` → `DiscoveredProject[]`.
- `lib/git-status.ts` (create) — `readGitStatus(repoPath)` → `GitStatus`.
- `lib/git-status-cache.ts` (create) — `createGitStatusCache(opts)` → `{ get(path) }`.
- `lib/portfolio.ts` (create) — `ProjectConfig`, `PortfolioProject`, `assemblePortfolio(...)`.
- `lib/state/derive.ts` (modify) — `buildOverview(projects: PortfolioProject[], ...)` surfaces git/path/configured.
- `dashboard/src/server/portfolio-config.ts` (create) — `loadProjectConfig(repoRoot)` → `Map<string, ProjectConfig>`.
- `dashboard/src/server/index.ts` (modify) — `/api/overview` builds the portfolio.
- `dashboard/src/ui/components/ProjectCard.tsx` (modify) — render the git line + chips.
- Test files alongside each.

---

## Task 1: Types (GitStatus + ProjectView fields)

**Files:**
- Modify: `lib/state/types.ts`

- [ ] **Step 1: Add the GitStatus interface**

In `lib/state/types.ts`, add (place near `ProjectView`):

```ts
export interface GitStatus {
  branch: string | null;
  dirty: boolean;
  uncommitted: number;
  ahead: number;
  behind: number;
  last_commit: { hash: string; subject: string; at: string } | null;
  ok: boolean;
}
```

- [ ] **Step 2: Extend ProjectView**

In `export interface ProjectView { ... }`, add after `repo: string | null;`:

```ts
  path: string | null;
  configured: boolean;
  git: GitStatus | null;
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: errors ONLY in `derive.ts` (ProjectView now missing fields) — that's fixed in Task 6. If you want a clean check now, skip until Task 6; otherwise note the expected derive error.

- [ ] **Step 4: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(state): add GitStatus type and ProjectView git fields"
```

---

## Task 2: Project discovery (lib/discover.ts)

**Files:**
- Create: `lib/discover.ts`
- Test: `lib/discover.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/discover.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjects } from "./discover";

let root: string;

function mkRepo(name: string, gitAsFile = false): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (gitAsFile) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n", "utf8");
  else mkdirSync(join(dir, ".git"), { recursive: true });
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-discover-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("discoverProjects", () => {
  it("returns only git dirs, sorted by id", () => {
    mkRepo("beta");
    mkRepo("alpha");
    mkdirSync(join(root, "not-a-repo"), { recursive: true }); // no .git
    expect(discoverProjects(root).map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("treats a .git FILE (worktree) as a repo", () => {
    mkRepo("wt", true);
    expect(discoverProjects(root).map((p) => p.id)).toEqual(["wt"]);
  });

  it("skips dot-folders and ignored names", () => {
    mkRepo(".hidden");
    mkRepo("node_modules");
    mkRepo("keep");
    expect(discoverProjects(root, ["node_modules"]).map((p) => p.id)).toEqual(["keep"]);
  });

  it("returns the absolute path for each project", () => {
    mkRepo("alpha");
    expect(discoverProjects(root)[0].path).toBe(join(root, "alpha"));
  });

  it("returns [] when the root is missing", () => {
    expect(discoverProjects(join(root, "does-not-exist"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/discover.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/discover.ts`**

```ts
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredProject {
  id: string;
  path: string;
}

export const DEFAULT_IGNORE = ["node_modules"];

// Scans `root` at depth 1 and returns every subdirectory that is a git repo
// (has a `.git` dir OR file). Skips dot-folders and ignored names. Never throws.
export function discoverProjects(root: string, ignore: string[] = DEFAULT_IGNORE): DiscoveredProject[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const ignoreSet = new Set(ignore);
  const out: DiscoveredProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (ignoreSet.has(e.name)) continue;
    const path = join(root, e.name);
    if (existsSync(join(path, ".git"))) out.push({ id: e.name, path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/discover.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/discover.ts lib/discover.test.ts
git commit -m "feat(lib): discoverProjects scans a root for git repos"
```

---

## Task 3: Local git status (lib/git-status.ts)

**Files:**
- Create: `lib/git-status.ts`
- Test: `lib/git-status.test.ts`

- [ ] **Step 1: Write the failing tests** (real temp git repos — mirrors `runner/worktree.test.ts` style)

Create `lib/git-status.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitStatus } from "./git-status";

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@t.dev", "-c", "user.name=t", ...args], { encoding: "utf8" });

function initRepo(): void {
  spawnSync("git", ["init", "-b", "main", dir], { encoding: "utf8" });
  writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "surtec-gitstatus-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readGitStatus", () => {
  it("reports a clean repo with branch + last commit", () => {
    initRepo();
    const s = readGitStatus(dir);
    expect(s.ok).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.dirty).toBe(false);
    expect(s.uncommitted).toBe(0);
    expect(s.last_commit?.subject).toBe("init");
    expect(s.last_commit?.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("counts uncommitted changes", () => {
    initRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n", "utf8"); // modified
    writeFileSync(join(dir, "b.txt"), "new\n", "utf8");     // untracked
    const s = readGitStatus(dir);
    expect(s.dirty).toBe(true);
    expect(s.uncommitted).toBe(2);
  });

  it("reports ahead vs an upstream", () => {
    initRepo();
    const bare = mkdtempSync(join(tmpdir(), "surtec-remote-"));
    spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-u", "origin", "main");
    writeFileSync(join(dir, "c.txt"), "more\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "second");
    const s = readGitStatus(dir);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
    rmSync(bare, { recursive: true, force: true });
  });

  it("returns ok:false for a non-repo directory", () => {
    const s = readGitStatus(dir); // no git init
    expect(s.ok).toBe(false);
    expect(s.branch).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/git-status.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/git-status.ts`**

```ts
import { spawnSync } from "node:child_process";
import type { GitStatus } from "./state/types";

const TIMEOUT_MS = 10_000;

function git(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: TIMEOUT_MS });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "" };
}

const UNKNOWN: GitStatus = {
  branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false,
};

// Reads read-only LOCAL git status (no fetch/network). Never throws.
export function readGitStatus(repoPath: string): GitStatus {
  const head = git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!head.ok || head.stdout.trim() !== "true") return { ...UNKNOWN };

  const branchR = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchRaw = branchR.stdout.trim();
  const branch = branchR.ok && branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

  const porcelain = git(repoPath, ["status", "--porcelain"]);
  const lines = porcelain.stdout.split("\n").filter((l) => l.trim().length > 0);
  const uncommitted = lines.length;

  let ahead = 0;
  let behind = 0;
  const counts = git(repoPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts.ok) {
    const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  let last_commit: GitStatus["last_commit"] = null;
  const log = git(repoPath, ["log", "-1", "--format=%h%x00%s%x00%cI"]);
  if (log.ok && log.stdout.includes("\x00")) {
    const [hash, subject, at] = log.stdout.trim().split("\x00");
    if (hash) last_commit = { hash, subject: subject ?? "", at: at ?? "" };
  }

  return { branch, dirty: uncommitted > 0, uncommitted, ahead, behind, last_commit, ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/git-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/git-status.ts lib/git-status.test.ts
git commit -m "feat(lib): readGitStatus reads local git status (no network)"
```

---

## Task 4: TTL cache (lib/git-status-cache.ts)

**Files:**
- Create: `lib/git-status-cache.ts`
- Test: `lib/git-status-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/git-status-cache.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createGitStatusCache } from "./git-status-cache";
import type { GitStatus } from "./state/types";

const sample = (branch: string): GitStatus => ({
  branch, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true,
});

describe("createGitStatusCache", () => {
  it("reuses the cached value within the TTL", () => {
    let t = 1000;
    const readStatus = vi.fn(() => sample("main"));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => t });
    cache.get("/r");
    t = 1050; // within TTL
    cache.get("/r");
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("recomputes after the TTL expires", () => {
    let t = 1000;
    const readStatus = vi.fn(() => sample("main"));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => t });
    cache.get("/r");
    t = 1200; // past TTL
    cache.get("/r");
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it("caches per path independently", () => {
    const readStatus = vi.fn((p: string) => sample(p));
    const cache = createGitStatusCache({ readStatus, ttlMs: 100, now: () => 0 });
    expect(cache.get("/a").branch).toBe("/a");
    expect(cache.get("/b").branch).toBe("/b");
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/git-status-cache.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/git-status-cache.ts`**

```ts
import type { GitStatus } from "./state/types";
import { readGitStatus } from "./git-status";

export interface GitStatusCache {
  get(repoPath: string): GitStatus;
}

export function createGitStatusCache(opts: {
  readStatus?: (repoPath: string) => GitStatus;
  ttlMs?: number;
  now?: () => number;
} = {}): GitStatusCache {
  const readStatus = opts.readStatus ?? readGitStatus;
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: GitStatus; at: number }>();
  return {
    get(repoPath: string): GitStatus {
      const hit = cache.get(repoPath);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = readStatus(repoPath);
      cache.set(repoPath, { value, at: t });
      return value;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/git-status-cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/git-status-cache.ts lib/git-status-cache.test.ts
git commit -m "feat(lib): TTL cache for git status"
```

---

## Task 5: Portfolio merge (lib/portfolio.ts)

**Files:**
- Create: `lib/portfolio.ts`
- Test: `lib/portfolio.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/portfolio.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assemblePortfolio, type ProjectConfig } from "./portfolio";
import type { DiscoveredProject } from "./discover";
import type { GitStatus } from "./state/types";

const gs = (branch: string): GitStatus => ({
  branch, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true,
});

const discovered: DiscoveredProject[] = [
  { id: "alpha", path: "/p/alpha" },
  { id: "beta", path: "/p/beta" },
];
const statusByPath = new Map<string, GitStatus>([["/p/alpha", gs("main")], ["/p/beta", gs("dev")]]);

describe("assemblePortfolio", () => {
  it("marks a discovered project with config as configured and overlays its config", () => {
    const config = new Map<string, ProjectConfig>([
      ["alpha", { id: "alpha", status: "active", repo: "git@x:alpha.git", allowed_agents: ["backend-engineer"] }],
    ]);
    const out = assemblePortfolio(discovered, statusByPath, config);
    const alpha = out.find((p) => p.id === "alpha")!;
    expect(alpha.configured).toBe(true);
    expect(alpha.status).toBe("active");
    expect(alpha.repo).toBe("git@x:alpha.git");
    expect(alpha.path).toBe("/p/alpha");
    expect(alpha.git?.branch).toBe("main");
  });

  it("shows a discovered project without config as discovered + not configured", () => {
    const out = assemblePortfolio(discovered, statusByPath, new Map());
    const beta = out.find((p) => p.id === "beta")!;
    expect(beta.configured).toBe(false);
    expect(beta.status).toBe("discovered");
    expect(beta.repo).toBeNull();
    expect(beta.git?.branch).toBe("dev");
  });

  it("drops config entries with no discovered folder", () => {
    const config = new Map<string, ProjectConfig>([
      ["ghost", { id: "ghost", status: "active", allowed_agents: ["x"] }],
    ]);
    const out = assemblePortfolio(discovered, statusByPath, config);
    expect(out.map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("treats an empty allowed_agents as not configured", () => {
    const config = new Map<string, ProjectConfig>([["alpha", { id: "alpha", allowed_agents: [] }]]);
    expect(assemblePortfolio(discovered, statusByPath, config).find((p) => p.id === "alpha")!.configured).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/portfolio.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/portfolio.ts`**

```ts
import type { DiscoveredProject } from "./discover";
import type { GitStatus } from "./state/types";

export interface ProjectConfig {
  id: string;
  status?: string;
  repo?: string | null;
  allowed_agents?: string[];
  default_branch?: string | null;
}

export interface PortfolioProject {
  id: string;
  path: string | null;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  default_branch?: string | null;
  configured: boolean;
  git: GitStatus | null;
}

// Discovery drives the list; the registry config overlays by id. Config entries
// with no discovered folder are dropped (v1). Sorted by id.
export function assemblePortfolio(
  discovered: DiscoveredProject[],
  statusByPath: Map<string, GitStatus>,
  config: Map<string, ProjectConfig>,
): PortfolioProject[] {
  return discovered
    .map((d) => {
      const cfg = config.get(d.id);
      const configured = !!(cfg?.allowed_agents && cfg.allowed_agents.length > 0);
      return {
        id: d.id,
        path: d.path,
        status: cfg?.status ?? "discovered",
        repo: cfg?.repo ?? null,
        allowed_agents: cfg?.allowed_agents,
        default_branch: cfg?.default_branch ?? null,
        configured,
        git: statusByPath.get(d.path) ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/portfolio.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/portfolio.ts lib/portfolio.test.ts
git commit -m "feat(lib): assemblePortfolio merges discovery + status + config"
```

---

## Task 6: buildOverview consumes PortfolioProject (lib/state/derive.ts)

**Files:**
- Modify: `lib/state/derive.ts`
- Test: `lib/state/derive.test.ts`

`buildOverview`'s first param changes from `RegistryProject[]` to `PortfolioProject[]`, and each `ProjectView` gains `path`/`configured`/`git`. The existing `RegistryProject` interface stays (still used by `registry.ts`/dispatch). The derive test fixtures must be updated to the new input shape.

- [ ] **Step 1: Update the test fixtures + add a git-surfacing test**

In `lib/state/derive.test.ts`:

a) Change the import + the `registry` fixture to `PortfolioProject`:
```ts
import { buildOverview } from "./derive";
import type { PortfolioProject } from "../portfolio";
import type { TaskRecord } from "./types";

const registry: PortfolioProject[] = [
  { id: "stock-control", status: "active", repo: "git@github.com:surtec/stock-control.git", path: "/p/stock-control", configured: true, git: null },
  { id: "portfolio-site", status: "planned", repo: null, path: "/p/portfolio-site", configured: false, git: null },
];
```
(If the file passes any OTHER inline project-list arrays to `buildOverview`, add `path`, `configured`, `git` to each object the same way.)

b) Add a new test:
```ts
it("surfaces path, configured and git status on the project view", () => {
  const projects: PortfolioProject[] = [
    { id: "alpha", status: "active", repo: null, path: "/p/alpha", configured: true,
      git: { branch: "main", dirty: true, uncommitted: 3, ahead: 1, behind: 0, last_commit: { hash: "abc123", subject: "wip", at: "2026-05-29T10:00:00Z" }, ok: true } },
  ];
  const o = buildOverview(projects, [], []);
  const p = o.projects.find((x) => x.id === "alpha")!;
  expect(p.path).toBe("/p/alpha");
  expect(p.configured).toBe(true);
  expect(p.git?.branch).toBe("main");
  expect(p.git?.uncommitted).toBe(3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/state/derive.test.ts`
Expected: FAIL (ProjectView lacks the fields / type error).

- [ ] **Step 3: Update `lib/state/derive.ts`**

a) Add the import at the top:
```ts
import type { PortfolioProject } from "../portfolio";
```

b) Change the `buildOverview` signature's first param:
```ts
export function buildOverview(
  registryProjects: PortfolioProject[],
  tasks: TaskRecord[],
  overrides: ProjectStatusOverride[],
): OverviewModel {
```

c) In the `projects: ProjectView[] = registryProjects.map((rp) => { ... })`, add the three fields to the returned object (after `repo: rp.repo,`):
```ts
      path: rp.path ?? null,
      configured: rp.configured ?? false,
      git: rp.git ?? null,
```

(The existing `RegistryProject` interface in this file is unchanged and still exported for dispatch.)

- [ ] **Step 4: Run the tests + type-check**

Run: `pnpm vitest run lib/state/derive.test.ts`
Expected: PASS (existing + new).

Run: `pnpm exec tsc --noEmit`
Expected: errors only where `buildOverview` is called with the old shape (the overview endpoint) — fixed in Task 8. (`index.test.ts` may also need Task 8's wiring; proceed.)

- [ ] **Step 5: Commit**

```bash
git add lib/state/derive.ts lib/state/derive.test.ts
git commit -m "feat(state): buildOverview consumes PortfolioProject and surfaces git status"
```

---

## Task 7: Project config loader (dashboard/src/server/portfolio-config.ts)

**Files:**
- Create: `dashboard/src/server/portfolio-config.ts`
- Test: `dashboard/src/server/portfolio-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/server/portfolio-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "./portfolio-config";

let root: string;
function writeRegistry(yml: string): void {
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-pcfg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("loadProjectConfig", () => {
  it("indexes registry entries by id with config fields", () => {
    writeRegistry(
      "projects:\n  alpha:\n    repo: git@x:alpha.git\n    status: active\n    default_branch: main\n    allowed_agents:\n      - backend-engineer\n",
    );
    const cfg = loadProjectConfig(root);
    expect(cfg.get("alpha")).toMatchObject({
      id: "alpha", repo: "git@x:alpha.git", status: "active", default_branch: "main",
      allowed_agents: ["backend-engineer"],
    });
  });

  it("returns an empty map when the registry is missing", () => {
    expect(loadProjectConfig(root).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run dashboard/src/server/portfolio-config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `dashboard/src/server/portfolio-config.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProjectConfig } from "../../../lib/portfolio";

interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    allowed_agents?: string[];
    default_branch?: string;
  }>;
}

// Indexes registry/projects.yml entries by id as ProjectConfig overlays. Never throws.
export function loadProjectConfig(repoRoot: string): Map<string, ProjectConfig> {
  let doc: RegistryDoc;
  try {
    doc = (parse(readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8")) ?? {}) as RegistryDoc;
  } catch {
    return new Map();
  }
  const out = new Map<string, ProjectConfig>();
  for (const [id, v] of Object.entries(doc.projects ?? {})) {
    out.set(id, {
      id,
      status: v?.status,
      repo: v?.repo ?? null,
      allowed_agents: v?.allowed_agents ?? [],
      default_branch: v?.default_branch ?? null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run dashboard/src/server/portfolio-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/portfolio-config.ts dashboard/src/server/portfolio-config.test.ts
git commit -m "feat(dashboard): loadProjectConfig overlay by project id"
```

---

## Task 8: Wire the portfolio into /api/overview (index.ts)

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Read the existing `/api/overview` handler and `index.test.ts`**

The handler currently does:
```ts
const overview = buildOverview(loadRegistryProjects(repoRoot), listTasks(), listProjectOverrides());
```

- [ ] **Step 2: Update the handler in `dashboard/src/server/index.ts`**

a) Add imports near the top:
```ts
import { dirname } from "node:path";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { createGitStatusCache } from "../../../lib/git-status-cache";
import { assemblePortfolio } from "../../../lib/portfolio";
import { loadProjectConfig } from "./portfolio-config";
```

b) Inside `createApp`, before the routes, create a single cache:
```ts
  const gitStatusCache = createGitStatusCache();
```

c) Replace the `/api/overview` body:
```ts
  app.get("/api/overview", (c) => {
    try {
      const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
      const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
      const discovered = discoverProjects(root, ignore);
      const statusByPath = new Map(discovered.map((d) => [d.path, gitStatusCache.get(d.path)]));
      const config = loadProjectConfig(repoRoot);
      const portfolio = assemblePortfolio(discovered, statusByPath, config);
      const overview = buildOverview(portfolio, listTasks(), listProjectOverrides());
      return c.json(overview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

d) Remove the now-unused `loadRegistryProjects` import IF it is no longer referenced elsewhere in the file. (It is still used by `/api/dispatch-options` — keep it.)

- [ ] **Step 3: Update `index.test.ts` for the overview shape**

The overview test likely seeds a registry and asserts `overview.projects`. With discovery driving the list, projects now come from discovered git repos under the root. Update the overview test to set `SURTEC_PROJECTS_ROOT` to a temp dir containing a couple of git repos (or assert on the new fields without asserting an exact project list). Minimal robust approach — assert the endpoint returns 200 and an array, and that a discovered repo surfaces git + configured:

```ts
it("overview returns discovered projects with git status", async () => {
  // create a temp projects root with one git repo named "alpha"
  const projectsRoot = mkdtempSync(join(tmpdir(), "surtec-ov-root-"));
  const alpha = join(projectsRoot, "alpha");
  mkdirSync(alpha, { recursive: true });
  spawnSync("git", ["init", "-b", "main", alpha], { encoding: "utf8" });
  writeFileSync(join(alpha, "f.txt"), "x\n", "utf8");
  spawnSync("git", ["-C", alpha, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  spawnSync("git", ["-C", alpha, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
  process.env.SURTEC_PROJECTS_ROOT = projectsRoot;

  const app = createApp(repoRoot);
  const res = await app.request("/api/overview");
  expect(res.status).toBe(200);
  const body = await res.json();
  const p = body.projects.find((x: { id: string }) => x.id === "alpha");
  expect(p).toBeTruthy();
  expect(p.git.branch).toBe("main");
  expect(p.configured).toBe(false);

  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(projectsRoot, { recursive: true, force: true });
});
```

(Add the needed imports — `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync`, `tmpdir`, `join`, `spawnSync` — to `index.test.ts` if absent. If an existing overview test asserts a hard-coded project list from the registry, update it to set `SURTEC_PROJECTS_ROOT` to an empty temp dir so it sees no discovered projects, or adapt its expectations to the discovery model.)

- [ ] **Step 4: Run the tests + type-check + full suite**

Run: `pnpm vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(dashboard): /api/overview builds the discovered portfolio with git status"
```

---

## Task 9: Render git status on the project card (ProjectCard.tsx)

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Test: `dashboard/src/ui/components/ProjectCard.test.tsx`

- [ ] **Step 1: Read `ProjectCard.tsx` and its test** to match the existing render/props style (it receives a `ProjectView`).

- [ ] **Step 2: Write/extend the failing test** in `dashboard/src/ui/components/ProjectCard.test.tsx`:

```ts
it("renders git status, last commit and the configured chip", () => {
  const project = {
    id: "alpha", status: "active", health: null, note: null, repo: null,
    last_activity: null, task_counts: { inProgress: 0, finished: 0 },
    path: "/p/alpha", configured: true,
    git: { branch: "main", dirty: true, uncommitted: 2, ahead: 1, behind: 0,
      last_commit: { hash: "abc123", subject: "fix bug", at: "2026-05-29T10:00:00Z" }, ok: true },
  };
  render(<ProjectCard project={project as any} />);
  expect(screen.getByText(/main/)).toBeTruthy();
  expect(screen.getByText(/2/)).toBeTruthy();        // uncommitted count
  expect(screen.getByText(/fix bug/)).toBeTruthy();  // last commit subject
  expect(screen.getByText(/configurado/i)).toBeTruthy();
});

it("shows 'no disponible' when git read failed", () => {
  const project = {
    id: "beta", status: "discovered", health: null, note: null, repo: null,
    last_activity: null, task_counts: { inProgress: 0, finished: 0 },
    path: "/p/beta", configured: false,
    git: { branch: null, dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: false },
  };
  render(<ProjectCard project={project as any} />);
  expect(screen.getByText(/no disponible/i)).toBeTruthy();
});
```

(Use the test file's existing render setup / imports. If `ProjectCard.test.tsx` does not exist, create it with the jsdom directive and Testing Library imports like the other component tests.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Update `ProjectCard.tsx`** — add a git line + chips. Add a helper and render block (adapt to the card's existing JSX):

```tsx
function GitLine({ git }: { git: import("../../../../lib/state/types").GitStatus | null }) {
  if (!git) return null;
  if (!git.ok) return <div style={{ fontSize: 12, color: "#b02a37" }}>git: no disponible</div>;
  return (
    <div style={{ fontSize: 12, color: "#555", display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span>⎇ {git.branch ?? "(detached)"}</span>
      <span style={{ color: git.dirty ? "#b02a37" : "#198754" }}>
        {git.dirty ? `● ${git.uncommitted} sin commitear` : "✓ limpio"}
      </span>
      <span>↑{git.ahead} ↓{git.behind}</span>
      {git.last_commit && <span title={git.last_commit.at}>· {git.last_commit.subject}</span>}
    </div>
  );
}
```

Then inside the card's JSX (after the project title/status), render:
```tsx
      <span style={{ fontSize: 11, color: project.configured ? "#198754" : "#999" }}>
        {project.configured ? "configurado" : "sin configurar"}
      </span>
      <GitLine git={project.git} />
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx
git commit -m "feat(dashboard): render live git status on the project card"
```

---

## Task 10: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README section**

```markdown
### Portfolio discovery

The dashboard auto-discovers your projects by scanning a root folder (default: the control plane's
parent dir; override with `SURTEC_PROJECTS_ROOT`) for git repos at depth 1, and shows live local git
status per project (branch, dirty + uncommitted count, ahead/behind origin, last commit). The
`registry/projects.yml` is now a config overlay matched by folder name — a discovered project without a
registry entry is shown but not yet dispatchable. Ignore folders with `SURTEC_PROJECTS_IGNORE`
(comma-separated). Git status is read-only and local (no fetch), cached ~15s.
```

- [ ] **Step 2: Full suite + type-check + build**

Run: `pnpm test`
Expected: all tests pass (prior 124 + the new discover/git-status/cache/portfolio/derive/portfolio-config/index/ProjectCard tests).

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document portfolio discovery + git status"
```

---

## Self-Review (plan vs. spec)

**Spec coverage:**
- §5 GitStatus + ProjectView → Task 1. `lib/discover.ts` → Task 2. `lib/git-status.ts` → Task 3.
  `lib/git-status-cache.ts` → Task 4. `lib/portfolio.ts` → Task 5. `derive.ts` → Task 6.
  `portfolio-config.ts` → Task 7. `/api/overview` wiring → Task 8. `ProjectCard.tsx` → Task 9. README → Task 10. ✅
- §9 testing → discover, git-status, cache, portfolio, derive, portfolio-config, index(overview), ProjectCard all have tasks. ✅
- §7 safety → git read-only (Task 3 uses only rev-parse/status/rev-list/log); discovery reads dir names only (Task 2); failures → ok:false / [] (Tasks 2,3). ✅
- Dispatch unchanged → no task touches dispatch.ts; `loadRegistryProjects` kept for dispatch-options (Task 8 note). ✅

**Type consistency:** `GitStatus` (Task 1) used identically in git-status/cache/portfolio/derive/ProjectCard.
`DiscoveredProject {id,path}` (Task 2) consumed by portfolio (Task 5) + index (Task 8). `PortfolioProject`
(Task 5) is buildOverview's input (Task 6) and assemblePortfolio's output (Task 5) — same shape.
`ProjectConfig` (Task 5) produced by loadProjectConfig (Task 7) and consumed by assemblePortfolio (Task 5).
`createGitStatusCache(...).get(path)` (Task 4) used in index (Task 8). ✅

**Placeholder scan:** No TBD/TODO; full code in each step. Tasks 8/9 note "adapt to existing test/JSX" because
they extend existing files — concrete code + assertions are provided; the implementer matches the file's
fixtures. ✅
