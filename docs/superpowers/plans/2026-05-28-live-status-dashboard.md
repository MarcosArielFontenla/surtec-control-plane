# Live Status Dashboard (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web dashboard that shows live project status across Surtec projects — project cards, in-progress/history tasks, and risks/pending approvals — reading from a file-first state store.

**Architecture:** A dependency-free TypeScript store interface (`lib/state`) reads/writes one JSON file per task under `state/` (gitignored). A small CLI (`cli/surtec-state`) seeds/records task data. A Hono API serves a derived overview to a Vite/React UI (classic sidebar + grid layout). No execution runner in v1 — data comes from the CLI/fixtures.

**Tech Stack:** TypeScript (ESM), Node ≥18, `lib/state` (node:fs only), Hono + `@hono/node-server` (API), Vite + React (UI), `yaml` (registry parsing), Vitest + Testing Library (tests), pnpm.

**Conventions:**
- All commands run from the repo root: `E:\product-projects\surtec-control-plane`.
- Relative imports are **extensionless** (resolved by tsx/vitest/vite with `moduleResolution: "bundler"`).
- Every commit message ends with this trailer (shown in each commit step):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Refinement vs spec:** v1 uses a **single root `package.json`** (not a separate `dashboard/` package) to avoid monorepo overhead. `lib/state` stays dependency-free regardless; `yaml`/`hono`/`react` live in the one root package. Revisit a workspace split only if the dashboard grows. Everything else follows the approved spec `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.

---

## File Structure

```
package.json                       # MODIFY: add deps + scripts
tsconfig.json                      # CREATE: ESM + bundler resolution + react-jsx
vitest.config.ts                   # CREATE: node default env
vite.config.ts                     # CREATE: root=dashboard, /api proxy, build to dashboard/dist
.gitignore                         # MODIFY: ignore state/ and dashboard/dist

lib/state/
  types.ts                         # CREATE: TaskEnvelope, AgentResult, TaskRecord, views (no deps)
  paths.ts                         # CREATE: state/fixtures dir resolution (env overridable)
  store.ts                         # CREATE: atomic JSON read/write; listTasks/readTask/upsert
  derive.ts                        # CREATE: RegistryProject type + buildOverview() (pure)
  store.test.ts                    # CREATE
  derive.test.ts                   # CREATE

cli/surtec-state.ts                # CREATE: record | set-status | seed

fixtures/
  tasks/STK-001.json               # CREATE: finished task w/ approval + risk
  tasks/STK-002.json               # CREATE: running task
  projects/stock-control.json      # CREATE: health override

dashboard/
  index.html                       # CREATE
  src/main.tsx                     # CREATE: React entry
  src/ui/api.ts                    # CREATE: fetch + polling hook
  src/ui/App.tsx                   # CREATE: layout A (sidebar + grid)
  src/ui/components/Sidebar.tsx        # CREATE
  src/ui/components/ProjectCard.tsx    # CREATE
  src/ui/components/TaskList.tsx       # CREATE
  src/ui/components/AttentionPanel.tsx # CREATE
  src/ui/App.test.tsx              # CREATE
  src/server/registry.ts           # CREATE: loadRegistryProjects() via yaml
  src/server/registry.test.ts      # CREATE
  src/server/index.ts              # CREATE: Hono app + endpoints + static
  src/server/index.test.ts         # CREATE

registry/companies.yml             # MODIFY: default_executor -> claude
adapters/codex-runner/README.md    # MODIFY: DEPRECATED note
agents/codex/README.md             # CREATE: DEPRECATED note for the agent set
```

---

## Task 0: Project setup & tooling

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `vitest.config.ts`, `vite.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add dependencies and scripts to `package.json`**

Replace the `scripts` block and add `dependencies`/`devDependencies` (keep existing fields like `name`, `version`, `private`, `type`, `engines`):

```json
{
  "name": "surtec-control-plane",
  "version": "0.1.0",
  "private": true,
  "description": "Surtec control plane for project orchestration, agent governance, Codex execution, and upstream monitoring.",
  "type": "module",
  "scripts": {
    "validate": "bash scripts/validation/validate-schemas.sh && bash scripts/validation/validate-registry.sh",
    "validate:registry": "bash scripts/validation/validate-registry.sh",
    "validate:schemas": "bash scripts/validation/validate-schemas.sh",
    "upstream:check": "bash scripts/upstream/check-updates.sh",
    "project:bootstrap": "bash scripts/projects/bootstrap-project.sh",
    "task:run": "bash scripts/projects/run-codex-task.sh",
    "state": "tsx cli/surtec-state.ts",
    "dev:api": "tsx watch dashboard/src/server/index.ts",
    "dev:ui": "vite",
    "dev": "concurrently -n api,ui -c blue,green \"pnpm dev:api\" \"pnpm dev:ui\"",
    "build": "vite build",
    "start": "tsx dashboard/src/server/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@hono/node-server": "^1.13.7",
    "hono": "^4.6.14",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "yaml": "^2.6.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "concurrently": "^9.1.0",
    "jsdom": "^25.0.1",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["lib", "cli", "dashboard"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4317" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
```

- [ ] **Step 5: Update `.gitignore`**

Add these lines under the existing entries:

```
state/
dashboard/dist
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`
Expected: completes without errors; creates `node_modules` and `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts vite.config.ts .gitignore pnpm-lock.yaml
git commit -m "chore: set up TS + Vite + Vitest tooling for dashboard" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: State types (`lib/state/types.ts`)

Pure type definitions mirroring `schemas/task-envelope.schema.json` and `schemas/agent-result.schema.json`, plus the record and view shapes. No behavior, so no test.

**Files:**
- Create: `lib/state/types.ts`

- [ ] **Step 1: Write the file**

```ts
// Canonical TS mirror of schemas/task-envelope.schema.json
export type SandboxMode = "read-only" | "workspace-write";

export interface TaskEnvelope {
  id: string;
  source: string;
  project: string;
  task_type: string;
  agent: string;
  title: string;
  instructions: string;
  repo_path: string;
  branch: string;
  sandbox: SandboxMode;
  expected_outputs: string[];
  requires_human_approval: boolean;
  metadata: Record<string, unknown>;
}

// Canonical TS mirror of schemas/agent-result.schema.json
export type AgentOutcome = "completed" | "partial" | "blocked" | "failed" | "needs-review";

export interface AgentResult {
  task_id: string;
  agent: string;
  status: AgentOutcome;
  summary: string;
  files_changed: string[];
  commands_run: string[];
  tests_run: string[];
  risks: string[];
  blockers: string[];
  next_steps: string[];
  artifacts: string[];
  logs_path: string;
}

export type Lifecycle = "queued" | "running" | "finished";

export interface TaskRecord {
  envelope: TaskEnvelope;
  lifecycle: Lifecycle;
  outcome: AgentOutcome | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  result: AgentResult | null;
  logs_path: string | null;
}

export interface ProjectStatusOverride {
  id: string;
  health?: "ok" | "at-risk" | "blocked";
  note?: string;
}

export interface ProjectView {
  id: string;
  status: string;
  health: "ok" | "at-risk" | "blocked" | null;
  note: string | null;
  repo: string | null;
  last_activity: string | null;
  task_counts: { inProgress: number; finished: number };
}

export interface TaskView {
  id: string;
  project: string;
  agent: string;
  title: string;
  lifecycle: Lifecycle;
  outcome: AgentOutcome | null;
  updated_at: string;
  finished_at: string | null;
  requires_human_approval: boolean;
}

export interface AttentionItem {
  kind: "needs-review" | "awaiting-approval" | "risk" | "blocker";
  task_id: string;
  project: string;
  title: string;
}

export interface OverviewModel {
  projects: ProjectView[];
  inProgress: TaskView[];
  history: TaskView[];
  attention: AttentionItem[];
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(state): add canonical TS types for store records and views" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Path resolution (`lib/state/paths.ts`)

**Files:**
- Create: `lib/state/paths.ts`
- Test: `lib/state/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/state/paths.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { stateDir, tasksDir, fixturesDir } from "./paths";

describe("paths", () => {
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
  });

  it("defaults stateDir to <cwd>/state", () => {
    expect(stateDir()).toBe(join(process.cwd(), "state"));
  });

  it("honors SURTEC_STATE_DIR override", () => {
    process.env.SURTEC_STATE_DIR = "/tmp/custom-state";
    expect(stateDir()).toBe("/tmp/custom-state");
    expect(tasksDir()).toBe(join("/tmp/custom-state", "tasks"));
  });

  it("defaults fixturesDir to <cwd>/fixtures", () => {
    expect(fixturesDir()).toBe(join(process.cwd(), "fixtures"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/state/paths.test.ts`
Expected: FAIL — cannot find module `./paths`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/state/paths.ts
import { join } from "node:path";

export function stateDir(): string {
  return process.env.SURTEC_STATE_DIR ?? join(process.cwd(), "state");
}

export function fixturesDir(): string {
  return process.env.SURTEC_FIXTURES_DIR ?? join(process.cwd(), "fixtures");
}

export function tasksDir(base: string = stateDir()): string {
  return join(base, "tasks");
}

export function projectsDir(base: string = stateDir()): string {
  return join(base, "projects");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/state/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/paths.ts lib/state/paths.test.ts
git commit -m "feat(state): add env-overridable path resolution" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Store I/O (`lib/state/store.ts`)

Atomic JSON read/write; `listTasks` skips unreadable files.

**Files:**
- Create: `lib/state/store.ts`
- Test: `lib/state/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/state/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTask, readTask, listTasks, upsertProjectOverride, listProjectOverrides } from "./store";
import type { TaskRecord } from "./types";

function makeRecord(id: string): TaskRecord {
  return {
    envelope: {
      id, source: "cli", project: "stock-control", task_type: "bugfix",
      agent: "backend-engineer", title: `Task ${id}`, instructions: "do it",
      repo_path: "~/dev/surtec/stock-control", branch: `agent/${id}`,
      sandbox: "workspace-write", expected_outputs: ["summary"],
      requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-28T10:00:00Z", started_at: null,
    updated_at: "2026-05-28T10:00:00Z", finished_at: null,
    result: null, logs_path: null,
  };
}

describe("store", () => {
  let dir: string;
  let tasks: string;
  let projects: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "surtec-store-"));
    tasks = join(dir, "tasks");
    projects = join(dir, "projects");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("roundtrips a task write -> read", () => {
    const rec = makeRecord("STK-1");
    writeTask(rec, tasks);
    expect(readTask("STK-1", tasks)).toEqual(rec);
  });

  it("readTask returns null when missing", () => {
    expect(readTask("nope", tasks)).toBeNull();
  });

  it("listTasks returns [] when dir does not exist", () => {
    expect(listTasks(join(dir, "absent"))).toEqual([]);
  });

  it("listTasks skips an unreadable/corrupt file without throwing", () => {
    writeTask(makeRecord("STK-1"), tasks);
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "broken.json"), "{ not json", "utf8");
    const result = listTasks(tasks);
    expect(result.map((r) => r.envelope.id)).toEqual(["STK-1"]);
  });

  it("upserts and lists project overrides", () => {
    upsertProjectOverride({ id: "stock-control", health: "ok", note: "fine" }, projects);
    expect(listProjectOverrides(projects)).toEqual([
      { id: "stock-control", health: "ok", note: "fine" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/state/store.test.ts`
Expected: FAIL — cannot find module `./store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/state/store.ts
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { TaskRecord, ProjectStatusOverride } from "./types";
import { tasksDir, projectsDir } from "./paths";

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function readJsonDir<T>(dir: string, label: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
    } catch (err) {
      console.warn(`[store] skipping unreadable ${label} file ${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function writeTask(record: TaskRecord, dir: string = tasksDir()): void {
  writeJsonAtomic(join(dir, `${record.envelope.id}.json`), record);
}

export function readTask(id: string, dir: string = tasksDir()): TaskRecord | null {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as TaskRecord;
}

export function listTasks(dir: string = tasksDir()): TaskRecord[] {
  return readJsonDir<TaskRecord>(dir, "task");
}

export function listProjectOverrides(dir: string = projectsDir()): ProjectStatusOverride[] {
  return readJsonDir<ProjectStatusOverride>(dir, "project");
}

export function upsertProjectOverride(o: ProjectStatusOverride, dir: string = projectsDir()): void {
  writeJsonAtomic(join(dir, `${o.id}.json`), o);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/state/store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/store.ts lib/state/store.test.ts
git commit -m "feat(state): add atomic JSON store with resilient listing" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Overview derivation (`lib/state/derive.ts`)

Pure function computing the three dashboard views. Defines `RegistryProject` (no yaml dep here).

**Files:**
- Create: `lib/state/derive.ts`
- Test: `lib/state/derive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/state/derive.test.ts
import { describe, it, expect } from "vitest";
import { buildOverview, type RegistryProject } from "./derive";
import type { TaskRecord } from "./types";

const registry: RegistryProject[] = [
  { id: "stock-control", status: "active", repo: "git@github.com:surtec/stock-control.git" },
  { id: "portfolio-site", status: "planned", repo: null },
];

function rec(partial: Partial<TaskRecord> & { id: string; project: string }): TaskRecord {
  return {
    envelope: {
      id: partial.id, source: "cli", project: partial.project, task_type: "bugfix",
      agent: "backend-engineer", title: `Task ${partial.id}`, instructions: "x",
      repo_path: "~/dev", branch: `agent/${partial.id}`, sandbox: "workspace-write",
      expected_outputs: [], requires_human_approval: partial.envelope?.requires_human_approval ?? false,
      metadata: {},
    },
    lifecycle: partial.lifecycle ?? "queued",
    outcome: partial.outcome ?? null,
    created_at: "2026-05-28T10:00:00Z",
    started_at: partial.started_at ?? null,
    updated_at: partial.updated_at ?? "2026-05-28T10:00:00Z",
    finished_at: partial.finished_at ?? null,
    result: partial.result ?? null,
    logs_path: null,
  };
}

describe("buildOverview", () => {
  it("returns empty views when there are no tasks", () => {
    const o = buildOverview(registry, [], []);
    expect(o.inProgress).toEqual([]);
    expect(o.history).toEqual([]);
    expect(o.attention).toEqual([]);
    expect(o.projects.map((p) => p.id)).toEqual(["stock-control", "portfolio-site"]);
    expect(o.projects[0].task_counts).toEqual({ inProgress: 0, finished: 0 });
  });

  it("splits in-progress vs finished and sorts history by finished_at desc", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", lifecycle: "running", updated_at: "2026-05-28T11:00:00Z" }),
      rec({ id: "B", project: "stock-control", lifecycle: "finished", outcome: "completed", finished_at: "2026-05-28T09:00:00Z", updated_at: "2026-05-28T09:00:00Z" }),
      rec({ id: "C", project: "stock-control", lifecycle: "finished", outcome: "completed", finished_at: "2026-05-28T12:00:00Z", updated_at: "2026-05-28T12:00:00Z" }),
    ];
    const o = buildOverview(registry, tasks, []);
    expect(o.inProgress.map((t) => t.id)).toEqual(["A"]);
    expect(o.history.map((t) => t.id)).toEqual(["C", "B"]);
  });

  it("computes project last_activity as max updated_at and applies overrides", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", updated_at: "2026-05-28T11:00:00Z" }),
      rec({ id: "B", project: "stock-control", updated_at: "2026-05-28T13:00:00Z" }),
    ];
    const o = buildOverview(registry, tasks, [{ id: "stock-control", health: "at-risk", note: "watch it" }]);
    const sc = o.projects.find((p) => p.id === "stock-control")!;
    expect(sc.last_activity).toBe("2026-05-28T13:00:00Z");
    expect(sc.health).toBe("at-risk");
    expect(sc.note).toBe("watch it");
    expect(sc.task_counts).toEqual({ inProgress: 2, finished: 0 });
  });

  it("builds attention from needs-review, awaiting-approval, risks and blockers", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", lifecycle: "finished", outcome: "needs-review", finished_at: "2026-05-28T12:00:00Z" }),
      rec({
        id: "B", project: "stock-control", lifecycle: "finished", outcome: "completed",
        finished_at: "2026-05-28T12:00:00Z",
        envelope: { requires_human_approval: true } as TaskRecord["envelope"],
        result: {
          task_id: "B", agent: "backend-engineer", status: "completed", summary: "ok",
          files_changed: [], commands_run: [], tests_run: [],
          risks: ["migration without rollback"], blockers: ["needs prod creds"],
          next_steps: [], artifacts: [], logs_path: "reports/B.jsonl",
        },
      }),
    ];
    const o = buildOverview(registry, tasks, []);
    const kinds = o.attention.map((a) => `${a.kind}:${a.task_id}:${a.title}`);
    expect(kinds).toContain("needs-review:A:Task A");
    expect(kinds).toContain("awaiting-approval:B:Task B");
    expect(kinds).toContain("risk:B:migration without rollback");
    expect(kinds).toContain("blocker:B:needs prod creds");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/state/derive.test.ts`
Expected: FAIL — cannot find module `./derive`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/state/derive.ts
import type {
  TaskRecord, ProjectStatusOverride, OverviewModel, ProjectView, TaskView, AttentionItem,
} from "./types";

export interface RegistryProject {
  id: string;
  status: string;
  repo: string | null;
}

function toTaskView(t: TaskRecord): TaskView {
  return {
    id: t.envelope.id,
    project: t.envelope.project,
    agent: t.envelope.agent,
    title: t.envelope.title,
    lifecycle: t.lifecycle,
    outcome: t.outcome,
    updated_at: t.updated_at,
    finished_at: t.finished_at,
    requires_human_approval: t.envelope.requires_human_approval,
  };
}

export function buildOverview(
  registryProjects: RegistryProject[],
  tasks: TaskRecord[],
  overrides: ProjectStatusOverride[],
): OverviewModel {
  const overrideById = new Map(overrides.map((o) => [o.id, o]));

  const inProgress = tasks
    .filter((t) => t.lifecycle !== "finished")
    .map(toTaskView);

  const history = tasks
    .filter((t) => t.lifecycle === "finished")
    .map(toTaskView)
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));

  const projects: ProjectView[] = registryProjects.map((rp) => {
    const projTasks = tasks.filter((t) => t.envelope.project === rp.id);
    const lastActivity = projTasks.reduce<string | null>(
      (max, t) => (max === null || t.updated_at > max ? t.updated_at : max),
      null,
    );
    const ov = overrideById.get(rp.id);
    return {
      id: rp.id,
      status: rp.status,
      health: ov?.health ?? null,
      note: ov?.note ?? null,
      repo: rp.repo,
      last_activity: lastActivity,
      task_counts: {
        inProgress: projTasks.filter((t) => t.lifecycle !== "finished").length,
        finished: projTasks.filter((t) => t.lifecycle === "finished").length,
      },
    };
  });

  const attention: AttentionItem[] = [];
  for (const t of tasks) {
    if (t.outcome === "needs-review") {
      attention.push({ kind: "needs-review", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title });
    } else if (t.lifecycle === "finished" && t.envelope.requires_human_approval) {
      attention.push({ kind: "awaiting-approval", task_id: t.envelope.id, project: t.envelope.project, title: t.envelope.title });
    }
    if (t.result) {
      for (const r of t.result.risks) {
        attention.push({ kind: "risk", task_id: t.envelope.id, project: t.envelope.project, title: r });
      }
      for (const b of t.result.blockers) {
        attention.push({ kind: "blocker", task_id: t.envelope.id, project: t.envelope.project, title: b });
      }
    }
  }

  return { projects, inProgress, history, attention };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/state/derive.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/derive.ts lib/state/derive.test.ts
git commit -m "feat(state): derive overview views from tasks + registry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Registry loader (`dashboard/src/server/registry.ts`)

Parses `registry/projects.yml` into `RegistryProject[]`. This is where the `yaml` dependency is used (kept out of `lib/state`).

**Files:**
- Create: `dashboard/src/server/registry.ts`
- Test: `dashboard/src/server/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/server/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistryProjects } from "./registry";

describe("loadRegistryProjects", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-reg-"));
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(
      join(root, "registry", "projects.yml"),
      [
        "projects:",
        "  stock-control:",
        "    repo: git@github.com:surtec/stock-control.git",
        "    status: active",
        "  portfolio-site:",
        "    status: planned",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps projects to id/status/repo", () => {
    expect(loadRegistryProjects(root)).toEqual([
      { id: "stock-control", status: "active", repo: "git@github.com:surtec/stock-control.git" },
      { id: "portfolio-site", status: "planned", repo: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/server/registry.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RegistryProject } from "../../../lib/state/derive";

interface RegistryDoc {
  projects?: Record<string, { repo?: string; status?: string }>;
}

export function loadRegistryProjects(repoRoot: string = process.cwd()): RegistryProject[] {
  const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as RegistryDoc;
  const projects = doc.projects ?? {};
  return Object.entries(projects).map(([id, v]) => ({
    id,
    status: v?.status ?? "unknown",
    repo: v?.repo ?? null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/registry.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/registry.ts dashboard/src/server/registry.test.ts
git commit -m "feat(dashboard): load registry projects from YAML" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: API server (`dashboard/src/server/index.ts`)

Hono app exposing `/api/overview` and `/api/tasks/:id`, plus static serving of the built UI. Tested via `app.request()` (no listening socket needed).

**Files:**
- Create: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/server/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index";

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-api-"));
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    status: active\n",
    "utf8",
  );
  stateDir = join(root, "state");
  mkdirSync(join(stateDir, "tasks"), { recursive: true });
  const task = {
    envelope: {
      id: "STK-1", source: "cli", project: "stock-control", task_type: "bugfix",
      agent: "backend-engineer", title: "Fix it", instructions: "x", repo_path: "~/dev",
      branch: "agent/STK-1", sandbox: "workspace-write", expected_outputs: [],
      requires_human_approval: false, metadata: {},
    },
    lifecycle: "running", outcome: null, created_at: "2026-05-28T10:00:00Z",
    started_at: "2026-05-28T10:00:00Z", updated_at: "2026-05-28T10:00:00Z",
    finished_at: null, result: null, logs_path: null,
  };
  writeFileSync(join(stateDir, "tasks", "STK-1.json"), JSON.stringify(task), "utf8");
  process.env.SURTEC_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("api", () => {
  it("GET /api/overview returns the four view arrays", async () => {
    const app = createApp(root);
    const res = await app.request("/api/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["stock-control"]);
    expect(body.inProgress.map((t: { id: string }) => t.id)).toEqual(["STK-1"]);
    expect(body.history).toEqual([]);
  });

  it("GET /api/tasks/:id returns the record", async () => {
    const app = createApp(root);
    const res = await app.request("/api/tasks/STK-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope.id).toBe("STK-1");
  });

  it("GET /api/tasks/:id returns 404 when missing", async () => {
    const app = createApp(root);
    const res = await app.request("/api/tasks/NOPE");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — cannot find module `./index` (or `createApp` not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/server/index.ts
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { listTasks, listProjectOverrides, readTask } from "../../../lib/state/store";
import { buildOverview } from "../../../lib/state/derive";
import { loadRegistryProjects } from "./registry";

export function createApp(repoRoot: string = process.cwd()): Hono {
  const app = new Hono();

  app.get("/api/overview", (c) => {
    try {
      const overview = buildOverview(
        loadRegistryProjects(repoRoot),
        listTasks(),
        listProjectOverrides(),
      );
      return c.json(overview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const rec = readTask(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  return app;
}

// Entrypoint: only runs when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  const app = createApp();
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));
  const port = Number(process.env.PORT ?? 4317);
  serve({ fetch: app.fetch, port });
  console.log(`Surtec Control Plane dashboard on http://localhost:${port}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(dashboard): add Hono API for overview and task detail" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Fixtures + CLI (`cli/surtec-state.ts`)

Example data and the `record | set-status | seed` commands.

**Files:**
- Create: `fixtures/tasks/STK-001.json`, `fixtures/tasks/STK-002.json`, `fixtures/projects/stock-control.json`
- Create: `cli/surtec-state.ts`

- [ ] **Step 1: Create fixture `fixtures/tasks/STK-001.json`** (finished, needs approval, with a risk)

```json
{
  "envelope": {
    "id": "STK-001", "source": "cli", "project": "stock-control",
    "task_type": "backend-implementation", "agent": "backend-engineer",
    "title": "Add low-stock alert endpoint", "instructions": "Implement GET /alerts/low-stock.",
    "repo_path": "~/dev/surtec/stock-control", "branch": "agent/STK-001-backend-engineer",
    "sandbox": "workspace-write", "expected_outputs": ["summary", "files_changed", "tests_run"],
    "requires_human_approval": true, "metadata": { "priority": "high" }
  },
  "lifecycle": "finished", "outcome": "completed",
  "created_at": "2026-05-28T09:00:00Z", "started_at": "2026-05-28T09:05:00Z",
  "updated_at": "2026-05-28T09:40:00Z", "finished_at": "2026-05-28T09:40:00Z",
  "result": {
    "task_id": "STK-001", "agent": "backend-engineer", "status": "completed",
    "summary": "Added low-stock alert endpoint with tests.",
    "files_changed": ["src/routes/alerts.ts", "test/alerts.test.ts"],
    "commands_run": ["pnpm test"], "tests_run": ["alerts.test.ts"],
    "risks": ["No rate limiting on the new endpoint"], "blockers": [],
    "next_steps": ["Add rate limiting"], "artifacts": [],
    "logs_path": "reports/STK-001-backend-engineer.jsonl"
  },
  "logs_path": "reports/STK-001-backend-engineer.jsonl"
}
```

- [ ] **Step 2: Create fixture `fixtures/tasks/STK-002.json`** (running)

```json
{
  "envelope": {
    "id": "STK-002", "source": "cli", "project": "stock-control",
    "task_type": "qa-review", "agent": "qa-reviewer",
    "title": "Regression pass on checkout", "instructions": "Run the regression suite on checkout.",
    "repo_path": "~/dev/surtec/stock-control", "branch": "agent/STK-002-qa-reviewer",
    "sandbox": "read-only", "expected_outputs": ["summary", "tests_run"],
    "requires_human_approval": false, "metadata": {}
  },
  "lifecycle": "running", "outcome": null,
  "created_at": "2026-05-28T11:00:00Z", "started_at": "2026-05-28T11:02:00Z",
  "updated_at": "2026-05-28T11:15:00Z", "finished_at": null,
  "result": null, "logs_path": null
}
```

- [ ] **Step 3: Create fixture `fixtures/projects/stock-control.json`**

```json
{ "id": "stock-control", "health": "ok", "note": "MVP in active development" }
```

- [ ] **Step 4: Write the failing test**

```ts
// cli/surtec-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeed } from "./surtec-state";

describe("cli seed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-cli-"));
    mkdirSync(join(root, "fixtures", "tasks"), { recursive: true });
    mkdirSync(join(root, "fixtures", "projects"), { recursive: true });
    writeFileSync(join(root, "fixtures", "tasks", "T-1.json"), "{}", "utf8");
    writeFileSync(join(root, "fixtures", "projects", "p.json"), "{}", "utf8");
    process.env.SURTEC_STATE_DIR = join(root, "state");
    process.env.SURTEC_FIXTURES_DIR = join(root, "fixtures");
  });
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_FIXTURES_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("copies fixtures into the state dir", () => {
    const { tasks, projects } = runSeed();
    expect(tasks).toBe(1);
    expect(projects).toBe(1);
    expect(existsSync(join(root, "state", "tasks", "T-1.json"))).toBe(true);
    expect(existsSync(join(root, "state", "projects", "p.json"))).toBe(true);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm exec vitest run cli/surtec-state.test.ts`
Expected: FAIL — cannot find module `./surtec-state`.

- [ ] **Step 6: Write minimal implementation**

```ts
// cli/surtec-state.ts
import {
  readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskEnvelope, TaskRecord, AgentResult } from "../lib/state/types";
import { readTask, writeTask } from "../lib/state/store";
import { stateDir, fixturesDir, tasksDir, projectsDir } from "../lib/state/paths";

function now(): string {
  return new Date().toISOString();
}

export function runRecord(envelopeFile: string): string {
  const envelope = JSON.parse(readFileSync(envelopeFile, "utf8")) as TaskEnvelope;
  const ts = now();
  const record: TaskRecord = {
    envelope, lifecycle: "queued", outcome: null,
    created_at: ts, started_at: null, updated_at: ts, finished_at: null,
    result: null, logs_path: null,
  };
  writeTask(record);
  return envelope.id;
}

export function runSetStatus(id: string, status: string, resultFile?: string): string {
  const rec = readTask(id);
  if (!rec) throw new Error(`task not found: ${id}`);
  const ts = now();
  rec.updated_at = ts;
  if (status === "running") {
    rec.lifecycle = "running";
    rec.started_at = rec.started_at ?? ts;
  } else if (status === "finished") {
    if (!resultFile) throw new Error("set-status finished requires --result <file>");
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as AgentResult;
    rec.lifecycle = "finished";
    rec.finished_at = ts;
    rec.outcome = result.status;
    rec.result = result;
    rec.logs_path = result.logs_path;
  } else {
    throw new Error(`unknown status: ${status} (use running|finished)`);
  }
  writeTask(rec);
  return rec.lifecycle;
}

function copyJsonDir(srcDir: string, destDir: string): number {
  if (!existsSync(srcDir)) return 0;
  mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".json")) continue;
    copyFileSync(join(srcDir, f), join(destDir, f));
    n++;
  }
  return n;
}

export function runSeed(): { tasks: number; projects: number } {
  return {
    tasks: copyJsonDir(join(fixturesDir(), "tasks"), tasksDir()),
    projects: copyJsonDir(join(fixturesDir(), "projects"), projectsDir()),
  };
}

function parseFlags(args: string[]): { flags: Record<string, string>; pos: string[] } {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; }
    else pos.push(args[i]);
  }
  return { flags, pos };
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  switch (cmd) {
    case "record": {
      if (!flags.from) throw new Error("usage: surtec-state record --from <envelope.json>");
      console.log(`recorded ${runRecord(flags.from)} (queued)`);
      break;
    }
    case "set-status": {
      const lifecycle = runSetStatus(pos[0], pos[1], flags.result);
      console.log(`updated ${pos[0]} -> ${lifecycle}`);
      break;
    }
    case "seed": {
      const { tasks, projects } = runSeed();
      console.log(`seeded ${tasks} task(s) and ${projects} project override(s) into ${stateDir()}`);
      break;
    }
    default:
      throw new Error("usage: surtec-state <record --from <file> | set-status <id> <running|finished> [--result <file>] | seed>");
  }
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("surtec-state.ts")) {
  main();
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm exec vitest run cli/surtec-state.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Manually seed and confirm**

Run: `pnpm state seed`
Expected: prints `seeded 2 task(s) and 1 project override(s) into <repo>/state`; `state/tasks/STK-001.json`, `state/tasks/STK-002.json`, `state/projects/stock-control.json` now exist (and are gitignored).

- [ ] **Step 9: Commit**

```bash
git add cli/surtec-state.ts cli/surtec-state.test.ts fixtures
git commit -m "feat(cli): add surtec-state record/set-status/seed + fixtures" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: React UI (layout A)

Classic panel: sidebar + grid (project cards on top; in-progress and attention below). Polls `/api/overview` every 3s.

**Files:**
- Create: `dashboard/index.html`, `dashboard/src/main.tsx`, `dashboard/src/ui/api.ts`,
  `dashboard/src/ui/App.tsx`, `dashboard/src/ui/components/{Sidebar,ProjectCard,TaskList,AttentionPanel}.tsx`
- Test: `dashboard/src/ui/App.test.tsx`

- [ ] **Step 1: Create `dashboard/index.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Surtec Control Plane</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `dashboard/src/ui/api.ts`**

```ts
import { useEffect, useState } from "react";
import type { OverviewModel } from "../../../lib/state/types";

export async function fetchOverview(): Promise<OverviewModel> {
  const res = await fetch("/api/overview");
  if (!res.ok) throw new Error(`overview failed: ${res.status}`);
  return (await res.json()) as OverviewModel;
}

export function useOverview(intervalMs = 3000): { data: OverviewModel | null; error: string | null } {
  const [data, setData] = useState<OverviewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchOverview();
        if (active) { setData(next); setError(null); }
      } catch (err) {
        if (active) setError((err as Error).message); // keep last good data
      }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);

  return { data, error };
}
```

- [ ] **Step 3: Create the components**

`dashboard/src/ui/components/Sidebar.tsx`:
```tsx
export function Sidebar() {
  const items = ["Overview", "Proyectos", "Tareas", "Riesgos"];
  return (
    <nav style={{ width: 160, padding: 16, borderRight: "1px solid #ddd" }}>
      <h3 style={{ marginTop: 0 }}>Surtec</h3>
      <ul style={{ listStyle: "none", padding: 0, lineHeight: 2 }}>
        {items.map((i) => <li key={i}>▸ {i}</li>)}
      </ul>
    </nav>
  );
}
```

`dashboard/src/ui/components/ProjectCard.tsx`:
```tsx
import type { ProjectView } from "../../../../lib/state/types";

export function ProjectCard({ p }: { p: ProjectView }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, minWidth: 180 }}>
      <strong>{p.id}</strong>
      <div style={{ fontSize: 12, color: "#666" }}>
        {p.status}{p.health ? ` · ${p.health}` : ""}
      </div>
      <div style={{ fontSize: 12 }}>
        {p.task_counts.inProgress} en curso · {p.task_counts.finished} hechas
      </div>
      <div style={{ fontSize: 11, color: "#999" }}>
        {p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}
      </div>
    </div>
  );
}
```

`dashboard/src/ui/components/TaskList.tsx`:
```tsx
import type { TaskView } from "../../../../lib/state/types";

export function TaskList({ title, tasks }: { title: string; tasks: TaskView[] }) {
  return (
    <section style={{ flex: 1 }}>
      <h4>{title}</h4>
      {tasks.length === 0 ? (
        <p style={{ color: "#999" }}>Nada por ahora.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {tasks.map((t) => (
            <li key={t.id}>
              <strong>{t.id}</strong> · {t.agent} · {t.title}
              {t.outcome ? ` (${t.outcome})` : ` [${t.lifecycle}]`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`dashboard/src/ui/components/AttentionPanel.tsx`:
```tsx
import type { AttentionItem } from "../../../../lib/state/types";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <section style={{ flex: 1 }}>
      <h4>⚠ Necesita tu atención</h4>
      {items.length === 0 ? (
        <p style={{ color: "#999" }}>Todo en orden.</p>
      ) : (
        <ul style={{ paddingLeft: 16 }}>
          {items.map((a, i) => (
            <li key={`${a.task_id}-${i}`}>
              <em>{LABEL[a.kind]}</em> · {a.task_id} · {a.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`dashboard/src/ui/App.tsx`:
```tsx
import { useOverview } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";

export function App() {
  const { data, error } = useOverview();

  return (
    <div style={{ display: "flex", fontFamily: "system-ui, sans-serif", minHeight: "100vh" }}>
      <Sidebar />
      <main style={{ flex: 1, padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>Estado vivo</h2>
        {error && (
          <div style={{ background: "#fff3cd", padding: 8, borderRadius: 6, marginBottom: 12 }}>
            No pude refrescar ({error}); mostrando el último estado conocido.
          </div>
        )}
        {!data ? (
          <p>Cargando…</p>
        ) : (
          <>
            <section>
              <h4>Proyectos</h4>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {data.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
              </div>
            </section>
            <div style={{ display: "flex", gap: 24, marginTop: 24 }}>
              <TaskList title="En curso" tasks={data.inProgress} />
              <AttentionPanel items={data.attention} />
            </div>
            <div style={{ marginTop: 24 }}>
              <TaskList title="Historial" tasks={data.history} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
```

`dashboard/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Write the failing UI test**

```tsx
// dashboard/src/ui/App.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { OverviewModel } from "../../../lib/state/types";

const overview: OverviewModel = {
  projects: [{
    id: "stock-control", status: "active", health: "ok", note: null,
    repo: null, last_activity: "2026-05-28T11:15:00Z",
    task_counts: { inProgress: 1, finished: 1 },
  }],
  inProgress: [{
    id: "STK-002", project: "stock-control", agent: "qa-reviewer",
    title: "Regression pass", lifecycle: "running", outcome: null,
    updated_at: "2026-05-28T11:15:00Z", finished_at: null, requires_human_approval: false,
  }],
  history: [],
  attention: [{ kind: "risk", task_id: "STK-001", project: "stock-control", title: "No rate limiting" }],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => overview,
  })) as unknown as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("renders projects, in-progress tasks and attention items", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("stock-control")).toBeTruthy());
    expect(screen.getByText(/STK-002/)).toBeTruthy();
    expect(screen.getByText(/No rate limiting/)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run test to verify it fails, then passes**

Run: `pnpm exec vitest run dashboard/src/ui/App.test.tsx`
Expected: FAIL first (missing modules), then PASS once Steps 1-3 files exist. If you wrote Steps 1-3 before the test, it should PASS on first run (1 test).

- [ ] **Step 6: Manual smoke test**

Run (two terminals or `pnpm dev`): `pnpm dev`
Then open `http://localhost:5173`.
Expected: sidebar + "Estado vivo"; one project card (`stock-control`), `STK-002` under "En curso", the risk under "Necesita tu atención", `STK-001` under "Historial". (Run `pnpm state seed` first if `state/` is empty.)

- [ ] **Step 7: Commit**

```bash
git add dashboard/index.html dashboard/src
git commit -m "feat(dashboard): add React UI (layout A) with polling" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Record the Codex → Claude pivot in the repo

**Files:**
- Modify: `registry/companies.yml`
- Modify: `adapters/codex-runner/README.md`
- Create: `agents/codex/README.md`

- [ ] **Step 1: Update `registry/companies.yml`**

Change the executor line:
```yaml
  default_executor: claude
```
(from `default_executor: codex-cli`).

- [ ] **Step 2: Add a DEPRECATED banner at the top of `adapters/codex-runner/README.md`**

```markdown
> **DEPRECATED (2026-05-28):** Surtec standardizes execution on Claude tooling
> (Claude Agent SDK / Claude Code). This Codex runner is kept for reference only and
> receives no further investment. The Claude runner will be introduced in the
> "dispatch" slice. See `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.
```

- [ ] **Step 3: Create `agents/codex/README.md`**

```markdown
# Codex agents — DEPRECATED (2026-05-28)

These `*.toml` Codex agent definitions are kept for reference. Surtec is moving
execution to Claude tooling (Claude Agent SDK / Claude Code); the replacement agent
definitions will be introduced alongside the Claude runner in the "dispatch" slice.
Do not invest further in these files. See
`docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.
```

- [ ] **Step 4: Validate the registry still parses**

Run: `pnpm validate:registry`
Expected: passes (or the existing minimal-existence check passes).

- [ ] **Step 5: Commit**

```bash
git add registry/companies.yml adapters/codex-runner/README.md agents/codex/README.md
git commit -m "chore: mark Codex execution deprecated; default_executor=claude" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: README pointer + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Dashboard (local)" section to `README.md`** (after the "Status" section)

```markdown
## Dashboard (local)

A local web dashboard shows live status across Surtec projects (project cards,
in-progress/history tasks, risks and pending approvals). It reads a file-first store
under `state/` (gitignored).

```bash
pnpm install
pnpm state seed     # load example data into state/
pnpm dev            # UI on http://localhost:5173 (API on :4317)
```

For a production-style run: `pnpm build && pnpm start` (serves UI + API on :4317).
Design: `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: all suites PASS (paths, store, derive, registry, api, cli, App).

- [ ] **Step 3: Type-check the whole project**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Production build smoke test**

Run: `pnpm build`
Expected: Vite builds to `dashboard/dist` without errors.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the local dashboard in README" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** store interface (Tasks 1-4), CLI record/set-status/seed (Task 7),
  dashboard API + UI layout A (Tasks 5-6, 8), `state/` gitignored (Task 0), three views
  incl. attention/approval logic (Task 4), Codex→Claude pivot (Task 9). All spec
  sections map to a task.
- **Placeholders:** none — every code step contains complete code; every command has
  expected output.
- **Type consistency:** `TaskRecord`, `OverviewModel`, `RegistryProject`, `buildOverview`,
  `createApp`, `loadRegistryProjects`, `runSeed/runRecord/runSetStatus`,
  `useOverview/fetchOverview` are used with identical signatures across tasks.
- **Known deviation from spec:** single root `package.json` instead of a separate
  `dashboard/` package (flagged in the header). `lib/state` remains dependency-free.
```
