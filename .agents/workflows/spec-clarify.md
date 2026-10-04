# Clarify a Prospective Specification

Load `.agents/specs/CONTRACT.md` and the affected spec completely.

1. Mark each genuine unresolved ambiguity inline as `[NEEDS CLARIFICATION: question]`. Prioritize scope, then behavior, data and edge cases. With more than five unresolved markers, stop drafting and ask the human to refine intent.
2. Ask one question at a time. Offer options only when they help distinguish materially different outcomes; do not treat defaults, silence or an earlier roadmap approval as an answer.
3. Append the actual answer to `clarifications` with date, original question, concise answer and affected section/check id. Update the corresponding requirement and remove that marker in the same edit.
4. Repeat until zero markers remain. If an answer expands authorized scope, present the resulting delta for review rather than implementing it.
5. Return to the spec-first approval stage. Clarification is not design approval; an approved spec modified materially needs renewed review.

Never log private state, credentials or raw reasoning. H4 scans the complete YAML source, including comments, for remaining markers before approval validation; schema validation alone is insufficient.
