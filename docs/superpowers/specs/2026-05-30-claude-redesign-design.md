# Claude Redesign — Control Plane Layout Overhaul (Design Spec)

**Date:** 2026-05-30
**Status:** Approved (design)
**Branch:** `feat/claude-redesign`

## Goal

Apply the "Claude Design" layout redesign — captured by Marcos in a standalone HTML
mockup at the repo root (`Surtec Control Plane (standalone).html`, decoded to
`extracted-design/_template.html`) — to the live control-plane dashboard. It is a
**full layout/structure overhaul** built on the **same Boreal design tokens** we already
ship (`boreal-tokens.css`: ink / glacier / ember / aurora, Bricolage / Hanken / Space Mono).
The palette and type do not change; the layout, component structure, and visual treatment do.

## Constraints

- **Tokens unchanged.** `boreal-tokens.css` stays byte-identical. The redesign consumes the
  existing tokens; it does not introduce a new palette. ("Claude Design" = the new *layout*,
  not a new brand — Surtec branding stays.)
- **Behaviour preserved.** Every existing capability stays wired and functional: live polling
  (`/api/overview`, `/api/runs`), dispatch, git fetch/pull/push, bulk sync, branch ops,
  GitHub PR/issue counts + CI, dep staleness, per-project notes, the Procesos view (SSE runs).
  This is a presentation overhaul, not a behaviour change.
- **Real data only.** New affordances (KPIs, sidebar "Resumen", "Historial reciente") are
  derived from existing API data. No fabricated numbers. Decorative mockup values with no real
  source (e.g. "Sincronizado · hace 45 min") are replaced by real state (live / sin conexión)
  or dropped.
- **New dependency:** `lucide-react` for the icon set the design relies on.
- **Reference artifacts gitignored:** the standalone HTML and `extracted-design/` are
  reference only (gitignored), like `.shots/`.

## Architecture

### CSS
- **`dashboard.css` is rewritten** to the mockup's class vocabulary, taken from the extracted
  `<style>` block: `.app`, `.sidebar` (brand / nav-label / nav / side-foot / resumen), `.main`,
  `.wrap`, `.topbar` (+ `.live` pill), `.kpis` / `.kpi`, `.section-head`, `.panel`, `.task-panel`
  (+ `.task-head` / `.sync-actions` / `.ghost-btn` / `.task-row` / `.field` / `.task-foot` /
  `.cta`), `.proj-grid` / `.card` (+ `.card-top` / `.pill` / `.git-line` / `.commit` / `.counts`
  / `.card-divider` / `.actions` / `.ibtn` / `.card-links`), `.two-col`, `.attn-list` /
  `.attn-item` (+ `.tag` / `.mini-cta`), `.empty`, `.hist` / `.hist-row`. Background is
  `var(--grad-aurora), var(--grad-night)` fixed.
- The current `es-*` class names are **retired** in favour of the mockup's names. Markup changes
  accordingly (see Components). Class names are an implementation detail; tests assert
  text/roles where possible.

### Icons & logo
- `lucide-react` icons used across nav, KPIs, task panel, and card actions
  (layout-dashboard, cpu, folder-git-2, list-checks, bell, zap, arrow-down-to-line,
  git-pull-request-arrow, send, git-branch, code-2, folder, external-link, arrow-up-from-line,
  bell-ring, loader, git-commit-horizontal, wind, etc.).
- The brand mark is the mockup's ember+glacier compass SVG, inlined as a small React component
  (`BrandMark`).

## Components

The data shape is unchanged (`OverviewModel = { projects, inProgress, history, attention }`
from `lib/state/types.ts`, plus `runs` from `useRuns`). Components are re-skinned and
re-structured; their props and behaviour stay.

### `App`
- Renders the `.app` grid shell (`232px 1fr`): `<Sidebar>` + `<main class="main">`.
- Topbar: `<h1>` title ("Estado vivo" / "Procesos"), a `.sub` mono line (e.g. `N repos · M tareas
  activas`), and the `.live` pill — aurora pulsing dot + "En vivo" when connected, danger +
  "sin conexión" on `error` (driven by the existing `error` from `useOverview`).
- Overview body: `<KpiStrip>`, `<NewTaskForm>` (task-panel with integrated bulk sync), the
  Proyectos `section-head` + `<div class="proj-grid">` of `<ProjectCard>`, then the `.two-col`
  bottom: left = `<AttentionPanel>`, right = `<InProgressColumn>` (en curso empty-state +
  Historial reciente).
- Procesos body: `<ProcesosView>` inside the same shell.

### `Sidebar`
- `BrandMark` + "Surtec" wordmark; `nav-label` "Control Plane"; nav buttons with lucide icons.
- Nav items: **Overview** and **Procesos** switch the view (as today). **Proyectos / Tareas /
  Atención** scroll to their section on the Overview (anchor scroll; if the active view is
  Procesos, selecting one switches to Overview first, then scrolls). Active item styled per
  `.nav a.active`.
- Footer **Resumen** panel (derived, real): Proyectos (total), Configurados, Sin configurar,
  Necesitan atención (count). A `sync-note` row shows live/disconnected state (real), not a
  fabricated timestamp.
- Receives the derived summary via props from `App` (or computes from the same `data`); takes
  `active`, `onSelect`, and a `summary` object. Keeps `NavItem` union.

### `KpiStrip` (new)
Four `.kpi` cards, all derived from `data` + `runs`:
- **Proyectos** = `projects.length`; foot = `${configured} activos · ${total-configured} descubiertos`.
- **En curso** = `inProgress.length`; foot = "sin tareas corriendo" or `${n} corriendo`.
- **Atención** = `attention.length` (ember when > 0); foot = breakdown by `kind`
  (aprobar / riesgo / bloqueo / revisar).
- **Sin commitear** = Σ `git.uncommitted` over `git.ok && dirty` projects (aurora); foot =
  `en ${k} repos`.
Pure function `deriveKpis(data, runs)` for testability.

### `NewTaskForm` (task-panel)
- `.panel.task-panel`: `task-head` with `zap` icon + "Nueva tarea" on the left and the
  **Sincronizar** group (Fetch all / Pull all `ghost-btn`s, driven by the existing `BulkSync`
  logic) on the right. The bulk per-repo result dots render compactly below the head when a run
  is active.
- `task-row` of three `.field`s (Repositorio / Agente / Modo) with mono uppercase labels +
  styled `select`s; `task-foot` = textarea (flex) + ember `.cta` "Despachar" with `send` icon.
- Dispatch logic, mode mapping (`workspace-write-verify` → `self_verify`), validation, and the
  `aria-label`ed selects are unchanged.

### `ProjectCard`
- `.card` (dashed `.discovered` variant when `!configured`): `card-top` (name + status `.pill`
  ok/todo), `git-line` (git-branch icon + branch, dirty/clean, `↑a ↓b`), `.commit` (subject +
  `.when`, 2-line clamp), `.counts` (en curso / hechas), `.card-divider`.
- `.actions` row of compact `.ibtn` icon buttons: Code (primary) + Carpeta + GitHub link, a
  `.spacer`, then Fetch / Pull / Push (push disabled when `ahead===0`, two-step confirm
  preserved inline). All from the existing `openProject` / `gitSync` logic.
- `.card-links` row: **PRs · Issues**, **Deps**, **Notas** — each toggles its existing expandable
  panel (`GithubCounts`, `DepsStatus`, `ProjectNotes`). **Branch** control is reachable from the
  git-line branch (button that opens the existing `BranchControl` panel).
- All sub-components (`GitSyncRow`, `BranchControl`, `GithubCounts`, `DepsStatus`,
  `ProjectNotes`) keep their fetch-once/retry/confirm logic; only their trigger + container
  markup is re-skinned.

### `AttentionPanel`
- `.panel` with `.attn-list` of `.attn-item`s. Each: a `.tag` coloured by `kind`
  (awaiting-approval → "Aprobar"/approve, risk → "Riesgo"/risk, blocker → "Bloqueo"/block,
  needs-review → "Revisar"), the `attn-id`, `attn-text` title, an optional verification
  `badge-mini`, and `attn-actions`: Aprobar (`mini-cta.solid`) / Rechazar (`mini-cta.outline`)
  for approvable items, preserving the confirm + `decide()` logic.

### `InProgressColumn` (new, splits today's two `TaskList`s)
- Right column of `.two-col`. When `inProgress` is empty → `.empty` state (wind icon + copy).
  Otherwise a compact running list. Below: `.hist` "Historial reciente" from `history`
  (id / agent / title / `.st` outcome badge: completed → aurora, failed → danger).

### `ProcesosView`
- Re-skinned to the new `.panel` / mono vocabulary inside the same shell; run/stop + SSE console
  behaviour unchanged.

## Data flow

`App` calls `useOverview()` + `useRuns()` (unchanged). It computes `deriveKpis(data, runs)` and
the sidebar `summary` once and passes them down. No new endpoints. The Procesos view keeps its
own `getProjectCommands` / SSE wiring.

## Error handling

- `useOverview` error → topbar `.live` pill shows "sin conexión" (danger dot) and a `.panel`
  warning banner above the grid ("mostrando el último estado conocido"), as today.
- Per-action failures (git sync, branch op, open, dispatch) keep their existing inline banners,
  re-skinned.
- Missing/`!ok` git, non-GitHub repos, etc. degrade exactly as today (the sub-components already
  guard these).

## Testing

- Existing tests assert mostly **text and roles** (button labels "Despachar"/"Aprobar"/
  "Rechazar"/"Fetch"/"Pull"/"Push", project ids, "configurado", aria-labels). These survive the
  re-skin as long as that accessible text/roles are preserved — a primary design constraint.
- Structural/class-based assertions (notably in `ProjectCard.test`, 28 tests) are updated to the
  new markup during TDD.
- New unit tests: `deriveKpis` (pure), the sidebar `Resumen` derivation, `KpiStrip` rendering,
  `InProgressColumn` empty + history states.
- Gate: full suite green (current 319 + new), `tsc --noEmit` clean, `vite build` clean, plus a
  live visual smoke (Playwright `scripts/shot.mjs`) confirming the new layout renders with real
  data and uniform behaviour.

## Slice / delivery

- Branch `feat/claude-redesign`; subagent-driven TDD per the plan; merge `--no-ff` to master +
  push to origin at the end.
- `lucide-react` added to `dashboard` deps.
- Reference artifacts (`Surtec Control Plane (standalone).html`, `extracted-design/`) stay
  gitignored. `scripts/extract-bundle.mjs` (the one-off bundle decoder) is kept as dev tooling.

## Out of scope

- No new backend routes/endpoints. Proyectos / Tareas / Atención nav items are scroll anchors,
  not new views (can become real routes in a later slice if wanted).
- No token/palette changes. No new product capabilities — presentation only.
