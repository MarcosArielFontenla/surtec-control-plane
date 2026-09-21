# Control Plane Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the control-plane dashboard to the "Control Plane Design" layout (from the user's standalone mockup) on the existing Boreal tokens, preserving all behaviour and deriving new affordances (KPIs, sidebar Resumen, Historial) from real API data.

**Architecture:** Pure presentation overhaul. `dashboard/src/ui/styles/dashboard.css` is rewritten to the mockup's class vocabulary; `boreal-tokens.css` is untouched. React components are re-structured to emit the new markup while keeping their props, hooks, and side-effect logic. A new `lucide-react` dependency supplies icons; a small inline `BrandMark` SVG is the logo. One pure helper `deriveKpis` computes the KPI/summary numbers from `OverviewModel` + runs.

**Tech Stack:** TS ESM, React 18, Vite, Vitest + Testing Library/jsdom, lucide-react, Hono API (unchanged), pnpm. Windows/PowerShell.

**Reference (on disk, gitignored):** `extracted-design/_template.html` — the decoded mockup. Its third `<style>` block (lines **452–752**) is the canonical source for the new CSS; its `<body>` (lines **754–993**) is the canonical markup/structure reference. The logo SVG is `extracted-design/63527529-da41-4b5f-bc59-ca1bf09e60c3`.

**Data shape (unchanged, from `lib/state/types.ts`):**
`OverviewModel = { projects: ProjectView[]; inProgress: TaskView[]; history: TaskView[]; attention: AttentionItem[] }`.
`ProjectView` has `id, status, health, note, repo, path, configured, git: GitStatus|null, last_activity, task_counts:{inProgress,finished}`.
`GitStatus` has `branch, dirty, uncommitted, ahead, behind, last_commit:{hash,subject,at}|null, ok`.
`AttentionItem.kind ∈ "needs-review" | "awaiting-approval" | "risk" | "blocker"`.
`TaskView` has `id, project, agent, title, lifecycle, outcome, updated_at, finished_at, requires_human_approval`.
`RunRecord` (from `useRuns`) has `runId, projectId, kind:"dev"|"oneshot", status:"running"|..., command`.

**Naming contract (used across tasks — keep identical):**
- New util: `dashboard/src/ui/derive-kpis.ts` exporting `deriveKpis(data, runs)` and `deriveSummary(data)`.
- New components: `dashboard/src/ui/components/KpiStrip.tsx`, `dashboard/src/ui/components/BrandMark.tsx`, `dashboard/src/ui/components/InProgressColumn.tsx`.
- `Sidebar` gains a `summary: Summary` prop (type defined in Task 3).
- `NewTaskForm` gains a `bulkProjectIds: string[]` prop (the ids BulkSync should act on).

---

## File Structure

**Create:**
- `dashboard/src/ui/components/BrandMark.tsx` — inline logo SVG component.
- `dashboard/src/ui/derive-kpis.ts` — `deriveKpis` + `deriveSummary` pure functions + `Kpi`/`Summary` types.
- `dashboard/src/ui/derive-kpis.test.ts` — unit tests for the derivations.
- `dashboard/src/ui/components/KpiStrip.tsx` — the 4-KPI strip.
- `dashboard/src/ui/components/KpiStrip.test.tsx` — render tests.
- `dashboard/src/ui/components/InProgressColumn.tsx` — en-curso empty state + Historial reciente.
- `dashboard/src/ui/components/InProgressColumn.test.tsx` — render tests.

**Modify:**
- `dashboard/package.json` — add `lucide-react`.
- `dashboard/src/ui/styles/dashboard.css` — full rewrite to the new class vocabulary.
- `dashboard/src/ui/components/Sidebar.tsx` — icon nav + Resumen + scroll anchors.
- `dashboard/src/ui/components/NewTaskForm.tsx` — task-panel + integrated bulk sync.
- `dashboard/src/ui/components/BulkSync.tsx` — expose a headless/ghost-button variant used inside the task panel (keep logic).
- `dashboard/src/ui/components/ProjectCard.tsx` — new card structure.
- `dashboard/src/ui/components/AttentionPanel.tsx` — tags by kind + mini-ctas.
- `dashboard/src/ui/App.tsx` — grid shell, topbar live pill, KPIs, two-col, scroll refs.
- `dashboard/src/ui/views/ProcesosView.tsx` — re-skin to `.panel`/mono.
- Test files for each modified component (update markup expectations).

**Delete:**
- `dashboard/src/ui/components/TaskList.tsx` + `TaskList` usages — replaced by `InProgressColumn` (Historial + en-curso). (Confirm no other importers first.)

---

## Task 1: Dependency + BrandMark logo

**Files:**
- Modify: `dashboard/package.json`
- Create: `dashboard/src/ui/components/BrandMark.tsx`

- [ ] **Step 1: Add lucide-react**

Run (from repo root):
```
pnpm --filter ./dashboard add lucide-react
```
If the dashboard is not a separate pnpm workspace package, run `pnpm add lucide-react` at the root. Expected: `lucide-react` appears in `dashboard/package.json` (or root `package.json`) dependencies and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Verify it imports**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0 (no errors introduced).

- [ ] **Step 3: Create the BrandMark component**

The SVG is the mockup's ember+glacier compass (verbatim paths from `extracted-design/63527529-...`).

```tsx
// dashboard/src/ui/components/BrandMark.tsx
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="#E8884C" strokeWidth="2.4" strokeLinecap="round">
        <path d="M24 6 V42" />
        <path d="M8.4 15 L39.6 33" />
        <path d="M8.4 33 L39.6 15" />
        <path d="M24 6 l-4 6 m4 -6 l4 6" />
        <path d="M24 42 l-4 -6 m4 6 l4 -6" />
      </g>
      <g stroke="#86BEDF" strokeWidth="2" strokeLinecap="round" opacity="0.9">
        <path d="M8.4 15 l1.5 6.8 M8.4 15 l6.8 1.6" />
        <path d="M39.6 33 l-1.5 -6.8 M39.6 33 l-6.8 -1.6" />
        <path d="M39.6 15 l-6.8 1.6 M39.6 15 l-1.5 6.8" />
        <path d="M8.4 33 l6.8 -1.6 M8.4 33 l1.5 -6.8" />
      </g>
    </svg>
  );
}
```

- [ ] **Step 4: Commit**

```
git add dashboard/package.json pnpm-lock.yaml dashboard/src/ui/components/BrandMark.tsx
git commit -m "feat(ui): add lucide-react + BrandMark logo for the control-plane redesign"
```

---

## Task 2: Rewrite dashboard.css to the new vocabulary

**Files:**
- Modify: `dashboard/src/ui/styles/dashboard.css` (full replace)

This is CSS-only; jsdom tests are unaffected. The app will look partially unstyled until the component tasks land — expected on a WIP branch.

- [ ] **Step 1: Replace the file body with the mockup's CSS**

Copy the **third `<style>` block** from `extracted-design/_template.html` (lines **452–752**) verbatim into `dashboard/src/ui/styles/dashboard.css`, replacing the entire current file. Then apply these adaptations:

1. Keep the leading reset/base from the block:
   `* { box-sizing: border-box; margin: 0; padding: 0; }`, `html, body { height: 100%; }`, the `body { ... background: var(--grad-aurora), var(--grad-night); ... }` rule, and `::selection`.
2. The mockup targets bare `select, .input, textarea` and `::placeholder`. Keep these — our selects/textarea use the same elements. Add `.es-select`, `.es-input`, `.es-textarea` as aliases on the same rule selector list so any not-yet-converted markup still picks up the styling, i.e. change the selector
   `select, .input, textarea {` → `select, .input, textarea, .es-select, .es-input, .es-textarea {`
   and `select { appearance: none; ... }` → `select, .es-select { appearance: none; ... }`
   and `select:focus, textarea:focus {` → `select:focus, textarea:focus, .es-select:focus, .es-textarea:focus {`.
3. Remove nothing else. The `@import`/font-face and `:root` tokens live in `boreal-tokens.css` (already imported before this file in `main.tsx`) — do NOT duplicate them here.

- [ ] **Step 2: Verify the build still compiles the CSS**

Run: `pnpm build`
Expected: `✓ built` with one CSS asset emitted, no errors.

- [ ] **Step 3: Verify tests are still green (CSS doesn't touch jsdom)**

Run: `pnpm test`
Expected: the current suite still passes (319), since class-name changes haven't landed in components yet.

- [ ] **Step 4: Commit**

```
git add dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): rewrite dashboard.css to the control-plane redesign vocabulary"
```

---

## Task 3: deriveKpis + deriveSummary pure functions

**Files:**
- Create: `dashboard/src/ui/derive-kpis.ts`
- Test: `dashboard/src/ui/derive-kpis.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/src/ui/derive-kpis.test.ts
import { describe, it, expect } from "vitest";
import { deriveKpis, deriveSummary } from "./derive-kpis";
import type { OverviewModel } from "../../../lib/state/types";

function model(over: Partial<OverviewModel> = {}): OverviewModel {
  return { projects: [], inProgress: [], history: [], attention: [], ...over };
}
const proj = (id: string, configured: boolean, git: Partial<NonNullable<OverviewModel["projects"][number]["git"]>> | null) => ({
  id, status: "", health: null, note: null, repo: null, path: null, configured,
  git: git === null ? null : { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true, ...git },
  last_activity: null, task_counts: { inProgress: 0, finished: 0 },
});

describe("deriveSummary", () => {
  it("counts totals, configured, unconfigured, and projects needing attention", () => {
    const m = model({
      projects: [proj("a", true, {}), proj("b", true, {}), proj("c", false, null)],
      attention: [
        { kind: "awaiting-approval", task_id: "T1", project: "a", title: "x" },
        { kind: "risk", task_id: "T2", project: "a", title: "y" },
      ],
    });
    expect(deriveSummary(m)).toEqual({ total: 3, configured: 2, unconfigured: 1, attention: 2 });
  });
});

describe("deriveKpis", () => {
  it("derives the four KPI cards from overview + runs", () => {
    const m = model({
      projects: [
        proj("a", true, { dirty: true, uncommitted: 5 }),
        proj("b", true, { dirty: true, uncommitted: 3 }),
        proj("c", false, null),
      ],
      inProgress: [{ id: "T9", project: "a", agent: "x", title: "t", lifecycle: "running", outcome: null, updated_at: "", finished_at: null, requires_human_approval: false }],
      attention: [
        { kind: "awaiting-approval", task_id: "T1", project: "a", title: "x" },
        { kind: "risk", task_id: "T2", project: "b", title: "y" },
        { kind: "blocker", task_id: "T3", project: "b", title: "z" },
      ],
    });
    const k = deriveKpis(m, []);
    expect(k.projects).toEqual({ value: "3", foot: "2 activos · 1 descubiertos" });
    expect(k.inProgress).toEqual({ value: "1", foot: "1 corriendo" });
    expect(k.attention).toEqual({ value: "3", foot: "1 aprobar · 1 riesgo · 1 bloqueo", emphasis: "ember" });
    expect(k.uncommitted).toEqual({ value: "8", foot: "en 2 repos", emphasis: "aurora" });
  });

  it("handles the empty/zero case", () => {
    const k = deriveKpis(model(), []);
    expect(k.inProgress).toEqual({ value: "0", foot: "sin tareas corriendo" });
    expect(k.uncommitted).toEqual({ value: "0", foot: "en 0 repos", emphasis: "aurora" });
    expect(k.attention.value).toBe("0");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/derive-kpis.test.ts`
Expected: FAIL — cannot find module `./derive-kpis`.

- [ ] **Step 3: Implement**

```ts
// dashboard/src/ui/derive-kpis.ts
import type { OverviewModel, RunRecord } from "../../../lib/state/types";

export interface Summary { total: number; configured: number; unconfigured: number; attention: number; }
export interface Kpi { value: string; foot: string; emphasis?: "ember" | "aurora"; }
export interface Kpis { projects: Kpi; inProgress: Kpi; attention: Kpi; uncommitted: Kpi; }

export function deriveSummary(data: OverviewModel): Summary {
  const total = data.projects.length;
  const configured = data.projects.filter((p) => p.configured).length;
  return { total, configured, unconfigured: total - configured, attention: data.attention.length };
}

export function deriveKpis(data: OverviewModel, _runs: RunRecord[]): Kpis {
  const { total, configured, unconfigured, attention } = deriveSummary(data);

  const running = data.inProgress.length;

  const byKind = (k: string) => data.attention.filter((a) => a.kind === k).length;
  const attnFoot = [
    [byKind("awaiting-approval"), "aprobar"],
    [byKind("risk"), "riesgo"],
    [byKind("blocker"), "bloqueo"],
    [byKind("needs-review"), "revisar"],
  ] as const;
  const attnParts = attnFoot.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);

  const dirtyRepos = data.projects.filter((p) => p.git?.ok && p.git.dirty);
  const uncommitted = dirtyRepos.reduce((sum, p) => sum + (p.git?.uncommitted ?? 0), 0);

  return {
    projects: { value: String(total), foot: `${configured} activos · ${unconfigured} descubiertos` },
    inProgress: { value: String(running), foot: running === 0 ? "sin tareas corriendo" : `${running} corriendo` },
    attention: {
      value: String(attention),
      foot: attnParts.length ? attnParts.join(" · ") : "todo en orden",
      emphasis: "ember",
    },
    uncommitted: { value: String(uncommitted), foot: `en ${dirtyRepos.length} repos`, emphasis: "aurora" },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/derive-kpis.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/derive-kpis.ts dashboard/src/ui/derive-kpis.test.ts
git commit -m "feat(ui): deriveKpis/deriveSummary from overview data"
```

---

## Task 4: KpiStrip component

**Files:**
- Create: `dashboard/src/ui/components/KpiStrip.tsx`
- Test: `dashboard/src/ui/components/KpiStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/src/ui/components/KpiStrip.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiStrip } from "./KpiStrip";
import type { Kpis } from "../derive-kpis";

const kpis: Kpis = {
  projects: { value: "14", foot: "12 activos · 2 descubiertos" },
  inProgress: { value: "0", foot: "sin tareas corriendo" },
  attention: { value: "3", foot: "1 aprobar · 1 riesgo · 1 bloqueo", emphasis: "ember" },
  uncommitted: { value: "2400", foot: "en 4 repos", emphasis: "aurora" },
};

describe("KpiStrip", () => {
  it("renders the four KPI labels, values and foots", () => {
    render(<KpiStrip kpis={kpis} />);
    for (const label of ["Proyectos", "En curso", "Atención", "Sin commitear"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("1 aprobar · 1 riesgo · 1 bloqueo")).toBeInTheDocument();
    expect(screen.getByText("en 4 repos")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/KpiStrip.test.tsx`
Expected: FAIL — cannot find module `./KpiStrip`.

- [ ] **Step 3: Implement**

```tsx
// dashboard/src/ui/components/KpiStrip.tsx
import { FolderGit2, Loader, BellRing, GitCommitHorizontal } from "lucide-react";
import type { Kpis, Kpi } from "../derive-kpis";

function KpiCard({ label, kpi, Icon }: { label: string; kpi: Kpi; Icon: typeof FolderGit2 }) {
  return (
    <div className="kpi">
      <span className="b-label">{label}</span>
      <span className={`num${kpi.emphasis ? ` ${kpi.emphasis}` : ""}`}>{kpi.value}</span>
      <span className="foot">{kpi.foot}</span>
      <span className="spark"><Icon /></span>
    </div>
  );
}

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <section className="kpis">
      <KpiCard label="Proyectos" kpi={kpis.projects} Icon={FolderGit2} />
      <KpiCard label="En curso" kpi={kpis.inProgress} Icon={Loader} />
      <KpiCard label="Atención" kpi={kpis.attention} Icon={BellRing} />
      <KpiCard label="Sin commitear" kpi={kpis.uncommitted} Icon={GitCommitHorizontal} />
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/KpiStrip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/KpiStrip.tsx dashboard/src/ui/components/KpiStrip.test.tsx
git commit -m "feat(ui): KpiStrip component"
```

---

## Task 5: Sidebar — icon nav + Resumen + scroll anchors

**Files:**
- Modify: `dashboard/src/ui/components/Sidebar.tsx`
- Test: `dashboard/src/ui/components/Sidebar.test.tsx` (create)

The nav items stay (`NAV_ITEMS`). Overview/Procesos switch view (handled by `App`); Proyectos/Tareas/Atención are scroll anchors (the `onSelect` callback still fires for all — `App` decides what to do). The Resumen is rendered from the `summary` prop.

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/src/ui/components/Sidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

const summary = { total: 14, configured: 12, unconfigured: 2, attention: 3 };

describe("Sidebar", () => {
  it("renders brand, nav items and the derived Resumen", () => {
    render(<Sidebar active="Overview" onSelect={() => {}} summary={summary} connected />);
    expect(screen.getByText("Surtec")).toBeInTheDocument();
    for (const item of ["Overview", "Procesos", "Proyectos", "Tareas", "Atención"]) {
      expect(screen.getByRole("button", { name: new RegExp(item) })).toBeInTheDocument();
    }
    expect(screen.getByText("14")).toBeInTheDocument(); // total
    expect(screen.getByText("12")).toBeInTheDocument(); // configured
  });

  it("fires onSelect with the clicked nav item", () => {
    const onSelect = vi.fn();
    render(<Sidebar active="Overview" onSelect={onSelect} summary={summary} connected />);
    fireEvent.click(screen.getByRole("button", { name: /Procesos/ }));
    expect(onSelect).toHaveBeenCalledWith("Procesos");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/Sidebar.test.tsx`
Expected: FAIL — `summary`/`connected` props don't exist yet; Resumen not rendered.

- [ ] **Step 3: Implement**

```tsx
// dashboard/src/ui/components/Sidebar.tsx
import { LayoutDashboard, Cpu, FolderGit2, ListChecks, Bell } from "lucide-react";
import { BrandMark } from "./BrandMark";
import type { Summary } from "../derive-kpis";

export const NAV_ITEMS = ["Overview", "Procesos", "Proyectos", "Tareas", "Atención"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

const NAV_ICON: Record<NavItem, typeof LayoutDashboard> = {
  Overview: LayoutDashboard,
  Procesos: Cpu,
  Proyectos: FolderGit2,
  Tareas: ListChecks,
  "Atención": Bell,
};

export function Sidebar({
  active, onSelect, summary, connected,
}: { active: NavItem; onSelect: (i: NavItem) => void; summary: Summary; connected: boolean }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark size={30} />
        <span style={{ fontFamily: "var(--font-display)", fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-.02em" }}>Surtec</span>
      </div>

      <div className="nav-label">Control Plane</div>
      <nav className="nav">
        {NAV_ITEMS.map((i) => {
          const Icon = NAV_ICON[i];
          return (
            <button key={i} type="button" className={`nav-item${i === active ? " active" : ""}`} onClick={() => onSelect(i)}>
              <Icon /> {i}
            </button>
          );
        })}
      </nav>

      <div className="side-foot">
        <div className="resumen">
          <span className="b-label">Resumen</span>
          <div className="resumen-row"><span>Proyectos</span><b>{summary.total}</b></div>
          <div className="resumen-row"><span>Configurados</span><b className="ok">{summary.configured}</b></div>
          <div className="resumen-row"><span>Sin configurar</span><b className="warn">{summary.unconfigured}</b></div>
          <div className="resumen-row"><span>Necesitan atención</span><b className="warn">{summary.attention}</b></div>
          <div className="sync-note"><span className="dot" />{connected ? "En vivo · sincronizado" : "Sin conexión"}</div>
        </div>
      </div>
    </aside>
  );
}
```

Note: the mockup nav uses `<a>` with `.nav a` selectors. We keep `<button>` for behaviour/testability; in dashboard.css Task 2, the nav selectors are `.nav a` — **add `.nav-item` to those selector lists** (e.g. `.nav a, .nav-item { ... }`, `.nav a:hover, .nav-item:hover { ... }`, `.nav a.active, .nav-item.active { ... }`, `.nav a svg, .nav-item svg { ... }`) and give `.nav-item` `background: none; border: none; width: 100%; text-align: left; cursor: pointer;`. Do this adaptation now as part of Step 3.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/Sidebar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/Sidebar.tsx dashboard/src/ui/components/Sidebar.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): Sidebar with icon nav, derived Resumen, button selectors"
```

---

## Task 6: NewTaskForm — task-panel + integrated bulk sync

**Files:**
- Modify: `dashboard/src/ui/components/BulkSync.tsx`
- Modify: `dashboard/src/ui/components/NewTaskForm.tsx`
- Modify: `dashboard/src/ui/components/BulkSync.test.tsx`
- Modify: `dashboard/src/ui/components/NewTaskForm.test.tsx`

BulkSync becomes a ghost-button group living inside the task-panel head. It keeps its exact sequential fetch/pull logic and per-repo result dots; only the container/markup changes. `NewTaskForm` gains a `bulkProjectIds` prop and renders `<BulkSync>` in its head.

- [ ] **Step 1: Update BulkSync test to the new markup**

Replace the markup-coupled assertions in `BulkSync.test.tsx` so they query by button name and the results dots, not `.es-bulk*` classes. Keep the behavioural tests (sequential calls, failure does not abort). Example heading of the rendered group:

```tsx
// in BulkSync.test.tsx — the buttons are now labelled the same:
expect(screen.getByRole("button", { name: "Fetch all" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Pull all" })).toBeInTheDocument();
```
(Leave the `gitSync` mock + call-sequence assertions intact.)

- [ ] **Step 2: Run to verify failures where markup changed**

Run: `pnpm exec vitest run dashboard/src/ui/components/BulkSync.test.tsx`
Expected: the class-based assertions FAIL (the rest may pass).

- [ ] **Step 3: Implement BulkSync new markup**

```tsx
// dashboard/src/ui/components/BulkSync.tsx
import { useState } from "react";
import { ArrowDownToLine, GitPullRequestArrow } from "lucide-react";
import { gitSync } from "../api";

type RepoStatus = "idle" | "running" | "ok" | "failed";
interface RepoResult { status: RepoStatus; output?: string }

const DOT: Record<RepoStatus, string> = {
  idle: "muted", running: "info", ok: "ok", failed: "danger",
};

export function BulkSync({ projectIds }: { projectIds: string[] }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, RepoResult>>({});

  const run = async (action: "fetch" | "pull") => {
    if (running || projectIds.length === 0) return;
    setRunning(true);
    setResults(Object.fromEntries(projectIds.map((id) => [id, { status: "idle" as RepoStatus }])));
    try {
      for (const id of projectIds) {
        setResults((prev) => ({ ...prev, [id]: { status: "running" } }));
        try {
          const r = await gitSync(id, action);
          setResults((prev) => ({ ...prev, [id]: { status: r.ok ? "ok" : "failed", output: r.output } }));
        } catch (e) {
          setResults((prev) => ({ ...prev, [id]: { status: "failed", output: (e as Error).message } }));
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || projectIds.length === 0;
  const rows = Object.entries(results);
  return (
    <div className="sync-actions">
      <span className="lbl">Sincronizar</span>
      <button type="button" className="ghost-btn" disabled={disabled} onClick={() => run("fetch")}>
        <ArrowDownToLine /> Fetch all
      </button>
      <button type="button" className="ghost-btn" disabled={disabled} onClick={() => run("pull")}>
        <GitPullRequestArrow /> Pull all
      </button>
      {rows.length > 0 && (
        <span className="sync-results">
          {rows.map(([id, r]) => (
            <span key={id} className={`pdot pdot--${DOT[r.status]}`} title={`${id}${r.output ? `: ${r.output}` : ""}`} />
          ))}
        </span>
      )}
    </div>
  );
}
```

Add to `dashboard.css` (small, near `.sync-actions`): `.sync-results { display:inline-flex; gap:4px; margin-left:8px; } .pdot { width:7px; height:7px; border-radius:50%; display:inline-block; } .pdot--muted{background:var(--fg-muted)} .pdot--info{background:var(--glacier-400)} .pdot--ok{background:var(--aurora-500)} .pdot--danger{background:var(--danger)}`.

- [ ] **Step 4: Update NewTaskForm test to the task-panel markup**

In `NewTaskForm.test.tsx`, keep the behavioural tests (dispatch payload, mode mapping, disabled until valid). Update any container/class assertions. Add `bulkProjectIds={[]}` to the render calls. Verify the "Despachar" button and the three `aria-label`ed selects still resolve.

- [ ] **Step 5: Run to verify failures**

Run: `pnpm exec vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: render calls needing the new prop / class assertions FAIL.

- [ ] **Step 6: Implement NewTaskForm task-panel**

```tsx
// dashboard/src/ui/components/NewTaskForm.tsx
import { useEffect, useState } from "react";
import { Zap, Send } from "lucide-react";
import { fetchDispatchOptions, createTask, type DispatchOptions } from "../api";
import { BulkSync } from "./BulkSync";

export function NewTaskForm({ bulkProjectIds }: { bulkProjectIds: string[] }) {
  const [options, setOptions] = useState<DispatchOptions["projects"]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState("read-only");
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchDispatchOptions()
      .then((o) => {
        if (!active) return;
        setOptions(o.projects);
        if (o.projects[0]) {
          setProject(o.projects[0].project);
          setAgent(o.projects[0].agents[0] ?? "");
        }
      })
      .catch((e) => active && setError((e as Error).message));
    return () => { active = false; };
  }, []);

  const agents = options.find((p) => p.project === project)?.agents ?? [];
  const onProjectChange = (value: string) => {
    setProject(value);
    const next = options.find((p) => p.project === value)?.agents ?? [];
    setAgent(next[0] ?? "");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOkMsg(null); setBusy(true);
    try {
      const body = mode === "workspace-write-verify"
        ? { project, agent, instructions, sandbox: "workspace-write", self_verify: true }
        : { project, agent, instructions, sandbox: mode };
      const { id } = await createTask(body);
      setInstructions("");
      setOkMsg(`Despachado: ${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="panel task-panel">
      <div className="task-head">
        <div className="ttl"><Zap /> Nueva tarea</div>
        <BulkSync projectIds={bulkProjectIds} />
      </div>
      {error && <div className="banner banner--danger">{error}</div>}
      {okMsg && <div className="banner banner--ok">{okMsg}</div>}
      <div className="task-row">
        <div className="field">
          <label>Repositorio</label>
          <select aria-label="Proyecto" value={project} onChange={(e) => onProjectChange(e.target.value)}>
            {options.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Agente</label>
          <select aria-label="Agente" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Modo</label>
          <select aria-label="Modo" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="read-only">Analizar (read-only)</option>
            <option value="workspace-write">Implementar (workspace-write)</option>
            <option value="workspace-write-verify">Implementar + auto-fix (verify)</option>
          </select>
        </div>
      </div>
      <div className="task-foot">
        <textarea name="instructions" placeholder="Instrucciones para el agente…" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <button type="submit" className="cta" disabled={busy || !project || !agent || !instructions.trim()}>
          <Send /> {busy ? "Despachando…" : "Despachar"}
        </button>
      </div>
    </form>
  );
}
```

Add `.banner`, `.banner--ok`, `.banner--danger`, `.banner--warn` to dashboard.css (small tinted-glass rules mirroring the old `es-banner*`: ok→aurora tint, danger→danger tint, warn→ember tint; `padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-sm);`).

- [ ] **Step 7: Run both tests to verify pass**

Run: `pnpm exec vitest run dashboard/src/ui/components/BulkSync.test.tsx dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```
git add dashboard/src/ui/components/BulkSync.tsx dashboard/src/ui/components/NewTaskForm.tsx dashboard/src/ui/components/BulkSync.test.tsx dashboard/src/ui/components/NewTaskForm.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): task-panel NewTaskForm with integrated bulk sync"
```

---

## Task 7: ProjectCard — new card structure

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Modify: `dashboard/src/ui/components/ProjectCard.test.tsx`

Keep all sub-components (`GitSyncRow`, `BranchControl`, `GithubCounts`, `DepsStatus`, plus `ProjectNotes`) and their logic. Re-skin: `card-top`, `git-line` (branch is a button opening the branch panel), `commit` clamp, `counts`, `card-divider`, `actions` (Code/Carpeta/GitHub + spacer + Fetch/Pull/Push icon buttons), `card-links` (PRs·Issues / Deps / Notas / Branch toggles).

- [ ] **Step 1: Update ProjectCard test to the new markup**

`ProjectCard.test.tsx` (28 tests) asserts text and some structure. Keep all behavioural/text assertions: project `id`, "configurado"/"sin configurar", branch name, "sin commitear"/"limpio", "VS Code"/"Carpeta"/"GitHub", "Fetch"/"Pull"/"Push", "PRs · Issues", "Deps", "Notas", the running indicator. Update any `.es-*` class queries to the new classes (`.card`, `.git-line`, `.ibtn`, etc.) or, preferably, re-query by accessible role/text. Buttons that were text ("VS Code") may become icon buttons — give them `title`/`aria-label` matching the old text so `getByTitle`/`getByRole(name)` still resolves (the implementation below does this).

- [ ] **Step 2: Run to verify failures**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: class-coupled assertions FAIL.

- [ ] **Step 3: Implement the new ProjectCard**

Full file (sub-components keep their logic; markup re-skinned). The `GitSyncRow` is inlined into the actions row; `BranchControl` opens from the git-line branch button.

```tsx
// dashboard/src/ui/components/ProjectCard.tsx
import { useState } from "react";
import { GitBranch, Code2, Folder, ExternalLink, ArrowDownToLine, GitPullRequestArrow, ArrowUpFromLine } from "lucide-react";
import type { ProjectView, GitStatus } from "../../../../lib/state/types";
import { relativeTime } from "../relative-time";
import { githubWebUrl } from "../../../../lib/github-url";
import { openProject, gitSync, getBranches, branchOp, getGithubCounts, getDeps } from "../api";
import { ProjectNotes } from "./ProjectNotes";

function GitLine({ git, onBranchClick }: { git: GitStatus | null; onBranchClick: () => void }) {
  if (!git) return null;
  if (!git.ok) {
    return <div className="git-line"><span className="dirty">git: no disponible</span></div>;
  }
  return (
    <div className="git-line">
      <button type="button" className="branch" onClick={onBranchClick}><GitBranch />{git.branch ?? "(detached)"}</button>
      <span className="sep">·</span>
      <span className={git.dirty ? "dirty" : "clean"}>{git.dirty ? `${git.uncommitted} sin commitear` : "limpio"}</span>
      <span className="sep">·</span>
      <span className="ab">↑{git.ahead} ↓{git.behind}</span>
    </div>
  );
}

function useGitSync(project: ProjectView) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const run = (action: "fetch" | "pull" | "push") => {
    setBusy(action); setResult(null);
    gitSync(project.id, action)
      .then((r) => setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") }))
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => { setBusy(null); setConfirmPush(false); });
  };
  return { busy, result, confirmPush, setConfirmPush, run };
}

function BranchPanel({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const git = project.git;
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(git?.ok ? git.branch : null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  if (!git?.ok) return null;

  const load = () => {
    if (loading) return;
    setLoading(true);
    getBranches(project.id)
      .then((b) => { setBranches(b.branches); setCurrent(b.current); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setLoading(false));
  };
  // load once on mount
  useState(() => { load(); return undefined; });

  const op = (operation: "switch" | "create", name: string) => {
    setBusy(true); setResult(null);
    branchOp(project.id, operation, name)
      .then((r) => { setResult({ ok: r.ok, text: r.output || (r.ok ? "ok" : "falló") }); if (operation === "create" && r.ok) setNewName(""); load(); })
      .catch((e) => setResult({ ok: false, text: (e as Error).message }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="branches__panel">
      {git.dirty && <div className="branches__note">árbol sucio: commiteá o descartá para cambiar de branch</div>}
      {loading ? <span className="empty-mini">cargando…</span> : (
        <ul className="branches__list">
          {branches.map((b) => (
            <li key={b}>
              {b === current ? <span className="branches__cur">● {b}</span>
                : <button type="button" className="ghost-btn" disabled={busy || git.dirty} onClick={() => op("switch", b)}>{b}</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="branches__create">
        <input className="input" placeholder="nueva-branch" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="ghost-btn" disabled={busy || newName.trim() === ""} onClick={() => op("create", newName.trim())}>Crear</button>
      </div>
      {result && <div className={`banner ${result.ok ? "banner--ok" : "banner--warn"}`}>{result.text}</div>}
      <button type="button" className="ghost-btn" onClick={onClose}>Cerrar</button>
    </div>
  );
}

const CI_DOT: Record<string, string> = { passing: "ok", failing: "danger", running: "info", none: "muted", unknown: "muted" };
const CI_LABEL: Record<string, string> = { passing: "ok", failing: "falló", running: "corriendo", none: "sin runs", unknown: "—" };

function GithubCounts({ project }: { project: ProjectView }) {
  const gh = githubWebUrl(project.repo);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ ok: boolean; prs: number; issues: number; ci: "passing" | "failing" | "running" | "none" | "unknown"; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!gh) return null;
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next && !data && !loading) { setLoading(true); setErr(null); getGithubCounts(project.id).then(setData).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false)); }
  };
  return (
    <span className="link-pop">
      <button type="button" className="card-link-btn" onClick={toggle}>PRs · Issues</button>
      {open && (
        <span className="link-pop__val" title={data?.error ?? err ?? undefined}>
          {loading ? "cargando…" : data ? (data.ok ? `PRs: ${data.prs} · Issues: ${data.issues}` : "GitHub: no disponible") : err ? "GitHub: no disponible" : null}
          {data && <span className="ci"><span className={`pdot pdot--${CI_DOT[data.ci]}`} />CI: {CI_LABEL[data.ci]}</span>}
        </span>
      )}
    </span>
  );
}

function DepsStatus({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ ok: boolean; outdated: number; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!project.git?.ok) return null;
  const toggle = () => {
    const next = !open; setOpen(next);
    if (next && !data && !loading) { setLoading(true); setErr(null); getDeps(project.id).then(setData).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false)); }
  };
  const dot = !data?.ok ? "muted" : data.outdated > 0 ? "warn" : "ok";
  const text = loading ? "cargando…" : data ? (data.ok ? (data.outdated > 0 ? `${data.outdated} desactualizada${data.outdated === 1 ? "" : "s"}` : "al día") : (data.error ?? "Deps: no disponible")) : err ? "Deps: no disponible" : null;
  return (
    <span className="link-pop">
      <button type="button" className="card-link-btn" onClick={toggle}>Deps</button>
      {open && <span className="link-pop__val" title={data?.error ?? err ?? undefined}><span className={`pdot pdot--${dot}`} />{text}</span>}
    </span>
  );
}

export function ProjectCard({ p, running = [] }: { p: ProjectView; running?: string[] }) {
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const gs = useGitSync(p);
  const open = (target: "vscode" | "folder") => { setOpenErr(null); openProject(p.id, target).catch((e) => setOpenErr((e as Error).message)); };
  const gh = githubWebUrl(p.repo);
  const git = p.git;
  const ahead = git?.ok ? (git.ahead ?? 0) : 0;
  const canSync = !!git?.ok;

  return (
    <article className={`card${p.configured ? "" : " discovered"}`}>
      <div className="card-top">
        <h3 className="card-name">{p.id}</h3>
        <span className={`pill ${p.configured ? "ok" : "todo"}`}><span className="dot" />{p.configured ? "configurado" : "sin configurar"}</span>
      </div>

      <GitLine git={git} onBranchClick={() => setBranchOpen((v) => !v)} />
      {git?.ok && git.last_commit && (
        <p className="commit" title={git.last_commit.at}>{git.last_commit.subject} <span className="when">· {relativeTime(git.last_commit.at)}</span></p>
      )}

      <div className="counts">
        <span><b>{p.task_counts.inProgress}</b> en curso</span>
        <span><b>{p.task_counts.finished}</b> hechas</span>
        {running.map((label) => <span key={label} className="run-ind">{`● ${label}`}</span>)}
      </div>

      <div className="card-divider" />

      <div className="actions">
        <button type="button" className="ibtn primary" title="Abrir en VS Code" aria-label="VS Code" onClick={() => open("vscode")}><Code2 /> Code</button>
        <button type="button" className="ibtn icon-only" title="Carpeta" aria-label="Carpeta" onClick={() => open("folder")}><Folder /></button>
        {gh && <a className="ibtn icon-only" title="GitHub" aria-label="GitHub" href={gh} target="_blank" rel="noreferrer"><ExternalLink /></a>}
        <span className="spacer" />
        {canSync && !gs.confirmPush && (
          <>
            <button type="button" className="ibtn" title="Fetch" aria-label="Fetch" disabled={gs.busy !== null} onClick={() => gs.run("fetch")}><ArrowDownToLine /></button>
            <button type="button" className="ibtn" title="Pull" aria-label="Pull" disabled={gs.busy !== null} onClick={() => gs.run("pull")}><GitPullRequestArrow /></button>
            <button type="button" className="ibtn" title="Push" aria-label="Push" disabled={gs.busy !== null || ahead === 0} onClick={() => gs.setConfirmPush(true)}><ArrowUpFromLine /></button>
          </>
        )}
        {canSync && gs.confirmPush && (
          <span className="push-confirm">
            <span>Publicar {ahead} commit{ahead === 1 ? "" : "s"} a origin/{git!.branch}?</span>
            <button type="button" className="ibtn primary" disabled={gs.busy !== null} onClick={() => gs.run("push")}>Confirmar</button>
            <button type="button" className="ibtn" onClick={() => gs.setConfirmPush(false)}>Cancelar</button>
          </span>
        )}
      </div>
      {gs.result && <div className={`banner ${gs.result.ok ? "banner--ok" : "banner--warn"}`}>{gs.result.text}</div>}

      <div className="card-links">
        <GithubCounts project={p} />
        <DepsStatus project={p} />
        <button type="button" className="card-link-btn" onClick={() => setNotesOpen((v) => !v)}>Notas</button>
      </div>

      {branchOpen && <BranchPanel project={p} onClose={() => setBranchOpen(false)} />}
      {notesOpen && <ProjectNotes projectId={p.id} />}
      {openErr && <div className="banner banner--danger">{openErr}</div>}
    </article>
  );
}
```

Notes for the implementer:
- `ProjectNotes` is unchanged internally; it now mounts only when `notesOpen` (its own "Notas (N)" badge button becomes redundant — if `ProjectNotes` renders its own toggle, render it always-open by leaving it as-is; if its tests expect the badge, keep `ProjectNotes` as-is and instead of a separate "Notas" button, render `<ProjectNotes projectId={p.id} />` directly in `.card-links` and drop the local `notesOpen`). **Check `ProjectNotes.tsx` + its test first** and pick whichever keeps `ProjectNotes.test.tsx` green with the least change. Prefer: keep `ProjectNotes` exactly as-is, render it directly (remove the extra Notas button + `notesOpen`).
- Add the small CSS for `.link-pop`, `.link-pop__val`, `.card-link-btn` (text-link styling like `.card-links a`), `.push-confirm`, `.run-ind`, `.branches__panel/__list/__cur/__create/__note`, `.empty-mini` — mirror the old `es-*` equivalents using the new tokens. Reuse `.pdot` from Task 6.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/components/ProjectNotes.test.tsx`
Expected: PASS (adjust assertions until green; do not weaken behavioural coverage).

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): redesigned ProjectCard (card-top/git-line/ibtn actions/card-links)"
```

---

## Task 8: AttentionPanel — tags by kind + mini-ctas

**Files:**
- Modify: `dashboard/src/ui/components/AttentionPanel.tsx`
- Modify: `dashboard/src/ui/components/AttentionPanel.test.tsx`

Keep the `decide()` confirm + approve/reject logic exactly. Re-skin to `.attn-item` rows with a `.tag` coloured by `kind`.

- [ ] **Step 1: Update the test markup**

Keep behavioural assertions (Aprobar/Rechazar present for approvable items; clicking triggers the confirm/decide path with the mocked api). Update class-coupled queries to `.attn-item`/`.tag`/`.mini-cta` or query by role/text.

- [ ] **Step 2: Run to verify failures**

Run: `pnpm exec vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: class-coupled assertions FAIL.

- [ ] **Step 3: Implement**

Read the current `AttentionPanel.tsx` to preserve its exact state/handlers (`decide`, the kind→label map, the verification badge). Then render:

```tsx
// tag class + label by kind:
const TAG: Record<string, { cls: string; label: string }> = {
  "awaiting-approval": { cls: "approve", label: "Aprobar" },
  "needs-review": { cls: "approve", label: "Revisar" },
  risk: { cls: "risk", label: "Riesgo" },
  blocker: { cls: "block", label: "Bloqueo" },
};
```
- Wrap rows in `<div className="panel"><div className="attn-list">…`.
- Each row: `<div className="attn-item">` with `<span className={`tag ${TAG[a.kind].cls}`}>{TAG[a.kind].label}</span>`, `<span className="attn-id">{a.task_id}</span>`, `<span className="attn-text">{a.title}</span>`, optional `<span className="badge-mini">{verification text}</span>`, and `<div className="attn-actions">` with the existing Aprobar (`mini-cta solid`) / Rechazar (`mini-cta outline`) buttons calling the same `decide(...)`. For non-approvable kinds keep a single contextual button as today (or none) — match current behaviour.
- Preserve the empty state ("Nada por ahora." or current copy).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/AttentionPanel.tsx dashboard/src/ui/components/AttentionPanel.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): AttentionPanel with kind tags + mini-ctas"
```

---

## Task 9: InProgressColumn — en-curso empty state + Historial

**Files:**
- Create: `dashboard/src/ui/components/InProgressColumn.tsx`
- Create: `dashboard/src/ui/components/InProgressColumn.test.tsx`

Replaces the two `TaskList` usages on the Overview (en-curso + Historial). `TaskList.tsx` is removed in Task 10 once no longer imported.

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/src/ui/components/InProgressColumn.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InProgressColumn } from "./InProgressColumn";
import type { TaskView } from "../../../../lib/state/types";

const task = (id: string, outcome: TaskView["outcome"]): TaskView => ({
  id, project: "p", agent: "backend-engineer", title: `title ${id}`, lifecycle: "finished", outcome, updated_at: "", finished_at: null, requires_human_approval: false,
});

describe("InProgressColumn", () => {
  it("shows the empty state when nothing is running", () => {
    render(<InProgressColumn inProgress={[]} history={[]} />);
    expect(screen.getByText("Nada por ahora")).toBeInTheDocument();
  });
  it("lists running tasks and recent history with outcome badges", () => {
    render(<InProgressColumn inProgress={[task("T9", null)]} history={[task("T1", "completed"), task("T2", "failed")]} />);
    expect(screen.getByText("title T9")).toBeInTheDocument();
    expect(screen.getByText("Historial reciente")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/InProgressColumn.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
// dashboard/src/ui/components/InProgressColumn.tsx
import { Wind } from "lucide-react";
import type { TaskView } from "../../../../lib/state/types";

const ST: Record<string, string> = { completed: "completed", failed: "failed" };

export function InProgressColumn({ inProgress, history }: { inProgress: TaskView[]; history: TaskView[] }) {
  return (
    <div>
      <div className="section-head"><h2>En curso</h2><span className="meta">{inProgress.length} activas</span></div>
      {inProgress.length === 0 ? (
        <div className="empty">
          <Wind />
          <p>Nada por ahora</p>
          <span className="hint">Las tareas despachadas aparecerán aquí en vivo.</span>
        </div>
      ) : (
        <div className="panel" style={{ padding: "6px 18px" }}>
          {inProgress.map((t) => (
            <div key={t.id} className="hist-row">
              <span className="hid">{t.id}</span><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span><span className="st">{t.outcome ?? t.lifecycle}</span>
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="hist">
          <span className="b-label">Historial reciente</span>
          {history.map((t) => (
            <div key={t.id} className="hist-row">
              <span className="hid">{t.id}</span><span className="agent">{t.agent}</span>
              <span className="htext">{t.title}</span>
              <span className={`st ${ST[t.outcome ?? ""] ?? ""}`}>{t.outcome ?? t.lifecycle}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/InProgressColumn.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/components/InProgressColumn.tsx dashboard/src/ui/components/InProgressColumn.test.tsx
git commit -m "feat(ui): InProgressColumn (en curso empty + Historial reciente)"
```

---

## Task 10: App — shell, topbar live pill, KPIs, two-col, scroll anchors

**Files:**
- Modify: `dashboard/src/ui/App.tsx`
- Modify: `dashboard/src/ui/App.test.tsx`
- Delete: `dashboard/src/ui/components/TaskList.tsx`

- [ ] **Step 1: Confirm TaskList has no other importers**

Run: `grep -rn "TaskList" dashboard/src`
Expected: only `App.tsx` (being changed) and `TaskList.tsx` itself. If anything else imports it, stop and reconcile.

- [ ] **Step 2: Update App test to the new shell**

`App.test.tsx` currently asserts the view switch + presence of sections. Keep those behavioural assertions (renders "Estado vivo"/Overview content; switching nav to "Procesos" shows the Procesos view; the live/error state). Update structure/class queries to the new shell (`.app`, `.topbar`, `.kpis`, `.two-col`). Ensure the mocked `useOverview`/`useRuns` still drive it.

- [ ] **Step 3: Run to verify failures**

Run: `pnpm exec vitest run dashboard/src/ui/App.test.tsx`
Expected: class/structure assertions FAIL.

- [ ] **Step 4: Implement the new App**

```tsx
// dashboard/src/ui/App.tsx
import { useRef, useState } from "react";
import { useOverview } from "./api";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { KpiStrip } from "./components/KpiStrip";
import { InProgressColumn } from "./components/InProgressColumn";
import { ProcesosView } from "./views/ProcesosView";
import { useRuns } from "./useRuns";
import { deriveKpis, deriveSummary } from "./derive-kpis";

const ANCHOR: Partial<Record<NavItem, string>> = { Proyectos: "sec-proyectos", Tareas: "sec-tareas", "Atención": "sec-atencion" };

export function App() {
  const { data, error } = useOverview();
  const { runs } = useRuns();
  const [nav, setNav] = useState<NavItem>("Overview");
  const mainRef = useRef<HTMLDivElement>(null);

  const runningByProject = new Map<string, string[]>();
  for (const r of runs) {
    if (r.status !== "running") continue;
    const label = r.kind === "dev" ? "dev" : "en curso";
    runningByProject.set(r.projectId, [...(runningByProject.get(r.projectId) ?? []), label]);
  }

  const summary = data ? deriveSummary(data) : { total: 0, configured: 0, unconfigured: 0, attention: 0 };
  const kpis = data ? deriveKpis(data, runs) : null;
  const view: "Overview" | "Procesos" = nav === "Procesos" ? "Procesos" : "Overview";

  const onSelect = (item: NavItem) => {
    if (item === "Overview" || item === "Procesos") { setNav(item); return; }
    // scroll anchor — switch to Overview first if needed
    setNav("Overview");
    const id = ANCHOR[item];
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const activeProjectIds = data ? data.projects.filter((p) => p.configured).map((p) => p.id) : [];
  const gitProjectIds = data ? data.projects.filter((p) => p.git?.ok).map((p) => p.id) : [];

  return (
    <div className="app">
      <Sidebar active={nav} onSelect={onSelect} summary={summary} connected={!error} />
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <h1>{view === "Procesos" ? "Procesos" : "Estado vivo"}</h1>
            <span className="sub">{summary.total} repos · {data?.inProgress.length ?? 0} tareas activas</span>
          </div>
          <span className={`live${error ? " live--down" : ""}`}>
            <span className="dot" />{error ? "Sin conexión" : "En vivo"}
          </span>
        </header>

        <div className="wrap" ref={mainRef}>
          {view === "Procesos" ? (
            <ProcesosView projectIds={activeProjectIds} />
          ) : (
            <>
              {kpis && <KpiStrip kpis={kpis} />}
              <NewTaskForm bulkProjectIds={gitProjectIds} />
              {error && <div className="banner banner--warn">No pude refrescar ({error}); mostrando el último estado conocido.</div>}
              {!data ? <p className="empty-mini">Cargando…</p> : (
                <>
                  <div className="section-head" id="sec-proyectos"><h2>Proyectos</h2><span className="meta">{data.projects.length} repos</span></div>
                  <section className="proj-grid">
                    {data.projects.map((p) => <ProjectCard key={p.id} p={p} running={runningByProject.get(p.id) ?? []} />)}
                  </section>
                  <div className="two-col">
                    <div id="sec-atencion">
                      <div className="section-head"><h2>Necesita tu atención</h2><span className="meta">{data.attention.length} ítems</span></div>
                      <AttentionPanel items={data.attention} />
                    </div>
                    <div id="sec-tareas">
                      <InProgressColumn inProgress={data.inProgress} history={data.history} />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Delete TaskList**

```
git rm dashboard/src/ui/components/TaskList.tsx
```

- [ ] **Step 6: Run App + full suite**

Run: `pnpm exec vitest run dashboard/src/ui/App.test.tsx`
Expected: PASS.
Run: `pnpm test`
Expected: all green (319 − removed TaskList-coupled, + new tests).

- [ ] **Step 7: Commit**

```
git add dashboard/src/ui/App.tsx dashboard/src/ui/App.test.tsx
git commit -m "feat(ui): App grid shell, topbar live pill, KPIs, two-col, scroll anchors"
```

---

## Task 11: ProcesosView — re-skin

**Files:**
- Modify: `dashboard/src/ui/views/ProcesosView.tsx`
- Modify: `dashboard/src/ui/views/ProcesosView.test.tsx`

- [ ] **Step 1: Read ProcesosView + its test**

Read `dashboard/src/ui/views/ProcesosView.tsx` and `ProcesosView.test.tsx` to preserve exact behaviour (per-project command rows, run/Detener, the `RunConsole` SSE wiring).

- [ ] **Step 2: Update the test markup if class-coupled**

Keep behavioural assertions; swap any `.es-*` queries to the new `.panel`/`.section-head`/`.ibtn` classes or role/text queries.

- [ ] **Step 3: Re-skin the markup**

Wrap the view in a `.section-head` ("Procesos") + `.panel`s; render each project's command row with `.ibtn` buttons (run) and the existing Detener; keep `RunConsole` as-is (it already styles its own log; only update its container classes if needed to `.panel`). Do not change run/stop/SSE logic.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run dashboard/src/ui/views/ProcesosView.test.tsx dashboard/src/ui/components/RunConsole.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add dashboard/src/ui/views/ProcesosView.tsx dashboard/src/ui/views/ProcesosView.test.tsx dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): re-skin ProcesosView to the redesign vocabulary"
```

---

## Task 12: Verify + visual smoke + finish

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all tests green.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: `✓ built`, one CSS + one JS asset.

- [ ] **Step 4: Live visual smoke**

If the user's dev server is up on :5173, screenshot it; otherwise spin an ephemeral dev server on a free port, screenshot, then kill it (do NOT leave a background dev server running — the user's dev server is theirs).

Run: `node scripts/shot.mjs http://localhost:5173`
Expected: `cardCount` matches the project count; read `.shots/full.png` and confirm the new layout renders (sidebar + KPIs + redesigned cards + two-column bottom) with real data and no obvious breakage.

- [ ] **Step 5: Finish the branch**

Use **superpowers:finishing-a-development-branch**: verify tests pass, then merge `--no-ff` to master + push to origin (the established project flow), delete the branch. Update memory: mark the control-plane redesign DONE in `live-status-dashboard-slice.md` (supersedes the Boreal restyle layout note — Boreal *tokens* still in use), and refresh `MEMORY.md`.

---

## Self-Review

**1. Spec coverage:**
- Tokens unchanged → Task 2 keeps `boreal-tokens.css` untouched. ✓
- Behaviour preserved → Tasks 6–11 keep each component's hooks/handlers; only markup changes. ✓
- Real derived data (KPIs/Resumen/Historial) → Tasks 3 (deriveKpis/deriveSummary), 4 (KpiStrip), 5 (Sidebar Resumen), 9 (InProgressColumn). ✓
- lucide-react + BrandMark → Task 1. ✓
- Sidebar nav: Overview/Procesos switch, others scroll → Task 10 `onSelect` + anchors. ✓
- ProjectCard: card-top/git-line/ibtn actions/card-links + branch-from-gitline → Task 7. ✓
- AttentionPanel tags by kind + mini-ctas → Task 8. ✓
- Procesos re-skin → Task 11. ✓
- Reference artifacts gitignored → done pre-plan (spec commit). ✓
- Gate: tests + tsc + build + visual smoke → Task 12. ✓

**2. Placeholder scan:** No "TBD"/"add error handling" placeholders. Task 7/8/11 reference reading the current file to preserve exact handler logic (legitimate — those handlers already exist and must not change); the new markup is fully specified. The CSS block is referenced by exact file+line range (it exists verbatim on disk; re-typing 300 lines would risk transcription drift) plus an explicit adaptation list — actionable, not a placeholder.

**3. Type consistency:** `Summary`/`Kpi`/`Kpis` defined in Task 3 and consumed in Tasks 4/5/10 with matching shapes. `deriveKpis(data, runs)` / `deriveSummary(data)` signatures consistent. `Sidebar` props `{active,onSelect,summary,connected}` defined in Task 5 and supplied in Task 10. `NewTaskForm` `bulkProjectIds` defined in Task 6, supplied in Task 10. `InProgressColumn` `{inProgress,history}` defined in Task 9, supplied in Task 10. ✓
