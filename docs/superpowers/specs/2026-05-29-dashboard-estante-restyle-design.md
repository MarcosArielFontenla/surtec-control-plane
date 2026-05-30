# Surtec Control Plane — Dashboard Restyle with Estante (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Dashboard restyle (adopts the Estante design system; first UI-design slice)
- **Reference:** `Estante Design System/` at the repo root (`colors_and_type.css`, `ui_kits/web/app.css`,
  `README.md`, `Shell.jsx`, `components.jsx`)

## 1. Context & Goal

The dashboard is functional but bare — inline-styled React with no design language. Marcos authored a
complete design system ("Estante": clean, bold, modern-fintech — white paper, near-black ink action, one
terracotta CTA, Geist + JetBrains Mono, pill controls, hairline cards, status as color dots not glyphs).
This slice **restyles the existing dashboard to adopt Estante**. It is a **pure restyle**: same data, same
handlers, same labels/roles — only style and structure change. Light mode only for v1 (the tokens already
support dark; a toggle is deferred).

## 2. Key Decisions

- **CSS-class based, not inline.** Copy Estante's `colors_and_type.css` (tokens + type classes) into the
  dashboard, and author a `dashboard.css` of component classes adapted from Estante's `app.css` `es-*`
  patterns. Components reference classes via `className` strings.
- **CSS is imported ONLY in `main.tsx`** (the app entry), never inside components. This keeps the jsdom
  component tests (which import components, not `main.tsx`) free of any `.css` import, so the test setup is
  unchanged and stays green.
- **Fonts via the Google Fonts `@import`** already at the top of `colors_and_type.css` (Geist + JetBrains
  Mono). No self-hosting in v1.
- **No glyphs.** Replace `✓ / ✗ / ●` in the UI with 6px CSS color dots + text, per Estante's rule. The
  only test assertions that bake in a glyph (the verification badge in `AttentionPanel.test.tsx`) are
  updated to match the new glyph-free text; no behavior test changes.
- **Behavior frozen.** No new endpoints, state, or handlers (except the cosmetic `relativeTime` helper).
  The 150 tests stay green (with the noted assertion edits).
- The `Estante Design System/` folder stays a **reference**; the app owns its copied styles.

## 3. Scope

**In scope (v1):**

- `dashboard/src/ui/styles/estante-tokens.css` — a copy of Estante's `colors_and_type.css` (tokens, type
  classes, dark-mode swap, font `@import`).
- `dashboard/src/ui/styles/dashboard.css` — component classes for the shell + cards + chips + pills +
  status dots + form controls, adapted from Estante's `app.css` `es-*` patterns.
- `dashboard/src/main.tsx` — import both CSS files.
- `dashboard/src/ui/App.tsx` — the Estante shell: sidebar + topbar + content area (max ~1240px, `#FAFAFA`
  page bg).
- `dashboard/src/ui/components/Sidebar.tsx` — Estante sidebar (brand "Surtec", nav with active pill).
- `dashboard/src/ui/components/ProjectCard.tsx` — Estante card; status color-dot chip; git line in mono
  tabular; `configurado`/`sin configurar` chip; relative last-commit time.
- `dashboard/src/ui/components/AttentionPanel.tsx` — chips + pill Aprobar/Rechazar; verification as a
  color-dot chip (not ✓/✗).
- `dashboard/src/ui/components/TaskList.tsx` — Estante table/list styling.
- `dashboard/src/ui/components/NewTaskForm.tsx` — Estante select/textarea/pill button + semantic banners.
- `dashboard/src/ui/relative-time.ts` — `relativeTime(iso, now?)` → es-AR relative string.
- `dashboard/src/ui/relative-time.test.ts` — unit tests (injected `now`).
- `dashboard/src/ui/components/AttentionPanel.test.tsx` — update the 3 verification-badge assertions to
  glyph-free text.

**Out of scope:** dark-mode toggle; Estante screens we don't use (Productos/Movimientos/etc.); Estante
brand mark/logo; topbar search (no search backend); icon library (use simple inline SVG or text labels —
no new dependency); any data/behavior change.

## 4. Architecture

```
main.tsx
  import "./ui/styles/estante-tokens.css"   // tokens + type + fonts (@import)
  import "./ui/styles/dashboard.css"         // component classes (es-* adapted)
  render <App/>

App.tsx  (shell)
  <div class="app-shell">                    // flex row, min-h 100vh, bg paper-sunk
    <Sidebar/>                                // 232px, white, active pill
    <div class="app-main">                    // flex col
      <Topbar title="Estado vivo" live={!error}/>   // 64px; inline in App or a small component
      <div class="app-content">               // max 1240px, padding, gap
        <NewTaskForm/>
        <error banner if error>
        <section> Proyectos: cards grid </section>
        <two-col> En curso | Atención </two-col>
        <Historial/>
      </div>
    </div>
  </div>
```

Classes mirror Estante: `es-side`, `es-nav-item(--on)`, `es-top`, `es-card`, `es-chip`, `es-btn(--pill,
--ghost)`, `es-dot(--ok/--warn/--danger/--muted)`, `.t-numeric` (tabular mono). The exact rules are
adapted from `Estante Design System/ui_kits/web/app.css`.

## 5. Components

### `estante-tokens.css`
A verbatim copy of `Estante Design System/colors_and_type.css` (do not edit — it carries the `:root`
tokens, `[data-theme="dark"]` swap, `.t-*` type classes, base reset, and the Google Fonts `@import`).

### `dashboard.css`
New component classes built ONLY on the tokens (`var(--ink)`, `var(--paper)`, `var(--accent)`,
`var(--ok)`, radii, shadows, spacing). Covers: `.app-shell/.app-main/.app-content`; sidebar (`.es-side`,
`.es-nav-item`, `.es-nav-item--on` = solid ink pill, white text); topbar (`.es-top`); card (`.es-card`
hairline ring + `--shadow-sm`, radius `--r-lg`); chip (`.es-chip` pill, `--surface-2` bg); status dot
(`.es-dot` 6px circle + modifiers using `--ok/--warn/--danger/--ink-4`); buttons (`.es-btn` pill ink,
`.es-btn--ghost` hairline, `.es-btn--accent` terracotta — reserved); form controls (`.es-input`,
`.es-select`, `.es-textarea` — hairline, pill/`--r-md`, focus ring); banners (`.es-banner--warn/--danger`).

### `App.tsx`
Replace the inline-styled flex with the shell structure (§4). Keep the exact data flow (`useOverview`,
the `error` banner, `Cargando…`, the projects grid, the two-column En-curso/Atención, the Historial). Add
a topbar with the title "Estado vivo" and a small "en vivo"/"sin conexión" indicator driven by `error`.

### `Sidebar.tsx`
Estante sidebar: brand "Surtec" at top; nav items (Overview, Proyectos, Tareas, Atención) as
`.es-nav-item` buttons, the first active (`--on`). No routing change (the dashboard is single-page); items
are visual/anchor for now. A small footer ("Marcos · Admin") is optional.

### `ProjectCard.tsx`
`.es-card`. Header: project `id` (`.t-h3`) + a status chip with a color dot. The git line uses
`.t-numeric` (mono tabular): `⎇ branch` (the ⎇ branch glyph is a label, acceptable; or use the text
"rama"), `<N> sin commitear` (dot --warn) or `limpio` (dot --ok), `↑<ahead> ↓<behind>`, and
`relativeTime(last_commit.at)` with the subject. `configurado`/`sin configurar` chip (dot --ok/--muted).
`git.ok===false` → `git: no disponible` (dot --danger). **Keep the text words** `limpio`, `sin commitear`,
`no disponible`, `configurado`, `sin configurar` so the existing ProjectCard tests pass unchanged; only the
`✓/✗/●` prefixes are replaced by dots.

### `AttentionPanel.tsx`
Items as rows with a kind chip; Aprobar = `.es-btn` (ink pill), Rechazar = `.es-btn--ghost`. The
`verificationBadge` returns glyph-free text — `verificado` / `verificación falló` / `sin verificar` — and
renders a leading `.es-dot` (`--ok/--danger/--muted`). The confirm dialog + handlers are unchanged.

### `TaskList.tsx` / `NewTaskForm.tsx`
Estante table/list and form-control classes. Keep all labels/placeholders/roles
(`aria-label="Modo"`, placeholder `Instrucciones…`, button `Despachar`) so those tests pass unchanged.

### `relative-time.ts`
```ts
export function relativeTime(iso: string, now: number = Date.now()): string;
```
es-AR: `< 60s` → "recién"; `< 60m` → "Hace N min"; `< 24h` → "Hace N h"; `< 48h` → "Ayer"; `< 7d` →
"Hace N días"; else a short date "DD mmm" (es-AR month abbrevs). Invalid/empty → "". Pure; `now`
injectable.

## 6. Data Flow & State Transitions

None. The overview poll, dispatch, and review handlers are untouched. Only presentation changes. Light
mode is the default (`:root` tokens); no theme state.

## 7. Safety & Governance

Pure front-end restyle. No server/runner/registry/dispatch changes. No new dependencies (no icon lib —
inline SVG or text). No secrets, no network beyond the existing API poll and the Google Fonts `@import`.

## 8. Error Handling

The existing error banner (overview poll failure → "mostrando el último estado conocido") is restyled as
`.es-banner--warn` but behaves identically. `relativeTime` returns "" on an invalid date rather than
throwing.

## 9. Testing (TDD)

- `dashboard/src/ui/relative-time.test.ts` (new): "recién" / "Hace N min" / "Hace N h" / "Ayer" / "Hace N
  días" / short-date boundaries with an injected `now`; invalid input → "".
- `dashboard/src/ui/components/AttentionPanel.test.tsx` (edit): change the 3 verification-badge assertions
  from `/✓ verificado/`, `/✗ verificación falló/`, `/(sin verificar)/` to `/verificado/`,
  `/verificación falló/`, `/sin verificar/`. The Aprobar/Rechazar + risk-item tests are unchanged.
- All other existing tests (`ProjectCard`, `NewTaskForm`, `App`, `TaskList` if any) must remain GREEN
  unchanged — the restyle preserves their queried text/roles/labels. The implementer verifies the full
  suite after each component.
- No CSS-class assertions (brittle); behavior/text/role assertions only.

## 10. Evolution Path

- Dark-mode toggle (topbar sun/moon, `data-theme` on `<html>`, localStorage) — the tokens already support
  it.
- A real icon set (Lucide) and the Estante brand mark.
- Wire sidebar nav to in-page sections/filters once there are more views (theme B/D).
- es-AR number formatting helper for any future quantitative columns.

## 11. Open Questions

None blocking. Fonts depend on Google Fonts reachability at runtime; if offline, the stack falls back to
the system sans/mono in the token `font-family` lists (already specified in `colors_and_type.css`).
