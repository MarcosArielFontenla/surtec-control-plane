# Mandatory Project Policy

Read this document completely for every task. The root primer requires it; routing cannot make it optional.

## Purpose and architecture

- This repository is a personal, single-user, local-first control plane for inspecting and operating software projects. Product source remains in each project repository; this repository contains only the control plane.
- Preserve a modular monolith. Do not introduce distributed infrastructure, multi-tenant authentication, or a generic plugin framework without a concrete requirement.
- Follow the product stack and module boundaries in `docs/architecture/current-architecture.md`; read it before architecture or implementation changes.
- The sole execution runtime and its mandatory safety configuration are defined in `docs/architecture/execution-runtime.md`; read it before any runtime, protocol, dispatch, sandbox, approval, or verification change.
- State is file-first under `state/` until transaction and concurrency requirements justify a storage migration.
- Project discovery and Git status are driven by real sibling repositories; registry data is policy and integration configuration.
- Keep UI, application orchestration, domain policy, infrastructure adapters, and persistence boundaries explicit. Prefer dependency injection for process, protocol, filesystem, Git, and clock boundaries.

## Language

- Communicate with the user in Spanish unless asked otherwise.
- Write implementation artifacts in English: source, identifiers, schemas, tests, comments, ADRs, runbooks, and technical documentation.

## Ownership and authorization

- Do not modify external project repositories unless the user explicitly requests it.
- Never deploy, merge, push, or send external messages without explicit authorization.
- Never store credentials, tokens, auth files, or private keys in the repository, task state, logs, events, screenshots, or generated artifacts.
- Treat existing and untracked user changes as user-owned. Preserve them unless the user explicitly authorizes migration or removal.

## Agent execution safety

- Use the installed runtime and its current official documentation as protocol sources of truth, as specified by the product runtime contract.
- Default to the stable local protocol surface. Do not enable experimental protocol fields without an ADR and demonstrated need.
- Keep the model configurable; do not hardcode a model name.
- Map analysis to a read-only sandbox and implementation to a workspace-write sandbox in an isolated Git worktree.
- Never use a full-access sandbox for dispatched tasks.
- Do not grant shell or filesystem access based only on prompt instructions. Enforce limits in code, sandbox configuration, approvals, and registry policy.
- Automated tests must use protocol fakes and must not make paid model calls.
- Real runtime smoke tests must be explicit opt-in operations.
- Invalid or missing structured agent output must fail safely as `needs-review`.
- Do not request or persist raw chain-of-thought. Store operational events and concise agent-visible summaries only.

## Development workflow

1. Inspect relevant code, tests, schemas, registries, and current documentation before editing.
2. Record the baseline and distinguish pre-existing failures from regressions.
3. Work in small, testable, reversible vertical slices.
4. Add or update tests alongside behavior.
5. Avoid unrelated refactors.
6. Do not push, merge, or deploy while implementing a phase.
7. Stop after each authorized phase for local user validation. Approval of a roadmap is not evidence that each phase passed.

Required checks when applicable:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

When a phase changes user-facing or persisted dashboard behavior, automate every repeatable acceptance step and verify the real local API plus dashboard in a browser. Read `.agents/skills/local-dashboard-validation/SKILL.md` completely and extend its isolated smoke coverage for new flows. `pnpm smoke:local:playwright` starts the real API and dashboard against temporary state and synthetic Git repositories, never the user's normal `state/` or sibling projects. Combine it with focused fixture smokes for states that are difficult to set up through the UI. Leave manual validation only for genuinely subjective choices or a step that cannot safely/reliably be automated, and say exactly why. When runtime behavior changes, run fake-protocol integration tests; run the real runtime smoke command only when explicitly opted in.

## Delivery format

Every phase delivery reports:

1. Summary.
2. Files modified.
3. Commands executed.
4. Exact test, typecheck, build, schema, and smoke results; distinguish not run from passed.
5. Manual local validation steps, or why none are needed.
6. Security impact.
7. Known risks and deferred work.
8. Local commits created, or none.
9. Recommended next phase.
