---
spec: .agents/specs/project-archetype-preview.spec.yaml
feature: phase-r-archetype-preview
status: done
createdAt: "2026-11-16"
reviewedBy: repository-owner
approvedAt: "2026-11-16T18:15:47Z"
---

# Phase R · First archetype and scaffold preview

See the [design proposal](../../../docs/proposals/phase-r-archetype-preview.md). The owner reviews this task sequence and the exact specification before implementation.

## Phase 1 · Define the recommendation

<!-- maps to: ac-schema,ac-behavior -->
- [x] T001 Define the closed registry, explicit personal archetype selection and verification recommendations with focused acceptance for valid and unsupported input -> schemas/project-archetypes.schema.json, registry/project-archetypes.yml, lib/harness/archetypes.ts, lib/harness/archetypes.test.ts

T001 evidence: the installed Vitest passed all 23 focused registry tests, the schema catalog compiled all 64 schemas, and the installed TypeScript checker passed.

## Phase 2 · Preview the pinned templates

<!-- maps to: ac-behavior,ac-types -->
- [x] T002 (depends: T001) Compose the read-only decisions, fingerprints and refusal tests from the actual trusted source and known ownership -> lib/harness/scaffold-preview.ts, lib/harness/scaffold-preview.test.ts

T002 evidence: the installed Vitest passed all 59 focused preview, archetype, source, inventory and Doctor tests. The installed TypeScript checker passed.

- [x] T003 (depends: T002) Exercise the three fixture paths and the hypothetical Doctor result, verify both byte inventories and cleanup, and record observed acceptance -> scripts/harness-scaffold-preview.test.ts, docs/proposals/phase-r-archetype-preview.md, .agents/specs/tasks/phase-r-archetype-preview.tasks.md

## Done gate

Run the three focused test files and use the guarded spec catalog after approval. Record that the reusable fixture covered the real canonical source and Doctor, with both owned trees cleaned up.

Final acceptance on 2026-11-16: 39 focused tests passed in 3 files. The two disposable target trees and the pinned source fixture preserved their inventories during inspection and were removed. The guarded spec catalog reported exit 0 for ac-behavior, ac-schema and ac-types in 890.64 seconds total, with a 900-second limit per command and no waiver. Gate TEMP/TMP cleanup was verified. See the [observed acceptance](../../../docs/proposals/phase-r-archetype-preview.md#t003-final-acceptance-on-2026-11-16).
