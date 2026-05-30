# Surtec Control Plane — Boreal Restyle (dark winter theme) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Visual restyle from the Estante (light) design system to the Boreal (dark, winter) design system
- **Builds on / replaces:** the Estante restyle (`2026-05-30-dashboard-estante-restyle-design.md`)

## 1. Context & Goal

The dashboard currently wears the Estante light design system (paper/ink/terracotta, Geist + JetBrains Mono).
Marcos wants a **winter theme** — he's drawn to the Argentine Sur Patagónico: snow, cold, snowy mountains.
The **Boreal Design System** (a folder he dropped in the repo root) is exactly that: a "moody alpine night" —
deep night-navy grounds, glacier blues, frost whites, a single warm **ember** accent, **aurora** mint for
positive signals, frosted-glass surfaces, and a technical mono "expedition log" data style. This slice
re-skins the control plane in Boreal. It is a **pure visual restyle**: behavior, markup, routes, and tests
are unchanged. It stays **Surtec** — we adopt Boreal's *visual language* (palette, type, surfaces), NOT its
brand identity (no Boreal logo/wordmark, no rename).

## 2. Key Decisions

- **Token-layer swap + dashboard.css rewrite.** `dashboard/src/main.tsx` imports `estante-tokens.css` then
  `dashboard.css`. We replace the first with **`boreal-tokens.css`** (a verbatim copy of Boreal's
  `colors_and_type.css` + the Boreal `fonts.css` `@import`) and **rewrite `dashboard.css`** to consume Boreal
  tokens directly with Boreal's real recipes (frosted glass, ember CTAs, glacier focus). We do NOT use a thin
  alias bridge — that would yield a "dark Estante", not the authentic Boreal look.
- **Markup unchanged → tests unchanged.** Every `es-*` / `t-*` class KEEPS ITS NAME; only its CSS rules
  change. No `.tsx` edits, no component/test changes. The full suite (319 tests) must stay green — they assert
  text/behavior, never computed styles.
- **Full dark, no light toggle.** Boreal is dark-default; the dashboard was "light only". We go full dark
  (alpine night) and drop the light assumption. (A future light "frost" theme is a follow-up if wanted.)
- **Surtec branding stays.** The sidebar brand reads "Surtec"; copy (Spanish, voseo) is unchanged. Boreal's
  logo SVGs and brand name are NOT used.
- **Frosted glass is the signature surface** for the sidebar, topbar, and cards
  (`--surface-glass` + `backdrop-filter: blur(--blur-glass)` + `--border-glass` hairline + inset highlight).

## 3. Scope

**In scope (v1):**

- `dashboard/src/ui/styles/boreal-tokens.css` — NEW: verbatim Boreal `colors_and_type.css` (tokens + `.b-*`
  helpers) prefixed with the Boreal fonts `@import` (Google Fonts: Bricolage Grotesque, Hanken Grotesk, Space
  Mono).
- `dashboard/src/main.tsx` — import `boreal-tokens.css` instead of `estante-tokens.css`.
- `dashboard/src/ui/styles/dashboard.css` — REWRITE every rule to consume Boreal tokens + apply Boreal
  recipes (dark shell, glass surfaces, ember accent, glacier focus, status colors, mono data). Same selectors.
- Delete `dashboard/src/ui/styles/estante-tokens.css` (replaced).

**Out of scope (later):** a light/"frost" theme toggle; full-bleed winter photography / atmosphere gradients
behind the shell; the grain/noise overlay; Lucide line icons (the dashboard uses CSS color-dots, no icons —
keep it); animated reveals/parallax; restyling the agent-task dispatch flow differently from the rest.

## 4. Architecture

```
main.tsx:
  import "./ui/styles/boreal-tokens.css";   // was estante-tokens.css — raw Boreal tokens + fonts @import
  import "./ui/styles/dashboard.css";        // rewritten to Boreal

boreal-tokens.css  = @import(Boreal fonts) + <verbatim colors_and_type.css>
                     → defines --ink-950, --glacier-500, --ember-500, --aurora-500, --surface-glass,
                       --space-*, --radius-*, --shadow-*, --font-display/body/mono, --text-*, etc.

dashboard.css      = the SAME es-*/t-* selectors, re-authored to consume Boreal tokens (dark + glass + ember).
```

No JS/markup change; the cascade does the work. The dark theme applies globally via the shell + token values.

## 5. Components — Estante → Boreal mapping (in the rewritten `dashboard.css`)

Same selectors; new rules. The mapping (token → Boreal):

- **Shell / page** (`.app-shell`, `.app-content`): `background: var(--ink-950)` (deepest night), `color: var(--fg1)`
  (frost white); `font-family: var(--font-body)` (Hanken). `--container-max` kept.
- **Sidebar** (`.es-side*`): frosted glass panel — `background: var(--surface-glass)` +
  `backdrop-filter: blur(var(--blur-glass))` + `border-right: 1px solid var(--border-glass)`. Brand "Surtec"
  in `--font-display` (Bricolage) bold, `--frost-50`. Nav item hover → glass-light bg / `--ice-200` text;
  **active** (`--on`) → `background: var(--glacier-500); color:#fff` (or a glass-active variant).
- **Topbar** (`.es-top*`): frosted glass, `border-bottom: var(--border-glass)`; title in `--font-display`;
  `.es-live` dot uses `--aurora-500` (live) / `--danger` (offline).
- **Card** (`.es-card`): the signature glass — `background: var(--surface-glass)`,
  `backdrop-filter: blur(var(--blur-glass))`, `border: 1px solid var(--border-glass)`,
  `border-radius: var(--radius-lg)`, `box-shadow: var(--shadow-lg), var(--shadow-inset-hair)`; title in
  Bricolage. Hover lift (−2px) + `--shadow-frost` is a nice-to-have.
- **Buttons** (`.es-btn`): pill (`--radius-pill`), Hanken 600. `--es-btn--accent` → **ember**
  (`background: var(--ember-500); color: var(--fg-on-accent); box-shadow: var(--shadow-ember)`), hover
  `--ember-400` + lift. `--ghost` → transparent / `--glacier-300` text, hover `--ice-200`. Base/secondary →
  glass-light + `--border-glass`. `:disabled` → muted, no glow.
- **Chips** (`.es-chip`, `.es-chip--run`): pill, `--surface-glass-light` bg, `--border-glass`, `--fg2` text.
- **Dots** (`.es-dot--*`): `ok → --aurora-500`, `warn → --ember-500`, `danger → --danger (#E5705F)`,
  `info → --glacier-400`, `muted → --slate-500`. (Keeps the no-glyph color-dot status language.)
- **Inputs** (`.es-input/.es-select/.es-textarea`): `--surface-glass-light` bg, `--border-glass`,
  `--radius-md`, `--fg1` text, placeholder `--fg-muted`; **focus** → `border-color: var(--glacier-500)` +
  `box-shadow: 0 0 0 3px rgba(60,130,180,.25)` (glacier ring). `.es-select` stays pill.
- **Banners** (`.es-banner--ok/warn/danger`): tinted translucent fills over glass — ok=aurora-tint,
  warn=ember-tint, danger=danger-tint, with the matching readable text.
- **Data / mono** (`.es-num`, `.es-gitline`, console, run/notes/branches/deps/github rows): `--font-mono`
  (Space Mono), `tabular-nums`, `--fg2/fg3`. The Procesos **console** (`.es-console__log`) already uses an ink
  bg — re-point to `--ink-900`/`--snow` text (fits dark natively).
- **Lists / sections / forms / cols / empty** (`.es-list/.es-row/.es-section__title/.es-form/.es-cols/.es-empty`):
  dark text tokens, `--border-soft` hairlines, glass form panel.
- The slice-specific rows already added (`.es-gitsync`, `.es-branches`, `.es-bulk`, `.es-gh`, `.es-deps`,
  `.es-notes`, `.es-console`, `.es-proc-slot`) all re-point their colors to Boreal `--fg*`/`--border-*`/dots.

## 6. Data Flow & State Transitions

None — CSS only. No runtime state, no API, no markup. The visual change is entirely in the two stylesheet
files + the one-line import swap in `main.tsx`.

## 7. Safety & Governance

- **Zero behavior change**: no `.tsx`, no routes, no state, no tests' logic touched. Risk is purely visual.
- Fonts load from the **Google Fonts CDN** (same approach as Estante's Geist import) — an external request at
  load; acceptable for a localhost dev tool. (Bundling offline is a noted follow-up, as in Boreal's README.)
- `backdrop-filter` is broadly supported in modern Chromium/Firefox (the dev browser); a `-webkit-` prefix is
  included. A browser without it degrades to a translucent (non-blurred) glass — still legible.

## 8. Error Handling

N/A (CSS). If a Boreal token is referenced that doesn't exist, the property falls back to its initial value;
the rewrite uses only tokens defined in `boreal-tokens.css` (verified against the copied file).

## 9. Testing

- **`pnpm test`** — the full suite (319) must stay green (markup/behavior unchanged). No test edits expected.
  (If a test happened to assert a literal Estante class that we renamed — none should, since we keep class
  names — fix it; not anticipated.)
- **`pnpm exec tsc --noEmit`** — clean (no TS touched).
- **`pnpm build`** — succeeds (Vite bundles the new CSS).
- **Manual visual smoke (REQUIRED)** — run `pnpm dev`, open the dashboard, and confirm the winter look across
  the surfaces: dark alpine shell, frosted-glass sidebar/topbar/cards, ember primary buttons, glacier focus
  rings, aurora/ember/danger status dots, Space-Mono data, the Procesos console, and the on-card controls
  (git sync / branches / bulk / GitHub / deps / notes). Marcos reviews it live and we iterate on specifics.

## 10. Evolution Path

- A light "frost" theme + a toggle; winter atmosphere gradients / a subtle grain overlay behind the shell;
  Lucide line icons (snowflake/mountain) alongside the dots; small entrance animations (fade + rise);
  bundling the fonts offline; a Boreal-styled Design System reference tab.

## 11. Open Questions

None blocking. The restyle is self-contained in two CSS files + one import line. The exact shade/spacing
choices are tuned live during the manual smoke (Marcos reviews "cómo queda" and we adjust). The `Boreal Design
System/` reference folder stays in the repo root (untracked) as the source of truth for the tokens.
