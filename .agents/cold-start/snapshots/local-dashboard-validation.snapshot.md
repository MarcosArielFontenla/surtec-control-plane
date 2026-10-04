---
sourceSkill: local-dashboard-validation
sourcePath: .agents/skills/local-dashboard-validation/SKILL.md
sourceVersion: "1.1.0"
sourceHash: "48ee9381d34e7baeea4c9d6ec7875b837c97fbd7000852376f1057571514bdef"
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
