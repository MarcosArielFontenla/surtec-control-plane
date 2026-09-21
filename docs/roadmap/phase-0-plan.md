# Phase 0 implementation plan

## Goal

Make Codex the only active execution runtime, restore dispatch, preserve the task lifecycle, and make malformed results fail safely.

Status: implemented and verified on 2026-09-21. Evidence is recorded in `phase-0-verification.md`.

## Ordered slices

1. **Baseline and evidence**
   - Record Git, Node.js, pnpm, Codex CLI, install, test, typecheck, build, and vendor-reference inventory.
   - Confirm or reject each current-state hypothesis.

2. **Instructions and architecture decision**
   - Add root `AGENTS.md`.
   - Accept ADR-0001 after comparing current official surfaces and installed bindings.
   - Add current architecture, runtime, development, security, and roadmap documents.

3. **Protocol contract and executor boundary**
   - Add `AgentExecutor`, normalized events, usage, and execution result contracts.
   - Generate stable protocol TypeScript bindings from Codex CLI 0.145.0.
   - Implement the `stdio` JSON-RPC client with initialization, correlation, thread start/resume, turn start, events, approvals, interrupt, exit, and malformed-output handling.
   - Verify with a fake App Server process.

4. **Task orchestration integration**
   - Replace the legacy executor import.
   - Persist thread/turn identifiers, usage, and normalized events.
   - Preserve isolated worktrees, commit/diff collection, and post-commit verification.
   - Remove hardcoded model and legacy credential checks.

5. **Structured result safety**
   - Pass a JSON Schema to `turn/start`.
   - Validate the model report and final `AgentResult` at runtime.
   - Convert missing or malformed reports to `needs-review`.

6. **Repository migration**
   - Remove the obsolete dependency and regenerate the lockfile.
   - Rename runtime files and update tests, docs, examples, and comments.
   - Remove obsolete historical runtime plans and superseded instruction/configuration files.
   - Require a zero-match vendor inventory.

7. **Smoke and acceptance**
   - Add a repository-root instruction-file integration test.
   - Add an explicit opt-in read-only smoke command against a fixture.
   - Run targeted tests, full tests, typecheck, build, schema checks, API smoke, and final inventory.
   - Create small local commits and stop before Phase 1.

## Primary risks

- Protocol drift: mitigated by generated bindings and a recorded CLI version.
- Accidental writes in analysis mode: mitigated by the App Server read-only sandbox and a before/after smoke assertion.
- Secret exposure to agent-run commands: reduced subprocess environment in Phase 0; canonical process isolation is completed in Phase 1.
- Partial worktree state after runtime failure: existing risk retained and explicitly scheduled for Phase 1.
- Real authentication unavailable during automated tests: tests use a fake process; the real smoke is opt-in.
