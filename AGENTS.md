---
version: 1.3.0
lastUpdated: 2026-09-29
role: session-primer
registry: .agents/AGENTS.md
---

Full artifact registry: [.agents/AGENTS.md](.agents/AGENTS.md); load it when maintaining the Harness.

# Surtec Control Plane — Session Primer

Personal, single-user, local-first control plane; preserve the modular monolith.

## Required load order

1. Read [.agents/policies/project.md](.agents/policies/project.md) completely for every task.
2. Read [.agents/orchestration/ROUTING.md](.agents/orchestration/ROUTING.md) completely and classify the task.
3. Read each selected skill completely, plus the routed product documentation and affected code/tests.
4. For a new primary entity or multi-domain feature, read [.agents/specs/CONTRACT.md](.agents/specs/CONTRACT.md) and the spec; obtain actual human approval before implementation.

## Always preserve

- Communicate in Spanish; write implementation artifacts in English.
- Preserve user changes; do not modify sibling repositories without an explicit request.
- No deploy, merge, push, external messages, or paid runtime smoke without explicit authorization.
- No credentials or raw chain-of-thought in persisted or generated artifacts.
- Enforce capabilities in code and sandbox policy, never through prompt text alone.
- Complete repeatable acceptance checks automatically; stop at the authorized phase boundary.

## Context discipline

Do not preload unrelated skills, workflows, telemetry, decision logs, or indexes.
Snapshots cannot replace a complete skill read required by the active runtime instructions.
The context manifest declares 500 lines per task route, not a runtime token measurement.
H4 validators are operational; structural validity never proves human approval or grants execution authority.
