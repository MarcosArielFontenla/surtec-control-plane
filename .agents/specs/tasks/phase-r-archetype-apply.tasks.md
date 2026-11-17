---
spec: .agents/specs/harness-scaffold-operation.spec.yaml
feature: phase-r-archetype-apply
status: done
createdAt: "2026-11-16"
reviewedBy: repository-owner
approvedAt: "2026-11-16T18:57:42Z"
---

# Phase R · Apply a reviewed personal scaffold

See the [design proposal](../../../docs/proposals/phase-r-archetype-apply.md). The owner reviews the exact design, spec and task list before implementation.

## Phase 1 · Bind the project and the journal

<!-- maps to: ac-behavior,ac-types -->
- [x] T001 Bind the existing read-only preview to current registered checkout, Git and physical path facts with refusal tests -> lib/harness/scaffold-preview.ts, lib/harness/scaffold-files.ts, lib/harness/scaffold-project.ts, lib/harness/scaffold-project.test.ts

T001 evidence: 53 tests passed in 4 focused files, including registered checkout binding on disposable Git trees and the preceding preview acceptance. The installed TypeScript checker passed. Fixture and launcher cleanup completed.

<!-- maps to: ac-behavior,ac-schema,ac-types -->
- [x] T002 (depends: T001) Validate and persist the versioned sealed preimage and operation checkpoints under the exclusive mutation boundary -> schemas/harness-scaffold-operation.schema.json, lib/state/paths.ts, lib/state/harness-scaffold-operations.ts, lib/state/harness-scaffold-operations.test.ts

T002 evidence: 111 tests passed in 3 focused files. The existing opt-in browser smoke was skipped. All 65 schemas compiled and TypeScript typechecking passed. Isolated fixtures verified the sealed preimage, checkpoint integrity, exclusive access, failure preservation and cleanup.

## Phase 2 · Apply, verify, and recover

<!-- maps to: ac-behavior,ac-types -->
- [x] T003 (depends: T002) Implement exclusive no-overwrite apply, Doctor verification, read-only status and separately approved rollback with fault injection -> lib/harness/scaffold-files.ts, lib/harness/scaffold-operation.ts, lib/harness/scaffold-operation.test.ts

T003 evidence: 67 tests passed in 5 focused files. TypeScript and the 65-schema catalog passed. Disposable Git and state fixtures verified no-overwrite publication, Doctor evidence, separate rollback approval, preserved conflicts, partial and interrupted effects, and cleanup. Repeated Git reads in fault fixtures reused successful observations only while their fixture metadata matched. The primary apply path used live Git.
- [x] T004 (depends: T003) Expose the local CLI and qualify the full lifecycle in disposable Git trees and state, with cleanup and operator documentation -> cli/surtec-scaffold.ts, cli/surtec-scaffold.test.ts, scripts/harness-scaffold-apply.test.ts, docs/runbooks/harness-scaffold-apply.md

## Done gate

Run the new focused tests and the existing Phase R preview acceptance. Execute the reviewed specification through the guarded catalog with 900 seconds per command and record the three exit codes, fixture ownership, cleanup and recovery outcomes. Present a separate readiness decision for the first real checkout before any pilot write.

Final acceptance on 2026-11-16: 69 focused tests passed in 6 files. The final CLI and lifecycle rerun passed 17 tests in 2 files, with TypeScript passing. The guarded spec catalog reported exit 0 for ac-behavior, ac-schema and ac-types in 903.26 seconds total with a 900-second limit per command and no waiver. Disposable checkout, state and launcher cleanup passed. See the [operations runbook and qualification evidence](../../../docs/runbooks/harness-scaffold-apply.md#t004-acceptance-on-2026-11-16). The pilot remains a separate decision.
