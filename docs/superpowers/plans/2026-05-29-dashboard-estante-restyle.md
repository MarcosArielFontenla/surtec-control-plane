# Dashboard Estante Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing dashboard UI to adopt the Estante design system (tokens, Geist + JetBrains Mono, sidebar+topbar shell, hairline cards, pill controls, status color-dots instead of ✓/✗ glyphs) with no behavior change.

**Architecture:** Copy Estante's `colors_and_type.css` tokens into the app and author a token-based `dashboard.css`; import both in `main.tsx` only (so jsdom component tests stay unaffected). Rewrite each component's JSX to use Estante classes while preserving every queried text/label/role. Add a cosmetic `relativeTime` helper. Light mode only.

**Tech Stack:** React, Vite, CSS custom properties, Vitest + Testing Library/jsdom.

**Spec:** `docs/superpowers/specs/2026-05-29-dashboard-estante-restyle-design.md`

---

## File Structure

- `dashboard/src/ui/styles/estante-tokens.css` (create) — copy of Estante `colors_and_type.css`.
- `dashboard/src/ui/styles/dashboard.css` (create) — token-based component classes.
- `dashboard/src/main.tsx` (modify) — import the two CSS files.
- `dashboard/src/ui/relative-time.ts` (create) + test.
- `dashboard/src/ui/App.tsx` (modify) — shell.
- `dashboard/src/ui/components/Sidebar.tsx` (modify).
- `dashboard/src/ui/components/ProjectCard.tsx` (modify).
- `dashboard/src/ui/components/AttentionPanel.tsx` (modify) + test edit.
- `dashboard/src/ui/components/TaskList.tsx` (modify).
- `dashboard/src/ui/components/NewTaskForm.tsx` (modify).

**Test-safety rule (applies to every component task):** Status uses a dot as a SEPARATE sibling element and the label text in its OWN element, e.g. `<span className="es-dot es-dot--ok" /><span>limpio</span>` — never `dot + text` in one node — so Testing Library `getByText` keeps matching. Preserve all existing words (`limpio`, `sin commitear`, `no disponible`, `configurado`, `sin configurar`, `Aprobar`, `Rechazar`, `Despachar`, `Modo`, `Instrucciones…`).

---

## Task 1: Tokens + dashboard.css + imports

**Files:**
- Create: `dashboard/src/ui/styles/estante-tokens.css`
- Create: `dashboard/src/ui/styles/dashboard.css`
- Modify: `dashboard/src/main.tsx`

- [ ] **Step 1: Copy the Estante tokens**

Copy the ENTIRE contents of `Estante Design System/colors_and_type.css` verbatim into
`dashboard/src/ui/styles/estante-tokens.css` (it carries the `@import` for Geist + JetBrains Mono, the
`:root` tokens, the `[data-theme="dark"]` swap, the `.t-*` type classes, and the base reset). Do not edit it.

- [ ] **Step 2: Author `dashboard/src/ui/styles/dashboard.css`**

```css
/* dashboard.css — Surtec control plane, Estante-based component styles.
   Built only on estante-tokens.css custom properties. Light mode (tokens are dark-ready). */

/* shell */
.app-shell { display: flex; min-height: 100vh; background: var(--paper-sunk); color: var(--ink); font-family: var(--font-sans); }
.app-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.app-content { width: 100%; max-width: var(--container-max); margin: 0 auto; padding: var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-6); }

/* sidebar */
.es-side { width: var(--sidebar-w); flex-shrink: 0; background: var(--paper); border-right: 1px solid var(--hairline); display: flex; flex-direction: column; padding: var(--sp-4); gap: var(--sp-2); }
.es-side__brand { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-h2); letter-spacing: var(--tr-heading); padding: var(--sp-2) var(--sp-3); }
.es-side__group { font-size: var(--fs-micro); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tr-caps); color: var(--ink-4); padding: var(--sp-3) var(--sp-3) var(--sp-1); }
.es-side__nav { display: flex; flex-direction: column; gap: 2px; }
.es-nav-item { display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left; border: 0; background: transparent; color: var(--ink-2); font: inherit; font-weight: 500; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-pill); cursor: pointer; transition: background var(--dur-quick) var(--ease-out); }
.es-nav-item:hover { background: var(--paper-sunk); }
.es-nav-item--on { background: var(--ink); color: var(--paper); }
.es-side__foot { margin-top: auto; display: flex; flex-direction: column; padding: var(--sp-3); border-top: 1px solid var(--hairline); }
.es-side__foot-name { font-weight: 600; font-size: var(--fs-body-sm); }
.es-side__foot-role { font-size: var(--fs-caption); color: var(--ink-3); }

/* topbar */
.es-top { height: var(--topbar-h); flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: 0 var(--sp-6); background: var(--paper); border-bottom: 1px solid var(--hairline); }
.es-top__title { font-family: var(--font-sans); font-weight: 700; font-size: var(--fs-h2); letter-spacing: var(--tr-heading); }
.es-live { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-caption); color: var(--ink-3); }

/* card */
.es-card { background: var(--surface); border-radius: var(--r-lg); box-shadow: var(--shadow-sm); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-2); }
.es-card__head { display: flex; align-items: center; gap: var(--sp-2); justify-content: space-between; }
.es-card__title { font-weight: 600; font-size: var(--fs-h3); }

/* chip + dot */
.es-chip { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); font-weight: 500; color: var(--ink-2); background: var(--surface-2); border-radius: var(--r-pill); padding: 2px 10px; }
.es-dot { width: 6px; height: 6px; border-radius: var(--r-pill); background: var(--ink-4); flex-shrink: 0; display: inline-block; }
.es-dot--ok { background: var(--ok); }
.es-dot--warn { background: var(--warn); }
.es-dot--danger { background: var(--danger); }
.es-dot--muted { background: var(--ink-4); }
.es-dot--info { background: var(--info); }

/* git line */
.es-gitline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); font-size: var(--fs-caption); color: var(--ink-3); }
.es-num { font-family: var(--font-numeric); font-variant-numeric: tabular-nums; }

/* buttons */
.es-btn { font: inherit; font-weight: 600; font-size: var(--fs-body-sm); border: 0; border-radius: var(--r-pill); padding: var(--sp-2) var(--sp-4); cursor: pointer; background: var(--ink); color: var(--paper); transition: background var(--dur-quick) var(--ease-out); }
.es-btn:hover { background: var(--brand-600); }
.es-btn:active { background: var(--brand-700); }
.es-btn:disabled { background: var(--ink-disabled); cursor: not-allowed; }
.es-btn--ghost { background: transparent; color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline-2); }
.es-btn--ghost:hover { background: var(--paper-sunk); }
.es-btn--accent { background: var(--accent); color: #fff; }
.es-btn--accent:hover { background: var(--accent-600); }

/* form controls */
.es-input, .es-select, .es-textarea { font: inherit; font-size: var(--fs-body); color: var(--ink); background: var(--surface); border: 1px solid var(--hairline-2); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
.es-input:focus, .es-select:focus, .es-textarea:focus { outline: none; border-color: var(--hairline-3); box-shadow: var(--shadow-focus); }
.es-textarea { width: 100%; box-sizing: border-box; resize: vertical; }
.es-select { border-radius: var(--r-pill); }

/* banners */
.es-banner { border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-body-sm); }
.es-banner--warn { background: var(--warn-50); color: var(--warn-700); }
.es-banner--danger { background: var(--danger-50); color: var(--danger-700); }
.es-banner--ok { background: var(--ok-50); color: var(--ok-700); }

/* lists / layout */
.es-section__title { font-size: var(--fs-h3); font-weight: 600; margin: 0 0 var(--sp-3); }
.es-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.es-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-body-sm); padding: var(--sp-2) 0; border-bottom: 1px solid var(--hairline); }
.es-row__id { font-family: var(--font-numeric); font-weight: 600; }
.es-cards { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
.es-cols { display: flex; gap: var(--sp-6); flex-wrap: wrap; }
.es-cols > * { flex: 1; min-width: 280px; }
.es-empty { color: var(--ink-4); font-size: var(--fs-body-sm); }
.es-form { background: var(--surface); border-radius: var(--r-lg); box-shadow: var(--shadow-sm); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
.es-form__row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
```

- [ ] **Step 3: Import the CSS in `dashboard/src/main.tsx`**

Add at the top (before the React imports is fine; CSS import order doesn't affect React):
```ts
import "./ui/styles/estante-tokens.css";
import "./ui/styles/dashboard.css";
```

- [ ] **Step 4: Verify the build picks up the CSS**

Run: `pnpm build`
Expected: success (Vite bundles the CSS; the Google Fonts `@import` is left as an external import).

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/styles/estante-tokens.css dashboard/src/ui/styles/dashboard.css dashboard/src/main.tsx
git commit -m "feat(dashboard): add Estante tokens + dashboard.css, import in main"
```

---

## Task 2: relativeTime helper (TDD)

**Files:**
- Create: `dashboard/src/ui/relative-time.ts`
- Test: `dashboard/src/ui/relative-time.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/ui/relative-time.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time";

const base = Date.parse("2026-05-29T12:00:00Z");
const ago = (ms: number) => new Date(base - ms).toISOString();

describe("relativeTime", () => {
  it("returns 'recién' under a minute", () => {
    expect(relativeTime(ago(30_000), base)).toBe("recién");
  });
  it("returns minutes", () => {
    expect(relativeTime(ago(5 * 60_000), base)).toBe("Hace 5 min");
  });
  it("returns hours", () => {
    expect(relativeTime(ago(3 * 3_600_000), base)).toBe("Hace 3 h");
  });
  it("returns 'Ayer' between 24 and 48h", () => {
    expect(relativeTime(ago(30 * 3_600_000), base)).toBe("Ayer");
  });
  it("returns days under a week", () => {
    expect(relativeTime(ago(4 * 86_400_000), base)).toBe("Hace 4 días");
  });
  it("returns a short date beyond a week", () => {
    expect(relativeTime(ago(40 * 86_400_000), base)).toMatch(/^\d{1,2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/);
  });
  it("returns '' for an invalid date", () => {
    expect(relativeTime("not-a-date", base)).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run dashboard/src/ui/relative-time.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `dashboard/src/ui/relative-time.ts`**

```ts
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// es-AR relative time for recent activity; short "DD mmm" beyond a week. Pure; `now` injectable.
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.floor((now - t) / 1000);
  if (secs < 60) return "recién";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "Ayer";
  if (days < 7) return `Hace ${days} días`;
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run dashboard/src/ui/relative-time.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/relative-time.ts dashboard/src/ui/relative-time.test.ts
git commit -m "feat(dashboard): es-AR relativeTime helper"
```

---

## Task 3: Shell — Sidebar + App

**Files:**
- Modify: `dashboard/src/ui/components/Sidebar.tsx`
- Modify: `dashboard/src/ui/App.tsx`

- [ ] **Step 1: Rewrite `Sidebar.tsx`**

```tsx
export function Sidebar() {
  const items = ["Overview", "Proyectos", "Tareas", "Atención"];
  return (
    <aside className="es-side">
      <div className="es-side__brand">Surtec</div>
      <div className="es-side__group">Control plane</div>
      <nav className="es-side__nav">
        {items.map((i, idx) => (
          <button key={i} type="button" className={`es-nav-item${idx === 0 ? " es-nav-item--on" : ""}`}>
            {i}
          </button>
        ))}
      </nav>
      <div className="es-side__foot">
        <span className="es-side__foot-name">Marcos</span>
        <span className="es-side__foot-role">Admin</span>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Rewrite `App.tsx`** (keep the exact data flow + texts)

```tsx
import { useOverview } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";

export function App() {
  const { data, error } = useOverview();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <header className="es-top">
          <span className="es-top__title">Estado vivo</span>
          <span className="es-live">
            <span className={`es-dot ${error ? "es-dot--danger" : "es-dot--ok"}`} />
            {error ? "sin conexión" : "en vivo"}
          </span>
        </header>
        <div className="app-content">
          <NewTaskForm />
          {error && (
            <div className="es-banner es-banner--warn">
              No pude refrescar ({error}); mostrando el último estado conocido.
            </div>
          )}
          {!data ? (
            <p className="es-empty">Cargando…</p>
          ) : (
            <>
              <section>
                <h4 className="es-section__title">Proyectos</h4>
                <div className="es-cards">
                  {data.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
                </div>
              </section>
              <div className="es-cols">
                <TaskList title="En curso" tasks={data.inProgress} />
                <AttentionPanel items={data.attention} />
              </div>
              <TaskList title="Historial" tasks={data.history} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run the UI tests**

Run: `pnpm vitest run dashboard/src/ui/App.test.tsx`
Expected: PASS (the shell preserves the data rendering + the "No pude refrescar" text). If App.test queries a specific element the shell moved, adjust the test's query to the same text/role (do NOT change asserted text).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/ui/components/Sidebar.tsx dashboard/src/ui/App.tsx
git commit -m "feat(dashboard): Estante shell (sidebar + topbar + content)"
```

---

## Task 4: ProjectCard

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`

- [ ] **Step 1: Rewrite `ProjectCard.tsx`** (dots as separate siblings; text in own nodes; mono numbers; relativeTime)

```tsx
import type { ProjectView, GitStatus } from "../../../../lib/state/types";
import { relativeTime } from "../relative-time";

function GitLine({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  if (!git.ok) {
    return (
      <div className="es-gitline">
        <span className="es-dot es-dot--danger" />
        <span>git: no disponible</span>
      </div>
    );
  }
  return (
    <div className="es-gitline">
      <span>{git.branch ?? "(detached)"}</span>
      <span className={`es-dot ${git.dirty ? "es-dot--warn" : "es-dot--ok"}`} />
      <span>{git.dirty ? `${git.uncommitted} sin commitear` : "limpio"}</span>
      <span className="es-num">↑{git.ahead} ↓{git.behind}</span>
      {git.last_commit && (
        <span title={git.last_commit.at}>{git.last_commit.subject} · {relativeTime(git.last_commit.at)}</span>
      )}
    </div>
  );
}

export function ProjectCard({ p }: { p: ProjectView }) {
  return (
    <div className="es-card" style={{ minWidth: 220 }}>
      <div className="es-card__head">
        <span className="es-card__title">{p.id}</span>
        <span className="es-chip">
          <span className={`es-dot ${p.configured ? "es-dot--ok" : "es-dot--muted"}`} />
          <span>{p.configured ? "configurado" : "sin configurar"}</span>
        </span>
      </div>
      <div className="t-caption">{p.status}{p.health ? ` · ${p.health}` : ""}</div>
      <GitLine git={p.git} />
      <div className="t-caption">
        <span className="es-num">{p.task_counts.inProgress}</span> en curso · <span className="es-num">{p.task_counts.finished}</span> hechas
      </div>
      <div className="t-micro">{p.last_activity ? `últ. ${p.last_activity}` : "sin actividad"}</div>
    </div>
  );
}
```

- [ ] **Step 2: Run the ProjectCard tests**

Run: `pnpm vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS unchanged — `main`, `2 sin commitear`, `fix bug`, `configurado`, `limpio`, `sin configurar`, `no disponible` are all preserved as queryable text nodes.

> If `getByText(/2 sin commitear/)` fails because the count and text split across nodes, the rewrite above already keeps `${git.uncommitted} sin commitear` as a single text node in its own `<span>` (the dot is a sibling) — verify the dot is NOT inside the same span as the text.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx
git commit -m "feat(dashboard): restyle ProjectCard with Estante card + status dots"
```

---

## Task 5: AttentionPanel (+ test edit)

**Files:**
- Modify: `dashboard/src/ui/components/AttentionPanel.tsx`
- Modify: `dashboard/src/ui/components/AttentionPanel.test.tsx`

- [ ] **Step 1: Update the verification-badge assertions** in `AttentionPanel.test.tsx`

In the test "renders a verification badge per item status", change:
```ts
    expect(screen.getByText(/✓ verificado/)).toBeTruthy();
    expect(screen.getByText(/✗ verificación falló/)).toBeTruthy();
    expect(screen.getByText(/\(sin verificar\)/)).toBeTruthy();
```
to (glyph-free, parenthesis-free):
```ts
    expect(screen.getByText(/verificado/)).toBeTruthy();
    expect(screen.getByText(/verificación falló/)).toBeTruthy();
    expect(screen.getByText(/sin verificar/)).toBeTruthy();
```
Leave the other AttentionPanel tests (Aprobar/Rechazar POST, no-buttons-for-risk) unchanged.

- [ ] **Step 2: Run to verify it fails** (the new text isn't rendered yet — still has glyphs)

Run: `pnpm vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: the badge test FAILS (old component still renders "✓ verificado" — `getByText(/verificado/)` actually still matches the substring, so this test may already pass; the REAL change is the component). Proceed to Step 3 regardless.

- [ ] **Step 3: Rewrite `AttentionPanel.tsx`** (pills + dot badge; drop the ⚠ glyph from the heading)

```tsx
import { useState } from "react";
import type { AttentionItem } from "../../../../lib/state/types";
import { approveTask, rejectTask } from "../api";

const LABEL: Record<AttentionItem["kind"], string> = {
  "needs-review": "Revisar",
  "awaiting-approval": "Aprobar",
  risk: "Riesgo",
  blocker: "Bloqueo",
};
const TASK_KINDS: AttentionItem["kind"][] = ["needs-review", "awaiting-approval"];

function verification(v: AttentionItem["verification"]): { text: string; dot: string } {
  if (v === "passed") return { text: "verificado", dot: "es-dot--ok" };
  if (v === "failed") return { text: "verificación falló", dot: "es-dot--danger" };
  return { text: "sin verificar", dot: "es-dot--muted" };
}

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, action: "approve" | "reject") => {
    const ok = window.confirm(
      action === "approve"
        ? `¿Aprobar ${id}? Si es workspace-write, se pushea su branch a origin y se abre un PR.`
        : `¿Rechazar ${id}? Si es workspace-write, se descartan su worktree y branch.`,
    );
    if (!ok) return;
    setError(null);
    try {
      if (action === "approve") await approveTask(id);
      else await rejectTask(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h4 className="es-section__title">Necesita tu atención</h4>
      {error && <div className="es-banner es-banner--danger">{error}</div>}
      {items.length === 0 ? (
        <p className="es-empty">Todo en orden.</p>
      ) : (
        <ul className="es-list">
          {items.map((a) => {
            const v = verification(a.verification);
            return (
              <li key={`${a.task_id}-${a.kind}-${a.title}`} className="es-row">
                <span className="es-chip">{LABEL[a.kind]}</span>
                <span className="es-row__id">{a.task_id}</span>
                <span>{a.title}</span>
                {TASK_KINDS.includes(a.kind) && (
                  <>
                    <span className="es-chip">
                      <span className={`es-dot ${v.dot}`} />
                      <span>{v.text}</span>
                    </span>
                    <button type="button" className="es-btn" onClick={() => decide(a.task_id, "approve")}>Aprobar</button>
                    <button type="button" className="es-btn es-btn--ghost" onClick={() => decide(a.task_id, "reject")}>Rechazar</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the AttentionPanel tests**

Run: `pnpm vitest run dashboard/src/ui/components/AttentionPanel.test.tsx`
Expected: PASS (3 tests: badge text glyph-free, Aprobar POST, no buttons for risk).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/components/AttentionPanel.tsx dashboard/src/ui/components/AttentionPanel.test.tsx
git commit -m "feat(dashboard): restyle AttentionPanel (pills + dot verification badge)"
```

---

## Task 6: TaskList + NewTaskForm

**Files:**
- Modify: `dashboard/src/ui/components/TaskList.tsx`
- Modify: `dashboard/src/ui/components/NewTaskForm.tsx`

- [ ] **Step 1: Rewrite `TaskList.tsx`**

```tsx
import type { TaskView } from "../../../../lib/state/types";

export function TaskList({ title, tasks }: { title: string; tasks: TaskView[] }) {
  return (
    <section>
      <h4 className="es-section__title">{title}</h4>
      {tasks.length === 0 ? (
        <p className="es-empty">Nada por ahora.</p>
      ) : (
        <ul className="es-list">
          {tasks.map((t) => (
            <li key={t.id} className="es-row">
              <span className="es-row__id">{t.id}</span>
              <span>{t.agent}</span>
              <span>{t.title}</span>
              <span className="es-chip">{t.outcome ?? t.lifecycle}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Rewrite `NewTaskForm.tsx`** (apply Estante classes; keep ALL labels/placeholder/values/logic)

Take the existing `NewTaskForm.tsx` and change ONLY the presentational wrappers/classes:
- root `<form>` → `className="es-form"` (drop the inline border/padding style).
- error banner → `className="es-banner es-banner--danger"`; ok banner → `className="es-banner es-banner--ok"`.
- the heading → `<h4 className="es-section__title" style={{ marginTop: 0 }}>Nueva tarea</h4>`.
- the selects row `<div>` → `className="es-form__row"`.
- each `<select>` → add `className="es-select"` (keep `aria-label="Proyecto"|"Agente"|"Modo"` and all `<option>`s incl. `workspace-write-verify`).
- the `<textarea>` → `className="es-textarea"` (keep `placeholder` and rows).
- the submit `<button>` → `className="es-btn"` (keep `disabled` logic and the `Despachando…`/`Despachar` text).
Do NOT change the `onSubmit` body mapping (`workspace-write-verify` → `{ sandbox: "workspace-write", self_verify: true }`), the state, or the effect.

- [ ] **Step 3: Run the form + list tests**

Run: `pnpm vitest run dashboard/src/ui/components/NewTaskForm.test.tsx`
Expected: PASS (labels `Modo`, placeholder `Instrucciones…`, button `Despachar`, and the `self_verify` body assertions are all preserved).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/ui/components/TaskList.tsx dashboard/src/ui/components/NewTaskForm.tsx
git commit -m "feat(dashboard): restyle TaskList + NewTaskForm with Estante controls"
```

---

## Task 7: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a README note**

```markdown
### Dashboard style

The dashboard adopts the Estante design system (`Estante Design System/` in the repo root): tokens in
`dashboard/src/ui/styles/estante-tokens.css`, component classes in `dashboard.css`, Geist + JetBrains Mono,
a sidebar+topbar shell, hairline cards, pill controls, and status color-dots (no glyphs). Light mode for now
(tokens are dark-ready). Pure restyle — no behavior change.
```

- [ ] **Step 2: Full suite + type-check + build**

Run: `pnpm test`
Expected: all tests pass (prior 150 + the 7 relativeTime tests; AttentionPanel badge assertions updated).

Run: `pnpm exec tsc --noEmit`
Expected: zero errors.

Run: `pnpm build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note the Estante dashboard style"
```

---

## Self-Review (plan vs. spec)

**Spec coverage:**
- §5 estante-tokens.css + dashboard.css + main imports → Task 1. relativeTime → Task 2. App shell +
  Sidebar → Task 3. ProjectCard → Task 4. AttentionPanel + test edit → Task 5. TaskList + NewTaskForm →
  Task 6. README → Task 7. ✅
- §2 CSS-only-in-main (component tests untouched) → Task 1 Step 3. Glyph removal + the only test edit
  (AttentionPanel badge) → Task 5. Behavior frozen → every task preserves labels/handlers. ✅
- §9 testing → relativeTime test (Task 2), AttentionPanel assertion edit (Task 5), all others green
  unchanged (Tasks 3/4/6 verify). ✅

**Type consistency:** `relativeTime(iso, now?)` (Task 2) used in ProjectCard (Task 4). The Estante class
names (`es-card`, `es-chip`, `es-dot--*`, `es-btn`, `es-nav-item--on`, `es-row`, `es-section__title`,
`es-banner--*`, `es-select`, `es-textarea`, `es-form`) defined in dashboard.css (Task 1) are exactly the
ones referenced by the components (Tasks 3–6). The test-safety rule (dot sibling + text own node) is stated
once and applied in Tasks 4/5. ✅

**Placeholder scan:** No TBD/TODO; full code for CSS, helper, and components; Task 6 NewTaskForm gives a
precise class-by-class change list against the known existing file (rather than re-pasting it). ✅
