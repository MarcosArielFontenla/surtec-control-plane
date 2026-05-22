# Agent Rules

Agents working in this repository must follow these rules.

## Language

- Work in Spanish in user-facing conversation unless the user asks otherwise.
- Write implementation artifacts in English: code, filenames, identifiers, schemas, scripts, technical comments, docs, and registry keys.

## Repository Boundaries

- Do not modify external project repositories from this control plane unless the user explicitly asks.
- Do not clone upstream repositories during bootstrap or routine validation.
- Do not store product source code in this repository.

## Safety

- Do not deploy.
- Do not merge to `main` or any protected branch.
- Do not push branches unless the user explicitly asks.
- Do not touch real secrets, credentials, tokens, or private keys.
- Do not use `danger-full-access`.
- Prefer `read-only` for analysis and `workspace-write` for controlled edits.

## Orchestration

- Paperclip is optional and replaceable.
- All orchestrators should communicate through the Surtec adapter layer and `TaskEnvelope`.
- Codex CLI is the primary execution engine for automated tasks.

## Methodology

- Use Superpowers as the development methodology when installed and relevant.
- Use branches or worktrees per task.
- Keep changes small, reviewable, and tied to one task.

## Delivery Format

Every delivery must include:

- Summary.
- Files modified.
- Commands executed.
- Tests or validation run.
- Risks.
- Suggested next steps.

## Human Review Gates

- Do not update upstreams automatically without review.
- Do not import legal material without human legal review.
- Do not merge, deploy, or publish without explicit approval.

