---
name: agent-execution-safety
description: Change or review local agent dispatch, protocol handling, worktree execution, approval enforcement, leases, retries, cancellation, and evidence without widening capabilities.
metadata:
  version: "1.0.0"
  snapshotPath: ".agents/cold-start/snapshots/agent-execution-safety.snapshot.md"
  snapshotVersion: "1.0.0"
  driftStatus: "inactive"
---

# Agent Execution Safety

Use for the execution boundary, not ordinary UI styling or skill authoring. Read `docs/architecture/execution-runtime.md` completely; it defines the sole product runtime. For security or threat-model changes, also read `docs/security/threat-model.md`. Follow linked official protocol sources only when protocol details need verification.

## Execution invariants

- Trace dispatch through `dashboard/src/server/dispatch.ts`, `lib/policy/service.ts`, `runner/task-orchestrator.ts`, `runner/run-task.ts`, and the relevant executor. Validate untrusted input before effects and revalidate current policy at execution time.
- For issue-backed writes, inspect `dashboard/src/server/issue-service.ts` and `lib/issues/types.ts`. Authorization, task ownership and scope revision come from trusted application state, never request-supplied metadata or model text. Do not widen scope on retry.
- Keep analysis read-only and writes in isolated managed worktrees. Before committing, verify staged paths against authorized scope; preserve out-of-scope findings as review evidence, not automatic approval.
- Check active lease and immutable run identity before progress, commits and terminal effects. Recovery, cancellation and retries must not let a stale attempt publish or resume writes after a review candidate is ready.
- Unknown approval requests fail closed. Missing or invalid structured final output becomes `needs-review`; a transport completion signal alone is not proof of success.
- Store normalized operational events, concise summaries and cumulative usage; redact process/protocol output. Never copy authentication material or raw reasoning into records, fixtures or test output.
- Preserve model configurability, bounded attempts/budgets and cancellation propagation. Do not switch transport, enable experimental fields, expand sandbox access or add a second execution runtime without the required design decision.

## Verification and stopping condition

Use protocol fakes and synthetic repositories to test success, malformed output, denied approval, scope violation, cancellation, stale lease and restart/retry behavior applicable to the change. Locate the fake executor and test helpers before invoking any runtime. For example, `pnpm exec vitest run runner/run-task.test.ts runner/task-orchestrator.test.ts dashboard/src/server/dispatch.test.ts` exercises existing local suites without paid calls; add the executor's focused suite when protocol behavior changes.

If the API/UI or persisted workflow changes, also load `.agents/skills/local-dashboard-validation/SKILL.md` and run its isolated acceptance flow. Report actual terminal state, evidence and cleanup separately; passing fake tests is not a real-runtime smoke. Stop when the authorized slice passes or needs a new human decision. Paid runtime calls and external publication remain separately authorized operations.
