# Factory Local — sealed candidate adoption for daily use

Status: **Proposed design**. This increment covers local preparation of an existing sealed candidate for human review.

## Evidence and product boundary

The F5 rehearsal accepted the exact Gear List tree and report for the accepted pilot candidate. One staged byte changed the tree and caused `TREE_MISMATCH`. One whitespace byte changed the report digest and caused `REPORT_SHA256_MISMATCH`, with equal parsed JSON. Both refusals left the review package absent. The successful launch took 3.527 s to prepare the package and 6.284 s overall, with zero human interventions during execution. Two earlier setup launches stopped at Git's ownership check. Active setup time was unmeasured. These are measurements for one fixture. See the [F5 report](../runbooks/factory-local-f5-pilot-review.md#next-bounded-increment-for-review).

Surtec's ordinary issue flow records a candidate and its verification under a live authorized task lease. A stopped workflow can retain a tree and a separate verification report while remaining `needs-decision`. Give the operator an explicit local command to prepare that evidence for human review. The command reads live issue and workflow bindings and writes a single private review package. Ordinary issue acceptance and publication continue through their existing gates. See [Local Work Issues](../runbooks/local-work-issues.md#scope-and-review-gates) and [execution runtime](../architecture/execution-runtime.md#sole-agent-runtime).

## Operator flow

1. Open the issue in Surtec and confirm why it stopped. Select the already sealed commit from its isolated worktree and the report produced for that same commit. The first version handles an inactive, traceable execution of an issue in `needs-decision`. A staged tree with no sealed commit or no trustworthy report goes back to the existing human decision path.
2. Run the local preparation command explicitly with the issue ID, expected issue revision, private dossier ID and independently recorded seal digest. The SHA-256 anchor comes from the prior owner-controlled record for that issue and scope. The dossier supplies the evidence matched against that anchor. The output gives either a ready-for-human-review package ID or a bounded reason and next action.
3. Open the package alongside the dossier. Reviewer and QA, where required by the current review policy or the approved plan, record their own findings against the same commit, tree and report digest. The owner records the local decision per criterion in the private dossier. Revalidate that binding against the current issue and bytes before recording a decision. A scope, candidate, policy or evidence change requires a fresh package and any affected review. The issue and workflow statuses still describe the original execution. The package is the separate record of human review preparation.

Proposed entry point:

```text
pnpm exec tsx cli/surtec-sealed-adoption.ts prepare --issue-id <issue-id> --expected-revision <revision> --dossier-id <id> --seal-sha256 <sha256>
```

## Contract for preparation

| Check | Required evidence |
| --- | --- |
| Current authority and origin | Known project and original issue, workflow, task and run. The current issue revision, scope revision/fingerprint, plan/criteria, baseline and approved review policy agree with the dossier. The stopped owner is inactive, with known writer/lease state, and there is no superseding candidate or active project writer. Use existing state validators and ownership checks. Require matching observations before and after inspecting the dossier. |
| Candidate identity | Resolve the physical isolated worktree and Git common directory from trusted records. Check the expected commit and its tree, the index against the sealed tree including paths, modes and blob IDs, and the clean worktree and file content against that identity. Recompute changed paths from the authorized base and apply current allow/exclude rules. Check staged identities with read-only Git plumbing. Preserve the existing empty-hooks and process isolation controls. |
| Report and provenance | Match SHA-256 over the original report bytes before parsing. Verify the reviewed verifier ID/version and its pins, report-to-commit/tree/content binding, approved checks and exact recorded results, including any required session and closure evidence. Start with the sealed report v1 shape exercised in F5 and an exact reviewed verifier binding. Treat unsupported producers, incomplete records and self-declared success as unavailable evidence. The source dossier and commands are data. A seal proves consistency with the anchored bytes within Surtec's local trust model. |
| Review package | Include issue/scope revision and criterion IDs, original execution references, base/commit/tree, allowed changed paths, report and seal digests, verifier identity, required human decisions and preparation time. Preserve a digest or stable ID for references from subsequent review. Keep the report, source bodies and native output in the original private dossier. |

`READY_FOR_HUMAN_REVIEW` means there is a package for human review. A demonstrated mismatch is `REFUSED`. Unreadable, incomplete or unstable evidence is `UNKNOWN`. The command returns exit code 0 for ready, 1 for refused and 2 for unknown. Only the successful outcome creates a package. A changed staged tree and a changed report receive separate reason codes. For a refusal, show which binding to investigate. For unknown ownership or incomplete evidence, route to the existing human decision. Preserve the original task failure, usage and receipts as historical facts.

Use bounded physical file reads from a private root with a closed dossier layout. Resolve projects through Surtec policy, reject linked or escaped inputs, and keep process arguments fixed to inspection operations. Store a small, complete package under its binding-derived ID in an ignored, operator-owned directory. Publish it only after the final checks. An identical request revalidates and returns the existing complete package. Concurrent requests may converge on that package, and a conflicting or partial result requires inspection. This uses the file-first operations already familiar to Surtec and a separate private result. It introduces no new issue status or workflow transition.

## Proposed first increment

| Task | Scope and target files |
| --- | --- |
| T001 | Implement the bounded evidence reader and binding checks in `lib/workflows/sealed-adoption.ts` with `lib/workflows/sealed-adoption.test.ts`. Reuse validated issue/workflow projections and scope checks. Port only evidence-inspection predicates from the private rehearsal. Keep the verifier runner and Gear List paths outside the product reader. |
| T002 | Add `cli/surtec-sealed-adoption.ts` and `cli/surtec-sealed-adoption.test.ts` for the explicit `prepare` entry point and private package outcome. Resolve Git and dossier inputs locally through bounded adapters. Stay with one CLI operation and one versioned evidence reader. |
| T003 | Document how to inspect the package, record the human decisions and interpret refusal in `docs/runbooks/local-work-issues.md`. Add the reviewed procedure link to `docs/runbooks/factory-local-f5-pilot-review.md`. |

T002 depends on T001. T003 depends on the established CLI behavior. Dashboard actions and issue-state transitions would be a separate design once actual use shows a need. The deliverable here is a human-operated procedure that can reuse already captured trustworthy verification.

## Proposed acceptance

| Case | Expected result |
| --- | --- |
| Exact tree and report in an isolated Git fixture | One package with the exact issue/run, scope, criterion, commit, tree and report bindings. Reload from disk and confirm it is readable. An identical request revalidates and resolves to the same ID. |
| One staged byte changes, report intact | `REFUSED` with `TREE_MISMATCH`. Package absent. |
| One report whitespace byte changes, tree intact | `REFUSED` with `REPORT_SHA256_MISMATCH` even when parsed JSON is equal. Package absent. |
| Report or policy does not belong to this candidate | Reject a candidate/report swap, a wrong independent seal, an out-of-scope path and stale issue, scope or verification policy. Reject incomplete/failed verification and unavailable or unsupported verifier evidence. |
| Ownership, interruption and filesystem boundaries | Confirm active or unprovable ownership, input drift before package publication, unsafe paths, and incomplete package writes all fail closed. Verify the original task, ledger, source objects, index, worktree and dossier are unchanged. Assert zero dispatch, model, verification and publication calls with effect-guarded fakes. |
| Operator measurement | Record wall time from invocation to package and to final result, separately count human interventions and record active setup and review time when observed. Report unmeasured values as such. Treat F5 timing as a reference, without a new performance threshold. |

After implementation approval, run the focused suite with `pnpm exec vitest run lib/workflows/sealed-adoption.test.ts cli/surtec-sealed-adoption.test.ts` and then `pnpm typecheck`. Use synthetic state, isolated Git and retained-shaped reports for focused qualification. Exercise both CLI exit modes for refusal and unknown and compare the sources before and after. V01–V08 remain prior technical evidence for the Gear List dossier. A later decision about an actual project's adoption is separate from qualification.
