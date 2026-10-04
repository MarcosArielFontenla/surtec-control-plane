---
sourceSkill: file-state-contracts
sourcePath: .agents/skills/file-state-contracts/SKILL.md
sourceVersion: "1.0.0"
sourceHash: "7c125b319f65ea7857cad7d69c8ea1d4c6b004a86e45c2c0dd04927cd0162075"
authoredAt: "2026-09-29"
---

# File State Contracts — Supplemental Snapshot

Read the complete source skill; this summary grants no authority.

## Must

- Distinguish absent state, corruption and future versions.
- Lock, reread, validate aggregates, then atomically replace.
- Preserve version dispatch, revisions, leases and event ordering.
- Migrate synthetic fixtures; require backups and recoverable procedures.

## Never

- Never treat malformed data as empty or approved.
- Never copy private state into fixtures or tracked backups.

Key check: `pnpm schemas:check` plus affected store tests.
