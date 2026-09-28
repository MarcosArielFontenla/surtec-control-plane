# Phase I — Outcome-oriented EVALs and operating feedback

## Baseline

- Reviewed commit: `4687736` (`docs: record Phase H implementation and verification`).
- Working tree at phase start: only the two user-owned roadmap prompt files were untracked; neither is in scope for edits or commits.
- `pnpm ci:check`: passed before Phase I — repository consistency, 26 JSON Schemas, secret scan (962 files), existing EVAL coverage 36/36 and expectations 42/42, 79 test files / 536 tests, TypeScript typecheck, and Vite production build.
- Existing EVAL hard-fails cover secret exposure, read-only mutation/commands, prohibited operations, denied task types, missing approvals, and runtime policy denial. Missing code-change evidence currently produces required quality failures rather than a hard-fail; Phase I will promote missing required evidence to a non-compensable hard-fail.

## Scope and design

1. Keep `evals/v1` and its offline CI gate. Add a versioned, synthetic `evals/v2` golden suite for architecture review, implementation plan, frontend change, backend change, bug diagnosis with a verified minimal fix, security review, QA review, and documentation update. Reuse the existing role/task policy evaluator for hard failures, then add deterministic checks for required report sections, evidence references, changed-file scope, tests and verification, risks, next steps, and prohibited side effects. Fixtures contain no private client or production content.
2. Add an explicitly opted-in, fixed-count live-canary command. It uses only repository-owned synthetic fixtures and the read-only sandbox, pins its comparison to the v2 suite ID, stops on runtime/token thresholds, and refuses ordinary CI. Automated tests use a fake executor; no real model call is part of Phase I verification. Token limits are enforced by aborting on usage notifications; the report will disclose that a final usage notification can arrive after some tokens have already been consumed. Monetary cost is not estimated without billing data.
3. Record the first signal action and evidence timestamp in optional, backward-compatible fields in the existing local human-state file. Aggregate those actions with local task, verification, work-session, and current signal evidence into counts/rates and median evidence-to-action latency. This measures time since signal evidence, not time since first display; the application does not currently persist first-seen events.
4. Expose aggregate-only feedback through a no-store local API and an on-demand dashboard view. The response will not contain signal/task/session IDs, project names, prompts, paths, notes, or result text. No analytics or external telemetry will be introduced.

## Verification plan

- Unit tests for additional hard-failure behavior, golden-suite validation and scope checks, canary opt-in/budget behavior with a protocol fake, backward-compatible signal state, metric definitions, and the metrics API.
- Add an offline Playwright smoke using synthetic API responses for the Feedback view.
- Run `pnpm evals:check`, schema check, secret scan, focused tests, Playwright smoke, `pnpm ci:check`, and `git diff --check`.
- Do not run `pnpm evals:canary` with opt-in flags or any other real Codex runtime command.

## Stop condition

After implementation and verification, update the roadmap and deliver the consolidated A–I product review, manual local validation steps, security impact, residual risks, and local commit list. Stop for Marcos's local validation; do not begin another phase.
