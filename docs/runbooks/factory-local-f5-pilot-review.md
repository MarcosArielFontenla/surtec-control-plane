# Factory Local F5 — pilot closure report

**F3 and F5 closed on 2026-11-12 (America/Buenos_Aires).** The owner confirmed the QA assessment and accepted the verified Gear List candidate locally for F3-01 through F3-08.

## What the pilot delivered

The pilot added a documented local acceptance command for the existing list and item workflow. The isolated candidate contains eight allowed changes covering the runner, its tests, the local API host, the browser scenario, the frontend package command and the README. The business flow exercises registration, list and item creation, persistence after reload, purchase and archive, plus 401 without a session and 404 for a second synthetic user.

The retained Planner plan was explicitly approved. Engineer exceeded its token cap and stopped before commit. The owner separately approved adoption of the exact staged tree and independent human Reviewer and QA as the evidence route for F3-01 and F3-07. The operator reproduced that tree in a separate worktree, committed it locally and verified that commit. The failed attempt and its accounting remain intact in the original workflow, which is in `needs-decision`.

## Evidence and disposition

| Item | Observed disposition |
| --- | --- |
| F2 request, context and plan | Local functional acceptance complete under the revised procedure. The human pilot-preparation checkpoint is recorded. See the Factory request contract acceptance record. |
| F3 candidate and technical evidence | The adopted candidate passed its original V01–V08 run in 274,428 ms. The accepted corrected descendant passed its own V01–V08 run in 281,501 ms against 300,000 ms, with native exit 0 and both EOFs. V01 checked installed prerequisites and passed eight runner tests. V02 passed 82 frontend tests. V03–V06 passed TypeScript, the frontend build, offline restore, backend build and ten backend tests. V07 observed two independent real Chromium/API/PostgreSQL sessions and confirmed owned closure. V08 sealed the corrected candidate and verifier. |
| F3-01 and F3-07 human evidence | Reviewer approved the corrected candidate without observations. The owner confirmed the favorable technical QA assessment and accepted all eight criteria against the same commit, tree and report. The acceptance is recorded in the private dossier under the approved adoption route. The original workflow remains recorded in `needs-decision`. |
| F4 failure, recovery and traceability | T001–T005 technical acceptance complete. N01–N10 and N12 were verified using isolated fixtures and the full real API/Chromium smoke with 31 synthetic turns and owned cleanup. N11 applies if integration is authorized and performed. See the F4 consolidated acceptance record. |
| Integration | N11 is inapplicable to this local acceptance because integration was outside the pilot's execution. Any separately authorized integration requires a fresh check of the resulting tree and a record of its commit and evidence. |
| Global regression and CI | DEBT-F2-GLOBAL-900 was open at pilot closure. The [regression debt record](../roadmap/factory-local-poc.md#debt-f2-global-900) records the 2026-11-16 full regression PASS and the [integrated local CI PASS](../roadmap/factory-local-poc.md#integrated-local-ci-pass--2026-11-16). The two historical F4 full-smoke timeouts remain failures with unknown causes. |

The private dossier holds the request, approved scope, plan and candidate lineage, diff, verification report, criterion matrix, Reviewer approval, QA assessment and local decision. The owner retained the dossier seal, verification report and local acceptance fingerprints in the private handoff. The original adopted candidate's sealed dossier remains available as historical evidence.

## Observed measures

| Measure | Observation |
| --- | --- |
| Time until candidate was ready for human review | 5 h 50 min 53.528 s from issuance of the final G1 operation to completion of the adopted candidate verifier. This wall interval includes operator and approval waits. Time from the original request and time to human acceptance are unmeasured. |
| Attempts in the final live workflow | Two charged attempts and 65,135 ms of recorded active runtime. Planner completed in 18,446 ms with 20,386 tokens and complete terminal usage evidence. Engineer stopped in 46,689 ms after 189,266 observed tokens crossed its 180,000-token cap. |
| Usage | Final workflow observed 209,652 tokens. The distinct historical floor of 955,759 plus this workflow yields a pilot-wide observed floor of 1,165,411 tokens. Engineer terminal usage and provider-final cumulative usage are unknown. The adoption and verification spent zero model tokens. |
| Review returns | The first technical review requested three corrections. The corrected candidate resolved them, passed its own verification, and received owner approval as Reviewer without observations. |
| Recovered work | One exact staged tree was recovered as an independently verified local candidate through the approved adoption. The failed Engineer attempt and incomplete accounting were preserved. |
| Manual effort | Recorded interventions include the exact plan and risk approval, the adoption decision, and the operator's isolated commit and verification. Human minutes and total manual effort were not measured. |

The final live grant capped four tasks, four attempts, 900,000 ms and 300,000 nominal tokens, with automatic correction off. The interrupted workflow's remaining executable authority is unavailable under incomplete accounting. The original and corrected verifier runs finished with 25.572 s and 18.499 s of observed headroom, respectively.

## Daily use and closure decision

1. Record the request, exact scope, success criteria and owner before authorizing a plan. Use the [local work issue flow](local-work-issues.md).
2. Retain the exact candidate, verification receipt and criterion matrix. Check the commit and report hashes before reviewing. A changed candidate needs fresh evidence for its own identity.
3. Record Reviewer and QA findings and decisions against the same commit, tree and report. Then record the owner's local accept or return decision by criterion in the private dossier.

The accepted Gear List request and F4 evidence satisfy the pilot's local closure criteria. The [regression debt record](../roadmap/factory-local-poc.md#debt-f2-global-900) holds the results of subsequent control-plane validation.

## Next bounded increment for review

Run one synthetic rehearsal of the sealed-tree adoption procedure in an isolated fixture. Check that the matching tree and report produce a package for review and that changing either by one byte is refused. Record elapsed time and manual effort under the existing runtime and budget controls. Use the result to decide whether the procedure belongs in daily use.

**Rehearsal result (2026-11-14, America/Buenos_Aires).** In a separate Git fixture, the sealed tree and report for the accepted candidate produced a review package. Changing a single staged byte in `README.md` was refused as a tree mismatch. With the tree unchanged, changing one whitespace byte in the report while preserving its parsed JSON was refused as a SHA-256 mismatch. Neither refusal produced a review package.

The successful run took 3.527 s from launch to the review package and 6.284 s for all three cases and the final integrity check. It required one automated launch and no human intervention while running. Two earlier setup launches stopped at Git's ownership check before any trial; the operator switched to a private local bundle. Active setup minutes were not measured. V01-V08 were not rerun, and the source dossier and worktrees were unchanged.

Use the [sealed candidate preparation procedure](local-work-issues.md#prepare-a-sealed-candidate-for-human-review) for daily local review of an eligible stopped issue.

Use the [historical revalidation procedure](local-work-issues.md#revalidate-the-historical-gear-list-acceptance) to prepare a private receipt for the already accepted Gear List dossier.

**Historical revalidation (2026-11-15, America/Buenos_Aires).** Two runs of the Gear List historical command returned the same private receipt for the accepted candidate. The first run prepared it in 6.259 s and the second reused it after revalidation in 5.780 s. The receipt remained byte-identical at 1,685 bytes. The original seal, acceptance, and nine other evidence files retained their hashes. The command used the stored verification reports.
