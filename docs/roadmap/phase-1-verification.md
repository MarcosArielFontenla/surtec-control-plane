# Phase 1 verification

- Date: 2026-09-21
- Branch: `codex/phase-1-security-policy`
- Scope: local commits only; no push, merge, deployment, external message, or paid model call

## Implemented evidence

- Shared security primitives enforce safe identifiers, canonical path containment including symlinks, purpose-specific environment allowlists, and centralized credential redaction.
- `PolicyService` is the canonical registry reader and authorization boundary. Dispatch, execution, and review all revalidate current project, agent, sandbox, task-type, exact-command, and repository-path policy.
- Seven JSON Schemas cover registries, task envelopes and records, project overrides, agent reports, and final results. Persisted state is validated on read and write.
- App Server approvals must match the active thread and turn plus the exact command or file path authorized for the task.
- The Hono API binds to `127.0.0.1`; middleware rejects hostile host/origin/fetch-site values and requires a random session token for mutations.
- Non-agent subprocesses use allowlisted environments. Logs, process output, errors, and JSON events use centralized redaction.
- Approval and rejection are durable state machines with effect checkpoints. Push and cleanup retries are idempotent, and PR creation first searches for an existing open PR.
- Startup reconciliation closes interrupted tasks and writes an orphan-worktree report without deleting unknown paths.
- CI validates schemas, scans secrets, runs the offline suite, typechecks, builds, and audits dependencies without invoking Codex.
- Node.js 20 is now the minimum because the patched Vitest 4 line requires it.

## Final gates

- `pnpm install --frozen-lockfile`: lockfile validated. The host's shared pnpm store contained incomplete cached package contents after a forced recreation, so the clean install was repeated successfully from an isolated temporary store with copy imports; the temporary store was removed afterward.
- `pnpm ci:check`: passed with exit code 0.
  - Seven JSON Schemas compiled successfully.
  - Secret scan passed across 824 tracked and non-ignored repository files.
  - 55 test files and 405 tests passed under Vitest 4.1.11.
  - TypeScript type checking passed.
  - Production build passed with 1,908 modules; JavaScript bundle 193.24 kB, 59.39 kB gzip.
- `pnpm audit --audit-level moderate`: no known vulnerabilities.
- `pnpm smoke:api`: HTTP 200 for overview and dispatch options; 20 repositories discovered and 12 registry entries returned.
- `pnpm smoke:codex` without opt-in: passed by skipping without making an external request.
- `git diff --check`: passed.

## Manual local validation

- Production-style `pnpm start` bound the dashboard to `http://127.0.0.1:4317`.
- Overview rendered 20 project cards, live KPIs, the task form, and zero attention items.
- Procesos rendered nine configured repositories and their exact configured command buttons.
- Browser console inspection reported no errors.
- The sandbox account could not read Git status or enumerate worktrees in several sibling repositories because Git correctly rejected their different Windows owner as dubious. Startup reported each reconciliation warning and continued serving; it did not mutate or delete those repositories. This is an environment-limited inspection result, not a bypass.
- HTTP security tests cover loopback host/origin/fetch-site checks and rejection of mutations without the session token.

## Local commits

- `acb9c19` — `docs: define phase 1 security plan`
- `ca89817` — `feat: add shared security primitives`
- `35b747f` — `feat: add canonical policy service`
- `89c2561` — `feat: enforce policy at trust boundaries`
- `16339f1` — `feat: harden local HTTP and subprocesses`
- `77c05f2` — `feat: make review effects recoverable`
- `3bad164` — `ci: add security verification pipeline`
- `2c378fb` — `fix: revalidate policy before review effects`

## Residual risk

- Task orchestration and project-process state remain in-process and non-durable; Phase 2 owns the worker, queue, cancellation, retry, and concurrency boundary.
- File-first state is atomically replaced per record but is not transactional across records and has no multi-process locking.
- Orphan cleanup is intentionally manual.
- Pattern-based redaction and secret detection are defense-in-depth, not general DLP.
