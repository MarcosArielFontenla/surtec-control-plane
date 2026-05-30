# Boreal Restyle (dark winter theme) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the control plane from Estante (light) to Boreal (dark winter) — pure CSS/token swap, markup and behavior unchanged.

**Architecture:** Replace the `estante-tokens.css` import with a new `boreal-tokens.css` (verbatim Boreal `colors_and_type.css` + the Boreal fonts `@import`), and rewrite `dashboard.css` to consume Boreal tokens with Boreal recipes (dark shell, frosted-glass surfaces, ember accent, glacier focus, aurora/ember/danger dots, Space-Mono data). Every `es-*`/`t-*` selector keeps its name; only rules change, so no `.tsx`/test changes.

**Tech Stack:** CSS custom properties, Vite, Google Fonts (Bricolage Grotesque / Hanken Grotesk / Space Mono). Note: this is a holistic visual restyle — verify by the full suite staying green + a manual visual smoke, not per-step TDD.

**Spec:** `docs/superpowers/specs/2026-05-30-boreal-restyle-design.md`

---

## File Structure

**Create:**
- `dashboard/src/ui/styles/boreal-tokens.css` — Boreal fonts `@import` + verbatim copy of `Boreal Design System/colors_and_type.css`.

**Modify:**
- `dashboard/src/main.tsx` — import `boreal-tokens.css` instead of `estante-tokens.css`.
- `dashboard/src/ui/styles/dashboard.css` — full rewrite to Boreal (same selectors).

**Delete:**
- `dashboard/src/ui/styles/estante-tokens.css` (replaced).

---

## Task 1: Boreal token layer + import swap

**Files:**
- Create: `dashboard/src/ui/styles/boreal-tokens.css`
- Modify: `dashboard/src/main.tsx`
- Delete: `dashboard/src/ui/styles/estante-tokens.css`

- [ ] **Step 1: Create `boreal-tokens.css`**

Create `dashboard/src/ui/styles/boreal-tokens.css` whose contents are: (a) the Boreal fonts `@import` line, then (b) the ENTIRE contents of `Boreal Design System/colors_and_type.css` copied **verbatim** (the `:root { … }` token block + the `.b-*` helper classes). The first line must be:

```css
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
```

Then paste the full `Boreal Design System/colors_and_type.css` below it. (Read that file and copy it exactly — do not edit token values.)

- [ ] **Step 2: Swap the import in `main.tsx`**

`dashboard/src/main.tsx` currently starts:
```ts
import "./ui/styles/estante-tokens.css";
import "./ui/styles/dashboard.css";
```
Change the first line to:
```ts
import "./ui/styles/boreal-tokens.css";
import "./ui/styles/dashboard.css";
```

- [ ] **Step 3: Delete `estante-tokens.css`**

```bash
git rm dashboard/src/ui/styles/estante-tokens.css
```

- [ ] **Step 4: Verify it builds (dashboard.css still references Estante tokens at this point — that's fine for the build; it's rewritten in Task 2)**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no TS touched).

> Note: after this task the app would render with Boreal tokens defined but `dashboard.css` still referencing Estante token NAMES (which no longer exist → properties fall back to initial values, i.e. an unstyled/broken look). That's expected mid-slice; Task 2 fixes it. Do NOT visually smoke until Task 2 is done. (tsc/build don't care about undefined CSS vars.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/styles/boreal-tokens.css dashboard/src/main.tsx dashboard/src/ui/styles/estante-tokens.css
git commit -m "feat(ui): add boreal-tokens.css (winter dark tokens + fonts), swap import, drop estante-tokens"
```

---

## Task 2: Rewrite `dashboard.css` to Boreal

**Files:**
- Modify (full rewrite): `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Replace the entire file** with the Boreal version below (same selectors, Boreal tokens + recipes):

```css
/* dashboard.css — Surtec control plane, Boreal-based component styles (dark winter theme).
   Built only on boreal-tokens.css custom properties. */

/* base — dark alpine night under everything */
html, body { background: var(--ink-950); }
body { margin: 0; color: var(--fg1); font-family: var(--font-body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--ember-500); color: var(--fg-on-accent); }

/* type helpers used by the markup (kept from Estante's names) */
.t-caption { font-size: var(--text-xs); color: var(--fg3); }
.t-micro { font-size: 11px; color: var(--fg-muted); }

/* shell */
.app-shell { display: flex; min-height: 100vh; background: var(--ink-950); color: var(--fg1); font-family: var(--font-body); }
.app-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.app-content { width: 100%; max-width: 1280px; margin: 0 auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-6); }

/* sidebar — frosted glass */
.es-side { width: 232px; flex-shrink: 0; background: var(--surface-glass); backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass)); border-right: 1px solid var(--border-glass); display: flex; flex-direction: column; padding: var(--space-4); gap: var(--space-2); }
.es-side__brand { font-family: var(--font-display); font-weight: 800; font-size: var(--text-h2); letter-spacing: -0.015em; color: var(--frost-50); padding: var(--space-2) var(--space-3); }
.es-side__group { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 400; text-transform: uppercase; letter-spacing: var(--ls-eyebrow); color: var(--glacier-300); padding: var(--space-3) var(--space-3) var(--space-1); }
.es-side__nav { display: flex; flex-direction: column; gap: 2px; }
.es-nav-item { display: flex; align-items: center; gap: var(--space-2); width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg2); font: inherit; font-weight: 500; padding: var(--space-2) var(--space-3); border-radius: var(--radius-pill); cursor: pointer; transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast); }
.es-nav-item:hover { background: var(--surface-glass-light); color: var(--fg1); }
.es-nav-item--on { background: var(--glacier-500); color: #fff; }
.es-side__foot { margin-top: auto; display: flex; flex-direction: column; padding: var(--space-3); border-top: 1px solid var(--border-soft); }
.es-side__foot-name { font-weight: 600; font-size: var(--text-sm); color: var(--fg1); }
.es-side__foot-role { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg3); }

/* topbar — frosted glass */
.es-top { height: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 0 var(--space-6); background: var(--surface-glass); backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass)); border-bottom: 1px solid var(--border-glass); }
.es-top__title { font-family: var(--font-display); font-weight: 700; font-size: var(--text-h2); letter-spacing: -0.015em; color: var(--fg1); }
.es-live { display: inline-flex; align-items: center; gap: var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs); letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg3); }

/* card — the signature frosted glass */
.es-card { background: var(--surface-glass); backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass)); border: 1px solid var(--border-glass); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg), var(--shadow-inset-hair); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); transition: transform var(--dur-base) var(--ease-out), box-shadow var(--dur-base); }
.es-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-xl), var(--shadow-frost); }
.es-card__head { display: flex; align-items: center; gap: var(--space-2); justify-content: space-between; }
.es-card__title { font-family: var(--font-display); font-weight: 700; font-size: var(--text-h3); letter-spacing: -0.01em; color: var(--fg1); }

/* chip + dot */
.es-chip { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); font-weight: 500; color: var(--fg2); background: var(--surface-glass-light); border: 1px solid var(--border-glass); border-radius: var(--radius-pill); padding: 3px 11px; }
.es-dot { width: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--slate-500); flex-shrink: 0; display: inline-block; }
.es-dot--ok { background: var(--aurora-500); }
.es-dot--warn { background: var(--ember-500); }
.es-dot--danger { background: var(--danger); }
.es-dot--muted { background: var(--slate-500); }
.es-dot--info { background: var(--glacier-400); }

.es-card__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; margin-top: auto; padding-top: var(--space-2); }
.es-link { font-size: var(--text-sm); color: var(--glacier-300); text-decoration: none; }
.es-link:hover { color: var(--ice-200); text-decoration: underline; }

/* git line */
.es-gitline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg3); }
.es-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg2); }

/* buttons */
.es-btn { font-family: var(--font-body); font-weight: 600; font-size: var(--text-sm); border: 1px solid var(--border-glass); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; background: var(--surface-glass-light); color: var(--fg1); transition: transform var(--dur-fast) var(--ease-out), background var(--dur-base), border-color var(--dur-base), box-shadow var(--dur-base); }
.es-btn:hover { border-color: var(--glacier-400); color: #fff; transform: translateY(-1px); }
.es-btn:active { transform: scale(0.98); }
.es-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; border-color: var(--border-soft); color: var(--fg3); }
.es-btn--ghost { background: transparent; color: var(--glacier-300); border-color: transparent; }
.es-btn--ghost:hover { background: var(--surface-glass-light); color: var(--ice-200); border-color: transparent; }
.es-btn--accent { background: var(--ember-500); color: var(--fg-on-accent); border-color: transparent; box-shadow: var(--shadow-ember); }
.es-btn--accent:hover { background: var(--ember-400); color: var(--fg-on-accent); box-shadow: 0 18px 44px -10px var(--ember-glow); }
.es-btn--accent:active { background: var(--ember-600); }

/* form controls */
.es-input, .es-select, .es-textarea { font: inherit; font-size: var(--text-base); color: var(--fg1); background: var(--surface-glass-light); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); }
.es-input::placeholder, .es-textarea::placeholder { color: var(--fg-muted); }
.es-input:focus, .es-select:focus, .es-textarea:focus { outline: none; border-color: var(--glacier-500); box-shadow: 0 0 0 3px rgba(60,130,180,0.25); }
.es-textarea { width: 100%; box-sizing: border-box; resize: vertical; }
.es-select { border-radius: var(--radius-pill); }

/* banners — tinted glass */
.es-banner { border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); font-size: var(--text-sm); border: 1px solid transparent; }
.es-banner--warn { background: rgba(232,136,76,0.12); border-color: rgba(232,136,76,0.30); color: var(--ember-400); }
.es-banner--danger { background: rgba(229,112,95,0.12); border-color: rgba(229,112,95,0.32); color: #F2A79B; }
.es-banner--ok { background: rgba(69,196,158,0.12); border-color: rgba(69,196,158,0.30); color: var(--aurora-400); }

/* lists / layout */
.es-section__title { font-family: var(--font-display); font-size: var(--text-h3); font-weight: 600; color: var(--fg1); margin: 0 0 var(--space-3); }
.es-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.es-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-sm); color: var(--fg2); padding: var(--space-2) 0; border-bottom: 1px solid var(--border-soft); }
.es-row__id { font-family: var(--font-mono); font-weight: 600; color: var(--fg1); }
.es-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: var(--space-4); align-items: stretch; }
.es-cols { display: flex; gap: var(--space-6); flex-wrap: wrap; }
.es-cols > * { flex: 1; min-width: 280px; }
.es-empty { color: var(--fg-muted); font-size: var(--text-sm); }
.es-form { background: var(--surface-glass); backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass)); border: 1px solid var(--border-glass); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg), var(--shadow-inset-hair); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
.es-form__row { display: flex; gap: var(--space-2); flex-wrap: wrap; }

/* git sync row */
.es-gitsync { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; margin-top: var(--space-2); }
.es-gitsync__confirm { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; font-size: var(--text-xs); color: var(--fg2); }

/* branch control */
.es-branches { margin-top: var(--space-2); }
.es-branches__panel { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); padding: var(--space-3); background: var(--surface-glass-light); border: 1px solid var(--border-soft); border-radius: var(--radius-md); }
.es-branches__note { font-size: var(--text-xs); color: var(--ember-400); }
.es-branches__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow: auto; }
.es-branches__cur { font-size: var(--text-sm); font-weight: 600; color: var(--fg1); }
.es-branches__create { display: flex; gap: var(--space-2); }

/* procesos / console */
.es-row--proc { gap: var(--space-3); }
.es-proc-slot { display: inline-flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.es-chip--run { gap: var(--space-2); }
.es-run-ind { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--fg2); }
.es-console { display: flex; flex-direction: column; gap: var(--space-2); }
.es-console__bar { display: flex; align-items: center; gap: var(--space-3); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg3); }
.es-console__cmd { font-family: var(--font-mono); margin-left: auto; color: var(--fg2); }
.es-console__log {
  font-family: var(--font-mono); font-size: var(--text-sm); line-height: 1.5;
  background: var(--ink-950); color: var(--frost-100); border: 1px solid var(--border-soft); border-radius: var(--radius-md);
  padding: var(--space-3); margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}

/* bulk sync */
.es-bulk { display: flex; flex-direction: column; gap: var(--space-2); }
.es-bulk__bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.es-bulk__label { font-size: var(--text-sm); font-weight: 600; color: var(--fg1); }
.es-bulk__results { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0; padding: 0; list-style: none; }
.es-bulk__row { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg2); }

/* github counts */
.es-gh { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.es-gh__counts { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg2); }
.es-gh__ci { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg2); }

/* deps staleness */
.es-deps { display: inline-flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.es-deps__val { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg2); }

/* project notes */
.es-notes { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-2); }
.es-notes__panel { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-1); }
.es-notes__item { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--fg2); }
.es-notes__item--done { color: var(--fg-muted); text-decoration: line-through; }
.es-notes__add { display: flex; gap: var(--space-2); }
.es-notes__del { border: 0; background: transparent; color: var(--fg3); cursor: pointer; font-size: var(--text-base); }
.es-notes__del:hover { color: var(--danger); }
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed (Vite bundles the new CSS).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/styles/dashboard.css
git commit -m "feat(ui): rewrite dashboard.css to the Boreal winter theme (dark + frosted glass + ember)"
```

---

## Task 3: Full verification + visual smoke + finish

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all 319 still green (markup/behavior unchanged; only CSS changed).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual visual smoke (REQUIRED — verification-before-completion)**

Run `pnpm dev` and open the dashboard in the browser. Confirm the winter look across the surfaces and capture
what's observed (Marcos reviews "cómo queda"):
- Dark alpine shell (navy ground), frosted-glass **sidebar / topbar / cards**.
- "Surtec" brand in the display font; nav active item in glacier blue.
- Project cards: glass, ember nowhere by default; status **dots** = aurora (ok) / ember (warn) / danger / glacier (info).
- **Despachar** primary button = ember (pill + glow); ghost buttons glassy; inputs/selects with a glacier focus ring.
- The on-card controls (git sync / branches / bulk / GitHub PRs·Issues·CI / deps / notes) all readable on dark, mono data.
- The **Procesos** console: near-black panel, frost text.
- Fonts loaded (Bricolage headings, Hanken body, Space Mono data).

If something looks off (contrast, a missed token, a too-bright surface), adjust `dashboard.css`/`boreal-tokens.css` and re-smoke — this is the iterate-live step.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch. Update the memory:
`live-status-dashboard-slice.md` (Boreal restyle replaces Estante) and `boreal-design-system-pending.md`
(mark it DONE, no longer pending).

---

## Self-Review (completed during planning)

- **Spec coverage:** boreal-tokens.css (verbatim Boreal tokens + fonts) + import swap + delete estante →
  Task 1; dashboard.css rewrite to Boreal recipes (shell/sidebar/topbar/card/chip/dot/button/input/banner/
  list/console/sub-rows + the t-caption/t-micro helpers the markup uses) → Task 2; full-suite-green + tsc +
  build + visual smoke + finish → Task 3. All spec sections covered. The markup-unchanged guarantee → no
  .tsx/test changes.
- **Placeholder scan:** no TODO/TBD; Task 1's token file is "copy colors_and_type.css verbatim + prepend the
  given @import" (concrete); Task 2 has the complete dashboard.css.
- **Token consistency:** every Boreal token referenced in the rewritten dashboard.css (`--ink-950`,
  `--glacier-*`, `--ember-*`, `--aurora-*`, `--slate-*`, `--frost-*`, `--ice-*`, `--surface-glass*`,
  `--border-glass`, `--border-soft`, `--fg1/2/3`, `--fg-muted`, `--fg-on-accent`, `--space-*`, `--radius-*`,
  `--shadow-lg/xl/frost/ember/inset-hair`, `--ember-glow`, `--blur-glass`, `--font-display/body/mono`,
  `--text-*`, `--ls-eyebrow`, `--dur-fast/base`, `--ease-out`, `--danger`) is defined in Boreal's
  `colors_and_type.css` (copied verbatim into boreal-tokens.css). The `t-caption`/`t-micro` helpers (the only
  non-es markup classes) are redefined in dashboard.css so the markup stays styled.
