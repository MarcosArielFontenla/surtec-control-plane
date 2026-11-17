# Phase R · Personal project archetype and Harness scaffold preview

## Pilot evidence and scope

Gear List repeats the same verification pattern in its baseline and its accepted pilot candidate. The npm frontend defines Vitest and a TypeScript/Vite build. Its README pairs frontend tests and build with solution-level .NET tests and a Release build. The accepted pilot retained those checks and used a separate isolated browser smoke for the business flow. The smoke was a pilot extension. The common pattern is independent test and build evidence for both frontend and backend. The [F5 closure record](../runbooks/factory-local-f5-pilot-review.md#evidence-and-disposition) records which checks ran.

Use `personal@1` as the first selectable archetype. It recommends independent tests and builds for the frontend and backend of a personally maintained application when those components exist. Selection is explicit. The archetype carries stable verification intents and authoring template paths. It carries zero execution authority. Attachment to an actual project and executable command selection remain operator decisions through existing project policy. One pilot justifies this starting pattern. Broader adoption would require evidence from more projects.

The first increment is a deterministic, read-only preview exercised through a disposable fixture. Phase R's real-project apply, backup, rollback, generated updates and obsolete-file reconciliation are later slices. This increment has two importable entries, the pinned `.agents/templates/entity.spec.yaml` and `.agents/templates/feature.tasks.md`. The root `AGENTS.md` is an explicit inspection entry because it routes the project and contains project-specific instructions. Importing the root primer or its routing requires manual migration.

## Preview behavior

1. Load the versioned archetype from a closed local registry and load the trusted canonical source through `loadHarnessSource`. Unknown IDs, malformed metadata or an untrusted source yield a refusal. The initial registry contains one reviewed recommendation and a fixed entry allowlist. It accepts neither repository paths nor executable commands.
2. Use the actual Doctor and trusted ownership facts for the target fixture. Bind each inspected path to its normalized relative path, existing ownership evidence, presence or observed SHA-256, and canonical entry SHA-256. Inspect physical contained files within existing size limits. Reject redirected roots, links, hard-linked file targets, unsafe parent directories and unstable reads. Continue to use existing no-effect project policy where observations extend to a project in a later slice.
3. Project missing approved templates as `safe-addition`. Mark byte-identical templates `unchanged` and preserve their ownership. A differing project-owned or user-owned entry is a `user-owned-conflict`. Different bytes with unknown ownership or a root primer that needs adaptation are `manual-migration-required`. Unreadable or drifting inputs make the whole preview unavailable.
4. Emit sorted relative-path decisions, canonical-only addition bytes for an optional bounded text diff, ownership categories, conflict actions, physical line counts, routing impact and validation expectations. An absent template never has an original file to back up. The preview returns the prospective backup set for existing files that a future approved plan would change, plus its fingerprint. This fixture's backup set is empty. Bind a deterministic plan fingerprint to the archetype and its bytes, trusted source, target identity, bounded observations and decisions. Keep absolute paths and private file contents out of the output. The plan expresses zero execution authority.
5. Show the current Doctor result. Predict the effect of the allowed additions against a second disposable tree. Keep validation `unknown` until a relevant validator runs on the exact target. Rollback planning lists the proposed new paths with their expected hashes. A future separately authorized rollback would remove an exact addition only after verifying unchanged ownership and content. Preview itself leaves the target bytes and file inventory intact.

The authoring template adds physical lines to the tree. It adds zero lines to active context because this slice does not update the primer, routing, or cold-start manifest. Source version changes invalidate the preview. An exact pinned copy supports byte identity and by itself leaves ownership unknown.

## Disposable fixture observed on 2026-11-16

A read-only probe called `loadHarnessSource` and `inspectHarness` from the current Surtec checkout, using the real `surtec-h1-h4-v1` source and two manufactured trees. The fixture declares its synthetic root primer as user-owned. The canonical task template was seeded into both trees. The probe added only the canonical spec template to the second tree to observe the projection. Byte and inventory snapshots matched around both Doctor calls.

| Path | Observation in the target fixture | Expected preview |
| --- | --- | --- |
| `AGENTS.md` | Present, user-owned, differs from the canonical primer | `user-owned-conflict`. Preserve it and retain the conflict for human review. |
| `.agents/templates/entity.spec.yaml` | Absent, with a contained template directory | `safe-addition`. Plan the 26-line pinned template. |
| `.agents/templates/feature.tasks.md` | Present with the exact canonical bytes and unknown ownership | `unchanged`. Preserve both the bytes and the ownership classification. |

The Doctor reported `legacy`, `warning` and validation `unknown` in both trees. The new template became present in the second tree. Active routing remained unchanged. The probe checked the canonical template hashes and draft markers, then removed both owned fixtures. This probe qualified the design using the existing readers before T003 added repeatable acceptance.

## T003 final acceptance on 2026-11-16

**The Phase R preview increment is complete.** The [T003 acceptance test](../../scripts/harness-scaffold-preview.test.ts) used the reviewed `surtec-h1-h4-v1` pins and the real Doctor. It seeded the exact pinned spec template into an independent projected tree.

| Observation | Baseline tree | Projected tree |
| --- | --- | --- |
| Doctor | `legacy`, `warning`, validation `unknown` | `legacy`, `warning`, validation `unknown` |
| Entity spec template | Absent, `safe-addition` | Exact pinned bytes, `unchanged`, ownership `unknown` |
| Feature tasks template | Exact pinned bytes, `unchanged`, ownership `unknown` | Exact pinned bytes, `unchanged`, ownership `unknown` |
| Root primer | `user-owned-conflict` with declared ownership | `user-owned-conflict` with declared ownership |
| Preview additions | 26 physical lines and zero active context lines | Zero physical or active context lines |

The inventories and byte hashes matched before and after the inspections of both trees and the disposable canonical source. The test verified removal of all three directories and their owned parent. The gate launcher also verified removal of its dedicated TEMP/TMP directory. The Windows run created a literal `%SystemDrive%` directory in the checkout containing four shell-cache databases. Post-gate inspection verified its creation time and inventory before removing that scratch directory and confirming its absence.

| Check | Observed result |
| --- | --- |
| Focused archetype, preview, and T003 acceptance files | 39 tests passed in 3 files, exit 0 |
| `ac-behavior` / `pnpm test` | Exit 0 |
| `ac-schema` / `pnpm schemas:check` | Exit 0 |
| `ac-types` / `pnpm typecheck` | Exit 0 |

The [approved specification](../../.agents/specs/project-archetype-preview.spec.yaml) ran through the guarded Harness catalog with a 900-second limit per command. All three checks completed in 890.64 seconds total, with no waiver. The [task plan](../../.agents/specs/tasks/phase-r-archetype-preview.tasks.md) records the result. The preview carries zero execution authority. Automated acceptance covers this read-only increment. Real-project application, backup and rollback execution remain future work.
