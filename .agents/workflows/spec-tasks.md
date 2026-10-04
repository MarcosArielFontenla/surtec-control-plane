# Decompose Approved Work into Tasks

Load `.agents/specs/CONTRACT.md` and the prospective approved spec completely. Confirm actual human approval and scope; a YAML status is not proof of authority.

1. Copy `.agents/templates/feature.tasks.md` to the feature's tasks artifact. Set the real spec path, feature slug and drafting date; keep review metadata null and status draft until reviewed.
2. Decompose observable requirements into small reversible slices. Order models before services/endpoints; put tests before or alongside the behavior they verify.
3. Give each task a stable id, concrete target paths and explicit earlier dependencies. Target files may be new. Map every phase to real acceptanceCheck ids; uncovered work means the proposal/checks need amendment before implementation.
4. Mark `[P]` only for independent tasks with different target files and no dependency edge. It grants neither agent delegation nor external write permission.
5. Present the tasks and any spec amendments for human review. Record approval only after the human approves the exact delta; implementation cannot start from draft tasks.
6. Preserve completed task entries and evidence. If scope, targets, dependencies or checks materially change, append the proposed delta and obtain renewed review before resuming. Never rewrite completion history to manufacture convergence.
7. Mark done only after the guarded executable done gate passes all runnable approved checks and waived human criteria are separately reported. Keep task history; archival/deletion requires authorization.

H4 allows contained future target paths before implementation; missing future files are not implementation failures. No task or template invokes a shell automatically.
