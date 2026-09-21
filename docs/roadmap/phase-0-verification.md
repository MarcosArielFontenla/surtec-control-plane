# Phase 0 verification

- Date: 2026-09-21
- Branch: `codex/phase-0-codex-native`
- Scope: local commits only; no push, merge, or deployment

## Baseline

- Node.js: 24.16.0
- pnpm: 10.24.0
- Codex CLI: 0.145.0
- Initial tests: 51 files and 386 tests passed.
- Initial production build: 1,770 modules; JavaScript bundle 189.79 kB, 58.33 kB gzip.
- The literal `pnpm exec tsc --noEmit` command could not resolve the Windows shim in this host environment. Direct shim execution passed, and the repository now exposes `pnpm typecheck`, which also passes and includes `runner/` and `scripts/`.

## Implemented evidence

- ADR-0001 selects stable App Server over local `stdio` after comparing the current official App Server and SDK surfaces.
- TypeScript protocol bindings regenerate without a diff from Codex CLI 0.145.0.
- `AgentExecutor` isolates orchestration from the provider implementation.
- Contract tests cover initialization, thread start/resume, turn start, event and usage streaming, exact approval handling, path containment, structured output, interruption, malformed JSONL, and unexpected process exit.
- The root instruction file is loaded and injected in the task-orchestration integration test.
- The model report and the final `AgentResult` are validated at runtime against canonical schemas. Invalid reports become `needs-review`.
- Task logs record normalized events, thread/turn identifiers, and usage while redacting credential-shaped data.
- Discovered machine-local project paths override stale configured paths before dispatch.
- The dependency and lockfile inventory contains only the active runtime.
- Content and filename scans report zero forbidden-token matches outside ignored dependency, build, temporary, and Git directories.

## Final gates

- `pnpm install --frozen-lockfile`: passed after lockfile regeneration.
- `pnpm test`: 52 files and 378 tests passed. The count changed because obsolete runtime tests were removed and native contract tests were added.
- `pnpm typecheck`: passed.
- `pnpm schemas:check`: three schemas compiled successfully.
- `pnpm audit --prod`: no known vulnerabilities after updating Hono and its Node adapter to patched compatible releases.
- `pnpm build`: passed; 1,770 modules; JavaScript bundle 189.79 kB, 58.33 kB gzip.
- `pnpm smoke:api`: passed with HTTP 200 for overview and dispatch options; 20 repositories discovered and 12 registry entries returned.
- Production dashboard browser smoke: passed. Overview rendered 20 project cards with live KPIs and the Procesos view loaded configured commands.
- Opt-in smoke without the opt-in setting: passed by skipping without an external request.

## Optional real runtime smoke

The opt-in real read-only smoke reached App Server and attempted a Responses API connection. The restricted execution environment blocked outbound network access. A request to elevate that call was rejected because a real external request can consume account quota and needs separate explicit authorization. This is recorded as environment-limited, not as a successful real run.

Acceptance relies on the deterministic App Server contract suite in this environment. A user can run the isolated fixture smoke explicitly with:

```text
$env:SURTEC_CODEX_SMOKE='1'
pnpm smoke:codex
```

The smoke snapshots the fixture before and after, uses the read-only sandbox, and fails on any filesystem change or invalid structured report.
