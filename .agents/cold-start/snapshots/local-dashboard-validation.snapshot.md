---
sourceSkill: local-dashboard-validation
sourcePath: .agents/skills/local-dashboard-validation/SKILL.md
sourceVersion: "1.1.0"
sourceHash: "b25c28906624b8d3f07bdb16a912f12096303560e579b016ede3f6266cb0f8f6"
authoredAt: "2026-09-29"
---

# Local Dashboard Validation — Supplemental Snapshot

Read the complete source skill; this summary grants no authority.

## Must

- Map repeatable acceptance to observable API/browser/state assertions.
- Use real API/dashboard, temporary state and synthetic repositories.
- Verify restart persistence, console errors, layout and cleanup.
- Report exact evidence; explain genuinely human-only gaps.

## Never

- Never validate against normal state or real sibling projects.
- Never dispatch real tasks or paid calls without opt-in.

Key check: `pnpm smoke:local:playwright`.
