---
name: local-dashboard-validation
description: Automate phase acceptance through the real local API and browser using isolated temporary state; use for dashboard UI, persistence, migration, and workflow changes.
metadata:
  version: "1.1.0"
  snapshotPath: ".agents/cold-start/snapshots/local-dashboard-validation.snapshot.md"
  snapshotVersion: "1.1.0"
  driftStatus: "inactive"
---

# Local Dashboard Validation

Use this skill before delivering a phase that changes user-facing dashboard behavior or persisted workflows. The goal is to complete safe, repeatable acceptance checks for the user and leave only genuinely subjective or unsafe-to-automate steps for them.

## Workflow

1. Read the phase's acceptance criteria, affected UI/API/state code, schemas, focused tests, and existing browser smokes. Record any known baseline failures.
2. Map each repeatable user action to an observable assertion: rendered state, API response, persisted document, security guard, reload, or process restart. Extend the nearest relevant smoke when a criterion is uncovered.
3. For end-to-end validation, run `pnpm smoke:local:playwright`. It starts the repository's actual API and dashboard in a headless browser using loopback ports, synthetic repositories, and temporary state. Treat only files created by that process beneath its unique OS-temp root as test-owned. Never point it at the user's normal `state/`, project root, or a running server.
4. Run focused fixture smokes for state combinations that are hard or unnatural to create via UI. Fixture smokes complement—not replace—actual API/browser flows for persistence and writes.
5. Inspect browser console/page errors, API status, assertions, server exit, and cleanup result. Report exact commands and pass/fail evidence without printing secrets, session tokens, private record fields, or user-state paths beyond what is necessary to explain a cleanup failure.
6. If visual behavior changes, include responsive layout and readable-control checks. Use the available browser automation for live browser inspection only when the user explicitly asks to inspect their running instance; keep that inspection read-only unless a specific local write was authorized.
7. Never create real agent tasks, invoke paid model/runtime calls, contact external providers, deploy, push, or alter real sibling repositories as part of ordinary validation. Synthetic tasks with protocol fakes are allowed inside isolated test fixtures; real runtime smokes remain opt-in.
8. Ask the user to do a manual step only when the criterion depends on human preference/accessibility judgment, unavailable credentials/device behavior, or a platform interaction that cannot safely/reliably be automated. Explain the gap and give the shortest exact validation step; do not ask them to repeat checks already covered by automation.

## Delivery evidence

State which acceptance criteria were automated, the exact commands and results, whether the real API and browser were used, what persisted across reload/restart, and whether temporary cleanup succeeded. List any remaining human-only checks with a reason. Continue to stop at the authorized phase boundary for user review.
