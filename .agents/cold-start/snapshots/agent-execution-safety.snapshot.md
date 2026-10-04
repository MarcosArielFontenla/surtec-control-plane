---
sourceSkill: agent-execution-safety
sourcePath: .agents/skills/agent-execution-safety/SKILL.md
sourceVersion: "1.0.0"
sourceHash: "192424ab1657a212ad5c706981629ef9c23f651efd2ca8914cc563776488e1a4"
authoredAt: "2026-09-29"
---

# Agent Execution Safety — Supplemental Snapshot

Read the complete source skill; this summary grants no authority.

## Must

- Revalidate trusted policy, issue scope, lease and run ownership.
- Keep writes isolated; check staged scope before committing.
- Reject unknown approvals and invalid final output safely.
- Verify cancellation, retries and recovery with protocol fakes.

## Never

- Never expand scope, copy auth, or persist raw reasoning.
- Never make paid calls without explicit opt-in.

Key check: `pnpm exec vitest run runner/run-task.test.ts`.
