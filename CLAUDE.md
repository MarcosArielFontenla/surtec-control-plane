# Surtec Control Plane — project conventions

This repository is a **personal portfolio control plane**: one dashboard to see the live status of
and orchestrate Marcos's bespoke git projects (under `E:\product-projects\`). It is NOT a Paperclip
clone and has no Codex/OpenAI dependency — execution is Claude-only.

## Language

- Converse with the user in **Spanish** unless asked otherwise.
- Write all implementation artifacts in **English**: code, filenames, identifiers, schemas, scripts,
  technical comments, docs, and registry keys.

## Repository boundaries

- Do not modify external project repositories from this control plane unless the user explicitly asks.
- Do not store product source code in this repository — only the control plane itself.

## Safety

- Do not deploy.
- Do not merge to a protected branch or push branches unless the user explicitly asks.
- Do not touch real secrets, credentials, tokens, or private keys.
- Prefer `read-only` for analysis and `workspace-write` for controlled edits.

## Methodology

- Use the **Superpowers** workflow: brainstorm → spec → plan → execute (TDD) → review → finish.
  Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.
- One branch (or worktree) per task; keep changes small, reviewable, and tied to one slice.
- Established delivery flow per slice: merge `--no-ff` to `master` AND push to `origin/master`.

## Stack

- TypeScript ESM. Dashboard: Vite + React 18 (UI) and Hono + `@hono/node-server` (API). Task runner:
  the Claude Agent SDK (`runner/`). Tests: Vitest + Testing Library (jsdom). Package manager: pnpm.
- Run the dashboard with `pnpm dev` (concurrently: `dev:api` on :4317, `dev:ui` Vite on :5173 proxying
  `/api` → :4317). `pnpm test` runs the suite; `pnpm build` builds the UI.
- Windows / PowerShell environment.

## Delivery format

Every delivery should report: summary, files modified, commands executed, tests/validation run, risks,
and suggested next steps.
